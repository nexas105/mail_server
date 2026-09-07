import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertSafeUrl } from './net-guard.js';
import { DATA_DIR, CONTENT_SEED_FILE, ACCOUNTS_SEED_FILE } from './paths.js';

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- Encryption key (AES-256-GCM) ----------------------------------------
// Priority: env MAIL_CRYPTO_KEY (64 hex chars) > data/.keyfile (auto-created).
function loadKey() {
  const env = process.env.MAIL_CRYPTO_KEY;
  if (env) {
    if (!/^[0-9a-fA-F]{64}$/.test(env)) {
      throw new Error('MAIL_CRYPTO_KEY must be 64 hex characters (32 bytes).');
    }
    return Buffer.from(env, 'hex');
  }
  const keyfile = path.join(DATA_DIR, '.keyfile');
  if (fs.existsSync(keyfile)) return Buffer.from(fs.readFileSync(keyfile, 'utf8').trim(), 'hex');
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyfile, key.toString('hex'), { mode: 0o600 });
  return key;
}
const KEY = loadKey();

export function encrypt(plain) {
  if (plain == null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decrypt(blob) {
  if (!blob) return '';
  const [iv, tag, enc] = blob.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(enc, 'base64')), decipher.final()]).toString('utf8');
}

// ---- Database -------------------------------------------------------------
export const db = new DatabaseSync(path.join(DATA_DIR, 'mail.db'));
// busy_timeout, weil Web-Server und MCP-Server zwei Prozesse auf derselben Datei sind:
// ohne ihn wirft SQLite bei gleichzeitigem Schreiben sofort SQLITE_BUSY statt kurz zu warten.
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 587,
  secure INTEGER NOT NULL DEFAULT 0,
  username TEXT NOT NULL,
  password_enc TEXT,
  from_name TEXT,
  from_email TEXT NOT NULL,
  reply_to TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  subject TEXT NOT NULL DEFAULT '',
  html TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'batch',        -- 'batch' = one personalized mail per recipient; 'single' = one combined mail
  reply_to TEXT,                             -- optional; overrides the account default
  status TEXT NOT NULL DEFAULT 'draft',      -- draft | sending | sent | failed | partial
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
);

CREATE TABLE IF NOT EXISTS recipients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'to',           -- to | cc | bcc
  email TEXT NOT NULL,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',    -- pending | sent | failed
  error TEXT,
  message_id TEXT,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_recipients_draft ON recipients(draft_id);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS list_contacts (
  list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  PRIMARY KEY (list_id, contact_id)
);

-- E-Mail-Vorlagen (wiederverwendbare Betreff + HTML-Bausteine).
CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  html TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Globale Custom-Felder (Platzhalter) mit optionalem Standardwert.
CREATE TABLE IF NOT EXISTS custom_fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  field_key TEXT NOT NULL UNIQUE,
  label TEXT,
  default_value TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Datei-Anhänge eines Entwurfs (auf Platte unter data/attachments gespeichert).
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mimetype TEXT,
  size INTEGER,
  stored_path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attachments_draft ON attachments(draft_id);

-- Versand-Protokoll: jede Zustellung/Fehler als unveränderliches Ereignis (Audit-Trail).
CREATE TABLE IF NOT EXISTS send_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id INTEGER REFERENCES drafts(id) ON DELETE SET NULL,
  draft_subject TEXT,
  account_email TEXT,
  email TEXT NOT NULL,
  name TEXT,
  kind TEXT,
  status TEXT NOT NULL,          -- sent | failed
  error TEXT,
  message_id TEXT,
  attempt TEXT,                  -- 'test' | 'send' | 'resend'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_draft ON send_events(draft_id);
CREATE INDEX IF NOT EXISTS idx_events_created ON send_events(created_at);

