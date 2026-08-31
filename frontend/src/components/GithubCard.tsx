import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { relTime } from '../lib/dates';
import { confirmDialog } from './Dialog';
import { Icon } from './Icon';
import type { GithubConnection } from '../lib/types';

/**
 * GitHub-Verbindungen. Liegt beim Profil, nicht bei den Einstellungen:
 * das Token gehört einem Menschen, nicht dem Server.
 */
export function GithubCard() {
  const [conns, setConns] = useState<GithubConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<number | 'new' | null>(null);
  const [form, setForm] = useState({ name: '', token: '', api_base: '' });
  const [editing, setEditing] = useState<number | null>(null);

  const load = () => api<GithubConnection[]>('/github/connections')
    .then(setConns).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  function reset() { setForm({ name: '', token: '', api_base: '' }); setEditing(null); }

  function edit(c: GithubConnection) {
    // Das Token wird bewusst NICHT vorbefüllt – der Server gibt es nie heraus.
    setEditing(c.id);
    setForm({ name: c.name, token: '', api_base: c.api_base === 'https://api.github.com' ? '' : c.api_base });
  }

  async function save() {
    if (!form.name.trim()) return toast('Name erforderlich', 'err');
    if (!editing && !form.token.trim()) return toast('Token erforderlich', 'err');
    setBusy(editing ?? 'new');
    try {
      const body: Record<string, unknown> = { name: form.name.trim() };
      if (form.token.trim()) body.token = form.token.trim();
      if (form.api_base.trim()) body.api_base = form.api_base.trim();
      if (editing) await api('/github/connections/' + editing, { method: 'PUT', body });
      else await api('/github/connections', { method: 'POST', body });
      toast(editing ? 'Verbindung gespeichert' : 'Verbindung angelegt');
      reset(); await load();
    } catch (e) { toast((e as Error).message, 'err'); }
    setBusy(null);
  }

  async function verify(c: GithubConnection) {
    setBusy(c.id);
    try {
      const r = await api<{ login: string; token_type: string }>(
        '/github/connections/' + c.id + '/verify', { method: 'POST' });
      toast(`Angemeldet als @${r.login}`);
    } catch (e) { toast((e as Error).message, 'err'); }
    await load();
    setBusy(null);
  }

  async function remove(c: GithubConnection) {
    if (!await confirmDialog({
      title: 'Verbindung löschen?',
      message: `„${c.name}" wird entfernt. Verknüpfte Repos bleiben bestehen, sind aber ohne Token nicht mehr abrufbar.`,
      danger: true, confirmLabel: 'Löschen',
    })) return;
    setBusy(c.id);
    try { await api('/github/connections/' + c.id, { method: 'DELETE' }); toast('Gelöscht'); await load(); }
    catch (e) { toast((e as Error).message, 'err'); }
    setBusy(null);
  }

  async function makeDefault(c: GithubConnection) {
    setBusy(c.id);
    try { await api('/github/connections/' + c.id + '/default', { method: 'POST' }); await load(); }
    catch (e) { toast((e as Error).message, 'err'); }
    setBusy(null);
  }

  return (
    <div className="card">
      <div className="toolbar">
        <Icon name="git" size={16} />
        <strong className="grow">GitHub</strong>
      </div>
      <div className="muted small" style={{ marginBottom: 12 }}>
        Ein Token hinterlegen, dann lassen sich bei den Kontakten Repos verknüpfen –
        die KI kann sie über MCP lesen.
      </div>

      {loading ? <div className="skel skel-row" /> : conns.length === 0 ? (
        <div className="empty" style={{ padding: '18px 0' }}>
          <Icon name="git" size={26} />
          <div>Noch keine Verbindung</div>
        </div>
      ) : conns.map(c => (
        <div key={c.id} className="list-item static" style={{ alignItems: 'flex-start' }}>
          <div className="grow">
            <div className="title">
              {c.name}
              {c.is_default === 1 && conns.length > 1 && <span className="badge sent" style={{ marginLeft: 6 }}>Standard</span>}
              {c.token_type === 'fine_grained' && <span className="badge" style={{ marginLeft: 6 }}>Fine-grained</span>}
            </div>
            <div className="muted small">
              {c.login
                ? <>@{c.login} · geprüft {c.verified_at ? relTime(c.verified_at) : '–'}</>
                : <>noch nicht geprüft</>}
              {c.api_base !== 'https://api.github.com' && <> · {c.api_base}</>}
            </div>
            {c.scopes && (
              <div style={{ marginTop: 4 }}>
                {c.scopes.split(',').filter(Boolean).map(s => <span key={s} className="pill">{s}</span>)}
              </div>
            )}
            {c.last_error && <div className="badge failed" style={{ marginTop: 6 }}>{c.last_error}</div>}
          </div>
          <div className="toolbar" style={{ margin: 0, gap: 4 }}>
            <button className="btn ghost sm" disabled={busy === c.id} onClick={() => verify(c)}>
              <Icon name="check" size={13} /> {busy === c.id ? '…' : 'Testen'}
            </button>
            {conns.length > 1 && c.is_default !== 1 && (
              <button className="btn ghost sm" disabled={busy === c.id} onClick={() => makeDefault(c)}>Standard</button>
            )}
            <button className="btn ghost sm icon-only" title="Bearbeiten" onClick={() => edit(c)}>
              <Icon name="edit" size={13} />
            </button>
            <button className="btn ghost sm icon-only danger" title="Löschen" disabled={busy === c.id} onClick={() => remove(c)}>
              <Icon name="trash" size={13} />
            </button>
          </div>
        </div>
      ))}

      <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
        <div className="toolbar" style={{ marginBottom: 6 }}>
          <strong className="grow small">{editing ? 'Verbindung bearbeiten' : 'Neue Verbindung'}</strong>
          {editing && <button className="btn ghost sm" onClick={reset}>Abbrechen</button>}
        </div>
        <label>Name</label>
        <input value={form.name} placeholder="Privat" onChange={e => setForm({ ...form, name: e.target.value })} />
        <label>
          Token {editing && <span className="muted">(leer lassen = unverändert)</span>}
        </label>
        <input type="password" value={form.token} placeholder="github_pat_… oder ghp_…"
          onChange={e => setForm({ ...form, token: e.target.value })} />
        <details style={{ marginTop: 8 }}>
          <summary className="muted small" style={{ cursor: 'pointer' }}>GitHub Enterprise</summary>
          <label>API-Basis</label>
          <input value={form.api_base} placeholder="https://api.github.com"
            onChange={e => setForm({ ...form, api_base: e.target.value })} />
        </details>
        <div className="toolbar" style={{ marginTop: 10, marginBottom: 0 }}>
          <button className="btn" disabled={busy !== null} onClick={save}>
            <Icon name="save" size={14} /> {editing ? 'Speichern' : 'Anlegen'}
          </button>
        </div>
      </div>

      <details style={{ marginTop: 14 }}>
        <summary className="muted small" style={{ cursor: 'pointer' }}>Welches Token brauche ich?</summary>
        <div className="small" style={{ marginTop: 8, lineHeight: 1.7 }}>
          Ein <strong>Fine-grained Personal Access Token</strong> unter{' '}
          <a href="https://github.com/settings/personal-access-tokens" target="_blank" rel="noreferrer">
            github.com/settings/personal-access-tokens <Icon name="external" size={11} />
          </a>. Bei <em>Repository access</em> nur die Repos auswählen, die du wirklich verknüpfen willst.
          Berechtigungen, alle nur lesend:
          <div style={{ marginTop: 6 }}>
            <span className="pill">Metadata: Read</span>
            <span className="pill">Contents: Read</span>
            <span className="pill">Issues: Read</span>
            <span className="pill">Pull requests: Read</span>
          </div>
          <div className="muted" style={{ marginTop: 8 }}>
            Ein klassisches Token mit <code>repo</code> funktioniert auch, gibt aber Schreibrechte
            auf <em>alle</em> deine privaten Repos – deshalb lieber fine-grained.
          </div>
          <div className="muted" style={{ marginTop: 8 }}>
            Das Token wird verschlüsselt gespeichert und nie wieder ausgeliefert – auch nicht an diese
            Seite. Vergessen heißt: neues Token anlegen.
          </div>
        </div>
      </details>
    </div>
  );
}
