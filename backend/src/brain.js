// Brain: Wissen als echte Dateien – Markdown-Notizen plus Ablage für PDFs,
// Bilder, Office-Dateien, Audio/Video. Allgemein und je Projekt.
//
//   data/brain/allgemein/…            gilt überall (Schreibstil, Abläufe, Personen)
//   data/brain/projekte/<projekt>/…   je Projekt ein Ordner, README.md = Überblick,
//                                     Unterordner frei (z.B. dateien/, protokolle/)
//   data/brain/.papierkorb/…          Gelöschtes, mit Zeitstempel
//   data/brain/.cache/…               aus PDFs gezogener Text (wird neu erzeugt)
//
// Notizen können oben einen Kopf haben (Frontmatter):
//   ---
//   tags: [kunde, angebot]
//   status: aktiv
//   beschreibung: Ein Satz, worum es geht
//   ---
// und mit [[name]] bzw. [[pfad/name|Text]] auf andere Notizen verweisen. Bilder
// und Dateien bindet normales Markdown ein: ![Logo](dateien/logo.png).
//
// Geschrieben wird atomar (tmp + rename). Konflikte zwischen Oberfläche und KI
// fängt `if_match` (etag) ab. Alles liegt im Backup (backup.js TOP_DIRS).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

export const BRAIN_DIR = path.join(DATA_DIR, 'brain');
const GENERAL = 'allgemein';
const PROJECTS = 'projekte';
const TRASH = '.papierkorb';
const CACHE = '.cache';
export const NOTE_MAX_BYTES = 1024 * 1024;
export const FILE_MAX_BYTES = 50 * 1024 * 1024;
const SEGMENT = /^[\p{L}\p{N}][\p{L}\p{N} ._()&+,'-]{0,120}$/u;

// Erlaubte Dateitypen. Bewusst KEIN .html/.js – die Dateien werden über die
// Oberfläche ausgeliefert, ausführbarer Inhalt hat hier nichts zu suchen.
export const TYPES = {
  md: { mime: 'text/markdown; charset=utf-8', kind: 'note' },
  txt: { mime: 'text/plain; charset=utf-8', kind: 'text' },
  csv: { mime: 'text/csv; charset=utf-8', kind: 'text' },
  json: { mime: 'application/json', kind: 'text' },
  ics: { mime: 'text/calendar', kind: 'text' },
  vcf: { mime: 'text/vcard', kind: 'text' },
  eml: { mime: 'message/rfc822', kind: 'text' },
  pdf: { mime: 'application/pdf', kind: 'pdf' },
  png: { mime: 'image/png', kind: 'image' },
  jpg: { mime: 'image/jpeg', kind: 'image' },
  jpeg: { mime: 'image/jpeg', kind: 'image' },
  gif: { mime: 'image/gif', kind: 'image' },
  webp: { mime: 'image/webp', kind: 'image' },
  svg: { mime: 'image/svg+xml', kind: 'image' },
  heic: { mime: 'image/heic', kind: 'file' },
  doc: { mime: 'application/msword', kind: 'file' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'file' },
  xls: { mime: 'application/vnd.ms-excel', kind: 'file' },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'file' },
  ppt: { mime: 'application/vnd.ms-powerpoint', kind: 'file' },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', kind: 'file' },
  odt: { mime: 'application/vnd.oasis.opendocument.text', kind: 'file' },
  ods: { mime: 'application/vnd.oasis.opendocument.spreadsheet', kind: 'file' },
  rtf: { mime: 'application/rtf', kind: 'file' },
  zip: { mime: 'application/zip', kind: 'file' },
  mp3: { mime: 'audio/mpeg', kind: 'audio' },
  m4a: { mime: 'audio/mp4', kind: 'audio' },
  ogg: { mime: 'audio/ogg', kind: 'audio' },
  opus: { mime: 'audio/ogg', kind: 'audio' },
  wav: { mime: 'audio/wav', kind: 'audio' },
  mp4: { mime: 'video/mp4', kind: 'video' },
  mov: { mime: 'video/quicktime', kind: 'video' },
  webm: { mime: 'video/webm', kind: 'video' },
};
const MIME_TO_EXT = Object.fromEntries(Object.entries(TYPES).reverse().map(([ext, t]) => [t.mime.split(';')[0], ext]));
const extOf = p => path.extname(String(p)).slice(1).toLowerCase();
export const typeOf = p => TYPES[extOf(p)] || null;
export const mimeOf = p => typeOf(p)?.mime || 'application/octet-stream';
export const extForMime = mime => MIME_TO_EXT[String(mime || '').split(';')[0].trim().toLowerCase()] || null;

