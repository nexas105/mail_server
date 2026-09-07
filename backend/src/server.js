// MUSS der erste Import bleiben: harden.js setzt die umask beim Import, und
// ESM wertet Imports der Reihe nach VOR dem Modulrumpf aus – nur so entstehen
// mail.db, .keyfile & Co. (db.js) von vornherein nur für den eigenen Benutzer.
import { setRestrictiveUmask, hardenDataDir } from './harden.js';
setRestrictiveUmask(); // idempotent, nur noch zur Verdeutlichung
// ZWEITER Import: spielt ein hochgeladenes Backup (restore-pending.tgz) ein,
// bevor db.js weiter unten die Datenbank öffnet. Kein Export, nur Wirkung.
import './restore-boot.js';

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import * as db from './db.js';
import { PIXEL_GIF, PIXEL_PATH, trackingBaseUrl, trackingReachable, opensEnabledGlobally } from './tracking.js';
import * as auth from './auth.js';
import { installAuth, requireAdmin } from './auth-http.js';
import { sendDraft, sendTestMail, renderPreview, verifyAccount, preflightDraft } from './mailer.js';
import { fetchContacts } from './carddav.js';
import { parseVcf, contactsToVcf } from './vcard.js';
import { fetchInbox, verifyImap, listMailboxes } from './imap.js';
import * as gh from './github.js';
import * as wa from './whatsapp.js';
import { subscribe, ping as waPing, closeAllStreams, emit as waEmit } from './wa-bus.js';
import { ROOT_DIR, STATIC_DIR, DATA_DIR } from './paths.js';
import * as backup from './backup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.disable('etag');

// Hinter einem Reverse-Proxy (nginx, Caddy, Traefik) liefert erst das Vertrauen in
// X-Forwarded-* die echte Client-IP (Rate-Limits!) und https-Erkennung fürs Cookie.
// MAIL_TRUST_PROXY=1 | <Anzahl Hops> | <IP/CIDR-Liste>
const TRUST_PROXY = process.env.MAIL_TRUST_PROXY;
if (TRUST_PROXY) {
  app.set('trust proxy', /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY)
    : (TRUST_PROXY === 'true' ? true : TRUST_PROXY));
}

const PORT = Number(process.env.PORT || 3000);
// Standardmässig nur auf localhost lauschen. Wer den Server erreichbar machen will,
// setzt BIND_HOST=0.0.0.0 – dann greifen Host-Allowlist und Anmeldepflicht.
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
const LOOPBACK_ONLY = ['127.0.0.1', '::1', 'localhost'].includes(BIND_HOST);

// Host-Allowlist gegen DNS-Rebinding: eine fremde Domain, die auf diesen Server
// zeigt, wird abgewiesen, bevor irgendetwas ausgeliefert wird.
const ALLOWED_HOSTS = (process.env.MAIL_ALLOWED_HOSTS || '')
  .split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
const DEFAULT_LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];
// Interne Namen, die zusätzlich immer gelten: im Docker-Betrieb sprechen der
// Healthcheck (127.0.0.1) und der MCP-Container (Dienstname „backend") den
// Server unter Namen an, die nicht in MAIL_ALLOWED_HOSTS stehen.
const INTERNAL_HOSTS = (process.env.MAIL_INTERNAL_HOSTS || '')
  .split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
app.use((req, res, next) => {
  const host = String(req.get('host') || '').toLowerCase().replace(/:\d+$/, '');
  const allowed = ALLOWED_HOSTS.length ? ALLOWED_HOSTS : (LOOPBACK_ONLY ? DEFAULT_LOCAL_HOSTS : null);
  if (allowed && host && !allowed.includes(host) && !INTERNAL_HOSTS.includes(host)) {
    return res.status(421).json({ error: `Host "${host}" ist nicht freigegeben (MAIL_ALLOWED_HOSTS)` });
  }
  next();
});

// Sicherheits-Header. Die CSP ist auf die App zugeschnitten: kein fremdes Ziel,
// aber Inline-Styles (TinyMCE, Vorschau) und blob:/data: für Editor und Bilder.
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Cross-Origin-Opener-Policy', 'same-origin');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
  if (req.secure || req.get('x-forwarded-proto') === 'https') {
    res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  if (!req.path.startsWith('/api/') && process.env.MAIL_CSP !== '0') {
    res.set('Content-Security-Policy', [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'self'",
      "form-action 'self'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self' 'unsafe-inline' blob:",
      "connect-src 'self'",
      "frame-src 'self' blob:",
    ].join('; '));
  }
  next();
});

app.use(express.json({ limit: '30mb' }));

// Anmeldung, Sitzungen, /api/auth/* und der Schutzwall vor allen weiteren
// /api-Routen. Muss VOR den Routen stehen, die geschützt werden sollen.
installAuth(app);

const projectRoot = ROOT_DIR;
const mcpPath = path.join(__dirname, 'mcp-server.js');

app.get('/api/info', (req, res) => {
  res.json({
    node: process.execPath,
    mcpServerPath: mcpPath,
    projectRoot,
    uiUrl: `http://localhost:${process.env.PORT || 3000}`,
  });
});

// Zählpixel. Öffentlich erreichbar – der Aufrufer ist der Mail-Client des
// Empfängers, nicht die angemeldete Oberfläche. Antwortet IMMER mit dem GIF,
// auch bei unbekanntem Token: ein Fehlerbild im Postfach wäre verräterisch und
// hilft niemandem.
app.get(PIXEL_PATH + ':token.gif', (req, res) => {
  try {
    db.recordOpen(String(req.params.token || ''), { client: req.get('user-agent') });
  } catch (e) { console.error('[track]', e.message); }
  res.set({
    'Content-Type': 'image/gif',
    'Content-Length': String(PIXEL_GIF.length),
    // Ohne no-store liefert ein Proxy die zweite Öffnung aus dem Cache.
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    Pragma: 'no-cache',
    Expires: '0',
  });
  res.end(PIXEL_GIF);
});

// Zustand der Nachverfolgung für die Oberfläche: ohne öffentlich erreichbare
// Adresse kann das Pixel nichts messen – das soll die UI sagen können.
app.get('/api/tracking/status', (req, res) => res.json({
  base_url: trackingBaseUrl() || null,
  reachable: trackingReachable(),
  opens_enabled: opensEnabledGlobally(db.getAllSettings()),
}));

// Health-/Liveness-Check für das Frontend (Backend erreichbar? DB ok?).
const startedAt = Date.now();
app.get('/api/health', (req, res) => {
  let dbOk = true, accounts = null;
  try { accounts = db.listAccounts().length; } catch { dbOk = false; }
  const base = {
    ok: dbOk,
    status: dbOk ? 'up' : 'degraded',
    version: '1.0.0',
    needs_setup: auth.needsSetup(),
    time: new Date().toISOString(),
  };
  // Details (PID, Node-Version, Kontenzahl) nur für Angemeldete bzw. lokal –
  // der Launcher fragt über 127.0.0.1, ein Fremder im Netz erfährt nichts.
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip);
  if (!req.auth?.user && !local) return res.json(base);
  res.json({
    ...base,
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    node: process.version,
    db_ok: dbOk,
    accounts,
    pid: process.pid,
  });
});

// Gerendertes Fremd-HTML (Vorschau, empfangene Mails) läuft im iframe auf DIESEM
// Ursprung. Ohne script-src 'none' wäre jede Mail mit <script> ein XSS in der App.
// Externe Bilder sind standardmäßig gesperrt (Tracking-Pixel, Lese-Bestätigung
// an den Absender); nur wenn der Aufrufer sie ausdrücklich freigibt, dürfen
// https:/http:-Quellen geladen werden.
function sendUntrustedHtml(res, html, { externalImages = false } = {}) {
  res.set('Content-Security-Policy', [
    "default-src 'none'",
    externalImages ? "img-src 'self' data: https: http:" : "img-src 'self' data:",
    "style-src 'unsafe-inline' 'self'",
    "font-src 'self' data:",
    "script-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ].join('; '));
  res.set('X-Content-Type-Options', 'nosniff');
  res.type('html').send(html);
}

// Hochgeladene bzw. empfangene Dateien (Assets, Anhänge, WhatsApp-Medien) liegen
// auf DIESEM Ursprung. Nur harmlose Typen dürfen inline angezeigt werden – alles
// andere (SVG mit Script, HTML, unbekannte Typen) geht als Download raus, sonst
// wäre jede fremde Datei ein potenzielles XSS in der App.
const INLINE_MIME_EXACT = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'video/mp4', 'video/webm', 'video/3gpp',
  'application/pdf',
]);
const INLINE_AUDIO_SUBTYPES = new Set(['ogg', 'mpeg', 'mp4', 'aac', 'wav', 'opus', 'webm']);
function inlineMimeAllowed(mime) {
  if (INLINE_MIME_EXACT.has(mime)) return true;
  if (mime.startsWith('audio/')) return INLINE_AUDIO_SUBTYPES.has(mime.slice(6));
  return false;
}
// kind: 'image' | 'audio' | 'video' | … – wenn gesetzt (WhatsApp-Medien), muss
// der Mime-Typ zur Nachrichtenart passen, sonst ebenfalls nur Download.
function sendUntrustedFile(res, { path: filePath, mime, kind, filename }) {
  const clean = String(mime || '').split(';')[0].trim().toLowerCase();
  const kindOk = !kind || !['image', 'audio', 'video'].includes(kind) || clean.startsWith(kind + '/');
  const isSvg = clean === 'image/svg+xml';
  const inline = clean && inlineMimeAllowed(clean) && kindOk;
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    // SVG darf als <img> weiterhin geladen werden, nur nicht als Dokument mit Script laufen.
    'Content-Security-Policy': isSvg ? "sandbox; script-src 'none'; default-src 'none'" : "sandbox; default-src 'none'",
  };
  if (inline) {
    res.type(clean);
  } else {
    res.type(isSvg ? clean : 'application/octet-stream');
    // Sicherer Dateiname für Content-Disposition (ohne Steuerzeichen/Anführungszeichen)
    const safeName = String(filename || 'download').replace(/[^\w.\-() ]+/g, '_').slice(0, 120) || 'download';
    headers['Content-Disposition'] = `attachment; filename="${safeName}"`;
  }
  res.sendFile(filePath, { headers });
}

