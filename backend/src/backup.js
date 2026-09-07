// Sicherung und Umzug des kompletten Datenverzeichnisses als EIN .tgz.
//
// Enthalten: manifest.json, mail.db (konsistente Kopie inkl. WAL-Inhalt),
// .keyfile, attachments/, assets/, whatsapp/ (Sitzungen + Medien).
// Nicht enthalten: mail.db-wal/-shm, restore-*, *.tmp, session.lock.
//
// Dieses Modul importiert BEWUSST NICHT db.js: es muss laufen, bevor die
// Datenbank geöffnet ist (restore-boot.js beim Start) – und db.js würde beim
// Import sofort mail.db anlegen und den Schlüssel ermitteln. encrypt/decrypt
// sind deshalb hier in identischem Format nachgebaut (AES-256-GCM,
// „iv:tag:enc" jeweils base64).
//
// Tar-Format: eigener kleiner ustar-Writer/-Reader (512-Byte-Header, Prefix
// für lange Namen, kein Pax). Der Reader versteht zusätzlich Pax-Pfade, falls
// jemand das Archiv mit bsdtar/GNU tar neu gepackt hat.
//
// Aufruf als CLI:
//   node src/backup.js export [datei|-] [--no-media]
//   node src/backup.js import <datei> [--force]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { DATA_DIR } from './paths.js';

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const BLOCK = 512;
const ARCHIVE_VERSION = 1;

/** Erlaubte Einträge auf oberster Ebene – alles andere wird beim Lesen abgewiesen. */
const TOP_FILES = new Set(['manifest.json', 'mail.db', '.keyfile']);
const TOP_DIRS = new Set(['attachments', 'assets', 'whatsapp']);
/** Was beim Tausch bewegt wird (bestehender Inhalt → restore-prev-*). */
const SWAP_ENTRIES = ['mail.db', 'mail.db-wal', 'mail.db-shm', '.keyfile', 'attachments', 'assets', 'whatsapp'];

const log = (...a) => console.error('[backup]', ...a);

// ---- Schlüssel & Kryptografie (Spiegel von db.js) -------------------------

export function keyFingerprint(keyHex) {
  if (!keyHex) return null;
  return crypto.createHash('sha256').update(Buffer.from(keyHex, 'hex')).digest('hex').slice(0, 16);
}

function isKeyHex(s) { return typeof s === 'string' && /^[0-9a-fA-F]{64}$/.test(s); }

/** Liest den Schlüssel so wie db.js: env vor .keyfile. Ohne beides → null. */
export function currentKeyHex(dataDir = DATA_DIR) {
  const env = process.env.MAIL_CRYPTO_KEY;
  if (env) {
    if (!isKeyHex(env)) throw new Error('MAIL_CRYPTO_KEY muss 64 Hex-Zeichen (32 Bytes) sein');
    return env.toLowerCase();
  }
  const file = path.join(dataDir, '.keyfile');
  if (!fs.existsSync(file)) return null;
  const hex = fs.readFileSync(file, 'utf8').trim();
  if (!isKeyHex(hex)) throw new Error(`${file} enthält keinen gültigen Schlüssel`);
  return hex.toLowerCase();
}

function encryptWith(keyHex, plain) {
  if (plain == null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

function decryptWith(keyHex, blob) {
  if (!blob) return '';
  const [iv, tag, enc] = String(blob).split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(enc, 'base64')), decipher.final()]).toString('utf8');
}

// ---- Tar-Writer (ustar) ---------------------------------------------------

function octal(n, len) {
  // len Zeichen inkl. abschließendem NUL: len-1 Oktalziffern.
  const s = Math.max(0, Math.floor(n)).toString(8);
  if (s.length > len - 1) throw new Error(`Wert ${n} passt nicht in ein ${len}-Byte-Oktalfeld`);
  return s.padStart(len - 1, '0') + '\0';
}

/** Teilt einen Pfad in ustar name (≤100) und prefix (≤155). */
function splitName(name) {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: '' };
  // Am letzten '/' trennen, das beide Grenzen einhält.
  let i = name.length;
  while ((i = name.lastIndexOf('/', i - 1)) > 0) {
    const prefix = name.slice(0, i);
    const rest = name.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100 && rest.length) return { name: rest, prefix };
  }
  return null; // passt nicht in ustar – der Aufrufer schreibt einen PAX-Header davor
}