-- Idempotente Requests der externen HTTP-API.
CREATE TABLE IF NOT EXISTS api_requests (
  idempotency_key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Posteingang: empfangene Mails, per IMAP abgerufen und lokal gespeichert.
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  folder TEXT NOT NULL DEFAULT 'INBOX',
  uid INTEGER NOT NULL,               -- IMAP UID (stabil pro Ordner)
  message_id TEXT,
  from_name TEXT,
  from_email TEXT,
  to_text TEXT,                       -- To-Header als Rohtext
  subject TEXT,
  date TEXT,                          -- Datum der Mail (ISO)
  snippet TEXT,                       -- kurzer Textauszug für die Liste
  text TEXT,
  html TEXT,
  seen INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, folder, uid)
);
CREATE INDEX IF NOT EXISTS idx_messages_account ON messages(account_id, folder, date);
`);

// ---- Migrations (add columns to pre-existing databases) -------------------
for (const [table, col, def] of [
  ['accounts', 'reply_to', 'TEXT'],
  ['accounts', 'carddav_url', 'TEXT'],
  ['accounts', 'carddav_username', 'TEXT'],
  ['accounts', 'carddav_password_enc', 'TEXT'],
  ['accounts', 'imap_host', 'TEXT'],
  ['accounts', 'imap_port', 'INTEGER'],
  ['accounts', 'imap_secure', 'INTEGER'],
  ['accounts', 'imap_username', 'TEXT'],
  ['accounts', 'imap_password_enc', 'TEXT'],
  ['accounts', 'default_header_template_id', 'INTEGER'],
  ['accounts', 'default_footer_template_id', 'INTEGER'],
  ['drafts', 'reply_to', 'TEXT'],
  ['drafts', 'header_template_id', 'INTEGER'],
  ['drafts', 'footer_template_id', 'INTEGER'],
  ['drafts', 'header_html', 'TEXT'],
  ['drafts', 'footer_html', 'TEXT'],
  ['drafts', 'vars', 'TEXT'],
  ['templates', 'kind', "TEXT NOT NULL DEFAULT 'full'"],
  ['recipients', 'vars', 'TEXT'],
  ['contacts', 'company', 'TEXT'],
  ['contacts', 'phone', 'TEXT'],
  ['contacts', 'notes', 'TEXT'],
  ['contacts', 'vars', 'TEXT'],
  // Zustell-Nachverfolgung: Öffnungen (Zählpixel) und Unzustellbarkeit (Bounces).
  ['recipients', 'tracking_token', 'TEXT'],
  // Unerratbare Versandreferenz (X-Relay-Ref) – Beleg für echte Bounces.
  ['recipients', 'relay_ref', 'TEXT'],
  ['recipients', 'opened_at', 'TEXT'],
  ['recipients', 'last_open_at', 'TEXT'],
  ['recipients', 'open_count', 'INTEGER NOT NULL DEFAULT 0'],
  ['recipients', 'open_client', 'TEXT'],
  ['recipients', 'bounced_at', 'TEXT'],
  ['recipients', 'bounce_type', 'TEXT'],      // hard | soft
  ['recipients', 'bounce_code', 'TEXT'],      // z.B. 5.1.1
  ['recipients', 'bounce_reason', 'TEXT'],
  ['messages', 'is_bounce', 'INTEGER NOT NULL DEFAULT 0'],
  ['messages', 'bounce_draft_id', 'INTEGER'],
  ['messages', 'bounce_email', 'TEXT'],
  ['drafts', 'track_opens', 'INTEGER'],       // NULL = globale Einstellung
]) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
  catch { /* column already exists */ }
}

db.exec('CREATE INDEX IF NOT EXISTS idx_recipients_token ON recipients(tracking_token)');
db.exec('CREATE INDEX IF NOT EXISTS idx_recipients_relay_ref ON recipients(relay_ref)');
db.exec('CREATE INDEX IF NOT EXISTS idx_recipients_email ON recipients(email)');

// ---- Zustell-Nachverfolgung ----------------------------------------------
// Zwei Signale, zwei Verlässlichkeiten:
//   Öffnung  – Zählpixel. Untergrenze: Bildunterdrückung und Proxys verschlucken
//              Öffnungen, Apple Mail Privacy Protection erfindet welche.
//   Bounce   – die Unzustellbarkeitsmeldung des Zielservers. Harte Wahrheit.
export function setRecipientToken(id, token) {
  db.prepare('UPDATE recipients SET tracking_token=? WHERE id=?').run(token, id);
}

export function recipientByToken(token) {
  if (!token) return null;
  return db.prepare('SELECT * FROM recipients WHERE tracking_token=?').get(token) || null;
}

/** Zählt eine Öffnung. Die erste zählt als „geöffnet", jede weitere erhöht nur. */
export function recordOpen(token, { client = null } = {}) {
  const r = recipientByToken(token);
  if (!r) return null;
  db.prepare(`UPDATE recipients
      SET opened_at = COALESCE(opened_at, datetime('now')),
          last_open_at = datetime('now'),
          open_count = open_count + 1,
          open_client = COALESCE(open_client, ?)
    WHERE id = ?`).run(client ? String(client).slice(0, 200) : null, r.id);
  const fresh = db.prepare('SELECT * FROM recipients WHERE id=?').get(r.id);
  // Nur die erste Öffnung landet im Protokoll – sonst flutet ein Mail-Client den Verlauf.
  if (fresh.open_count === 1) {
    const d = db.prepare('SELECT subject FROM drafts WHERE id=?').get(r.draft_id);
    logSendEvent({
      draft_id: r.draft_id, draft_subject: d?.subject || null, account_email: null,
      email: r.email, name: r.name, kind: r.kind, status: 'opened', attempt: 'track',
    });
  }
  return fresh;
}

/**
 * Versandreferenz eines Empfängers – 128 Bit Zufall, beim ersten Versand
 * erzeugt und als Kopfzeile X-Relay-Ref mitgeschickt. Ein Zustellbericht
 * zitiert die Originalmail samt Kopfzeilen zurück; wer die Referenz kennt,
 * hat die Mail also wirklich erhalten. Die fortlaufende Empfänger-ID ist
 * dagegen erratbar und taugt nicht als Beleg.
 */
export function ensureRelayRef(recipientId) {
  const row = db.prepare('SELECT relay_ref FROM recipients WHERE id=?').get(recipientId);
  if (!row) return null;
  if (row.relay_ref) return row.relay_ref;
  const ref = crypto.randomBytes(16).toString('base64url');
  db.prepare('UPDATE recipients SET relay_ref=? WHERE id=?').run(ref, recipientId);
  return ref;
}

/** Konto, über das der Empfänger versendet wurde (Kontobindung für Bounces). */
export function recipientAccountId(recipient) {
  if (!recipient?.draft_id) return null;
  const d = db.prepare('SELECT account_id FROM drafts WHERE id=?').get(recipient.draft_id);
  return d?.account_id ?? null;
}

/**
 * Der gesendete Empfänger, auf den sich eine Bounce-Meldung bezieht.
 * Reihenfolge: Versandreferenz (X-Relay-Ref, unerratbar) → eigene
 * Empfänger-ID (X-Relay-Recipient; nur noch für Anzeige/Altbestand, kein
 * Beleg) → Message-ID → zuletzt gesendete Mail an die Adresse. Nur Datensätze
 * mit sent_at, damit eine Meldung nie einen noch nicht versendeten Empfänger
 * trifft.
 */
export function findSentRecipient({ email, messageId = null, draftId = null, recipientId = null, relayRef = null }) {
  if (relayRef && /^[A-Za-z0-9_-]{16,}$/.test(String(relayRef))) {
    const byRef = db.prepare('SELECT * FROM recipients WHERE relay_ref = ? AND sent_at IS NOT NULL').get(String(relayRef));
    if (byRef) return byRef;
    // Eine Referenz ist eindeutig: Passt sie nicht, darf kein schwächeres
    // Kriterium aus demselben Aufruf greifen.
    return null;
  }
  if (recipientId != null && Number.isInteger(Number(recipientId))) {
    const byRecipient = db.prepare('SELECT * FROM recipients WHERE id = ? AND sent_at IS NOT NULL').get(Number(recipientId));
    if (byRecipient) return byRecipient;
  }
  if (messageId) {
    // nodemailer speichert „<id@host>", ein Zustellbericht zitiert meist nur „id@host".
    const bare = String(messageId).trim().replace(/^<|>$/g, '');
    const byId = db.prepare('SELECT * FROM recipients WHERE message_id IN (?, ?) AND sent_at IS NOT NULL ORDER BY id DESC').get(bare, `<${bare}>`);
    if (byId) return byId;
  }
  if (!email) return null;
  const params = [String(email).toLowerCase()];
  let sql = `SELECT * FROM recipients WHERE lower(email) = ? AND sent_at IS NOT NULL`;
  if (draftId) { sql += ' AND draft_id = ?'; params.push(draftId); }
  sql += ' ORDER BY sent_at DESC, id DESC';
  return db.prepare(sql).get(...params) || null;
}

export function recordBounce(recipientId, { type = 'hard', code = null, reason = null } = {}) {
  db.prepare(`UPDATE recipients
      SET bounced_at = datetime('now'), bounce_type = ?, bounce_code = ?, bounce_reason = ?,
          status = CASE WHEN ? = 'hard' THEN 'failed' ELSE status END,
          error = COALESCE(?, error)
    WHERE id = ?`).run(type, code, reason, type, reason, recipientId);
  const r = db.prepare('SELECT * FROM recipients WHERE id=?').get(recipientId);
  const d = db.prepare('SELECT subject FROM drafts WHERE id=?').get(r.draft_id);
  logSendEvent({
    draft_id: r.draft_id, draft_subject: d?.subject || null, account_email: null,
    email: r.email, name: r.name, kind: r.kind,
    status: 'bounced', attempt: 'bounce', error: reason || code || null,
  });
  return r;
}

export function markMessageBounce(messageId, { draftId = null, email = null } = {}) {
  db.prepare('UPDATE messages SET is_bounce=1, bounce_draft_id=?, bounce_email=? WHERE id=?')
    .run(draftId, email, messageId);
}

export function getMessageByUid(accountId, folder, uid) {
  return db.prepare('SELECT * FROM messages WHERE account_id=? AND folder=? AND uid=?').get(accountId, folder, uid) || null;
}

/** Kennzahlen eines Versands für Postausgang und Entwurfsliste. */
export function trackingStats(draftId) {
  return db.prepare(`SELECT
      COUNT(*) FILTER (WHERE kind='to')                        AS total,
      COUNT(*) FILTER (WHERE kind='to' AND status='sent')      AS sent,
      COUNT(*) FILTER (WHERE kind='to' AND opened_at IS NOT NULL)  AS opened,
      COUNT(*) FILTER (WHERE kind='to' AND bounced_at IS NOT NULL) AS bounced
    FROM recipients WHERE draft_id = ?`).get(draftId);
}

// ---- Account data access --------------------------------------------------
export function listAccounts() {
  return db.prepare('SELECT id, name, host, port, secure, username, from_name, from_email, reply_to, carddav_url, carddav_username, imap_host, imap_port, imap_secure, imap_username, default_header_template_id, default_footer_template_id, created_at FROM accounts ORDER BY name').all()
    .map(a => ({ ...a, has_carddav: !!a.carddav_url, has_imap: !!a.imap_host }));
}
export function getAccount(id) {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
}
export function createAccount(a) {
  // Die CardDAV-URL bekommt später das Passwort per Basic-Auth – kein internes Ziel.
  if (a.carddav_url) assertSafeUrl(a.carddav_url, { purpose: 'CardDAV' });
  const r = db.prepare(`INSERT INTO accounts (name, host, port, secure, username, password_enc, from_name, from_email, reply_to, carddav_url, carddav_username, carddav_password_enc, imap_host, imap_port, imap_secure, imap_username, imap_password_enc, default_header_template_id, default_footer_template_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    a.name, a.host, a.port ?? 587, a.secure ? 1 : 0, a.username,
    encrypt(a.password), a.from_name ?? null, a.from_email, a.reply_to || null,
    a.carddav_url || null, a.carddav_username || null, a.carddav_password ? encrypt(a.carddav_password) : null,
    a.imap_host || null, a.imap_port ?? null, a.imap_secure != null ? (a.imap_secure ? 1 : 0) : null,
    a.imap_username || null, a.imap_password ? encrypt(a.imap_password) : null,
    a.default_header_template_id || null, a.default_footer_template_id || null);
  return getAccountPublic(r.lastInsertRowid);
}
export function updateAccount(id, a) {
  const cur = getAccount(id);
  if (!cur) return null;
  if (a.carddav_url) assertSafeUrl(a.carddav_url, { purpose: 'CardDAV' });

  // Wechselt der Server, muss das zugehörige Passwort im selben Aufruf neu
  // eingegeben werden. Sonst könnte ein Host-Wechsel plus „Prüfen“ das
  // gespeicherte Passwort an einen fremden Server schicken.
  const changed = (key, norm = v => v) => a[key] !== undefined && norm(a[key]) !== norm(cur[key]);
  const nullable = v => (v == null || v === '' ? null : String(v));
  const flag = v => (v ? 1 : 0);
  const num = v => (v == null || v === '' ? null : Number(v));
  if (changed('host', String) || changed('port', num) || changed('secure', flag)) {
    if (!a.password) throw new Error('Beim Wechsel des SMTP-Servers muss das Passwort neu eingegeben werden');
  }
  const imapHostAfter = a.imap_host !== undefined ? nullable(a.imap_host) : cur.imap_host;
  if (imapHostAfter && (changed('imap_host', nullable) || changed('imap_port', num) || changed('imap_secure', v => (v == null ? null : flag(v))))) {
    // Gilt auch, wenn bisher kein eigenes IMAP-Passwort hinterlegt war: der
    // Rückfall auf das SMTP-Passwort ist genau die Lücke.
    if (!a.imap_password) throw new Error('Beim Wechsel des IMAP-Servers muss das IMAP-Passwort neu eingegeben werden');
  }
  if (nullable(a.carddav_url !== undefined ? a.carddav_url : cur.carddav_url) && changed('carddav_url', nullable)) {
    if (!a.carddav_password) throw new Error('Beim Wechsel der CardDAV-Adresse muss das CardDAV-Passwort neu eingegeben werden');
  }
  db.prepare(`UPDATE accounts SET name=?, host=?, port=?, secure=?, username=?, password_enc=?, from_name=?, from_email=?, reply_to=?, carddav_url=?, carddav_username=?, carddav_password_enc=?, imap_host=?, imap_port=?, imap_secure=?, imap_username=?, imap_password_enc=?, default_header_template_id=?, default_footer_template_id=? WHERE id=?`).run(
    a.name ?? cur.name, a.host ?? cur.host, a.port ?? cur.port,
    (a.secure ?? cur.secure) ? 1 : 0, a.username ?? cur.username,
    a.password ? encrypt(a.password) : cur.password_enc,
    a.from_name ?? cur.from_name, a.from_email ?? cur.from_email,
    a.reply_to !== undefined ? (a.reply_to || null) : cur.reply_to,
    a.carddav_url !== undefined ? (a.carddav_url || null) : cur.carddav_url,
    a.carddav_username !== undefined ? (a.carddav_username || null) : cur.carddav_username,
    a.carddav_password ? encrypt(a.carddav_password) : cur.carddav_password_enc,
    a.imap_host !== undefined ? (a.imap_host || null) : cur.imap_host,
    a.imap_port !== undefined ? (a.imap_port || null) : cur.imap_port,
    a.imap_secure !== undefined ? (a.imap_secure ? 1 : 0) : cur.imap_secure,
    a.imap_username !== undefined ? (a.imap_username || null) : cur.imap_username,
    a.imap_password ? encrypt(a.imap_password) : cur.imap_password_enc,
    a.default_header_template_id !== undefined ? (a.default_header_template_id || null) : cur.default_header_template_id,
    a.default_footer_template_id !== undefined ? (a.default_footer_template_id || null) : cur.default_footer_template_id, id);
  return getAccountPublic(id);
}
export function deleteAccount(id) {
  return db.prepare('DELETE FROM accounts WHERE id=?').run(id).changes > 0;
}
export function duplicateAccount(id, newName) {
  const a = getAccount(id);
  if (!a) return null;
  const r = db.prepare(`INSERT INTO accounts (name, host, port, secure, username, password_enc, from_name, from_email, reply_to, carddav_url, carddav_username, carddav_password_enc, imap_host, imap_port, imap_secure, imap_username, imap_password_enc)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    newName || `${a.name} (Kopie)`, a.host, a.port, a.secure, a.username,
    a.password_enc, a.from_name, a.from_email, a.reply_to,
    a.carddav_url, a.carddav_username, a.carddav_password_enc,
    a.imap_host, a.imap_port, a.imap_secure, a.imap_username, a.imap_password_enc);
  return getAccountPublic(r.lastInsertRowid);
}
export function getAccountPublic(id) {
  const a = getAccount(id);
  if (!a) return null;
  const { password_enc, carddav_password_enc, imap_password_enc, ...pub } = a;
  return { ...pub, has_password: !!password_enc, has_carddav: !!a.carddav_url, has_imap: !!a.imap_host };
}
// CardDAV-Zugangsdaten; fällt auf die SMTP-Zugangsdaten des Accounts zurück.
export function getCardDavCreds(account) {
  return {
    url: account.carddav_url,
    user: account.carddav_username || account.username,
    pass: account.carddav_password_enc ? decrypt(account.carddav_password_enc) : decrypt(account.password_enc),
  };
}
// IMAP-Zugangsdaten; Host wählbar, Benutzer/Passwort fallen auf die SMTP-Zugangsdaten zurück.
export function getImapCreds(account) {
  const secure = account.imap_secure != null ? !!account.imap_secure : true;
  return {
    host: account.imap_host,
    port: account.imap_port || (secure ? 993 : 143),
    secure,
    user: account.imap_username || account.username,
    pass: account.imap_password_enc ? decrypt(account.imap_password_enc) : decrypt(account.password_enc),
  };
}

// ---- Draft data access ----------------------------------------------------
export function createDraft(d) {
  // Account-Standards für Header/Footer übernehmen, wenn nicht explizit gesetzt.
  // Ein explizites `null` bedeutet "ohne Baustein". Nur fehlende Felder
  // erben die Account-Standards.
  const hasHeader = Object.prototype.hasOwnProperty.call(d, 'header_template_id');
  const hasFooter = Object.prototype.hasOwnProperty.call(d, 'footer_template_id');
  let headerId = hasHeader ? (d.header_template_id || null) : null;
  let footerId = hasFooter ? (d.footer_template_id || null) : null;
  if ((!hasHeader || !hasFooter) && d.account_id) {
    const acc = getAccount(d.account_id);
    if (acc) {
      if (!hasHeader) headerId = acc.default_header_template_id || null;
      if (!hasFooter) footerId = acc.default_footer_template_id || null;
    }
  }
  // Standard-Marke vererben, wenn der Entwurf keine eigenen Variablen mitbringt.
  let vars = d.vars;
  if (vars == null) {
    const def = getDefaultBrand();
    if (def) vars = brandVars(def);
  }
  const varsJson = vars && typeof vars === 'object' ? JSON.stringify(vars) : (vars ?? null);
  const headerSnapshot = headerId ? (getTemplate(headerId)?.html || null) : (d.header_html || null);
  const footerSnapshot = footerId ? (getTemplate(footerId)?.html || null) : (d.footer_html || null);
  const r = db.prepare(`INSERT INTO drafts (account_id, subject, html, text, mode, reply_to, header_template_id, footer_template_id, header_html, footer_html, vars)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    d.account_id ?? null, d.subject ?? '', d.html ?? '', d.text ?? '', d.mode ?? 'batch', d.reply_to || null,
    headerId, footerId, headerSnapshot, footerSnapshot, varsJson);
  const id = r.lastInsertRowid;
  if (Array.isArray(d.recipients)) addRecipients(id, d.recipients);
  return getDraft(id);
}
export function updateDraft(id, d) {
  const cur = db.prepare('SELECT * FROM drafts WHERE id=?').get(id);
  if (!cur) return null;
  const varsJson = d.vars !== undefined
    ? (d.vars && typeof d.vars === 'object' ? JSON.stringify(d.vars) : (d.vars || null))
    : cur.vars;
  const nextHeaderId = d.header_template_id !== undefined ? (d.header_template_id || null) : cur.header_template_id;
  const nextFooterId = d.footer_template_id !== undefined ? (d.footer_template_id || null) : cur.footer_template_id;
  const nextHeaderHtml = d.header_template_id !== undefined && d.header_template_id
    ? (getTemplate(d.header_template_id)?.html || null)
    : d.header_html !== undefined ? (d.header_html || null) : cur.header_html;
  const nextFooterHtml = d.footer_template_id !== undefined && d.footer_template_id
    ? (getTemplate(d.footer_template_id)?.html || null)
    : d.footer_html !== undefined ? (d.footer_html || null) : cur.footer_html;
  // track_opens kennt drei Zustände: 1 an, 0 aus, NULL „wie global eingestellt".
  const nextTrack = d.track_opens !== undefined
    ? (d.track_opens == null ? null : (d.track_opens ? 1 : 0))
    : cur.track_opens;
  db.prepare(`UPDATE drafts SET account_id=?, subject=?, html=?, text=?, mode=?, reply_to=?, header_template_id=?, footer_template_id=?, header_html=?, footer_html=?, vars=?, track_opens=?, updated_at=datetime('now') WHERE id=?`).run(
    d.account_id ?? cur.account_id, d.subject ?? cur.subject, d.html ?? cur.html,
    d.text ?? cur.text, d.mode ?? cur.mode,
    d.reply_to !== undefined ? (d.reply_to || null) : cur.reply_to,
    nextHeaderId, nextFooterId, nextHeaderHtml, nextFooterHtml, varsJson, nextTrack, id);
  return getDraft(id);
}
// Setzt Header/Footer-HTML um den Body (für Vorschau & Versand).
// Der beim Auswählen gespeicherte Snapshot hat Vorrang. Dadurch verändern
// spätere Template-Edits oder Löschungen keine bestehenden Entwürfe.
export function composeDraftHtml(draft) {
  const header = draft.header_template_id ? getTemplate(draft.header_template_id) : null;
  const footer = draft.footer_template_id ? getTemplate(draft.footer_template_id) : null;
  const headerHtml = draft.header_html || header?.html || '';
  const footerHtml = draft.footer_html || footer?.html || '';
  return (headerHtml ? headerHtml + '\n' : '') + (draft.html || '') + (footerHtml ? '\n' + footerHtml : '');
}
export function addRecipients(draftId, recipients) {
  const stmt = db.prepare('INSERT INTO recipients (draft_id, kind, email, name, vars) VALUES (?, ?, ?, ?, ?)');
  for (const rc of recipients) {
    if (!rc || !rc.email) continue;
    let vars = rc.vars && typeof rc.vars === 'object' ? JSON.stringify(rc.vars) : (rc.vars ?? null);
    // Keine Variablen mitgegeben? Werte des passenden Kontakts automatisch übernehmen.
    if (vars == null) {
      const c = getContactByEmail(rc.email);
      if (c) { const cv = contactVars(c); if (Object.keys(cv).length) vars = JSON.stringify(cv); }
    }
    stmt.run(draftId, rc.kind ?? 'to', rc.email.trim(), rc.name ?? null, vars);
  }
  return getRecipients(draftId);
}
export function getRecipients(draftId) {
  return db.prepare('SELECT * FROM recipients WHERE draft_id=? ORDER BY id').all(draftId);
}
/**
 * Einzelne Empfänger entfernen – per id oder per Adresse.
 * Bisher konnte man nur alle auf einmal löschen; ein Assistent, der einen
 * falschen Empfänger hinzugefügt hat, musste die ganze Liste neu aufbauen.
 */
export function removeRecipients(draftId, { ids = [], emails = [] } = {}) {
  let removed = 0;
  for (const id of ids) {
    removed += db.prepare('DELETE FROM recipients WHERE id=? AND draft_id=?').run(id, draftId).changes;
  }
  for (const email of emails) {
    removed += db.prepare('DELETE FROM recipients WHERE draft_id=? AND lower(email)=lower(?)')
      .run(draftId, String(email).trim()).changes;
  }
  return removed;
}

export function clearRecipients(draftId) {
  db.prepare('DELETE FROM recipients WHERE draft_id=?').run(draftId);
}
export function getDraft(id) {
  const d = db.prepare('SELECT * FROM drafts WHERE id=?').get(id);
  if (!d) return null;
  d.recipients = getRecipients(id);
  d.account = d.account_id ? getAccountPublic(d.account_id) : null;
  return d;
}
export function listDrafts(status) {
  const rows = status
    ? db.prepare('SELECT * FROM drafts WHERE status=? ORDER BY updated_at DESC').all(status)
    : db.prepare('SELECT * FROM drafts ORDER BY updated_at DESC').all();
  for (const d of rows) {
    const c = db.prepare(`SELECT
        COUNT(*) n,
        SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) sent,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,
        SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END) opened,
        SUM(CASE WHEN bounced_at IS NOT NULL THEN 1 ELSE 0 END) bounced
      FROM recipients WHERE draft_id=? AND kind='to'`).get(d.id);
    const total = db.prepare('SELECT COUNT(*) n FROM recipients WHERE draft_id=?').get(d.id);
    d.recipient_count = total.n;
    d.sent_count = c.sent || 0;
    d.failed_count = c.failed || 0;
    d.opened_count = c.opened || 0;
    d.bounced_count = c.bounced || 0;
    d.account = d.account_id ? getAccountPublic(d.account_id) : null;
  }
  return rows;
}

