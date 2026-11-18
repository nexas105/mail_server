// Brain: Markdown-Notizen als echte Dateien – allgemein und je Projekt.
//
//   data/brain/allgemein/…            Wissen, das überall gilt (Stil, Abläufe, Personen)
//   data/brain/projekte/<projekt>/…   Je Projekt ein Ordner, README.md = Überblick
//   data/brain/.papierkorb/…          Gelöschtes, mit Zeitstempel (nicht in Listen)
//
// Echte .md-Dateien statt Datenbankzeilen: lesbar ohne App, im Backup enthalten
// (backup.js TOP_DIRS) und von MCP-Prozess und Web-Server gleichermaßen nutzbar.
// Geschrieben wird atomar (tmp + rename), damit ein gleichzeitiger Leser nie eine
// halbe Datei sieht. Konflikte zwischen UI und KI fängt `if_match` (etag) ab.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

export const BRAIN_DIR = path.join(DATA_DIR, 'brain');
const GENERAL = 'allgemein';
const PROJECTS = 'projekte';
const TRASH = '.papierkorb';
const MAX_BYTES = 1024 * 1024;
const SEGMENT = /^[\p{L}\p{N}][\p{L}\p{N} ._()&+-]{0,100}$/u;

function ensureBase() {
  for (const d of [BRAIN_DIR, path.join(BRAIN_DIR, GENERAL), path.join(BRAIN_DIR, PROJECTS)]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  }
}

/** Projektname → Ordnername. */
export const slugify = name => String(name || '').trim()
  .toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

/**
 * Prüft und normalisiert einen Pfad relativ zu brain/. Erlaubt sind nur Dateien
 * unter allgemein/ oder projekte/<projekt>/, nur .md, keine versteckten Teile.
 */
export function cleanPath(input, { dir = false } = {}) {
  let p = String(input || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
  if (!dir && p && !p.toLowerCase().endsWith('.md')) p += '.md';
  const parts = p.split('/').filter(Boolean);
  if (!parts.length && dir) return '';
  if (!parts.length) throw new Error('Pfad fehlt');
  for (const s of parts) {
    if (!SEGMENT.test(s) || s === '.' || s === '..') throw new Error(`Ungültiger Pfadteil "${s}" – erlaubt sind Buchstaben, Ziffern, Leerzeichen und . _ - ( ) & +`);
  }
  if (parts[0] !== GENERAL && parts[0] !== PROJECTS) {
    throw new Error(`Pfad muss mit "${GENERAL}/" oder "${PROJECTS}/<projekt>/" beginnen`);
  }
  if (!dir && parts[0] === PROJECTS && parts.length < 3) throw new Error(`Projektdateien liegen unter "${PROJECTS}/<projekt>/datei.md"`);
  const rel = parts.join('/');
  const abs = path.join(BRAIN_DIR, rel);
  if (!abs.startsWith(BRAIN_DIR + path.sep)) throw new Error('Pfad außerhalb von brain/');
  return rel;
}
const absOf = rel => path.join(BRAIN_DIR, rel);
const etagOf = buf => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);