/**
 * PAX-Erweiterungssatz (Typ 'x') für Namen, die ustar nicht fasst: ein
 * eigener Eintrag mit „<len> path=<name>\n" direkt vor dem eigentlichen Header.
 * Unser Reader (und jedes GNU-/BSD-tar) versteht das.
 */
function paxHeaderFor(name) {
  const body = `path=${name}\n`;
  // Die Längenangabe zählt sich selbst mit – deshalb zwei Durchläufe.
  let len = Buffer.byteLength(body) + 3;
  len = String(len).length + 1 + Buffer.byteLength(body);
  const record = Buffer.from(`${len} ${body}`, 'utf8');
  const stub = name.slice(0, 60).replace(/[^\w.\-]/g, '_');
  const header = rawTarHeader({ name: `PaxHeader/${stub}`, prefix: '', size: record.length, type: 'x' });
  return Buffer.concat([header, record, padBlock(record.length)]);
}

function tarHeader({ name, size = 0, mode = FILE_MODE, mtime = Date.now() / 1000, type = '0' }) {
  const split = splitName(name);
  if (split) return rawTarHeader({ name: split.name, prefix: split.prefix, size, mode, mtime, type });
  // Zu lang für ustar: PAX-Header voran, im ustar-Feld nur ein gekürzter Platzhalter.
  const short = name.slice(-100);
  return Buffer.concat([paxHeaderFor(name), rawTarHeader({ name: short, prefix: '', size, mode, mtime, type })]);
}

function rawTarHeader({ name: n, prefix = '', size = 0, mode = FILE_MODE, mtime = Date.now() / 1000, type = '0' }) {
  const h = Buffer.alloc(BLOCK, 0);
  h.write(n, 0, 100, 'utf8');
  h.write(octal(mode & 0o7777, 8), 100, 8, 'latin1');
  h.write(octal(0, 8), 108, 8, 'latin1');          // uid
  h.write(octal(0, 8), 116, 8, 'latin1');          // gid
  h.write(octal(size, 12), 124, 12, 'latin1');
  h.write(octal(mtime, 12), 136, 12, 'latin1');
  h.write('        ', 148, 8, 'latin1');           // Checksumme: erst Leerzeichen
  h.write(type, 156, 1, 'latin1');
  h.write('ustar\0', 257, 6, 'latin1');
  h.write('00', 263, 2, 'latin1');
  h.write('mail', 265, 32, 'latin1');
  h.write('mail', 297, 32, 'latin1');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1');
  return h;
}

function padBlock(size) {
  const rest = size % BLOCK;
  return rest ? Buffer.alloc(BLOCK - rest, 0) : Buffer.alloc(0);
}

/** Sammelt Dateien unterhalb eines Verzeichnisses (relativ, mit '/'). */
function collectFiles(baseDir, rel, out, { skip = () => false } = {}) {
  const abs = path.join(baseDir, rel);
  let st;
  try { st = fs.lstatSync(abs); } catch { return; }
  if (skip(rel, st)) return;
  if (st.isDirectory()) {
    out.push({ rel, type: '5', mode: DIR_MODE, mtime: st.mtimeMs / 1000, size: 0 });
    for (const name of fs.readdirSync(abs).sort()) collectFiles(baseDir, rel ? `${rel}/${name}` : name, out, { skip });
  } else if (st.isFile()) {
    out.push({ rel, type: '0', mode: FILE_MODE, mtime: st.mtimeMs / 1000, size: st.size, abs });
  }
  // Symlinks, Sockets usw. werden bewusst übergangen.
}

/** Konsistente Kopie der Datenbank inkl. WAL-Inhalt nach tmpPath. */
async function snapshotDatabase(dbPath, tmpPath) {
  fs.rmSync(tmpPath, { force: true });
  const src = new DatabaseSync(dbPath, { readOnly: true });
  try {
    try {
      await sqliteBackup(src, tmpPath);
    } catch (e) {
      // Ältere Node-Version ohne backup(): VACUUM INTO liefert dieselbe Garantie.
      log(`backup() nicht nutzbar (${e.message}) – VACUUM INTO`);
      fs.rmSync(tmpPath, { force: true });
      src.exec(`VACUUM INTO '${tmpPath.replace(/'/g, "''")}'`);
    }
  } finally {
    src.close();
  }
  fs.chmodSync(tmpPath, FILE_MODE);
}

/**
 * Schreibt das Archiv nach dest (Writable-Stream oder Dateipfad).
 * Erzeugt eine temporäre DB-Kopie im Datenverzeichnis und räumt sie auf.
 */