const wrap = fn => (req, res) => new Promise(resolve => resolve(fn(req, res))).catch(e => {
  console.error(e);
  res.status(e.status || 400).json({ error: e.message });
});

// Externe Versand-API. Bewusst separat geschützt, damit die lokale Web-UI
// weiterhin ohne Login funktioniert. Schlüssel: Authorization: Bearer …
function requireApiKey(req, res, next) {
  const expected = process.env.MAIL_API_KEY;
  if (!expected) return apiError(res, 503, 'api_disabled', 'Versand-API nicht aktiviert (MAIL_API_KEY fehlt)');
  const auth = req.get('authorization') || '';
  const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : (req.get('x-api-key') || '');
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return apiError(res, 401, 'unauthorized', 'Ungültiger API-Key');
  }
  next();
}

function apiError(res, status, code, message, details) {
  return res.status(status).json({ ok: false, error: { code, message, ...(details ? { details } : {}) }, request_id: res.locals.requestId });
}

const apiHits = new Map();
function apiRateLimit(req, res, next) {
  const limit = Math.max(1, Number(process.env.MAIL_API_RATE_LIMIT || 60));
  const key = req.ip || 'unknown';
  const now = Date.now();
  const entry = apiHits.get(key);
  const current = !entry || entry.resetAt <= now ? { count: 0, resetAt: now + 60_000 } : entry;
  current.count++; apiHits.set(key, current);
  res.set('X-RateLimit-Limit', String(limit));
  res.set('X-RateLimit-Remaining', String(Math.max(0, limit - current.count)));
  res.set('X-RateLimit-Reset', String(Math.ceil(current.resetAt / 1000)));
  if (current.count > limit) return apiError(res, 429, 'rate_limit_exceeded', 'Zu viele API-Anfragen');
  next();
}

app.use('/api/v1', (req, res, next) => {
  res.locals.requestId = req.get('x-request-id') || crypto.randomUUID();
  res.set('X-Request-Id', res.locals.requestId);
  next();
});

function apiRecipients(value, kind, sharedVars) {
  const items = value == null ? [] : (Array.isArray(value) ? value : [value]);
  return items.map(item => {
    const rc = typeof item === 'string' ? { email: item } : (item || {});
    return {
      email: String(rc.email || '').trim(), name: rc.name || null, kind,
      vars: { ...sharedVars, ...(rc.vars || {}) },
    };
  });
}

class ApiValidationError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details; }
}

const apiWrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(error => {
  if (error instanceof ApiValidationError) return apiError(res, 422, error.code, error.message, error.details);
  console.error(error);
  return apiError(res, 500, 'internal_error', error.message || 'Interner Fehler');
});

function createApiDraft(body = {}) {
  const settings = db.getAllSettings();
  const accountId = Number(body.account_id || settings.default_account_id || 0);
  if (!accountId || !db.getAccount(accountId)) throw new ApiValidationError('invalid_account', 'Gültige account_id erforderlich');

  const sharedVars = body.vars && typeof body.vars === 'object' ? body.vars : {};
  const recipients = [
    ...apiRecipients(body.to, 'to', sharedVars),
    ...apiRecipients(body.cc, 'cc', sharedVars),
    ...apiRecipients(body.bcc, 'bcc', sharedVars),
    ...(Array.isArray(body.recipients) ? body.recipients.map(rc => ({
      email: String(rc?.email || '').trim(), name: rc?.name || null,
      kind: ['to', 'cc', 'bcc'].includes(rc?.kind) ? rc.kind : 'to',
      vars: { ...sharedVars, ...(rc?.vars || {}) },
    })) : []),
  ];
  if (recipients.length > 1000) throw new ApiValidationError('too_many_recipients', 'Maximal 1000 Empfänger pro Request');
  if (!recipients.some(r => r.kind === 'to' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email))) {
    throw new ApiValidationError('missing_recipient', 'Mindestens ein gültiger To-Empfänger erforderlich');
  }
  const invalid = recipients.filter(r => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)).map(r => r.email);
  if (invalid.length) throw new ApiValidationError('invalid_recipient', 'Ungültige Empfängeradresse', invalid);

  let subject = String(body.subject || '');
  let html = String(body.html || '');
  let text = String(body.text || '');
  if (body.template_id) {
    const template = db.getTemplate(Number(body.template_id));
    if (!template) throw new ApiValidationError('template_not_found', 'Vorlage nicht gefunden');
    subject = body.subject ?? template.subject;
    html = body.html ?? template.html;
  }
  subject = String(subject || '');
  html = String(html || '');
  text = String(text || '');
  if (!subject.trim()) throw new ApiValidationError('missing_subject', 'subject erforderlich');
  if (!html.trim() && !text.trim()) throw new ApiValidationError('missing_content', 'html oder text erforderlich');

  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  const totalBytes = attachments.reduce((sum, a) => sum + Math.floor(String(a?.base64 || '').length * .75), 0);
  if (totalBytes > 20 * 1024 * 1024) throw new ApiValidationError('attachments_too_large', 'Anhänge dürfen zusammen maximal 20 MB groß sein');
  if (attachments.some(a => !a?.filename || !a?.base64)) throw new ApiValidationError('invalid_attachment', 'Jeder Anhang benötigt filename und base64');

  const draft = db.createDraft({
    account_id: accountId, subject, html, text,
    mode: body.mode === 'single' ? 'single' : 'batch',
    reply_to: body.reply_to || null,
    header_template_id: body.header_template_id || null,
    footer_template_id: body.footer_template_id || null,
    recipients,
  });
  for (const attachment of attachments) db.addAttachment(draft.id, attachment);
  return draft;
}

app.get('/api/v1/health', (req, res) => res.json({ ok: true, service: 'mail-server', version: 'v1', api_enabled: !!process.env.MAIL_API_KEY, request_id: res.locals.requestId }));
app.get('/api/v1/openapi.json', (req, res) => res.json({
  openapi: '3.1.0',
  info: { title: 'Mail Server API', version: '1.0.0', description: 'API zum Erstellen und Versenden personalisierter E-Mails.' },
  servers: [{ url: '/api/v1' }],
  components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
  security: [{ bearerAuth: [] }],
  paths: {
    '/send': { post: { summary: 'Mail sofort senden', responses: { 200: { description: 'Versandergebnis' }, 422: { description: 'Validierungsfehler' } } } },
    '/drafts': { post: { summary: 'Entwurf anlegen', responses: { 201: { description: 'Entwurf erstellt' } } } },
    '/drafts/{id}': { get: { summary: 'Entwurf und Versandstatus abrufen', responses: { 200: { description: 'Entwurf' } } } },
    '/drafts/{id}/send': { post: { summary: 'Entwurf senden', responses: { 200: { description: 'Versandergebnis' } } } },
    '/drafts/{id}/resend-failed': { post: { summary: 'Fehlgeschlagene Zustellungen wiederholen', responses: { 200: { description: 'Versandergebnis' } } } },
    '/accounts': { get: { summary: 'SMTP-Accounts auflisten', responses: { 200: { description: 'Accounts' } } } },
    '/templates': { get: { summary: 'Vorlagen auflisten', responses: { 200: { description: 'Vorlagen' } } } },
  },
}));

app.use('/api/v1', requireApiKey, apiRateLimit);

app.get('/api/v1/accounts', (req, res) => res.json({ ok: true, data: db.listAccounts(), request_id: res.locals.requestId }));
app.get('/api/v1/templates', (req, res) => res.json({ ok: true, data: db.listTemplates(req.query.kind), request_id: res.locals.requestId }));

app.post('/api/v1/drafts', apiWrap((req, res) => {
  const draft = createApiDraft(req.body);
  res.status(201).json({ ok: true, draft_id: draft.id, status: draft.status, request_id: res.locals.requestId });
}));

app.get('/api/v1/drafts/:id', (req, res) => {
  const draft = db.getDraft(Number(req.params.id));
  if (!draft) return apiError(res, 404, 'draft_not_found', 'Entwurf nicht gefunden');
  res.json({ ok: true, data: draft, request_id: res.locals.requestId });
});

