// Zustell-Nachverfolgung: Öffnungen (Zählpixel) und Unzustellbarkeit (Bounces).
//
// Zwei Signale mit sehr unterschiedlicher Verlässlichkeit — das gehört
// zusammen erklärt, weil man sie sonst gleich liest:
//
//   Öffnung  Ein 1×1-Pixel, das der Mail-Client nachlädt. Das ist eine
//            UNTERGRENZE: wer Bilder unterdrückt, wird nie gezählt. Umgekehrt
//            lädt Apple Mail Privacy Protection Pixel auf Vorrat und erzeugt
//            Öffnungen, die keine sind. Taugt für Tendenzen, nicht für Beweise.
//
//   Bounce   Die Unzustellbarkeitsmeldung des Zielservers (RFC 3464). Das ist
//            die harte Wahrheit — und der Grund, warum „gesendet" allein nichts
//            über Zustellung sagt.
//
// Das Pixel ist standardmäßig AUS. Eine Öffnungsmessung ist personenbezogen und
// braucht in der EU eine Rechtsgrundlage; diese Entscheidung trifft der Nutzer,
// nicht der Code.
import crypto from 'node:crypto';

export const PIXEL_PATH = '/api/t/o/';

// 1×1-GIF, transparent, 43 Byte. Fest eingebettet, damit kein Dateizugriff nötig ist.
export const PIXEL_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64',
);

export const newTrackingToken = () => crypto.randomBytes(16).toString('base64url');

/** Basis-URL, unter der Empfänger diesen Server erreichen. */
export function trackingBaseUrl() {
  return String(process.env.MAIL_PUBLIC_URL || process.env.MAIL_UI_URL || '').replace(/\/+$/, '');
}

/** Zeigt die Basis-URL nach außen — oder nur auf diesen Rechner? */
export function trackingReachable() {
  const base = trackingBaseUrl();
  return !!base && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(base);
}

/**
 * Hängt das Zählpixel als letztes Element in den Body.
 * Ohne erreichbare Basis-URL wird nichts eingebaut – ein Pixel auf
 * http://localhost wäre beim Empfänger ein kaputtes Bild und misst nichts.
 */
