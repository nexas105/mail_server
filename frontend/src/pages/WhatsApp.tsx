import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { relTime, fullDateTime } from '../lib/dates';
import { onWaEvent } from '../lib/waStream';
import { confirmDialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { StickerMaker } from '../components/StickerMaker';
import { StatusBadge } from '../components/WaStatus';
import type { WaSession, WaChat, WaMessage, Contact, WaReaction, WaScheduled } from '../lib/types';
import { ROUTES } from '../lib/routes';

/**
 * Chat-Ansicht. Alles rund ums Koppeln steckt in pages/WhatsAppConnect.tsx –
 * hier geht es ausschließlich um Gespräche.
 */
export function WhatsApp() {
  const [sessions, setSessions] = useState<WaSession[]>([]);
  const [accountId, setAccountId] = useState<number | null>(null);

  useEffect(() => {
    api<WaSession[]>('/whatsapp/accounts').then(s => {
      setSessions(s);
      setAccountId(a => a ?? s.find(x => x.status === 'connected')?.wa_account_id ?? s[0]?.wa_account_id ?? null);
    });
    return onWaEvent((event, data) => { if (event === 'status') setSessions(data); });
  }, []);

  const active = sessions.find(s => s.wa_account_id === accountId);
  const connected = active?.status === 'connected';

  if (!sessions.length || !sessions.some(s => s.status === 'connected')) {
    return (
      <>
        <div className="toolbar sticky-bar">
          <Icon name="chat" size={16} />
          <strong style={{ fontSize: 16 }}>Chats</strong>
          <span className="grow" />
          {active && <StatusBadge status={active.status} />}
        </div>
        <div className="empty" style={{ padding: '56px 0' }}>
          <Icon name="chat" size={30} />
          <div>WhatsApp ist nicht verbunden</div>
          <div className="muted small">Unter <Link to={ROUTES.whatsapp.connect}>Verbindung</Link> ein Konto koppeln.</div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="toolbar sticky-bar">
        <Icon name="chat" size={16} />
        <strong style={{ fontSize: 16 }}>Chats</strong>
        {sessions.length > 1 && (
          <select value={accountId ?? ''} style={{ width: 'auto' }}
            onChange={e => setAccountId(e.target.value ? +e.target.value : null)}>
            {sessions.map(s => <option key={s.wa_account_id} value={s.wa_account_id}>{s.name}</option>)}
          </select>
        )}
        <span className="grow" />
        {active && <StatusBadge status={active.status} />}
      </div>
      <ChatsTab accountId={accountId} connected={connected} />
    </>
  );
}

/* ------------------------------------------------------------------ Chats */

function ChatsTab({ accountId, connected }: { accountId: number | null; connected: boolean }) {
  const [chats, setChats] = useState<WaChat[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'unread' | 'groups'>('all');

  const load = () => api<WaChat[]>('/whatsapp/chats' + (accountId ? '?account_id=' + accountId : ''))
    .then(setChats);

  useEffect(() => { setChats(null); load(); }, [accountId]);

  useEffect(() => onWaEvent((event, data) => {
    if (event === 'message' || event === 'chat') {
      // Der Server schickt den ganzen Chat mit – Liste an Ort und Stelle nachziehen.
      setChats(cs => {
        if (!cs) return cs;
        const idx = cs.findIndex(c => c.id === data.id);
        const next = idx >= 0 ? [...cs] : [data, ...cs];
        if (idx >= 0) next[idx] = { ...next[idx], ...data };
        return next.sort((a, b) => (b.last_message_ts || 0) - (a.last_message_ts || 0));
      });
    }
  }), []);

  const visible = useMemo(() => (chats || []).filter(c => {
    if (filter === 'unread' && !c.unread) return false;
    if (filter === 'groups' && !c.is_group) return false;
    if (!q.trim()) return true;
    const t = q.toLowerCase();
    return (c.name || '').toLowerCase().includes(t) || c.jid.toLowerCase().includes(t);
  }), [chats, q, filter]);

  const unreadTotal = (chats || []).reduce((n, c) => n + (c.unread || 0), 0);
  const groupCount = (chats || []).filter(c => c.is_group).length;

  if (chats && !chats.length) {
    return (
      <div className="empty" style={{ padding: '48px 0' }}>
        <Icon name="chat" size={30} />
        <div>{connected ? 'Noch keine Chats' : 'Nicht verbunden'}</div>
        <div className="muted small">
          {connected
            ? 'Sobald eine Nachricht eingeht, erscheint sie hier.'
            : 'Unter „Verbindung" ein Konto koppeln.'}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="toolbar">
        <div className="searchbox grow">
          <Icon name="search" size={14} />
          <input value={q} placeholder="Chats durchsuchen" onChange={e => setQ(e.target.value)} />
        </div>
        <div className="chips">
          <button className={'chip' + (filter === 'all' ? ' active' : '')} onClick={() => setFilter('all')}>
            Alle <span className="count">{chats?.length ?? 0}</span>
          </button>
          <button className={'chip' + (filter === 'unread' ? ' active' : '')} onClick={() => setFilter('unread')}>
            Ungelesen <span className="count">{unreadTotal}</span>
          </button>
          <button className={'chip' + (filter === 'groups' ? ' active' : '')} onClick={() => setFilter('groups')}>
            Gruppen <span className="count">{groupCount}</span>
          </button>
        </div>
      </div>

      <div className="editor-grid">
        <div className="editor-main">
          {!chats ? <>{[0, 1, 2, 3].map(i => <div key={i} className="skel skel-row" />)}</>
            : visible.map(c => (
              <div key={c.id}
                className={'list-item' + (selected === c.id ? ' sel' : '')}
                onClick={() => setSelected(selected === c.id ? null : c.id)}>
                {!!c.unread && <span className="unread-dot" />}
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="title" style={{ fontWeight: c.unread ? 600 : 400 }}>
                    {c.name || c.jid.split('@')[0]}
                    {c.is_group === 1 && <span className="badge" style={{ marginLeft: 6 }}>Gruppe</span>}
                  </div>
                  <div className="muted small" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {c.last_snippet || '—'}
                  </div>
                </div>
                {!!c.unread && <span className="badge">{c.unread}</span>}
                {c.last_message_ts && (
                  <span className="muted small" title={fullDateTime(new Date(c.last_message_ts * 1000).toISOString())}>
                    {relTime(new Date(c.last_message_ts * 1000).toISOString())}
                  </span>
                )}
              </div>
            ))}
        </div>

        <div className="editor-preview">
          {selected
            ? <Thread key={selected} chatId={selected} connected={connected} />
            : <div className="empty"><Icon name="chat" size={26} /><div>Chat auswählen</div></div>}
        </div>
      </div>
    </>
  );
}

/* ----------------------------------------------------------------- Thread */

function Thread({ chatId, connected }: { chatId: number; connected: boolean }) {
  const [chat, setChat] = useState<WaChat | null>(null);
  const [msgs, setMsgs] = useState<WaMessage[] | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [linking, setLinking] = useState(false);
  const [picking, setPicking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [sticker, setSticker] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [cq, setCq] = useState('');
  // Geplante Nachrichten: Panel zum Anlegen + Liste der offenen Aufträge.
  const [planning, setPlanning] = useState(false);
  const [planAt, setPlanAt] = useState('');
  const [planNote, setPlanNote] = useState('');
  const [scheduled, setScheduled] = useState<WaScheduled[]>([]);
  const endRef = useRef<HTMLDivElement>(null);
  const nav = useNavigate();

  const load = () => api<WaMessage[]>(`/whatsapp/chats/${chatId}/messages?limit=60`)
    .then(m => setMsgs(m.slice().reverse()));

  const loadScheduled = () => api<WaScheduled[]>(`/whatsapp/scheduled?chat_id=${chatId}&limit=20`)
    .then(setScheduled).catch(() => {});

  useEffect(() => {
    api<WaChat>('/whatsapp/chats/' + chatId).then(setChat);
    load();
    loadScheduled();
    api('/whatsapp/chats/' + chatId + '/read', { method: 'POST' }).catch(() => {});
  }, [chatId]);

  useEffect(() => onWaEvent((event, data) => {
    if (event === 'message' && data?.message?.chat_id === chatId) {
      setMsgs(ms => (ms || []).some(m => m.id === data.message.id) ? ms : [...(ms || []), data.message]);
    }
    if (event === 'scheduled' && data?.chat_id === chatId && data.item) {
      setScheduled(list => {
        const rest = list.filter(x => x.id !== data.item.id);
        return [data.item as WaScheduled, ...rest];
      });
    }
    if (event === 'reaction' && data?.chat_id === chatId) {
      setMsgs(ms => (ms || []).map(m =>
        m.wa_id === data.target_wa_id ? { ...m, reactions: data.reactions } : m));
    }
  }), [chatId]);

  /** Reaktion setzen oder – bei erneutem Klick auf dieselbe – zurücknehmen. */
  async function react(m: WaMessage, emoji: string) {
    const mine = m.reactions?.find(r => r.mine);
    const next = mine?.emoji === emoji ? '' : emoji;
    try {
      const r = await api<{ reactions: WaReaction[] }>(`/whatsapp/messages/${m.id}/react`,
        { method: 'POST', body: { emoji: next } });
      setMsgs(ms => (ms || []).map(x => x.id === m.id ? { ...x, reactions: r.reactions } : x));
    } catch (e) { toast((e as Error).message, 'err'); }
  }

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [msgs?.length]);

  async function send() {
    const t = text.trim();
    if (!t) return;
    setSending(true);
    try {
      await api(`/whatsapp/chats/${chatId}/messages`, { method: 'POST', body: { text: t } });
      setText('');
    } catch (e) { toast((e as Error).message, 'err'); }
    setSending(false);
  }

  /** Vorbelegung fürs Planen: nächste volle Stunde, als Wert für datetime-local. */
  function openPlanning() {
    const d = new Date(Date.now() + 3600_000);
    d.setMinutes(0, 0, 0);
    setPlanAt(toLocalInput(d));
    setPlanning(true);
  }

  async function schedule() {
    const t = text.trim();
    if (!t || !planAt) return;
    const when = new Date(planAt);
    if (Number.isNaN(when.getTime())) { toast('Zeitpunkt ungültig', 'err'); return; }
    if (when.getTime() < Date.now()) { toast('Zeitpunkt liegt in der Vergangenheit', 'err'); return; }
    setSending(true);
    try {
      await api(`/whatsapp/chats/${chatId}/scheduled`, {
        method: 'POST', body: { text: t, send_at: when.toISOString(), note: planNote.trim() || undefined },
      });
      setText(''); setPlanNote(''); setPlanning(false);
      toast('Eingeplant für ' + when.toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }));
      loadScheduled();
    } catch (e) { toast((e as Error).message, 'err'); }
    setSending(false);
  }

  async function cancelScheduled(item: WaScheduled) {
    if (!await confirmDialog({ title: 'Geplante Nachricht zurückziehen?', message: item.text.slice(0, 160), confirmLabel: 'Zurückziehen', danger: true })) return;
    try {
      await api(`/whatsapp/scheduled/${item.id}`, { method: 'DELETE' });
      loadScheduled();
    } catch (e) { toast((e as Error).message, 'err'); }
  }

  /** Text in den Composer zurückholen, Auftrag zurückziehen – so „ändert" man ihn. */
  async function editScheduled(item: WaScheduled) {
    try {
      await api(`/whatsapp/scheduled/${item.id}`, { method: 'DELETE' });
      setText(item.text);
      setPlanNote(item.note || '');
      setPlanAt(toLocalInput(new Date(item.send_at * 1000)));
      setPlanning(true);
      loadScheduled();
    } catch (e) { toast((e as Error).message, 'err'); }
  }

  /** Mit einem vorhandenen Kontakt verknüpfen. */
  async function linkTo(contactId: number) {
    if (!chat?.wa_contact_id) return;
    setLinking(true);
    try {
      await api(`/whatsapp/contacts/${chat.wa_contact_id}/link`, {
        method: 'POST', body: { contact_id: contactId },
      });
      toast('Verknüpft');
      setPicking(false);
      setChat(await api<WaChat>('/whatsapp/chats/' + chatId));
    } catch (e) { toast((e as Error).message, 'err'); }
    setLinking(false);
  }

  /**
   * Neuen Kontakt anlegen. Name ist Pflicht, Mailadresse freiwillig – wer nur
   * eine WhatsApp-Nummer hat, gehört trotzdem ins Adressbuch.
   */
  async function createAndLink() {
    if (!chat?.wa_contact_id) return;
    if (!newName.trim()) return toast('Name fehlt', 'err');
    setLinking(true);
    try {
      await api(`/whatsapp/contacts/${chat.wa_contact_id}/link`, {
        method: 'POST',
        body: {
          name: newName.trim(),
          email: newEmail.trim() || undefined,
          phone: chat.jid.endsWith('@s.whatsapp.net') ? chat.jid.split('@')[0] : undefined,
        },
      });
      toast('Angelegt und verknüpft');
      setPicking(false); setCreating(false);
      setChat(await api<WaChat>('/whatsapp/chats/' + chatId));
    } catch (e) { toast((e as Error).message, 'err'); }
    setLinking(false);
  }

  async function loadOlder() {
    if (!await confirmDialog({
      title: 'Ältere Nachrichten laden?',
      message: 'WhatsApp liefert Verlauf nur, soweit das Telefon ihn noch hergibt – '
        + 'in Schritten von 50 Nachrichten und mit Wartezeiten. Das kann eine Weile dauern '
        + 'und manchmal kommt nichts zurück.',
      confirmLabel: 'Laden',
    })) return;
    setLoadingMore(true);
    try {
      const r = await api<{ rounds: number; complete: boolean }>(
        `/whatsapp/chats/${chatId}/backfill`, { method: 'POST', body: { days: 90 } });
      toast(r.complete ? '90 Tage vollständig' : `${r.rounds} Durchgänge – mehr gab WhatsApp nicht her`);
      await load();
    } catch (e) { toast((e as Error).message, 'err'); }
    setLoadingMore(false);
  }

  let lastDay = '';

  return (
    <div className="card sticky-card" style={{ display: 'flex', flexDirection: 'column', maxHeight: '78vh' }}>
      <div className="toolbar" style={{ marginBottom: 6 }}>
        <div className="grow" style={{ minWidth: 0 }}>
          <strong>{chat?.name || chat?.jid.split('@')[0] || '…'}</strong>
          <div className="muted small">
            {chat?.is_group ? 'Gruppe' : chat?.jid.split('@')[0]}
          </div>
        </div>
        {/* Verknüpft → direkt zum Kontakt. Nicht verknüpft → hier übernehmen,
            ohne die Seite zu verlassen. Gruppen haben keinen Einzelkontakt. */}
        {!chat?.is_group && (chat?.contact_id ? (
          <button className="btn ghost sm" title={chat.contact_email || undefined}
            onClick={() => nav(ROUTES.manage.contacts + '?id=' + chat.contact_id)}>
            <Icon name="users" size={13} /> {chat.contact_name || chat.contact_email || 'Kontakt'}
          </button>
        ) : (
          <button className="btn ghost sm" disabled={linking}
            onClick={() => { setPicking(p => !p); if (!contacts.length) api<Contact[]>('/contacts').then(setContacts); }}>
            <Icon name="plus" size={13} /> {linking ? '…' : 'Ins Adressbuch'}
          </button>
        ))}
        <button className="btn ghost sm" disabled={!connected || loadingMore} onClick={loadOlder}>
          <Icon name="download" size={13} /> {loadingMore ? '…' : 'Ältere'}
        </button>
      </div>

      {picking && (
        <div className="card" style={{ marginBottom: 8, padding: 12 }}>
          <div className="muted small" style={{ marginBottom: 8 }}>
            Mit vorhandenem Kontakt verknüpfen – oder unten neu anlegen.
          </div>
          <div className="searchbox">
            <Icon name="search" size={14} />
            <input autoFocus value={cq} placeholder="Name oder E-Mail" onChange={e => setCq(e.target.value)} />
          </div>
          <div style={{ maxHeight: 180, overflowY: 'auto', marginTop: 6 }}>
            {contacts
              .filter(c => !cq.trim() || (c.name || '').toLowerCase().includes(cq.toLowerCase())
                || c.email.toLowerCase().includes(cq.toLowerCase()))
              .slice(0, 12)
              .map(c => (
                <div key={c.id} className="list-item" onClick={() => linkTo(c.id)}>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="title">{c.name || c.email}</div>
                    <div className="muted small">{c.email}</div>
                  </div>
                </div>
              ))}
          </div>
          {creating ? (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
              <label>Name</label>
              <input autoFocus value={newName} placeholder="Vorname Nachname"
                onChange={e => setNewName(e.target.value)} />
              <label>E-Mail <span className="muted">(optional)</span></label>
              <input type="email" value={newEmail} placeholder="nur falls vorhanden"
                onChange={e => setNewEmail(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') createAndLink(); }} />
              <div className="muted small" style={{ marginTop: 4 }}>
                Ohne Adresse landet der Kontakt im Adressbuch, wird beim Mailversand aber
                übersprungen.
              </div>
              <div className="toolbar" style={{ marginTop: 10, marginBottom: 0 }}>
                <button className="btn sm" disabled={linking || !newName.trim()} onClick={createAndLink}>
                  <Icon name="save" size={13} /> {linking ? '…' : 'Anlegen und verknüpfen'}
                </button>
                <span className="grow" />
                <button className="btn ghost sm" onClick={() => setCreating(false)}>Zurück</button>
              </div>
            </div>
          ) : (
            <div className="toolbar" style={{ marginTop: 8, marginBottom: 0 }}>
              <button className="btn sm" disabled={linking}
                onClick={() => {
                  // Namen vorbelegen – aber nur, wenn es wirklich einer ist und
                  // nicht die nackte Kennung des Chats.
                  const guess = chat?.name && !/^\d+$/.test(chat.name) ? chat.name : '';
                  setNewName(guess); setNewEmail(''); setCreating(true);
                }}>
                <Icon name="plus" size={13} /> Neuen Kontakt anlegen
              </button>
              <span className="grow" />
              <button className="btn ghost sm" onClick={() => setPicking(false)}>Abbrechen</button>
            </div>
          )}
        </div>
      )}

      <div className="wa-thread">
        {!msgs ? <div className="skel skel-row" /> : msgs.map(m => {
          const day = new Date(m.ts * 1000).toLocaleDateString('de-DE',
            { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
          const showDay = day !== lastDay;
          lastDay = day;
          return (
            <div key={m.id}>
              {showDay && <div className="wa-day">{day}</div>}
              <Bubble m={m} isGroup={chat?.is_group === 1}
                onReact={connected ? e => react(m, e) : undefined} />
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      {sticker && (
        <StickerMaker chatId={chatId} onClose={() => setSticker(false)} onSent={() => {}} />
      )}

      {/* Offene und gescheiterte Aufträge – erledigte verschwinden still. */}
      {scheduled.some(x => x.status === 'pending' || x.status === 'failed') && (
        <div className="wa-scheduled">
          {scheduled.filter(x => x.status === 'pending' || x.status === 'failed').map(x => (
            <div key={x.id} className={'wa-sched-item' + (x.status === 'failed' ? ' failed' : '')}>
              <Icon name={x.status === 'failed' ? 'alert' : 'clock'} size={13} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="small">
                  <strong>{schedWhen(x.send_at)}</strong>
                  {x.note && <span className="muted"> · {x.note}</span>}
                  {x.origin === 'mcp' && <span className="badge" style={{ marginLeft: 6 }}>KI</span>}
                </div>
                <div className="muted small" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                  title={x.text}>
                  {x.status === 'failed' ? `Gescheitert: ${x.error || 'unbekannt'} – ` : ''}{x.text}
                </div>
                {x.status === 'pending' && x.error && (
                  <div className="muted small">Letzter Versuch: {x.error}</div>
                )}
              </div>
              {x.status === 'pending' && (
                <button className="btn ghost sm" title="Text zurück in den Editor, Auftrag zurückziehen"
                  onClick={() => editScheduled(x)}>
                  <Icon name="edit" size={12} />
                </button>
              )}
              <button className="btn ghost sm" title={x.status === 'pending' ? 'Zurückziehen' : 'Ausblenden'}
                onClick={() => x.status === 'pending' ? cancelScheduled(x)
                  : setScheduled(l => l.filter(y => y.id !== x.id))}>
                <Icon name="x" size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {planning && (
        <div className="wa-plan">
          <div className="muted small" style={{ marginBottom: 6 }}>
            Text unten eingeben – er geht zum gewählten Zeitpunkt automatisch raus, solange der
            Server läuft und das Konto verbunden ist.
          </div>
          <div className="toolbar" style={{ marginBottom: 0, flexWrap: 'wrap' }}>
            <input type="datetime-local" value={planAt} style={{ width: 'auto', margin: 0 }}
              onChange={e => setPlanAt(e.target.value)} />
            <input value={planNote} placeholder="Merkzettel (optional), z.B. „Nach ihrer Woche fragen“"
              style={{ flex: 1, minWidth: 160, margin: 0 }} maxLength={200}
              onChange={e => setPlanNote(e.target.value)} />
            <button className="btn sm" disabled={!connected || sending || !text.trim() || !planAt} onClick={schedule}>
              <Icon name="clock" size={13} /> Einplanen
            </button>
            <button className="btn ghost sm" onClick={() => setPlanning(false)}>Abbrechen</button>
          </div>
        </div>
      )}

      <div className="wa-composer">
        <textarea rows={2} value={text} placeholder={connected ? (planning ? 'Geplante Nachricht …' : 'Nachricht …') : 'Nicht verbunden'}
          disabled={!connected || sending}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); planning ? schedule() : send(); } }} />
        <button className="btn ghost icon-only" title="Sticker aus Bild" disabled={!connected}
          onClick={() => setSticker(true)}>
          <Icon name="sticker" size={15} />
        </button>
        <button className={'btn ghost icon-only' + (planning ? ' active' : '')} title="Später senden" disabled={!connected}
          onClick={() => planning ? setPlanning(false) : openPlanning()}>
          <Icon name="clock" size={15} />
        </button>
        {planning ? (
          <button className="btn" disabled={!connected || sending || !text.trim() || !planAt} onClick={schedule}>
            <Icon name="clock" size={14} /> {sending ? '…' : 'Einplanen'}
          </button>
        ) : (
          <button className="btn" disabled={!connected || sending || !text.trim()} onClick={send}>
            <Icon name="send" size={14} /> {sending ? '…' : 'Senden'}
          </button>
        )}
      </div>
    </div>
  );
}

/** Datum für <input type="datetime-local"> – in Ortszeit, ohne Sekunden. */
function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function schedWhen(ts: number): string {
  return new Date(ts * 1000).toLocaleString('de-DE',
    { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const TICK: Record<string, string> = { pending: '·', sent: '✓', delivered: '✓✓', read: '✓✓' };

/** Auswahl beim Reagieren – dieselben, die WhatsApp selbst anbietet. */
const QUICK = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

function Bubble({ m, isGroup, onReact }: {
  m: WaMessage; isGroup: boolean; onReact?: (emoji: string) => void;
}) {
  const [picker, setPicker] = useState(false);
  const time = new Date(m.ts * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const isMedia = !!m.media_mime;
  return (
    <div className={'wa-row' + (m.from_me ? ' me' : '')}>
      {onReact && (
        <div className="wa-react-trigger">
          <button className="btn ghost sm icon-only" title="Reagieren"
            onClick={() => setPicker(p => !p)}><Icon name="sparkle" size={12} /></button>
          {picker && (
            <div className="wa-react-picker" onMouseLeave={() => setPicker(false)}>
              {QUICK.map(e => (
                <button key={e} onClick={() => { onReact(e); setPicker(false); }}>{e}</button>
              ))}
            </div>
          )}
        </div>
      )}
    <div className={'wa-bubble' + (m.from_me ? ' me' : '')}>
      {isGroup && !m.from_me && m.sender_name && <div className="wa-sender">{m.sender_name}</div>}
      {isMedia && <Media m={m} />}
      {m.body && <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.body}</div>}
      {!m.body && !isMedia && <div className="muted small">{m.snippet || m.type}</div>}
      <div className="meta">
        {m.origin === 'mcp' && <span className="badge" style={{ marginRight: 4 }}>KI</span>}
        {time}{m.from_me && m.status ? ' ' + (TICK[m.status] || '') : ''}
      </div>
      {!!m.reactions?.length && (
        <div className="wa-reactions">
          {m.reactions.map(r => (
            <button key={r.emoji} className={'wa-reaction' + (r.mine ? ' mine' : '')}
              onClick={() => onReact?.(r.emoji)} disabled={!onReact}
              title={r.mine ? 'Deine Reaktion – nochmal klicken zum Zurücknehmen' : undefined}>
              {r.emoji}{r.count > 1 && <span>{r.count}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
    </div>
  );
}


/**
 * Medien in der Sprechblase. Sprachnachrichten sind mit Abstand der häufigste
 * Fall, deshalb bekommen sie einen echten Abspieler statt eines Downloadlinks.
 *
 * WhatsApp liefert Sprachnachrichten als Opus in einem Ogg-Container. Chrome
 * und Firefox spielen das direkt; ältere Safari-Versionen nicht – dafür der
 * Hinweis samt Downloadmöglichkeit im Fehlerfall.
 */
function Media({ m }: { m: WaMessage }) {
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'gone'>(
    m.media_downloaded ? 'ready' : 'idle');
  const [why, setWhy] = useState('');
  const url = `/api/whatsapp/messages/${m.id}/media`;
  const mime = m.media_mime || '';
  const size = m.media_size ? ` · ${(m.media_size / 1024).toFixed(0)} KB` : '';
  const label = { audio: 'Sprachnachricht', image: 'Bild', video: 'Video',
    document: m.media_filename || 'Dokument', sticker: 'Sticker' }[m.type] || 'Datei';

  /**
   * Noch nicht geladene Medien erst auf Klick holen. Der Server versucht dabei,
   * die Datei beim Absendergerät neu anzufordern – bei alten Nachrichten aus
   * dem Verlaufs-Abgleich schlägt das oft fehl, deshalb der eigene Zustand
   * statt eines Abspielers, der ins Leere greift.
   */
  async function fetchIt() {
    setState('loading');
    try {
      const r = await fetch(url);
      if (!r.ok) {
        const j = await r.json().catch(() => ({} as any));
        setWhy(j.error || 'Nicht abrufbar');
        setState('gone');
        return;
      }
      setState('ready');
    } catch { setWhy('Netzwerkfehler'); setState('gone'); }
  }

  if (state === 'gone') {
    return <div className="muted small" style={{ lineHeight: 1.5 }}>
      <Icon name="alert" size={12} /> {label} nicht mehr abrufbar
      <div style={{ opacity: .8 }}>{why}</div>
    </div>;
  }

  if (state !== 'ready') {
    return (
      <button className="btn ghost sm" disabled={state === 'loading'} onClick={fetchIt}
        style={{ marginBottom: 4 }}>
        <Icon name="download" size={12} /> {state === 'loading' ? 'Lädt …' : `${label} laden${size}`}
      </button>
    );
  }

  if (mime.startsWith('image/')) {
    return <a href={url} target="_blank" rel="noreferrer">
      <img className="media" src={url} alt={m.media_filename || 'Bild'} loading="lazy" />
    </a>;
  }
  if (mime.startsWith('audio/')) {
    return <audio className="wa-audio" controls preload="metadata"
      onError={() => { setWhy('Dieser Browser spielt Opus/Ogg nicht ab'); setState('gone'); }}>
      <source src={url} type={mime.split(';')[0]} />
    </audio>;
  }
  if (mime.startsWith('video/')) {
    return <video className="media" controls preload="metadata" src={url} />;
  }
  return (
    <div className="muted small">
      <Icon name="paperclip" size={12} /> {m.media_filename || m.type}{size}
      {' '}<a href={url} target="_blank" rel="noreferrer">öffnen</a>
    </div>
  );
}
