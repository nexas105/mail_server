import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { relTime, fullDateTime } from '../lib/dates';
import { confirmDialog, promptDialog } from '../components/Dialog';
import { Icon, type IconName } from '../components/Icon';

type Kind = 'note' | 'text' | 'pdf' | 'image' | 'audio' | 'video' | 'file';
interface Entry { path: string; kind: Kind; mime: string; size: number; updated_at: string; title?: string; tags?: string[]; status?: string; description?: string }
interface Project { project: string; path: string; title: string; description: string; status?: string; tags?: string[]; notes: number; files: number; updated_at: string | null }
interface Overview { general: Entry[]; projects: Project[]; tags: { tag: string; count: number }[] }
interface Tree { files: Entry[]; folders: string[] }
interface Opened extends Entry {
  etag: string; content?: string; lines_total?: number; links?: string[]; backlinks?: string[];
  pages_total?: number; note?: string;
}
interface SearchHit { path: string; kind: Kind; title: string; matches: { line: number; text: string }[] }

const enc = encodeURIComponent;
const base = (p: string) => p.split('/').pop() || p;
const dirOf = (p: string) => p.split('/').slice(0, -1).join('/');
const stem = (p: string) => base(p).replace(/\.md$/i, '');
const rawUrl = (p: string, download = false) => `/api/brain/raw?path=${enc(p)}${download ? '&download=1' : ''}`;
const KIND_ICON: Record<Kind, IconName> = { note: 'draft', text: 'template', pdf: 'book', image: 'image', audio: 'play', video: 'play', file: 'paperclip' };
const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const editable = (k?: Kind) => k === 'note' || k === 'text';

