// Datei-Uploads für den MCP-Betrieb über HTTP.
//
// Über HTTP sitzt der Aufrufer auf einem anderen Rechner: ein „path" zeigt auf
// SEIN Dateisystem, nicht auf unseres – und base64 im Tool-Aufruf kostet bei
// einer PDF schnell Hunderttausende Token. Deshalb:
//
//   1. Werkzeug create_upload → einmalige Upload-URL (zufälliges Token, 15 Min.)
//   2. Aufrufer: curl -T datei.pdf <upload_url>     (Token in der URL = Berechtigung)
//   3. Werkzeug add_attachment / create_draft mit { upload_id }
//
// Eine Upload-URL nimmt genau EINE Datei an, eine upload_id wird beim Anhängen
// verbraucht. Abgelegt wird im temporären Ordner, nichts bleibt liegen.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
const TTL_MS = Math.max(1, Number(process.env.MCP_UPLOAD_TTL_MINUTES || 15)) * 60_000;
const MAX_PENDING = 50;
const DIR = path.join(os.tmpdir(), 'mail-mcp-uploads');

/** id → { token, filename, mimetype, owner, expiresAt, file, size } */
const uploads = new Map();
let baseUrl = process.env.MCP_PUBLIC_URL ? String(process.env.MCP_PUBLIC_URL).replace(/\/+$/, '') : '';

/** Wird vom HTTP-Einstieg mit der Adresse der ersten Anfrage gefüttert, falls MCP_PUBLIC_URL fehlt. */
export function rememberBaseUrl(url) {
  if (!baseUrl && url) baseUrl = String(url).replace(/\/+$/, '');
}
export const uploadBaseUrl = () => baseUrl;

const safeName = name => path.basename(String(name || 'datei')).replace(/[\u0000-\u001f/\\]/g, '_').slice(0, 200) || 'datei';

function removeFile(entry) {
  if (entry?.file) fs.rm(entry.file, { force: true }, () => {});
}

function sweep() {
  const now = Date.now();
  for (const [id, entry] of uploads) {
    if (entry.expiresAt <= now) { removeFile(entry); uploads.delete(id); }
  }
}
setInterval(sweep, 60_000).unref();

/** Legt einen Upload-Platz an. owner = Token-Herkunft der MCP-Sitzung. */
export function createUpload({ filename, mimetype, owner }) {
  sweep();
  if (uploads.size >= MAX_PENDING) throw new Error('Zu viele offene Uploads – bitte kurz warten oder vorhandene verwenden.');
  if (!baseUrl) throw new Error('Upload-Adresse unbekannt – MCP_PUBLIC_URL setzen.');
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('base64url');
  const entry = { id, token, filename: safeName(filename), mimetype: mimetype || null, owner: owner ?? null, expiresAt: Date.now() + TTL_MS, file: null, size: 0 };
  uploads.set(id, entry);
  return { upload_id: id, upload_url: `${baseUrl}/upload/${token}`, expires_at: new Date(entry.expiresAt).toISOString() };
}

function byToken(token) {
  const t = Buffer.from(String(token || ''));
  for (const entry of uploads.values()) {
    const x = Buffer.from(entry.token);
    if (x.length === t.length && crypto.timingSafeEqual(x, t)) return entry;
  }
  return null;
}

/** HTTP-Handler-Logik: speichert den Body (Buffer) unter dem Token. */
export function receiveUpload(token, body) {
  sweep();
  const entry = byToken(token);
  if (!entry) return { status: 404, error: 'Upload-URL unbekannt oder abgelaufen' };
  if (entry.file) return { status: 409, error: 'Diese Upload-URL wurde schon benutzt' };
  if (!Buffer.isBuffer(body) || !body.length) return { status: 400, error: 'Leerer Upload' };
  if (body.length > UPLOAD_MAX_BYTES) return { status: 413, error: 'Zu groß (max. 20 MB)' };
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const file = path.join(DIR, entry.id);
  fs.writeFileSync(file, body, { mode: 0o600 });
  entry.file = file;
  entry.size = body.length;
  return { status: 200, data: { ok: true, upload_id: entry.id, filename: entry.filename, size: entry.size } };
}

/**
 * Holt eine hochgeladene Datei und verbraucht sie. owner muss zur Sitzung passen,
 * die den Upload angelegt hat – eine fremde Sitzung kann ihn nicht abgreifen.
 */
export function takeUpload(id, owner) {
  sweep();
  const entry = uploads.get(String(id || ''));
  if (!entry || (entry.owner ?? null) !== (owner ?? null)) throw new Error(`Upload ${id} nicht gefunden oder abgelaufen`);
  if (!entry.file) throw new Error(`Upload ${id} ist noch leer – erst die Datei an die upload_url schicken (curl -T datei <upload_url>)`);
  const buf = fs.readFileSync(entry.file);
  removeFile(entry);
  uploads.delete(entry.id);
  return { filename: entry.filename, mimetype: entry.mimetype, buffer: buf };
}