app.post('/api/v1/drafts/:id/send', apiWrap(async (req, res) => {
  if (!db.getDraft(Number(req.params.id))) return apiError(res, 404, 'draft_not_found', 'Entwurf nicht gefunden');
  const result = await sendDraft(Number(req.params.id));
  res.json({ ok: result.failed === 0, draft_id: Number(req.params.id), ...result, request_id: res.locals.requestId });
}));

app.post('/api/v1/drafts/:id/resend-failed', apiWrap(async (req, res) => {
  if (!db.getDraft(Number(req.params.id))) return apiError(res, 404, 'draft_not_found', 'Entwurf nicht gefunden');
  const result = await sendDraft(Number(req.params.id), () => {}, { onlyFailed: true });
  res.json({ ok: result.failed === 0, draft_id: Number(req.params.id), ...result, request_id: res.locals.requestId });
}));

app.post('/api/v1/send', apiWrap(async (req, res) => {
  const idemKey = String(req.get('idempotency-key') || '').trim();
  if (idemKey.length > 200) throw new ApiValidationError('invalid_idempotency_key', 'Idempotency-Key darf maximal 200 Zeichen lang sein');
  const requestHash = crypto.createHash('sha256').update(JSON.stringify(req.body || {})).digest('hex');
  if (idemKey) {
    const cached = db.getApiRequest(idemKey);
    if (cached && cached.request_hash !== requestHash) return apiError(res, 409, 'idempotency_conflict', 'Idempotency-Key wurde bereits mit anderen Daten verwendet');
    if (cached) return res.set('Idempotency-Replayed', 'true').json({ ...cached.response, request_id: res.locals.requestId });
  }
  const draft = createApiDraft(req.body);
  const result = await sendDraft(draft.id);
  const response = { ok: result.failed === 0, draft_id: draft.id, ...result };
  if (idemKey) db.saveApiRequest(idemKey, requestHash, response);
  res.json({ ...response, request_id: res.locals.requestId });
}));

// ---- MCP-Zugang & Protokoll ----------------------------------------------
// Token für den HTTP-Betrieb des MCP-Servers: benannt, einzeln widerrufbar,
// optional nur-lesend. Nur Administratoren – ein Token ist ein Vollzugang.
app.get('/api/mcp/tokens', requireAdmin, wrap(async (req, res) => {
  const m = await import('./mcp-access.js');
  res.json(m.listMcpTokens());
}));
app.post('/api/mcp/tokens', requireAdmin, wrap(async (req, res) => {
  const m = await import('./mcp-access.js');
  res.status(201).json(m.createMcpToken({
    name: req.body?.name, readonly: !!req.body?.readonly,
    days: req.body?.days || null, createdBy: req.auth?.user?.email || null,
  }));
}));
app.put('/api/mcp/tokens/:id', requireAdmin, wrap(async (req, res) => {
  const m = await import('./mcp-access.js');
  const t = m.updateMcpToken(+req.params.id, req.body || {});
  if (!t) return res.status(404).json({ error: 'not found' });
  res.json(t);
}));
app.delete('/api/mcp/tokens/:id', requireAdmin, wrap(async (req, res) => {
  const m = await import('./mcp-access.js');
  res.json({ ok: m.deleteMcpToken(+req.params.id) });
}));

// Was hat die KI getan? Jeder Werkzeug-Aufruf mit Dauer, Erfolg und knapper
// Argument-Zusammenfassung – ohne Inhalte.
app.get('/api/mcp/events', wrap(async (req, res) => {
  const m = await import('./mcp-access.js');
  res.json({
    stats: m.mcpEventStats(),
    events: m.listMcpEvents({
      limit: +req.query.limit || 200,
      tool: req.query.tool || null,
      transport: req.query.transport || null,
      onlyErrors: req.query.errors === '1',
    }),
  });
}));

// Kompakte, inhaltsfreie Nutzungsanalyse für das zentrale Dashboard.
app.get('/api/dashboard/analytics', wrap(async (req, res) => {
  const m = await import('./mcp-access.js');
  res.json({ ...db.dashboardAnalytics(), mcp: m.mcpEventStats() });
}));

// Welche MCP-Werkzeuge bietet DIESE Installation? Liest das Verzeichnis aus
// src/mcp-tools.js, damit die Anleitung nicht von Hand nachgepflegt werden muss
// (und Abschaltungen per MCP_READONLY/MCP_DISABLED_TOOLS ehrlich abbildet).
app.get('/api/mcp/tools', wrap(async (req, res) => {
  const { toolCatalog } = await import('./mcp-tools.js');
  res.json(toolCatalog());
}));

// ---- Einstellungen (z.B. default_account_id) ------------------------------
app.get('/api/settings', wrap((req, res) => res.json(db.getAllSettings())));
app.put('/api/settings', requireAdmin, wrap((req, res) => res.json(db.setSettings(req.body || {}))));

// ---- Marken (Brands): Variablen-Presets inkl. Farbe -----------------------
app.get('/api/brands', wrap((req, res) => res.json(db.listBrands())));
// Aufbau der Farb-Palette (Slots, Beschriftungen, was abgeleitet wird) – die
// Oberfläche baut daraus den Farbeditor, ohne die Liste zu duplizieren.
app.get('/api/brands/palette', wrap((req, res) => res.json({
  fields: db.BRAND_PALETTE.map(f => ({ key: f.key, label: f.label, hint: f.hint, derived: false })),
  derived: db.BRAND_PALETTE_DERIVED.map(f => ({ key: f.key, label: f.label, derived: true })),
  defaults: db.brandPalette({}),
})));
app.post('/api/brands', wrap((req, res) => res.status(201).json(db.upsertBrand(req.body || {}))));
app.put('/api/brands/:id', wrap((req, res) => {
  const b = db.upsertBrand({ id: +req.params.id, ...req.body });
  if (!b) return res.status(404).json({ error: 'not found' });
  res.json(b);
}));
app.delete('/api/brands/:id', wrap((req, res) => res.json({ ok: db.deleteBrand(+req.params.id) })));
app.post('/api/brands/:id/default', wrap((req, res) => res.json(db.setDefaultBrand(+req.params.id))));
// Marke auf einen Entwurf anwenden: mischt draft.vars mit den Marken-Werten (Marken-Keys
// gewinnen, damit ein Wechsel wirkt; Nicht-Marken-Felder des Entwurfs bleiben erhalten).
app.post('/api/drafts/:id/apply-brand/:brandId', wrap((req, res) => {
  const brand = db.getBrand(+req.params.brandId);
  if (!brand) return res.status(404).json({ error: 'Marke nicht gefunden' });
  const cur = db.getDraft(+req.params.id);
  if (!cur) return res.status(404).json({ error: 'Entwurf nicht gefunden' });
  let curVars = {}; if (cur.vars) { try { curVars = JSON.parse(cur.vars); } catch { /* ignore */ } }
  res.json(db.updateDraft(+req.params.id, { vars: { ...curVars, ...db.brandVars(brand) } }));
}));

// ---- Assets (Medien-Bibliothek: Logos/Bilder) -----------------------------
const assetJson = express.json({ limit: '25mb' });
app.get('/api/assets', wrap((req, res) => res.json(db.listAssets())));
app.post('/api/assets', assetJson, wrap((req, res) => {
  const { filename, mimetype, base64 } = req.body || {};
  if (!filename || !base64 || !mimetype) return res.status(400).json({ error: 'filename, mimetype und base64 erforderlich' });
  res.status(201).json(db.addAsset({ filename, mimetype, base64 }));
}));
app.get('/api/assets/:id/file', wrap((req, res) => {
  const a = db.getAsset(+req.params.id);
  if (!a) return res.status(404).send('not found');
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  sendUntrustedFile(res, { path: a.stored_path, mime: a.mimetype, filename: a.filename });
}));
app.delete('/api/assets/:id', wrap((req, res) => res.json({ ok: db.deleteAsset(+req.params.id) })));