async function uploadFile(folder: string, file: File): Promise<Entry> {
  const res = await fetch(`/api/brain/upload?folder=${enc(folder)}&name=${enc(file.name || 'bild.png')}`, {
    method: 'POST', credentials: 'same-origin',
    // octet-stream: sonst würde der globale JSON-Parser .json-Dateien abfangen.
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || res.statusText);
  return j;
}

/**
 * Brain: Notizen und Dateien, allgemein und je Projekt. Dieselben Dateien liest
 * und schreibt die KI über MCP (/mcp/brain) – deshalb Konfliktschutz per etag.
 */
export function Brain() {
  const [params, setParams] = useSearchParams();
  const current = params.get('datei') || '';
  const [ov, setOv] = useState<Overview | null>(null);
  const [tree, setTree] = useState<Tree>({ files: [], folders: [] });
  const [open, setOpen] = useState<Record<string, boolean>>({ allgemein: true });
  const [folder, setFolder] = useState('allgemein');
  const [file, setFile] = useState<Opened | null>(null);
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<'view' | 'edit' | 'text'>('view');
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);

  const dirty = !!file && editable(file.kind) && draft !== (file.content ?? '');

  const reload = useCallback(async () => {
    try {
      const [o, t] = await Promise.all([api<Overview>('/brain'), api<Tree>('/brain/tree')]);
      setOv(o); setTree(t);
    } catch (e) { toast((e as Error).message, 'err'); }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const openFile = useCallback(async (path: string) => {
    try {
      const f = await api<Opened>(`/brain/file?path=${enc(path)}`);
      setFile(f); setDraft(f.content ?? '');
      setFolder(dirOf(path));
      // Elternordner aufklappen.
      const parts = path.split('/');
      setOpen(o => { const n = { ...o }; for (let i = 1; i < parts.length; i++) n[parts.slice(0, i).join('/')] = true; return n; });
    } catch (e) { toast((e as Error).message, 'err'); setFile(null); }
  }, []);

  useEffect(() => {
    if (!current) { setFile(null); setDraft(''); return; }
    setMode(m => (m === 'text' ? 'view' : m));
    openFile(current);
  }, [current, openFile]);

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  async function go(path: string) {
    if (path === current) return;
    if (dirty && !(await confirmDialog({ title: 'Änderungen verwerfen?', message: 'Die aktuelle Datei ist nicht gespeichert.', confirmLabel: 'Verwerfen', danger: true }))) return;
    setParams({ datei: path });
  }

  const save = useCallback(async () => {
    if (!file || !dirty) return;
    setSaving(true);
    try {
      await api('/brain/file', { method: 'PUT', body: { path: file.path, content: draft, if_match: file.etag } });
      await openFile(file.path);
      toast('Gespeichert');
      reload();
    } catch (e) { toast((e as Error).message, 'err'); }
    setSaving(false);
  }, [file, draft, dirty, openFile, reload]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [save]);

  // ---- Hochladen ----------------------------------------------------------
  async function uploadMany(files: FileList | File[], into = folder) {
    const list = [...files];
    if (!list.length) return;
    setUploading(n => n + list.length);
    let last: Entry | null = null;
    for (const f of list) {
      try { last = await uploadFile(into, f); toast(`${base(last.path)} abgelegt`); }
      catch (e) { toast(`${f.name}: ${(e as Error).message}`, 'err'); }
      setUploading(n => n - 1);
    }
    await reload();
    setOpen(o => ({ ...o, [into]: true }));
    if (last && list.length === 1) setParams({ datei: last.path });
  }

  // Bild aus der Zwischenablage in eine Notiz: nach <ordner>/dateien ablegen und einbinden.
  async function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (!file) return;
    const imgs = [...e.clipboardData.files].filter(f => f.type.startsWith('image/'));
    if (!imgs.length) return;
    e.preventDefault();
    const ta = e.currentTarget;
    const pos = ta.selectionStart;
    const target = `${dirOf(file.path)}/dateien`;
    for (const img of imgs) {
      const ext = img.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
      const named = new File([img], img.name && img.name !== 'image.png' ? img.name : `bild-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`, { type: img.type });
      try {
        const r = await uploadFile(target, named);
        const md = `![](${encodeURI(r.path.slice(dirOf(file.path).length + 1))})`;
        setDraft(d => d.slice(0, pos) + md + d.slice(pos));
      } catch (err) { toast((err as Error).message, 'err'); }
    }
    reload();
  }

  // ---- Anlegen, Umbenennen, Löschen ---------------------------------------
  async function newNote(dir = folder) {
    const name = await promptDialog({ title: 'Neue Notiz', message: `in ${dir}`, label: 'Name', placeholder: 'z.B. entscheidungen', confirmLabel: 'Anlegen' });
    if (!name) return;
    const path = `${dir}/${name.trim().replace(/\.md$/i, '')}.md`;
    try {
      await api('/brain/file', { method: 'PUT', body: { path, content: `# ${name.trim()}\n\n`, create_only: true } });
      await reload();
      setMode('edit');
      setParams({ datei: path });
    } catch (e) { toast((e as Error).message, 'err'); }
  }

  async function newFolder(dir = folder) {
    const name = await promptDialog({ title: 'Neuer Ordner', message: `in ${dir}`, label: 'Name', placeholder: 'z.B. protokolle', confirmLabel: 'Anlegen' });
    if (!name) return;
    try {
      const r = await api<{ path: string }>('/brain/folders', { method: 'POST', body: { path: `${dir}/${name.trim()}` } });
      await reload();
      setOpen(o => ({ ...o, [dir]: true, [r.path]: true }));
      setFolder(r.path);
    } catch (e) { toast((e as Error).message, 'err'); }
  }

  async function newProject() {
    const name = await promptDialog({ title: 'Neues Projekt', label: 'Projektname', confirmLabel: 'Weiter' });
    if (!name) return;
    const description = await promptDialog({ title: 'Worum geht es?', label: 'Ein Satz (optional)', confirmLabel: 'Anlegen' });
    try {
      const r = await api<{ path: string; readme: string }>('/brain/projects', { method: 'POST', body: { name, description: description || '' } });
      await reload();
      setOpen(o => ({ ...o, [r.path]: true }));
      setParams({ datei: r.readme });
    } catch (e) { toast((e as Error).message, 'err'); }
  }

  async function renameEntry(from: string, isFolder = false) {
    const to = await promptDialog({ title: isFolder ? 'Ordner umbenennen / verschieben' : 'Umbenennen / verschieben', label: 'Neuer Pfad', defaultValue: from, confirmLabel: 'Verschieben' });
    if (!to || to === from) return;
    try {
      const r = await api<{ to: string; links_updated: number }>('/brain/move', { method: 'POST', body: { from, to } });
      if (r.links_updated) toast(`Verweise in ${r.links_updated} Notiz(en) angepasst`);
      await reload();
      if (!isFolder) setParams({ datei: r.to });
      else if (current.startsWith(from + '/')) setParams({ datei: r.to + current.slice(from.length) });
    } catch (e) { toast((e as Error).message, 'err'); }
  }

  async function removeFile() {
    if (!file) return;
    if (!(await confirmDialog({ title: 'Löschen?', message: `${file.path} wandert in den Papierkorb.`, confirmLabel: 'Löschen', danger: true }))) return;
    try { await api(`/brain/file?path=${enc(file.path)}`, { method: 'DELETE' }); await reload(); setParams({}); }
    catch (e) { toast((e as Error).message, 'err'); }
  }

  async function removeFolder(path: string, project?: Project) {
    const msg = project ? `Projekt „${project.title}" mit ${project.notes + project.files} Einträgen` : `Ordner ${path}`;
    if (!(await confirmDialog({ title: 'In den Papierkorb?', message: `${msg} wandert in den Papierkorb.`, confirmLabel: 'Löschen', danger: true }))) return;
    try {
      if (project) await api(`/brain/projects/${enc(project.project)}`, { method: 'DELETE' });
      else await api(`/brain/file?path=${enc(path)}&folder=1`, { method: 'DELETE' });
      if (current.startsWith(path + '/')) setParams({});
      reload();
    } catch (e) { toast((e as Error).message, 'err'); }
  }

  // ---- Suche & Tags -------------------------------------------------------
  useEffect(() => {
    const qv = query.trim();
    if (qv.length < 2 && !tag) { setHits(null); return; }
    const t = setTimeout(() => {
      api<SearchHit[]>(`/brain/search?q=${enc(qv.length >= 2 ? qv : '')}${tag ? `&tag=${enc(tag)}` : ''}`).then(setHits).catch(() => setHits([]));
    }, 200);
    return () => clearTimeout(t);
  }, [query, tag]);

  // ---- Baum ---------------------------------------------------------------
  const children = useMemo(() => {
    const map: Record<string, { folders: string[]; files: Entry[] }> = {};
    const node = (p: string) => (map[p] ||= { folders: [], files: [] });
    for (const d of tree.folders) { node(d); if (d.includes('/')) node(dirOf(d)).folders.push(d); }
    for (const f of tree.files) node(dirOf(f.path)).files.push(f);
    return map;
  }, [tree]);

  function renderFolder(path: string, depth: number): ReactNode {
    const c = children[path];
    if (!c) return null;
    return (
      <div className="brain-files" style={depth ? undefined : { marginLeft: 6 }}>
        {c.folders.map(d => (
          <div key={d}>
            <div className={'brain-folder-row' + (folder === d ? ' active' : '')}>
              <button className="mailbox-nav" onClick={() => { setOpen(o => ({ ...o, [d]: !o[d] })); setFolder(d); }}>
                <span className="brain-caret">{open[d] ? '▾' : '▸'}</span><span>{base(d)}</span>
              </button>
              <button className="btn-icon" title="Umbenennen" onClick={() => renameEntry(d, true)}><Icon name="edit" size={12} /></button>
              <button className="btn-icon" title="Ordner löschen" onClick={() => removeFolder(d)}><Icon name="trash" size={12} /></button>
            </div>
            {open[d] && renderFolder(d, depth + 1)}
          </div>
        ))}
        {c.files.map(f => (
          <button key={f.path} className={'mailbox-nav' + (f.path === current ? ' active' : '')} onClick={() => go(f.path)} title={f.path}>
            <Icon name={KIND_ICON[f.kind]} size={13} />
            <span>{f.kind === 'note' ? (f.title || stem(f.path)) : base(f.path)}</span>
          </button>
        ))}
        {!c.folders.length && !c.files.length && <div className="muted small brain-empty">leer – Dateien hierher ziehen</div>}
      </div>
    );
  }

  const crumbs = file ? file.path.split('/') : [];
  const meta = file?.kind === 'note' ? frontmatter(draft) : null;

  return (
    <div className="inbox-page"
      onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={e => { if (e.currentTarget === e.target) setDragging(false); }}
      onDrop={e => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length) uploadMany(e.dataTransfer.files); }}>
      <div className="inbox-topbar">
        <div>
          <h1>Brain</h1>
          <span>Notizen und Dateien für dich und die KI · Ablage: <strong>{folder}</strong>{uploading ? ` · lädt ${uploading} …` : ''}</span>
        </div>
        <button className="btn ghost" onClick={() => newNote()}><Icon name="draft" size={14} />Notiz</button>
        <button className="btn ghost" onClick={() => fileInput.current?.click()}><Icon name="upload" size={14} />Dateien</button>
        <button className="btn" onClick={newProject}><Icon name="plus" size={14} />Projekt</button>
        <input ref={fileInput} type="file" multiple hidden onChange={e => { if (e.target.files) uploadMany(e.target.files); e.target.value = ''; }} />
      </div>
      {dragging && <div className="brain-drop"><Icon name="upload" size={28} /><div>Loslassen zum Ablegen in <strong>{folder}</strong></div></div>}

      <div className="inbox-workspace brain-workspace">
        <aside className="mailbox-sidebar">
          <input className="brain-search" placeholder="Suchen – auch in PDFs …" value={query} onChange={e => setQuery(e.target.value)} />
          {!!ov?.tags.length && (
            <div className="brain-tags">
              {ov.tags.slice(0, 18).map(t => (
                <button key={t.tag} className={'chip' + (tag === t.tag ? ' active' : '')} onClick={() => setTag(tag === t.tag ? null : t.tag)}>#{t.tag}</button>
              ))}
            </div>
          )}

          {hits ? (
            <>
              <div className="mailbox-section-title">{hits.length} Treffer{tag ? ` · #${tag}` : ''}</div>
              {hits.map(h => (
                <button key={h.path} className={'mailbox-nav account' + (h.path === current ? ' active' : '')} onClick={() => go(h.path)}>
                  <Icon name={KIND_ICON[h.kind] || 'search'} size={14} />
                  <span><strong>{h.title || base(h.path)}</strong><small>{h.matches[0]?.text || h.path}</small></span>
                </button>
              ))}
            </>
          ) : (
            <>
              <div className="mailbox-section-title brain-section">
                <span>Allgemein</span>
                <span>
                  <button className="btn-icon" title="Neue Notiz" onClick={() => newNote('allgemein')}><Icon name="plus" size={13} /></button>
                  <button className="btn-icon" title="Neuer Ordner" onClick={() => newFolder('allgemein')}><Icon name="template" size={13} /></button>
                </span>
              </div>
              <div onClick={() => setFolder(f => (f.startsWith('allgemein') ? f : 'allgemein'))}>{renderFolder('allgemein', 0)}</div>

              <div className="mailbox-section-title folders-title brain-section">
                <span>Projekte</span>
                <button className="btn-icon" title="Neues Projekt" onClick={newProject}><Icon name="plus" size={13} /></button>
              </div>
              {ov?.projects.length === 0 && <div className="muted small brain-empty">Noch keine Projekte.</div>}
              {ov?.projects.map(p => (
                <div key={p.path}>
                  <button className={'mailbox-nav account' + (current.startsWith(p.path + '/') || folder.startsWith(p.path) ? ' active' : '')}
                    onClick={() => { setOpen(o => ({ ...o, [p.path]: !o[p.path] })); setFolder(p.path); }} title={p.description}>
                    <Icon name="book" size={14} />
                    <span>
                      <strong>{p.title}{p.status && p.status !== 'aktiv' ? <em className="brain-status"> · {p.status}</em> : null}</strong>
                      <small>{p.notes} Notizen · {p.files} Dateien{p.updated_at ? ` · ${relTime(p.updated_at)}` : ''}</small>
                    </span>
                  </button>
                  {open[p.path] && (
                    <>
                      {renderFolder(p.path, 1)}
                      <div className="brain-project-actions">
                        <button className="linklike" onClick={() => newNote(p.path)}>+ Notiz</button>
                        <button className="linklike" onClick={() => newFolder(p.path)}>+ Ordner</button>
                        <button className="linklike" onClick={() => { setFolder(`${p.path}/dateien`); fileInput.current?.click(); }}>+ Dateien</button>
                        <button className="linklike" onClick={() => removeFolder(p.path, p)}>löschen</button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </>
          )}
        </aside>

        <section className="reading-pane">
          {!file ? (
            <div className="empty">
              <Icon name="brain" size={28} />
              <div>
                Wähle links eine Notiz oder Datei – oder zieh PDFs, Bilder und Dokumente einfach hier hinein.
                Unter <strong>Allgemein</strong> liegt Wissen, das überall gilt, unter <strong>Projekte</strong> je Projekt ein Ordner.
                Die KI liest und schreibt dieselben Dateien über <code>/mcp/brain</code> – PDFs liest sie als Text, Bilder sieht sie.
              </div>
            </div>
          ) : (
            <>
              <div className="toolbar brain-filebar">
                <div className="grow brain-crumbs">
                  {crumbs.map((c, i) => <span key={i}>{i > 0 && <span className="muted"> / </span>}{c}</span>)}
                  <div className="muted small">
                    {fmtSize(file.size)} · geändert <span title={fullDateTime(file.updated_at)}>{relTime(file.updated_at)}</span>
                    {file.pages_total ? ` · ${file.pages_total} Seiten` : ''}
                    {dirty && <strong> · nicht gespeichert</strong>}
                  </div>
                </div>
                {editable(file.kind) && (
                  <div className="tabs2">
                    <button className={mode === 'view' ? 'active' : ''} onClick={() => setMode('view')}><Icon name="eye" size={13} /> Ansicht</button>
                    <button className={mode === 'edit' ? 'active' : ''} onClick={() => setMode('edit')}><Icon name="edit" size={13} /> Bearbeiten</button>
                  </div>
                )}
                {file.kind === 'pdf' && (
                  <div className="tabs2">
                    <button className={mode !== 'text' ? 'active' : ''} onClick={() => setMode('view')}><Icon name="eye" size={13} /> PDF</button>
                    <button className={mode === 'text' ? 'active' : ''} onClick={() => setMode('text')}><Icon name="template" size={13} /> Text</button>
                  </div>
                )}
                {editable(file.kind) && <button className="btn sm" disabled={!dirty || saving} onClick={save} title="Speichern (⌘S)"><Icon name="save" size={13} />Speichern</button>}
                {!editable(file.kind) && <a className="btn sm ghost" href={rawUrl(file.path, true)} title="Herunterladen"><Icon name="download" size={13} /></a>}
                <button className="btn sm ghost" onClick={() => navigator.clipboard.writeText(file.kind === 'image' ? `![](${file.path})` : `[[${file.path.replace(/\.md$/i, '')}]]`).then(() => toast('Verweis kopiert'))} title="Verweis kopieren"><Icon name="copy" size={13} /></button>
                <button className="btn sm ghost" onClick={() => renameEntry(file.path)} title="Umbenennen / verschieben"><Icon name="edit" size={13} /></button>
                <button className="btn sm ghost" onClick={removeFile} title="Löschen"><Icon name="trash" size={13} /></button>
              </div>

              {meta && (meta.tags.length > 0 || meta.status || meta.description) && mode === 'view' && (
                <div className="brain-meta">
                  {meta.status && <span className="badge">{meta.status}</span>}
                  {meta.tags.map(t => <button key={t} className="chip" onClick={() => setTag(t)}>#{t}</button>)}
                  {meta.description && <span className="muted small">{meta.description}</span>}
                </div>
              )}

              {editable(file.kind) && mode === 'edit' ? (
                <textarea ref={editor} className="brain-editor" value={draft} onChange={e => setDraft(e.target.value)} onPaste={onPaste} spellCheck autoFocus
                  placeholder="Markdown … Bilder per ⌘V einfügen, [[notiz]] verknüpft, #tag markiert" />
              ) : file.kind === 'note' ? (
                <div className="brain-preview" onDoubleClick={() => setMode('edit')}>
                  {renderMarkdown(stripFrontmatter(draft), file.path, tree.files.map(f => f.path), go)}
                  {!!file.backlinks?.length && (
                    <div className="brain-backlinks">
                      <div className="mailbox-section-title">Verweise hierher</div>
                      {file.backlinks.map(b => <button key={b} className="linklike" onClick={() => go(b)}>{b}</button>)}
                    </div>
                  )}
                </div>
              ) : file.kind === 'text' ? (
                <pre className="brain-preview brain-pre">{draft}</pre>
              ) : file.kind === 'pdf' ? (
                mode === 'text'
                  ? <pre className="brain-preview brain-pre">{file.note ? `${file.note}\n\n` : ''}{file.content}</pre>
                  : <iframe className="brain-frame" src={rawUrl(file.path)} title={file.path} />
              ) : file.kind === 'image' ? (
                <div className="brain-media"><img src={rawUrl(file.path)} alt={base(file.path)} /></div>
              ) : file.kind === 'audio' ? (
                <div className="brain-media"><audio controls src={rawUrl(file.path)} /></div>
              ) : file.kind === 'video' ? (
                <div className="brain-media"><video controls src={rawUrl(file.path)} /></div>
              ) : (
                <div className="empty">
                  <Icon name="paperclip" size={28} />
                  <div>{base(file.path)} · {fmtSize(file.size)}<br /><a className="btn sm" style={{ marginTop: 10 }} href={rawUrl(file.path, true)}><Icon name="download" size={13} />Herunterladen</a></div>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

// ---- Frontmatter -------------------------------------------------------------
function frontmatter(src: string) {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out = { tags: [] as string[], status: '', description: '' };
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const v = kv[2].trim();
    if (kv[1] === 'tags') out.tags = v.replace(/^\[|\]$/g, '').split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    if (kv[1] === 'status') out.status = v;
    if (kv[1] === 'beschreibung' || kv[1] === 'description') out.description = v;
  }
  return out;
}
const stripFrontmatter = (src: string) => src.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');

// ---- Kleiner Markdown-Renderer ---------------------------------------------
// Erzeugt React-Elemente statt HTML – aus einer Notiz kann so nichts als Skript
// laufen. Kann: Überschriften, Listen, Checkboxen, Zitate, Code, Tabellen,
// Trennlinien, **fett**, *kursiv*, `code`, [Links](…), ![Bilder](…), [[Verweise]], #tags.
type Go = (path: string) => void;

function resolveRel(href: string, from: string, all: string[]): string | null {
  let h: string;
  try { h = decodeURIComponent(href); } catch { return null; }
  const parts = (h.startsWith('/') ? h.slice(1) : `${dirOf(from)}/${h}`).split('/');
  const out: string[] = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); }
  const rel = out.join('/');
  return all.includes(rel) ? rel : (all.includes(`${rel}.md`) ? `${rel}.md` : null);
}

function resolveWiki(target: string, from: string, all: string[]): string | null {
  const t = target.trim().replace(/\.md$/i, '');
  if (t.includes('/')) return all.find(f => f.replace(/\.md$/i, '') === t || f === t) || resolveRel(t, from, all);
  const lower = t.toLowerCase();
  const cands = all.filter(f => stem(f).toLowerCase() === lower || base(f).toLowerCase() === lower);
  const project = from.match(/^projekte\/[^/]+/)?.[0];
  return cands.find(f => dirOf(f) === dirOf(from)) || (project && cands.find(f => f.startsWith(project + '/'))) || cands[0] || null;
}

function inline(text: string, key: string, from: string, all: string[], go: Go): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(!\[[^\]]*\]\([^)\s]+\)|\[\[[^\]]+\]\]|\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|(?<![\w*])\*[^*\s][^*]*\*|(?<!\w)_[^_\s][^_]*_|(?<![\w&])#[\p{L}][\p{L}\p{N}_-]{1,40})/gu;
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0], k = `${key}-${i++}`;
    if (t.startsWith('![')) {
      const [, alt, src] = t.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/) || [];
      const rel = /^https:\/\//i.test(src) ? null : resolveRel(src, from, all);
      const url = rel ? rawUrl(rel) : (/^https:\/\//i.test(src) ? src : undefined);
      out.push(url ? <img key={k} className="brain-img" src={url} alt={alt} onClick={() => rel && go(rel)} /> : <span key={k} className="muted">[Bild fehlt: {src}]</span>);
    } else if (t.startsWith('[[')) {
      const [, target, label] = t.match(/^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]$/) || [];
      const rel = target ? resolveWiki(target, from, all) : null;
      out.push(rel
        ? <button key={k} className="linklike brain-wikilink" onClick={() => go(rel)}>{label || target}</button>
        : <span key={k} className="brain-wikilink missing" title="Noch keine Notiz mit diesem Namen">{label || target}</span>);
    } else if (t.startsWith('**')) out.push(<strong key={k}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith('`')) out.push(<code key={k}>{t.slice(1, -1)}</code>);
    else if (t.startsWith('[')) {
      const [, label, href] = t.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/) || [];
      const rel = /^[a-z]+:/i.test(href || '') ? null : resolveRel(href, from, all);
      if (rel) out.push(<button key={k} className="linklike" onClick={() => go(rel)}>{label}</button>);
      else {
        const safe = /^(https?:|mailto:)/i.test(href || '') ? href : undefined;
        out.push(<a key={k} href={safe} target="_blank" rel="noreferrer">{label}</a>);
      }
    } else if (t.startsWith('#')) out.push(<span key={k} className="brain-hashtag">{t}</span>);
    else out.push(<em key={k}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function renderMarkdown(src: string, from: string, all: string[], go: Go): ReactNode[] {
  const lines = src.replace(/\r/g, '').split('\n');
  const blocks: ReactNode[] = [];
  const il = (t: string, k: string) => inline(t, k, from, all, go);
  let i = 0, n = 0;
  while (i < lines.length) {
    const line = lines[i];
    const k = `b${n++}`;
    if (/^```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push(<pre key={k}><code>{body.join('\n')}</code></pre>);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const Tag = `h${Math.min(h[1].length + 1, 6)}` as 'h2';
      blocks.push(<Tag key={k}>{il(h[2], k)}</Tag>);
      i++; continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { blocks.push(<hr key={k} />); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      blocks.push(
        <table key={k} className="brain-table"><thead><tr>{head.map((c, j) => <th key={j}>{il(c, `${k}h${j}`)}</th>)}</tr></thead>
          <tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((c, j) => <td key={j}>{il(c, `${k}${ri}-${j}`)}</td>)}</tr>)}</tbody></table>,
      );
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push(<blockquote key={k}>{il(body.join(' '), k)}</blockquote>);
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        const t = lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, '');
        const task = t.match(/^\[( |x|X)\]\s+(.*)$/);
        const indent = (lines[i].match(/^\s*/)?.[0].length || 0) >= 2;
        items.push(<li key={`${k}-${i}`} className={indent ? 'sub' : undefined}>
          {task ? <><input type="checkbox" checked={task[1] !== ' '} readOnly /> {il(task[2], `${k}-${i}`)}</> : il(t, `${k}-${i}`)}
        </li>);
        i++;
      }
      blocks.push(ordered ? <ol key={k}>{items}</ol> : <ul key={k}>{items}</ul>);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*>|\s*([-*+]|\d+[.)])\s+|\s*\|.*\|\s*$)/.test(lines[i])) para.push(lines[i++]);
    if (!para.length) { para.push(lines[i++]); }
    blocks.push(<p key={k}>{il(para.join(' '), k)}</p>);
  }
  return blocks;
}