/** Kanalübergreifende Nutzungszahlen für das Dashboard, ohne Nachrichteninhalte. */
export function dashboardAnalytics() {
  const email = db.prepare(`SELECT
      COUNT(*) AS recipients,
      SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opened,
      SUM(CASE WHEN bounced_at IS NOT NULL THEN 1 ELSE 0 END) AS bounced,
      SUM(CASE WHEN sent_at >= datetime('now','-7 days') THEN 1 ELSE 0 END) AS sent_7d
    FROM recipients WHERE kind='to'`).get();
  const inbox = db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN created_at >= datetime('now','-7 days') THEN 1 ELSE 0 END) AS last_7d
    FROM messages`).get();
  const whatsapp = db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN from_me=1 THEN 1 ELSE 0 END) AS outgoing,
      SUM(CASE WHEN from_me=0 THEN 1 ELSE 0 END) AS incoming,
      SUM(CASE WHEN ts >= unixepoch('now','-7 days') THEN 1 ELSE 0 END) AS last_7d,
      SUM(CASE WHEN origin='mcp' THEN 1 ELSE 0 END) AS via_mcp
    FROM wa_messages`).get();
  const days = db.prepare(`WITH RECURSIVE days(day) AS (
      SELECT date('now','-6 days') UNION ALL
      SELECT date(day,'+1 day') FROM days WHERE day < date('now')
    ) SELECT day,
      (SELECT COUNT(*) FROM recipients r WHERE r.kind='to' AND date(r.sent_at)=day) AS email,
      (SELECT COUNT(*) FROM messages m WHERE date(m.created_at)=day) AS inbox,
      (SELECT COUNT(*) FROM wa_messages w WHERE date(w.ts,'unixepoch')=day) AS whatsapp
    FROM days ORDER BY day`).all();
  const clean = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value || 0]));
  return { email: clean(email), inbox: clean(inbox), whatsapp: clean(whatsapp), days };
}
export function deleteDraft(id) {
  return db.prepare('DELETE FROM drafts WHERE id=?').run(id).changes > 0;
}
// Kopie eines Entwurfs inkl. Empfänger (Status zurückgesetzt), ohne Anhänge.
export function duplicateDraft(id) {
  const d = getDraft(id);
  if (!d) return null;
  const r = db.prepare(`INSERT INTO drafts (account_id, subject, html, text, mode, reply_to, header_template_id, footer_template_id, header_html, footer_html)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    d.account_id, d.subject, d.html, d.text, d.mode, d.reply_to,
    d.header_template_id, d.footer_template_id, d.header_html, d.footer_html);
  const newId = r.lastInsertRowid;
  addRecipients(newId, d.recipients.map(x => ({ email: x.email, name: x.name, kind: x.kind, vars: x.vars ?? undefined })));
  return getDraft(newId);
}
export function setDraftStatus(id, status, error = null) {
  db.prepare(`UPDATE drafts SET status=?, error=?, sent_at=CASE WHEN ? IN ('sent','partial') THEN datetime('now') ELSE sent_at END WHERE id=?`)
    .run(status, error, status, id);
}
export function setRecipientResult(id, status, { error = null, messageId = null } = {}) {
  db.prepare(`UPDATE recipients SET status=?, error=?, message_id=?, sent_at=datetime('now') WHERE id=?`)
    .run(status, error, messageId, id);
}

// ---- Contacts & lists -----------------------------------------------------
/**
 * Kontakt über die Mailadresse anlegen oder aktualisieren.
 *
 * Ohne Adresse geht das nicht – dafür gibt es createContact. Der Grund: Ohne
 * Schlüssel lässt sich nicht entscheiden, ob jemand schon existiert, und jeder
 * Aufruf legte einen weiteren Eintrag an.
 */
export function upsertContact(email, name) {
  const mail = String(email ?? '').trim();
  if (!mail) return createContact({ name });
  db.prepare(`INSERT INTO contacts (email, name) VALUES (?, ?)
    ON CONFLICT(email) DO UPDATE SET name=COALESCE(excluded.name, name)`).run(mail, name ?? null);
  return db.prepare('SELECT * FROM contacts WHERE email=?').get(mail);
}

/**
 * Kontakt anlegen – die Mailadresse ist optional.
 *
 * Nötig, seit WhatsApp dazugehört: Wer nur eine Nummer hat, soll trotzdem ins
 * Adressbuch. Solche Kontakte werden beim Mailversand übersprungen
 * (addRecipients lässt Einträge ohne Adresse aus), können also nicht
 * versehentlich angeschrieben werden.
 */
export function createContact({ email, name, company, phone, notes } = {}) {
  const mail = String(email ?? '').trim() || null;
  if (mail) {
    const existing = getContactByEmail(mail);
    if (existing) return updateContact(existing.id, { name, company, phone, notes });
  }
  const r = db.prepare(
    'INSERT INTO contacts (email, name, company, phone, notes) VALUES (?, ?, ?, ?, ?)')
    .run(mail, name ?? null, company ?? null, phone ?? null, notes ?? null);
  return getContactById(r.lastInsertRowid);
}

/** Kontakte einer Liste, die per Mail erreichbar sind – der Rest wird gezählt. */
export function mailableListMembers(listId) {
  const all = getListMembers(listId);
  const mailable = all.filter(c => c.email);
  return { mailable, skipped: all.length - mailable.length };
}
export function listContacts() {
  // repo_count kommt mit, damit die Kontaktliste die Repo-Zahl ohne Extra-Abfrage zeigt.
  return db.prepare(
    `SELECT c.*, (SELECT COUNT(*) FROM contact_repos r WHERE r.contact_id = c.id) AS repo_count
     FROM contacts c ORDER BY c.name, c.email`).all();
}
export function getContactById(id) {
  return db.prepare('SELECT * FROM contacts WHERE id=?').get(id);
}
export function getContactByEmail(email) {
  return db.prepare('SELECT * FROM contacts WHERE email=?').get(String(email || '').trim());
}
// Optionale Zusatzfelder (name/company/phone/notes/vars) eines Kontakts aktualisieren.
export function updateContact(id, f = {}) {
  const cur = getContactById(id);
  if (!cur) return null;
  const vars = f.vars !== undefined
    ? (f.vars && typeof f.vars === 'object' ? JSON.stringify(f.vars) : (f.vars || null))
    : (cur.vars ?? null);
  db.prepare('UPDATE contacts SET name=?, company=?, phone=?, notes=?, vars=? WHERE id=?').run(
    f.name ?? cur.name, f.company ?? cur.company ?? null,
    f.phone ?? cur.phone ?? null, f.notes ?? cur.notes ?? null, vars, id);
  return getContactById(id);
}
// Platzhalter-Werte eines Kontakts: strukturierte Felder + freie vars (vars gewinnen).
// Aliase: company→{{company}}/{{firma}}, phone→{{phone}}/{{telefon}}.
export function contactVars(contact) {
  if (!contact) return {};
  const structured = {};
  if (contact.company) { structured.company = contact.company; structured.firma = contact.company; }
  if (contact.phone) { structured.phone = contact.phone; structured.telefon = contact.phone; }
  if (contact.notes) structured.notes = contact.notes;
  let custom = {};
  if (contact.vars) { try { custom = JSON.parse(contact.vars); } catch { /* ignore */ } }
  return { ...structured, ...custom };
}
export function deleteContact(id) {
  return db.prepare('DELETE FROM contacts WHERE id=?').run(id).changes > 0;
}
export function createList(name) {
  db.prepare('INSERT OR IGNORE INTO lists (name) VALUES (?)').run(name);
  return db.prepare('SELECT * FROM lists WHERE name=?').get(name);
}
export function listLists() {
  const lists = db.prepare('SELECT * FROM lists ORDER BY name').all();
  for (const l of lists) {
    l.members = db.prepare(`SELECT c.* FROM contacts c JOIN list_contacts lc ON lc.contact_id=c.id WHERE lc.list_id=? ORDER BY c.name, c.email`).all(l.id);
  }
  return lists;
}
export function addContactToList(listId, contactId) {
  db.prepare('INSERT OR IGNORE INTO list_contacts (list_id, contact_id) VALUES (?, ?)').run(listId, contactId);
}
export function removeContactFromList(listId, contactId) {
  return db.prepare('DELETE FROM list_contacts WHERE list_id=? AND contact_id=?').run(listId, contactId).changes > 0;
}
export function deleteList(id) {
  return db.prepare('DELETE FROM lists WHERE id=?').run(id).changes > 0;
}
export function getListMembers(listId) {
  return db.prepare(`SELECT c.* FROM contacts c JOIN list_contacts lc ON lc.contact_id=c.id WHERE lc.list_id=?`).all(listId);
}

export function getAccountByName(name) {
  return db.prepare('SELECT * FROM accounts WHERE name=?').get(name);
}

// ---- Datei-Anhänge --------------------------------------------------------
const ATTACH_DIR = path.join(DATA_DIR, 'attachments');
fs.mkdirSync(ATTACH_DIR, { recursive: true });
export function addAttachment(draftId, { filename, mimetype, base64 }) {
  const buf = Buffer.from(base64, 'base64');
  const safe = String(filename || 'datei').replace(/[^\w.\-]+/g, '_').slice(0, 120);
  const stored = path.join(ATTACH_DIR, `${draftId}_${Date.now()}_${safe}`);
  fs.writeFileSync(stored, buf);
  const r = db.prepare('INSERT INTO attachments (draft_id, filename, mimetype, size, stored_path) VALUES (?, ?, ?, ?, ?)')
    .run(draftId, filename || safe, mimetype || 'application/octet-stream', buf.length, stored);
  return getAttachment(r.lastInsertRowid);
}
export function getAttachment(id) {
  return db.prepare('SELECT * FROM attachments WHERE id=?').get(id);
}
export function listAttachments(draftId) {
  return db.prepare('SELECT id, draft_id, filename, mimetype, size, created_at FROM attachments WHERE draft_id=? ORDER BY id').all(draftId);
}
export function deleteAttachment(id) {
  const a = getAttachment(id);
  if (!a) return false;
  try { fs.unlinkSync(a.stored_path); } catch { /* egal */ }
  return db.prepare('DELETE FROM attachments WHERE id=?').run(id).changes > 0;
}
// Für den Versand (nodemailer): filename + path + contentType.
export function attachmentsForSend(draftId) {
  return db.prepare('SELECT filename, mimetype, stored_path FROM attachments WHERE draft_id=?').all(draftId)
    .map(a => ({ filename: a.filename, path: a.stored_path, contentType: a.mimetype }));
}

// ---- E-Mail-Vorlagen ------------------------------------------------------
// kind: 'full' (Betreff+Body), 'header' (oben eingefügt), 'footer' (unten eingefügt)
export function listTemplates(kind) {
  return kind
    ? db.prepare('SELECT * FROM templates WHERE kind=? ORDER BY name').all(kind)
    : db.prepare('SELECT * FROM templates ORDER BY kind, name').all();
}
export function getTemplate(id) {
  return db.prepare('SELECT * FROM templates WHERE id=?').get(id);
}
export function createTemplate(t) {
  const r = db.prepare('INSERT INTO templates (name, subject, html, kind) VALUES (?, ?, ?, ?)')
    .run(t.name || 'Unbenannt', t.subject || '', t.html || '', t.kind || 'full');
  return getTemplate(r.lastInsertRowid);
}
export function updateTemplate(id, t) {
  const cur = getTemplate(id);
  if (!cur) return null;
  db.prepare(`UPDATE templates SET name=?, subject=?, html=?, kind=?, updated_at=datetime('now') WHERE id=?`)
    .run(t.name ?? cur.name, t.subject ?? cur.subject, t.html ?? cur.html, t.kind ?? cur.kind, id);
  return getTemplate(id);
}
export function deleteTemplate(id) {
  return db.prepare('DELETE FROM templates WHERE id=?').run(id).changes > 0;
}

// ---- Globale Custom-Felder ------------------------------------------------
export function listCustomFields() {
  return db.prepare('SELECT * FROM custom_fields ORDER BY field_key').all();
}
export function upsertCustomField({ field_key, label, default_value }) {
  const key = String(field_key || '').trim().replace(/[^\w.]/g, '');
  if (!key) throw new Error('field_key erforderlich (nur Buchstaben/Zahlen/_)');
  db.prepare(`INSERT INTO custom_fields (field_key, label, default_value) VALUES (?, ?, ?)
    ON CONFLICT(field_key) DO UPDATE SET label=excluded.label, default_value=excluded.default_value`)
    .run(key, label ?? null, default_value ?? null);
  return db.prepare('SELECT * FROM custom_fields WHERE field_key=?').get(key);
}
export function deleteCustomField(id) {
  return db.prepare('DELETE FROM custom_fields WHERE id=?').run(id).changes > 0;
}
// { key: default_value } für alle Felder mit gesetztem Standardwert.
export function getCustomFieldDefaults() {
  const out = {};
  for (const f of db.prepare('SELECT field_key, default_value FROM custom_fields').all()) {
    if (f.default_value != null && f.default_value !== '') out[f.field_key] = f.default_value;
  }
  return out;
}

// ---- Marken (Brands): Variablen-Presets inkl. Farbe -----------------------
// Eine Marke ist ein benanntes Set von Variablen (firma, brand_color, website …).
// Auf einen Entwurf angewendet = draft.vars. So sind Design/Farbe umschaltbar und
// Vorlagen werden kontext-spezifisch (Erohub, DBFV NRW …), ohne Extra-Vorlagen.
db.exec(`CREATE TABLE IF NOT EXISTS brands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  vars TEXT NOT NULL DEFAULT '{}',
  asset_id INTEGER,                 -- optionales Logo (Referenz in assets)
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
for (const [col, def] of [['asset_id', 'INTEGER'], ['is_default', 'INTEGER NOT NULL DEFAULT 0']]) {
  try { db.exec(`ALTER TABLE brands ADD COLUMN ${col} ${def}`); } catch { /* existiert schon */ }
}
// ---- Farb-Palette einer Marke --------------------------------------------
// Eine Marke hat mehr als eine Farbe: Primär/Sekundär/Akzent plus Flächen- und
// Textfarben. Nicht gesetzte Slots werden aus den gesetzten abgeleitet, damit
// jede Vorlage alle Platzhalter bekommt – auch bei Marken, die nur eine Farbe
// pflegen. Spiegelbild im Frontend: frontend/src/lib/brandPalette.ts
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
function rgbOf(c) {
  let h = String(c || '').trim();
  if (!HEX.test(h)) return null;
  h = h.slice(1);
  if (h.length <= 4) h = h.split('').map(x => x + x).join('');
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
}
const hexOf = ([r, g, b]) =>
  '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
// t = 0 → a, t = 1 → b
function mix(a, b, t) {
  const x = rgbOf(a), y = rgbOf(b);
  if (!x || !y) return a;
  return hexOf(x.map((v, i) => v + (y[i] - v) * t));
}
// t > 0 heller (Richtung Weiß), t < 0 dunkler (Richtung Schwarz)
const shade = (c, t) => mix(c, t > 0 ? '#ffffff' : '#000000', Math.abs(t));
// Farbton drehen – liefert eine verwandte, aber klar andere Farbe als Akzent.
function rotate(c, deg) {
  const p = rgbOf(c);
  if (!p) return c;
  const [r, g, b] = p.map(v => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  h = (((h * 60 + deg) % 360) + 360) % 360;
  const cc = (1 - Math.abs(2 * l - 1)) * s, xx = cc * (1 - Math.abs((h / 60) % 2 - 1)), m = l - cc / 2;
  const seg = [[cc, xx, 0], [xx, cc, 0], [0, cc, xx], [0, xx, cc], [xx, 0, cc], [cc, 0, xx]][Math.floor(h / 60) % 6];
  return hexOf(seg.map(v => (v + m) * 255));
}
// Lesbare Schriftfarbe auf einer Fläche (WCAG-Relativhelligkeit). Die Schwelle
// liegt bewusst über dem rechnerischen Optimum (0.179): auf kräftigen Marken-
// farben wie Blau oder Rot bleibt damit die übliche weiße Schrift, erst bei
// hellen Tönen (Gold, Gelb, Hellgrün) wird auf dunkle Schrift gewechselt.
function readableOn(c) {
  const p = rgbOf(c);
  if (!p) return '#ffffff';
  const [r, g, b] = p.map(v => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.35 ? '#0f172a' : '#ffffff';
}

// Editierbare Farb-Slots (Reihenfolge = Anzeige in der Oberfläche).
export const BRAND_PALETTE = [
  { key: 'brand_color', label: 'Primärfarbe', hint: 'Header, Buttons, Links', derive: () => '#4f8cff' },
  { key: 'brand_color_2', label: 'Sekundärfarbe', hint: 'Zweite Fläche, Ende des Verlaufs', derive: p => shade(p.brand_color, -0.3) },
  { key: 'brand_accent', label: 'Akzentfarbe', hint: 'Badges, Hervorhebungen, Zahlen', derive: p => rotate(p.brand_color, 42) },
  { key: 'brand_bg', label: 'Seitenhintergrund', hint: 'Fläche hinter der Mail', derive: () => '#f4f5f7' },
  { key: 'brand_surface', label: 'Inhaltsfläche', hint: 'Das „Papier“ der Mail', derive: () => '#ffffff' },
  { key: 'brand_text', label: 'Textfarbe', hint: 'Fließtext und Überschriften', derive: () => '#0f172a' },
  { key: 'brand_muted', label: 'Sekundärtext', hint: 'Footer, Hinweise, Labels', derive: p => mix(p.brand_text, p.brand_surface, 0.48) },
  { key: 'brand_border', label: 'Rahmenfarbe', hint: 'Linien und Trenner', derive: p => mix(p.brand_text, p.brand_surface, 0.88) },
];
// Automatisch berechnet – überschreibbar, aber normalerweise abgeleitet.
export const BRAND_PALETTE_DERIVED = [
  { key: 'brand_on_color', label: 'Text auf Primär', derive: p => readableOn(p.brand_color) },
  { key: 'brand_on_color_2', label: 'Text auf Sekundär', derive: p => readableOn(p.brand_color_2) },
  { key: 'brand_on_accent', label: 'Text auf Akzent', derive: p => readableOn(p.brand_accent) },
  { key: 'brand_soft', label: 'Primär, sehr hell', derive: p => mix(p.brand_color, p.brand_surface, 0.88) },
  { key: 'brand_gradient', label: 'Verlauf Primär → Sekundär', derive: p => `linear-gradient(135deg, ${p.brand_color}, ${p.brand_color_2})` },
];
export const BRAND_PALETTE_KEYS = [...BRAND_PALETTE, ...BRAND_PALETTE_DERIVED].map(f => f.key);

// Vollständige Palette: gesetzte Werte gewinnen, der Rest wird abgeleitet.
export function brandPalette(vars = {}) {
  const out = {};
  for (const f of [...BRAND_PALETTE, ...BRAND_PALETTE_DERIVED]) {
    const own = String(vars[f.key] ?? '').trim();
    // Halb getippte Hex-Werte („#1a“) zählen als „noch nichts“ – dann lieber
    // ableiten als eine ungültige Farbe in die Mail schreiben.
    const usable = own && !(own.startsWith('#') && !HEX.test(own));
    out[f.key] = usable ? own : f.derive(out);
  }
  return out;
}

function parseBrand(b) {
  if (!b) return b;
  try { b.vars = JSON.parse(b.vars); } catch { b.vars = {}; }
  b.logo_url = b.asset_id ? `/api/assets/${b.asset_id}/file` : null;
  b.palette = brandPalette(b.vars); // aufgelöste Farben inkl. abgeleiteter Slots
  return b;
}
export function listBrands() { return db.prepare('SELECT * FROM brands ORDER BY name').all().map(parseBrand); }
export function getBrand(id) { return parseBrand(db.prepare('SELECT * FROM brands WHERE id=?').get(id)); }
export function getDefaultBrand() { return parseBrand(db.prepare('SELECT * FROM brands WHERE is_default=1').get()); }
export function upsertBrand({ id, name, vars, asset_id, is_default }) {
  const json = JSON.stringify(vars && typeof vars === 'object' ? vars : {});
  let bid = id;
  if (id) {
    const cur = db.prepare('SELECT * FROM brands WHERE id=?').get(id);
    if (!cur) return null;
    db.prepare('UPDATE brands SET name=?, vars=?, asset_id=? WHERE id=?').run(
      name ?? cur.name, vars !== undefined ? json : cur.vars,
      asset_id !== undefined ? (asset_id || null) : cur.asset_id, id);
  } else {
    const r = db.prepare(`INSERT INTO brands (name, vars, asset_id) VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET vars=excluded.vars, asset_id=excluded.asset_id`).run(name, json, asset_id || null);
    bid = r.lastInsertRowid || db.prepare('SELECT id FROM brands WHERE name=?').get(name).id;
  }
  if (is_default) setDefaultBrand(bid);
  return getBrand(bid);
}
export function setDefaultBrand(id) {
  db.prepare('UPDATE brands SET is_default = CASE WHEN id=? THEN 1 ELSE 0 END').run(id);
  return getBrand(id);
}
export function deleteBrand(id) { return db.prepare('DELETE FROM brands WHERE id=?').run(id).changes > 0; }
// Marken-Variablen inkl. brand_logo-URL (falls Logo gesetzt) – für apply-brand & Default-Vererbung.
export function brandVars(brand) {
  if (!brand) return {};
  // Palette zuletzt: leer gelassene Farb-Slots kommen so abgeleitet statt leer an.
  const v = { ...(brand.vars || {}), ...brandPalette(brand.vars) };
  if (brand.asset_id) v.brand_logo = `/api/assets/${brand.asset_id}/file`;
  return v;
}

// ---- Einstellungen (key/value, JSON-Werte) --------------------------------
db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');
export function getAllSettings() {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) {
    try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
  }
  return out;
}
export function setSettings(obj = {}) {
  const stmt = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  for (const [k, v] of Object.entries(obj)) stmt.run(k, JSON.stringify(v ?? null));
  return getAllSettings();
}

// ---- Externe HTTP-API ----------------------------------------------------
export function getApiRequest(key) {
  const row = db.prepare('SELECT * FROM api_requests WHERE idempotency_key=?').get(key);
  if (!row) return null;
  try { return { ...row, response: JSON.parse(row.response_json) }; }
  catch { return null; }
}
export function saveApiRequest(key, requestHash, response) {
  db.prepare('INSERT INTO api_requests (idempotency_key, request_hash, response_json) VALUES (?, ?, ?)')
    .run(key, requestHash, JSON.stringify(response));
  return getApiRequest(key);
}

// ---- Assets (Medien-Bibliothek: Logos/Bilder) -----------------------------
const ASSET_DIR = path.join(DATA_DIR, 'assets');
fs.mkdirSync(ASSET_DIR, { recursive: true });
db.exec(`CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  mimetype TEXT NOT NULL,
  size INTEGER,
  stored_path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
const ASSET_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']);
export function addAsset({ filename, mimetype, base64 }) {
  if (!ASSET_TYPES.has(mimetype)) throw new Error('Nur Bilder erlaubt (png, jpeg, gif, webp, svg)');
  const buf = Buffer.from(base64, 'base64');
  const safe = String(filename || 'bild').replace(/[^\w.\-]+/g, '_').slice(0, 120);
  const stored = path.join(ASSET_DIR, `${Date.now()}_${safe}`);
  fs.writeFileSync(stored, buf);
  const r = db.prepare('INSERT INTO assets (filename, mimetype, size, stored_path) VALUES (?, ?, ?, ?)')
    .run(filename || safe, mimetype, buf.length, stored);
  return getAsset(r.lastInsertRowid);
}
export function getAsset(id) {
  return db.prepare('SELECT * FROM assets WHERE id=?').get(id);
}
export function listAssets() {
  return db.prepare('SELECT id, filename, mimetype, size, created_at FROM assets ORDER BY id DESC').all();
}
export function deleteAsset(id) {
  const a = getAsset(id);
  if (!a) return false;
  try { fs.unlinkSync(a.stored_path); } catch { /* egal */ }
  return db.prepare('DELETE FROM assets WHERE id=?').run(id).changes > 0;
}

// ---- Posteingang (empfangene Mails) --------------------------------------
// Fügt eine Mail ein; existiert die UID im Ordner bereits, passiert nichts
// (idempotenter Sync). Gibt true zurück, wenn eine neue Zeile angelegt wurde.
export function insertMessage(m) {
  const r = db.prepare(`INSERT OR IGNORE INTO messages
    (account_id, folder, uid, message_id, from_name, from_email, to_text, subject, date, snippet, text, html, seen, flagged)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    m.account_id, m.folder || 'INBOX', m.uid, m.message_id ?? null,
    m.from_name ?? null, m.from_email ?? null, m.to_text ?? null,
    m.subject ?? null, m.date ?? null, m.snippet ?? null,
    m.text ?? null, m.html ?? null, m.seen ? 1 : 0, m.flagged ? 1 : 0);
  return r.changes > 0;
}
// Höchste bereits gespeicherte UID eines Ordners (für inkrementellen Abruf).
export function maxMessageUid(accountId, folder = 'INBOX') {
  const r = db.prepare('SELECT MAX(uid) m FROM messages WHERE account_id=? AND folder=?').get(accountId, folder);
  return r?.m || 0;
}
// Liste ohne die schweren Felder (text/html) — für die Übersicht.
export function listMessages({ accountId = null, folder = 'INBOX', limit = 100 } = {}) {
  const cols = 'id, account_id, folder, uid, message_id, from_name, from_email, to_text, subject, date, snippet, seen, flagged, created_at';
  const rows = accountId && folder
    ? db.prepare(`SELECT ${cols} FROM messages WHERE account_id=? AND folder=? ORDER BY COALESCE(date, created_at) DESC LIMIT ?`).all(accountId, folder, limit)
    : accountId
      ? db.prepare(`SELECT ${cols} FROM messages WHERE account_id=? ORDER BY COALESCE(date, created_at) DESC LIMIT ?`).all(accountId, limit)
      : folder
        ? db.prepare(`SELECT ${cols} FROM messages WHERE folder=? ORDER BY COALESCE(date, created_at) DESC LIMIT ?`).all(folder, limit)
        : db.prepare(`SELECT ${cols} FROM messages ORDER BY COALESCE(date, created_at) DESC LIMIT ?`).all(limit);
  return rows;
}
export function listMessageFolders(accountId = null) {
  return accountId
    ? db.prepare(`SELECT folder, COUNT(*) count, SUM(CASE WHEN seen=0 THEN 1 ELSE 0 END) unread
        FROM messages WHERE account_id=? GROUP BY folder ORDER BY folder`).all(accountId)
    : db.prepare(`SELECT folder, COUNT(*) count, SUM(CASE WHEN seen=0 THEN 1 ELSE 0 END) unread
        FROM messages GROUP BY folder ORDER BY folder`).all();
}
export function getMessage(id) {
  return db.prepare('SELECT * FROM messages WHERE id=?').get(id);
}
export function setMessageSeen(id, seen = true) {
  return db.prepare('UPDATE messages SET seen=? WHERE id=?').run(seen ? 1 : 0, id).changes > 0;
}
export function setMessageFlagged(id, flagged = true) {
  return db.prepare('UPDATE messages SET flagged=? WHERE id=?').run(flagged ? 1 : 0, id).changes > 0;
}
export function deleteMessage(id) {
  return db.prepare('DELETE FROM messages WHERE id=?').run(id).changes > 0;
}
export function unreadCount(accountId = null, folder = 'INBOX') {
  const r = accountId
    ? db.prepare('SELECT COUNT(*) n FROM messages WHERE account_id=? AND folder=? AND seen=0').get(accountId, folder)
    : db.prepare('SELECT COUNT(*) n FROM messages WHERE seen=0').get();
  return r.n;
}

// ---- Send events (Audit-Trail) --------------------------------------------
export function logSendEvent(e) {
  db.prepare(`INSERT INTO send_events (draft_id, draft_subject, account_email, email, name, kind, status, error, message_id, attempt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    e.draft_id ?? null, e.draft_subject ?? null, e.account_email ?? null,
    e.email, e.name ?? null, e.kind ?? 'to', e.status, e.error ?? null,
    e.message_id ?? null, e.attempt ?? 'send');
}
export function listSendEvents({ draftId = null, limit = 200 } = {}) {
  return draftId
    ? db.prepare('SELECT * FROM send_events WHERE draft_id=? ORDER BY id DESC LIMIT ?').all(draftId, limit)
    : db.prepare('SELECT * FROM send_events ORDER BY id DESC LIMIT ?').all(limit);
}
export function hasSuccessfulTestSend(draftId) {
  return !!db.prepare(`SELECT 1 FROM send_events
    WHERE draft_id=? AND attempt='test' AND status='sent'
      AND created_at >= (SELECT updated_at FROM drafts WHERE id=?)
    LIMIT 1`).get(draftId, draftId);
}

// ---- Seeding --------------------------------------------------------------
// Reads accounts from a JSON file (default: backend/accounts.seed.json, see paths.js)
// and inserts any that don't exist yet (matched by name). Existing accounts —
// including ones edited in the UI — are never overwritten.
// NOTE: uses console.error (not console.log) so it never corrupts MCP stdio.
export function seedAccounts(file = ACCOUNTS_SEED_FILE) {
  if (!fs.existsSync(file)) return { added: 0, skipped: 0 };
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`[seed] ${path.basename(file)} ist kein gültiges JSON: ${e.message}`);
    return { added: 0, skipped: 0 };
  }
  if (!Array.isArray(entries)) entries = entries.accounts || [];
  let added = 0, skipped = 0;
  for (const a of entries) {
    if (!a || !a.name || !a.host || !a.username || !a.from_email) {
      console.error('[seed] Eintrag übersprungen (name/host/username/from_email erforderlich):', JSON.stringify(a));
      continue;
    }
    if (getAccountByName(a.name)) { skipped++; continue; }
    createAccount(a);
    added++;
    console.error(`[seed] Account angelegt: ${a.name} <${a.from_email}>`);
  }
  if (added || skipped) console.error(`[seed] fertig — ${added} neu, ${skipped} bereits vorhanden`);
  return { added, skipped };
}

seedAccounts();

// ---- Generische Start-Vorlagen (Vorlagen-Center) --------------------------
// Legt beispielhafte Header-/Body-/Footer-/Vollvorlagen an, die noch nicht
// existieren (Abgleich per Name). Idempotent; überschreibt Eigenes nie.
const STARTER_TEMPLATES = [
  // --- Vollständige Mails (Betreff + Body) ---
  { name: 'Vollmail · Willkommen', kind: 'full', subject: 'Willkommen bei {{firma}}, {{name}}!', html:
`<div style="max-width:600px;margin:0 auto;font-family:Arial,sans-serif;color:#222;font-size:15px;line-height:1.6">
  <div style="background:#4f8cff;padding:20px 24px;color:#fff;font-size:20px;font-weight:bold">{{firma}}</div>
  <div style="padding:24px">
    <p>Hallo {{name}},</p>
    <p>schön, dass Sie dabei sind! Hier sind Ihre nächsten Schritte …</p>
    <p style="margin:20px 0"><a href="#" style="background:#4f8cff;color:#fff;padding:11px 20px;border-radius:6px;text-decoration:none;display:inline-block">Loslegen</a></p>
    <p>Beste Grüße<br>{{firma}}</p>
  </div>
  <div style="padding:16px 24px;border-top:1px solid #eee;color:#888;font-size:12px">Sie erhalten diese Mail an {{email}} · <a href="#" style="color:#888">Abmelden</a></div>
</div>` },
  { name: 'Vollmail · Newsletter', kind: 'full', subject: '{{firma}} · Neuigkeiten', html:
`<div style="max-width:600px;margin:0 auto;font-family:Arial,sans-serif;color:#222;font-size:15px;line-height:1.6">
  <div style="padding:24px;text-align:center;border-bottom:2px solid #eee"><span style="font-size:22px;font-weight:bold">{{firma}}</span></div>
  <div style="padding:24px">
    <h1 style="font-size:20px;margin:0 0 12px">Das gibt es Neues</h1>
    <p>Hallo {{name}}, hier die aktuellen Themen …</p>
    <p style="margin:20px 0"><a href="#" style="background:#4f8cff;color:#fff;padding:11px 20px;border-radius:6px;text-decoration:none;display:inline-block">Mehr erfahren</a></p>
  </div>
  <div style="padding:16px 24px;border-top:1px solid #eee;color:#888;font-size:12px">{{firma}} · {{email}} · <a href="#" style="color:#888">Abmelden</a></div>
</div>` },
  { name: 'Vollmail · Angebot', kind: 'full', subject: 'Ihr Angebot: {{angebot}}', html:
`<div style="max-width:600px;margin:0 auto;font-family:Arial,sans-serif;color:#222;font-size:15px;line-height:1.6">
  <div style="padding:24px">
    <p>Hallo {{name}},</p>
    <p>Ihr persönliches Angebot: <strong>{{angebot}}</strong></p>
    <p>Ihr Rabatt: <strong>{{rabatt}}</strong> — gültig bis {{datum}}.</p>
    <p style="margin:20px 0"><a href="#" style="background:#3ecf8e;color:#06251a;padding:11px 20px;border-radius:6px;text-decoration:none;display:inline-block;font-weight:bold">Angebot sichern</a></p>
  </div>
  <div style="padding:16px 24px;border-top:1px solid #eee;color:#888;font-size:12px">{{firma}} · {{email}}</div>
</div>` },
  // --- Header ---
  { name: 'Header · Farbbanner', kind: 'header', html:
`<div style="background:#4f8cff;padding:20px 24px;font-family:Arial,sans-serif">
  <span style="color:#fff;font-size:20px;font-weight:bold">{{firma}}</span>
</div>` },
  { name: 'Header · Schlicht', kind: 'header', html:
`<div style="padding:20px 24px;border-bottom:2px solid #eee;font-family:Arial,sans-serif">
  <span style="font-size:18px;font-weight:bold;color:#111">{{firma}}</span>
</div>` },
  { name: 'Header · Zentriert', kind: 'header', html:
`<div style="text-align:center;padding:24px;font-family:Arial,sans-serif">
  <div style="font-size:22px;font-weight:bold;color:#111">{{firma}}</div>
  <div style="color:#888;font-size:12px;margin-top:4px">Newsletter</div>
</div>` },
  // --- Body ---
  { name: 'Body · Anschreiben', kind: 'body', html:
`<div style="padding:24px;font-family:Arial,sans-serif;color:#222;font-size:15px;line-height:1.6">
  <p>Hallo {{name}},</p>
  <p>vielen Dank für Ihr Interesse. Hier steht Ihr persönlicher Text …</p>
  <p>Beste Grüße<br>{{firma}}</p>
</div>` },
  { name: 'Body · Newsletter', kind: 'body', html:
`<div style="padding:24px;font-family:Arial,sans-serif;color:#222;font-size:15px;line-height:1.6">
  <h1 style="font-size:20px;color:#111;margin:0 0 12px">Neuigkeiten</h1>
  <p>Hallo {{name}}, das gibt es Neues …</p>
  <p style="margin:20px 0">
    <a href="#" style="background:#4f8cff;color:#fff;padding:11px 20px;border-radius:6px;text-decoration:none;display:inline-block">Mehr erfahren</a>
  </p>
</div>` },
  { name: 'Body · Angebot', kind: 'body', html:
`<div style="padding:24px;font-family:Arial,sans-serif;color:#222;font-size:15px;line-height:1.6">
  <p>Hallo {{name}},</p>
  <p>Ihr persönliches Angebot: <strong>{{angebot}}</strong></p>
  <p>Ihr Rabatt: <strong>{{rabatt}}</strong> — gültig bis {{datum}}.</p>
</div>` },
  // --- Footer ---
  { name: 'Footer · Standard', kind: 'footer', html:
`<div style="padding:20px 24px;border-top:1px solid #eee;font-family:Arial,sans-serif;color:#888;font-size:12px">
  {{firma}} · Sie erhalten diese Mail an {{email}} · <a href="#" style="color:#888">Abmelden</a>
</div>` },
  { name: 'Footer · Kontakt', kind: 'footer', html:
`<div style="padding:20px 24px;border-top:1px solid #eee;font-family:Arial,sans-serif;color:#888;font-size:12px">
  <strong>{{firma}}</strong><br>Musterstraße 1, 12345 Musterstadt<br>Tel. 0123 456789 · info@example.com
</div>` },
  { name: 'Footer · Minimal', kind: 'footer', html:
`<div style="padding:16px 24px;text-align:center;font-family:Arial,sans-serif;color:#aaa;font-size:11px">
  © {{firma}} · <a href="#" style="color:#aaa">Abmelden</a>
</div>` },
];

const STARTER_CUSTOM_FIELDS = [
  { field_key: 'firma', label: 'Firma', default_value: '' },
  { field_key: 'angebot', label: 'Angebot', default_value: '' },
  { field_key: 'rabatt', label: 'Rabatt', default_value: '' },
  { field_key: 'datum', label: 'Datum', default_value: '' },
];

// Vorlagen + globale Custom-Felder aus content.seed.json laden (idempotent).
// Existiert die Datei nicht, wird sie aus den eingebauten Defaults erzeugt –
// danach ist sie die versionierbare Quelle, die man editieren/committen kann.
export function seedContent(file = CONTENT_SEED_FILE) {
  let content;
  if (fs.existsSync(file)) {
    try { content = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { console.error(`[seed] ${path.basename(file)} ungültig: ${e.message}`); return { templates: 0, customFields: 0 }; }
  } else {
    content = { templates: STARTER_TEMPLATES, customFields: STARTER_CUSTOM_FIELDS };
    try { fs.writeFileSync(file, JSON.stringify(content, null, 2)); console.error(`[seed] ${path.basename(file)} aus Defaults erstellt`); }
    catch { /* read-only fs ok */ }
  }
  let t = 0, f = 0;
  for (const tpl of content.templates || []) {
    if (!tpl?.name) continue;
    if (db.prepare('SELECT 1 FROM templates WHERE name=?').get(tpl.name)) continue; // Eigenes nie überschreiben
    createTemplate(tpl); t++;
  }
  for (const cf of content.customFields || []) {
    if (!cf?.field_key) continue;
    upsertCustomField(cf); f++; // Custom-Felder per Schlüssel aktualisieren
  }
  if (t || f) console.error(`[seed] Inhalte: ${t} Vorlagen, ${f} Custom-Felder`);
  return { templates: t, customFields: f };
}

// Aktuellen Stand (Vorlagen + Custom-Felder) nach content.seed.json schreiben – zum Versionieren.
export function exportContent(file = CONTENT_SEED_FILE) {
  const templates = listTemplates().map(t => ({ name: t.name, kind: t.kind, subject: t.subject, html: t.html }));
  const customFields = listCustomFields().map(f => ({ field_key: f.field_key, label: f.label, default_value: f.default_value }));
  fs.writeFileSync(file, JSON.stringify({ templates, customFields }, null, 2));
  return { file, templates: templates.length, customFields: customFields.length };
}

// Für den Export-Endpoint (ohne auf Platte zu schreiben).
export function contentSnapshot() {
  return {
    templates: listTemplates().map(t => ({ name: t.name, kind: t.kind, subject: t.subject, html: t.html })),
    customFields: listCustomFields().map(f => ({ field_key: f.field_key, label: f.label, default_value: f.default_value })),
  };
}

seedContent();

// ---- Marken-Seed: brand_color-Feld, themebare Vorlagen, Presets -----------
const BRAND_TEMPLATES = [
  { name: 'Marke · Willkommen', kind: 'full', subject: 'Willkommen bei {{firma}}, {{name}}', html:
`<div style="background:#f4f5f7;padding:24px 0;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif"><div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
  <div style="background:{{brand_color}};padding:22px 28px"><span style="color:#fff;font-size:19px;font-weight:700">{{firma}}</span></div>
  <div style="padding:32px 28px;color:#1a1a1a;font-size:15px;line-height:1.65">
    <h1 style="margin:0 0 10px;font-size:23px;color:#0f172a">Willkommen, {{name}}!</h1>
    <p style="margin:0 0 22px;color:#475569">Schön, dass Sie bei {{firma}} sind. Legen Sie direkt los:</p>
    <p style="margin:0 0 24px"><a href="{{link}}" style="display:inline-block;background:{{brand_color}};color:#fff;text-decoration:none;padding:12px 26px;border-radius:8px;font-weight:600">Loslegen</a></p>
    <p style="margin:0;color:#64748b;font-size:13px">Herzlich,<br>{{ansprechpartner}}</p>
  </div>
  <div style="padding:20px 28px;background:#f9fafb;border-top:1px solid #e5e7eb;color:#94a3b8;font-size:12px">{{firma}} · {{website}}</div>
</div></div>` },
  { name: 'Marke · Newsletter', kind: 'full', subject: '{{firma}} · Neues für {{name}}', html:
`<div style="background:#f4f5f7;padding:24px 0;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif"><div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
  <div style="padding:24px 28px;border-bottom:3px solid {{brand_color}}"><span style="font-size:20px;font-weight:700;color:#0f172a">{{firma}}</span></div>
  <div style="padding:32px 28px;color:#1a1a1a;font-size:15px;line-height:1.65">
    <h1 style="margin:0 0 8px;font-size:22px;color:#0f172a">Das gibt es Neues</h1>
    <p style="margin:0 0 22px;color:#475569">Hallo {{name}}, hier die aktuellen Themen von {{firma}}.</p>
    <p style="margin:0 0 8px"><a href="{{link}}" style="display:inline-block;background:{{brand_color}};color:#fff;text-decoration:none;padding:12px 26px;border-radius:8px;font-weight:600">Mehr erfahren</a></p>
  </div>
  <div style="padding:20px 28px;background:#f9fafb;border-top:1px solid #e5e7eb;color:#94a3b8;font-size:12px">{{firma}} · {{website}}</div>
</div></div>` },
  { name: 'Marke · Einladung', kind: 'full', subject: 'Einladung: {{anlass}} am {{datum}}', html:
`<div style="background:#f4f5f7;padding:24px 0;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif"><div style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
  <div style="background:{{brand_color}};padding:34px 28px;text-align:center"><div style="color:rgba(255,255,255,.85);font-size:12px;text-transform:uppercase;letter-spacing:2px">Sie sind eingeladen</div><div style="color:#fff;font-size:25px;font-weight:800;margin-top:6px">{{anlass}}</div></div>
  <div style="padding:32px 28px;color:#1a1a1a;font-size:15px;line-height:1.65">
    <p style="margin:0 0 18px;color:#0f172a">Hallo {{name}},</p>
    <p style="margin:0 0 20px;color:#475569">{{firma}} lädt Sie herzlich ein:</p>
    <table style="width:100%;border-collapse:collapse;margin:0 0 24px">
      <tr><td style="padding:8px 0;color:#6b7280;width:90px">Datum</td><td style="padding:8px 0;color:#0f172a;font-weight:600">{{datum}}</td></tr>
      <tr><td style="padding:8px 0;color:#6b7280">Uhrzeit</td><td style="padding:8px 0;color:#0f172a;font-weight:600">{{uhrzeit}}</td></tr>
      <tr><td style="padding:8px 0;color:#6b7280">Ort</td><td style="padding:8px 0;color:#0f172a;font-weight:600">{{ort}}</td></tr>
    </table>
    <p style="margin:0;text-align:center"><a href="{{link}}" style="display:inline-block;background:{{brand_color}};color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600">Jetzt zusagen</a></p>
  </div>
  <div style="padding:20px 28px;background:#f9fafb;border-top:1px solid #e5e7eb;color:#94a3b8;font-size:12px">{{firma}} · {{website}}</div>
</div></div>` },
  { name: 'Marke · Palette', kind: 'full', subject: '{{firma}}: {{anlass}}', html:
`<div style="background:{{brand_bg}};padding:24px 0;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif"><div style="max-width:600px;margin:0 auto;background:{{brand_surface}};border-radius:12px;overflow:hidden;border:1px solid {{brand_border}}">
  <div style="background:{{brand_color}};background-image:{{brand_gradient}};padding:30px 28px">
    <div style="color:{{brand_on_color}};opacity:.8;font-size:12px;text-transform:uppercase;letter-spacing:2px">{{firma}}</div>
    <div style="color:{{brand_on_color}};font-size:24px;font-weight:800;margin-top:6px">{{anlass}}</div>
  </div>
  <div style="padding:30px 28px;color:{{brand_text}};font-size:15px;line-height:1.65">
    <p style="margin:0 0 16px">Hallo {{name}},</p>
    <p style="margin:0 0 22px;color:{{brand_muted}}">kurz und knapp: das Wichtigste von {{firma}} für Sie.</p>
    <div style="background:{{brand_soft}};border-left:4px solid {{brand_accent}};border-radius:8px;padding:14px 16px;margin:0 0 24px">
      <span style="display:inline-block;background:{{brand_accent}};color:{{brand_on_accent}};border-radius:99px;padding:2px 10px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px">Neu</span>
      <div style="margin-top:8px;color:{{brand_text}}">{{angebot}}</div>
    </div>
    <p style="margin:0 0 26px"><a class="sm-block" href="{{link}}" style="display:inline-block;background:{{brand_color}};color:{{brand_on_color}};text-decoration:none;padding:12px 26px;border-radius:8px;font-weight:600">Jetzt ansehen</a></p>
    <p style="margin:0;color:{{brand_muted}};font-size:13px">Herzlich,<br>{{ansprechpartner}}</p>
  </div>
  <div style="padding:18px 28px;background:{{brand_color_2}};color:{{brand_on_color_2}};font-size:12px">{{firma}} · {{website}}</div>
</div></div>` },
];
const BRAND_PRESETS = [
  { name: 'Standard', vars: { firma: 'Ihre Firma', brand_color: '#4f8cff', website: 'example.com', ansprechpartner: '' } },
  { name: 'Erohub', vars: { firma: 'Erohub', brand_color: '#6366f1', brand_color_2: '#4338ca', brand_accent: '#f59e0b', website: 'erohub.app', ansprechpartner: 'Tobias Ludwig' } },
  { name: 'DBFV NRW', vars: { firma: 'DBFV NRW', brand_color: '#d32f2f', brand_color_2: '#7f1d1d', brand_accent: '#facc15', brand_text: '#111827', website: 'nrw-meisterschaft.de', ansprechpartner: 'DBFV NRW', anlass: 'NRW-Meisterschaft' } },
];
export function seedBrands() {
  // Palette als Custom-Felder: so haben Vorschau und Versand auch ohne
  // angewendete Marke gültige Farbwerte statt sichtbarer {{platzhalter}}.
  const fallback = brandPalette({});
  for (const f of [...BRAND_PALETTE, ...BRAND_PALETTE_DERIVED]) {
    upsertCustomField({ field_key: f.key, label: f.label, default_value: fallback[f.key] });
  }
  let tpl = 0, br = 0;
  for (const t of BRAND_TEMPLATES) {
    if (db.prepare('SELECT 1 FROM templates WHERE name=?').get(t.name)) continue;
    createTemplate(t); tpl++;
  }
  for (const b of BRAND_PRESETS) {
    if (db.prepare('SELECT 1 FROM brands WHERE name=?').get(b.name)) continue;
    upsertBrand(b); br++;
  }
  if (tpl || br) console.error(`[seed] Marken: ${tpl} Vorlagen, ${br} Presets`);
  return { templates: tpl, brands: br };
}
seedBrands();

// ---- GitHub: Verbindungen & Repos an Kontakten ----------------------------
// Das Token wird wie SMTP-Passwörter verschlüsselt (token_enc) und NIE ausgeliefert.
// Bewusst eine eigene Tabelle statt eines settings-Schlüssels: getAllSettings()
// gibt alles unmaskiert zurück und hängt am MCP-Tool get_settings.
db.exec(`
CREATE TABLE IF NOT EXISTS github_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,                                       -- "Privat", "Arbeit"
  token_enc TEXT,                                           -- AES-256-GCM, siehe encrypt()
  login TEXT,                                               -- GitHub-Benutzername, beim Testen gefüllt
  scopes TEXT,                                              -- x-oauth-scopes (nur klassische PATs)
  token_type TEXT,                                          -- classic | fine_grained
  api_base TEXT NOT NULL DEFAULT 'https://api.github.com',  -- für GitHub Enterprise
  is_default INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Repos, die einem Kontakt zugeordnet sind. Identität ist die numerische GitHub-ID
-- (überlebt Umbenennen und Transfer); owner/name sind nur Anzeige-Cache.
CREATE TABLE IF NOT EXISTS contact_repos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  connection_id INTEGER REFERENCES github_connections(id) ON DELETE SET NULL,
  repo_id INTEGER,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  private INTEGER NOT NULL DEFAULT 0,
  default_branch TEXT,
  description TEXT,
  html_url TEXT,
  role TEXT,                 -- freie Notiz: "Kundenprojekt", "Fork" …
  pushed_at TEXT,
  synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(contact_id, full_name)
);
CREATE INDEX IF NOT EXISTS idx_contact_repos_contact ON contact_repos(contact_id);
`);

for (const [table, col, def] of [
  ['github_connections', 'token_type', 'TEXT'],
  ['contact_repos', 'role', 'TEXT'],
]) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
  catch { /* Spalte existiert schon */ }
}

const GIT_PUBLIC_COLS = 'id, name, login, scopes, token_type, api_base, is_default, verified_at, last_error, created_at';

/** Verbindungen ohne Token – has_token statt Chiffrat (wie getAccountPublic). */
export function listGithubConnections() {
  return db.prepare(
    `SELECT ${GIT_PUBLIC_COLS}, token_enc IS NOT NULL AND token_enc <> '' AS has_token
     FROM github_connections ORDER BY is_default DESC, name`).all();
}
/** Rohzeile inkl. token_enc – nur für den internen Gebrauch. */
export function getGithubConnection(id) {
  return db.prepare('SELECT * FROM github_connections WHERE id=?').get(id);
}
export function getGithubConnectionPublic(id) {
  const c = getGithubConnection(id);
  if (!c) return null;
  const { token_enc, ...pub } = c;
  return { ...pub, has_token: !!token_enc };
}
/** Entschlüsselt das Token. Einziger Ort, an dem das passiert (wie getImapCreds). */
export function getGithubToken(connection) {
  const c = typeof connection === 'object' ? connection : getGithubConnection(connection);
  if (!c) throw new Error('GitHub-Verbindung nicht gefunden');
  if (!c.token_enc) throw new Error(`GitHub-Verbindung "${c.name}" hat kein Token`);
  return { token: decrypt(c.token_enc), apiBase: c.api_base || 'https://api.github.com' };
}
export function createGithubConnection(c = {}) {
  const r = db.prepare(
    `INSERT INTO github_connections (name, token_enc, api_base, is_default)
     VALUES (?, ?, ?, ?)`)
    .run(String(c.name || 'GitHub'), encrypt(c.token), c.api_base || 'https://api.github.com',
      c.is_default ? 1 : 0);
  if (c.is_default) setDefaultGithubConnection(r.lastInsertRowid);
  return getGithubConnectionPublic(r.lastInsertRowid);
}
export function updateGithubConnection(id, c = {}) {
  const cur = getGithubConnection(id);
  if (!cur) return null;
  // Leeres Token heißt "unverändert", nie "löschen" (Hausregel aus updateAccount).
  db.prepare(
    `UPDATE github_connections SET name=?, token_enc=?, api_base=? WHERE id=?`)
    .run(c.name ?? cur.name, c.token ? encrypt(c.token) : cur.token_enc,
      c.api_base ?? cur.api_base, id);
  if (c.is_default) setDefaultGithubConnection(id);
  return getGithubConnectionPublic(id);
}
export function deleteGithubConnection(id) {
  return db.prepare('DELETE FROM github_connections WHERE id=?').run(id).changes > 0;
}
export function setDefaultGithubConnection(id) {
  db.prepare('UPDATE github_connections SET is_default = CASE WHEN id=? THEN 1 ELSE 0 END').run(id);
  return listGithubConnections();
}
export function getDefaultGithubConnection() {
  return db.prepare('SELECT * FROM github_connections ORDER BY is_default DESC, id LIMIT 1').get();
}
/** Nach erfolgreichem Test: Login/Scopes festhalten, alten Fehler löschen. */
export function markGithubVerified(id, { login, scopes, token_type } = {}) {
  db.prepare(
    `UPDATE github_connections
     SET login=?, scopes=?, token_type=?, verified_at=datetime('now'), last_error=NULL WHERE id=?`)
    .run(login || null, Array.isArray(scopes) ? scopes.join(',') : (scopes || null),
      token_type || null, id);
  return getGithubConnectionPublic(id);
}
export function markGithubError(id, message) {
  db.prepare('UPDATE github_connections SET last_error=? WHERE id=?').run(String(message || ''), id);
  return getGithubConnectionPublic(id);
}

/** Verknüpfte Repos. contactId weglassen = alle (für MCP). */
export function listContactRepos(contactId = null) {
  const sql = `SELECT r.*, c.name AS contact_name, c.email AS contact_email
               FROM contact_repos r JOIN contacts c ON c.id = r.contact_id`;
  return contactId == null
    ? db.prepare(`${sql} ORDER BY c.name, r.full_name`).all()
    : db.prepare(`${sql} WHERE r.contact_id=? ORDER BY r.full_name`).all(contactId);
}
export function getContactRepo(id) {
  return db.prepare(
    `SELECT r.*, c.name AS contact_name, c.email AS contact_email
     FROM contact_repos r JOIN contacts c ON c.id = r.contact_id WHERE r.id=?`).get(id);
}
export function addContactRepo(contactId, r = {}) {
  const res = db.prepare(
    `INSERT INTO contact_repos
       (contact_id, connection_id, repo_id, owner, name, full_name, private,
        default_branch, description, html_url, role, pushed_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(contact_id, full_name) DO UPDATE SET
       repo_id=excluded.repo_id, private=excluded.private,
       default_branch=excluded.default_branch, description=excluded.description,
       html_url=excluded.html_url, pushed_at=excluded.pushed_at, synced_at=datetime('now')`)
    .run(contactId, r.connection_id ?? null, r.repo_id ?? null, r.owner, r.name, r.full_name,
      r.private ? 1 : 0, r.default_branch ?? null, r.description ?? null, r.html_url ?? null,
      r.role ?? null, r.pushed_at ?? null);
  return getContactRepo(res.lastInsertRowid) ||
    db.prepare('SELECT * FROM contact_repos WHERE contact_id=? AND full_name=?')
      .get(contactId, r.full_name);
}
export function updateContactRepo(id, { role } = {}) {
  const cur = getContactRepo(id);
  if (!cur) return null;
  db.prepare('UPDATE contact_repos SET role=? WHERE id=?').run(role ?? cur.role, id);
  return getContactRepo(id);
}
export function deleteContactRepo(id) {
  return db.prepare('DELETE FROM contact_repos WHERE id=?').run(id).changes > 0;
}
/** Metadaten nach Umbenennung/Refresh zurückschreiben. */
export function touchContactRepo(id, meta = {}) {
  const cur = getContactRepo(id);
  if (!cur) return null;
  db.prepare(
    `UPDATE contact_repos SET owner=?, name=?, full_name=?, private=?, default_branch=?,
       description=?, html_url=?, pushed_at=?, synced_at=datetime('now') WHERE id=?`)
    .run(meta.owner ?? cur.owner, meta.name ?? cur.name, meta.full_name ?? cur.full_name,
      meta.private != null ? (meta.private ? 1 : 0) : cur.private,
      meta.default_branch ?? cur.default_branch, meta.description ?? cur.description,
      meta.html_url ?? cur.html_url, meta.pushed_at ?? cur.pushed_at, id);
  return getContactRepo(id);
}

// ---- WhatsApp (Baileys) ---------------------------------------------------
// Der Socket lebt AUSSCHLIESSLICH im Web-Server-Prozess (src/whatsapp.js).
// Hier liegen nur die Daten – der MCP-Server liest sie direkt, schreibende
// WhatsApp-Aktionen laufen bei ihm über HTTP an den Web-Server.
db.exec(`
CREATE TABLE IF NOT EXISTS wa_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  jid TEXT,                                  -- eigene JID, nach dem Koppeln gesetzt
  phone TEXT,                                -- E.164 ohne '+', aus der JID abgeleitet
  push_name TEXT,
  status TEXT NOT NULL DEFAULT 'logged_out', -- logged_out|pairing|connecting|connected|conflict|banned
  last_error TEXT,
  autostart INTEGER NOT NULL DEFAULT 1,
  sync_full_history INTEGER NOT NULL DEFAULT 0,
  mcp_send_mode TEXT NOT NULL DEFAULT 'known', -- off | known (nur auf Eingang antworten) | all
  send_per_hour INTEGER NOT NULL DEFAULT 30,   -- harte Obergrenze, Schutz vor Nummernsperre
  history_done INTEGER NOT NULL DEFAULT 0,
  connected_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS wa_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_account_id INTEGER NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
  jid TEXT NOT NULL,
  phone TEXT,
  push_name TEXT,
  name TEXT,
  is_group INTEGER NOT NULL DEFAULT 0,
  -- Brücke ins Adressbuch. SET NULL, nicht CASCADE: einen Mail-Kontakt zu löschen
  -- darf niemals den WhatsApp-Verlauf mitreißen.
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(wa_account_id, jid)
);
CREATE INDEX IF NOT EXISTS idx_wa_contacts_contact ON wa_contacts(contact_id);
CREATE INDEX IF NOT EXISTS idx_wa_contacts_phone ON wa_contacts(phone);

CREATE TABLE IF NOT EXISTS wa_chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_account_id INTEGER NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
  jid TEXT NOT NULL,
  name TEXT,
  is_group INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  last_message_ts INTEGER,                   -- Unix-Sekunden, Sortierschlüssel
  last_snippet TEXT,
  oldest_synced_ts INTEGER,                  -- Wasserstand nach unten (Nachladen)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(wa_account_id, jid)
);
CREATE INDEX IF NOT EXISTS idx_wa_chats_account ON wa_chats(wa_account_id, last_message_ts);

CREATE TABLE IF NOT EXISTS wa_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_account_id INTEGER NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
  chat_id INTEGER NOT NULL REFERENCES wa_chats(id) ON DELETE CASCADE,
  wa_id TEXT NOT NULL,                       -- key.id
  chat_jid TEXT NOT NULL,
  sender_jid TEXT,                           -- key.participant bei Gruppen
  sender_name TEXT,
  from_me INTEGER NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL,                       -- Unix-Sekunden
  type TEXT NOT NULL DEFAULT 'text',
  body TEXT,
  snippet TEXT,                              -- Kurzform für Listen (body bleibt draußen)
  quoted_wa_id TEXT,
  media_mime TEXT,
  media_size INTEGER,
  media_filename TEXT,
  stored_path TEXT,                          -- NULL = noch nicht heruntergeladen
  status TEXT,                               -- nur from_me: pending|sent|delivered|read|failed
  error TEXT,
  origin TEXT,                               -- nur from_me: ui|mcp – das ist der Audit-Trail
  raw TEXT,                                  -- proto-JSON, NUR bei from_me (für Zustell-Wiederholungen)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(wa_account_id, chat_jid, wa_id)
);
CREATE INDEX IF NOT EXISTS idx_wa_messages_chat ON wa_messages(chat_id, ts);
CREATE INDEX IF NOT EXISTS idx_wa_messages_account_ts ON wa_messages(wa_account_id, ts);
`);

for (const [table, col, def] of [
  ['wa_accounts', 'mcp_send_mode', "TEXT NOT NULL DEFAULT 'known'"],
  ['wa_messages', 'origin', 'TEXT'],
  // Gruppen: Betreff kommt nicht mit der Nachricht, sondern muss einmal
  // abgefragt werden. Teilnehmer als JSON, damit das Adressbuch nicht mit
  // hunderten Gruppenmitgliedern zuläuft.
  // Medien-Einstellungen je Konto (vorher fest über Umgebungsvariablen).
  // media_download: off | images | images_audio | all   ·   media_keep_days: 0 = unbegrenzt
  ['wa_accounts', 'media_download', "TEXT NOT NULL DEFAULT 'images_audio'"],
  ['wa_accounts', 'media_max_mb', 'INTEGER NOT NULL DEFAULT 5'],
  ['wa_accounts', 'media_keep_days', 'INTEGER NOT NULL DEFAULT 0'],
  ['wa_chats', 'participants', 'TEXT'],
  ['wa_chats', 'participant_count', 'INTEGER'],
  ['wa_chats', 'meta_synced_at', 'TEXT'],
]) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
  catch { /* Spalte existiert schon */ }
}

/**
 * contacts.email von NOT NULL auf optional umstellen.
 *
 * Ursprünglich war die Mailadresse der Schlüssel des Adressbuchs. Seit WhatsApp
 * dazugekommen ist, stimmt das nicht mehr: Wer nur eine Nummer hat, hat keine
 * Adresse – und eine erfundene würde irgendwann in einem echten Serienversand
 * landen. SQLite kann NOT NULL nicht per ALTER entfernen, deshalb der
 * dokumentierte Umbau über eine Schattentabelle.
 *
 * Läuft genau einmal: danach steht kein NOT NULL mehr in der Definition.
 */
function migrateContactsEmailOptional() {
  const def = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='contacts'").get();
  if (!def || !/email TEXT NOT NULL UNIQUE/.test(def.sql)) return;

  const cols = db.prepare('PRAGMA table_info(contacts)').all().map(c => c.name);
  const list = cols.join(', ');

  // Fremdschlüssel MÜSSEN aus sein: fünf Tabellen zeigen auf contacts(id), und
  // DROP TABLE würde sie sonst mit ON DELETE CASCADE leerräumen.
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE contacts_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE,
      name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      company TEXT, phone TEXT, notes TEXT, vars TEXT,
      style_id INTEGER REFERENCES writing_styles(id) ON DELETE SET NULL
    )`);
    db.exec(`INSERT INTO contacts_new (${list}) SELECT ${list} FROM contacts`);
    db.exec('DROP TABLE contacts');
    db.exec('ALTER TABLE contacts_new RENAME TO contacts');
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* egal */ }
    db.exec('PRAGMA foreign_keys = ON');
    throw e;
  }
  db.exec('PRAGMA foreign_keys = ON');
  const check = db.prepare('PRAGMA foreign_key_check').all();
  console.error(`[migration] contacts.email ist jetzt optional`
    + (check.length ? ` – ACHTUNG: ${check.length} lose Verweise` : ''));
}
migrateContactsEmailOptional();