export async function writeArchive(dest, { dataDir = DATA_DIR, includeMedia = true } = {}) {
  const dbPath = path.join(dataDir, 'mail.db');
  if (!fs.existsSync(dbPath)) throw new Error(`Keine Datenbank unter ${dbPath}`);
  const keyHex = currentKeyHex(dataDir);
  const keyfile = path.join(dataDir, '.keyfile');
  const includesKeyfile = fs.existsSync(keyfile);

  const tmpDb = path.join(dataDir, `restore-snapshot-${process.pid}-${Date.now()}.tmp`);
  await snapshotDatabase(dbPath, tmpDb);

  const manifest = {
    version: ARCHIVE_VERSION,
    created_at: new Date().toISOString(),
    app: 'mail-server',
    key_fingerprint: keyFingerprint(keyHex),
    includes_keyfile: includesKeyfile,
    includes_media: includeMedia,
  };

  // Reihenfolge: Manifest und DB zuerst – inspectArchive kann dann früh abbrechen.
  const entries = [];
  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  entries.push({ rel: 'manifest.json', type: '0', mode: FILE_MODE, mtime: Date.now() / 1000, size: manifestBuf.length, buffer: manifestBuf });
  entries.push({ rel: 'mail.db', type: '0', mode: FILE_MODE, mtime: Date.now() / 1000, size: fs.statSync(tmpDb).size, abs: tmpDb });
  if (includesKeyfile) {
    const st = fs.statSync(keyfile);
    entries.push({ rel: '.keyfile', type: '0', mode: FILE_MODE, mtime: st.mtimeMs / 1000, size: st.size, abs: keyfile });
  }
  const skip = (rel) => {
    if (!includeMedia && (rel === 'whatsapp/media' || rel.startsWith('whatsapp/media/'))) return true;
    if (rel.endsWith('.tmp') || path.basename(rel) === 'session.lock') return true;
    return false;
  };
  for (const dir of TOP_DIRS) collectFiles(dataDir, dir, entries, { skip });

  // Tar → gzip → dest. Der Tar-Strom wird stückweise erzeugt, damit auch
  // große Medienordner nicht im Speicher landen.
  async function* tarChunks() {
    for (const e of entries) {
      yield tarHeader({ name: e.rel, size: e.size, mode: e.mode, mtime: e.mtime, type: e.type });
      if (e.type !== '0') continue;
      if (e.buffer) { yield e.buffer; yield padBlock(e.size); continue; }
      // Größe beim Header festgehalten: wächst die Datei währenddessen, wird
      // exakt e.size übertragen – tar bleibt konsistent.
      let remaining = e.size;
      if (remaining > 0) {
        for await (const chunk of fs.createReadStream(e.abs, { end: e.size - 1 })) {
          if (chunk.length > remaining) { yield chunk.subarray(0, remaining); remaining = 0; break; }
          remaining -= chunk.length;
          yield chunk;
        }
      }
      if (remaining > 0) yield Buffer.alloc(remaining, 0); // Datei wurde zwischenzeitlich gekürzt
      yield padBlock(e.size);
    }
    yield Buffer.alloc(BLOCK * 2, 0); // Ende-Markierung
  }

  const out = typeof dest === 'string' ? fs.createWriteStream(dest, { mode: FILE_MODE }) : dest;
  try {
    await pipeline(Readable.from(tarChunks()), zlib.createGzip({ level: 6 }), out);
  } finally {
    fs.rmSync(tmpDb, { force: true });
  }
  return manifest;
}

// ---- Tar-Reader -----------------------------------------------------------

