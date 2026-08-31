// Benutzer, Anmeldung und Sitzungen für die Web-UI.
//
// Warum eigenes statt einer Bibliothek: der Server hat bewusst keine nativen
// Module und wenig Abhängigkeiten. scrypt, HMAC und die Sitzungstabelle stecken
// alle in node:crypto bzw. node:sqlite.
//
// Drei Arten von Zugang:
//   1. Sitzung (Cookie)  – die Web-UI im Browser. Kurzlebig, CSRF-geschützt.
//   2. API-Token (Bearer)– native Clients (macOS-App, Skripte). Pro Nutzer,
//                          jederzeit widerrufbar.
//   3. Service-Token     – interner Prozess-zu-Prozess-Aufruf (MCP → Web-Server).
//                          Liegt AES-verschlüsselt in der DB, beide Prozesse
//                          teilen sich die Datei – deshalb ohne Konfiguration.
import crypto from 'node:crypto';
import { db, encrypt, decrypt } from './db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',        -- admin | user
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  password_changed_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,                        -- sha256(token), nie das Token selbst
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS service_secrets (
  name TEXT PRIMARY KEY,
  value_enc TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

export const COOKIE_NAME = 'mail_sid';
const SESSION_HOURS = Math.max(1, Number(process.env.MAIL_SESSION_HOURS || 12));
const REMEMBER_DAYS = Math.max(1, Number(process.env.MAIL_SESSION_REMEMBER_DAYS || 30));
const MIN_PASSWORD = 10;

// ---- Passwörter (scrypt) --------------------------------------------------
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, salt, hash] = String(stored || '').split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(hash, 'base64');
    const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length,
      { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
    return crypto.timingSafeEqual(expected, actual);
  } catch { return false; }
}

// Damit „Benutzer existiert nicht" und „falsches Passwort" gleich lange dauern.
const DUMMY_HASH = hashPassword(crypto.randomBytes(24).toString('hex'));

export function passwordProblem(password, email = '') {
  const pw = String(password || '');
  if (pw.length < MIN_PASSWORD) return `Passwort muss mindestens ${MIN_PASSWORD} Zeichen haben`;
  if (pw.length > 200) return 'Passwort darf höchstens 200 Zeichen haben';
  if (email && pw.toLowerCase() === String(email).toLowerCase()) return 'Passwort darf nicht die E-Mail-Adresse sein';
  return null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function normalizeEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(e) || e.length > 200) throw new Error('Gültige E-Mail-Adresse erforderlich');
  return e;
}

// ---- Benutzer -------------------------------------------------------------
const publicUser = u => u && ({
  id: u.id, email: u.email, name: u.name, role: u.role,
  disabled: !!u.disabled, created_at: u.created_at, last_login_at: u.last_login_at,
});

export function countUsers() {
  return db.prepare('SELECT COUNT(*) AS n FROM users WHERE disabled = 0').get().n;
}
export function needsSetup() { return countUsers() === 0; }

export function listUsers() {
  return db.prepare('SELECT * FROM users ORDER BY id').all().map(publicUser);
}
export function getUser(id) { return db.prepare('SELECT * FROM users WHERE id=?').get(id) || null; }
export function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email=? COLLATE NOCASE').get(String(email || '').trim()) || null;
}

export function createUser({ email, name, password, role = 'user' }) {
  const mail = normalizeEmail(email);
  const problem = passwordProblem(password, mail);
  if (problem) throw new Error(problem);
  if (getUserByEmail(mail)) throw new Error('Diese E-Mail-Adresse wird bereits verwendet');
  const info = db.prepare(`INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)`)
    .run(mail, String(name || '').trim() || null, hashPassword(password), role === 'admin' ? 'admin' : 'user');
  return publicUser(getUser(Number(info.lastInsertRowid)));
}

/** Erster Start: legt den Administrator an. Nur solange es keinen Nutzer gibt. */
export function registerFirstAdmin({ email, name, password }) {
  if (!needsSetup()) throw new Error('Es existiert bereits ein Konto – bitte anmelden');
  return createUser({ email, name, password, role: 'admin' });
}

