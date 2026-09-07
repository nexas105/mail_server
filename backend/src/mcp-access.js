// Zugang zum MCP-Server und Protokoll darüber, was er getan hat.
//
// Warum eigene Token statt nur MCP_TOKEN aus der Umgebung:
// Ein Wert in der Umgebung ist genau einer. Man kann ihn nicht einzeln
// widerrufen, nicht einem Client zuordnen und nicht ohne Neustart wechseln.
// Sobald mehr als ein Client (Laptop, Server, Kollege) dranhängt, ist das zu
// grob. Die Token hier liegen als Hash in der Datenbank, tragen einen Namen,
// lassen sich abschalten und einzeln nur-lesend schalten.
//
// Und warum ein Protokoll: Der MCP-Server handelt im Namen des Nutzers, aber
// ohne dass jemand zusieht. „Was hat die KI eigentlich gemacht?" ist sonst
// unbeantwortbar — erst recht, wenn der Endpunkt über das Netz erreichbar ist.
import crypto from 'node:crypto';
import { db } from './db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS mcp_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,                       -- erste Zeichen, nur zum Wiedererkennen
  readonly INTEGER NOT NULL DEFAULT 0,        -- 1 = nur lesende Werkzeuge
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  last_used_at TEXT,
  last_used_ip TEXT,
  use_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS mcp_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  transport TEXT NOT NULL DEFAULT 'stdio',    -- stdio | http
  token_id INTEGER,
  token_name TEXT,
  client TEXT,                                -- Name des KI-Clients aus initialize
  tool TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 1,
  duration_ms INTEGER,
  summary TEXT,                               -- gekürzte Argumente, keine Inhalte
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_mcp_events_at ON mcp_events(at DESC);
`);

const sha256 = v => crypto.createHash('sha256').update(String(v)).digest('hex');
const PREFIX = 'mcp_';

// ---- Token ----------------------------------------------------------------
const publicToken = t => t && ({
  id: t.id, name: t.name, prefix: t.prefix,
  readonly: !!t.readonly, disabled: !!t.disabled,
  created_at: t.created_at, created_by: t.created_by,
  last_used_at: t.last_used_at, last_used_ip: t.last_used_ip,
  use_count: t.use_count, expires_at: t.expires_at,
});

export function listMcpTokens() {
  return db.prepare('SELECT * FROM mcp_tokens ORDER BY id DESC').all().map(publicToken);
}

export function createMcpToken({ name, readonly = false, days = null, createdBy = null }) {
  const label = String(name || '').trim().slice(0, 80);
  if (!label) throw new Error('Name erforderlich');
  const token = PREFIX + crypto.randomBytes(32).toString('base64url');
  const expiresAt = days ? new Date(Date.now() + Number(days) * 86400_000).toISOString() : null;
  const info = db.prepare(`INSERT INTO mcp_tokens (name, token_hash, prefix, readonly, created_by, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(label, sha256(token), token.slice(0, 12), readonly ? 1 : 0, createdBy, expiresAt);
  // Das Klartext-Token existiert genau einmal – hier. Danach nur noch als Hash.
  return { ...publicToken(db.prepare('SELECT * FROM mcp_tokens WHERE id=?').get(info.lastInsertRowid)), token };
}

export function updateMcpToken(id, { disabled, readonly, name } = {}) {
  const cur = db.prepare('SELECT * FROM mcp_tokens WHERE id=?').get(id);
  if (!cur) return null;
  db.prepare('UPDATE mcp_tokens SET disabled=?, readonly=?, name=? WHERE id=?').run(
    disabled === undefined ? cur.disabled : (disabled ? 1 : 0),
    readonly === undefined ? cur.readonly : (readonly ? 1 : 0),
    name === undefined ? cur.name : String(name).trim().slice(0, 80) || cur.name,
    id,
  );
  return publicToken(db.prepare('SELECT * FROM mcp_tokens WHERE id=?').get(id));
}

export function deleteMcpToken(id) {
  return db.prepare('DELETE FROM mcp_tokens WHERE id=?').run(id).changes > 0;
}

export function countActiveMcpTokens() {
  return db.prepare(`SELECT COUNT(*) AS n FROM mcp_tokens
    WHERE disabled = 0 AND (expires_at IS NULL OR expires_at > datetime('now'))`).get().n;
}

/**
 * Prüft ein vorgelegtes Token. Gibt den Datensatz zurück oder null.
 * Der Vergleich läuft über den Hash – ein Zeitangriff auf den Index bringt
 * nichts, weil der Hash gleichverteilt ist.
 */