/** Liest exakt n Bytes aus einem asynchronen Chunk-Strom. */
class ChunkReader {
  constructor(iterable) { this.it = iterable[Symbol.asyncIterator](); this.buf = Buffer.alloc(0); this.done = false; }
  async fill(n) {
    while (this.buf.length < n && !this.done) {
      const { value, done } = await this.it.next();
      if (done) { this.done = true; break; }
      this.buf = this.buf.length ? Buffer.concat([this.buf, value]) : value;
    }
  }
  /** Liefert genau n Bytes oder null am Ende. */
  async read(n) {
    await this.fill(n);
    if (this.buf.length < n) {
      if (this.buf.length === 0) return null;
      throw new Error('Archiv endet unerwartet');
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
  /** Reicht n Bytes stückweise an sink weiter. */
  async pipe(n, sink) {
    let remaining = n;
    while (remaining > 0) {
      if (this.buf.length === 0) await this.fill(1);
      if (this.buf.length === 0) throw new Error('Archiv endet unerwartet');
      const take = Math.min(remaining, this.buf.length);
      await sink(this.buf.subarray(0, take));
      this.buf = this.buf.subarray(take);
      remaining -= take;
    }
  }
  async skip(n) { await this.pipe(n, () => {}); }
  async close() { try { await this.it.return?.(); } catch { /* egal */ } }
}

function parseOctal(buf) {
  const s = buf.toString('latin1').replace(/\0.*$/s, '').trim();
  if (!s) return 0;
  // GNU base-256 (führendes 0x80) für sehr große Dateien.
  if (buf[0] & 0x80) {
    let n = 0;
    for (let i = 1; i < buf.length; i++) n = n * 256 + buf[i];
    return n;
  }
  const n = parseInt(s, 8);
  if (!Number.isFinite(n)) throw new Error('Ungültiges Zahlenfeld im Tar-Header');
  return n;
}

function cstr(buf) {
  const i = buf.indexOf(0);
  return (i === -1 ? buf : buf.subarray(0, i)).toString('utf8');
}

/**
 * Prüft einen Archivpfad und liefert ihn normalisiert zurück.
 * Erlaubt sind ausschließlich die bekannten Namen auf oberster Ebene.
 */
export function validateArchivePath(raw) {
  let name = String(raw || '');
  if (name.startsWith('./')) name = name.slice(2);
  name = name.replace(/\/+$/, '');
  const bad = () => new Error(`Archiv enthält unerlaubten Pfad: ${JSON.stringify(raw)}`);
  if (!name || name.startsWith('/') || name.includes('\\') || name.includes('\0')) throw bad();
  const parts = name.split('/');
  if (parts.some(p => p === '' || p === '.' || p === '..')) throw bad();
  const top = parts[0];
  if (parts.length === 1) {
    if (!TOP_FILES.has(top) && !TOP_DIRS.has(top)) throw bad();
  } else if (!TOP_DIRS.has(top)) {
    throw bad();
  }
  return name;
}

/**
 * Liest ein Archiv sequenziell. Jeder Eintrag: { name, type ('0'|'5'), size,
 * mode, mtime, writeTo(path), buffer(), skip() }. GENAU EINE dieser drei
 * Methoden muss pro Datei-Eintrag aufgerufen werden, bevor der nächste
 * Eintrag angefordert wird – der Strom wird nicht zwischengespeichert.
 */
export async function* readArchive(file) {
  const reader = new ChunkReader(fs.createReadStream(file).pipe(zlib.createGunzip()));
  let paxPath = null;
  try {
    for (;;) {
      const h = await reader.read(BLOCK);
      if (!h) return;
      if (h.every(b => b === 0)) return; // Ende-Markierung

      // Checksumme: Feld 148-156 zählt als Leerzeichen.
      let sum = 0;
      for (let i = 0; i < BLOCK; i++) sum += (i >= 148 && i < 156) ? 32 : h[i];
      if (parseOctal(h.subarray(148, 156)) !== sum) throw new Error('Archiv beschädigt (Tar-Prüfsumme)');

      const size = parseOctal(h.subarray(124, 136));
      const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
      const magic = h.subarray(257, 262).toString('latin1');
      const prefix = magic === 'ustar' ? cstr(h.subarray(345, 500)) : '';
      let rawName = cstr(h.subarray(0, 100));
      if (prefix) rawName = `${prefix}/${rawName}`;
      const padded = Math.ceil(size / BLOCK) * BLOCK;

      if (type === 'x' || type === 'g') {
        // Pax-Erweiterung: nur „path" ist für uns relevant.
        const body = (await reader.read(padded)).subarray(0, size).toString('utf8');
        for (const rec of body.split('\n')) {
          const m = rec.match(/^\d+ path=(.*)$/);
          if (m && type === 'x') paxPath = m[1];
        }
        continue;
      }
      if (type === 'L') { // GNU-Langname
        paxPath = cstr((await reader.read(padded)).subarray(0, size));
        continue;
      }
      if (type !== '0' && type !== '5') throw new Error(`Archiv enthält unerlaubten Eintragstyp "${type}" (${rawName})`);

      const wanted = paxPath ?? rawName;
      paxPath = null;
      // macOS-tar legt Metadaten als „._name"/.DS_Store ab – still übergehen,
      // damit ein von Hand neu gepacktes Archiv trotzdem einspielbar bleibt.
      const base = path.posix.basename(wanted.replace(/\/+$/, ''));
      if (base.startsWith('._') || base === '.DS_Store') { await reader.skip(padded); continue; }
      // Wurzeleintrag „./" (tar -C dir .) trägt nichts bei.
      if (type === '5' && /^\.?\/*$/.test(wanted)) continue;
      const name = validateArchivePath(wanted);
      if (type === '5' && !TOP_DIRS.has(name.split('/')[0])) {
        throw new Error(`Archiv enthält unerlaubten Pfad: ${JSON.stringify(rawName)}`);
      }
      if (type === '0' && !name.includes('/') && !TOP_FILES.has(name)) {
        throw new Error(`Archiv enthält unerlaubten Pfad: ${JSON.stringify(rawName)}`);
      }

      let consumed = type !== '0';
      const entry = {
        name, type, size,
        mode: parseOctal(h.subarray(100, 108)) & 0o7777,
        mtime: parseOctal(h.subarray(136, 148)),
        async skip() { if (consumed) return; consumed = true; await reader.skip(padded); },
        async buffer() {
          if (consumed) throw new Error('Eintrag bereits gelesen');
          consumed = true;
          const b = await reader.read(padded);
          return Buffer.from(b.subarray(0, size));
        },
        async writeTo(dest) {
          if (consumed) throw new Error('Eintrag bereits gelesen');
          consumed = true;
          const fd = fs.openSync(dest, 'w', FILE_MODE);
          try {
            await reader.pipe(size, chunk => { fs.writeSync(fd, chunk); });
          } finally { fs.closeSync(fd); }
          await reader.skip(padded - size);
        },
      };
      yield entry;
      if (!consumed) await entry.skip();
    }
  } finally {
    await reader.close();
  }
}

/** Vorprüfung: Manifest lesen und feststellen, ob mail.db enthalten ist. */
export async function inspectArchive(file) {
  let manifest = null;
  let hasDb = false;
  let hasKeyfile = false;
  for await (const e of readArchive(file)) {
    if (e.name === 'manifest.json' && e.type === '0') {
      if (e.size > 1_000_000) throw new Error('manifest.json ist unplausibel groß');
      try { manifest = JSON.parse((await e.buffer()).toString('utf8')); }
      catch { throw new Error('manifest.json ist kein gültiges JSON'); }
    } else if (e.name === 'mail.db' && e.type === '0') {
      hasDb = true;
    } else if (e.name === '.keyfile' && e.type === '0') {
      hasKeyfile = true;
    }
    // Unser Writer legt Manifest, DB und Keyfile ganz vorn ab – danach kommt
    // nur noch Nutzlast, die wir hier nicht mehr durchlesen müssen.
    if (manifest && hasDb && (hasKeyfile || manifest.includes_keyfile === false)) break;
  }
  if (!manifest || manifest.app !== 'mail-server' || typeof manifest.version !== 'number') {
    throw new Error('Kein gültiges mail-server-Archiv (manifest.json fehlt oder ist fremd)');
  }
  if (manifest.version > ARCHIVE_VERSION) {
    throw new Error(`Archiv-Version ${manifest.version} ist neuer als diese Installation (${ARCHIVE_VERSION})`);
  }
  if (!hasDb) throw new Error('Archiv enthält keine mail.db');
  return { manifest, hasDb, hasKeyfile };
}

// ---- Umschlüsselung -------------------------------------------------------

/** Spalten mit AES-verschlüsselten Werten, die beim Schlüsselwechsel umzuschreiben sind. */
const ENC_COLUMNS = [
  { table: 'accounts', pk: 'id', cols: ['password_enc', 'carddav_password_enc', 'imap_password_enc'], onFail: 'null' },
  { table: 'github_connections', pk: 'id', cols: ['token_enc'], onFail: 'null' },
  { table: 'service_secrets', pk: 'name', cols: ['value_enc'], onFail: 'delete' },
];

/**
 * Schreibt alle verschlüsselten Werte von oldKeyHex auf newKeyHex um.
 * Nicht entschlüsselbare Werte werden protokolliert und geleert (bzw. die
 * Zeile gelöscht) – der Import darf daran nicht scheitern.
 */
export function reencryptDatabase(dbPath, oldKeyHex, newKeyHex, { warnings = [] } = {}) {
  const db = new DatabaseSync(dbPath);
  let count = 0;
  try {
    db.exec('PRAGMA busy_timeout = 5000;');
    const tableCols = table => {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return null;
      return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name));
    };
    db.exec('BEGIN');
    for (const spec of ENC_COLUMNS) {
      const present = tableCols(spec.table);
      if (!present) continue;
      const cols = spec.cols.filter(c => present.has(c));
      if (!cols.length) continue;
      const rows = db.prepare(`SELECT ${spec.pk} AS pk, ${cols.join(', ')} FROM ${spec.table}`).all();
      for (const row of rows) {
        const sets = [];
        const vals = [];
        let broken = false;
        for (const col of cols) {
          const v = row[col];
          if (v == null || v === '') continue;
          try {
            sets.push(`${col}=?`);
            vals.push(encryptWith(newKeyHex, decryptWith(oldKeyHex, v)));
            count++;
          } catch {
            sets.pop();
            broken = true;
            warnings.push(`${spec.table}[${row.pk}].${col}: nicht entschlüsselbar – ${spec.onFail === 'delete' ? 'Zeile gelöscht' : 'auf NULL gesetzt'}`);
            if (spec.onFail !== 'delete') { sets.push(`${col}=NULL`); }
          }
        }
        if (broken && spec.onFail === 'delete') {
          db.prepare(`DELETE FROM ${spec.table} WHERE ${spec.pk}=?`).run(row.pk);
          continue;
        }
        if (sets.length) db.prepare(`UPDATE ${spec.table} SET ${sets.join(', ')} WHERE ${spec.pk}=?`).run(...vals, row.pk);
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* egal */ }
    throw e;
  } finally {
    db.close();
  }
  // Die Kopie kann im WAL-Modus sein – nach dem Schließen sind -wal/-shm
  // eingearbeitet; Reste räumen wir sicherheitshalber weg.
  for (const s of ['-wal', '-shm']) fs.rmSync(dbPath + s, { force: true });
  return count;
}

// ---- Wiederherstellung ----------------------------------------------------

function writeResult(dataDir, result) {
  const file = path.join(dataDir, 'restore-last.json');
  try { fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n', { mode: FILE_MODE }); }
  catch (e) { log(`restore-last.json nicht schreibbar: ${e.message}`); }
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/** Löscht alle restore-prev-* außer dem angegebenen; ebenso liegengebliebene restore-tmp-*. */
function pruneRestoreDirs(dataDir, keep) {
  for (const name of fs.readdirSync(dataDir)) {
    const full = path.join(dataDir, name);
    if (full === keep) continue;
    if (name.startsWith('restore-prev-') || name.startsWith('restore-tmp-')) {
      try { fs.rmSync(full, { recursive: true, force: true }); log(`aufgeräumt: ${name}`); }
      catch (e) { log(`${name} nicht löschbar: ${e.message}`); }
    }
  }
}

/**
 * Spielt ein Archiv in dataDir ein: entpacken, ggf. umschlüsseln, tauschen.
 * Der bisherige Bestand wandert nach restore-prev-<ts>/ (nur der jüngste bleibt).
 * Schreibt restore-last.json und liefert dasselbe Ergebnisobjekt zurück;
 * bei Fehlern wird geworfen (restore-last.json steht dann auf ok:false).
 */
export async function restoreArchive(file, { dataDir = DATA_DIR, newKeyHex = process.env.MAIL_CRYPTO_KEY } = {}) {
  const ts = stamp();
  const warnings = [];
  const result = { at: new Date().toISOString(), ok: false, message: '', reencrypted: 0, warnings };
  const tmp = path.join(dataDir, `restore-tmp-${ts}`);
  const prev = path.join(dataDir, `restore-prev-${ts}`);
  fs.mkdirSync(dataDir, { recursive: true, mode: DIR_MODE });

  try {
    // 1. Entpacken in ein Arbeitsverzeichnis.
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { mode: DIR_MODE });
    let manifest = null;
    for await (const e of readArchive(file)) {
      const dest = path.join(tmp, e.name);
      if (e.type === '5') { fs.mkdirSync(dest, { recursive: true, mode: DIR_MODE }); continue; }
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: DIR_MODE });
      if (e.name === 'manifest.json') {
        const buf = await e.buffer();
        try { manifest = JSON.parse(buf.toString('utf8')); } catch { throw new Error('manifest.json ist kein gültiges JSON'); }
        fs.writeFileSync(dest, buf, { mode: FILE_MODE });
        continue;
      }
      await e.writeTo(dest);
    }
    if (!manifest || manifest.app !== 'mail-server') throw new Error('Kein gültiges mail-server-Archiv (manifest.json fehlt)');
    if ((manifest.version || 0) > ARCHIVE_VERSION) throw new Error(`Archiv-Version ${manifest.version} wird nicht unterstützt`);
    const tmpDb = path.join(tmp, 'mail.db');
    if (!fs.existsSync(tmpDb)) throw new Error('Archiv enthält keine mail.db');

    // 2. Datenbank kurz prüfen.
    {
      const check = new DatabaseSync(tmpDb, { readOnly: true });
      try {
        const r = check.prepare('PRAGMA quick_check').get();
        const verdict = r ? Object.values(r)[0] : 'unbekannt';
        if (verdict !== 'ok') throw new Error(`mail.db im Archiv ist beschädigt: ${verdict}`);
      } finally { check.close(); }
    }

    // 3. Schlüssel bestimmen.
    const tmpKeyfile = path.join(tmp, '.keyfile');
    let oldKeyHex = null;
    if (fs.existsSync(tmpKeyfile)) {
      const hex = fs.readFileSync(tmpKeyfile, 'utf8').trim().toLowerCase();
      if (!isKeyHex(hex)) throw new Error('.keyfile im Archiv ist ungültig');
      oldKeyHex = hex;
    }
    let keySource;
    if (newKeyHex) {
      if (!isKeyHex(newKeyHex)) throw new Error('MAIL_CRYPTO_KEY muss 64 Hex-Zeichen (32 Bytes) sein');
      newKeyHex = newKeyHex.toLowerCase();
      keySource = 'env';
    } else {
      const existing = path.join(dataDir, '.keyfile');
      if (fs.existsSync(existing)) {
        const hex = fs.readFileSync(existing, 'utf8').trim().toLowerCase();
        if (!isKeyHex(hex)) throw new Error(`${existing} enthält keinen gültigen Schlüssel`);
        newKeyHex = hex;
        keySource = 'keyfile';
      } else if (oldKeyHex) {
        newKeyHex = oldKeyHex;
        keySource = 'archive';
      } else {
        throw new Error('Archiv ohne Schlüssel und kein MAIL_CRYPTO_KEY/.keyfile vorhanden – Passwörter nicht lesbar');
      }
    }
    if (!oldKeyHex) {
      // Ohne Keyfile im Archiv muss der Fingerabdruck zum neuen Schlüssel passen.
      if (manifest.key_fingerprint && manifest.key_fingerprint === keyFingerprint(newKeyHex)) {
        oldKeyHex = newKeyHex;
      } else {
        throw new Error('Archiv ohne Schlüssel, Passwörter nicht lesbar (key_fingerprint passt nicht zu MAIL_CRYPTO_KEY/.keyfile)');
      }
    } else if (manifest.key_fingerprint && manifest.key_fingerprint !== keyFingerprint(oldKeyHex)) {
      warnings.push('key_fingerprint im Manifest passt nicht zur .keyfile im Archiv – .keyfile wird verwendet');
    }

    // 4. Umschlüsseln, falls nötig.
    if (oldKeyHex !== newKeyHex) {
      log(`Schlüssel unterscheiden sich (${keyFingerprint(oldKeyHex)} → ${keyFingerprint(newKeyHex)}) – schlüssle um`);
      result.reencrypted = reencryptDatabase(tmpDb, oldKeyHex, newKeyHex, { warnings });
      log(`${result.reencrypted} Werte umgeschlüsselt${warnings.length ? `, ${warnings.length} Warnung(en)` : ''}`);
    }
    for (const s of ['-wal', '-shm']) fs.rmSync(tmpDb + s, { force: true });

    // 5. Tausch: Bestand nach restore-prev-<ts>, Archivinhalt an Ort und Stelle.
    fs.mkdirSync(prev, { mode: DIR_MODE });
    let moved = 0;
    for (const name of SWAP_ENTRIES) {
      const from = path.join(dataDir, name);
      if (!fs.existsSync(from)) continue;
      fs.renameSync(from, path.join(prev, name));
      moved++;
    }
    for (const name of ['mail.db', ...TOP_DIRS]) {
      const from = path.join(tmp, name);
      if (fs.existsSync(from)) fs.renameSync(from, path.join(dataDir, name));
    }
    if (keySource !== 'env') {
      // db.js bevorzugt MAIL_CRYPTO_KEY; nur ohne env ist die Datei maßgeblich.
      fs.writeFileSync(path.join(dataDir, '.keyfile'), newKeyHex, { mode: FILE_MODE });
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!moved) { try { fs.rmdirSync(prev); } catch { /* egal */ } }
    pruneRestoreDirs(dataDir, prev);

    result.ok = true;
    result.message = `Wiederhergestellt aus Archiv vom ${manifest.created_at || '?'}`
      + (result.reencrypted ? `, ${result.reencrypted} Werte umgeschlüsselt` : '')
      + (moved ? `; vorheriger Stand in ${path.basename(prev)}` : '');
    result.manifest = manifest;
    result.prev_dir = moved ? path.basename(prev) : null;
    writeResult(dataDir, result);
    return result;
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    result.ok = false;
    result.message = e.message;
    writeResult(dataDir, result);
    throw e;
  }
}

// ---- Hilfen für Status-Anzeige --------------------------------------------

/** Größe des Datenverzeichnisses in Bytes (ohne restore-prev-*). */
export function dataDirBytes(dataDir = DATA_DIR) {
  let total = 0;
  const walk = dir => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (dir === dataDir && e.name.startsWith('restore-prev-')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { try { total += fs.statSync(p).size; } catch { /* egal */ } }
    }
  };
  walk(dataDir);
  return total;
}

export function readLastResult(dataDir = DATA_DIR) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'restore-last.json'), 'utf8')); }
  catch { return null; }
}