/**
 * Erste Transaktion im Projekt – bewusst nur für Massen-Inserts beim Verlaufs-Sync.
 * fn MUSS synchron sein: node:sqlite ist synchron, ein `await` im Rumpf würde die
 * Schreibsperre über die Event-Loop halten und den anderen Prozess blockieren.
 */
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch { /* egal */ } throw e; }
}

// Rückreparatur für Verknüpfungen aus älteren Versionen: nur leere Nummern
// ergänzen, niemals eine im Adressbuch gepflegte Telefonnummer überschreiben.
db.exec(`UPDATE contacts
  SET phone = (
    SELECT CASE WHEN substr(trim(w.phone), 1, 1)='+' THEN trim(w.phone) ELSE '+' || trim(w.phone) END
    FROM wa_contacts w
    WHERE w.contact_id=contacts.id AND trim(COALESCE(w.phone,''))<>''
    ORDER BY w.id LIMIT 1
  )
  WHERE trim(COALESCE(phone,''))=''
    AND EXISTS (
      SELECT 1 FROM wa_contacts w
      WHERE w.contact_id=contacts.id AND trim(COALESCE(w.phone,''))<>''
    )`);

const WA_ACCOUNT_COLS = `id, name, jid, phone, push_name, status, last_error, autostart,
  sync_full_history, mcp_send_mode, send_per_hour, history_done, connected_at, created_at,
  media_download, media_max_mb, media_keep_days`;

