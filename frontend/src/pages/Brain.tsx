import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { relTime, fullDateTime } from '../lib/dates';
import { confirmDialog, promptDialog } from '../components/Dialog';
import { Icon } from '../components/Icon';

interface BrainFileInfo { path: string; size: number; updated_at: string; title?: string }
interface BrainProject { project: string; path: string; title: string; description: string; files: number; updated_at: string | null }
interface Overview { general: BrainFileInfo[]; projects: BrainProject[] }
interface BrainFile extends BrainFileInfo { etag: string; content: string; lines_total: number }
interface SearchHit { path: string; title: string; matches: { line: number; text: string }[] }

const q = (p: string) => encodeURIComponent(p);
const fileName = (p: string) => p.split('/').pop()?.replace(/\.md$/i, '') || p;

/**
 * Brain: Markdown-Notizen, allgemein und je Projekt. Dieselben Dateien liest und
 * schreibt die KI über MCP (/mcp/brain) – deshalb Konfliktschutz per etag.
 */
export function Brain() {
  const [params, setParams] = useSearchParams();
  const current = params.get('datei') || '';
  const [ov, setOv] = useState<Overview | null>(null);
  const [projectFiles, setProjectFiles] = useState<Record<string, BrainFileInfo[]>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [file, setFile] = useState<BrainFile | null>(null);
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<'edit' | 'preview'>('preview');
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);

  const dirty = !!file && draft !== file.content;

  const loadOverview = useCallback(() => api<Overview>('/brain').then(setOv).catch(e => toast(e.message, 'err')), []);
  const loadProject = useCallback((path: string) =>
    api<BrainFileInfo[]>(`/brain/files?path=${q(path)}`)
      .then(list => setProjectFiles(m => ({ ...m, [path]: list })))
      .catch(() => {}), []);

  useEffect(() => { loadOverview(); }, [loadOverview]);

  // Datei aus der URL laden (auch Links aus MCP-Antworten: /brain?datei=…).
  useEffect(() => {
    if (!current) { setFile(null); setDraft(''); return; }
    api<BrainFile>(`/brain/file?path=${q(current)}`)
      .then(f => { setFile(f); setDraft(f.content); })
      .catch(e => { toast(e.message, 'err'); setFile(null); });
    const m = current.match(/^projekte\/[^/]+/);
    if (m) { setOpen(o => ({ ...o, [m[0]]: true })); loadProject(m[0]); }
  }, [current, loadProject]);

  // Warnen, bevor ungespeicherte Änderungen verloren gehen.
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  async function select(path: string) {
    if (path === current) return;
    if (dirty && !(await confirmDialog({ title: 'Änderungen verwerfen?', message: 'Die aktuelle Datei ist nicht gespeichert.', confirmLabel: 'Verwerfen', danger: true }))) return;
    setParams({ datei: path });
  }

  const save = useCallback(async () => {
    if (!file || !dirty) return;
    setSaving(true);
    try {
      const r = await api<BrainFile>('/brain/file', { method: 'PUT', body: { path: file.path, content: draft, if_match: file.etag } });
      setFile({ ...file, ...r, content: draft });
      toast('Gespeichert');
      loadOverview();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
    setSaving(false);
  }, [file, draft, dirty, loadOverview]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [save]);

  async function newFile(dir: string) {
    const name = await promptDialog({ title: 'Neue Notiz', label: 'Dateiname', placeholder: 'z.B. entscheidungen', confirmLabel: 'Anlegen' });
    if (!name) return;
    const path = `${dir}/${name.trim().replace(/\.md$/i, '')}.md`;
    try {
      await api('/brain/file', { method: 'PUT', body: { path, content: `# ${name.trim()}\n\n`, create_only: true } });
      await loadOverview();
      if (dir.startsWith('projekte/')) loadProject(dir);
      setMode('edit');
      setParams({ datei: path });
    } catch (e) { toast((e as Error).message, 'err'); }
  }

  async function newProject() {
    const name = await promptDialog({ title: 'Neues Projekt', label: 'Projektname', confirmLabel: 'Anlegen' });
    if (!name) return;
    const description = await promptDialog({ title: 'Kurzbeschreibung', label: 'Worum geht es? (optional)', confirmLabel: 'Weiter' });
    try {
      const r = await api<{ path: string; readme: string }>('/brain/projects', { method: 'POST', body: { name, description: description || '' } });
      await loadOverview();
      setOpen(o => ({ ...o, [r.path]: true }));
      loadProject(r.path);
      setParams({ datei: r.readme });
    } catch (e) { toast((e as Error).message, 'err'); }
  }

  async function rename() {
    if (!file) return;
    const to = await promptDialog({ title: 'Umbenennen / verschieben', label: 'Neuer Pfad', defaultValue: file.path, confirmLabel: 'Verschieben' });
    if (!to || to === file.path) return;
    try {
      const r = await api<BrainFileInfo>('/brain/move', { method: 'POST', body: { from: file.path, to } });
      await loadOverview();
      Object.keys(open).filter(k => open[k]).forEach(loadProject);
      setParams({ datei: r.path });
    } catch (e) { toast((e as Error).message, 'err'); }
  }

  async function remove() {
    if (!file) return;
    if (!(await confirmDialog({ title: 'Notiz löschen?', message: `${file.path} wandert in den Papierkorb.`, confirmLabel: 'Löschen', danger: true }))) return;
    try {
      await api(`/brain/file?path=${q(file.path)}`, { method: 'DELETE' });
      const m = file.path.match(/^projekte\/[^/]+/);
      await loadOverview();
      if (m) loadProject(m[0]);
      setParams({});
    } catch (e) { toast((e as Error).message, 'err'); }
  }

  async function removeProject(p: BrainProject) {
    if (!(await confirmDialog({ title: `Projekt „${p.title}" löschen?`, message: `Alle ${p.files} Dateien wandern in den Papierkorb.`, confirmLabel: 'Projekt löschen', danger: true }))) return;
    try {
      await api(`/brain/projects/${q(p.project)}`, { method: 'DELETE' });
      if (current.startsWith(p.path + '/')) setParams({});
      loadOverview();
    } catch (e) { toast((e as Error).message, 'err'); }
  }

  function toggleProject(p: BrainProject) {
    const next = !open[p.path];
    setOpen(o => ({ ...o, [p.path]: next }));
    if (next) loadProject(p.path);
  }

  async function runSearch(v: string) {
    setQuery(v);
    if (v.trim().length < 2) { setHits(null); return; }
    try { setHits(await api<SearchHit[]>(`/brain/search?q=${q(v.trim())}`)); } catch { setHits([]); }
  }

  const crumbs = useMemo(() => (file ? file.path.split('/') : []), [file]);

  return (
    <div className="inbox-page">
      <div className="inbox-topbar">
        <div>
          <h1>Brain</h1>
          <span>Markdown-Wissen für dich und die KI · über MCP unter <code>/mcp/brain</code></span>
        </div>
        <button className="btn" onClick={newProject}><Icon name="plus" size={14} />Projekt</button>
      </div>
      <div className="inbox-workspace brain-workspace">
        <aside className="mailbox-sidebar">
          <input className="brain-search" placeholder="Suchen …" value={query} onChange={e => runSearch(e.target.value)} />

          {hits ? (
            <>
              <div className="mailbox-section-title">{hits.length} Treffer</div>
              {hits.map(h => (
                <button key={h.path} className={'mailbox-nav account' + (h.path === current ? ' active' : '')} onClick={() => select(h.path)}>
                  <Icon name="search" size={14} />
                  <span><strong>{h.title || fileName(h.path)}</strong><small>{h.matches[0]?.text || h.path}</small></span>
                </button>
              ))}
            </>
          ) : (
            <>
              <div className="mailbox-section-title brain-section">
                <span>Allgemein</span>
                <button className="btn-icon" title="Neue allgemeine Notiz" onClick={() => newFile('allgemein')}><Icon name="plus" size={13} /></button>
              </div>
              {ov?.general.length === 0 && <div className="muted small brain-empty">Noch keine Notizen.</div>}
              {ov?.general.map(f => (
                <button key={f.path} className={'mailbox-nav' + (f.path === current ? ' active' : '')} onClick={() => select(f.path)} title={f.path}>
                  <Icon name="draft" size={14} /><span>{f.title || fileName(f.path)}</span>
                </button>
              ))}

              <div className="mailbox-section-title folders-title brain-section">
                <span>Projekte</span>
                <button className="btn-icon" title="Neues Projekt" onClick={newProject}><Icon name="plus" size={13} /></button>
              </div>
              {ov?.projects.length === 0 && <div className="muted small brain-empty">Noch keine Projekte.</div>}
              {ov?.projects.map(p => (
                <div key={p.path}>
                  <button className={'mailbox-nav account' + (current.startsWith(p.path + '/') ? ' active' : '')} onClick={() => toggleProject(p)} title={p.description}>
                    <Icon name="book" size={14} />
                    <span><strong>{p.title}</strong><small>{p.files} {p.files === 1 ? 'Datei' : 'Dateien'}{p.updated_at ? ` · ${relTime(p.updated_at)}` : ''}</small></span>
                  </button>
                  {open[p.path] && (
                    <div className="brain-files">
                      {(projectFiles[p.path] || []).map(f => (
                        <button key={f.path} className={'mailbox-nav' + (f.path === current ? ' active' : '')} onClick={() => select(f.path)} title={f.path}>
                          <span>{f.path.slice(p.path.length + 1).replace(/\.md$/i, '')}</span>
                        </button>
                      ))}
                      <div className="brain-project-actions">
                        <button className="linklike" onClick={() => newFile(p.path)}>+ Datei</button>
                        <button className="linklike" onClick={() => removeProject(p)}>Projekt löschen</button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </>
          )}
        </aside>

        <section className="reading-pane">
          {!file ? (
            <div className="empty">
              <Icon name="book" size={28} />
              <div>
                Wähle links eine Notiz – oder lege unter <strong>Allgemein</strong> Wissen an, das überall gilt
                (Schreibstil, Abläufe, Personen), und unter <strong>Projekte</strong> je Projekt einen Ordner.
                Die KI liest und schreibt dieselben Dateien über <code>/mcp/brain</code>.
              </div>
            </div>
          ) : (
            <>
              <div className="toolbar brain-filebar">
                <div className="grow brain-crumbs">
                  {crumbs.map((c, i) => <span key={i}>{i > 0 && <span className="muted"> / </span>}{c}</span>)}
                  <div className="muted small">
                    geändert <span title={fullDateTime(file.updated_at)}>{relTime(file.updated_at)}</span> · {file.lines_total} Zeilen
                    {dirty && <strong> · nicht gespeichert</strong>}
                  </div>
                </div>
                <div className="tabs2">
                  <button className={mode === 'preview' ? 'active' : ''} onClick={() => setMode('preview')}><Icon name="eye" size={13} /> Ansicht</button>
                  <button className={mode === 'edit' ? 'active' : ''} onClick={() => setMode('edit')}><Icon name="edit" size={13} /> Bearbeiten</button>
                </div>
                <button className="btn sm" disabled={!dirty || saving} onClick={save} title="Speichern (⌘S)"><Icon name="save" size={13} />Speichern</button>
                <button className="btn sm ghost" onClick={rename} title="Umbenennen / verschieben"><Icon name="edit" size={13} /></button>
                <button className="btn sm ghost" onClick={remove} title="Löschen"><Icon name="trash" size={13} /></button>
              </div>
              {mode === 'edit' ? (
                <textarea className="brain-editor" value={draft} onChange={e => setDraft(e.target.value)} spellCheck autoFocus />
              ) : (
                <div className="brain-preview" onDoubleClick={() => setMode('edit')}>{renderMarkdown(draft)}</div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

// ---- Kleiner Markdown-Renderer ---------------------------------------------
// Erzeugt React-Elemente statt HTML – damit kann nichts aus einer Notiz als
// Skript ausgeführt werden. Deckt ab: Überschriften, Listen, Checkboxen,
// Zitate, Code-Blöcke, Trennlinien, **fett**, *kursiv*, `code`, [Links](url).
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0], k = `${key}-${i++}`;
    if (t.startsWith('**')) out.push(<strong key={k}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith('`')) out.push(<code key={k}>{t.slice(1, -1)}</code>);
    else if (t.startsWith('[')) {
      const [, label, href] = t.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/) || [];
      const safe = /^(https?:|mailto:|\/)/i.test(href || '') ? href : undefined;
      out.push(<a key={k} href={safe} target="_blank" rel="noreferrer">{label}</a>);
    } else out.push(<em key={k}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function renderMarkdown(src: string): ReactNode[] {
  const lines = src.replace(/\r/g, '').split('\n');
  const blocks: ReactNode[] = [];
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
      const level = Math.min(h[1].length + 1, 6);
      const Tag = `h${level}` as 'h2';
      blocks.push(<Tag key={k}>{inline(h[2], k)}</Tag>);
      i++; continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { blocks.push(<hr key={k} />); i++; continue; }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push(<blockquote key={k}>{inline(body.join(' '), k)}</blockquote>);
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
          {task ? <><input type="checkbox" checked={task[1] !== ' '} readOnly /> {inline(task[2], `${k}-${i}`)}</> : inline(t, `${k}-${i}`)}
        </li>);
        i++;
      }
      blocks.push(ordered ? <ol key={k}>{items}</ol> : <ul key={k}>{items}</ul>);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*>|\s*([-*+]|\d+[.)])\s+)/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={k}>{inline(para.join(' '), k)}</p>);
  }
  return blocks;
}
