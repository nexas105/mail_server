import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { confirmDialog, promptDialog } from './Dialog';
import { toast } from '../lib/toast';
import { fullDateTime, relTime } from '../lib/dates';
import * as auth from '../lib/auth';
import type { ApiToken, AuthUser, SessionInfo } from '../lib/auth';

/* ----------------------------------------------------- Eigenes Konto */

/**
 * Passwort ändern, offene Sitzungen sehen, Zugriffs-Token für Clients ausgeben,
 * die keinen Browser haben (macOS-App, Skripte, Monitoring).
 */
export function AccountCard({ user }: { user: AuthUser }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);

  const loadSessions = () => auth.listSessions().then(setSessions).catch(() => setSessions([]));
  useEffect(() => { loadSessions(); }, []);

  async function save() {
    if (next !== repeat) return toast('Die neuen Passwörter stimmen nicht überein', 'err');
    setBusy(true);
    try {
      await auth.changePassword(current, next);
      setCurrent(''); setNext(''); setRepeat('');
      toast('Passwort geändert – andere Sitzungen wurden abgemeldet');
      loadSessions();
    } catch (e) { toast((e as Error).message, 'err'); }
    setBusy(false);
  }

  async function revokeOthers() {
    const ok = await confirmDialog({
      title: 'Andere Sitzungen beenden?',
      message: 'Alle anderen Browser und Geräte werden abgemeldet. Diese Sitzung bleibt bestehen.',
      confirmLabel: 'Beenden', danger: true,
    });
    if (!ok) return;
    const { revoked } = await auth.revokeOtherSessions();
    toast(revoked ? `${revoked} Sitzung(en) beendet` : 'Keine weiteren Sitzungen');
    loadSessions();
  }

  const others = sessions.filter(s => !s.current).length;

  return (
    <div className="card">
      <div className="toolbar">
        <Icon name="users" size={16} />
        <strong className="grow">Mein Konto</strong>
        <span className="badge">{user.role === 'admin' ? 'Administrator' : 'Benutzer'}</span>
      </div>
      <div className="muted small" style={{ marginBottom: 10 }}>
        Angemeldet als <strong>{user.email}</strong>
        {others > 0 && <> · {others} weitere Sitzung{others === 1 ? '' : 'en'} aktiv</>}
      </div>

      <label>Aktuelles Passwort</label>
      <input type="password" autoComplete="current-password" value={current} onChange={e => setCurrent(e.target.value)} />
      <label>Neues Passwort</label>
      <input type="password" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)}
        placeholder="mindestens 10 Zeichen" />
      <label>Neues Passwort wiederholen</label>
      <input type="password" autoComplete="new-password" value={repeat} onChange={e => setRepeat(e.target.value)} />

      <div className="toolbar" style={{ marginTop: 10 }}>
        <button className="btn sm" onClick={save} disabled={busy || !current || next.length < 10}>
          <Icon name="save" size={14} /> Passwort ändern
        </button>
        <span className="grow" />
        <button className="btn sm danger" onClick={revokeOthers} disabled={!others}>
          Andere Sitzungen beenden
        </button>
      </div>

      {sessions.length > 1 && (
        <div style={{ marginTop: 12 }}>
          {sessions.map((s, i) => (
            <div className="list-item static" key={i}>
              <div className="grow">
                <div className="title">{s.current ? 'Diese Sitzung' : (s.user_agent?.slice(0, 60) || 'Unbekannter Client')}</div>
                <div className="muted small">
                  {s.ip || '—'} · zuletzt {relTime(s.last_seen_at)} · gültig bis {fullDateTime(s.expires_at)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <TokensSection />
    </div>
  );
}

function TokensSection() {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [fresh, setFresh] = useState<string | null>(null);
  const [name, setName] = useState('');

  const load = () => auth.listTokens().then(setTokens).catch(() => setTokens([]));
  useEffect(() => { load(); }, []);

  async function create() {
    if (!name.trim()) return toast('Name erforderlich', 'err');
    try {
      const t = await auth.createToken(name.trim());
      setFresh(t.token); setName(''); load();
    } catch (e) { toast((e as Error).message, 'err'); }
  }

  async function remove(t: ApiToken) {
    const ok = await confirmDialog({
      title: `Token „${t.name}" widerrufen?`,
      message: 'Clients, die es benutzen, verlieren sofort den Zugriff.',
      confirmLabel: 'Widerrufen', danger: true,
    });
    if (!ok) return;
    await auth.deleteToken(t.id);
    load();
  }

  return (
    <>
      <div className="toolbar" style={{ marginTop: 18 }}>
        <Icon name="command" size={15} />
        <strong className="grow">Zugriffs-Token</strong>
      </div>
      <div className="muted small" style={{ marginBottom: 8 }}>
        Für Clients ohne Browser – die macOS-App, Skripte, Monitoring. Der Client schickt den Wert
        als <code>Authorization: Bearer …</code>. Er gilt mit deinen Rechten und ist jederzeit widerrufbar.
      </div>

      {fresh && (
        <div className="auth-token-reveal">
          <div className="muted small">Einmalig sichtbar – jetzt kopieren:</div>
          <code>{fresh}</code>
          <div className="toolbar" style={{ marginTop: 6 }}>
            <button className="btn sm ghost" onClick={() => { navigator.clipboard.writeText(fresh); toast('Kopiert'); }}>
              <Icon name="copy" size={13} /> Kopieren
            </button>
            <button className="btn sm ghost" onClick={() => setFresh(null)}>Verbergen</button>
          </div>
        </div>
      )}

      {tokens.map(t => (
        <div className="list-item static" key={t.id}>
          <div className="grow">
            <div className="title">{t.name}</div>
            <div className="muted small">
              angelegt {relTime(t.created_at)} · {t.last_used_at ? `zuletzt benutzt ${relTime(t.last_used_at)}` : 'noch nie benutzt'}
            </div>
          </div>
          <button className="btn sm danger icon-only" title="Widerrufen" onClick={() => remove(t)}>
            <Icon name="trash" size={14} />
          </button>
        </div>
      ))}

      <div className="toolbar" style={{ marginTop: 8 }}>
        <input placeholder="Name, z.B. macOS-App" value={name} onChange={e => setName(e.target.value)} />
        <button className="btn sm" onClick={create}><Icon name="plus" size={14} /> Token</button>
      </div>
    </>
  );
}

/* ------------------------------------------------------- Benutzerverwaltung */

export function UsersCard({ me }: { me: AuthUser }) {
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [form, setForm] = useState({ email: '', name: '', password: '', role: 'user' as 'admin' | 'user' });
  const [busy, setBusy] = useState(false);

  const load = () => auth.listUsers().then(setUsers).catch(() => setUsers([]));
  useEffect(() => { load(); }, []);

  async function create() {
    setBusy(true);
    try {
      await auth.createUser({
        email: form.email.trim(), name: form.name.trim() || undefined,
        password: form.password, role: form.role,
      });
      setForm({ email: '', name: '', password: '', role: 'user' });
      toast('Benutzer angelegt');
      load();
    } catch (e) { toast((e as Error).message, 'err'); }
    setBusy(false);
  }

  async function toggle(u: AuthUser) {
    try { await auth.updateUser(u.id, { disabled: !u.disabled }); load(); }
    catch (e) { toast((e as Error).message, 'err'); }
  }

  async function setRole(u: AuthUser, role: 'admin' | 'user') {
    try { await auth.updateUser(u.id, { role }); load(); }
    catch (e) { toast((e as Error).message, 'err'); }
  }

  async function resetPassword(u: AuthUser) {
    const pw = await promptDialog({
      title: `Passwort für ${u.email} setzen`,
      message: 'Der Benutzer wird überall abgemeldet und braucht danach das neue Passwort.',
      label: 'Neues Passwort', placeholder: 'mindestens 10 Zeichen', confirmLabel: 'Setzen',
    });
    if (!pw) return;
    try { await auth.resetUserPassword(u.id, pw); toast('Passwort gesetzt'); }
    catch (e) { toast((e as Error).message, 'err'); }
  }

  async function remove(u: AuthUser) {
    const ok = await confirmDialog({
      title: `${u.email} löschen?`,
      message: 'Sitzungen und Token dieses Benutzers werden mitgelöscht.',
      confirmLabel: 'Löschen', danger: true,
    });
    if (!ok) return;
    try { await auth.deleteUser(u.id); load(); }
    catch (e) { toast((e as Error).message, 'err'); }
  }

  return (
    <div className="card">
      <div className="toolbar">
        <Icon name="users" size={16} />
        <strong className="grow">Benutzer</strong>
        <span className="muted small">{users.length}</span>
      </div>

      {users.map(u => (
        <div className="list-item static" key={u.id}>
          <div className="grow">
            <div className="title">
              {u.name || u.email}
              {u.disabled && <span className="badge failed" style={{ marginLeft: 6 }}>deaktiviert</span>}
              {u.id === me.id && <span className="badge" style={{ marginLeft: 6 }}>du</span>}
            </div>
            <div className="muted small">
              {u.email} · {u.last_login_at ? `zuletzt angemeldet ${relTime(u.last_login_at)}` : 'noch nie angemeldet'}
            </div>
          </div>
          <select
            value={u.role} onChange={e => setRole(u, e.target.value as 'admin' | 'user')}
            style={{ width: 'auto', minWidth: 120 }}
          >
            <option value="admin">Administrator</option>
            <option value="user">Benutzer</option>
          </select>
          <button className="btn sm ghost" onClick={() => resetPassword(u)} title="Passwort setzen">
            <Icon name="refresh" size={13} />
          </button>
          <button className="btn sm ghost" onClick={() => toggle(u)} title={u.disabled ? 'Aktivieren' : 'Deaktivieren'}>
            <Icon name={u.disabled ? 'check' : 'x'} size={13} />
          </button>
          {u.id !== me.id && (
            <button className="btn sm danger icon-only" onClick={() => remove(u)} title="Löschen">
              <Icon name="trash" size={14} />
            </button>
          )}
        </div>
      ))}

      <div className="toolbar" style={{ marginTop: 12, flexWrap: 'wrap' }}>
        <input placeholder="E-Mail" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} style={{ minWidth: 180 }} />
        <input placeholder="Name (optional)" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} style={{ minWidth: 140 }} />
        <input placeholder="Passwort" type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} style={{ minWidth: 140 }} />
        <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value as 'admin' | 'user' })} style={{ width: 'auto' }}>
          <option value="user">Benutzer</option>
          <option value="admin">Administrator</option>
        </select>
        <button className="btn sm" onClick={create} disabled={busy || !form.email || form.password.length < 10}>
          <Icon name="plus" size={14} /> Anlegen
        </button>
      </div>
      <div className="muted small" style={{ marginTop: 6 }}>
        Alle Benutzer sehen dieselben Postfächer und Entwürfe. Der Unterschied: nur Administratoren
        dürfen Benutzer verwalten.
      </div>
    </div>
  );
}