export function listWaAccounts() {
  return db.prepare(
    `SELECT ${WA_ACCOUNT_COLS},
       (SELECT COALESCE(SUM(unread),0) FROM wa_chats c WHERE c.wa_account_id = a.id) AS unread
     FROM wa_accounts a ORDER BY id`).all();
}
export function getWaAccount(id) {
  return db.prepare('SELECT * FROM wa_accounts WHERE id=?').get(id);
}
export function createWaAccount({ name } = {}) {
  const r = db.prepare('INSERT INTO wa_accounts (name) VALUES (?)').run(String(name || 'WhatsApp'));
  return getWaAccount(r.lastInsertRowid);
}
export function updateWaAccount(id, f = {}) {
  const cur = getWaAccount(id);
  if (!cur) return null;
  db.prepare(
    `UPDATE wa_accounts SET name=?, autostart=?, sync_full_history=?, mcp_send_mode=?, send_per_hour=?,
       media_download=?, media_max_mb=?, media_keep_days=?
     WHERE id=?`)
    .run(f.name ?? cur.name,
      f.autostart != null ? (f.autostart ? 1 : 0) : cur.autostart,
      f.sync_full_history != null ? (f.sync_full_history ? 1 : 0) : cur.sync_full_history,
      f.mcp_send_mode ?? cur.mcp_send_mode,
      f.send_per_hour != null ? Number(f.send_per_hour) : cur.send_per_hour,
      f.media_download ?? cur.media_download,
      f.media_max_mb != null ? Number(f.media_max_mb) : cur.media_max_mb,
      f.media_keep_days != null ? Number(f.media_keep_days) : cur.media_keep_days, id);
  return getWaAccount(id);
}
export function setWaAccountStatus(id, status, extra = {}) {
  const cur = getWaAccount(id);
  if (!cur) return null;
  // Auf VORHANDENSEIN des Schlüssels prüfen, nicht mit ?? auf den Wert:
  // Beim Zurücksetzen wird ausdrücklich null übergeben, um Nummer und Fehler zu
  // löschen. Mit `extra.phone ?? cur.phone` wäre genau das unmöglich – null gilt
  // dort als "nicht angegeben" und der alte Wert bliebe stehen.
  const pick = (key, fallback) => (key in extra ? extra[key] : fallback);
  db.prepare(
    `UPDATE wa_accounts SET status=?, last_error=?, jid=?, phone=?, push_name=?,
       connected_at=CASE WHEN ?='connected' THEN datetime('now') ELSE connected_at END
     WHERE id=?`)
    .run(status,
      pick('error', status === 'connected' ? null : cur.last_error),
      pick('jid', cur.jid), pick('phone', cur.phone), pick('push_name', cur.push_name),
      status, id);
  return getWaAccount(id);
}
export function setWaHistoryDone(id, done = true) {
  db.prepare('UPDATE wa_accounts SET history_done=? WHERE id=?').run(done ? 1 : 0, id);
}
export function deleteWaAccount(id) {
  return db.prepare('DELETE FROM wa_accounts WHERE id=?').run(id).changes > 0;
}

