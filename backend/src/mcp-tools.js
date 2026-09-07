import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import * as db from './db.js';
import { sendDraft, renderPreview, verifyAccount, sendTestMail, preflightDraft } from './mailer.js';
import { fetchContacts } from './carddav.js';
import { fetchInbox, verifyImap } from './imap.js';
import * as gh from './github.js';
import { policy, assertToolAllowed, resolveAttachmentPath } from './mcp-policy.js';
import { getServiceToken } from './auth.js';
import { trackingBaseUrl, trackingReachable } from './tracking.js';
import { logMcpEvent, summarizeArgs } from './mcp-access.js';
import { registerContextTools } from './mcp-context-tools.js';

/**
 * Baut eine frische MCP-Server-Instanz mit allen Werkzeugen.
 *
 * Eine Instanz je Verbindung: Der stdio-Betrieb nutzt genau eine, der
 * HTTP-Betrieb eine pro Sitzung – ein McpServer kann immer nur an einem
 * Transport hängen.
 */
/**
 * Verzeichnis der tatsächlich registrierten Werkzeuge.
 *
 * Existiert, damit die Anleitung in der Oberfläche nicht von Hand nachgepflegt
 * werden muss – eine handgeschriebene Liste ist nach dem ersten neuen Werkzeug
 * falsch. Gefüllt wird beim Registrieren, gelesen über toolCatalog().
 */
const CATALOG = new Map();

export function toolCatalog() {
  if (!CATALOG.size) createMcpServer();   // einmal bauen, nur um die Namen zu kennen
  return [...CATALOG].map(([name, description]) => ({ name, description }));
}

/**
 * @param {object} ctx  Herkunft dieser Verbindung – landet im Protokoll und
 *                      entscheidet, ob das Token nur lesen darf.
 *                      { transport, tokenId, tokenName, readonly }
 */
export function createMcpServer(ctx = {}) {
  const readOnlySession = !!ctx.readonly;

  // Werkzeuge, die die Richtlinie verbietet (MCP_READONLY, MCP_DISABLED_TOOLS)
  // oder die ein nur-lesendes Token ausschließt, werden gar nicht erst
  // registriert – sie tauchen dann auch in tools/list nicht auf.
  const tool = (name, description, ...rest) => {
    if (!assertToolAllowed(name, { readonly: readOnlySession })) return undefined;
    CATALOG.set(name, String(description || '').split(/(?<=\.)\s/)[0]);

    // Jeden Aufruf protokollieren: Werkzeug, Dauer, Erfolg und eine knappe
    // Zusammenfassung der Argumente – ohne Inhalte. Ein MCP-Server handelt
    // sonst unbeobachtet im Namen des Nutzers.
    const handler = rest[rest.length - 1];
    if (typeof handler === 'function') {
      rest[rest.length - 1] = async (...args) => {
        const started = Date.now();
        try {
          const result = await handler(...args);
          logMcpEvent({
            ...ctx, tool: name, ok: !result?.isError, durationMs: Date.now() - started,
            summary: summarizeArgs(args[0]),
            error: result?.isError ? String(result?.content?.[0]?.text || '').slice(0, 300) : null,
          });
          return result;
        } catch (e) {
          logMcpEvent({
            ...ctx, tool: name, ok: false, durationMs: Date.now() - started,
            summary: summarizeArgs(args[0]), error: e.message,
          });
          throw e;
        }
      };
    }
    return server.tool(name, description, ...rest);
  };


// UI: interne Adresse des Web-Servers (WhatsApp-Socket, Service-Aufrufe). Im
// Container ist das http://backend:3000 – für Links an den Nutzer unbrauchbar.
// LINK: öffentliche Adresse für open_in_ui & Co.; fällt auf UI zurück.
const UI = process.env.MAIL_UI_URL || `http://localhost:${process.env.PORT || 3000}`;
const LINK = String(process.env.MAIL_PUBLIC_URL || UI).replace(/\/+$/, '');
const server = new McpServer({ name: 'mail-server', version: '1.0.0' });

const ok = obj => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const draftLink = id => `${LINK}/draft/${id}`;

const recipientSchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
  kind: z.enum(['to', 'cc', 'bcc']).optional().default('to'),
  vars: z.record(z.string()).optional().describe('Custom-Platzhalter, z.B. {"firma":"ACME","betrag":"99€"} → {{firma}}/{{betrag}}'),
});

// ---- Anhänge --------------------------------------------------------------
const ATTACH_MAX_BYTES = 20 * 1024 * 1024;
const MIME_BY_EXT = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.heic': 'image/heic',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text', '.rtf': 'application/rtf',
  '.txt': 'text/plain', '.csv': 'text/csv', '.md': 'text/markdown', '.json': 'application/json',
  '.zip': 'application/zip', '.ics': 'text/calendar', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
};
const mimeForName = name => MIME_BY_EXT[path.extname(name).toLowerCase()] || 'application/octet-stream';

const attachmentSchema = z.object({
  path: z.string().optional().describe('Pfad zur Datei auf diesem Rechner – der bevorzugte Weg (spart Tokens, "~" wird aufgelöst)'),
  base64: z.string().optional().describe('Alternative zu path: Dateiinhalt base64-kodiert (dann ist filename Pflicht)'),
  filename: z.string().optional().describe('Dateiname beim Empfänger (Standard: der Name aus path)'),
  mimetype: z.string().optional().describe('Standard: aus der Dateiendung abgeleitet'),
}).describe('Datei-Anhang: entweder path (empfohlen) oder base64 + filename');

/**
 * Pfad für Fehlermeldungen. Über HTTP sitzt der Aufrufer woanders – der
 * absolute Pfad verriete ihm Ordnerstruktur und Benutzername des Servers.
 */
const shownPath = file => (policy.transport === 'http' ? path.basename(file) : file);

/** Liest einen Anhang aus path oder base64 und normalisiert ihn für db.addAttachment. */
function readAttachment(a) {
  if (a.path) {
    // Die Richtlinie entscheidet, ob und aus welchem Ordner überhaupt gelesen werden darf.
    const file = resolveAttachmentPath(a.path);
    if (!fs.existsSync(file)) throw new Error(`Datei nicht gefunden: ${shownPath(file)}`);
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error(`Kein reguläre Datei: ${shownPath(file)}`);
    if (stat.size > ATTACH_MAX_BYTES) throw new Error(`Zu groß (${(stat.size / 1048576).toFixed(1)} MB, max. 20 MB): ${shownPath(file)}`);
    const filename = a.filename || path.basename(file);
    return { filename, mimetype: a.mimetype || mimeForName(filename), base64: fs.readFileSync(file).toString('base64'), size: stat.size };
  }
  if (a.base64) {
    if (!a.filename) throw new Error('filename ist erforderlich, wenn base64 genutzt wird');
    const size = Math.floor(a.base64.length * 0.75);
    if (size > ATTACH_MAX_BYTES) throw new Error(`Zu groß (${(size / 1048576).toFixed(1)} MB, max. 20 MB): ${a.filename}`);
    return { filename: a.filename, mimetype: a.mimetype || mimeForName(a.filename), base64: a.base64, size };
  }
  throw new Error('Anhang braucht entweder path oder base64');
}

/** Hängt eine Liste an einen Entwurf; prüft die Gesamtgröße vorab (alles oder nichts). */
function attachAll(draftId, list = []) {
  if (!list.length) return [];
  const files = list.map(readAttachment);
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total > ATTACH_MAX_BYTES) throw new Error(`Anhänge zusammen ${(total / 1048576).toFixed(1)} MB – erlaubt sind 20 MB`);
  return files.map(f => {
    const row = db.addAttachment(draftId, f);
    return { id: row.id, filename: row.filename, mimetype: row.mimetype, size: row.size };
  });
}

tool(
  'list_smtp_accounts',
  'Liste der konfigurierten SMTP-Accounts (Absender). Nutze eine id als account_id beim Entwurf.',
  {},
  async () => ok(db.listAccounts()),
);