const PROJECT_TEMPLATE = (name, description) => `---
tags: []
status: aktiv
beschreibung: ${(description || '').replace(/\n/g, ' ').trim()}
---
# ${name}

${description ? `${description.trim()}\n\n` : ''}## Ziel

## Stand

## Beteiligte

## Entscheidungen

## Offene Punkte

## Dateien
`;

function ensureBase() {
  for (const d of [BRAIN_DIR, path.join(BRAIN_DIR, GENERAL), path.join(BRAIN_DIR, PROJECTS)]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  }
}

/** Projektname → Ordnername. */
export const slugify = name => String(name || '').trim()
  .toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

/** Dateiname aus fremder Quelle (Upload, Mail-Anhang) entschärfen. */
export function safeFileName(name, mime = null) {
  let base = path.basename(String(name || 'datei')).normalize('NFC')
    .replace(/[^\p{L}\p{N} ._()&+,'-]+/gu, '_').replace(/^[^\p{L}\p{N}]+/u, '').slice(0, 110) || 'datei';
  if (!TYPES[extOf(base)]) {
    const ext = extForMime(mime);
    if (!ext) throw new Error(`Dateityp nicht erlaubt: ${name}. Erlaubt: ${Object.keys(TYPES).join(', ')}`);
    base = `${base.replace(/\.[^.]*$/, '')}.${ext}`;
  }
  return base;
}

/**
 * Prüft und normalisiert einen Pfad relativ zu brain/. Erlaubt sind nur
 * Einträge unter allgemein/ oder projekte/<projekt>/, nur bekannte Dateitypen,
 * keine versteckten Teile. Ohne Endung wird .md angenommen.
 */
export function cleanPath(input, { dir = false } = {}) {
  let p = String(input || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/').normalize('NFC');
  if (!dir && p && !TYPES[extOf(p)]) {
    if (path.extname(p)) throw new Error(`Dateityp nicht erlaubt: ${path.extname(p)}. Erlaubt: ${Object.keys(TYPES).join(', ')}`);
    p += '.md';
  }
  const parts = p.split('/').filter(Boolean);
  if (!parts.length && dir) return '';
  if (!parts.length) throw new Error('Pfad fehlt');
  for (const s of parts) {
    if (!SEGMENT.test(s) || s === '.' || s === '..') throw new Error(`Ungültiger Pfadteil "${s}" – erlaubt sind Buchstaben, Ziffern, Leerzeichen und . _ - ( ) & + ,`);
  }
  if (parts[0] !== GENERAL && parts[0] !== PROJECTS) {
    throw new Error(`Pfad muss mit "${GENERAL}/" oder "${PROJECTS}/<projekt>/" beginnen`);
  }
  if (!dir && parts[0] === PROJECTS && parts.length < 3) throw new Error(`Projektdateien liegen unter "${PROJECTS}/<projekt>/datei"`);
  const rel = parts.join('/');
  if (!path.join(BRAIN_DIR, rel).startsWith(BRAIN_DIR + path.sep)) throw new Error('Pfad außerhalb von brain/');
  return rel;
}
export const absOf = rel => path.join(BRAIN_DIR, rel);
const etagOf = buf => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
const isNote = rel => extOf(rel) === 'md';

// ---- Frontmatter, Titel, Verknüpfungen -------------------------------------

/** Liest den Kopf (--- … ---). Einfaches YAML: key: wert, Listen als [a, b]. */
export function parseFrontmatter(content) {
  const m = String(content).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: String(content) };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([\p{L}\p{N}_-]+)\s*:\s*(.*)$/u);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^\[.*\]$/.test(v)) v = v.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    else if (v === 'true' || v === 'false') v = v === 'true';
    else v = v.replace(/^["']|["']$/g, '');
    meta[kv[1].toLowerCase()] = v;
  }
  if (typeof meta.tags === 'string') meta.tags = meta.tags.split(/[,\s]+/).filter(Boolean);
  // #tags im Text zählen auch.
  const body = String(content).slice(m[0].length);
  return { meta, body };
}

function tagsOf(content) {
  const { meta, body } = parseFrontmatter(content);
  const set = new Set((Array.isArray(meta.tags) ? meta.tags : []).map(t => String(t).toLowerCase()));
  for (const t of body.matchAll(/(?:^|\s)#([\p{L}][\p{L}\p{N}_-]{1,40})/gu)) set.add(t[1].toLowerCase());
  return [...set];
}

/** Erste Überschrift bzw. erste Textzeile als Titel. */
function titleOf(content) {
  const { meta, body } = parseFrontmatter(content);
  if (meta.titel || meta.title) return String(meta.titel || meta.title).slice(0, 120);
  for (const line of body.split('\n').slice(0, 30)) {
    const t = line.trim();
    if (!t) continue;
    return t.replace(/^#+\s*/, '').slice(0, 120);
  }
  return '';
}

const WIKILINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g;

/** [[ziel]] auflösen: erst gleicher Ordner, dann gleiches Projekt, dann überall. */
export function resolveLink(target, fromRel, all = null) {
  const t = String(target).trim().replace(/\.md$/i, '');
  if (!t) return null;
  const files = all || walk('');
  if (t.includes('/')) {
    const direct = files.find(f => f.replace(/\.md$/i, '') === t || f === t);
    if (direct) return direct;
    const rel = fromRel ? path.posix.join(path.posix.dirname(fromRel), t) : t;
    return files.find(f => f.replace(/\.md$/i, '') === rel || f === rel) || null;
  }
  const lower = t.toLowerCase();
  const byName = files.filter(f => path.posix.basename(f).replace(/\.md$/i, '').toLowerCase() === lower
    || path.posix.basename(f).toLowerCase() === lower);
  if (!byName.length) return null;
  const dir = fromRel ? path.posix.dirname(fromRel) : '';
  const project = fromRel?.match(/^projekte\/[^/]+/)?.[0];
  return byName.find(f => path.posix.dirname(f) === dir)
    || (project && byName.find(f => f.startsWith(project + '/')))
    || byName[0];
}

function linksOf(content, fromRel, all) {
  const out = new Set();
  for (const m of String(content).matchAll(WIKILINK)) {
    const r = resolveLink(m[1], fromRel, all);
    if (r) out.add(r);
  }
  // Normale Markdown-Links/Bilder auf Dateien im Brain.
  for (const m of String(content).matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const href = decodeURIComponent(m[1]);
    if (/^[a-z]+:/i.test(href) || href.startsWith('#')) continue;
    const rel = href.startsWith('/') ? href.slice(1) : path.posix.join(path.posix.dirname(fromRel), href);
    if (all.includes(rel)) out.add(rel);
  }
  return [...out];
}

// ---- Dateien auflisten ------------------------------------------------------

function walk(relDir, out = [], { dirs = null } = {}) {
  const abs = absOf(relDir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const rel = relDir ? `${relDir}/${e.name}` : e.name;
    if (e.isDirectory()) { dirs?.push(rel); walk(rel, out, { dirs }); }
    else if (e.isFile() && TYPES[extOf(e.name)]) out.push(rel);
  }
  return out;
}

function fileInfo(rel, { withMeta = true } = {}) {
  const abs = absOf(rel);
  const st = fs.statSync(abs);
  const t = typeOf(rel);
  const info = { path: rel, kind: t?.kind || 'file', mime: t?.mime.split(';')[0], size: st.size, updated_at: st.mtime.toISOString() };
  if (withMeta && isNote(rel)) {
    const content = fs.readFileSync(abs, 'utf8');
    info.title = titleOf(content);
    const tags = tagsOf(content);
    if (tags.length) info.tags = tags;
    const { meta } = parseFrontmatter(content);
    if (meta.status) info.status = String(meta.status);
    if (meta.beschreibung || meta.description) info.description = String(meta.beschreibung || meta.description).slice(0, 200);
  }
  return info;
}

/** Alle Einträge unter einem Ordner (Standard: alles), plus die Ordner selbst. */
export function listFiles(dir = '', { kind = null, tag = null } = {}) {
  ensureBase();
  const rel = cleanPath(dir, { dir: true });
  let files = walk(rel).sort((a, b) => a.localeCompare(b, 'de')).map(p => fileInfo(p));
  if (kind) files = files.filter(f => f.kind === kind);
  if (tag) files = files.filter(f => f.tags?.includes(String(tag).toLowerCase()));
  return files;
}

/** Ganzer Baum für die Oberfläche: Dateien + (auch leere) Ordner. */
export function tree() {
  ensureBase();
  const dirs = [];
  const files = walk('', [], { dirs }).sort((a, b) => a.localeCompare(b, 'de')).map(p => fileInfo(p));
  return { files, folders: dirs.sort((a, b) => a.localeCompare(b, 'de')) };
}

/** Projekte mit Beschreibung, Status, Tags und Zahlen. */
export function listProjects() {
  ensureBase();
  const base = absOf(PROJECTS);
  return fs.readdirSync(base, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => {
      const rel = `${PROJECTS}/${e.name}`;
      const files = walk(rel);
      const readme = files.find(f => f.toLowerCase() === `${rel}/readme.md`.toLowerCase());
      let title = e.name, description = '', status, tags = [];
      if (readme) {
        const content = fs.readFileSync(absOf(readme), 'utf8');
        const { meta, body } = parseFrontmatter(content);
        title = titleOf(content) || e.name;
        description = String(meta.beschreibung || meta.description || '').slice(0, 200)
          || (body.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#')) || '').slice(0, 200);
        status = meta.status ? String(meta.status) : undefined;
        tags = tagsOf(content);
      }
      const updated = files.reduce((m, f) => Math.max(m, fs.statSync(absOf(f)).mtimeMs), 0);
      return {
        project: e.name, path: rel, title, description, status, tags: tags.length ? tags : undefined,
        notes: files.filter(isNote).length, files: files.filter(f => !isNote(f)).length,
        updated_at: updated ? new Date(updated).toISOString() : null,
      };
    })
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}

export function overview() {
  ensureBase();
  const all = walk('');
  const tagCount = {};
  for (const f of all.filter(isNote)) {
    for (const t of tagsOf(fs.readFileSync(absOf(f), 'utf8'))) tagCount[t] = (tagCount[t] || 0) + 1;
  }
  return {
    general: listFiles(GENERAL),
    projects: listProjects(),
    tags: Object.entries(tagCount).sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count })),
  };
}

// ---- Lesen ------------------------------------------------------------------

/** Text aus einem PDF – gecacht unter .cache/, damit Suche und Lesen billig bleiben. */
export async function pdfText(rel) {
  const abs = absOf(rel);
  const cache = path.join(BRAIN_DIR, CACHE, `${rel}.json`);
  const st = fs.statSync(abs);
  try {
    const c = JSON.parse(fs.readFileSync(cache, 'utf8'));
    if (c.mtime === st.mtimeMs) return c;
  } catch { /* noch nicht gecacht */ }
  const { extractText, getDocumentProxy } = await import('unpdf');
  let pages = [], totalPages = 0, error = null;
  try {
    // verbosity 0: pdf.js schreibt sonst Warnungen nach stdout – im stdio-Betrieb
    // des MCP-Servers würde das das Protokoll zerschießen.
    const doc = await getDocumentProxy(new Uint8Array(fs.readFileSync(abs)), { verbosity: 0 });
    const r = await extractText(doc, { mergePages: false });
    pages = r.text.map(t => String(t).replace(/[ \t]+\n/g, '\n').trim());
    totalPages = r.totalPages;
  } catch (e) { error = e.message; }
  const out = { mtime: st.mtimeMs, totalPages, pages, error };
  fs.mkdirSync(path.dirname(cache), { recursive: true, mode: 0o700 });
  fs.writeFileSync(cache, JSON.stringify(out), { mode: 0o600 });
  return out;
}

function searchableText(rel) {
  const t = typeOf(rel);
  if (t?.kind === 'note' || t?.kind === 'text') return fs.readFileSync(absOf(rel), 'utf8');
  if (t?.kind === 'pdf') {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(BRAIN_DIR, CACHE, `${rel}.json`), 'utf8'));
      return c.pages.join('\n');
    } catch { return ''; }
  }
  return '';
}

