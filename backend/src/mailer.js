import nodemailer from 'nodemailer';
import {
  getAccount, decrypt, getDraft, getRecipients,
  setDraftStatus, setRecipientResult, logSendEvent, attachmentsForSend, composeDraftHtml,
  getCustomFieldDefaults, getAsset, listAttachments, hasSuccessfulTestSend,
  getAllSettings, setRecipientToken, ensureRelayRef,
} from './db.js';
import { newTrackingToken, withPixel, trackingBaseUrl, opensEnabledGlobally } from './tracking.js';
import { isPrivateHost } from './net-guard.js';

// Umschließt das fertige Mail-HTML mit einem mobil-optimierten Dokument:
// viewport (Gerätebreite statt Schrumpfen), fluide Bilder und ein stabiler
// heller E-Mail-Canvas. Templates mit eigenem Dark-Mode können weiterhin ihre
// Farben explizit definieren; automatische Client-Invertierung wird vermieden.
// Media-Queries für Klassen sm-full / sm-pad / sm-block / sm-center / sm-h1.
// Wird nur beim tatsächlichen Versand angewandt (Vorschau bleibt unverändert).
export function wrapEmailHtml(inner) {
  if (!inner) return inner;
  if (/<html[\s>]/i.test(inner)) return inner; // schon ein vollständiges Dokument
  return `<!DOCTYPE html>
<html lang="de"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<style>
  :root{color-scheme:light only}
  html,body{background:#fff;color:#171b1f}
  body{margin:0;padding:0;width:100%!important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
  img{border:0;line-height:100%;max-width:100%!important;height:auto!important}
  table{border-collapse:collapse}
  a{text-decoration:none}
  @media only screen and (max-width:600px){
    .sm-full{width:100%!important;max-width:100%!important}
    .sm-pad{padding-left:16px!important;padding-right:16px!important}
    .sm-block{display:block!important;width:100%!important;box-sizing:border-box!important;text-align:center!important}
    .sm-center{text-align:center!important}
    .sm-h1{font-size:22px!important;line-height:1.3!important}
  }
</style>
</head><body>${inner}</body></html>`;
}