export function upsertWaChat(waAccountId, { jid, name, is_group, unread, archived, last_message_ts, last_snippet }) {
  // Zwei Schritte statt eines UPSERT mit COALESCE: unread und archived sind
  // NOT NULL. Ein einzelnes INSERT … ON CONFLICT müsste beim Anlegen NULL
  // binden, um beim Aktualisieren "nicht ändern" ausdrücken zu können – und
  // genau daran scheitert es. Anlegen mit Standardwerten, danach gezielt
  // aktualisieren, was der Aufrufer wirklich mitgegeben hat.
  db.prepare(
    `INSERT OR IGNORE INTO wa_chats (wa_account_id, jid, name, is_group, unread, archived)
     VALUES (?, ?, ?, ?, 0, 0)`)
    .run(waAccountId, jid, name ?? null, is_group ? 1 : 0);

  const sets = [];
  const args = [];
  if (name != null) { sets.push('name=?'); args.push(name); }
  if (is_group != null) { sets.push('is_group=?'); args.push(is_group ? 1 : 0); }
  if (unread != null) { sets.push('unread=?'); args.push(Number(unread) || 0); }
  if (archived != null) { sets.push('archived=?'); args.push(archived ? 1 : 0); }
  if (last_message_ts != null) {
    // Nie rückwärts laufen – der Verlaufs-Sync liefert auch ältere Nachrichten.
    sets.push('last_message_ts=MAX(COALESCE(last_message_ts,0), ?)');
    args.push(last_message_ts);
  }
  // Der Ausschnitt gehört zur jüngsten Nachricht, also nur mitziehen, wenn diese
  // auch die jüngste ist.
  if (last_snippet != null && last_message_ts != null) {
    sets.push('last_snippet=CASE WHEN COALESCE(last_message_ts,0) <= ? THEN ? ELSE last_snippet END');
    args.push(last_message_ts, last_snippet);
  } else if (last_snippet != null) {
    sets.push('last_snippet=?'); args.push(last_snippet);
  }

  if (sets.length) {
    args.push(waAccountId, jid);
    db.prepare(`UPDATE wa_chats SET ${sets.join(', ')} WHERE wa_account_id=? AND jid=?`).run(...args);
  }
  return getWaChatByJid(waAccountId, jid);
}
export function getWaChatByJid(waAccountId, jid) {
  return db.prepare('SELECT * FROM wa_chats WHERE wa_account_id=? AND jid=?').get(waAccountId, jid);
}
export function getWaChat(id) {
  return db.prepare(
    `SELECT c.*,
            COALESCE(NULLIF(c.name,''), NULLIF(wc.name,''), NULLIF(wc.push_name,''),
                     NULLIF(ct.name,''), wc.phone) AS name,
            wc.id AS wa_contact_id, wc.contact_id,
            ct.email AS contact_email, ct.name AS contact_name
     FROM wa_chats c
     LEFT JOIN wa_contacts wc ON wc.wa_account_id = c.wa_account_id AND wc.jid = c.jid
     LEFT JOIN contacts ct ON ct.id = wc.contact_id
     WHERE c.id=?`).get(id);
}
export function listWaChats({ waAccountId = null, query = null, archived = 0, limit = 50 } = {}) {
  const where = ['1=1'];
  const args = [];
  if (waAccountId) { where.push('c.wa_account_id=?'); args.push(waAccountId); }
  if (archived != null) { where.push('c.archived=?'); args.push(archived ? 1 : 0); }
  if (query) { where.push('(c.name LIKE ? OR c.jid LIKE ?)'); args.push(`%${query}%`, `%${query}%`); }
  args.push(limit);
  // Anzeigename in absteigender Güte: Chatname → Telefonbuchname → selbst
  // gesetzter Name des Gegenübers → verknüpfter Adressbuch-Kontakt → Nummer.
  // Ohne diese Kette steht in der Liste sonst eine nackte Kennung.
  return db.prepare(
    `SELECT c.id, c.wa_account_id, c.jid,
            COALESCE(NULLIF(c.name,''), NULLIF(wc.name,''), NULLIF(wc.push_name,''),
                     NULLIF(ct.name,''), wc.phone) AS name,
            c.is_group, c.unread, c.archived,
            c.last_message_ts, c.last_snippet, c.participant_count, wc.contact_id, ct.email AS contact_email
     FROM wa_chats c
     LEFT JOIN wa_contacts wc ON wc.wa_account_id = c.wa_account_id AND wc.jid = c.jid
     LEFT JOIN contacts ct ON ct.id = wc.contact_id
     WHERE ${where.join(' AND ')}
     ORDER BY COALESCE(c.last_message_ts, 0) DESC LIMIT ?`).all(...args);
}
/** Gruppen-Stammdaten (Betreff + Teilnehmer) festhalten. */
export function setWaGroupMeta(id, { name, participants }) {
  db.prepare(
    `UPDATE wa_chats SET name=COALESCE(?, name), participants=?, participant_count=?,
       meta_synced_at=datetime('now') WHERE id=?`)
    .run(name || null, participants ? JSON.stringify(participants) : null,
      Array.isArray(participants) ? participants.length : null, id);
  return getWaChat(id);
}
/** Teilnehmer einer Gruppe als Array – leer, wenn nie abgefragt. */
export function waChatParticipants(chat) {
  if (!chat?.participants) return [];
  try { return JSON.parse(chat.participants); } catch { return []; }
}