export function verifyMcpToken(token, { ip = null } = {}) {
  if (!token || !token.startsWith(PREFIX)) return null;
  const row = db.prepare('SELECT * FROM mcp_tokens WHERE token_hash=?').get(sha256(token));
  if (!row || row.disabled) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return null;
  db.prepare(`UPDATE mcp_tokens SET last_used_at=datetime('now'), last_used_ip=?, use_count=use_count+1 WHERE id=?`)
    .run(ip, row.id);
  return row;
}

// ---- Protokoll ------------------------------------------------------------
const EVENT_CAP = Math.max(200, Number(process.env.MCP_LOG_CAP || 5000));

// Schlüssel, deren Wert nie ins Protokoll darf. Geheimnisse werden zu `***`,
// Inhalte (HTML, Text, base64) nur als Länge notiert – egal wie kurz sie sind.
// Anlass: `create_smtp_account`/`update_smtp_account` nehmen `password` als
// kurze Zeichenkette entgegen, und die landete damit im Klartext in
// mcp_events.summary – lesbar für jeden, der die Protokoll-Ansicht öffnet.
const SECRET_KEY = /password|pass|token|secret|key/i;
const CONTENT_KEY = /base64|webp|html|text|body/i;

/**
 * Fasst die Argumente eines Aufrufs zusammen – Zahlen und kurze Zeichenketten.
 * Bewusst KEINE Inhalte: HTML-Rümpfe, base64-Anhänge und Nachrichtentexte
 * gehören nicht in ein Protokoll, das jemand später durchblättert.
 */
export function summarizeArgs(args = {}) {
  if (!args || typeof args !== 'object') return null;
  const parts = [];
  for (const [k, v] of Object.entries(args)) {
    if (v == null) continue;
    if (SECRET_KEY.test(k)) parts.push(`${k}=***`);
    else if (CONTENT_KEY.test(k)) parts.push(`${k}=…${typeof v === 'string' ? v.length : JSON.stringify(v).length} Zeichen`);
    else if (typeof v === 'number' || typeof v === 'boolean') parts.push(`${k}=${v}`);
    else if (typeof v === 'string') {
      if (v.length > 60 || /<[a-z]/i.test(v)) parts.push(`${k}=…${v.length} Zeichen`);
      else parts.push(`${k}=${v}`);
    } else if (Array.isArray(v)) parts.push(`${k}[${v.length}]`);
    else parts.push(`${k}={…}`);
    if (parts.length >= 6) break;
  }
  return parts.join(' ').slice(0, 300) || null;
}

let sinceCleanup = 0;
export function logMcpEvent(e = {}) {
  try {
    db.prepare(`INSERT INTO mcp_events (transport, token_id, token_name, client, tool, ok, duration_ms, summary, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      e.transport || 'stdio', e.tokenId ?? null, e.tokenName ?? null, e.client ?? null,
      e.tool, e.ok === false ? 0 : 1, e.durationMs ?? null,
      e.summary ?? null, e.error ? String(e.error).slice(0, 300) : null);
    // Das Protokoll darf nicht unbegrenzt wachsen; gelegentlich hinten abschneiden.
    if (++sinceCleanup >= 200) {
      sinceCleanup = 0;
      db.prepare(`DELETE FROM mcp_events WHERE id <= (
        SELECT id FROM mcp_events ORDER BY id DESC LIMIT 1 OFFSET ?)`).run(EVENT_CAP);
    }
  } catch { /* Ein Protokollfehler darf den Aufruf nie kippen. */ }
}

export function listMcpEvents({ limit = 200, tool = null, onlyErrors = false, transport = null } = {}) {
  const where = [], params = [];
  if (tool) { where.push('tool = ?'); params.push(tool); }
  if (onlyErrors) where.push('ok = 0');
  if (transport) { where.push('transport = ?'); params.push(transport); }
  const sql = `SELECT * FROM mcp_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY id DESC LIMIT ?`;
  return db.prepare(sql).all(...params, Math.min(1000, Math.max(1, limit)));
}

/** Kurzüberblick für die Oberfläche: was lief zuletzt, wie oft, wie fehlerhaft. */
export function mcpEventStats() {
  const row = db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS errors,
      SUM(CASE WHEN at >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS last_day,
      MAX(at) AS last_at
    FROM mcp_events`).get();
  const top = db.prepare(`SELECT tool, COUNT(*) AS n FROM mcp_events
    WHERE at >= datetime('now', '-7 days') GROUP BY tool ORDER BY n DESC LIMIT 5`).all();
  return { ...row, errors: row.errors || 0, last_day: row.last_day || 0, top };
}