// ---- Accounts -------------------------------------------------------------
app.get('/api/accounts', wrap((req, res) => res.json(db.listAccounts())));
app.post('/api/accounts', requireAdmin, wrap((req, res) => res.status(201).json(db.createAccount(req.body))));
app.put('/api/accounts/:id', requireAdmin, wrap((req, res) => {
  const a = db.updateAccount(+req.params.id, req.body);
  if (!a) return res.status(404).json({ error: 'not found' });
  res.json(a);
}));
app.delete('/api/accounts/:id', requireAdmin, wrap((req, res) => res.json({ ok: db.deleteAccount(+req.params.id) })));
app.post('/api/accounts/:id/duplicate', requireAdmin, wrap((req, res) => {
  const a = db.duplicateAccount(+req.params.id, req.body?.name);
  if (!a) return res.status(404).json({ error: 'not found' });
  res.status(201).json(a);
}));
app.post('/api/accounts/:id/verify', requireAdmin, wrap(async (req, res) => {
  const a = db.getAccount(+req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  try { await verifyAccount(a); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
}));

// CardDAV: Kontakte des Accounts synchronisieren (optional in eine Liste)
app.post('/api/accounts/:id/carddav/sync', requireAdmin, wrap(async (req, res) => {
  const account = db.getAccount(+req.params.id);
  if (!account) return res.status(404).json({ error: 'not found' });
  if (!account.carddav_url) return res.status(400).json({ error: 'Keine CardDAV-URL konfiguriert' });
  const { url, user, pass } = db.getCardDavCreds(account);
  const contacts = await fetchContacts(url, user, pass);
  let list = null;
  if (req.body?.list) list = db.createList(req.body.list);
  let imported = 0;
  for (const c of contacts) {
    const contact = db.upsertContact(c.email, c.name);
    if (list) db.addContactToList(list.id, contact.id);
    imported++;
  }
  res.json({ found: contacts.length, imported, list: list?.name || null });
}));

// IMAP-Zugangsdaten des Accounts prüfen (ohne Mails zu laden)
app.post('/api/accounts/:id/imap/verify', requireAdmin, wrap(async (req, res) => {
  const a = db.getAccount(+req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  if (!a.imap_host) return res.status(400).json({ ok: false, error: 'Kein IMAP-Host konfiguriert' });
  try { await verifyImap(a); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
}));

// Posteingang synchronisieren: neue Mails per IMAP abrufen und speichern
app.post('/api/accounts/:id/inbox/sync', wrap(async (req, res) => {
  const account = db.getAccount(+req.params.id);
  if (!account) return res.status(404).json({ error: 'not found' });
  if (!account.imap_host) return res.status(400).json({ error: 'Kein IMAP-Host konfiguriert' });
  const folder = String(req.body?.folder || 'INBOX');
  const result = await fetchInbox(account, { folder, limit: +req.body?.limit || 50 });
  res.json(result);
}));
app.get('/api/accounts/:id/mailboxes', wrap(async (req, res) => {
  const account = db.getAccount(+req.params.id);
  if (!account) return res.status(404).json({ error: 'not found' });
  if (!account.imap_host) return res.status(400).json({ error: 'Kein IMAP-Host konfiguriert' });
  res.json(await listMailboxes(account));
}));

// ---- Posteingang (empfangene Mails) --------------------------------------
app.get('/api/messages', wrap((req, res) => res.json(db.listMessages({
  accountId: req.query.account_id ? +req.query.account_id : null,
  folder: req.query.folder === '*' ? null : String(req.query.folder || 'INBOX'),
  limit: +req.query.limit || 100,
}))));
app.get('/api/message-folders', wrap((req, res) => res.json(
  db.listMessageFolders(req.query.account_id ? +req.query.account_id : null),
)));
app.get('/api/messages/unread-count', wrap((req, res) => res.json({
  count: db.unreadCount(req.query.account_id ? +req.query.account_id : null),
})));
app.get('/api/messages/:id', wrap((req, res) => {
  const m = db.getMessage(+req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  res.json(m);
}));
// Roher HTML-Body für den iframe (mit Text-Fallback)
app.get('/api/messages/:id/body.html', wrap((req, res) => {
  const m = db.getMessage(+req.params.id);
  if (!m) return res.status(404).send('not found');
  const body = m.html
    || (m.text ? `<pre style="font-family:sans-serif;white-space:pre-wrap;margin:0">${m.text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre>` : '')
    || '<em style="font-family:sans-serif;color:#888">Kein Inhalt</em>';
  // Externe Bilder nur auf ausdrücklichen Wunsch (?external=1) – sonst könnte
  // jeder Absender per Tracking-Pixel sehen, wann die Mail geöffnet wurde.
  sendUntrustedHtml(res, body, { externalImages: req.query.external === '1' });
}));
app.post('/api/messages/:id/seen', wrap((req, res) => res.json({
  ok: db.setMessageSeen(+req.params.id, req.body?.seen !== false),
})));
app.post('/api/messages/:id/flag', wrap((req, res) => res.json({
  ok: db.setMessageFlagged(+req.params.id, req.body?.flagged !== false),
})));
app.delete('/api/messages/:id', wrap((req, res) => res.json({ ok: db.deleteMessage(+req.params.id) })));

// ---- Drafts ---------------------------------------------------------------
app.get('/api/drafts', wrap((req, res) => res.json(db.listDrafts(req.query.status))));
app.get('/api/drafts/:id', wrap((req, res) => {
  const d = db.getDraft(+req.params.id);
  if (!d) return res.status(404).json({ error: 'not found' });
  res.json(d);
}));
app.post('/api/drafts', wrap((req, res) => {
  // attachments dürfen direkt beim Anlegen mitkommen (wie in der v1-API).
  const { attachments = [], ...rest } = req.body || {};
  if (!Array.isArray(attachments)) throw new ApiValidationError('invalid_attachment', 'attachments muss ein Array sein');
  if (attachments.some(a => !a?.filename || !a?.base64)) throw new ApiValidationError('invalid_attachment', 'Jeder Anhang benötigt filename und base64');
  const totalBytes = attachments.reduce((sum, a) => sum + Math.floor(String(a.base64).length * .75), 0);
  if (totalBytes > 20 * 1024 * 1024) throw new ApiValidationError('attachments_too_large', 'Anhänge dürfen zusammen maximal 20 MB groß sein');
  const draft = db.createDraft(rest);
  for (const attachment of attachments) db.addAttachment(draft.id, attachment);
  res.status(201).json(attachments.length ? db.getDraft(draft.id) : draft);
}));
app.put('/api/drafts/:id', wrap((req, res) => {
  const d = db.updateDraft(+req.params.id, req.body);
  if (!d) return res.status(404).json({ error: 'not found' });
  res.json(d);
}));
app.delete('/api/drafts/:id', wrap((req, res) => res.json({ ok: db.deleteDraft(+req.params.id) })));
app.post('/api/drafts/:id/duplicate', wrap((req, res) => {
  const d = db.duplicateDraft(+req.params.id);
  if (!d) return res.status(404).json({ error: 'not found' });
  res.status(201).json(d);
}));
// Test-Versand an eine beliebige Adresse (Status bleibt unberührt)
app.post('/api/drafts/:id/test-send', wrap(async (req, res) => {
  const to = String(req.body?.to || '').trim();
  if (!to || !to.includes('@')) return res.status(400).json({ error: 'Gültige Empfängeradresse erforderlich' });
  res.json(await sendTestMail(+req.params.id, to));
}));
app.get('/api/drafts/:id/preflight', wrap((req, res) => res.json(preflightDraft(+req.params.id))));

// Recipients
app.post('/api/drafts/:id/recipients', wrap((req, res) => {
  if (req.body.replace) db.clearRecipients(+req.params.id);
  res.json(db.addRecipients(+req.params.id, req.body.recipients || []));
}));
// Add a whole list's contacts as recipients
app.post('/api/drafts/:id/recipients/from-list/:listId', wrap((req, res) => {
  const members = db.getListMembers(+req.params.listId);
  res.json(db.addRecipients(+req.params.id, members.map(m => ({ email: m.email, name: m.name, kind: req.body.kind || 'to' }))));
}));

// Preview (personalized). ?recipient=<id> or defaults to first To recipient.
app.get('/api/drafts/:id/preview', wrap((req, res) => {
  const p = renderPreview(+req.params.id, req.query.recipient ? +req.query.recipient : null);
  res.json(p);
}));
// Raw rendered HTML for iframe (srcdoc alternative)
app.get('/api/drafts/:id/preview.html', wrap((req, res) => {
  const p = renderPreview(+req.params.id, req.query.recipient ? +req.query.recipient : null);
  // Eigene Inhalte: externe Bilder (z.B. gehostete Logos) dürfen geladen werden.
  sendUntrustedHtml(res, p.html || '<em style="font-family:sans-serif;color:#888">Kein HTML-Inhalt</em>', { externalImages: true });
}));

// Send with live progress over Server-Sent Events
app.get('/api/drafts/:id/send', wrap(async (req, res) => {
  // Zustandsändernde GET-Route: Eine Top-Level-Navigation (Link, <iframe>,
  // <img src>) mit Cookie-Sitzung darf KEINEN Versand auslösen. EventSource
  // schickt Sec-Fetch-Dest: empty / Sec-Fetch-Mode: cors – alles andere lehnen
  // wir ab. Fehlt der Header (alte Browser, curl), lassen wir durch: ohne
  // Cookie kommt so ein Aufruf ohnehin nicht an der Anmeldung vorbei.
  if (req.auth?.via === 'cookie') {
    const dest = (req.get('sec-fetch-dest') || '').toLowerCase();
    if (dest && dest !== 'empty') {
      return res.status(403).json({ error: 'Versand nur aus der App heraus (kein Aufruf per Navigation/Einbettung)' });
    }
  }
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  try {
    const check = preflightDraft(+req.params.id);
    if (!check.ok) throw new Error('Versand durch Vorflug-Check blockiert: ' + check.blockers.map(x => x.message).join(' '));
    const result = await sendDraft(+req.params.id, p => send('progress', p), { onlyFailed: req.query.failed === '1' });
    send('done', result);
  } catch (e) {
    send('error', { error: e.message });
  }
  res.end();
}));
// Non-streaming send (used by MCP / scripts)
app.post('/api/drafts/:id/send', wrap(async (req, res) => {
  res.json(await sendDraft(+req.params.id, () => {}, { onlyFailed: req.query.failed === '1' }));
}));

// ---- Send events / Audit-Trail -------------------------------------------
app.get('/api/events', wrap((req, res) => res.json(db.listSendEvents({ limit: +req.query.limit || 200 }))));
app.get('/api/drafts/:id/events', wrap((req, res) => res.json(db.listSendEvents({ draftId: +req.params.id }))));

// ---- E-Mail-Vorlagen ------------------------------------------------------
app.get('/api/templates', wrap((req, res) => res.json(db.listTemplates(req.query.kind))));
app.get('/api/templates/:id', wrap((req, res) => {
  const t = db.getTemplate(+req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  res.json(t);
}));
app.post('/api/templates', wrap((req, res) => res.status(201).json(db.createTemplate(req.body))));
// Vorlagen + Custom-Felder aus content.seed.json (nach)laden – idempotent
app.post('/api/templates/seed', requireAdmin, wrap((req, res) => res.json(db.seedContent())));
app.post('/api/content/seed', requireAdmin, wrap((req, res) => res.json(db.seedContent())));
// Aktuellen Stand als JSON zurückgeben (Download/Ansehen)
app.get('/api/content/export', wrap((req, res) => res.json(db.contentSnapshot())));
// Aktuellen Stand nach content.seed.json schreiben (zum Committen/Versionieren)
app.post('/api/content/export', requireAdmin, wrap((req, res) => res.json(db.exportContent())));
app.put('/api/templates/:id', wrap((req, res) => {
  const t = db.updateTemplate(+req.params.id, req.body);
  if (!t) return res.status(404).json({ error: 'not found' });
  res.json(t);
}));
app.delete('/api/templates/:id', wrap((req, res) => res.json({ ok: db.deleteTemplate(+req.params.id) })));

// ---- Globale Platzhalter -------------------------------------------------
app.get('/api/custom-fields', wrap((req, res) => res.json(db.listCustomFields())));
app.post('/api/custom-fields', wrap((req, res) => res.status(201).json(db.upsertCustomField(req.body))));
app.delete('/api/custom-fields/:id', wrap((req, res) => res.json({ ok: db.deleteCustomField(+req.params.id) })));

// ---- Datei-Anhänge --------------------------------------------------------
const bigJson = express.json({ limit: '30mb' }); // Uploads dürfen größer sein als die Standard-5mb
app.get('/api/drafts/:id/attachments', wrap((req, res) => res.json(db.listAttachments(+req.params.id))));
app.post('/api/drafts/:id/attachments', bigJson, wrap((req, res) => {
  const { filename, mimetype, base64 } = req.body || {};
  if (!filename || !base64) return res.status(400).json({ error: 'filename und base64 erforderlich' });
  res.status(201).json(db.addAttachment(+req.params.id, { filename, mimetype, base64 }));
}));
app.delete('/api/attachments/:id', wrap((req, res) => res.json({ ok: db.deleteAttachment(+req.params.id) })));
app.get('/api/attachments/:id/download', wrap((req, res) => {
  const a = db.getAttachment(+req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  // Download erzwingt bereits Content-Disposition: attachment; nosniff + CSP
  // zusätzlich, falls ein Browser die Datei doch inline öffnet.
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "sandbox; default-src 'none'");
  res.download(a.stored_path, a.filename);
}));

// ---- Contacts & lists -----------------------------------------------------
app.get('/api/contacts', wrap((req, res) => res.json(db.listContacts())));
app.post('/api/contacts', wrap((req, res) => {
  if (!req.body?.email && !req.body?.name) throw new Error('Name oder E-Mail-Adresse angeben');
  const c = db.createContact(req.body);
  const { company, phone, notes } = req.body;
  const full = (company != null || phone != null || notes != null)
    ? db.updateContact(c.id, { company, phone, notes }) : c;
  res.status(201).json(full);
}));
app.put('/api/contacts/:id', wrap((req, res) => {
  const c = db.updateContact(+req.params.id, req.body);
  if (!c) return res.status(404).json({ error: 'not found' });
  res.json(c);
}));
app.delete('/api/contacts/:id', wrap((req, res) => res.json({ ok: db.deleteContact(+req.params.id) })));
app.get('/api/lists', wrap((req, res) => res.json(db.listLists())));
app.post('/api/lists', wrap((req, res) => res.status(201).json(db.createList(req.body.name))));
app.delete('/api/lists/:id', wrap((req, res) => res.json({ ok: db.deleteList(+req.params.id) })));
app.post('/api/lists/:id/contacts', wrap((req, res) => {
  // Per Kontakt-ID (Drag & Drop) oder per E-Mail/Name (Formular) hinzufügen.
  const c = req.body.contact_id
    ? db.getContactById(+req.body.contact_id)
    : db.upsertContact(req.body.email, req.body.name);
  if (!c) return res.status(404).json({ error: 'Kontakt nicht gefunden' });
  db.addContactToList(+req.params.id, c.id);
  res.json(c);
}));
app.delete('/api/lists/:id/contacts/:contactId', wrap((req, res) =>
  res.json({ ok: db.removeContactFromList(+req.params.id, +req.params.contactId) })));
// CSV-Import: Kontakte in Adressbuch bzw. in eine Liste übernehmen
app.post('/api/contacts/import', wrap((req, res) => {
  const rows = Array.isArray(req.body?.contacts) ? req.body.contacts : [];
  let imported = 0;
  for (const r of rows) { if (r?.email) { db.upsertContact(r.email, r.name); imported++; } }
  res.json({ imported });
}));
app.post('/api/lists/:id/import', wrap((req, res) => {
  const listId = +req.params.id;
  const rows = Array.isArray(req.body?.contacts) ? req.body.contacts : [];
  let imported = 0;
  for (const r of rows) {
    if (!r?.email) continue;
    const c = db.upsertContact(r.email, r.name);
    db.addContactToList(listId, c.id);
    imported++;
  }
  res.json({ imported });
}));

// ---- vCard (.vcf) – Handy-Format Import/Export ----------------------------
function importVcards(text, listId = null) {
  let imported = 0;
  for (const c of parseVcf(text)) {
    const contact = db.upsertContact(c.email, c.name);
    if (c.phone || c.company) db.updateContact(contact.id, { phone: c.phone || undefined, company: c.company || undefined });
    if (listId) db.addContactToList(listId, contact.id);
    imported++;
  }
  return imported;
}
app.post('/api/contacts/import-vcf', wrap((req, res) => res.json({ imported: importVcards(req.body?.vcf || '') })));
app.post('/api/lists/:id/import-vcf', wrap((req, res) => res.json({ imported: importVcards(req.body?.vcf || '', +req.params.id) })));
app.get('/api/contacts/export.vcf', wrap((req, res) => {
  res.type('text/vcard').set('Content-Disposition', 'attachment; filename="kontakte.vcf"');
  res.send(contactsToVcf(db.listContacts()));
}));
app.get('/api/lists/:id/export.vcf', wrap((req, res) => {
  const members = db.getListMembers(+req.params.id);
  res.type('text/vcard').set('Content-Disposition', 'attachment; filename="liste.vcf"');
  res.send(contactsToVcf(members));
}));

// Serviert das gebaute React-Frontend (frontend/dist). Fällt für Client-Routen
// (react-router) auf index.html zurück. Vorher `npm run build` ausführen.
// ---- GitHub-Verbindungen --------------------------------------------------
// Das Token verlässt den Server nie: listGithubConnections liefert nur has_token.
app.get('/api/github/connections', wrap((req, res) => res.json(db.listGithubConnections())));
app.post('/api/github/connections', requireAdmin, wrap((req, res) => {
  if (!req.body?.token) throw new Error('Token erforderlich');
  res.status(201).json(db.createGithubConnection(req.body));
}));
app.put('/api/github/connections/:id', requireAdmin, wrap((req, res) => {
  const c = db.updateGithubConnection(+req.params.id, req.body || {});
  if (!c) return res.status(404).json({ error: 'not found' });
  res.json(c);
}));
app.delete('/api/github/connections/:id', requireAdmin, wrap((req, res) =>
  res.json({ ok: db.deleteGithubConnection(+req.params.id) })));
app.post('/api/github/connections/:id/default', requireAdmin, wrap((req, res) =>
  res.json(db.setDefaultGithubConnection(+req.params.id))));

app.post('/api/github/connections/:id/verify', requireAdmin, wrap(async (req, res) => {
  const id = +req.params.id;
  if (!db.getGithubConnection(id)) return res.status(404).json({ error: 'not found' });
  try {
    const info = await gh.verifyToken(db.getGithubToken(id));
    db.markGithubVerified(id, info);
    res.json({ ok: true, ...info });
  } catch (e) {
    db.markGithubError(id, e.message);
    res.status(400).json({ ok: false, error: gh.redact(e.message) });
  }
}));

// Repos des Tokens – nur für die Auswahl beim Verknüpfen.
app.get('/api/github/connections/:id/repos', wrap(async (req, res) => {
  const conn = db.getGithubConnection(+req.params.id);
  if (!conn) return res.status(404).json({ error: 'not found' });
  res.json(await gh.listRepos(db.getGithubToken(conn), { limit: +req.query.limit || 100 }));
}));

// Alle Verknüpfungen dieser Verbindung neu auflösen (heilt Umbenennungen).
app.post('/api/github/connections/:id/sync', requireAdmin, wrap(async (req, res) => {
  const conn = db.getGithubConnection(+req.params.id);
  if (!conn) return res.status(404).json({ error: 'not found' });
  const creds = db.getGithubToken(conn);
  let updated = 0, failed = 0;
  for (const link of db.listContactRepos()) {
    if (link.connection_id !== conn.id) continue;
    try {
      const fresh = link.repo_id
        ? await gh.getRepoById(creds, link.repo_id)
        : await gh.getRepo(creds, { owner: link.owner, repo: link.name });
      db.touchContactRepo(link.id, fresh);
      updated++;
    } catch { failed++; }
  }
  res.json({ updated, failed });
}));

// ---- Repos an Kontakten ---------------------------------------------------
app.get('/api/contacts/:id/repos', wrap((req, res) => res.json(db.listContactRepos(+req.params.id))));
app.post('/api/contacts/:id/repos', wrap(async (req, res) => {
  const contact = db.getContactById(+req.params.id);
  if (!contact) return res.status(404).json({ error: 'not found' });
  const body = req.body || {};
  const full = String(body.full_name || `${body.owner || ''}/${body.name || ''}`).trim();
  const [owner, name] = full.split('/');
  if (!owner || !name) throw new Error('Repo als "owner/name" angeben');

  const conn = body.connection_id
    ? db.getGithubConnection(+body.connection_id)
    : db.getDefaultGithubConnection();
  if (!conn) throw new Error('Keine GitHub-Verbindung hinterlegt – erst in den Einstellungen anlegen');

  // Beim Verknüpfen einmal auflösen: so landet keine tote Zeile in der DB und
  // wir bekommen die numerische repo_id, die Umbenennungen übersteht.
  const repo = await gh.getRepo(db.getGithubToken(conn), { owner, repo: name });
  res.status(201).json(db.addContactRepo(contact.id, { ...repo, connection_id: conn.id, role: body.role }));
}));
app.put('/api/contact-repos/:id', wrap((req, res) => {
  const r = db.updateContactRepo(+req.params.id, req.body || {});
  if (!r) return res.status(404).json({ error: 'not found' });
  res.json(r);
}));
app.delete('/api/contact-repos/:id', wrap((req, res) =>
  res.json({ ok: db.deleteContactRepo(+req.params.id) })));
app.post('/api/contact-repos/:id/refresh', wrap(async (req, res) => {
  const link = db.getContactRepo(+req.params.id);
  if (!link) return res.status(404).json({ error: 'not found' });
  const conn = db.getGithubConnection(link.connection_id) || db.getDefaultGithubConnection();
  if (!conn) throw new Error('Keine GitHub-Verbindung hinterlegt');
  const fresh = link.repo_id
    ? await gh.getRepoById(db.getGithubToken(conn), link.repo_id)
    : await gh.getRepo(db.getGithubToken(conn), { owner: link.owner, repo: link.name });
  res.json(db.touchContactRepo(link.id, fresh));
}));

// Hinweis: Es gibt bewusst KEINE HTTP-Routen zum Lesen von Dateiinhalten.
// Die /api/*-Fläche hat keine Authentifizierung – solche Routen wären offene
// Quelltext-Endpunkte. Der MCP-Server holt Inhalte direkt bei GitHub.

// ---- WhatsApp -------------------------------------------------------------
// Der Baileys-Socket lebt nur in DIESEM Prozess. Der MCP-Server liest aus SQLite
// und schickt Sende-Aufträge hierher (Header X-Origin: mcp).
app.get('/api/whatsapp/accounts', wrap((req, res) => res.json(wa.listSessions())));
// Volle Konto-Zeilen inkl. Regeln (mcp_send_mode, Stundenlimit) für die Einstellungen.
// Muss vor /accounts/:id stehen, sonst schluckt der Parameter das Wort "settings".
app.get('/api/whatsapp/accounts/settings', wrap((req, res) => res.json(db.listWaAccounts())));
app.post('/api/whatsapp/accounts', requireAdmin, wrap((req, res) =>
  res.status(201).json(db.createWaAccount(req.body || {}))));
app.put('/api/whatsapp/accounts/:id', requireAdmin, wrap((req, res) => {
  const a = db.updateWaAccount(+req.params.id, req.body || {});
  if (!a) return res.status(404).json({ error: 'not found' });
  res.json(a);
}));
app.delete('/api/whatsapp/accounts/:id', requireAdmin, wrap(async (req, res) => {
  await wa.stopSession(+req.params.id).catch(() => {});
  res.json({ ok: db.deleteWaAccount(+req.params.id) });
}));
app.get('/api/whatsapp/accounts/:id/status', wrap((req, res) => {
  const s = wa.sessionStatus(+req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  res.json(s);
}));
app.post('/api/whatsapp/accounts/:id/connect', requireAdmin, wrap(async (req, res) => {
  const { method, phone } = req.body || {};
  if (method === 'pairing' && !phone) throw new Error('Für den Kopplungs-Code wird die Telefonnummer gebraucht');
  // Antwortet sofort – QR bzw. Code kommen über den Live-Stream.
  res.json(await wa.startSession(+req.params.id, { method: method || 'qr', phone }));
}));
app.post('/api/whatsapp/accounts/:id/disconnect', requireAdmin, wrap(async (req, res) =>
  res.json(await wa.stopSession(+req.params.id))));
app.post('/api/whatsapp/accounts/:id/logout', requireAdmin, wrap(async (req, res) =>
  res.json(await wa.stopSession(+req.params.id, { logout: true }))));
// Harter Reset: löscht die Kopplung lokal, ohne WhatsApp fragen zu müssen.
// Der Ausweg, wenn die Sitzung in einem kaputten Zustand feststeckt.
app.post('/api/whatsapp/accounts/:id/reset', requireAdmin, wrap(async (req, res) =>
  res.json(await wa.resetSession(+req.params.id))));
// Telefonbuch-Namen erneut anfordern (kommen sonst nur einmal beim Koppeln).
app.post('/api/whatsapp/accounts/:id/resync-contacts', requireAdmin, wrap(async (req, res) =>
  res.json(await wa.resyncContacts(+req.params.id))));
// Gruppennamen und Teilnehmer für alle Gruppen auf einmal holen.
app.post('/api/whatsapp/accounts/:id/sync-groups', requireAdmin, wrap(async (req, res) =>
  res.json(await wa.syncAllGroups(+req.params.id))));
// Belegter Platz + Aufräumen von Hand anstoßen.
app.get('/api/whatsapp/media-usage', wrap((req, res) =>
  res.json(db.waMediaUsage(req.query.account_id ? +req.query.account_id : null))));
app.post('/api/whatsapp/accounts/:id/cleanup-media', requireAdmin, wrap((req, res) =>
  res.json(wa.cleanupMedia(+req.params.id))));

// Live-Stream. Bewusst OHNE wrap(): die Header sind längst raus, ein
// res.status(400).json() daraus würde die Verbindung zerschießen.
app.get('/api/whatsapp/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  // Startbild, damit ein automatischer Reconnect sich selbst heilt.
  res.write(`event: status\ndata: ${JSON.stringify(wa.listSessions())}\n\n`);
  const unsubscribe = subscribe(res);
  const timer = setInterval(() => { try { res.write(':ping\n\n'); } catch { /* weg */ } }, 25000);
  req.on('close', () => { clearInterval(timer); unsubscribe(); });
  // Kein res.end() – der Stream lebt, bis der Browser geht.
});

app.get('/api/whatsapp/chats', wrap((req, res) => res.json(db.listWaChats({
  waAccountId: req.query.account_id ? +req.query.account_id : null,
  query: req.query.q || null,
  archived: req.query.archived === '1' ? 1 : 0,
  limit: +req.query.limit || 60,
}))));
app.get('/api/whatsapp/chats/:id', wrap((req, res) => {
  const c = db.getWaChat(+req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  res.json(c);
}));
app.get('/api/whatsapp/chats/:id/messages', wrap((req, res) => res.json(db.listWaMessages({
  chatId: +req.params.id,
  limit: +req.query.limit || 50,
  beforeTs: req.query.before_ts ? +req.query.before_ts : null,
}))));
// Zwei Einzelchats derselben Person zusammenführen (z.B. @lid-Kennung und
// Nummer). Merkt sich die Zuordnung, damit es nicht wieder passiert.
app.post('/api/whatsapp/chats/:id/merge', wrap((req, res) => {
  const from = db.getWaChat(+req.params.id);
  const into = db.getWaChat(+req.body?.into_chat_id);
  if (!from || !into) return res.status(404).json({ error: 'Chat nicht gefunden' });
  try { res.json(wa.mergeChats(from.id, into.id, { reason: 'manual' })); }
  catch (e) { res.status(400).json({ error: e.message }); }
}));
app.post('/api/whatsapp/chats/:id/read', wrap(async (req, res) => {
  const chat = db.getWaChat(+req.params.id);
  if (!chat) return res.status(404).json({ error: 'not found' });
  res.json(await wa.markRead(chat.wa_account_id, chat.id));
}));
app.post('/api/whatsapp/chats/:id/backfill', wrap(async (req, res) => {
  const chat = db.getWaChat(+req.params.id);
  if (!chat) return res.status(404).json({ error: 'not found' });
  res.json(await wa.backfillChat(chat.wa_account_id, chat.id, {
    days: +req.body?.days || 90, maxRounds: +req.body?.max_rounds || 10,
  }));
}));

/**
 * Schutzregeln für Versand aus dem MCP-Prozess. Gelten für Sofortversand UND
 * für geplante Nachrichten – deshalb eine Funktion, nicht zwei Kopien.
 */
function assertMaySend(origin, account, chat) {
  if (origin !== 'mcp') return;
  if (process.env.MAIL_WA_MCP_SEND !== '1') {
    const e = new Error('Versand über MCP ist deaktiviert – MAIL_WA_MCP_SEND=1 setzen oder in der UI senden');
    e.status = 403; throw e;
  }
  if (account.mcp_send_mode === 'off') {
    const e = new Error(`Für "${account.name}" ist MCP-Versand abgeschaltet`);
    e.status = 403; throw e;
  }
  if (account.mcp_send_mode === 'known') {
    // Nur antworten, nie fremde Gespräche eröffnen: das ist zugleich der
    // wirksamste Schutz gegen eine Nummernsperre.
    if (!chat || !db.waChatHasInbound(chat.id)) {
      const e = new Error('MCP darf nur in Chats schreiben, in denen bereits eine Nachricht eingegangen ist');
      e.status = 403; throw e;
    }
  }
}

/**
 * Versand. Die Schutzmaßnahmen sitzen bewusst hier und nicht in einer
 * Tool-Beschreibung – so gelten sie für UI und MCP gleichermaßen.
 */
async function sendWhatsapp(req, { accountId, chatId, to, text, quoteWaId }) {
  const origin = req.get('x-origin') === 'mcp' ? 'mcp' : 'ui';
  if (!text || !String(text).trim()) throw new Error('Text fehlt');

  let chat = chatId ? db.getWaChat(chatId) : null;
  const id = accountId || chat?.wa_account_id;
  if (!id) throw new Error('Kein WhatsApp-Konto angegeben');
  const account = db.getWaAccount(id);
  if (!account) throw new Error('WhatsApp-Konto nicht gefunden');
  assertMaySend(origin, account, chat);

  let jid = chat?.jid;
  if (!jid) {
    jid = await wa.resolveJid(id, to);
    if (!jid) throw new Error(`${to} ist nicht bei WhatsApp registriert`);
  }
  const msg = await wa.sendText(id, jid, String(text), { quotedWaId: quoteWaId, origin });
  chat = chat || db.getWaChatByJid(id, jid);
  return { sent: true, wa_id: msg?.wa_id, chat_id: chat?.id, to: jid, origin };
}

app.post('/api/whatsapp/chats/:id/messages', wrap(async (req, res) => {
  const chat = db.getWaChat(+req.params.id);
  if (!chat) return res.status(404).json({ error: 'not found' });
  try {
    res.json(await sendWhatsapp(req, {
      chatId: chat.id, text: req.body?.text, quoteWaId: req.body?.quote_wa_id,
    }));
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
}));
// Auf eine Nachricht reagieren. Leeres emoji nimmt die Reaktion zurück.
app.post('/api/whatsapp/messages/:id/react', wrap(async (req, res) => {
  const m = db.getWaMessage(+req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  res.json(await wa.sendReaction(m.wa_account_id, m.chat_jid, m.wa_id, req.body?.emoji || ''));
}));

// Sticker: fertiges WebP aus dem Browser, hier wird nur noch verschickt.
app.post('/api/whatsapp/chats/:id/sticker', bigJson, wrap(async (req, res) => {
  const chat = db.getWaChat(+req.params.id);
  if (!chat) return res.status(404).json({ error: 'not found' });
  const origin = req.get('x-origin') === 'mcp' ? 'mcp' : 'ui';
  if (origin === 'mcp' && process.env.MAIL_WA_MCP_SEND !== '1') {
    return res.status(403).json({ error: 'Versand über MCP ist deaktiviert' });
  }
  if (!req.body?.webp) throw new Error('webp fehlt');
  const msg = await wa.sendSticker(chat.wa_account_id, chat.jid, req.body.webp, { origin });
  res.json({ sent: true, wa_id: msg?.wa_id, chat_id: chat.id });
}));

app.post('/api/whatsapp/accounts/:id/messages', wrap(async (req, res) => {
  try {
    res.json(await sendWhatsapp(req, {
      accountId: +req.params.id, to: req.body?.to, text: req.body?.text,
    }));
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
}));

// ---- Geplante Nachrichten ---------------------------------------------------
// Auftrag anlegen: Text jetzt festlegen, Versand später. Dieselben Schutzregeln
// wie beim Sofortversand – geprüft beim Anlegen, damit der Fehler dort landet,
// wo jemand ihn sieht, und nicht nachts im Planer.

/** Nimmt Unix-Sekunden, Millisekunden oder ISO-8601 und liefert Unix-Sekunden. */
function parseSendAt(v) {
  if (v == null || v === '') throw new Error('send_at fehlt');
  let ts;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) {
    ts = Number(v);
    if (ts > 1e12) ts = Math.floor(ts / 1000);
  } else {
    const d = new Date(String(v));
    if (Number.isNaN(d.getTime())) throw new Error('send_at ist kein gültiger Zeitpunkt (ISO-8601 oder Unix-Sekunden)');
    ts = Math.floor(d.getTime() / 1000);
  }
  const now = Math.floor(Date.now() / 1000);
  if (ts < now - 60) throw new Error('send_at liegt in der Vergangenheit');
  if (ts > now + 366 * 86400) throw new Error('send_at liegt mehr als ein Jahr in der Zukunft');
  return ts;
}

app.get('/api/whatsapp/scheduled', wrap((req, res) => res.json(db.listWaScheduled({
  waAccountId: req.query.account_id ? +req.query.account_id : null,
  chatId: req.query.chat_id ? +req.query.chat_id : null,
  status: req.query.status || null,
  limit: +req.query.limit || 50,
}))));

app.post('/api/whatsapp/chats/:id/scheduled', wrap((req, res) => {
  const chat = db.getWaChat(+req.params.id);
  if (!chat) return res.status(404).json({ error: 'not found' });
  const origin = req.get('x-origin') === 'mcp' ? 'mcp' : 'ui';
  try {
    const text = String(req.body?.text || '').trim();
    if (!text) throw new Error('Text fehlt');
    const account = db.getWaAccount(chat.wa_account_id);
    assertMaySend(origin, account, chat);
    const row = db.createWaScheduled({
      wa_account_id: chat.wa_account_id, chat_id: chat.id, text,
      send_at: parseSendAt(req.body?.send_at), origin,
      note: req.body?.note ? String(req.body.note).slice(0, 200) : null,
    });
    waEmit('scheduled', { chat_id: chat.id, item: row });
    res.status(201).json(row);
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
}));

app.put('/api/whatsapp/scheduled/:id', wrap((req, res) => {
  try {
    const patch = {};
    if (req.body?.text !== undefined) {
      patch.text = String(req.body.text).trim();
      if (!patch.text) throw new Error('Text fehlt');
    }
    if (req.body?.send_at !== undefined) patch.send_at = parseSendAt(req.body.send_at);
    if (req.body?.note !== undefined) patch.note = req.body.note ? String(req.body.note).slice(0, 200) : null;
    const row = db.updateWaScheduled(+req.params.id, patch);
    if (!row) return res.status(404).json({ error: 'Auftrag nicht gefunden oder nicht mehr offen' });
    waEmit('scheduled', { chat_id: row.chat_id, item: row });
    res.json(row);
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
}));

app.delete('/api/whatsapp/scheduled/:id', wrap((req, res) => {
  const row = db.getWaScheduled(+req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (!db.cancelWaScheduled(row.id)) return res.status(409).json({ error: `Auftrag ist bereits ${row.status}` });
  const after = db.getWaScheduled(row.id);
  waEmit('scheduled', { chat_id: row.chat_id, item: after });
  res.json(after);
}));

/**
 * Planer: alle 30 s fällige Aufträge ausführen. Läuft nur hier, im
 * Web-Server-Prozess – der WhatsApp-Socket lebt nirgendwo sonst.
 * Ist das Konto gerade nicht verbunden, bleibt der Auftrag offen und wird
 * beim nächsten Durchlauf erneut versucht; nach sechs Stunden Verspätung
 * gilt er als gescheitert, damit nichts Tage später unpassend rausgeht.
 */
const SCHED_GRACE_SEC = 6 * 3600;
let schedRunning = false;
async function runScheduled() {
  if (schedRunning) return;
  schedRunning = true;
  try {
    const now = Math.floor(Date.now() / 1000);
    for (const job of db.dueWaScheduled(now)) {
      try {
        const msg = await wa.sendText(job.wa_account_id, job.chat_jid, job.text, { origin: job.origin });
        const done = db.markWaScheduled(job.id, { status: 'sent', wa_id: msg?.wa_id || null });
        waEmit('scheduled', { chat_id: job.chat_id, item: done });
        console.log(`[whatsapp] geplante Nachricht #${job.id} an ${job.chat_name || job.chat_jid} gesendet`);
      } catch (e) {
        const expired = now - job.send_at > SCHED_GRACE_SEC;
        const item = db.markWaScheduled(job.id, {
          status: expired ? 'failed' : 'pending',
          error: expired ? `Aufgegeben nach 6 h: ${e.message}` : e.message,
        });
        waEmit('scheduled', { chat_id: job.chat_id, item });
        if (expired) console.error(`[whatsapp] geplante Nachricht #${job.id} aufgegeben: ${e.message}`);
      }
    }
  } finally { schedRunning = false; }
}
setInterval(() => runScheduled().catch(e => console.error('[whatsapp] Planer:', e.message)), 30_000).unref();
// Kurz nach dem Start einmal nachsehen – die Verbindung braucht ein paar Sekunden.
setTimeout(() => runScheduled().catch(() => {}), 20_000).unref();

app.get('/api/whatsapp/messages/:id/media', wrap(async (req, res) => {
  let m = db.getWaMessage(+req.params.id);
  if (!m) return res.status(404).json({ error: 'not found' });
  if (!m.stored_path) {
    try { m = await wa.downloadMessageMedia(m.id); }
    catch (e) {
      // 410 statt 400: die Datei ist nicht kaputt, sie ist nicht mehr da.
      // Das Frontend zeigt daraufhin einen Hinweis statt eines toten Players.
      return res.status(410).json({ error: e.message });
    }
  }
  sendUntrustedFile(res, { path: m.stored_path, mime: m.media_mime, kind: m.type, filename: m.media_filename });
}));
app.post('/api/whatsapp/messages/:id/download-media', wrap(async (req, res) =>
  res.json(await wa.downloadMessageMedia(+req.params.id))));

app.get('/api/whatsapp/unread-count', wrap((req, res) =>
  res.json({ unread: db.waUnreadCount(req.query.account_id ? +req.query.account_id : null) })));

app.get('/api/whatsapp/contacts', wrap((req, res) => res.json(db.listWaContacts({
  waAccountId: req.query.account_id ? +req.query.account_id : null,
  query: req.query.q || null, limit: +req.query.limit || 100,
}))));
app.post('/api/whatsapp/contacts/:id/link', wrap((req, res) => {
  const body = req.body || {};
  // Mailadresse ist optional – wer nur eine WhatsApp-Nummer hat, gehört
  // trotzdem ins Adressbuch. Ein Name allein reicht.
  let contact = null;
  if (body.contact_id) contact = db.getContactById(+body.contact_id);
  else if (body.email || body.name) {
    contact = db.createContact({
      email: body.email, name: body.name, phone: body.phone,
    });
  }
  if (!contact) throw new Error('contact_id, name oder email angeben');
  res.json(db.linkWaContact(+req.params.id, contact.id));
}));
app.delete('/api/whatsapp/contacts/:id/link', wrap((req, res) =>
  res.json(db.linkWaContact(+req.params.id, null))));
app.get('/api/contacts/:id/whatsapp', wrap((req, res) =>
  res.json(db.waContactsForContact(+req.params.id))));

// ---- Sicherung ------------------------------------------------------------
// Export/Import des kompletten Datenverzeichnisses als .tgz (siehe backup.js).
// Nur Administratoren: das Archiv enthält Schlüssel, Passwörter und alle Mails.
app.get('/api/backup/export', requireAdmin, wrap(async (req, res) => {
  const includeMedia = req.query.media !== '0';
  res.set('Content-Type', 'application/gzip');
  res.set('Content-Disposition', `attachment; filename="${backup.defaultArchiveName()}"`);
  res.set('Cache-Control', 'no-store');
  try {
    await backup.writeArchive(res, { includeMedia });
  } catch (e) {
    console.error('[backup] Export abgebrochen:', e.message);
    // Kopf ist schon raus – nur noch die Verbindung kappen, damit der Client
    // ein unvollständiges Archiv erkennt.
    if (res.headersSent) res.destroy(e); else throw e;
  }
}));

app.get('/api/backup/status', requireAdmin, wrap((req, res) => res.json({
  pending: fs.existsSync(path.join(DATA_DIR, 'restore-pending.tgz'))
    || fs.existsSync(path.join(DATA_DIR, 'restore-processing.tgz')),
  last: backup.readLastResult(),
  key_fingerprint: backup.keyFingerprint(backup.currentKeyHex()),
  key_source: process.env.MAIL_CRYPTO_KEY ? 'env' : 'keyfile',
  data_dir_bytes: backup.dataDirBytes(),
  restart_automatic: !!process.env.MAIL_DATA_DIR && fs.existsSync('/.dockerenv'),
})));

// Upload wird direkt auf die Platte gestreamt (bis 4 GB) – nicht per
// express.raw in den Speicher. Danach Vorprüfung, Ablage als
// restore-pending.tgz und Neustart: restore-boot.js spielt es beim nächsten
// Start ein. In Docker startet der Container von selbst neu
// (restart: unless-stopped), lokal muss der Nutzer den Server neu starten.
const RESTORE_TYPES = ['application/gzip', 'application/x-gzip', 'application/octet-stream'];
const RESTORE_LIMIT = 4 * 1024 ** 3;
app.post('/api/backup/restore', requireAdmin, wrap(async (req, res) => {
  const ct = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!RESTORE_TYPES.includes(ct)) {
    return res.status(415).json({ error: `Content-Type ${ct || '(leer)'} wird nicht angenommen – erwartet application/gzip` });
  }
  const declared = Number(req.get('content-length') || 0);
  if (declared > RESTORE_LIMIT) return res.status(413).json({ error: 'Archiv größer als 4 GB' });
  const pending = path.join(DATA_DIR, 'restore-pending.tgz');
  const part = pending + '.part';
  if (fs.existsSync(pending) || fs.existsSync(path.join(DATA_DIR, 'restore-processing.tgz'))) {
    return res.status(409).json({ error: 'Es liegt bereits eine Wiederherstellung an – bitte Server neu starten' });
  }
  let received = 0;
  try {
    const out = fs.createWriteStream(part, { mode: 0o600 });
    req.on('data', chunk => {
      received += chunk.length;
      if (received > RESTORE_LIMIT) req.destroy(new Error('Archiv größer als 4 GB'));
    });
    await pipeline(req, out);
    const info = await backup.inspectArchive(part);
    fs.renameSync(part, pending);
    res.json({ ok: true, restarting: true, manifest: info.manifest, bytes: received });
    console.log(`[backup] Archiv (${(received / 1048576).toFixed(1)} MB) angenommen – Neustart zur Wiederherstellung.`);
    setTimeout(() => shutdown('restore'), 500);
  } catch (e) {
    fs.rmSync(part, { force: true });
    if (res.headersSent) return;
    res.status(400).json({ error: e.message });
  }
}));

// Frontend-Build ausliefern, falls vorhanden. Im Docker-Betrieb übernimmt das
// nginx – dann fehlt das Verzeichnis, und der Server bleibt reine API.
const distDir = STATIC_DIR;
if (fs.existsSync(path.join(distDir, 'index.html'))) {
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(distDir, 'index.html'), err => err && next());
  });
} else {
  console.error(`Kein Frontend-Build unter ${distDir} – UI wird von hier nicht ausgeliefert`);
}

// Letzte Instanz: alles, was aus einer Route herausfliegt, wird hier zu JSON.
// Express' Standard-Seite würde den Stacktrace ausliefern – auf einem Server
// erfährt der Angreifer daraus Pfade und Modulstruktur.
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: status === 500 ? 'Interner Fehler' : err.message });
});


// Altbestand aus der Zeit vor der umask einmalig nachziehen.
hardenDataDir();

const server = app.listen(PORT, BIND_HOST, () => {
  console.log(`Mail-Server UI:  http://localhost:${PORT}  (gebunden an ${BIND_HOST})`);
  if (auth.needsSetup()) {
    console.log('[auth] Noch kein Konto vorhanden – die Web-UI zeigt die Ersteinrichtung.');
    if (!LOOPBACK_ONLY && !process.env.MAIL_SETUP_TOKEN) {
      console.warn('[auth] WARNUNG: Server ist über das Netz erreichbar und die Ersteinrichtung ist offen. '
        + 'Setze MAIL_SETUP_TOKEN=<geheim>, damit nur du den Administrator anlegen kannst.');
    }
  }
  if (!LOOPBACK_ONLY && !ALLOWED_HOSTS.length) {
    console.warn('[security] Hinweis: MAIL_ALLOWED_HOSTS ist nicht gesetzt – jeder Host-Header wird akzeptiert.');
  }
});

// Abgelaufene Sitzungen und Token regelmässig wegräumen.
setInterval(() => { try { auth.purgeExpired(); } catch { /* egal */ } }, 3600_000).unref();

// Gekoppelte WhatsApp-Konten wieder verbinden (WA_AUTOSTART=0 schaltet das ab).
wa.autostart().catch(e => console.error('[whatsapp] Autostart:', e.message));
wa.startMediaCleanup();
// Hält den Stream und Zwischenstationen wach.
setInterval(waPing, 25000).unref();

// Sauberes Herunterfahren. Der Launcher schickt SIGTERM und nach ~4s SIGKILL – in der Zeit
// müssen dauerhafte Verbindungen (ab Phase 2: WhatsApp) getrennt werden, sonst bleibt die
// Sitzung beschädigt zurück.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} – Mail-Server wird beendet …`);
  try { await closeIntegrations(); } catch (e) { console.error(e); }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

// Hier tragen sich langlebige Integrationen ein (siehe src/whatsapp.js).
const integrationClosers = [wa.shutdownAll, closeAllStreams];
export function onShutdown(fn) { integrationClosers.push(fn); }
async function closeIntegrations() {
  for (const fn of integrationClosers) await Promise.resolve(fn()).catch(e => console.error(e));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