tool(
  'create_draft',
  'Legt einen HTML-Mail-Entwurf an. Er wird NICHT gesendet — der Nutzer prüft die Vorschau in der Web-UI und klickt auf Senden. ' +
  'HTML unterstützt Platzhalter {{name}} und {{email}}, die pro Empfänger ersetzt werden. mode "batch" = pro Empfänger eine eigene, personalisierte Mail; "single" = eine gemeinsame Mail.',
  {
    account_id: z.number().int().describe('SMTP-Account-ID aus list_smtp_accounts'),
    subject: z.string(),
    html: z.string().describe('HTML-Body, darf {{name}}/{{email}} enthalten'),
    text: z.string().optional().describe('Optionaler Plaintext-Fallback (sonst automatisch aus HTML)'),
    mode: z.enum(['batch', 'single']).optional().default('batch'),
    reply_to: z.string().email().optional().describe('Optionale Reply-To-Adresse (sonst Account-Standard)'),
    header_template_id: z.number().int().optional().describe('Header-Vorlage (kind=header), wird oben eingefügt'),
    footer_template_id: z.number().int().optional().describe('Footer-Vorlage (kind=footer), wird unten eingefügt'),
    vars: z.record(z.string()).optional().describe('Entwurfs-Variablen (gelten für die ganze Kampagne; Empfänger können überschreiben)'),
    recipients: z.array(recipientSchema).optional().default([]),
    attachments: z.array(attachmentSchema).optional().default([])
      .describe('Datei-Anhänge, z.B. [{"path":"~/Downloads/Bewerbung.pdf"}] – zusammen max. 20 MB'),
  },
  async ({ attachments = [], ...a }) => {
    const d = db.createDraft(a);
    const files = attachAll(d.id, attachments);
    return ok({
      id: d.id, status: d.status, recipients: d.recipients.length,
      attachments: files, open_in_ui: draftLink(d.id),
      hint: 'Entwurf in der UI prüfen und senden.',
    });
  },
);

tool(
  'update_draft',
  'Aktualisiert Betreff/HTML/Text/Modus/Account eines Entwurfs.',
  {
    id: z.number().int(),
    account_id: z.number().int().optional(),
    subject: z.string().optional(),
    html: z.string().optional(),
    text: z.string().optional(),
    mode: z.enum(['batch', 'single']).optional(),
    reply_to: z.string().optional().describe('Reply-To-Adresse; leerer String = Account-Standard'),
    vars: z.record(z.string()).optional().describe('Entwurfs-Variablen (Kampagnen-Ebene)'),
    track_opens: z.boolean().nullable().optional()
      .describe('Öffnungen dieser Mail messen; null = globale Einstellung übernehmen'),
  },
  async ({ id, ...patch }) => {
    const d = db.updateDraft(id, patch);
    if (!d) throw new Error('Entwurf nicht gefunden');
    return ok({ id: d.id, status: d.status, open_in_ui: draftLink(d.id) });
  },
);

tool(
  'add_recipients',
  'Fügt einem Entwurf Empfänger hinzu (oder ersetzt alle mit replace=true).',
  {
    id: z.number().int(),
    recipients: z.array(recipientSchema),
    replace: z.boolean().optional().default(false),
  },
  async ({ id, recipients, replace }) => {
    if (replace) db.clearRecipients(id);
    const r = db.addRecipients(id, recipients);
    return ok({ id, recipients: r.length, open_in_ui: draftLink(id) });
  },
);

tool(
  'add_recipients_from_list',
  'Fügt alle Kontakte einer gespeicherten Liste als Empfänger hinzu (Batch).',
  { id: z.number().int(), list_id: z.number().int(), kind: z.enum(['to', 'cc', 'bcc']).optional().default('to') },
  async ({ id, list_id, kind }) => {
    const members = db.getListMembers(list_id);
    const r = db.addRecipients(id, members.map(m => ({ email: m.email, name: m.name, kind })));
    return ok({ id, added: members.length, total_recipients: r.length, open_in_ui: draftLink(id) });
  },
);

tool(
  'list_drafts',
  'Listet Entwürfe, optional gefiltert nach Status (draft|sending|sent|failed|partial).',
  { status: z.string().optional() },
  async ({ status }) => ok(db.listDrafts(status).map(d => ({
    id: d.id, subject: d.subject, status: d.status, recipients: d.recipient_count,
    account: d.account?.from_email, updated_at: d.updated_at,
  }))),
);

tool(
  'get_draft',
  'Details eines Entwurfs inkl. personalisierter Vorschau (Betreff, HTML, Text) für den ersten Empfänger.',
  { id: z.number().int() },
  async ({ id }) => {
    const d = db.getDraft(id);
    if (!d) throw new Error('Entwurf nicht gefunden');
    const preview = renderPreview(id);
    return ok({ ...d, preview, open_in_ui: draftLink(id) });
  },
);

tool(
  'preview_draft',
  'Rendert die personalisierte Vorschau eines Entwurfs (optional für einen bestimmten Empfänger).',
  { id: z.number().int(), recipient_id: z.number().int().optional() },
  async ({ id, recipient_id }) => ok(renderPreview(id, recipient_id ?? null)),
);

tool(
  'send_draft',
  'SENDET einen Entwurf sofort (Batch). Standardmäßig sendet der Nutzer selbst über die UI — dieses '
  + 'Tool nur nutzen, wenn ausdrücklich gewünscht. Vorher läuft derselbe Vorflug-Check wie in der '
  + 'Oberfläche; blockiert er, wird nichts gesendet und die Gründe kommen zurück.',
  {
    id: z.number().int(),
    only_failed: z.boolean().optional().default(false).describe('Nur die fehlgeschlagenen Empfänger erneut versuchen'),
  },
  async ({ id, only_failed }) => {
    // Die Leitplanke gehört in den Server, nicht in die Werkzeug-Beschreibung:
    // so gilt sie für Oberfläche und KI gleichermaßen.
    const check = preflightDraft(id);
    if (!check.ok) {
      return ok({
        sent: 0, blocked: true,
        reason: 'Vorflug-Check hat den Versand blockiert',
        blockers: check.blockers, duplicates: check.duplicates, unresolved: check.unresolved,
        hint: 'Ursachen beheben (preflight_draft zeigt Details) und erneut versuchen.',
      });
    }
    const result = await sendDraft(id, () => {}, { onlyFailed: only_failed });
    return ok({ ...result, warnings: check.warnings, open_in_ui: draftLink(id) });
  },
);

tool(
  'delete_draft',
  'Löscht einen Entwurf endgültig.',
  { id: z.number().int() },
  async ({ id }) => ok({ deleted: db.deleteDraft(id) }),
);

tool(
  'duplicate_draft',
  'Dupliziert einen Entwurf (inkl. Inhalt/Empfänger) und gibt den neuen Entwurf zurück.',
  { id: z.number().int() },
  async ({ id }) => {
    const d = db.duplicateDraft(id);
    if (!d) throw new Error('Entwurf nicht gefunden');
    return ok({ id: d.id, open_in_ui: draftLink(d.id) });
  },
);

tool(
  'test_send_draft',
  'Schickt eine personalisierte TEST-Mail des Entwurfs an eine beliebige Adresse ([TEST]-Betreff). Ändert weder Empfänger- noch Entwurfsstatus.',
  { id: z.number().int(), to: z.string().email() },
  async ({ id, to }) => ok(await sendTestMail(id, to)),
);

tool(
  'get_settings',
  'Liest globale Einstellungen (z.B. default_account_id für den Standard-Absender).',
  {},
  async () => ok(db.getAllSettings()),
);
tool(
  'set_default_account',
  'Setzt den Standard-Absender (default_account_id), der für neue Entwürfe vorausgewählt wird.',
  { account_id: z.number().int().nullable() },
  async ({ account_id }) => ok(db.setSettings({ default_account_id: account_id })),
);

// ---- E-Mail-Vorlagen ------------------------------------------------------
tool('list_templates', 'Gespeicherte E-Mail-Vorlagen (Betreff + HTML).', {}, async () => ok(db.listTemplates()));
tool(
  'create_template',
  'Legt eine wiederverwendbare Vorlage an. kind: "full" (Betreff+Body), "header" (oben) oder "footer" (unten). {{name}}/{{email}}/Custom-Felder erlaubt.',
  { name: z.string(), subject: z.string().optional(), html: z.string().optional(), kind: z.enum(['full', 'header', 'body', 'footer']).optional().default('full') },
  async (t) => ok(db.createTemplate(t)),
);
tool(
  'update_template',
  'Aktualisiert eine Vorlage (inkl. kind: full|header|footer).',
  { id: z.number().int(), name: z.string().optional(), subject: z.string().optional(), html: z.string().optional(), kind: z.enum(['full', 'header', 'body', 'footer']).optional() },
  async ({ id, ...t }) => {
    const r = db.updateTemplate(id, t);
    if (!r) throw new Error('Vorlage nicht gefunden');
    return ok(r);
  },
);
tool('delete_template', 'Löscht eine Vorlage.', { id: z.number().int() },
  async ({ id }) => ok({ deleted: db.deleteTemplate(id) }));

