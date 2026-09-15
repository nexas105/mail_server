// Antworten auf empfangene Mails.
//
// Eine „richtige" Antwort ist mehr als „Re:" im Betreff. Damit sie beim
// Empfänger im selben Gesprächsfaden landet und nicht als neue Mail daneben,
// braucht sie drei Dinge:
//   1. In-Reply-To  – die Message-ID der Mail, auf die geantwortet wird.
//   2. References    – die komplette Kette davor plus diese Message-ID.
//   3. die richtige Zieladresse – Reply-To schlägt From (Newsletter, Ticket-
//      systeme und Verteiler tragen ihre Antwortadresse dort ein).
// Punkt 1 und 2 sind der Grund, warum diese Datei überhaupt existiert: sie
// müssen am Entwurf hängen bleiben, bis er gesendet wird – auch wenn der
// Nutzer ihn vorher noch in der Oberfläche umschreibt.
//
// Gebaut wird hier nur der Entwurf. Gesendet wird über den normalen Weg
// (preflightDraft + sendDraft), damit für Antworten dieselben Regeln gelten
// wie für alles andere.
import { getAccount, getMessage, createDraft } from './db.js';

const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/**
 * Zerlegt eine Adress-Kopfzeile („Max Muster" <max@x.de>, a@b.de) in Adressen.
 * Kein vollständiger RFC-5322-Parser, aber robust gegen das, was in echten
 * Kopfzeilen steht: Kommas in zitierten Namen, Klammer-Kommentare, reine
 * Adressen ohne Namen. Gruppen-Syntax (undisclosed-recipients:;) fällt raus,
 * weil sie keine Adresse enthält.
 */
export function parseAddressList(header) {
  const raw = String(header || '');
  if (!raw.trim()) return [];
  const parts = [];
  let buf = '', quoted = false, depth = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\\' && quoted) { buf += c + (raw[++i] ?? ''); continue; }
    if (c === '"') { quoted = !quoted; buf += c; continue; }
    if (!quoted && c === '<') depth++;
    if (!quoted && c === '>') depth = Math.max(0, depth - 1);
    if (!quoted && depth === 0 && (c === ',' || c === ';')) { parts.push(buf); buf = ''; continue; }
    buf += c;
  }
  parts.push(buf);

  const out = [];
  for (const part of parts) {
    const piece = part.trim();
    if (!piece) continue;
    const angle = piece.match(/<([^<>]+)>\s*$/);
    let email = (angle ? angle[1] : piece).trim();
    let name = angle ? piece.slice(0, angle.index).trim() : '';
    // Zitierten Namen auspacken; Klammer-Kommentar als Name akzeptieren.
    if (/^".*"$/s.test(name)) name = name.slice(1, -1).replace(/\\(.)/g, '$1');
    if (!name) {
      const comment = piece.match(/\(([^()]*)\)/);
      if (comment) { name = comment[1].trim(); email = email.replace(/\([^()]*\)/, '').trim(); }
    }
    email = email.replace(/^mailto:/i, '').trim();
    if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(email)) continue;
    out.push({ email, name: name || null });
  }
  return out;
}

/** Message-IDs aus einer References-/In-Reply-To-Kopfzeile, in Reihenfolge. */
export function parseReferences(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : String(value).split(/\s+/);
  const ids = [];
  for (const entry of list) {
    for (const m of String(entry).matchAll(/<[^<>\s]+>/g)) {
      if (!ids.includes(m[0])) ids.push(m[0]);
    }
  }
  return ids;
}

/** Message-ID in spitze Klammern bringen – Server liefern beides. */
const bracket = id => {
  const v = String(id || '').trim();
  if (!v) return null;
  return /^<.*>$/.test(v) ? v : `<${v}>`;
};

/** „Re:" genau einmal davor – nicht „Re: Re: AW: Re:". */
export function replySubject(subject) {
  const base = String(subject || '').replace(/^(\s*(re|aw|antw|fwd|wg)\s*(\[\d+\])?\s*:\s*)+/i, '').trim();
  return base ? `Re: ${base}` : 'Re:';
}

/**
 * Empfänger einer Antwort bestimmen.
 * `to`:  Reply-To der Originalmail, sonst deren Absender.
 * `cc`:  nur bei replyAll – alle übrigen Adressen aus To und Cc, ohne die
 *        eigenen Adressen des Kontos (sonst schreibt man sich selbst) und ohne
 *        Dubletten der To-Adresse.
 */