/**
 * Datei lesen. Notizen und Text: Inhalt (optional Zeilen-Ausschnitt), dazu bei
 * Notizen Tags, Verknüpfungen und Rückverweise. PDFs: Text je Seite (optional
 * Seitenbereich). Bilder: base64 (Aufrufer entscheidet, ob er es braucht).
 */
export async function readFile(p, { startLine = null, endLine = null, pages = null, withImage = false } = {}) {
  const rel = cleanPath(p);
  const abs = absOf(rel);
  if (!fs.existsSync(abs)) throw new Error(`Datei nicht gefunden: ${rel}`);
  const info = fileInfo(rel);
  const buf = fs.readFileSync(abs);
  const base = { ...info, etag: etagOf(buf) };

  if (info.kind === 'note' || info.kind === 'text') {
    let content = buf.toString('utf8');
    const lines = content.split('\n');
    if (startLine || endLine) {
      const s = Math.max(1, startLine || 1), e = Math.min(lines.length, endLine || lines.length);
      content = lines.slice(s - 1, e).join('\n');
    }
    const out = { ...base, lines_total: lines.length, content };
    if (info.kind === 'note') {
      const all = walk('');
      const links = linksOf(buf.toString('utf8'), rel, all);
      if (links.length) out.links = links;
      const back = backlinks(rel, all);
      if (back.length) out.backlinks = back;
    }
    return out;
  }
  if (info.kind === 'pdf') {
    const t = await pdfText(rel);
    const [from, to] = pages ? pages : [1, t.totalPages];
    const sel = t.pages.slice(Math.max(0, from - 1), Math.min(t.totalPages, to));
    return {
      ...base, pages_total: t.totalPages, pages: [from, Math.min(to, t.totalPages)],
      content: sel.map((txt, i) => `--- Seite ${from + i} ---\n${txt}`).join('\n\n'),
      note: t.error ? `Text konnte nicht gelesen werden: ${t.error}`
        : (!sel.join('').trim() ? 'Kein Text im PDF – vermutlich ein Scan (Bild ohne Texterkennung).' : undefined),
    };
  }
  if (info.kind === 'image' && withImage) return { ...base, base64: buf.toString('base64') };
  return base;
}

