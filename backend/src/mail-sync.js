// Automatischer IMAP-Abruf: holt in festen Abständen neue Mails aller Konten.
//
// Ohne das stehen im Posteingang nur Mails, für die jemand von Hand (UI oder
// MCP sync_inbox) abgerufen hat – und get_thread kennt die eigenen Antworten
// aus dem Ordner „Gesendet" nur, wenn der auch synchronisiert wird.
//
// Läuft ausschließlich im Web-Server-Prozess (server.js). Der MCP-Prozess teilt
// sich die Datenbank; liefe der Takt in beiden, würde doppelt abgerufen.
//
// Einstellungen (Tabelle settings, in der Oberfläche schaltbar):
//   mail_autosync_per_day  0 = aus, sonst Abrufe pro Tag (Standard 4 → alle 6 Std.)
//   mail_autosync_scope    'all'   = alle Server-Ordner außer Papierkorb/Spam/Entwürfe
//                          'known' = Posteingang, Gesendet und lokal schon bekannte Ordner
//   mail_autosync_last     Ergebnis des letzten Laufs (wird hier geschrieben)
import * as db from './db.js';
import { fetchInbox, listMailboxes, sentMailbox } from './imap.js';

const log = (...a) => console.log('[mail-sync]', ...a);
const DEFAULT_PER_DAY = 4;
// Ordner, deren Inhalt nur Kontext verbraucht oder alles doppelt (Gmail „Alle Nachrichten").
const SKIP_SPECIAL = new Set(['\\Trash', '\\Junk', '\\Drafts', '\\All', '\\Flagged', '\\Important']);
const SKIP_NAME = /^(trash|papierkorb|gelöschte|deleted|spam|junk|drafts|entw(ü|ue)rfe)/i;

let running = null;

export function autoSyncConfig() {
  const s = db.getAllSettings();
  const raw = s.mail_autosync_per_day;
  const perDay = raw === undefined || raw === null || raw === '' ? DEFAULT_PER_DAY : Math.max(0, Math.min(48, Number(raw) || 0));
  const scope = s.mail_autosync_scope === 'known' ? 'known' : 'all';
  const last = s.mail_autosync_last || null;
  const intervalMs = perDay > 0 ? Math.round(86_400_000 / perDay) : null;
  const nextAt = intervalMs
    ? new Date(Math.max(Date.now(), (last?.started_at ? Date.parse(last.started_at) : 0) + intervalMs)).toISOString()
    : null;
  return { per_day: perDay, scope, last, next_at: nextAt, running: !!running };
}

/** Welche Ordner eines Kontos werden abgerufen? */
async function foldersFor(account, scope) {
  const out = new Set(['INBOX']);
  if (scope === 'all') {
    for (const b of await listMailboxes(account)) {
      if (SKIP_SPECIAL.has(b.specialUse) || SKIP_NAME.test(b.name)) continue;
      out.add(b.path);
    }
    return [...out];
  }
  const sent = await sentMailbox(account).catch(() => null);
  if (sent) out.add(sent);
  for (const f of db.listMessageFolders(account.id)) out.add(f.folder);
  return [...out];
}

/** Ein kompletter Durchlauf über alle IMAP-Konten. Läuft nie doppelt. */
export function runAutoSync({ reason = 'Zeitplan' } = {}) {
  if (running) return running;
  running = (async () => {
    const started = new Date();
    const { scope } = autoSyncConfig();
    const accounts = db.listAccounts().filter(a => a.has_imap);
    const results = [];
    let saved = 0;
    for (const pub of accounts) {
      const account = db.getAccount(pub.id);
      const entry = { account_id: account.id, account: account.name, folders: 0, saved: 0, errors: [] };
      try {
        for (const folder of await foldersFor(account, scope)) {
          try {
            const r = await fetchInbox(account, { folder, limit: 50 });
            entry.folders++;
            entry.saved += r.saved || 0;
          } catch (e) {
            entry.errors.push(`${folder}: ${e.message}`);
          }
        }
      } catch (e) {
        entry.errors.push(e.message);
      }
      saved += entry.saved;
      results.push(entry);
    }
    const last = {
      started_at: started.toISOString(),
      finished_at: new Date().toISOString(),
      reason, scope, saved,
      accounts: results.map(r => ({ ...r, errors: r.errors.slice(0, 5) })),
      ok: results.every(r => !r.errors.length),
    };
    db.setSettings({ mail_autosync_last: last });
    log(`${reason}: ${accounts.length} Konto/Konten, ${saved} neue Mails${last.ok ? '' : ' (mit Fehlern)'}`);
    return last;
  })().finally(() => { running = null; });
  return running;
}

/** Startet den Takt. Prüft alle 5 Minuten, ob ein Lauf fällig ist – übersteht so Neustarts. */
export function startAutoSync() {
  const tick = () => {
    const { per_day, last } = autoSyncConfig();
    if (!per_day || running) return;
    const due = (last?.started_at ? Date.parse(last.started_at) : 0) + 86_400_000 / per_day;
    if (Date.now() >= due) runAutoSync().catch(e => log('Fehler:', e.message));
  };
  // Kurz nach dem Start einmal prüfen, nicht sofort – der Server soll erst hochkommen.
  setTimeout(tick, 60_000).unref();
  setInterval(tick, 5 * 60_000).unref();
}