tool('list_custom_fields', 'Globale Custom-Felder (Platzhalter) mit Standardwerten.', {}, async () => ok(db.listCustomFields()));
tool(
  'set_custom_field',
  'Legt ein globales Custom-Feld an bzw. aktualisiert es. field_key wird als {{field_key}} genutzt; default_value füllt fehlende Empfängerwerte.',
  { field_key: z.string(), label: z.string().optional(), default_value: z.string().optional() },
  async (f) => ok(db.upsertCustomField(f)),
);
tool('delete_custom_field', 'Löscht ein globales Custom-Feld.', { id: z.number().int() },
  async ({ id }) => ok({ deleted: db.deleteCustomField(id) }));

// ---- Marken (Brands) ------------------------------------------------------
tool('list_brands', 'Marken (Variablen-Presets inkl. Farb-Palette) – z.B. Erohub, DBFV NRW. Feld palette = aufgelöste Farben (brand_color, brand_color_2, brand_accent, brand_bg, brand_surface, brand_text, brand_muted, brand_border + abgeleitet brand_on_color, brand_on_color_2, brand_on_accent, brand_soft, brand_gradient).', {}, async () => ok(db.listBrands()));
tool(
  'set_brand',
  'Legt eine Marke an bzw. aktualisiert sie. vars = Preset von Platzhaltern (firma, website, ansprechpartner …) plus Farb-Palette: brand_color (Primär), brand_color_2 (Sekundär), brand_accent, brand_bg, brand_surface, brand_text, brand_muted, brand_border. Nicht gesetzte Farb-Slots werden automatisch aus brand_color abgeleitet, ebenso brand_on_color/brand_on_color_2/brand_on_accent (lesbare Schriftfarbe), brand_soft und brand_gradient. asset_id optional = Logo aus der Medien-Bibliothek (wird beim Versand CID-eingebettet). is_default=true → neue Entwürfe erben diese Marke.',
  { id: z.number().int().optional(), name: z.string(), vars: z.record(z.string()), asset_id: z.number().int().nullable().optional(), is_default: z.boolean().optional() },
  async (b) => ok(db.upsertBrand(b)),
);
tool(
  'apply_brand_to_draft',
  'Wendet eine Marke auf einen Entwurf an (setzt/mischt die Marken-Variablen in draft.vars). So werden Farbe/Kontext der Vorlage umgeschaltet.',
  { draft_id: z.number().int(), brand_id: z.number().int() },
  async ({ draft_id, brand_id }) => {
    const brand = db.getBrand(brand_id);
    if (!brand) throw new Error('Marke nicht gefunden');
    const cur = db.getDraft(draft_id);
    if (!cur) throw new Error('Entwurf nicht gefunden');
    let curVars = {}; if (cur.vars) { try { curVars = JSON.parse(cur.vars); } catch { /* ignore */ } }
    return ok(db.updateDraft(draft_id, { vars: { ...curVars, ...db.brandVars(brand) } }));
  },
);