export function replyRecipients(message, { replyAll = false, account = null } = {}) {
  const preferred = parseAddressList(message.reply_to);
  const from = parseAddressList(message.from_email
    ? (message.from_name ? `"${String(message.from_name).replace(/"/g, '')}" <${message.from_email}>` : message.from_email)
    : '');
  const to = preferred.length ? preferred : from;
  if (!to.length) throw new Error('Die Mail hat keine brauchbare Absender- oder Antwortadresse');

  const mine = new Set([account?.from_email, account?.reply_to, account?.username]
    .filter(Boolean).map(e => String(e).toLowerCase()));
  const seen = new Set(to.map(a => a.email.toLowerCase()));
  const cc = [];
  if (replyAll) {
    for (const a of [...parseAddressList(message.to_text), ...parseAddressList(message.cc_text)]) {
      const key = a.email.toLowerCase();
      if (seen.has(key) || mine.has(key)) continue;
      seen.add(key);
      cc.push(a);
    }
  }
  return { to, cc };
}

/** Zitat-Block unter die Antwort (der Teil, den Mailprogramme „>" schreiben). */
export function quoteBlock(message) {
  const original = message.text || message.snippet || '';
  if (!original) return '';
  const when = message.date ? new Date(message.date).toLocaleString('de-DE') : '';
  const who = esc(message.from_name || message.from_email || 'unbekannt');
  return '<hr>'
    + `<p style="color:#777;font-size:13px">Am ${esc(when)} schrieb ${who}:</p>`
    + '<blockquote style="margin:12px 0;padding:8px 14px;border-left:2px solid #ccc;color:#555;white-space:pre-wrap">'
    + `${esc(original.slice(0, 4000))}</blockquote>`;
}

/**
 * Legt den Antwort-Entwurf an und gibt ihn zurück.
 *
 * Gesendet wird hier nichts – der Entwurf trägt nur alles, was der Versand
 * später für eine echte Antwort braucht (in_reply_to, refs, reply_message_id).
 *
 * @param {number} messageId  id aus dem Posteingang
 */
export function createReplyDraft(messageId, {
  html = null, text = null, subject = null, quote = true, replyAll = false, cc: extraCc = [],
} = {}) {
  const message = getMessage(messageId);
  if (!message) throw new Error('Nachricht nicht gefunden');
  const account = message.account_id ? getAccount(message.account_id) : null;

  const { to, cc } = replyRecipients(message, { replyAll, account });
  const known = new Set([...to, ...cc].map(a => a.email.toLowerCase()));
  for (const entry of extraCc || []) {
    const parsed = typeof entry === 'string' ? parseAddressList(entry) : [entry];
    for (const a of parsed) {
      if (!a?.email || known.has(String(a.email).toLowerCase())) continue;
      known.add(String(a.email).toLowerCase());
      cc.push({ email: a.email, name: a.name || null });
    }
  }

  // References = Kette der Originalmail + deren eigene Message-ID. Kennt der
  // Server keine Message-ID, bleibt die Kette leer: dann ist die Antwort eben
  // eine normale Mail – besser als eine erfundene ID, die den Faden zerreißt.
  const parentId = bracket(message.message_id);
  const chain = parseReferences(message.refs);
  if (parentId && !chain.includes(parentId)) chain.push(parentId);

  const body = html != null ? html : '<p>Hallo {{name}},</p>\n<p>…</p>';
  const draft = createDraft({
    account_id: message.account_id,
    subject: subject || replySubject(message.subject),
    html: body + (quote ? quoteBlock(message) : ''),
    text: text || '',
    // 'batch' mit genau einem To-Empfänger: eine Mail, cc liest mit – wie
    // 'single', aber Platzhalter wie {{name}} werden aufgelöst, weil der
    // Empfängerkontext da ist. In 'single' bliebe „Hallo {{name}}," stehen und
    // der Vorflug-Check würde den Versand zu Recht blockieren.
    mode: 'batch',
    recipients: [
      ...to.map(a => ({ email: a.email, name: a.name, kind: 'to' })),
      ...cc.map(a => ({ email: a.email, name: a.name, kind: 'cc' })),
    ],
    reply_message_id: message.id,
    in_reply_to: parentId,
    refs: chain.length ? chain.join(' ') : null,
  });
  return { draft, message, to, cc, threaded: !!parentId };
}