/** Welche Notizen verweisen auf diese Datei? */
export function backlinks(rel, all = null) {
  const files = all || walk('');
  const out = [];
  for (const f of files.filter(isNote)) {
    if (f === rel) continue;
    if (linksOf(fs.readFileSync(absOf(f), 'utf8'), f, files).includes(rel)) out.push(f);
  }
  return out;
}

// ---- Schreiben --------------------------------------------------------------

function atomicWrite(rel, data, max = NOTE_MAX_BYTES) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  if (buf.length > max) throw new Error(`Zu groß (${(buf.length / 1048576).toFixed(1)} MB, max. ${max / 1048576} MB)`);
  const abs = absOf(rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.${Date.now()}.tmp`);
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
 * Notiz/Textdatei schreiben: mode replace (Standard), append, prepend.
 * create_only verhindert Überschreiben, if_match verlorene Änderungen.
 */
export function writeFile(p, content, { mode = 'replace', createOnly = false, ifMatch = null } = {}) {
  ensureBase();
  const rel = cleanPath(p);
  const kind = typeOf(rel)?.kind;
  if (kind !== 'note' && kind !== 'text') throw new Error('Nur Notizen/Textdateien lassen sich schreiben – Dateien mit add_brain_file ablegen');
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
  const kind = typeOf(rel)?.kind;
  if (kind !== 'note' && kind !== 'text') throw new Error('Nur Notizen/Textdateien lassen sich bearbeiten');
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

/** Freien Namen finden: bericht.pdf → bericht-2.pdf … */
function freePath(rel) {
  if (!fs.existsSync(absOf(rel))) return rel;
  const ext = path.posix.extname(rel), stem = rel.slice(0, -ext.length);
  for (let i = 2; i < 1000; i++) {
    const cand = `${stem}-${i}${ext}`;
    if (!fs.existsSync(absOf(cand))) return cand;
  }
  throw new Error('Kein freier Dateiname gefunden');
}

/**
 * Datei ablegen (PDF, Bild, Office …). folder = Zielordner, name = Dateiname.
 * Existiert der Name schon, wird hochgezählt – außer overwrite=true.
 * PDFs werden gleich ausgelesen, damit Suche und KI den Text kennen.
 */
export async function saveFile(folder, name, buffer, { mime = null, overwrite = false } = {}) {
  ensureBase();
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Leere Datei');
  if (buffer.length > FILE_MAX_BYTES) throw new Error(`Zu groß (${(buffer.length / 1048576).toFixed(1)} MB, max. 50 MB)`);
  const dir = cleanPath(folder, { dir: true });
  if (!dir) throw new Error('Zielordner fehlt, z.B. "allgemein" oder "projekte/<projekt>/dateien"');
  cleanPath(`${dir}/x.md`);   // prüft, dass der Ordner an einer erlaubten Stelle liegt
  let rel = cleanPath(`${dir}/${safeFileName(name, mime)}`);
  if (!overwrite) rel = freePath(rel);
  const etag = atomicWrite(rel, buffer, FILE_MAX_BYTES);
  const info = { ...fileInfo(rel), etag };
  if (info.kind === 'pdf') {
    const t = await pdfText(rel);
    info.pages_total = t.totalPages;
    info.has_text = t.pages.some(s => s.trim());
  }
  return info;
}

export function createFolder(p) {
  ensureBase();
  const rel = cleanPath(p, { dir: true });
  if (!rel || rel === GENERAL || rel === PROJECTS) throw new Error('Ordnername fehlt');
  if (rel.startsWith(PROJECTS + '/') && rel.split('/').length < 3) throw new Error('Projekte mit create_brain_project anlegen');
  fs.mkdirSync(absOf(rel), { recursive: true, mode: 0o700 });
  return { path: rel };
}

/** Datei ODER Ordner verschieben/umbenennen. Verweise [[…]] in Notizen werden nachgezogen. */
export function moveEntry(from, to) {
  ensureBase();
  const srcAbs = absOf(cleanPath(from, { dir: true }));
  const isDir = fs.existsSync(srcAbs) && fs.statSync(srcAbs).isDirectory();
  const a = isDir ? cleanPath(from, { dir: true }) : cleanPath(from);
  const b = isDir ? cleanPath(to, { dir: true }) : cleanPath(to);
  if (!fs.existsSync(absOf(a))) throw new Error(`Nicht gefunden: ${a}`);
  if ([GENERAL, PROJECTS].includes(a)) throw new Error('Grundordner lassen sich nicht verschieben');
  if (fs.existsSync(absOf(b))) throw new Error(`Ziel existiert schon: ${b}`);
  if (!isDir && extOf(a) !== extOf(b)) throw new Error('Die Dateiendung darf sich beim Verschieben nicht ändern');
  fs.mkdirSync(path.dirname(absOf(b)), { recursive: true, mode: 0o700 });
  fs.renameSync(absOf(a), absOf(b));
  // Verweise in allen Notizen nachziehen: Markdown-Links/Bilder (relativ oder
  // mit führendem /) und [[…]] mit Pfad. Kurze [[name]] lösen sich ohnehin neu auf.
  const strip = s => s.replace(/\.md$/i, '');
  const moved = target => (target === a ? b : (isDir && target.startsWith(a + '/') ? b + target.slice(a.length) : null));
  let updated = 0;
  for (const f of walk('').filter(isNote)) {
    const dir = path.posix.dirname(f);
    // Eine verschobene Notiz selbst: ihre relativen Links beziehen sich auf den alten Ort.
    const oldDir = f === b ? path.posix.dirname(a) : (isDir && f.startsWith(b + '/') ? path.posix.dirname(a + f.slice(b.length)) : dir);
    const cur = fs.readFileSync(absOf(f), 'utf8');
    let next = cur.replace(/(!?\[[^\]]*\]\()([^)\s]+)(\))/g, (all, pre, href, post) => {
      if (/^[a-z]+:/i.test(href) || href.startsWith('#')) return all;
      let decoded; try { decoded = decodeURIComponent(href); } catch { return all; }
      const abs = decoded.startsWith('/') ? decoded.slice(1) : path.posix.normalize(path.posix.join(oldDir, decoded));
      const target = moved(abs) || abs;
      if (target === abs && oldDir === dir) return all;
      const nextHref = decoded.startsWith('/') ? `/${target}` : path.posix.relative(dir, target);
      return `${pre}${encodeURI(nextHref)}${post}`;
    });
    next = next.replace(/\[\[([^\]|#]+)/g, (all, t) => {
      if (!t.includes('/')) return all;
      const target = moved(`${t.trim()}.md`) || moved(t.trim());
      return target ? `[[${strip(target)}` : all;
    });
    if (next !== cur) { atomicWrite(f, next); updated++; }
  }
  return { from: a, to: b, folder: isDir, links_updated: updated };
}

function pruneEmptyDirs(absDir) {
  let d = absDir;
  const stop = [absOf(GENERAL), absOf(PROJECTS)];
  while (d.startsWith(BRAIN_DIR + path.sep) && !stop.includes(d) && path.dirname(d) !== absOf(PROJECTS)) {
    if (fs.readdirSync(d).length) break;
    fs.rmdirSync(d);
    d = path.dirname(d);
  }
}

/** Löschen = in den Papierkorb. Ordner nur mit folder=true, Projekte mit project=true. */
export function deleteEntry(p, { project = false, folder = false } = {}) {
  ensureBase();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const toTrash = (rel, label) => {
    const dest = path.join(BRAIN_DIR, TRASH, `${stamp}_${label}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.renameSync(absOf(rel), dest);
    return { deleted: rel, trash: path.relative(BRAIN_DIR, dest) };
  };
  if (project) {
    const slug = slugify(String(p).replace(new RegExp(`^${PROJECTS}/`), ''));
    const rel = `${PROJECTS}/${slug}`;
    if (!slug || !fs.existsSync(absOf(rel))) throw new Error(`Projekt nicht gefunden: ${slug}`);
    return toTrash(rel, slug);
  }
  if (folder) {
    const rel = cleanPath(p, { dir: true });
    if (!rel || [GENERAL, PROJECTS].includes(rel) || /^projekte\/[^/]+$/.test(rel)) throw new Error('Grund- und Projektordner so nicht löschbar (Projekt: project=true)');
    if (!fs.existsSync(absOf(rel))) throw new Error(`Ordner nicht gefunden: ${rel}`);
    const r = toTrash(rel, rel.replace(/\//g, '__'));
    pruneEmptyDirs(path.dirname(absOf(rel)));
    return r;
  }
  const rel = cleanPath(p);
  if (!fs.existsSync(absOf(rel))) throw new Error(`Datei nicht gefunden: ${rel}`);
  const r = toTrash(rel, rel.replace(/\//g, '__'));
  fs.rmSync(path.join(BRAIN_DIR, CACHE, `${rel}.json`), { force: true });
  return r;
}

export function createProject(name, { description = '' } = {}) {
  ensureBase();
  const slug = slugify(name);
  if (!slug) throw new Error('Projektname fehlt');
  const rel = `${PROJECTS}/${slug}`;
  if (fs.existsSync(absOf(rel))) throw new Error(`Projekt existiert schon: ${slug}`);
  fs.mkdirSync(absOf(`${rel}/dateien`), { recursive: true, mode: 0o700 });
  writeFile(`${rel}/README.md`, PROJECT_TEMPLATE(String(name).trim(), description));
  return { project: slug, path: rel, readme: `${rel}/README.md`, files_folder: `${rel}/dateien` };
}

/**
 * Alles, was die KI zu einem Projekt wissen sollte, in EINEM Aufruf: README
 * komplett, Notizen mit Tag "kontext" (oder immer_laden: true) komplett, der
 * Rest als Liste mit Titel – plus die allgemeinen Notizen mit Tag "kontext".
 */
export function projectContext(project, { maxChars = 30000 } = {}) {
  ensureBase();
  const slug = slugify(String(project).replace(new RegExp(`^${PROJECTS}/`), ''));
  const rel = `${PROJECTS}/${slug}`;
  if (!fs.existsSync(absOf(rel))) throw new Error(`Projekt nicht gefunden: ${slug} – siehe get_brain_overview`);
  let budget = maxChars;
  const take = f => {
    const c = fs.readFileSync(absOf(f), 'utf8');
    const part = c.length > budget ? `${c.slice(0, Math.max(0, budget))}\n…[gekürzt]` : c;
    budget -= part.length;
    return { path: f, content: part };
  };
  const pinned = f => {
    const c = fs.readFileSync(absOf(f), 'utf8');
    const { meta } = parseFrontmatter(c);
    return tagsOf(c).includes('kontext') || meta.immer_laden === true;
  };
  const files = walk(rel).sort((a, b) => a.localeCompare(b, 'de'));
  const readme = files.find(f => f.toLowerCase() === `${rel}/readme.md`);
  const full = [];
  if (readme) full.push(take(readme));
  for (const f of files.filter(f => isNote(f) && f !== readme && pinned(f))) if (budget > 0) full.push(take(f));
  for (const f of walk(GENERAL).filter(f => isNote(f) && pinned(f))) if (budget > 0) full.push(take(f));
  const loaded = new Set(full.map(x => x.path));
  return {
    project: slug,
    loaded: full,
    other_files: files.filter(f => !loaded.has(f)).map(f => {
      const i = fileInfo(f);
      return { path: f, kind: i.kind, title: i.title, tags: i.tags, size: i.size };
    }),
    hint: 'Weitere Dateien gezielt mit read_brain_file lesen. Notizen mit Tag "kontext" werden hier immer komplett geladen.',
  };
}

/** Volltextsuche über Notizen, Textdateien und PDF-Text. Alle Wörter müssen vorkommen. */
export function search(query, { dir = '', tag = null, limit = 30 } = {}) {
  ensureBase();
  const q = String(query || '').trim().toLowerCase();
  if (!q && !tag) throw new Error('Suchbegriff fehlt');
  const words = q ? q.split(/\s+/) : [];
  const hits = [];
  for (const rel of walk(cleanPath(dir, { dir: true }))) {
    const text = searchableText(rel);
    if (tag && !(isNote(rel) && tagsOf(text).includes(String(tag).toLowerCase()))) continue;
    const lower = text.toLowerCase();
    const nameHit = q && rel.toLowerCase().includes(q);
    if (words.length && !nameHit && !words.every(w => lower.includes(w))) continue;
    const lines = text.split('\n');
    const matches = [];
    if (words.length) {
      lines.forEach((l, i) => {
        if (matches.length < 3 && words.some(w => l.toLowerCase().includes(w))) matches.push({ line: i + 1, text: l.trim().slice(0, 200) });
      });
    }
    hits.push({ path: rel, kind: typeOf(rel)?.kind, title: isNote(rel) ? titleOf(text) : path.posix.basename(rel), matches });
    if (hits.length >= limit) break;
  }
  return hits;
}