// ---- Assets (Logos/Bilder für Vorlagen) -----------------------------------
tool('list_assets', 'Bilder/Logos der Medien-Bibliothek (id, filename, mimetype, size).', {}, async () => ok(db.listAssets()));
tool(
  'add_asset',
  'Lädt ein Bild/Logo hoch (base64). In HTML per <img src="' + LINK + '/api/assets/<id>/file"> einbinden – beim Versand wird es automatisch zum Inline-Anhang (kommt beim Empfänger an).',
  { filename: z.string(), mimetype: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']), base64: z.string() },
  async (a) => {
    const asset = db.addAsset(a);
    return ok({ id: asset.id, filename: asset.filename, url: `${LINK}/api/assets/${asset.id}/file` });
  },
);

tool(
  'add_attachment',
  'Hängt eine Datei an einen bestehenden Entwurf (PDF, Office, Bilder …). Gib bevorzugt "path" an – die Datei liegt auf demselben Rechner wie dieser Server, das spart die base64-Übertragung. Anhänge sind echte Datei-Anhänge (anders als add_asset, das Bilder INLINE ins HTML einbettet).',
  {
    draft_id: z.number().int(),
    path: z.string().optional().describe('Pfad zur Datei, z.B. "~/Downloads/Bewerbung.pdf"'),
    base64: z.string().optional().describe('Alternative zu path (dann filename angeben)'),
    filename: z.string().optional().describe('Dateiname beim Empfänger (Standard: Name aus path)'),
    mimetype: z.string().optional().describe('Standard: aus der Dateiendung abgeleitet'),
  },
  async ({ draft_id, ...a }) => {
    if (!db.getDraft(draft_id)) throw new Error(`Entwurf ${draft_id} nicht gefunden`);
    const [file] = attachAll(draft_id, [a]);
    return ok({ ...file, draft_id, open_in_ui: draftLink(draft_id) });
  },
);

tool(
  'list_attachments',
  'Datei-Anhänge eines Entwurfs (id, filename, mimetype, size).',
  { draft_id: z.number().int() },
  async ({ draft_id }) => ok(db.listAttachments(draft_id)),
);

tool(
  'delete_attachment',
  'Entfernt einen Datei-Anhang (id aus list_attachments).',
  { id: z.number().int() },
  async ({ id }) => ok({ deleted: db.deleteAttachment(id) }),
);
tool(
  'create_draft_from_template',
  'Erstellt einen Entwurf aus einer Vorlage (Betreff/HTML werden übernommen). Sendet NICHT.',
  {
    template_id: z.number().int(),
    account_id: z.number().int(),
    recipients: z.array(recipientSchema).optional().default([]),
    mode: z.enum(['batch', 'single']).optional().default('batch'),
    attachments: z.array(attachmentSchema).optional().default([])
      .describe('Datei-Anhänge, z.B. [{"path":"~/Downloads/Angebot.pdf"}] – zusammen max. 20 MB'),
  },
  async ({ template_id, account_id, recipients, mode, attachments = [] }) => {
    const t = db.getTemplate(template_id);
    if (!t) throw new Error('Vorlage nicht gefunden');
    const d = db.createDraft({ account_id, subject: t.subject, html: t.html, mode, recipients });
    const files = attachAll(d.id, attachments);
    return ok({ id: d.id, from_template: t.name, attachments: files, open_in_ui: draftLink(d.id) });
  },
);

tool(
  'resend_failed',
  'Sendet einen (teilweise) fehlgeschlagenen Versand erneut – nur an die fehlgeschlagenen Empfänger.',
  { id: z.number().int() },
  async ({ id }) => ok(await sendDraft(id, () => {}, { onlyFailed: true })),
);

tool(
  'list_send_events',
  'Versand-Protokoll (Audit-Trail): jede Zustellung/Fehler mit Zeitstempel. Optional für einen Entwurf.',
  { draft_id: z.number().int().optional(), limit: z.number().int().optional().default(100) },
  async ({ draft_id, limit }) => ok(db.listSendEvents({ draftId: draft_id ?? null, limit })),
);

// ---- SMTP-Account-Verwaltung ---------------------------------------------
const accountShape = {
  name: z.string(),
  host: z.string(),
  port: z.number().int().optional().default(587),
  secure: z.boolean().optional().default(false).describe('true = SSL/TLS (465), false = STARTTLS (587)'),
  username: z.string(),
  password: z.string().describe('Wird verschlüsselt gespeichert'),
  from_name: z.string().optional(),
  from_email: z.string().email(),
  reply_to: z.string().email().optional(),
  default_header_template_id: z.number().int().optional().describe('Standard-Header-Vorlage für neue Entwürfe dieses Absenders'),
  default_footer_template_id: z.number().int().optional().describe('Standard-Footer-Vorlage für neue Entwürfe dieses Absenders'),
};

tool(
  'create_smtp_account',
  'Legt einen neuen SMTP-Account (Absender) an. Das Passwort wird verschlüsselt gespeichert.',
  accountShape,
  async (a) => ok(db.createAccount(a)),
);

tool(
  'update_smtp_account',
  'Aktualisiert einen SMTP-Account. Nur angegebene Felder ändern sich; Passwort nur setzen, wenn es '
  + 'geändert werden soll. WICHTIG: Ein Server-Wechsel (host, port oder secure) geht nur zusammen mit '
  + 'einem neuen password im selben Aufruf – sonst lehnt der Server die Änderung ab. Das verhindert, '
  + 'dass ein gespeichertes Passwort unbemerkt an einen fremden Server geschickt wird. Gleiches gilt '
  + 'für IMAP (imap_host/imap_port/imap_secure → imap_password) und CardDAV (carddav_url → carddav_password), '
  + 'die in der Web-UI gepflegt werden.',
  {
    id: z.number().int(),
    name: z.string().optional(),
    host: z.string().optional().describe('SMTP-Server. Änderung nur zusammen mit password'),
    port: z.number().int().optional().describe('Änderung nur zusammen mit password'),
    secure: z.boolean().optional().describe('true = SSL/TLS, false = STARTTLS. Änderung nur zusammen mit password'),
    username: z.string().optional(),
    password: z.string().optional().describe('Neues Passwort (verschlüsselt gespeichert). Pflicht, wenn host/port/secure geändert werden'),
    from_name: z.string().optional(),
    from_email: z.string().email().optional(), reply_to: z.string().optional(),
    default_header_template_id: z.number().int().nullable().optional(),
    default_footer_template_id: z.number().int().nullable().optional(),
  },
  async ({ id, ...patch }) => {
    const a = db.updateAccount(id, patch);
    if (!a) throw new Error('Account nicht gefunden');
    return ok(a);
  },
);

tool(
  'delete_smtp_account',
  'Löscht einen SMTP-Account.',
  { id: z.number().int() },
  async ({ id }) => ok({ deleted: db.deleteAccount(id) }),
);

tool(
  'duplicate_smtp_account',
  'Dupliziert einen SMTP-Account (inkl. Passwort) unter neuem Namen.',
  { id: z.number().int(), name: z.string().optional() },
  async ({ id, name }) => {
    const a = db.duplicateAccount(id, name);
    if (!a) throw new Error('Account nicht gefunden');
    return ok(a);
  },
);

tool(
  'verify_smtp_account',
  'Testet die SMTP-Verbindung/Anmeldung eines Accounts, ohne eine Mail zu senden.',
  { id: z.number().int() },
  async ({ id }) => {
    const a = db.getAccount(id);
    if (!a) throw new Error('Account nicht gefunden');
    try { await verifyAccount(a); return ok({ ok: true }); }
    catch (e) { return ok({ ok: false, error: e.message }); }
  },
);

tool(
  'sync_carddav_contacts',
  'Synchronisiert die Kontakte des Postfachs via CardDAV in das Adressbuch (optional in eine Liste). Erfordert am Account eine CardDAV-URL.',
  { id: z.number().int(), list: z.string().optional().describe('Optionaler Listenname für den Import') },
  async ({ id, list }) => {
    const account = db.getAccount(id);
    if (!account) throw new Error('Account nicht gefunden');
    if (!account.carddav_url) throw new Error('Keine CardDAV-URL konfiguriert');
    const { url, user, pass } = db.getCardDavCreds(account);
    const contacts = await fetchContacts(url, user, pass);
    let listObj = null;
    if (list) listObj = db.createList(list);
    let imported = 0;
    for (const c of contacts) {
      const contact = db.upsertContact(c.email, c.name);
      if (listObj) db.addContactToList(listObj.id, contact.id);
      imported++;
    }
    return ok({ found: contacts.length, imported, list: listObj?.name || null });
  },
);

// ---- Kontakte & Listen ----------------------------------------------------
tool('list_contacts', 'Gespeicherte Kontakte.', {}, async () => ok(db.listContacts()));
tool('list_lists', 'Kontaktlisten inkl. Mitglieder.', {}, async () => ok(db.listLists()));
tool(
  'add_contact',
  'Legt einen Kontakt an bzw. aktualisiert ihn – inkl. Variablen (company/phone/notes + freie vars). '
  + 'Diese Werte werden automatisch als Empfänger-Platzhalter übernommen, wenn der Kontakt/die Liste in einen Entwurf geladen wird. '
  + 'company→{{firma}}, phone→{{telefon}}, vars-Schlüssel→{{schlüssel}}.',
  {
    email: z.string().email(), name: z.string().optional(),
    company: z.string().optional(), phone: z.string().optional(), notes: z.string().optional(),
    vars: z.record(z.string()).optional().describe('Freie Felder, z.B. {"ort":"Berlin","kundennr":"K-2025"}'),
  },
  async ({ email, name, ...extra }) => {
    const c = db.upsertContact(email, name);
    if (extra.company != null || extra.phone != null || extra.notes != null || extra.vars != null) {
      return ok(db.updateContact(c.id, extra));
    }
    return ok(c);
  },
);
tool(
  'import_contacts',
  'Importiert mehrere Kontakte auf einmal (Upsert).',
  { contacts: z.array(z.object({ email: z.string().email(), name: z.string().optional() })) },
  async ({ contacts }) => {
    let imported = 0;
    for (const c of contacts) { db.upsertContact(c.email, c.name); imported++; }
    return ok({ imported });
  },
);
tool(
  'delete_contact',
  'Löscht einen Kontakt.',
  { id: z.number().int() },
  async ({ id }) => ok({ deleted: db.deleteContact(id) }),
);
tool(
  'create_list',
  'Legt eine Kontaktliste an (idempotent per Name).',
  { name: z.string() },
  async ({ name }) => ok(db.createList(name)),
);
tool(
  'delete_list',
  'Löscht eine Kontaktliste.',
  { id: z.number().int() },
  async ({ id }) => ok({ deleted: db.deleteList(id) }),
);
tool(
  'add_contact_to_list',
  'Fügt einen Kontakt (per E-Mail) einer Liste hinzu; legt ihn bei Bedarf an.',
  { list_id: z.number().int(), email: z.string().email(), name: z.string().optional() },
  async ({ list_id, email, name }) => {
    const c = db.upsertContact(email, name);
    db.addContactToList(list_id, c.id);
    return ok({ list_id, contact: c });
  },
);
tool(
  'import_contacts_to_list',
  'Importiert mehrere Kontakte direkt in eine Liste (Upsert + Zuordnung).',
  { list_id: z.number().int(), contacts: z.array(z.object({ email: z.string().email(), name: z.string().optional() })) },
  async ({ list_id, contacts }) => {
    let imported = 0;
    for (const c of contacts) {
      const contact = db.upsertContact(c.email, c.name);
      db.addContactToList(list_id, contact.id);
      imported++;
    }
    return ok({ list_id, imported });
  },
);

// ---- Posteingang (empfangene Mails) --------------------------------------
tool(
  'sync_inbox',
  'Ruft neue Mails eines Accounts per IMAP ab und speichert sie im Posteingang. Inkrementell (nur neue UIDs).',
  {
    account_id: z.number().int().describe('Account-ID aus list_smtp_accounts (muss IMAP konfiguriert haben)'),
    folder: z.string().optional().default('INBOX').describe('IMAP-Ordner, z.B. "INBOX" oder "Sent"'),
    limit: z.number().int().optional().default(50).describe('Max. Mails beim Erstabruf'),
  },
  async ({ account_id, folder, limit }) => {
    const account = db.getAccount(account_id);
    if (!account) return ok({ error: 'Account nicht gefunden' });
    if (!account.imap_host) return ok({ error: 'Kein IMAP-Host konfiguriert' });
    // bounced: dabei erkannte Unzustellbarkeitsmeldungen, die einem Versand zugeordnet wurden.
    const result = await fetchInbox(account, { folder, limit });
    return ok({ ...result, folder, inbox_link: `${LINK}/inbox` });
  },
);
tool(
  'list_inbox',
  'Listet empfangene Mails (Übersicht ohne Volltext). Optional nach Account gefiltert.',
  {
    account_id: z.number().int().optional().describe('Optional: nur Mails dieses Accounts'),
    limit: z.number().int().optional().default(50),
  },
  async ({ account_id, limit }) => ok(db.listMessages({ accountId: account_id ?? null, limit })),
);
tool(
  'get_message',
  'Liefert eine empfangene Mail inkl. Text/HTML-Body. Lesen verändert nichts – die Mail bleibt '
  + 'ungelesen, solange nicht mark_seen=true gesetzt wird (oder set_message_flags genutzt wird).',
  {
    id: z.number().int(),
    mark_seen: z.boolean().optional().default(false)
      .describe('true = Mail dabei als gelesen markieren. Im Nur-Lesen-Betrieb ohne Wirkung.'),
  },
  async ({ id, mark_seen }) => {
    const m = db.getMessage(id);
    if (!m) return ok({ error: 'Mail nicht gefunden' });
    // Früher wurde hier immer als gelesen markiert – ein Schreibzugriff hinter
    // einem get_-Werkzeug, den auch nur-lesende Token ausgelöst haben. Jetzt nur
    // auf Wunsch, und nie, wenn Richtlinie oder Token nur lesen dürfen.
    if (mark_seen && !readOnlySession && !policy.readonly) {
      db.setMessageSeen(id, true);
      m.seen = 1;
    }
    return ok(m);
  },
);


// ---- GitHub-Repos ---------------------------------------------------------
// Repos werden über die link_id aus list_contact_repos adressiert, NIE über einen
// frei gewählten "owner/name". Damit kann dieses Werkzeug grundsätzlich nur Repos
// lesen, die der Nutzer selbst an einen Kontakt gehängt hat.
// Fehlerstil hier: werfen (wie die Entwurfs-Tools), damit der Client einen Fehler
// als Fehler sieht und nicht als erfolgreiches Ergebnis.

/** Löst eine link_id zu { creds, link } auf. */
function resolveRepoLink(link_id) {
  const link = db.getContactRepo(link_id);
  if (!link) throw new Error(`Keine Repo-Verknüpfung mit der ID ${link_id} – erst list_contact_repos aufrufen.`);
  const conn = db.getGithubConnection(link.connection_id) || db.getDefaultGithubConnection();
  if (!conn) throw new Error('Keine GitHub-Verbindung hinterlegt – in den Einstellungen der Web-UI anlegen.');
  return { creds: db.getGithubToken(conn), link, owner: link.owner, repo: link.name };
}

tool(
  'list_contact_repos',
  'GitHub-Repos, die an Kontakte verknüpft sind. Ohne Argumente: alle. Die zurückgegebene '
  + 'link_id ist der Schlüssel für alle anderen Repo-Tools. Kostet keine GitHub-Anfrage.',
  {
    contact_id: z.number().int().optional().describe('Nur Repos dieses Kontakts'),
    email: z.string().optional().describe('Alternativ: Kontakt über die E-Mail-Adresse'),
  },
  async ({ contact_id, email }) => {
    let id = contact_id ?? null;
    if (id == null && email) {
      const c = db.getContactByEmail(email);
      if (!c) throw new Error(`Kein Kontakt mit der Adresse ${email}`);
      id = c.id;
    }
    const rows = db.listContactRepos(id);
    return ok(rows.map(r => ({
      link_id: r.id,
      contact: { id: r.contact_id, name: r.contact_name, email: r.contact_email },
      repo: r.full_name,
      private: !!r.private,
      default_branch: r.default_branch,
      description: r.description,
      role: r.role,
      html_url: r.html_url,
      open_in_ui: `${LINK}/contacts`,
    })));
  },
);

tool(
  'get_repo_tree',
  'Dateien und Ordner eines verknüpften Repos. Standardmäßig nur eine Ebene – das ist gewollt, '
  + 'ein ganzer Baum sprengt schnell den Kontext. Mit path tiefer gehen, recursive nur bei kleinen Repos.',
  {
    link_id: z.number().int().describe('Aus list_contact_repos'),
    path: z.string().optional().default('').describe('Unterordner, z.B. "src/lib"'),
    ref: z.string().optional().describe('Branch, Tag oder Commit (Standard: Haupt-Branch)'),
    recursive: z.boolean().optional().default(false),
    limit: z.number().int().optional().default(200),
  },
  async ({ link_id, ...a }) => {
    const { creds, owner, repo } = resolveRepoLink(link_id);
    return ok(await gh.getTree(creds, { owner, repo, ...a }));
  },
);

tool(
  'read_repo_file',
  'Liest eine Datei aus einem verknüpften Repo. Bei großen Dateien mit start_line/end_line '
  + 'gezielt einen Ausschnitt holen statt alles – der Rückgabewert nennt lines_total. '
  + 'Binärdateien werden erkannt und nicht eingelesen.',
  {
    link_id: z.number().int().describe('Aus list_contact_repos'),
    path: z.string().describe('Pfad im Repo, z.B. "src/index.js"'),
    ref: z.string().optional(),
    start_line: z.number().int().optional().describe('Erste Zeile (1-basiert)'),
    end_line: z.number().int().optional(),
    max_bytes: z.number().int().optional().default(60000),
  },
  async ({ link_id, start_line, end_line, max_bytes, ...a }) => {
    const { creds, owner, repo } = resolveRepoLink(link_id);
    return ok(await gh.readFile(creds, { owner, repo, ...a, startLine: start_line, endLine: end_line, maxBytes: max_bytes }));
  },
);

tool(
  'list_repo_commits',
  'Commits eines verknüpften Repos, neueste zuerst. Nur Kopfzeile je Commit – den Diff liefert get_repo_commit.',
  {
    link_id: z.number().int(),
    ref: z.string().optional().describe('Branch oder Commit'),
    path: z.string().optional().describe('Nur Commits, die diese Datei berühren'),
    author: z.string().optional(),
    since: z.string().optional().describe('ISO-Datum, z.B. "2026-08-01"'),
    until: z.string().optional(),
    limit: z.number().int().optional().default(20),
  },
  async ({ link_id, ...a }) => {
    const { creds, owner, repo } = resolveRepoLink(link_id);
    return ok(await gh.listCommits(creds, { owner, repo, ...a }));
  },
);

tool(
  'get_repo_commit',
  'Ein einzelner Commit mit geänderten Dateien. include_patch=true liefert die Diffs – das ist '
  + 'der mit Abstand größte Kontextfresser, also nur wenn der Diff wirklich gebraucht wird.',
  {
    link_id: z.number().int(),
    sha: z.string(),
    include_patch: z.boolean().optional().default(false),
    max_patch_bytes: z.number().int().optional().default(20000),
  },
  async ({ link_id, sha, include_patch, max_patch_bytes }) => {
    const { creds, owner, repo } = resolveRepoLink(link_id);
    return ok(await gh.getCommit(creds, { owner, repo, sha, includePatch: include_patch, maxPatchBytes: max_patch_bytes }));
  },
);

tool(
  'list_repo_issues',
  'Issues und Pull Requests eines verknüpften Repos – ohne Beschreibungstexte. '
  + 'Den Text eines einzelnen Vorgangs liefert get_repo_issue.',
  {
    link_id: z.number().int(),
    state: z.enum(['open', 'closed', 'all']).optional().default('open'),
    kind: z.enum(['all', 'issue', 'pr']).optional().default('all'),
    labels: z.string().optional().describe('Komma-getrennt, z.B. "bug,urgent"'),
    limit: z.number().int().optional().default(20),
  },
  async ({ link_id, ...a }) => {
    const { creds, owner, repo } = resolveRepoLink(link_id);
    return ok(await gh.listIssues(creds, { owner, repo, ...a }));
  },
);

tool(
  'get_repo_issue',
  'Ein Issue oder Pull Request mit Beschreibungstext, optional mit Kommentaren.',
  {
    link_id: z.number().int(),
    number: z.number().int(),
    include_comments: z.boolean().optional().default(false),
  },
  async ({ link_id, number, include_comments }) => {
    const { creds, owner, repo } = resolveRepoLink(link_id);
    return ok(await gh.getIssue(creds, { owner, repo, number, includeComments: include_comments }));
  },
);

tool(
  'link_contact_repo',
  'Verknüpft ein GitHub-Repo mit einem Kontakt. Das Repo wird dabei einmal bei GitHub aufgelöst; '
  + 'schlägt das fehl, hat das Token keinen Zugriff darauf.',
  {
    contact_id: z.number().int().optional(),
    email: z.string().optional().describe('Alternativ zum contact_id'),
    repo: z.string().describe('"owner/name"'),
    connection_id: z.number().int().optional(),
    role: z.string().optional().describe('Freie Notiz, z.B. "Kundenprojekt"'),
  },
  async ({ contact_id, email, repo, connection_id, role }) => {
    const contact = contact_id ? db.getContactById(contact_id) : (email ? db.getContactByEmail(email) : null);
    if (!contact) throw new Error('Kontakt nicht gefunden – contact_id oder email angeben.');
    const [owner, name] = String(repo).split('/');
    if (!owner || !name) throw new Error('Repo als "owner/name" angeben.');
    const conn = connection_id ? db.getGithubConnection(connection_id) : db.getDefaultGithubConnection();
    if (!conn) throw new Error('Keine GitHub-Verbindung hinterlegt – in den Einstellungen der Web-UI anlegen.');
    const meta = await gh.getRepo(db.getGithubToken(conn), { owner, repo: name });
    const row = db.addContactRepo(contact.id, { ...meta, connection_id: conn.id, role });
    return ok({ link_id: row.id, repo: row.full_name, contact: contact.email, open_in_ui: `${LINK}/contacts` });
  },
);

tool(
  'unlink_contact_repo',
  'Löst eine Repo-Verknüpfung wieder (link_id aus list_contact_repos). Löscht nichts bei GitHub.',
  { link_id: z.number().int() },
  async ({ link_id }) => ok({ deleted: db.deleteContactRepo(link_id) }),
);


// ---- WhatsApp -------------------------------------------------------------
// Lesen geht direkt in die SQLite. Alles, was den Socket anfasst (senden, lesen
// bestätigen, Verlauf nachladen), läuft über HTTP an den Web-Server – der Socket
// lebt nur dort, siehe Kopfkommentar in src/whatsapp.js.

/** HTTP-Aufruf an den Web-Server. Erstes MCP-Tool im Projekt, das das tut. */
async function ui(path, { method = 'GET', body, timeoutMs = 20000 } = {}) {
  let r;
  try {
    r = await fetch(`${UI}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Origin': 'mcp',
        // Der Web-Server verlangt seit der Anmeldepflicht einen Ausweis. Das
        // Service-Token liegt verschlüsselt in derselben SQLite-Datei, die sich
        // beide Prozesse teilen – deshalb ohne Konfiguration.
        Authorization: `Bearer ${getServiceToken()}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error(
      `Web-Server nicht erreichbar (${UI}). WhatsApp läuft ausschließlich im Web-Server-Prozess – `
      + 'bitte "npm start" starten oder den Launcher auf http://localhost:3999 nutzen.');
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

tool(
  'list_wa_accounts',
  'WhatsApp-Konten mit Live-Status (verbunden, wartet auf Kopplung, abgemeldet …). '
  + 'Fragt den Web-Server; ist der aus, kommt der zuletzt gespeicherte Stand mit live=false.',
  {},
  async () => {
    try { return ok(await ui('/api/whatsapp/accounts')); }
    catch { return ok(db.listWaAccounts().map(a => ({ ...a, live: false, note: 'Web-Server nicht erreichbar – Stand aus der Datenbank' }))); }
  },
);

tool(
  'list_wa_chats',
  'WhatsApp-Chats, neueste zuerst. Ohne Nachrichtentexte – nur der letzte Ausschnitt je Chat. '
  + 'Die chat_id ist der Schlüssel für list_wa_messages und send_wa_message.',
  {
    account_id: z.number().int().optional(),
    query: z.string().optional().describe('Sucht in Chat-Namen'),
    limit: z.number().int().optional().default(30),
  },
  async ({ account_id, query, limit }) => ok(
    db.listWaChats({ waAccountId: account_id ?? null, query: query ?? null, limit })
      .map(c => ({
        chat_id: c.id,
        name: c.name || c.jid.split('@')[0],
        jid: c.jid,
        is_group: !!c.is_group,
        participant_count: c.participant_count ?? null,
        unread: c.unread,
        last_message_at: c.last_message_ts ? new Date(c.last_message_ts * 1000).toISOString() : null,
        last_snippet: c.last_snippet,
        linked_contact_email: c.contact_email || null,
        open_in_ui: `${LINK}/whatsapp`,
      }))),
);

tool(
  'get_wa_chat',
  'Ein WhatsApp-Chat im Detail. Bei Gruppen mit Betreff und Teilnehmerliste – nützlich, '
  + 'um vor dem Antworten zu wissen, wer mitliest.',
  { chat_id: z.number().int() },
  async ({ chat_id }) => {
    const c = db.getWaChat(chat_id);
    if (!c) return ok({ error: `Kein Chat mit der ID ${chat_id}`, hint: 'Erst list_wa_chats aufrufen.' });
    const participants = db.waChatParticipants(c);
    return ok({
      chat_id: c.id,
      name: c.name || c.jid.split('@')[0],
      jid: c.jid,
      is_group: !!c.is_group,
      unread: c.unread,
      last_message_at: c.last_message_ts ? new Date(c.last_message_ts * 1000).toISOString() : null,
      linked_contact: c.contact_email ? { id: c.contact_id, email: c.contact_email, name: c.contact_name } : null,
      participant_count: c.participant_count ?? (c.is_group ? null : 1),
      participants: participants.map(p => ({ jid: p.jid, phone: p.phone, admin: p.admin })),
      participants_synced_at: c.meta_synced_at,
      note: c.is_group && !c.meta_synced_at
        ? 'Teilnehmer noch nicht abgefragt – das passiert automatisch beim nächsten Empfang in dieser Gruppe.'
        : undefined,
      open_in_ui: `${LINK}/whatsapp`,
    });
  },
);

tool(
  'list_wa_messages',
  'Nachrichten eines Chats, neueste zuerst. Lange Texte sind gekürzt – den vollen Text '
  + 'liefert get_wa_message. Mit before_ts (Unix-Sekunden) weiter zurückblättern.',
  {
    chat_id: z.number().int(),
    limit: z.number().int().optional().default(50),
    before_ts: z.number().int().optional(),
  },
  async ({ chat_id, limit, before_ts }) => {
    const chat = db.getWaChat(chat_id);
    if (!chat) return ok({ error: `Kein Chat mit der ID ${chat_id}`, hint: 'Erst list_wa_chats aufrufen.' });
    return ok({
      chat: { chat_id: chat.id, name: chat.name, jid: chat.jid, is_group: !!chat.is_group },
      messages: db.listWaMessages({ chatId: chat_id, limit, beforeTs: before_ts ?? null }).map(m => ({
        id: m.id,
        at: new Date(m.ts * 1000).toISOString(),
        from_me: !!m.from_me,
        sender: m.from_me ? 'ich' : (m.sender_name || m.sender_jid),
        type: m.type,
        text: m.body ? String(m.body).slice(0, 500) : m.snippet,
        truncated: !!(m.body && m.body.length > 500),
        media: m.media_mime ? { mime: m.media_mime, filename: m.media_filename, downloaded: !!m.media_downloaded } : null,
        status: m.status,
        origin: m.origin,
      })),
      open_in_ui: `${LINK}/whatsapp`,
    });
  },
);

tool(
  'get_wa_message',
  'Eine einzelne WhatsApp-Nachricht mit vollem Text.',
  { id: z.number().int() },
  async ({ id }) => {
    const m = db.getWaMessage(id);
    if (!m) return ok({ error: 'Nachricht nicht gefunden' });
    const { raw, ...rest } = m;
    return ok({ ...rest, at: new Date(m.ts * 1000).toISOString(), open_in_ui: `${LINK}/whatsapp` });
  },
);

tool(
  'search_wa_messages',
  'Durchsucht die Texte aller gespeicherten WhatsApp-Nachrichten.',
  {
    query: z.string(),
    account_id: z.number().int().optional(),
    limit: z.number().int().optional().default(30),
  },
  async ({ query, account_id, limit }) => ok(
    db.searchWaMessages({ query, waAccountId: account_id ?? null, limit }).map(m => ({
      id: m.id, chat_id: m.chat_id, chat: m.chat_name || m.chat_jid,
      at: new Date(m.ts * 1000).toISOString(), from_me: !!m.from_me, text: m.snippet,
    }))),
);

tool(
  'list_wa_contacts',
  'WhatsApp-Kontakte. contact_id/contact_email zeigen, ob eine Verknüpfung ins Adressbuch besteht.',
  {
    account_id: z.number().int().optional(),
    query: z.string().optional(),
    limit: z.number().int().optional().default(50),
  },
  async ({ account_id, query, limit }) => ok(
    db.listWaContacts({ waAccountId: account_id ?? null, query: query ?? null, limit })
      .map(c => ({
        wa_contact_id: c.id, jid: c.jid, phone: c.phone,
        name: c.name || c.push_name, is_group: !!c.is_group,
        contact_id: c.contact_id, contact_email: c.contact_email || null,
      }))),
);

tool(
  'send_wa_message',
  'SENDET SOFORT eine WhatsApp-Nachricht an einen echten Menschen. Es gibt keine Vorschau, '
  + 'kein Zurück und keine Rückfrage beim Nutzer – anders als bei Mail, wo nur ein Entwurf entsteht. '
  + 'Nur benutzen, wenn Empfänger UND Wortlaut ausdrücklich bestätigt sind; im Zweifel den Text '
  + 'vorschlagen und über open_in_ui den Nutzer selbst senden lassen. Kein Massenversand – '
  + 'WhatsApp sperrt Nummern dafür dauerhaft.',
  {
    chat_id: z.number().int().optional().describe('Aus list_wa_chats – der übliche Weg'),
    to: z.string().optional().describe('Telefonnummer, nur wenn es noch keinen Chat gibt'),
    account_id: z.number().int().optional().describe('Nötig, wenn nur `to` angegeben wird'),
    text: z.string(),
    quote_wa_id: z.string().optional().describe('Auf diese Nachricht antworten'),
  },
  async ({ chat_id, to, account_id, text, quote_wa_id }) => {
    try {
      if (chat_id) {
        return ok({ ...await ui(`/api/whatsapp/chats/${chat_id}/messages`, {
          method: 'POST', body: { text, quote_wa_id },
        }), open_in_ui: `${LINK}/whatsapp` });
      }
      if (!to || !account_id) return ok({ error: 'chat_id angeben – oder to zusammen mit account_id' });
      return ok({ ...await ui(`/api/whatsapp/accounts/${account_id}/messages`, {
        method: 'POST', body: { to, text },
      }), open_in_ui: `${LINK}/whatsapp` });
    } catch (e) {
      return ok({ error: e.message, open_in_ui: `${LINK}/whatsapp` });
    }
  },
);

const schedView = r => ({
  scheduled_id: r.id, chat_id: r.chat_id, chat: r.chat_name || r.chat_jid,
  send_at: new Date(r.send_at * 1000).toISOString(), status: r.status,
  text: r.text, note: r.note, origin: r.origin, error: r.error || null,
  sent_at: r.sent_at || null, wa_id: r.wa_id || null,
});

tool(
  'schedule_wa_message',
  'PLANT eine WhatsApp-Nachricht: Text jetzt, Versand zu einem Zeitpunkt in der Zukunft. Der Web-Server '
  + 'schickt sie dann von selbst (er muss zu dem Zeitpunkt laufen und das Konto verbunden sein). Bis dahin '
  + 'lässt sie sich mit cancel_wa_scheduled zurückziehen oder in der Oberfläche ändern. Dieselben Regeln wie '
  + 'send_wa_message: Empfänger und Wortlaut müssen vom Nutzer bestätigt sein.',
  {
    chat_id: z.number().int().describe('Aus list_wa_chats'),
    text: z.string(),
    send_at: z.string().describe('ISO-8601 mit Zeitzone, z.B. 2026-09-11T18:00:00+02:00 – oder Unix-Sekunden'),
    note: z.string().optional().describe('Merkzettel für den Nutzer, z.B. "Freitag: nach ihrer Woche fragen"'),
  },
  async ({ chat_id, text, send_at, note }) => {
    try {
      const row = await ui(`/api/whatsapp/chats/${chat_id}/scheduled`, {
        method: 'POST', body: { text, send_at, note },
      });
      return ok({ ...schedView(row), open_in_ui: `${LINK}/whatsapp` });
    } catch (e) {
      return ok({ error: e.message, open_in_ui: `${LINK}/whatsapp` });
    }
  },
);

tool(
  'list_wa_scheduled',
  'Geplante WhatsApp-Nachrichten: offene zuerst (nach Sendezeit), danach die zuletzt gesendeten, '
  + 'gescheiterten und zurückgezogenen.',
  {
    chat_id: z.number().int().optional(),
    account_id: z.number().int().optional(),
    status: z.enum(['pending', 'sent', 'failed', 'cancelled']).optional(),
    limit: z.number().int().optional().default(50),
  },
  async ({ chat_id, account_id, status, limit }) => ok(
    db.listWaScheduled({ chatId: chat_id ?? null, waAccountId: account_id ?? null, status: status ?? null, limit })
      .map(schedView)),
);

tool(
  'cancel_wa_scheduled',
  'Zieht eine geplante WhatsApp-Nachricht zurück, solange sie noch nicht gesendet ist.',
  { scheduled_id: z.number().int() },
  async ({ scheduled_id }) => {
    try { return ok(schedView(await ui(`/api/whatsapp/scheduled/${scheduled_id}`, { method: 'DELETE' }))); }
    catch (e) { return ok({ error: e.message }); }
  },
);

tool(
  'mark_wa_chat_read',
  'Setzt einen Chat auf gelesen und schickt Lesebestätigungen.',
  { chat_id: z.number().int() },
  async ({ chat_id }) => {
    try { return ok(await ui(`/api/whatsapp/chats/${chat_id}/read`, { method: 'POST' })); }
    catch (e) { return ok({ error: e.message }); }
  },
);

tool(
  'sync_wa_history',
  'Versucht, ältere Nachrichten eines Chats nachzuladen. Wichtig: WhatsApp liefert Verlauf nur, '
  + 'soweit das Telefon ihn hergibt – 50 Nachrichten pro Anfrage, mit Wartezeiten, manchmal gar nichts. '
  + 'complete=false heißt: mehr war gerade nicht zu holen.',
  {
    chat_id: z.number().int(),
    days: z.number().int().optional().default(90),
    max_rounds: z.number().int().optional().default(10),
  },
  async ({ chat_id, days, max_rounds }) => {
    try { return ok(await ui(`/api/whatsapp/chats/${chat_id}/backfill`, { method: 'POST', body: { days, max_rounds }, timeoutMs: 180000 })); }
    catch (e) { return ok({ error: e.message }); }
  },
);

tool(
  'link_wa_contact',
  'Verknüpft eine WhatsApp-Identität mit einem Kontakt aus dem Adressbuch – danach gehören '
  + 'Mailverlauf und WhatsApp-Verlauf sichtbar zusammen.',
  {
    wa_contact_id: z.number().int().describe('Aus list_wa_contacts'),
    contact_id: z.number().int().optional(),
    email: z.string().optional().describe('Alternativ: Kontakt über die Adresse (wird ggf. angelegt)'),
  },
  async ({ wa_contact_id, contact_id, email }) => {
    const contact = contact_id ? db.getContactById(contact_id) : (email ? db.upsertContact(email) : null);
    if (!contact) throw new Error('contact_id oder email angeben');
    return ok({ ...db.linkWaContact(wa_contact_id, contact.id), contact_email: contact.email });
  },
);

  // Kontakt-Kontext, Schreibstile, Vermeiden-Regeln – liegen in einer eigenen Datei.
  registerContextTools({ tool, ok, UI: LINK });

// ===========================================================================
// Vervollständigung: alles, was die Oberfläche kann, kann der KI-Client auch.
// Bewusst NICHT dabei: Benutzer/Anmeldung und GitHub-Token anlegen – dort würden
// Zugangsdaten durch den Modell-Kontext laufen. Das bleibt der Oberfläche.
// ===========================================================================

tool(
  'remove_recipients',
  'Entfernt einzelne Empfänger aus einem Entwurf – per recipient_id oder per Adresse. '
  + 'Ohne beides und mit all=true werden alle entfernt. Bisher ging nur „alle oder keiner".',
  {
    draft_id: z.number().int(),
    recipient_ids: z.array(z.number().int()).optional(),
    emails: z.array(z.string()).optional(),
    all: z.boolean().optional().default(false),
  },
  async ({ draft_id, recipient_ids = [], emails = [], all }) => {
    if (!db.getDraft(draft_id)) throw new Error(`Entwurf ${draft_id} nicht gefunden`);
    if (all) {
      const before = db.getRecipients(draft_id).length;
      db.clearRecipients(draft_id);
      return ok({ removed: before, remaining: 0, open_in_ui: draftLink(draft_id) });
    }
    if (!recipient_ids.length && !emails.length) {
      throw new Error('recipient_ids, emails oder all=true angeben');
    }
    const removed = db.removeRecipients(draft_id, { ids: recipient_ids, emails });
    return ok({ removed, remaining: db.getRecipients(draft_id).length, open_in_ui: draftLink(draft_id) });
  },
);

tool(
  'preflight_draft',
  'Prüft einen Entwurf VOR dem Versand: unaufgelöste Platzhalter, doppelte Adressen, fehlender '
  + 'Account/Betreff, Anhangsgröße, ob ein Testversand lief. Genau diese Prüfung blockiert auch '
  + 'den Versand – wer sie vorher aufruft, weiß, woran es hakt.',
  { id: z.number().int() },
  async ({ id }) => ok(preflightDraft(id)),
);

tool(
  'get_delivery_status',
  'Was ist nach dem Versand passiert? Zählt Zustellung, Öffnungen und Unzustellbarkeit je Entwurf '
  + 'und listet die Empfänger mit Zustand. Achtung: „gesendet" heißt nur, dass der SMTP-Server '
  + 'angenommen hat. Öffnungen sind eine Untergrenze (blockierte Bilder zählen nie).',
  {
    draft_id: z.number().int(),
    only: z.enum(['all', 'opened', 'bounced', 'failed']).optional().default('all'),
  },
  async ({ draft_id, only }) => {
    if (!db.getDraft(draft_id)) throw new Error(`Entwurf ${draft_id} nicht gefunden`);
    const stats = db.trackingStats(draft_id);
    const rows = db.getRecipients(draft_id)
      .filter(r => only === 'all'
        || (only === 'opened' && r.opened_at)
        || (only === 'bounced' && r.bounced_at)
        || (only === 'failed' && r.status === 'failed'))
      .map(r => ({
        recipient_id: r.id, email: r.email, kind: r.kind, status: r.status,
        sent_at: r.sent_at, opened_at: r.opened_at, open_count: r.open_count || 0,
        bounced_at: r.bounced_at, bounce_type: r.bounce_type, bounce_code: r.bounce_code,
        bounce_reason: r.bounce_reason, error: r.error,
      }));
    return ok({ ...stats, recipients: rows, open_in_ui: `${LINK}/outbox` });
  },
);

tool(
  'set_tracking',
  'Schaltet die Öffnungs-Messung global ein oder aus (Zählpixel in gesendeten Mails). '
  + 'Braucht eine von außen erreichbare Adresse (MAIL_PUBLIC_URL) – ohne sie wird kein Pixel '
  + 'eingebaut. Je Entwurf lässt sich das mit update_draft(track_opens) überschreiben. '
  + 'Die Messung ist personenbezogen: nur einschalten, wenn der Nutzer das will.',
  { track_opens: z.boolean() },
  async ({ track_opens }) => {
    db.setSettings({ track_opens: track_opens ? '1' : '0' });
    return ok({
      track_opens,
      public_url: trackingBaseUrl() || null,
      reachable: trackingReachable(),
      note: trackingReachable() ? undefined
        : 'Ohne erreichbare MAIL_PUBLIC_URL wird trotz Einstellung kein Pixel eingebaut.',
    });
  },
);

tool(
  'update_contact',
  'Ändert einen Kontakt: Name, Firma, Telefon, Notiz und eigene Variablen (vars). '
  + 'Die Variablen eines Kontakts gewinnen beim Versand gegen Entwurfs- und Standardwerte.',
  {
    contact_id: z.number().int().optional(),
    email: z.string().optional().describe('Alternativ zur contact_id'),
    name: z.string().optional(),
    company: z.string().optional(),
    phone: z.string().optional(),
    notes: z.string().optional(),
    vars: z.record(z.string()).optional(),
  },
  async ({ contact_id, email, ...patch }) => {
    const c = contact_id ? db.getContactById(contact_id) : (email ? db.getContactByEmail(email) : null);
    if (!c) throw new Error('Kontakt nicht gefunden – contact_id oder email angeben.');
    const updated = db.updateContact(c.id, patch);
    return ok({ id: updated.id, email: updated.email, name: updated.name });
  },
);

tool(
  'remove_contact_from_list',
  'Nimmt einen Kontakt aus einer Liste (der Kontakt selbst bleibt im Adressbuch).',
  { list_id: z.number().int(), contact_id: z.number().int().optional(), email: z.string().optional() },
  async ({ list_id, contact_id, email }) => {
    const c = contact_id ? db.getContactById(contact_id) : (email ? db.getContactByEmail(email) : null);
    if (!c) throw new Error('Kontakt nicht gefunden – contact_id oder email angeben.');
    return ok({ removed: db.removeContactFromList(list_id, c.id) });
  },
);

tool(
  'delete_asset',
  'Löscht ein Bild aus der Medien-Bibliothek. Vorsicht: Vorlagen, die es einbinden, zeigen danach '
  + 'ein totes Bild – vorher mit list_templates prüfen, wer es benutzt.',
  { id: z.number().int() },
  async ({ id }) => ok({ deleted: db.deleteAsset(id) }),
);

tool(
  'delete_brand',
  'Löscht eine Marke. Entwürfe behalten die bereits übernommenen Werte – die Marke ist nur die Quelle.',
  { id: z.number().int() },
  async ({ id }) => ok({ deleted: db.deleteBrand(id) }),
);

tool(
  'set_default_brand',
  'Legt fest, welche Marke neue Entwürfe vorbelegt.',
  { id: z.number().int() },
  async ({ id }) => {
    const b = db.setDefaultBrand(id);
    if (!b) throw new Error('Marke nicht gefunden');
    return ok({ id: b.id, name: b.name, is_default: true });
  },
);

tool(
  'list_message_folders',
  'Welche Ordner des Postfachs sind lokal gespeichert, mit Anzahl und Ungelesenen? '
  + 'Der Ordnername ist der Schlüssel für sync_inbox und list_inbox.',
  { account_id: z.number().int().optional() },
  async ({ account_id }) => ok(db.listMessageFolders(account_id ?? null)),
);

tool(
  'set_message_flags',
  'Markiert eine empfangene Mail als gelesen/ungelesen bzw. setzt oder entfernt die Markierung.',
  {
    id: z.number().int(),
    seen: z.boolean().optional(),
    flagged: z.boolean().optional(),
  },
  async ({ id, seen, flagged }) => {
    if (!db.getMessage(id)) throw new Error('Nachricht nicht gefunden');
    if (seen !== undefined) db.setMessageSeen(id, seen);
    if (flagged !== undefined) db.setMessageFlagged(id, flagged);
    const m = db.getMessage(id);
    return ok({ id: m.id, seen: !!m.seen, flagged: !!m.flagged });
  },
);

tool(
  'delete_message',
  'Entfernt eine Mail aus dem LOKALEN Posteingang. Auf dem Mail-Server bleibt sie liegen und '
  + 'kommt beim nächsten Abruf ggf. wieder.',
  { id: z.number().int() },
  async ({ id }) => ok({ deleted: db.deleteMessage(id) }),
);

tool(
  'reply_to_message',
  'Legt einen Antwort-Entwurf auf eine empfangene Mail an: Betreff mit Re:, Empfänger und Account '
  + 'übernommen, Originaltext als Zitat unten. Gesendet wird nichts – der Entwurf landet in der UI.',
  {
    message_id: z.number().int().describe('id aus list_inbox'),
    html: z.string().optional().describe('Antworttext als HTML; ohne Angabe entsteht ein Gerüst'),
    quote: z.boolean().optional().default(true).describe('Original als Zitat anhängen'),
  },
  async ({ message_id, html, quote }) => {
    const m = db.getMessage(message_id);
    if (!m) throw new Error('Nachricht nicht gefunden');
    if (!m.from_email) throw new Error('Die Mail hat keine Absender-Adresse');
    const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const original = m.text || m.snippet || '';
    const quoted = quote && original
      ? `<hr><p style="color:#777;font-size:13px">Am ${m.date || ''} schrieb ${esc(m.from_name || m.from_email)}:</p>`
        + `<blockquote style="margin:12px 0;padding:8px 14px;border-left:2px solid #ccc;color:#555;white-space:pre-wrap">`
        + `${esc(original.slice(0, 4000))}</blockquote>`
      : '';
    const subject = /^re:/i.test(m.subject || '') ? m.subject : `Re: ${m.subject || ''}`;
    const draft = db.createDraft({
      account_id: m.account_id,
      subject,
      html: (html || '<p>Hallo {{name}},</p>\n<p>…</p>') + quoted,
      mode: 'batch',
      recipients: [{ email: m.from_email, name: m.from_name || null, kind: 'to' }],
    });
    return ok({ draft_id: draft.id, subject, to: m.from_email, open_in_ui: draftLink(draft.id) });
  },
);

tool(
  'verify_imap_account',
  'Prüft die IMAP-Zugangsdaten eines Accounts, ohne Mails zu laden.',
  { id: z.number().int() },
  async ({ id }) => {
    const a = db.getAccount(id);
    if (!a) throw new Error('Account nicht gefunden');
    if (!a.imap_host) throw new Error('Kein IMAP-Host konfiguriert');
    try { await verifyImap(a); return ok({ ok: true }); }
    catch (e) { return ok({ ok: false, error: e.message }); }
  },
);

  return server;
}