export function setWaChatUnread(id, unread) {
  db.prepare('UPDATE wa_chats SET unread=? WHERE id=?').run(Number(unread) || 0, id);
}
export function setWaChatOldest(id, ts) {
  db.prepare('UPDATE wa_chats SET oldest_synced_ts=? WHERE id=?').run(ts, id);
}

const WA_MSG_LIST_COLS = `id, wa_account_id, chat_id, wa_id, chat_jid, sender_jid, sender_name,
  from_me, ts, type, snippet, quoted_wa_id, media_mime, media_size, media_filename,
  stored_path IS NOT NULL AS media_downloaded, status, origin, created_at`;

/** Ein Batch Nachrichten. Gibt zurück, wie viele wirklich neu waren. */
export function insertWaMessages(rows = []) {
  if (!rows.length) return 0;
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO wa_messages
       (wa_account_id, chat_id, wa_id, chat_jid, sender_jid, sender_name, from_me, ts, type,
        body, snippet, quoted_wa_id, media_mime, media_size, media_filename, stored_path,
        status, origin, raw)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let added = 0;
  for (const m of rows) {
    const r = stmt.run(m.wa_account_id, m.chat_id, m.wa_id, m.chat_jid, m.sender_jid ?? null,
      m.sender_name ?? null, m.from_me ? 1 : 0, m.ts, m.type || 'text',
      m.body ?? null, m.snippet ?? null, m.quoted_wa_id ?? null,
      m.media_mime ?? null, m.media_size ?? null, m.media_filename ?? null, m.stored_path ?? null,
      m.status ?? null, m.origin ?? null, m.raw ?? null);
    if (r.changes > 0) added++;
  }
  return added;
}
export function listWaMessages({ chatId, limit = 50, beforeTs = null } = {}) {
  const args = [chatId];
  let where = 'chat_id=?';
  if (beforeTs) { where += ' AND ts < ?'; args.push(beforeTs); }
  args.push(limit);
  const rows = db.prepare(
    `SELECT ${WA_MSG_LIST_COLS}, body FROM wa_messages WHERE ${where} ORDER BY ts DESC LIMIT ?`)
    .all(...args);
  if (!rows.length) return rows;
  // Reaktionen in EINER Abfrage nachladen statt je Nachricht.
  const map = waReactionsFor(rows[0].wa_account_id, rows[0].chat_jid, rows.map(r => r.wa_id));
  for (const r of rows) r.reactions = map[r.wa_id] || [];
  return rows;
}
export function getWaMessage(id) {
  return db.prepare('SELECT * FROM wa_messages WHERE id=?').get(id);
}
export function getWaMessageByWaId(waAccountId, chatJid, waId) {
  return db.prepare('SELECT * FROM wa_messages WHERE wa_account_id=? AND chat_jid=? AND wa_id=?')
    .get(waAccountId, chatJid, waId);
}
/** Rohes proto einer eigenen Nachricht – Baileys braucht das für Zustell-Wiederholungen. */
export function getWaRawMessage(waAccountId, chatJid, waId) {
  const r = db.prepare('SELECT raw FROM wa_messages WHERE wa_account_id=? AND chat_jid=? AND wa_id=? AND from_me=1')
    .get(waAccountId, chatJid, waId);
  if (!r?.raw) return undefined;
  try { return JSON.parse(r.raw); } catch { return undefined; }
}
export function updateWaMessageStatus(waAccountId, chatJid, waId, status, error = null) {
  return db.prepare('UPDATE wa_messages SET status=?, error=? WHERE wa_account_id=? AND chat_jid=? AND wa_id=?')
    .run(status, error, waAccountId, chatJid, waId).changes > 0;
}
export function setWaMessageMedia(id, { stored_path, media_size }) {
  db.prepare('UPDATE wa_messages SET stored_path=?, media_size=COALESCE(?, media_size) WHERE id=?')
    .run(stored_path, media_size ?? null, id);
  return getWaMessage(id);
}
/** Älteste bekannte Nachricht eines Chats – Startpunkt beim Nachladen. */
export function oldestWaMessage(chatId) {
  return db.prepare('SELECT wa_id, chat_jid, ts, from_me FROM wa_messages WHERE chat_id=? ORDER BY ts LIMIT 1')
    .get(chatId);
}
export function searchWaMessages({ query, waAccountId = null, limit = 30 } = {}) {
  const args = [`%${query}%`];
  let where = 'm.body LIKE ?';
  if (waAccountId) { where += ' AND m.wa_account_id=?'; args.push(waAccountId); }
  args.push(limit);
  return db.prepare(
    `SELECT m.id, m.chat_id, m.from_me, m.ts, m.type, m.snippet, c.name AS chat_name, c.jid AS chat_jid
     FROM wa_messages m JOIN wa_chats c ON c.id = m.chat_id
     WHERE ${where} ORDER BY m.ts DESC LIMIT ?`).all(...args);
}
/** Wie viele eigene Nachrichten in der letzten Stunde – für die Versand-Bremse. */
export function waSentLastHour(waAccountId) {
  return db.prepare(
    `SELECT COUNT(*) AS n FROM wa_messages
     WHERE wa_account_id=? AND from_me=1 AND ts > ?`)
    .get(waAccountId, Math.floor(Date.now() / 1000) - 3600).n;
}
/** Hat dieser Chat je eine eingehende Nachricht? Grundlage für mcp_send_mode='known'. */
export function waChatHasInbound(chatId) {
  return !!db.prepare('SELECT 1 FROM wa_messages WHERE chat_id=? AND from_me=0 LIMIT 1').get(chatId);
}