export function defaultArchiveName(date = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `mail-server-backup-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}.tgz`;
}

// ---- CLI ------------------------------------------------------------------

async function cli(argv) {
  const [cmd, ...rest] = argv;
  const flags = new Set(rest.filter(a => a.startsWith('--')));
  const args = rest.filter(a => !a.startsWith('--'));

  if (cmd === 'export') {
    const target = args[0] || defaultArchiveName();
    const includeMedia = !flags.has('--no-media');
    if (target === '-') {
      await writeArchive(process.stdout, { includeMedia });
      log('Archiv nach stdout geschrieben');
    } else {
      const dest = path.resolve(target);
      await writeArchive(dest, { includeMedia });
      const mb = (fs.statSync(dest).size / 1048576).toFixed(1);
      log(`Archiv geschrieben: ${dest} (${mb} MB${includeMedia ? '' : ', ohne WhatsApp-Medien'})`);
    }
    return 0;
  }

  if (cmd === 'import') {
    const file = args[0];
    if (!file) { log('Aufruf: node src/backup.js import <datei> [--force]'); return 2; }
    if (!fs.existsSync(file)) { log(`Datei nicht gefunden: ${file}`); return 2; }
    const wal = path.join(DATA_DIR, 'mail.db-wal');
    if (!flags.has('--force')) {
      // Der Server schließt die DB beim Beenden nicht explizit – die WAL bleibt
      // dann gefüllt zurück. Ein Checkpoint räumt sie auf, wenn niemand sonst
      // darauf arbeitet; bleibt sie danach voll, läuft noch ein Prozess.
      let walSize = 0;
      try { walSize = fs.statSync(wal).size; } catch { /* keine WAL */ }
      if (walSize > 0 && fs.existsSync(path.join(DATA_DIR, 'mail.db'))) {
        try {
          const d = new DatabaseSync(path.join(DATA_DIR, 'mail.db'));
          try { d.exec('PRAGMA busy_timeout = 1000; PRAGMA wal_checkpoint(TRUNCATE);'); } finally { d.close(); }
        } catch { /* unten entscheidet die WAL-Größe */ }
        try { walSize = fs.statSync(wal).size; } catch { walSize = 0; }
      }
      if (walSize > 0) {
        log(`${wal} ist nicht leer – der Server läuft vermutlich. Bitte stoppen (oder --force).`);
        return 3;
      }
    }
    log(`Stelle ${path.resolve(file)} nach ${DATA_DIR} wieder her …`);
    try {
      const r = await restoreArchive(file);
      log(r.message);
      for (const w of r.warnings) log('Warnung:', w);
      return 0;
    } catch (e) {
      log('Fehler:', e.message);
      return 1;
    }
  }

  log('Aufruf:\n  node src/backup.js export [datei|-] [--no-media]\n  node src/backup.js import <datei> [--force]');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  cli(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { log('Fehler:', e.message); process.exitCode = 1; });
}