// Bilder aus der Medien-Bibliothek (<img src=".../api/assets/<id>/file">) beim Versand
// in CID-Inline-Anhänge umwandeln – sonst wären die Bilder für Empfänger tot.
const ASSET_URL_RE = /(?:https?:\/\/[^"'\s)]*)?\/api\/assets\/(\d+)\/file(?:\?[^"'\s)]*)?/g;
export function inlineAssets(html) {
  if (!html) return { html, attachments: [] };
  const ids = new Set();
  let m; ASSET_URL_RE.lastIndex = 0;
  while ((m = ASSET_URL_RE.exec(html))) ids.add(Number(m[1]));
  if (!ids.size) return { html, attachments: [] };
  const attachments = [];
  for (const id of ids) {
    const a = getAsset(id);
    if (a) attachments.push({ filename: a.filename, path: a.stored_path, cid: `asset${id}@relay`, contentDisposition: 'inline' });
  }
  const out = html.replace(ASSET_URL_RE, (full, id) => (getAsset(Number(id)) ? `cid:asset${id}@relay` : full));
  return { html: out, attachments };
}

/**
 * Wird für diesen Entwurf die Öffnung gemessen? Reihenfolge: Einstellung am
 * Entwurf schlägt globale Einstellung. Ohne erreichbare öffentliche Adresse
 * bleibt die Messung aus – ein Pixel auf localhost misst nichts und hinterlässt
 * beim Empfänger nur ein totes Bild.
 */
export function opensTracked(draft) {
  if (!trackingBaseUrl()) return false;
  if (draft?.track_opens != null) return !!draft.track_opens;
  return opensEnabledGlobally(getAllSettings());
}

const transports = new Map();

function transportFor(account) {
  const key = `${account.id}:${account.host}:${account.port}:${account.username}`;
  if (transports.has(key)) return transports.get(key);
  const secure = !!account.secure; // true for 465, false for 587/STARTTLS
  const t = nodemailer.createTransport({
    host: account.host,
    port: account.port,
    secure,
    // STARTTLS erzwingen – sonst gehen Passwort und Mails im Klartext raus,
    // sobald jemand auf dem Weg das STARTTLS-Angebot unterdrückt. Nur für
    // lokale/private Server bleibt es opportunistisch (Testrelays ohne TLS).
    requireTLS: !secure && !isPrivateHost(account.host),
    auth: { user: account.username, pass: decrypt(account.password_enc) },
  });
  transports.set(key, t);
  return t;
}

/** Adressobjekt für nodemailer – das übernimmt Quoting/Encoding des Namens,
 *  statt dass ein Name mit Anführungszeichen oder „<“ den Header zerlegt. */
const addr = r => (r.name ? { name: r.name, address: r.email } : r.email);

export function fromHeader(account) {
  return addr({ name: account.from_name, email: account.from_email });
}

/** Genau EINE Adresse – keine Listen, keine Display-Namen. */
const SINGLE_EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

// Replace {{name}}, {{email}} and any {{field}} from the vars object.
export function personalize(str, vars) {
  if (!str) return str;
  return str.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
}

// Naive HTML -> text fallback when no plain text is provided.
function htmlToText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|tr|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n').trim();
}

// Verify SMTP credentials without sending.
export async function verifyAccount(account) {
  await transportFor(account).verify();
  return true;
}

// Render the personalized preview of a draft for a specific recipient (or the first one).
export function renderPreview(draftId, recipientId = null) {
  const draft = getDraft(draftId);
  if (!draft) throw new Error('Draft not found');
  const recips = draft.recipients.filter(r => r.kind === 'to');
  const r = recipientId
    ? draft.recipients.find(x => x.id === recipientId)
    : recips[0];
  const vars = recipientVars(r, getCustomFieldDefaults(), draftVarsOf(draft));
  const composed = composeDraftHtml(draft);
  return {
    subject: personalize(draft.subject, vars),
    html: personalize(composed, vars),
    text: personalize(draft.text || htmlToText(composed), vars),
    to: r ? (r.name ? `${r.name} <${r.email}>` : r.email) : '(kein Empfänger)',
    mode: draft.mode,
  };
}

// Entwurfs-Ebene: Variablen, die für den ganzen Entwurf (Kampagne) gelten.
export function draftVarsOf(draft) {
  if (!draft?.vars) return {};
  try { return JSON.parse(draft.vars); } catch { return {}; }
}

// Personalisierungs-Variablen mit Vorrang:
//   globale Standardwerte < Entwurfs-Werte < name/email < empfängerspezifische Felder.
export function recipientVars(r, defaults = {}, draftVars = {}) {
  if (!r) return { ...defaults, ...draftVars, name: '', email: '' };
  let custom = {};
  if (r.vars) { try { custom = JSON.parse(r.vars); } catch { /* ignore */ } }
  return { ...defaults, ...draftVars, name: r.name || r.email.split('@')[0], email: r.email, ...custom };
}

// Test-Versand: schickt die personalisierte Vorschau (Variablen des ersten
// To-Empfängers, sonst Standardwerte) an eine beliebige Adresse. Verändert
// weder Empfänger-Status noch Entwurfs-Status.
export async function sendTestMail(draftId, toEmail) {
  toEmail = String(toEmail ?? '').trim();
  if (!SINGLE_EMAIL_RE.test(toEmail)) throw new Error('Testadresse muss genau eine gültige E-Mail-Adresse sein');
  const draft = getDraft(draftId);
  if (!draft) throw new Error('Draft not found');
  if (!draft.account_id) throw new Error('Kein SMTP-Account gewählt');
  const account = getAccount(draft.account_id);
  if (!account) throw new Error('SMTP-Account nicht gefunden');
  const first = draft.recipients.find(r => r.kind === 'to');
  const vars = recipientVars(first || null, getCustomFieldDefaults(), draftVarsOf(draft));
  const { html: composed, attachments: assetAtts } = inlineAssets(composeDraftHtml(draft));
  const attachments = [...attachmentsForSend(draftId), ...assetAtts];
  const info = await transportFor(account).sendMail({
    from: fromHeader(account),
    replyTo: draft.reply_to || account.reply_to || undefined,
    to: toEmail,
    subject: '[TEST] ' + personalize(draft.subject, vars),
    html: wrapEmailHtml(personalize(composed, vars)),
    text: personalize(draft.text || htmlToText(composed), vars),
    attachments: attachments.length ? attachments : undefined,
  });
  logSendEvent({
    draft_id: draftId, draft_subject: draft.subject, account_email: account.from_email,
    email: toEmail, kind: 'to', status: 'sent', message_id: info.messageId, attempt: 'test',
  });
  return { messageId: info.messageId, to: toEmail };
}

const PLACEHOLDER_RE = /\{\{\s*([\w.]+)\s*\}\}/g;
function unresolvedKeys(value) {
  return [...new Set([...String(value || '').matchAll(PLACEHOLDER_RE)].map(match => match[1]))];
}

// Verbindlicher Vorflug-Check. Blocker verhindern den Versand auch bei einem
// direkten API-Aufruf; Warnungen werden in der Oberfläche bestätigt.
export function preflightDraft(draftId) {
  const draft = getDraft(draftId);
  if (!draft) throw new Error('Draft not found');
  const recipients = getRecipients(draftId);
  const to = recipients.filter(r => r.kind === 'to');
  const defaults = getCustomFieldDefaults();
  const draftVars = draftVarsOf(draft);
  const composed = composeDraftHtml(draft);

  const duplicateMap = new Map();
  for (const r of recipients) {
    const email = String(r.email || '').trim().toLowerCase();
    if (!email) continue;
    const group = duplicateMap.get(email) || [];
    group.push({ id: r.id, email: r.email, name: r.name, kind: r.kind });
    duplicateMap.set(email, group);
  }
  const duplicates = [...duplicateMap.entries()].filter(([, entries]) => entries.length > 1)
    .map(([email, entries]) => ({ email, count: entries.length, entries }));

  const unresolved = [];
  if (draft.mode === 'single') {
    const vars = { ...defaults, ...draftVars };
    const keys = unresolvedKeys([personalize(draft.subject, vars), personalize(composed, vars), personalize(draft.text || '', vars)].join('\n'));
    if (keys.length) unresolved.push({ recipient: 'Gemeinsame Mail', email: null, keys });
  } else {
    for (const r of to) {
      const vars = recipientVars(r, defaults, draftVars);
      const keys = unresolvedKeys([personalize(draft.subject, vars), personalize(composed, vars), personalize(draft.text || '', vars)].join('\n'));
      if (keys.length) unresolved.push({ recipient: r.name || r.email, email: r.email, keys });
    }
  }

  const attachments = listAttachments(draftId);
  const attachmentBytes = attachments.reduce((sum, a) => sum + (a.size || 0), 0);
  const blockers = [];
  if (!draft.account_id) blockers.push({ code: 'missing_account', message: 'Kein SMTP-Account ausgewählt.' });
  if (!to.length) blockers.push({ code: 'missing_recipients', message: 'Keine To-Empfänger vorhanden.' });
  if (duplicates.length) blockers.push({ code: 'duplicate_recipients', message: `${duplicates.length} doppelte Adresse(n) würden mehrfach angeschrieben.` });
  if (unresolved.length) blockers.push({ code: 'unresolved_placeholders', message: `Bei ${unresolved.length} Empfänger(n) bleiben Platzhalter unaufgelöst.` });
  if (attachmentBytes > 20 * 1024 * 1024) blockers.push({ code: 'attachments_too_large', message: `Anhänge belegen ${(attachmentBytes / 1048576).toFixed(1)} MB und überschreiten das 20-MB-Limit.` });
  const warnings = [];
  if (!String(draft.subject || '').trim()) warnings.push({ code: 'empty_subject', message: 'Der Betreff ist leer.' });
  if (!String(draft.text || '').trim()) warnings.push({ code: 'generated_text', message: 'Der Text-Teil wird automatisch aus dem HTML erzeugt.' });
  if (!hasSuccessfulTestSend(draftId)) warnings.push({ code: 'no_test_send', message: 'Für diesen Entwurf wurde noch kein erfolgreicher Testversand protokolliert.' });
  if (attachmentBytes >= 18 * 1024 * 1024 && attachmentBytes <= 20 * 1024 * 1024) warnings.push({ code: 'large_attachments', message: `Anhänge belegen ${(attachmentBytes / 1048576).toFixed(1)} MB und liegen nahe am 20-MB-Limit.` });
  return {
    ok: blockers.length === 0, checked_at: new Date().toISOString(), blockers, warnings,
    unresolved, duplicates, attachment_bytes: attachmentBytes, attachment_count: attachments.length,
    recipient_count: to.length, has_test_send: hasSuccessfulTestSend(draftId),
    text_mode: draft.text?.trim() ? 'explicit' : 'generated',
  };
}

/**
 * Send a draft. In 'batch' mode each `to` recipient gets an individual,
 * personalized mail (cc/bcc are attached to every mail). In 'single' mode a
 * single mail goes to all to/cc/bcc recipients.
 * onProgress({ index, total, email, status, error }) is called per recipient.
 */
export async function sendDraft(draftId, onProgress = () => {}, opts = {}) {
  const { onlyFailed = false } = opts;
  const draft = getDraft(draftId);
  if (!draft) throw new Error('Draft not found');
  if (!draft.account_id) throw new Error('Kein SMTP-Account gewählt');
  const account = getAccount(draft.account_id);
  if (!account) throw new Error('SMTP-Account nicht gefunden');

  const all = getRecipients(draftId);
  let to = all.filter(r => r.kind === 'to');
  // Beim erneuten Senden nur die fehlgeschlagenen To-Empfänger; cc/bcc nicht erneut benachrichtigen.
  const cc = onlyFailed ? [] : all.filter(r => r.kind === 'cc');
  const bcc = onlyFailed ? [] : all.filter(r => r.kind === 'bcc');
  if (onlyFailed) to = to.filter(r => r.status === 'failed');
  if (to.length === 0) throw new Error(onlyFailed ? 'Keine fehlgeschlagenen Empfänger' : 'Keine To-Empfänger');

  // Einmal entscheiden, nicht pro Empfänger – sonst könnte eine Änderung
  // mitten im Versand die Hälfte der Mails anders behandeln.
  const tracked = opensTracked(draft);

  setDraftStatus(draftId, 'sending');
  const transport = transportFor(account);
  const from = fromHeader(account);
  const replyTo = draft.reply_to || account.reply_to || undefined;
  const attempt = onlyFailed ? 'resend' : 'send';
  const { html: composed, attachments: assetAtts } = inlineAssets(composeDraftHtml(draft));
  const fileAtts = attachmentsForSend(draftId);
  const allAtts = [...fileAtts, ...assetAtts];
  const attach = allAtts.length ? allAtts : undefined;
  const defaults = getCustomFieldDefaults();
  const draftVars = draftVarsOf(draft);
  const base = { ...defaults, ...draftVars }; // für single-mode (ohne Empfängerkontext)
  let sent = 0, failed = 0;

  const logEv = (r, status, extra = {}) => logSendEvent({
    draft_id: draftId, draft_subject: draft.subject, account_email: account.from_email,
    email: r.email, name: r.name, kind: r.kind, status, attempt, ...extra,
  });

  if (draft.mode === 'single') {
    const total = 1;
    onProgress({ index: 0, total, email: to.map(r => r.email).join(', '), status: 'sending' });
    try {
      // Eine gemeinsame Mail = ein Pixel. Die Öffnung wird dem ersten
      // To-Empfänger zugeschrieben; mehr gibt eine gemeinsame Mail nicht her.
      const singleToken = tracked ? newTrackingToken() : null;
      if (singleToken) setRecipientToken(to[0].id, singleToken);
      // Eine Referenz je Empfänger, alle in einer Kopfzeile: Ein Zustellbericht
      // zitiert die Originalmail komplett zurück, die Zuordnung läuft dann
      // über Referenz + Final-Recipient-Adresse (siehe imap.js noteBounce).
      const relayRefs = all.map(r => ensureRelayRef(r.id)).filter(Boolean);
      const info = await transport.sendMail({
        from, replyTo, attachments: attach,
        to: to.map(addr),
        cc: cc.length ? cc.map(addr) : undefined,
        bcc: bcc.length ? bcc.map(addr) : undefined,
        subject: personalize(draft.subject, base),
        html: withPixel(wrapEmailHtml(personalize(composed, base)), singleToken),
        text: personalize(draft.text || htmlToText(composed), base),
        headers: {
          'X-Relay-Draft': String(draftId),
          ...(relayRefs.length ? { 'X-Relay-Ref': relayRefs.join(', ') } : {}),
        },
      });
      for (const r of all) { setRecipientResult(r.id, 'sent', { messageId: info.messageId }); logEv(r, 'sent', { message_id: info.messageId }); }
      sent = to.length; onProgress({ index: 0, total, email: 'alle', status: 'sent' });
    } catch (e) {
      for (const r of all) { setRecipientResult(r.id, 'failed', { error: e.message }); logEv(r, 'failed', { error: e.message }); }
      failed = to.length; onProgress({ index: 0, total, email: 'alle', status: 'failed', error: e.message });
    }
  } else {
    const total = to.length;
    for (let i = 0; i < to.length; i++) {
      const r = to[i];
      const vars = recipientVars(r, defaults, draftVars);
      onProgress({ index: i, total, email: r.email, status: 'sending' });
      try {
        // Ein eigenes Token je Empfänger – nur so lässt sich später sagen,
        // WER geöffnet hat, statt nur DASS jemand geöffnet hat.
        const token = tracked ? newTrackingToken() : null;
        if (token) setRecipientToken(r.id, token);
        const info = await transport.sendMail({
          from, replyTo, attachments: attach,
          to: addr(r),
          cc: cc.length ? cc.map(addr) : undefined,
          bcc: bcc.length ? bcc.map(addr) : undefined,
          subject: personalize(draft.subject, vars),
          html: withPixel(wrapEmailHtml(personalize(composed, vars)), token),
          text: personalize(draft.text || htmlToText(composed), vars),
          // Hilft der Bounce-Zuordnung: die Meldung zitiert die Kopfzeilen zurück.
          // X-Relay-Ref ist der eigentliche Beleg (unerratbar, kontogebunden);
          // X-Relay-Recipient bleibt nur zur Lesbarkeit im Bericht.
          headers: {
            'X-Relay-Draft': String(draftId),
            'X-Relay-Recipient': String(r.id),
            'X-Relay-Ref': ensureRelayRef(r.id),
          },
        });
        setRecipientResult(r.id, 'sent', { messageId: info.messageId }); logEv(r, 'sent', { message_id: info.messageId });
        sent++; onProgress({ index: i, total, email: r.email, status: 'sent' });
      } catch (e) {
        setRecipientResult(r.id, 'failed', { error: e.message }); logEv(r, 'failed', { error: e.message });
        failed++; onProgress({ index: i, total, email: r.email, status: 'failed', error: e.message });
      }
    }
  }

  // Gesamtstatus über ALLE To-Empfänger aus der DB (berücksichtigt frühere Sendungen bei Retry).
  const allTo = getRecipients(draftId).filter(r => r.kind === 'to');
  const totalFailed = allTo.filter(r => r.status === 'failed').length;
  const totalSent = allTo.filter(r => r.status === 'sent').length;
  const status = totalFailed === 0 ? 'sent' : totalSent === 0 ? 'failed' : 'partial';
  setDraftStatus(draftId, status, totalFailed ? `${totalFailed} Empfänger fehlgeschlagen` : null);
  return { status, sent, failed, totalSent, totalFailed };
}
