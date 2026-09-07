import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { onWaEvent } from '../lib/waStream';
import { confirmDialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import type { WaScheduled } from '../lib/types';
import { ROUTES } from '../lib/routes';

type Filter = 'pending' | 'failed' | 'sent' | 'cancelled' | 'all';

const LABEL: Record<WaScheduled['status'], string> = {
  pending: 'Offen', sent: 'Gesendet', failed: 'Gescheitert', cancelled: 'Zurückgezogen',
};
const BADGE: Record<WaScheduled['status'], string> = {
  pending: 'sending', sent: 'sent', failed: 'failed', cancelled: '',
};

/**
 * Übersicht aller geplanten WhatsApp-Nachrichten, chat-übergreifend.
 * Anlegen passiert im Chat (Uhr-Knopf im Eingabefeld) oder per MCP – hier wird
 * verwaltet: nachlesen, ändern, zurückziehen, und sehen, was der Planer mit
 * einem Auftrag gemacht hat.
 */
export function WhatsAppScheduled() {
  const [rows, setRows] = useState<WaScheduled[] | null>(null);
  const [filter, setFilter] = useState<Filter>('pending');
  const [editing, setEditing] = useState<number | null>(null);
  const [eText, setEText] = useState('');
  const [eAt, setEAt] = useState('');
  const [eNote, setENote] = useState('');
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();

  const load = () => api<WaScheduled[]>('/whatsapp/scheduled?limit=200').then(setRows);
  useEffect(() => { load(); }, []);

  // Der Planer meldet jede Änderung (gesendet, gescheitert, neu angelegt) live.
  useEffect(() => onWaEvent((event, data) => {
    if (event !== 'scheduled' || !data?.item) return;
    setRows(rs => {
      if (!rs) return rs;
      const idx = rs.findIndex(r => r.id === data.item.id);
      const next = idx >= 0 ? [...rs] : [data.item as WaScheduled, ...rs];
      if (idx >= 0) next[idx] = data.item;
      return next;
    });
  }), []);

  const counts = useMemo(() => {
    const c = { pending: 0, failed: 0, sent: 0, cancelled: 0 };
    for (const r of rows || []) c[r.status]++;
    return c;
  }, [rows]);

  const visible = useMemo(() => {
    const list = (rows || []).filter(r => filter === 'all' || r.status === filter);
    // Offene aufsteigend (was kommt als Nächstes), Erledigte absteigend (was war zuletzt).
    return list.sort((a, b) => {
      if (a.status === 'pending' && b.status !== 'pending') return -1;
      if (b.status === 'pending' && a.status !== 'pending') return 1;
      return a.status === 'pending' ? a.send_at - b.send_at : b.send_at - a.send_at;
    });
  }, [rows, filter]);

  function startEdit(r: WaScheduled) {
    setEditing(r.id); setEText(r.text); setENote(r.note || '');
    setEAt(toLocalInput(new Date(r.send_at * 1000)));
  }

  async function saveEdit() {
    if (editing == null) return;
    const when = new Date(eAt);
    if (Number.isNaN(when.getTime())) { toast('Zeitpunkt ungültig', 'err'); return; }
    if (when.getTime() < Date.now()) { toast('Zeitpunkt liegt in der Vergangenheit', 'err'); return; }
    if (!eText.trim()) { toast('Text fehlt', 'err'); return; }
    setBusy(true);
    try {
      await api(`/whatsapp/scheduled/${editing}`, {
        method: 'PUT', body: { text: eText.trim(), send_at: when.toISOString(), note: eNote.trim() || null },
      });
      toast('Gespeichert'); setEditing(null); await load();
    } catch (e) { toast((e as Error).message, 'err'); }
    setBusy(false);
  }

  async function cancel(r: WaScheduled) {
    if (!await confirmDialog({
      title: 'Geplante Nachricht zurückziehen?',
      message: `An ${r.chat_name || r.chat_jid.split('@')[0]}, ${when(r.send_at)}:\n${r.text.slice(0, 200)}`,
      confirmLabel: 'Zurückziehen', danger: true,
    })) return;
    try {
      await api(`/whatsapp/scheduled/${r.id}`, { method: 'DELETE' });
      toast('Zurückgezogen'); await load();
    } catch (e) { toast((e as Error).message, 'err'); }
  }

  return (
    <>
      <div className="toolbar sticky-bar">
        <Icon name="clock" size={16} />
        <strong style={{ fontSize: 16 }}>Geplante Nachrichten</strong>
        <span className="grow" />
        <div className="chips">
          {(['pending', 'failed', 'sent', 'cancelled', 'all'] as Filter[]).map(f => (
            <button key={f} className={'chip' + (filter === f ? ' active' : '')} onClick={() => setFilter(f)}>
              {f === 'all' ? 'Alle' : LABEL[f]}
              <span className="count">{f === 'all' ? (rows?.length ?? 0) : counts[f]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="muted small" style={{ marginBottom: 14 }}>
        Neue Aufträge legst du im Chat an: Text eingeben, Uhr-Knopf, Zeitpunkt wählen. Der Server
        sendet zur Sendezeit von selbst, solange er läuft und das Konto verbunden ist. Ist es das
        nicht, versucht er es weiter und gibt nach sechs Stunden Verspätung auf.
      </div>

      {!rows ? <>{[0, 1, 2].map(i => <div key={i} className="skel skel-row" />)}</>
        : !visible.length ? (
          <div className="empty" style={{ padding: '48px 0' }}>
            <Icon name="clock" size={30} />
            <div>{filter === 'pending' ? 'Nichts geplant' : 'Keine Einträge'}</div>
            <div className="muted small">
              {filter === 'pending' ? 'Im Chat über den Uhr-Knopf eine Nachricht für später anlegen.' : ''}
            </div>
          </div>
        ) : visible.map(r => (
          <div key={r.id} className="card" style={{ marginBottom: 10, padding: 14 }}>
            <div className="toolbar" style={{ marginBottom: 6 }}>
              <span className={'badge ' + BADGE[r.status]}>{LABEL[r.status]}</span>
              <strong>{when(r.send_at)}</strong>
              <span className="muted">an</span>
              <button className="btn ghost sm" title="Chat öffnen"
                onClick={() => nav(ROUTES.whatsapp.chats + '?chat=' + r.chat_id)}>
                <Icon name="chat" size={12} /> {r.chat_name || r.chat_jid.split('@')[0]}
              </button>
              {r.origin === 'mcp' && <span className="badge" title="Per MCP (KI) angelegt">KI</span>}
              <span className="grow" />
              {r.status === 'pending' && editing !== r.id && (
                <>
                  <button className="btn ghost sm" onClick={() => startEdit(r)}>
                    <Icon name="edit" size={12} /> Ändern
                  </button>
                  <button className="btn ghost sm" onClick={() => cancel(r)}>
                    <Icon name="x" size={12} /> Zurückziehen
                  </button>
                </>
              )}
            </div>

            {editing === r.id ? (
              <div>
                <label>Text</label>
                <textarea rows={4} value={eText} onChange={e => setEText(e.target.value)} />
                <div className="toolbar" style={{ marginTop: 8, marginBottom: 0, flexWrap: 'wrap' }}>
                  <input type="datetime-local" value={eAt} style={{ width: 'auto', margin: 0 }}
                    onChange={e => setEAt(e.target.value)} />
                  <input value={eNote} placeholder="Merkzettel (optional)" maxLength={200}
                    style={{ flex: 1, minWidth: 160, margin: 0 }} onChange={e => setENote(e.target.value)} />
                  <button className="btn sm" disabled={busy} onClick={saveEdit}>
                    <Icon name="save" size={13} /> {busy ? '…' : 'Speichern'}
                  </button>
                  <button className="btn ghost sm" onClick={() => setEditing(null)}>Abbrechen</button>
                </div>
              </div>
            ) : (
              <>
                {r.note && <div className="muted small" style={{ marginBottom: 4 }}>{r.note}</div>}
                <div style={{ whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.45 }}>{r.text}</div>
                {r.error && (
                  <div className="small" style={{ marginTop: 6, color: 'var(--red)' }}>
                    {r.status === 'pending' ? 'Letzter Versuch: ' : ''}{r.error}
                    {r.attempts > 1 && <span className="muted"> ({r.attempts} Versuche)</span>}
                  </div>
                )}
                {r.status === 'sent' && r.sent_at && (
                  <div className="muted small" style={{ marginTop: 6 }}>Gesendet {fmtDb(r.sent_at)}</div>
                )}
              </>
            )}
          </div>
        ))}
    </>
  );
}

function when(ts: number): string {
  return new Date(ts * 1000).toLocaleString('de-DE',
    { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** SQLite schreibt UTC ohne Zeitzone – als solche lesen. */
function fmtDb(s: string): string {
  const d = new Date(s.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