export function withPixel(html, token) {
  const base = trackingBaseUrl();
  if (!html || !token || !base) return html;
  const img = `<img src="${base}${PIXEL_PATH}${token}.gif" width="1" height="1" alt=""`
    + ' style="display:block;width:1px;height:1px;border:0;margin:0;padding:0;opacity:0;overflow:hidden">';
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${img}</body>`) : html + img;
}

/** Globale Einstellung lesen. Tolerant, weil die Einstellungen mal als
 *  String ('1'), mal als Boolean (true) geschrieben werden können. */
export function opensEnabledGlobally(settings = {}) {
  const v = settings.track_opens;
  return v === true || v === 1 || v === '1' || v === 'true';
}

// ---- Bounce-Erkennung -----------------------------------------------------

const DAEMON_RE = /^(mailer-daemon|postmaster|mail|noreply|no-reply)@/i;
const SUBJECT_RE = /(undeliverable|undelivered|delivery status notification|delivery failure|failure notice|returned mail|mail delivery (failed|subsystem)|delivery has failed|unzustellbar|nicht zustellbar|zustellung fehlgeschlagen)/i;
const EMAIL_RE = /[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+/g;

/**
 * Trägt die Mail einen echten Zustellbericht (RFC 3464)? Das ist das einzige
 * Merkmal, das ein Absender nicht mit Betreff und Fließtext nachstellen kann,
 * ohne den Bericht selbst zu bauen – deshalb entscheidet es später mit, ob
 * eine Adresse aus dem Text als Bounce-Ziel überhaupt vertrauenswürdig ist.
 */
export function hasDeliveryReport(parsed = {}) {
  const contentType = String(parsed.headers?.get?.('content-type')?.value || '');
  return /multipart\/report/i.test(contentType)
    || (parsed.attachments || []).some(a => /message\/delivery-status/i.test(a.contentType || ''));
}

/** Sieht diese eingegangene Mail nach einer Unzustellbarkeitsmeldung aus? */
export function looksLikeBounce(parsed = {}) {
  const from = String(parsed.from?.value?.[0]?.address || '').toLowerCase();
  const subject = String(parsed.subject || '');
  const autoSubmitted = String(parsed.headers?.get?.('auto-submitted') || '');
  return hasDeliveryReport(parsed)
    || DAEMON_RE.test(from)
    || (SUBJECT_RE.test(subject) && (/auto-replied|auto-generated/i.test(autoSubmitted) || !!from))
    ;
}

/** Text aller Teile, in denen die Zustelldetails stecken können. */
function reportText(parsed = {}) {
  const parts = [parsed.text || ''];
  for (const a of parsed.attachments || []) {
    if (/message\/(delivery-status|rfc822|feedback-report)/i.test(a.contentType || '') && a.content) {
      parts.push(Buffer.isBuffer(a.content) ? a.content.toString('utf8') : String(a.content));
    }
  }
  const failed = parsed.headers?.get?.('x-failed-recipients');
  if (failed) parts.push(`X-Failed-Recipients: ${failed}`);
  // Begrenzt: Die Regexes unten laufen über den ganzen Text, und die
  // relevanten Kopfzeilen eines Berichts stehen ohnehin weit vorn.
  return parts.join('\n').slice(0, 65536);
}

/**
 * Zerlegt eine Bounce-Meldung.
 * Gibt { email, code, type, reason, messageId, relayRecipientId, relayDraftId,
 * structured } zurück – Felder, die sich nicht sicher bestimmen lassen, bleiben
 * null. Lieber unvollständig als geraten: Das Ergebnis markiert einen Empfänger
 * als unzustellbar. `structured` sagt, ob ein echter Zustellbericht vorliegt;
 * ohne den ist `email` nur ein Fund im Fließtext und kein Beleg.
 */
export function parseBounce(parsed = {}) {
  const body = reportText(parsed);

  // Alle Muster erlauben am Zeilenanfang nur Leerzeichen/Tabs, nicht \s:
  // \s* frisst mit /m auch Zeilenumbrüche und wird bei vielen Leerzeilen
  // quadratisch langsam (32 KB Leerzeilen ≈ 0,6 s pro Muster).
  // Status: 5.1.1 → dauerhaft, 4.x.x → vorübergehend (Mailbox voll, Server down)
  const status = body.match(/^[ \t]*Status:\s*([245])\.(\d+)\.(\d+)/mi);
  const diagnostic = body.match(/^[ \t]*Diagnostic-Code:\s*(.+(?:\n[ \t]+.+)*)/mi);
  const action = body.match(/^[ \t]*Action:\s*(\w+)/mi);

  // Empfängeradresse: erst die maschinenlesbaren Felder, dann der Fließtext.
  const finalRcpt = body.match(/^[ \t]*(?:Final|Original)-Recipient:\s*(?:rfc822;)?\s*<?([^\s>;]+@[^\s>;]+)>?/mi)
    || body.match(/^[ \t]*X-Failed-Recipients:\s*<?([^\s>,;]+@[^\s>,;]+)>?/mi);

  const messageId = (body.match(/^[ \t]*(?:Original-)?Message-(?:ID|Id):\s*<([^>]+)>/mi) || [])[1] || null;

  // Unsere eigenen Kopfzeilen aus der zitierten Originalmail (message/rfc822-Teil).
  // Sie benennen den Empfänger-Datensatz direkt – die verlässlichste Zuordnung.
  const relayRecipientId = (body.match(/^[ \t]*X-Relay-Recipient:[ \t]*(\d+)[ \t\r]*$/mi) || [])[1] || null;
  const relayDraftId = (body.match(/^[ \t]*X-Relay-Draft:[ \t]*(\d+)[ \t\r]*$/mi) || [])[1] || null;

  let email = finalRcpt ? finalRcpt[1] : null;
  if (!email) {
    // Fallback: die erste Adresse im Text, die nicht der meldende Server ist.
    const self = String(parsed.from?.value?.[0]?.address || '').toLowerCase();
    email = (body.match(EMAIL_RE) || [])
      .map(a => a.toLowerCase())
      .find(a => a !== self && !DAEMON_RE.test(a)) || null;
  }

  const codeDigits = status ? `${status[1]}.${status[2]}.${status[3]}` : null;
  const fromDiagnostic = diagnostic ? diagnostic[1].replace(/\s+/g, ' ').trim() : null;
  // Ohne Status-Zeile aus dem Diagnostic-Code lesen ("smtp; 550 5.1.1 …").
  const smtpCode = !codeDigits && fromDiagnostic ? (fromDiagnostic.match(/\b([245])\d\d\b/) || [])[1] : null;
  const severity = status ? status[1] : smtpCode;

  return {
    email: email ? email.toLowerCase() : null,
    code: codeDigits || (fromDiagnostic ? (fromDiagnostic.match(/\b[245]\d\d\b/) || [])[0] : null),
    type: severity === '4' ? 'soft' : 'hard',
    reason: fromDiagnostic
      || (action ? `Zustellung ${action[1]}` : null)
      || String(parsed.subject || '').slice(0, 200)
      || null,
    messageId,
    relayRecipientId: relayRecipientId ? Number(relayRecipientId) : null,
    relayDraftId: relayDraftId ? Number(relayDraftId) : null,
    structured: hasDeliveryReport(parsed),
  };
}
