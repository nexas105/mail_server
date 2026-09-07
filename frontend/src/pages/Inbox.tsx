import { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { relTime, fullDateTime } from '../lib/dates';
import { confirmDialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import type { Account, Message, Draft } from '../lib/types';
import { ROUTES } from '../lib/routes';

type StatusFilter = 'all' | 'unread' | 'read' | 'flagged';
type DateFilter = 'all' | 'today' | 'week' | 'month';
interface Mailbox { path: string; name: string; delimiter: string; specialUse: string | null }
interface FolderStat { folder: string; count: number; unread: number }

const fromLabel = (m: Message) => m.from_name || m.from_email || '(unbekannt)';
const escapeHtml = (s: string) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
function folderLabel(path: string, specialUse?: string | null) {
  const names: Record<string, string> = { '\\Inbox': 'Posteingang', '\\Sent': 'Gesendet', '\\Drafts': 'Entwürfe', '\\Archive': 'Archiv', '\\Junk': 'Spam', '\\Trash': 'Papierkorb', '\\Flagged': 'Markiert', '\\All': 'Alle Nachrichten' };
  if (specialUse && names[specialUse]) return names[specialUse];
  if (path.toUpperCase() === 'INBOX') return 'Posteingang';
  return path.split(/[/.]/).filter(Boolean).pop() || path;
}

export function Inbox() {
  const nav = useNavigate();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState<number | ''>('');
  const [folder, setFolder] = useState('INBOX');
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [folderStats, setFolderStats] = useState<FolderStat[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const [detail, setDetail] = useState<Message | null>(null);
  const [externalImages, setExternalImages] = useState(false); // pro geöffnete Nachricht, Standard: blockiert
  const [syncing, setSyncing] = useState(false);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest');
  const [filtersOpen, setFiltersOpen] = useState(false);

  useEffect(() => {
    api<Account[]>('/accounts').then(list => { setAccounts(list.filter(a => a.has_imap)); setLoading(false); })
      .catch(e => { setLoadError((e as Error).message); setLoading(false); });
  }, []);

  const loadFolders = useCallback(async () => {
    const suffix = accountId === '' ? '' : '?account_id=' + accountId;
    const stats = await api<FolderStat[]>('/message-folders' + suffix).catch(() => []);
    setFolderStats(stats);
    if (accountId === '') {
      setMailboxes(stats.map(s => ({ path: s.folder, name: s.folder, delimiter: '/', specialUse: s.folder === 'INBOX' ? '\\Inbox' : null })));
    } else {
      const remote: Mailbox[] = await api<Mailbox[]>('/accounts/' + accountId + '/mailboxes').catch(() => [] as Mailbox[]);
      for (const stat of stats) if (!remote.some(m => m.path === stat.folder)) remote.push({ path: stat.folder, name: stat.folder, delimiter: '/', specialUse: null });
      setMailboxes(remote);
    }
  }, [accountId]);

  const load = useCallback(async () => {
    setLoading(true); setLoadError('');
    try {
      const params = new URLSearchParams({ folder, limit: '500' });
      if (accountId !== '') params.set('account_id', String(accountId));
      setMessages(await api<Message[]>('/messages?' + params));
      await loadFolders();
    } catch (e) { setLoadError((e as Error).message); }
    setLoading(false);
  }, [accountId, folder, loadFolders]);
  useEffect(() => { if (accounts.length) load(); }, [accounts.length, load]);

  const accountMap = useMemo(() => new Map(accounts.map(a => [a.id, a])), [accounts]);
  const statMap = useMemo(() => new Map(folderStats.map(s => [s.folder, s])), [folderStats]);
  const folders = useMemo(() => {
    const all = new Map<string, Mailbox>();
    all.set('INBOX', { path: 'INBOX', name: 'INBOX', delimiter: '/', specialUse: '\\Inbox' });
    mailboxes.forEach(m => all.set(m.path, m));
    return [...all.values()].sort((a, b) => a.path === 'INBOX' ? -1 : b.path === 'INBOX' ? 1 : folderLabel(a.path, a.specialUse).localeCompare(folderLabel(b.path, b.specialUse), 'de'));
  }, [mailboxes]);

  const shown = useMemo(() => {
    const q = query.trim().toLocaleLowerCase('de');
    const now = Date.now();
    const cutoff = dateFilter === 'today' ? now - 86400000 : dateFilter === 'week' ? now - 604800000 : dateFilter === 'month' ? now - 2592000000 : 0;
    return messages.filter(m => status === 'all' || status === 'unread' && !m.seen || status === 'read' && !!m.seen || status === 'flagged' && !!m.flagged)
      .filter(m => !cutoff || new Date(m.date || m.created_at).getTime() >= cutoff)
      .filter(m => !q || [m.subject, m.from_name, m.from_email, m.to_text, m.snippet, accountMap.get(m.account_id)?.name, m.folder].some(v => (v || '').toLocaleLowerCase('de').includes(q)))
      .sort((a, b) => (sort === 'newest' ? -1 : 1) * (new Date(a.date || a.created_at).getTime() - new Date(b.date || b.created_at).getTime()));
  }, [messages, query, status, dateFilter, sort, accountMap]);
  const unread = messages.filter(m => !m.seen).length;
  const flagged = messages.filter(m => m.flagged).length;
  const activeFilters = Number(status !== 'all') + Number(dateFilter !== 'all') + Number(sort !== 'newest');

  async function sync() {
    if (!accounts.length) return toast('Kein IMAP-Account verfügbar', 'err');
    setSyncing(true);
    try {
      const targets = accountId === '' ? accounts : accounts.filter(a => a.id === accountId);
      let saved = 0;
      for (const account of targets) {
        let paths = [folder];
        if (folder === '*') paths = (await api<Mailbox[]>('/accounts/' + account.id + '/mailboxes')).map(b => b.path);
        for (const path of paths) saved += (await api<{ saved: number }>('/accounts/' + account.id + '/inbox/sync', { method: 'POST', body: { folder: path } })).saved;
      }
      toast(saved ? `${saved} neue Nachrichten synchronisiert` : 'Alle Ordner sind aktuell'); await load();
    } catch (e) { toast('IMAP-Fehler: ' + (e as Error).message, 'err'); }
    setSyncing(false);
  }
  function selectAccount(id: number | '') { setAccountId(id); setFolder('INBOX'); setOpenId(null); setDetail(null); }
  function selectFolder(path: string) { setFolder(path); setOpenId(null); setDetail(null); }
  async function open(m: Message) {
    setOpenId(m.id); setDetail(null); setExternalImages(false); setDetail(await api<Message>('/messages/' + m.id));
    if (!m.seen) { await api('/messages/' + m.id + '/seen', { method: 'POST', body: { seen: true } }).catch(() => {}); setMessages(ms => ms.map(x => x.id === m.id ? { ...x, seen: 1 } : x)); }
  }
  async function toggleSeen(m: Message) { const seen = !m.seen; await api('/messages/' + m.id + '/seen', { method: 'POST', body: { seen } }); setMessages(ms => ms.map(x => x.id === m.id ? { ...x, seen: seen ? 1 : 0 } : x)); }
  async function toggleFlag(m: Message) { const next = !m.flagged; await api('/messages/' + m.id + '/flag', { method: 'POST', body: { flagged: next } }); setMessages(ms => ms.map(x => x.id === m.id ? { ...x, flagged: next ? 1 : 0 } : x)); if (detail?.id === m.id) setDetail(d => d ? { ...d, flagged: next ? 1 : 0 } : d); }
  async function del(id: number) {
    if (!await confirmDialog({ title: 'Mail löschen?', message: 'Die Mail wird lokal entfernt, nicht auf dem IMAP-Server.', danger: true })) return;
    await api('/messages/' + id, { method: 'DELETE' }); setMessages(ms => ms.filter(m => m.id !== id)); setOpenId(null); setDetail(null);
  }
  async function addSenderToContacts(m: Message) { if (m.from_email) { await api('/contacts', { method: 'POST', body: { email: m.from_email, name: m.from_name || '' } }); toast(`${m.from_email} ins Adressbuch übernommen`); } }
  async function reply(m: Message) {
    if (!m.from_email) return;
    const quoted = m.text ? `<blockquote style="margin:12px 0;padding:8px 14px;border-left:2px solid #ccc;color:#555;white-space:pre-wrap">${escapeHtml(m.text.slice(0, 4000))}</blockquote>` : m.snippet ? `<blockquote>${escapeHtml(m.snippet)}</blockquote>` : '';
    const subject = /^re:/i.test(m.subject || '') ? m.subject || '' : 'Re: ' + (m.subject || '');
    const d = await api<Draft>('/drafts', { method: 'POST', body: { account_id: m.account_id, subject, html: `<p>Hallo {{name}},</p>\n<p>…</p>\n<hr>\n<p>Am ${fullDateTime(m.date)} schrieb ${escapeHtml(fromLabel(m))}:</p>${quoted}`, recipients: [{ email: m.from_email, name: m.from_name || null, kind: 'to' }] } });
    toast('Antwort-Entwurf erstellt'); nav(ROUTES.email.draft(d.id));
  }

  if (!loading && accounts.length === 0) return <div className="empty"><Icon name="inbox" size={28} />Kein Account mit IMAP konfiguriert. Hinterlege unter <strong>Accounts</strong> die IMAP-Zugangsdaten.</div>;

  return <div className="inbox-page">
    <div className="inbox-topbar"><div><h1>Posteingang</h1><span>{accountId === '' ? 'Alle Postfächer' : accountMap.get(accountId)?.name} · {folder === '*' ? 'Alle Ordner' : folderLabel(folder, mailboxes.find(b => b.path === folder)?.specialUse)}</span></div><button className="btn" onClick={sync} disabled={syncing}><Icon name="refresh" size={14} />{syncing ? 'Synchronisiert …' : 'Synchronisieren'}</button></div>
    <div className="inbox-workspace">
      <aside className="mailbox-sidebar">
        <div className="mailbox-section-title">Postfächer</div>
        <button className={'mailbox-nav' + (accountId === '' ? ' active' : '')} onClick={() => selectAccount('')}><Icon name="inbox" size={15} /><span>Alle Postfächer</span></button>
        {accounts.map(a => <button key={a.id} className={'mailbox-nav account' + (accountId === a.id ? ' active' : '')} onClick={() => selectAccount(a.id)}><span className="account-avatar">{(a.name || a.from_email)[0].toUpperCase()}</span><span><strong>{a.name}</strong><small>{a.from_email}</small></span></button>)}
        <div className="mailbox-section-title folders-title">Ordner</div>
        <button className={'mailbox-nav' + (folder === '*' ? ' active' : '')} onClick={() => selectFolder('*')}><Icon name="mail" size={15} /><span>Alle Ordner</span></button>
        {folders.map(box => { const stat = statMap.get(box.path); return <button key={box.path} className={'mailbox-nav' + (folder === box.path ? ' active' : '')} onClick={() => selectFolder(box.path)} title={box.path}><Icon name={box.path === 'INBOX' ? 'inbox' : box.specialUse === '\\Trash' ? 'trash' : box.specialUse === '\\Flagged' ? 'flag' : 'mail'} size={15} /><span>{folderLabel(box.path, box.specialUse)}</span>{!!stat?.unread && <b>{stat.unread}</b>}</button>; })}
      </aside>
      <section className="message-column">
        <div className="message-tools"><div className="searchbox"><Icon name="search" size={15} /><input placeholder="Mails durchsuchen …" value={query} onChange={e => setQuery(e.target.value)} /></div><button className={'btn ghost sm' + (filtersOpen || activeFilters ? ' active' : '')} onClick={() => setFiltersOpen(v => !v)}><Icon name="filter" size={14} />Filter{activeFilters > 0 && <span className="filter-count">{activeFilters}</span>}</button></div>
        {filtersOpen && <div className="inbox-filters"><label>Status<select value={status} onChange={e => setStatus(e.target.value as StatusFilter)}><option value="all">Alle</option><option value="unread">Ungelesen</option><option value="read">Gelesen</option><option value="flagged">Markiert</option></select></label><label>Zeitraum<select value={dateFilter} onChange={e => setDateFilter(e.target.value as DateFilter)}><option value="all">Jederzeit</option><option value="today">24 Stunden</option><option value="week">7 Tage</option><option value="month">30 Tage</option></select></label><label>Sortierung<select value={sort} onChange={e => setSort(e.target.value as 'newest' | 'oldest')}><option value="newest">Neueste zuerst</option><option value="oldest">Älteste zuerst</option></select></label><button className="btn ghost sm" onClick={() => { setStatus('all'); setDateFilter('all'); setSort('newest'); }}>Zurücksetzen</button></div>}
        <div className="message-summary"><strong>{shown.length} Nachrichten</strong><span>{unread} ungelesen · {flagged} markiert</span></div>
        <div className="message-scroll scroll-region">
          {loading ? [0,1,2,3,4].map(i => <div key={i} className="skel skel-row" />) : loadError ? <div className="empty"><Icon name="alert" size={26} />Laden fehlgeschlagen.<button className="btn ghost sm" onClick={load}>Erneut versuchen</button></div> : shown.length === 0 ? <div className="empty"><Icon name="mailOpen" size={26} />{messages.length ? 'Keine Nachricht passt zu den Filtern.' : 'Dieser Ordner ist leer. Synchronisiere ihn, um Nachrichten abzurufen.'}</div> : shown.map(m => <button key={m.id} className={'message-row' + (!m.seen ? ' unread' : '') + (openId === m.id ? ' selected' : '')} onClick={() => open(m)}><span className="message-state">{!m.seen && <i />}</span><span className="message-content"><span className="message-from">{fromLabel(m)}</span><strong>{m.subject || '(kein Betreff)'}</strong><small>{m.snippet || 'Keine Vorschau verfügbar'}</small>{accountId === '' && <em>{accountMap.get(m.account_id)?.name || 'Postfach'} · {folderLabel(m.folder)}</em>}</span><span className="message-side"><span title={fullDateTime(m.date)}>{relTime(m.date)}</span><span className={'flag-btn' + (m.flagged ? ' flagged' : '')} onClick={e => { e.stopPropagation(); toggleFlag(m); }}><Icon name="flag" size={13} /></span></span></button>)}
        </div>
      </section>
      <section className="reading-pane">
        {!openId ? <div className="reading-empty"><Icon name="mailOpen" size={32} /><strong>Nachricht auswählen</strong><span>Die E-Mail erscheint hier, ohne die Liste zu verlassen.</span></div> : !detail ? <div className="reading-loading"><div className="skel" /></div> : <><div className="reading-header"><div className="reading-actions"><button className="btn sm" onClick={() => reply(detail)}><Icon name="reply" size={14} />Antworten</button><button className="btn ghost sm icon-only" title="Absender ins Adressbuch" onClick={() => addSenderToContacts(detail)}><Icon name="userPlus" size={14} /></button><button className="btn ghost sm icon-only" title={detail.seen ? 'Als ungelesen markieren' : 'Als gelesen markieren'} onClick={() => { toggleSeen(detail); setDetail(d => d ? { ...d, seen: d.seen ? 0 : 1 } : d); }}><Icon name={detail.seen ? 'mail' : 'mailOpen'} size={14} /></button><button className={'btn ghost sm icon-only' + (externalImages ? ' active' : '')} title={externalImages ? 'Externe Bilder werden geladen – klicken zum Blockieren' : 'Externe Bilder laden (nur für diese Nachricht)'} aria-pressed={externalImages} onClick={() => setExternalImages(v => !v)}><Icon name="image" size={14} /></button><button className="btn danger sm icon-only" title="Lokal löschen" onClick={() => del(detail.id)}><Icon name="trash" size={14} /></button></div><h2>{detail.subject || '(kein Betreff)'}</h2><div className="sender-line"><span className="account-avatar">{fromLabel(detail)[0].toUpperCase()}</span><span><strong>{fromLabel(detail)}</strong><small>{detail.from_email}</small></span><time title={fullDateTime(detail.date)}>{relTime(detail.date)}</time></div><details><summary>Empfangsdetails</summary><div><strong>An:</strong> {detail.to_text || '—'}<br/><strong>Postfach:</strong> {accountMap.get(detail.account_id)?.name || '—'}<br/><strong>Ordner:</strong> {folderLabel(detail.folder)}<br/><strong>Datum:</strong> {fullDateTime(detail.date)}</div></details></div><iframe className="reading-frame" title="Mail" sandbox="" src={'/api/messages/' + detail.id + '/body.html' + (externalImages ? '?external=1' : '')} /></>}
      </section>
    </div>
  </div>;
}
