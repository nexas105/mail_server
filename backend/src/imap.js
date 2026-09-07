import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import {
  getImapCreds, insertMessage, maxMessageUid,
  getMessageByUid, findSentRecipient, recordBounce, markMessageBounce, recipientAccountId,
} from './db.js';
import { looksLikeBounce, parseBounce } from './tracking.js';

// Baut einen IMAP-Client aus den Account-Zugangsdaten (IMAP-spezifisch, sonst SMTP-Fallback).
function clientFor(account) {
  const c = getImapCreds(account);
  if (!c.host) throw new Error('Kein IMAP-Host konfiguriert');
  return new ImapFlow({
    host: c.host,
    port: c.port,
    secure: c.secure,
    auth: { user: c.user, pass: c.pass },
    logger: false,
    // Zertifikat wird geprüft – sonst könnte sich jeder auf dem Weg als
    // IMAP-Server ausgeben und das Passwort abgreifen. Für selbstsignierte
    // Zertifikate lokaler Server: MAIL_IMAP_ALLOW_SELF_SIGNED=1.
    tls: { rejectUnauthorized: process.env.MAIL_IMAP_ALLOW_SELF_SIGNED !== '1' },
  });
}

// Prüft die IMAP-Zugangsdaten, ohne Mails zu laden.
export async function verifyImap(account) {
  const client = clientFor(account);
  await client.connect();
  await client.logout();
  return true;
}

// Liefert alle auswählbaren IMAP-Ordner. `specialUse` erlaubt der Oberfläche,
// Posteingang, Gesendet, Entwürfe, Archiv, Spam und Papierkorb sauber zu benennen.
export async function listMailboxes(account) {
  const client = clientFor(account);
  await client.connect();
  try {
    const boxes = await client.list();
    return boxes
      .filter(box => !box.flags?.has('\\Noselect'))
      .map(box => ({
        path: box.path,
        name: box.name || box.path,
        delimiter: box.delimiter || '/',
        specialUse: box.specialUse || null,
      }));
  } finally {
    await client.logout().catch(() => {});
  }
}