/* ---- Reaktionen ---------------------------------------------------------- */
// Eigene Tabelle statt Zeilen in wa_messages: eine Reaktion ist kein
// Gesprächsbeitrag, sondern eine Eigenschaft der Nachricht, auf die sie zielt.
// Je Person und Nachricht genau eine – eine neue ersetzt die alte.
db.exec(`
CREATE TABLE IF NOT EXISTS wa_reactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_account_id INTEGER NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
  chat_jid TEXT NOT NULL,
  target_wa_id TEXT NOT NULL,
  sender_jid TEXT NOT NULL,
  from_me INTEGER NOT NULL DEFAULT 0,
  emoji TEXT NOT NULL,
  ts INTEGER NOT NULL,
  UNIQUE(wa_account_id, chat_jid, target_wa_id, sender_jid)
);
CREATE INDEX IF NOT EXISTS idx_wa_reactions_target ON wa_reactions(wa_account_id, chat_jid, target_wa_id);
`);

/** Setzt oder entfernt eine Reaktion. Leerer Text = zurückgenommen. */
export function setWaReaction({ wa_account_id, chat_jid, target_wa_id, sender_jid, from_me, emoji, ts }) {
  if (!emoji) {
    return db.prepare(
      'DELETE FROM wa_reactions WHERE wa_account_id=? AND chat_jid=? AND target_wa_id=? AND sender_jid=?')
      .run(wa_account_id, chat_jid, target_wa_id, sender_jid).changes > 0;
  }
  db.prepare(
    `INSERT INTO wa_reactions (wa_account_id, chat_jid, target_wa_id, sender_jid, from_me, emoji, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(wa_account_id, chat_jid, target_wa_id, sender_jid) DO UPDATE SET
       emoji=excluded.emoji, ts=excluded.ts`)
    .run(wa_account_id, chat_jid, target_wa_id, sender_jid, from_me ? 1 : 0, emoji, ts);
  return true;
}

/** Reaktionen zu einer Menge von Nachrichten, gruppiert je Emoji. */
export function waReactionsFor(waAccountId, chatJid, waIds = []) {
  if (!waIds.length) return {};
  const marks = waIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT target_wa_id, emoji, sender_jid, from_me FROM wa_reactions
     WHERE wa_account_id=? AND chat_jid=? AND target_wa_id IN (${marks}) ORDER BY ts`)
    .all(waAccountId, chatJid, ...waIds);
  const out = {};
  for (const r of rows) {
    const list = out[r.target_wa_id] ||= [];
    const hit = list.find(x => x.emoji === r.emoji);
    if (hit) { hit.count++; if (r.from_me) hit.mine = true; }
    else list.push({ emoji: r.emoji, count: 1, mine: !!r.from_me });
  }
  return out;
}

/** Heruntergeladene Medien, die älter sind als N Tage. */
export function waMediaOlderThan(waAccountId, days) {
  return db.prepare(
    `SELECT id, stored_path, media_size FROM wa_messages
     WHERE wa_account_id=? AND stored_path IS NOT NULL AND ts < ?`)
    .all(waAccountId, Math.floor(Date.now() / 1000) - days * 86400);
}
/** Datei ist weg – Verweis lösen, damit die Oberfläche sie als nicht geladen zeigt. */
export function clearWaMedia(id) {
  db.prepare('UPDATE wa_messages SET stored_path=NULL WHERE id=?').run(id);
}
/** Belegter Platz durch heruntergeladene Medien. */
export function waMediaUsage(waAccountId = null) {
  const sql = `SELECT COUNT(*) files, COALESCE(SUM(media_size),0) bytes FROM wa_messages
               WHERE stored_path IS NOT NULL${waAccountId ? ' AND wa_account_id=?' : ''}`;
  return waAccountId ? db.prepare(sql).get(waAccountId) : db.prepare(sql).get();
}

export function upsertWaContact(waAccountId, { jid, phone, push_name, name, is_group }) {
  db.prepare(
    `INSERT INTO wa_contacts (wa_account_id, jid, phone, push_name, name, is_group)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(wa_account_id, jid) DO UPDATE SET
       phone = COALESCE(excluded.phone, wa_contacts.phone),
       push_name = COALESCE(excluded.push_name, wa_contacts.push_name),
       name = COALESCE(excluded.name, wa_contacts.name),
       updated_at = datetime('now')`)
    .run(waAccountId, jid, phone ?? null, push_name ?? null, name ?? null, is_group ? 1 : 0);
  return db.prepare('SELECT * FROM wa_contacts WHERE wa_account_id=? AND jid=?').get(waAccountId, jid);
}
export function listWaContacts({ waAccountId = null, query = null, limit = 100 } = {}) {
  const where = ['1=1'];
  const args = [];
  if (waAccountId) { where.push('w.wa_account_id=?'); args.push(waAccountId); }
  if (query) { where.push('(w.name LIKE ? OR w.push_name LIKE ? OR w.phone LIKE ?)'); args.push(`%${query}%`, `%${query}%`, `%${query}%`); }
  args.push(limit);
  return db.prepare(
    `SELECT w.*, c.email AS contact_email, c.name AS contact_full_name
     FROM wa_contacts w LEFT JOIN contacts c ON c.id = w.contact_id
     WHERE ${where.join(' AND ')} ORDER BY COALESCE(w.name, w.push_name, w.phone) LIMIT ?`).all(...args);
}
export function linkWaContact(waContactId, contactId) {
  const waContact = db.prepare('SELECT * FROM wa_contacts WHERE id=?').get(waContactId);
  if (!waContact) return null;
  tx(() => {
    db.prepare('UPDATE wa_contacts SET contact_id=? WHERE id=?').run(contactId, waContactId);
    if (contactId && waContact.phone) {
      const contact = getContactById(contactId);
      // WhatsApp speichert E.164 als Ziffern aus der JID. Im Adressbuch lesbar
      // mit führendem Plus ablegen, aber eine bereits gepflegte Nummer schützen.
      const digits = String(waContact.phone).replace(/\D/g, '');
      if (contact && !String(contact.phone || '').trim() && digits) {
        updateContact(contactId, { phone: `+${digits}` });
      }
    }
  });
  return db.prepare('SELECT * FROM wa_contacts WHERE id=?').get(waContactId);
}
/** WhatsApp-Identitäten eines Adressbuch-Kontakts. */
export function waContactsForContact(contactId) {
  return db.prepare(
    `SELECT w.*, c.id AS chat_id, c.last_message_ts, c.last_snippet
     FROM wa_contacts w
     LEFT JOIN wa_chats c ON c.wa_account_id = w.wa_account_id AND c.jid = w.jid
     WHERE w.contact_id=?`).all(contactId);
}
export function waUnreadCount(waAccountId = null) {
  return waAccountId
    ? db.prepare('SELECT COALESCE(SUM(unread),0) AS n FROM wa_chats WHERE wa_account_id=?').get(waAccountId).n
    : db.prepare('SELECT COALESCE(SUM(unread),0) AS n FROM wa_chats').get().n;
}

/* ---- Geplante WhatsApp-Nachrichten --------------------------------------- */
// Ein Auftrag, keine Nachricht: er steht hier, bis der Web-Server-Prozess ihn
// zur Sendezeit ausführt (der Socket lebt nur dort, siehe src/whatsapp.js).
// Der MCP-Prozess legt Aufträge über HTTP an, damit dieselben Schutzregeln
// greifen wie beim Sofortversand.
db.exec(`
CREATE TABLE IF NOT EXISTS wa_scheduled (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_account_id INTEGER NOT NULL REFERENCES wa_accounts(id) ON DELETE CASCADE,
  chat_id INTEGER NOT NULL REFERENCES wa_chats(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  send_at INTEGER NOT NULL,                  -- Unix-Sekunden
  status TEXT NOT NULL DEFAULT 'pending',    -- pending|sent|failed|cancelled
  origin TEXT NOT NULL DEFAULT 'ui',         -- ui|mcp
  note TEXT,                                 -- Merkzettel, z.B. wofür die Nachricht ist
  wa_id TEXT,                                -- nach dem Versand
  error TEXT,                                -- letzter Fehler (auch bei pending: Versuch fehlgeschlagen)
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_wa_scheduled_due ON wa_scheduled(status, send_at);
`);

const WA_SCHED_COLS = `s.*, c.name AS chat_name, c.jid AS chat_jid, c.is_group`;

export function createWaScheduled({ wa_account_id, chat_id, text, send_at, origin = 'ui', note = null }) {
  const info = db.prepare(
    `INSERT INTO wa_scheduled (wa_account_id, chat_id, text, send_at, origin, note)
     VALUES (?, ?, ?, ?, ?, ?)`).run(wa_account_id, chat_id, text, send_at, origin, note);
  return getWaScheduled(info.lastInsertRowid);
}
export function getWaScheduled(id) {
  return db.prepare(
    `SELECT ${WA_SCHED_COLS} FROM wa_scheduled s JOIN wa_chats c ON c.id = s.chat_id WHERE s.id=?`).get(id);
}
/**
 * Offene Aufträge zuerst (nach Sendezeit), danach die zuletzt erledigten –
 * so sieht man in der Oberfläche, was ansteht UND was gerade rausging.
 */
export function listWaScheduled({ waAccountId = null, chatId = null, status = null, limit = 50 } = {}) {
  const where = []; const args = [];
  if (waAccountId) { where.push('s.wa_account_id=?'); args.push(waAccountId); }
  if (chatId) { where.push('s.chat_id=?'); args.push(chatId); }
  if (status) { where.push('s.status=?'); args.push(status); }
  args.push(limit);
  return db.prepare(
    `SELECT ${WA_SCHED_COLS} FROM wa_scheduled s JOIN wa_chats c ON c.id = s.chat_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY CASE s.status WHEN 'pending' THEN 0 ELSE 1 END, 
              CASE s.status WHEN 'pending' THEN s.send_at ELSE -s.send_at END
     LIMIT ?`).all(...args);
}
export function dueWaScheduled(now = Math.floor(Date.now() / 1000)) {
  return db.prepare(
    `SELECT ${WA_SCHED_COLS} FROM wa_scheduled s JOIN wa_chats c ON c.id = s.chat_id
     WHERE s.status='pending' AND s.send_at <= ? ORDER BY s.send_at`).all(now);
}
export function cancelWaScheduled(id) {
  const r = db.prepare(`UPDATE wa_scheduled SET status='cancelled' WHERE id=? AND status='pending'`).run(id);
  return r.changes > 0;
}
export function updateWaScheduled(id, { text, send_at, note } = {}) {
  const cur = db.prepare('SELECT * FROM wa_scheduled WHERE id=?').get(id);
  if (!cur || cur.status !== 'pending') return null;
  db.prepare('UPDATE wa_scheduled SET text=?, send_at=?, note=? WHERE id=?').run(
    text ?? cur.text, send_at ?? cur.send_at, note === undefined ? cur.note : note, id);
  return getWaScheduled(id);
}
export function markWaScheduled(id, { status, wa_id = null, error = null }) {
  db.prepare(
    `UPDATE wa_scheduled SET status=?, wa_id=COALESCE(?, wa_id), error=?, attempts=attempts+1,
       sent_at=CASE WHEN ?='sent' THEN datetime('now') ELSE sent_at END
     WHERE id=?`).run(status, wa_id, error, status, id);
  return getWaScheduled(id);
}
export function waScheduledPendingCount(chatId = null) {
  return chatId
    ? db.prepare(`SELECT COUNT(*) AS n FROM wa_scheduled WHERE status='pending' AND chat_id=?`).get(chatId).n
    : db.prepare(`SELECT COUNT(*) AS n FROM wa_scheduled WHERE status='pending'`).get().n;
}