export function updateUser(id, { name, role, disabled }) {
  const user = getUser(id);
  if (!user) return null;
  const nextRole = role === undefined ? user.role : (role === 'admin' ? 'admin' : 'user');
  const nextDisabled = disabled === undefined ? user.disabled : (disabled ? 1 : 0);
  // Der letzte aktive Administrator darf sich nicht selbst aussperren.
  if ((nextRole !== 'admin' || nextDisabled) && user.role === 'admin' && !user.disabled && activeAdmins() <= 1) {
    throw new Error('Der letzte Administrator kann nicht deaktiviert oder herabgestuft werden');
  }
  db.prepare('UPDATE users SET name=COALESCE(?, name), role=?, disabled=? WHERE id=?')
    .run(name === undefined ? null : (String(name).trim() || null), nextRole, nextDisabled, id);
  if (nextDisabled) deleteUserSessions(id);
  return publicUser(getUser(id));
}

function activeAdmins() {
  return db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role='admin' AND disabled=0`).get().n;
}

export function deleteUser(id) {
  const user = getUser(id);
  if (!user) return false;
  if (user.role === 'admin' && !user.disabled && activeAdmins() <= 1) {
    throw new Error('Der letzte Administrator kann nicht gelöscht werden');
  }
  return db.prepare('DELETE FROM users WHERE id=?').run(id).changes > 0;
}

export function setPassword(id, password) {
  const user = getUser(id);
  if (!user) throw new Error('Benutzer nicht gefunden');
  const problem = passwordProblem(password, user.email);
  if (problem) throw new Error(problem);
  db.prepare(`UPDATE users SET password_hash=?, password_changed_at=datetime('now') WHERE id=?`)
    .run(hashPassword(password), id);
  return true;
}

export function changePassword(id, currentPassword, newPassword) {
  const user = getUser(id);
  if (!user || !verifyPassword(currentPassword, user.password_hash)) throw new Error('Aktuelles Passwort ist falsch');
  setPassword(id, newPassword);
  return true;
}

// ---- Anmeldeversuche drosseln --------------------------------------------
// Bewusst im Arbeitsspeicher: der Web-Server ist ein Prozess, und ein Neustart
// als „Reset" ist harmlos, solange das Fenster kurz ist.
const attempts = new Map();
const MAX_ATTEMPTS = Number(process.env.MAIL_LOGIN_MAX_ATTEMPTS || 8);
const LOCK_MS = Number(process.env.MAIL_LOGIN_LOCK_MINUTES || 15) * 60_000;

function attemptKey(ip, email) { return `${ip || '?'}|${String(email || '').toLowerCase()}`; }

export function loginLockedFor(ip, email) {
  const entry = attempts.get(attemptKey(ip, email));
  if (!entry || !entry.lockedUntil || entry.lockedUntil <= Date.now()) return 0;
  return Math.ceil((entry.lockedUntil - Date.now()) / 1000);
}

function noteFailure(ip, email) {
  const key = attemptKey(ip, email);
  const now = Date.now();
  const entry = attempts.get(key);
  // Zwei getrennte Uhren: das Zählfenster gleitet mit jedem Fehlversuch mit,
  // gesperrt wird erst, wenn MAX_ATTEMPTS darin voll sind.
  const current = !entry || entry.windowUntil <= now ? { count: 0, windowUntil: 0, lockedUntil: 0 } : entry;
  current.count++;
  current.windowUntil = now + LOCK_MS;
  if (current.count >= MAX_ATTEMPTS) { current.lockedUntil = now + LOCK_MS; current.count = 0; }
  attempts.set(key, current);
  if (attempts.size > 5000) attempts.clear();
}
function clearFailures(ip, email) { attempts.delete(attemptKey(ip, email)); }

/** Prüft Zugangsdaten. Wirft mit sprechender Meldung, gibt sonst den Nutzer zurück. */
export function authenticate({ email, password, ip }) {
  const locked = loginLockedFor(ip, email);
  if (locked) {
    const e = new Error(`Zu viele Fehlversuche – bitte in ${Math.ceil(locked / 60)} Minuten erneut versuchen`);
    e.status = 429; throw e;
  }
  const user = getUserByEmail(email);
  const okPassword = verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !okPassword || user.disabled) {
    noteFailure(ip, email);
    const e = new Error('E-Mail-Adresse oder Passwort ist falsch');
    e.status = 401; throw e;
  }
  clearFailures(ip, email);
  db.prepare(`UPDATE users SET last_login_at=datetime('now') WHERE id=?`).run(user.id);
  return user;
}

// ---- Sitzungen ------------------------------------------------------------
const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');

export function createSession(userId, { ip, userAgent, remember = false } = {}) {
  purgeExpired();
  const token = newToken();
  const ms = (remember ? REMEMBER_DAYS * 24 : SESSION_HOURS) * 3600_000;
  const expiresAt = new Date(Date.now() + ms);
  db.prepare(`INSERT INTO sessions (id, user_id, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)`)
    .run(sha256(token), userId, expiresAt.toISOString(), ip || null, String(userAgent || '').slice(0, 300) || null);
  return { token, expiresAt, maxAgeSeconds: Math.floor(ms / 1000) };
}

export function getSession(token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE id=?').get(sha256(token));
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id=?').run(row.id);
    return null;
  }
  const user = getUser(row.user_id);
  if (!user || user.disabled) return null;
  return { row, user };
}

export function touchSession(id) {
  db.prepare(`UPDATE sessions SET last_seen_at=datetime('now') WHERE id=?`).run(id);
}
export function deleteSession(token) {
  return db.prepare('DELETE FROM sessions WHERE id=?').run(sha256(token)).changes > 0;
}
export function deleteUserSessions(userId, exceptId = null) {
  return exceptId
    ? db.prepare('DELETE FROM sessions WHERE user_id=? AND id<>?').run(userId, exceptId).changes
    : db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId).changes;
}
export function listSessions(userId) {
  return db.prepare('SELECT id, created_at, last_seen_at, expires_at, ip, user_agent FROM sessions WHERE user_id=? ORDER BY last_seen_at DESC')
    .all(userId);
}
export function purgeExpired() {
  db.prepare(`DELETE FROM sessions WHERE expires_at <= datetime('now')`).run();
  db.prepare(`DELETE FROM api_tokens WHERE expires_at IS NOT NULL AND expires_at <= datetime('now')`).run();
}

// ---- API-Token (native Clients, Skripte) ---------------------------------
const TOKEN_PREFIX = 'mst_';

export function createApiToken(userId, { name, days = null } = {}) {
  if (!getUser(userId)) throw new Error('Benutzer nicht gefunden');
  const token = TOKEN_PREFIX + newToken();
  const expiresAt = days ? new Date(Date.now() + Number(days) * 86400_000).toISOString() : null;
  const info = db.prepare('INSERT INTO api_tokens (user_id, name, token_hash, expires_at) VALUES (?, ?, ?, ?)')
    .run(userId, String(name || 'Token').trim().slice(0, 80), sha256(token), expiresAt);
  // Das Klartext-Token existiert genau einmal – hier.
  return { id: Number(info.lastInsertRowid), name, token, expires_at: expiresAt };
}

export function listApiTokens(userId) {
  return db.prepare('SELECT id, name, created_at, last_used_at, expires_at FROM api_tokens WHERE user_id=? ORDER BY id DESC')
    .all(userId);
}
export function deleteApiToken(userId, id) {
  return db.prepare('DELETE FROM api_tokens WHERE id=? AND user_id=?').run(id, userId).changes > 0;
}

export function resolveApiToken(token) {
  if (!token || !token.startsWith(TOKEN_PREFIX)) return null;
  const row = db.prepare('SELECT * FROM api_tokens WHERE token_hash=?').get(sha256(token));
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
    db.prepare('DELETE FROM api_tokens WHERE id=?').run(row.id);
    return null;
  }
  const user = getUser(row.user_id);
  if (!user || user.disabled) return null;
  db.prepare(`UPDATE api_tokens SET last_used_at=datetime('now') WHERE id=?`).run(row.id);
  return user;
}

// ---- Service-Token (MCP-Server → Web-Server) ------------------------------
// Beide Prozesse teilen sich data/mail.db und den AES-Schlüssel; damit braucht
// der interne Aufruf keine Konfiguration und kein Passwort im Klartext.
export function getServiceToken(name = 'mcp') {
  const row = db.prepare('SELECT value_enc FROM service_secrets WHERE name=?').get(name);
  if (row) { try { return decrypt(row.value_enc); } catch { /* neu erzeugen */ } }
  const token = 'msv_' + newToken();
  db.prepare('INSERT INTO service_secrets (name, value_enc) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value_enc=excluded.value_enc')
    .run(name, encrypt(token));
  return token;
}

export function isServiceToken(token) {
  if (!token || !token.startsWith('msv_')) return null;
  for (const row of db.prepare('SELECT name, value_enc FROM service_secrets').all()) {
    let plain = '';
    try { plain = decrypt(row.value_enc); } catch { continue; }
    const a = Buffer.from(token), b = Buffer.from(plain);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return { name: row.name };
  }
  return null;
}