function snippetOf(text, html) {
  const src = text || (html ? html.replace(/<[^>]+>/g, ' ') : '');
  return src.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Ruft neue Mails eines Ordners per IMAP ab und speichert sie lokal.
 * Inkrementell: nur UIDs oberhalb der höchsten bereits gespeicherten werden geladen.
 * onProgress({ index, total }) wird pro verarbeiteter Mail aufgerufen.
 * Gibt { fetched, saved, total } zurück.
 */
export async function fetchInbox(account, { folder = 'INBOX', limit = 50, onProgress = () => {} } = {}) {
  const client = clientFor(account);
  await client.connect();
  let fetched = 0, saved = 0, bounced = 0;
  const lock = await client.getMailboxLock(folder);
  try {
    const sinceUid = maxMessageUid(account.id, folder);
    // Nur neuere UIDs; beim ersten Sync die letzten `limit` Nachrichten.
    const mailbox = client.mailbox;
    const range = sinceUid > 0 ? `${sinceUid + 1}:*` : '1:*';

    const uids = await client.search({ uid: range }, { uid: true });
    // search kann bei "N:*" die letzte Nachricht doppelt liefern; auf > sinceUid filtern.
    let targets = (uids || []).filter(u => u > sinceUid);
    // Beim Erstabruf (kein sinceUid) auf die neuesten `limit` begrenzen.
    if (sinceUid === 0 && targets.length > limit) targets = targets.slice(-limit);
    const total = targets.length;

    if (total > 0) {
      let index = 0;
      for await (const msg of client.fetch(
        { uid: targets.join(',') },
        { uid: true, envelope: true, flags: true, source: true },
        { uid: true },
      )) {
        index++;
        let parsed = {};
        try { parsed = await simpleParser(msg.source); } catch { /* Rohquelle unparsbar */ }
        const env = msg.envelope || {};
        const fromAddr = (env.from && env.from[0]) || (parsed.from?.value?.[0]) || {};
        const html = parsed.html || null;
        const text = parsed.text || null;
        const seen = msg.flags ? msg.flags.has('\\Seen') : false;
        const flagged = msg.flags ? msg.flags.has('\\Flagged') : false;
        const isNew = insertMessage({
          account_id: account.id,
          folder,
          uid: msg.uid,
          message_id: env.messageId || parsed.messageId || null,
          from_name: fromAddr.name || null,
          from_email: fromAddr.address || null,
          to_text: parsed.to?.text || (env.to || []).map(a => a.address).join(', ') || null,
          subject: env.subject || parsed.subject || '(kein Betreff)',
          date: (env.date || parsed.date || new Date(0)).toISOString?.() || null,
          snippet: snippetOf(text, html),
          text,
          html,
          seen,
          flagged,
        });
        fetched++;
        if (isNew) {
          saved++;
          bounced += noteBounce(account, folder, msg.uid, parsed) ? 1 : 0;
        }
        onProgress({ index, total });
      }
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  return { fetched, saved, bounced };
}


/**
 * Ordnet eine eingegangene Unzustellbarkeitsmeldung dem ursprünglichen
 * Empfänger zu. Das schließt die Lücke zwischen „SMTP hat angenommen" und
 * „wirklich zugestellt" – ohne das steht im Postausgang für immer „gesendet".
 *
 * Zuordnung in dieser Reihenfolge:
 *   1. X-Relay-Ref aus der zitierten Originalmail: 128 Bit Zufall je
 *      Empfänger, den nur kennt, wer die Mail wirklich bekommen hat. Bei
 *      mehreren Referenzen (Sammelmail) entscheidet die Final-Recipient-
 *      Adresse; ohne Adresse zählt nur eine einzelne, eindeutige Referenz.
 *   2. Message-ID aus der zitierten Originalmail (von nodemailer zufällig
 *      vergeben, also ebenfalls nicht erratbar).
 *   3. Final-Recipient/X-Failed-Recipients → letzte gesendete Mail an die
 *      Adresse – aber NUR, wenn ein echter Zustellbericht (multipart/report,
 *      message/delivery-status) vorliegt.
 * In allen drei Fällen muss der Bounce im Postfach des Kontos ankommen, über
 * das der Empfänger versendet wurde – sonst wird er verworfen.
 * X-Relay-Recipient (fortlaufende ID, erratbar) ist KEIN Beleg mehr: Sonst
 * könnte jede Mail mit Betreff „Undeliverable" und „X-Relay-Recipient: 345"
 * im Text einen fremden Versand auf „fehlgeschlagen" setzen, und
 * resend_failed würde ihn erneut verschicken. Ohne Beleg wird der Empfänger
 * nicht angefasst; die Mail selbst wird trotzdem als Bounce markiert – dann
 * eben ohne Zuordnung, statt sie stillschweigend als normale Mail abzulegen.
 */
export function noteBounce(account, folder, uid, parsed) {
  try {
    if (!parsed || !looksLikeBounce(parsed)) return false;
    const info = parseBounce(parsed);
    const stored = getMessageByUid(account.id, folder, uid);

    let recipient = null;
    if (info.relayRefs?.length) {
      const hits = [];
      for (const ref of info.relayRefs) {
        const hit = findSentRecipient({ email: null, relayRef: ref });
        if (hit && !hits.some(h => h.id === hit.id)) hits.push(hit);
      }
      if (info.email) {
        recipient = hits.find(h => String(h.email).toLowerCase() === info.email) || null;
      } else if (hits.length === 1) {
        recipient = hits[0];
      }
    }
    if (!recipient && info.messageId) {
      recipient = findSentRecipient({ email: null, messageId: info.messageId });
    }
    if (!recipient && info.structured && info.email) {
      recipient = findSentRecipient({ email: info.email });
    }
    // Kontobindung: Ein Bounce landet im Postfach des sendenden Kontos. Kommt
    // er woanders an, ist er entweder fremd oder gefälscht.
    if (recipient && recipientAccountId(recipient) !== account.id) {
      console.log(`[bounce] Konto passt nicht (Empfänger ${recipient.id}, Konto ${account.id}, uid ${uid}) – verworfen`);
      recipient = null;
    }

    if (recipient) {
      recordBounce(recipient.id, { type: info.type, code: info.code, reason: info.reason });
    } else {
      console.log(`[bounce] unbestätigt, nicht zugeordnet (${info.email || 'ohne Adresse'}, uid ${uid})`);
    }
    if (stored) {
      markMessageBounce(stored.id, { draftId: recipient?.draft_id ?? null, email: info.email });
    }
    return !!recipient;
  } catch (e) {
    console.error('[bounce]', e.message);
    return false;
  }
}