/** Erste Überschrift bzw. erste Textzeile als Titel. */
function titleOf(content) {
  for (const line of String(content).split('\n').slice(0, 30)) {
    const t = line.trim();
    if (!t || t === '---') continue;
    return t.replace(/^#+\s*/, '').slice(0, 120);
  }
  return '';
}

function fileInfo(rel, { withTitle = true } = {}) {
  const abs = absOf(rel);
  const st = fs.statSync(abs);
  const info = { path: rel, size: st.size, updated_at: st.mtime.toISOString() };
  if (withTitle) info.title = titleOf(fs.readFileSync(abs, 'utf8').slice(0, 4000));
  return info;
}

function walk(relDir, out = []) {
  const abs = absOf(relDir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const rel = relDir ? `${relDir}/${e.name}` : e.name;
    if (e.isDirectory()) walk(rel, out);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(rel);
  }
  return out;
}

/** Alle Dateien unter einem Ordner (Standard: alles), sortiert. */
export function listFiles(dir = '') {
  ensureBase();
  const rel = cleanPath(dir, { dir: true });
  return walk(rel).sort((a, b) => a.localeCompare(b, 'de')).map(p => fileInfo(p));
}

/** Projekte mit Beschreibung (aus README.md) und Dateizahl. */
export function listProjects() {
  ensureBase();
  const base = absOf(PROJECTS);
  return fs.readdirSync(base, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => {
      const rel = `${PROJECTS}/${e.name}`;
      const files = walk(rel);
      const readme = files.find(f => /\/readme\.md$/i.test(f) && f.split('/').length === 3);
      let description = '';
      if (readme) {
        const lines = fs.readFileSync(absOf(readme), 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
        description = (lines.find(l => !l.startsWith('#')) || '').slice(0, 200);
      }
      const updated = files.reduce((m, f) => Math.max(m, fs.statSync(absOf(f)).mtimeMs), 0);
      return {
        project: e.name, path: rel, title: readme ? titleOf(fs.readFileSync(absOf(readme), 'utf8')) : e.name,
        description, files: files.length, updated_at: updated ? new Date(updated).toISOString() : null,
      };
    })
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}

export function overview() {
  ensureBase();
  return { general: listFiles(GENERAL), projects: listProjects() };
}

/** Datei lesen, optional nur ein Zeilenausschnitt (1-basiert, inklusive). */
export function readFile(p, { startLine = null, endLine = null } = {}) {
  const rel = cleanPath(p);
  const abs = absOf(rel);
  if (!fs.existsSync(abs)) throw new Error(`Datei nicht gefunden: ${rel}`);
  const buf = fs.readFileSync(abs);
  let content = buf.toString('utf8');
  const lines = content.split('\n');
  if (startLine || endLine) {
    const s = Math.max(1, startLine || 1), e = Math.min(lines.length, endLine || lines.length);
    content = lines.slice(s - 1, e).join('\n');
  }
  return { ...fileInfo(rel, { withTitle: false }), etag: etagOf(buf), lines_total: lines.length, content };
}

function atomicWrite(rel, content) {
  const buf = Buffer.from(String(content), 'utf8');
  if (buf.length > MAX_BYTES) throw new Error(`Zu groß (${(buf.length / 1024).toFixed(0)} KB, max. 1 MB) – lieber auf mehrere Dateien aufteilen`);
  const abs = absOf(rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
  const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, buf, { mode: 0o600 });
  fs.renameSync(tmp, abs);
  return etagOf(buf);
}

function checkEtag(rel, ifMatch) {
  if (!ifMatch) return;
  const abs = absOf(rel);
  const cur = fs.existsSync(abs) ? etagOf(fs.readFileSync(abs)) : null;
  if (cur !== ifMatch) {
    throw new Error(`Die Datei wurde inzwischen geändert (etag ${cur || 'gelöscht'} statt ${ifMatch}) – neu lesen und Änderung erneut anwenden.`);
  }
}

/**
 * Schreiben: mode replace (Standard), append, prepend. create_only verhindert
 * Überschreiben, if_match (etag aus readFile) verhindert verlorene Änderungen.
 */
export function writeFile(p, content, { mode = 'replace', createOnly = false, ifMatch = null } = {}) {
  ensureBase();
  const rel = cleanPath(p);
  const abs = absOf(rel);
  const exists = fs.existsSync(abs);
  if (createOnly && exists) throw new Error(`Existiert schon: ${rel} – lesen und mit edit/append ändern`);
  checkEtag(rel, ifMatch);
  let next = String(content ?? '');
  if (exists && mode !== 'replace') {
    const cur = fs.readFileSync(abs, 'utf8');
    const sep = s => (s && !s.endsWith('\n') ? '\n' : '');
    next = mode === 'append' ? cur + sep(cur) + next : next + sep(next) + cur;
  }
  const etag = atomicWrite(rel, next);
  return { ...fileInfo(rel), etag, created: !exists };
}

/** Gezielte Ersetzung – spart, die ganze Datei neu zu schicken. */
export function editFile(p, oldStr, newStr, { replaceAll = false, ifMatch = null } = {}) {
  const rel = cleanPath(p);
  const abs = absOf(rel);
  if (!fs.existsSync(abs)) throw new Error(`Datei nicht gefunden: ${rel}`);
  checkEtag(rel, ifMatch);
  const cur = fs.readFileSync(abs, 'utf8');
  if (!oldStr) throw new Error('old_text darf nicht leer sein');
  const count = cur.split(oldStr).length - 1;
  if (!count) throw new Error('old_text kommt in der Datei nicht vor – exakt aus read_brain_file übernehmen');
  if (count > 1 && !replaceAll) throw new Error(`old_text kommt ${count}× vor – mehr Kontext angeben oder replace_all=true`);
  const next = replaceAll ? cur.split(oldStr).join(newStr) : cur.replace(oldStr, () => newStr);
  const etag = atomicWrite(rel, next);
  return { ...fileInfo(rel), etag, replaced: replaceAll ? count : 1 };
}

export function moveFile(from, to) {
  const a = cleanPath(from), b = cleanPath(to);
  if (!fs.existsSync(absOf(a))) throw new Error(`Datei nicht gefunden: ${a}`);
  if (fs.existsSync(absOf(b))) throw new Error(`Ziel existiert schon: ${b}`);
  fs.mkdirSync(path.dirname(absOf(b)), { recursive: true, mode: 0o700 });
  fs.renameSync(absOf(a), absOf(b));
  pruneEmptyDirs(path.dirname(absOf(a)));
  return fileInfo(b);
}

function pruneEmptyDirs(absDir) {
  // Leere Unterordner wegräumen, aber nie die Grundordner und keine Projektordner.
  let d = absDir;
  while (d.startsWith(absOf(PROJECTS) + path.sep) && d.split(path.sep).length > absOf(PROJECTS).split(path.sep).length + 1) {
    if (fs.readdirSync(d).length) break;
    fs.rmdirSync(d);
    d = path.dirname(d);
  }
}

/** Löschen = in den Papierkorb verschieben. Ganze Projekte nur mit project=true. */
export function deleteEntry(p, { project = false } = {}) {
  ensureBase();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (project) {
    const slug = slugify(String(p).replace(new RegExp(`^${PROJECTS}/`), ''));
    const rel = `${PROJECTS}/${slug}`;
    if (!slug || !fs.existsSync(absOf(rel))) throw new Error(`Projekt nicht gefunden: ${slug}`);
    const dest = path.join(BRAIN_DIR, TRASH, `${stamp}_${slug}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.renameSync(absOf(rel), dest);
    return { deleted: rel, trash: path.relative(BRAIN_DIR, dest) };
  }
  const rel = cleanPath(p);
  if (!fs.existsSync(absOf(rel))) throw new Error(`Datei nicht gefunden: ${rel}`);
  const dest = path.join(BRAIN_DIR, TRASH, `${stamp}_${rel.replace(/\//g, '__')}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  fs.renameSync(absOf(rel), dest);
  pruneEmptyDirs(path.dirname(absOf(rel)));
  return { deleted: rel, trash: path.relative(BRAIN_DIR, dest) };
}

export function createProject(name, { description = '' } = {}) {
  ensureBase();
  const slug = slugify(name);
  if (!slug) throw new Error('Projektname fehlt');
  const rel = `${PROJECTS}/${slug}`;
  if (fs.existsSync(absOf(rel))) throw new Error(`Projekt existiert schon: ${slug}`);
  fs.mkdirSync(absOf(rel), { recursive: true, mode: 0o700 });
  const readme = `# ${String(name).trim()}\n\n${description ? `${description.trim()}\n` : ''}`;
  writeFile(`${rel}/README.md`, readme);
  return { project: slug, path: rel, readme: `${rel}/README.md` };
}

/** Volltextsuche (Groß/klein egal), Treffer mit Zeilennummer und Ausschnitt. */
export function search(query, { dir = '', limit = 30 } = {}) {
  ensureBase();
  const q = String(query || '').trim().toLowerCase();
  if (!q) throw new Error('Suchbegriff fehlt');
  const words = q.split(/\s+/);
  const hits = [];
  for (const rel of walk(cleanPath(dir, { dir: true }))) {
    const content = fs.readFileSync(absOf(rel), 'utf8');
    const lower = content.toLowerCase();
    // Datei muss alle Wörter enthalten; Treffer-Zeilen sind die mit mindestens einem.
    if (!words.every(w => lower.includes(w)) && !rel.toLowerCase().includes(q)) continue;
    const lines = content.split('\n');
    const matches = [];
    lines.forEach((l, i) => {
      if (matches.length < 3 && words.some(w => l.toLowerCase().includes(w))) matches.push({ line: i + 1, text: l.trim().slice(0, 200) });
    });
    hits.push({ path: rel, title: titleOf(content), matches });
    if (hits.length >= limit) break;
  }
  return hits;
}
