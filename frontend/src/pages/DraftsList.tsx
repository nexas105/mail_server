import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { relTime } from '../lib/dates';
import { resolveDefaultAccountId } from '../lib/settings';
import { confirmDialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import type { Draft, Account, DraftStatus } from '../lib/types';
import { ROUTES } from '../lib/routes';

type Filter = 'all' | DraftStatus;
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'Alle' },
  { key: 'draft', label: 'Entwurf' },
  { key: 'sending', label: 'Läuft' },
  { key: 'sent', label: 'Gesendet' },
  { key: 'partial', label: 'Teilweise' },
  { key: 'failed', label: 'Fehlgeschlagen' },
];
const STATUS_LABEL: Record<DraftStatus, string> = {
  draft: 'Entwurf', sending: 'sendet', sent: 'gesendet', failed: 'fehlgeschlagen', partial: 'teilweise',
};

export function DraftsList() {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const nav = useNavigate();

  const load = () => api<Draft[]>('/drafts').then(setDrafts).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return drafts
      .filter(d => filter === 'all' || d.status === filter)
      .filter(d => !q
        || (d.subject || '').toLowerCase().includes(q)
        || (d.account?.from_email || '').toLowerCase().includes(q)
        || String(d.id) === q);
  }, [drafts, query, filter]);

  const counts = useMemo(() => {
    const c = new Map<Filter, number>([['all', drafts.length]]);
    for (const d of drafts) c.set(d.status, (c.get(d.status) || 0) + 1);
    return c;
  }, [drafts]);

  async function newDraft() {
    try {
      const accounts = await api<Account[]>('/accounts');
      const d = await api<Draft>('/drafts', {
        method: 'POST',
        body: { subject: '', html: '<p>Hallo {{name}},</p>\n<p>…</p>', account_id: await resolveDefaultAccountId(accounts) },
      });
      nav(ROUTES.email.draft(d.id));
    } catch (e) { toast((e as Error).message, 'err'); }
  }

  async function duplicate(d: Draft) {
    try {
      const copy = await api<Draft>('/drafts/' + d.id + '/duplicate', { method: 'POST', body: {} });
      toast('Entwurf dupliziert');
      nav(ROUTES.email.draft(copy.id));
    } catch (e) { toast((e as Error).message, 'err'); }
  }

  async function del(d: Draft) {
    const ok = await confirmDialog({
      title: 'Entwurf löschen?',
      message: `„${d.subject || '(kein Betreff)'}“ wird mitsamt Empfängern und Anhängen endgültig gelöscht.`,
      danger: true,
    });
    if (!ok) return;
    await api('/drafts/' + d.id, { method: 'DELETE' });
    toast('Entwurf gelöscht');
    load();
  }

  return (
    <>
      <div className="toolbar sticky-bar">
        <strong className="grow">Entwürfe</strong>
        <div className="searchbox" style={{ width: 260 }}>
          <Icon name="search" size={15} />
          <input placeholder="Betreff, Account oder Nr. …" value={query} onChange={e => setQuery(e.target.value)} />
        </div>
        <button className="btn" onClick={newDraft}><Icon name="plus" size={15} /> Neuer Entwurf</button>
      </div>

      <div className="chips" style={{ marginBottom: 16 }}>
        {FILTERS.map(f => {
          const n = counts.get(f.key) || 0;
          if (f.key !== 'all' && n === 0) return null;
          return (
            <button key={f.key} className={'chip' + (filter === f.key ? ' active' : '')} onClick={() => setFilter(f.key)}>
              {f.label} <span className="count">{n}</span>
            </button>
          );
        })}
      </div>

      {loading ? (
        <>{[0, 1, 2, 3].map(i => <div key={i} className="skel skel-row" />)}</>
      ) : shown.length === 0 ? (
        <div className="empty">
          <Icon name="draft" size={28} />
          {drafts.length === 0
            ? 'Noch keine Entwürfe. Lege oben einen an — oder lass Claude per MCP einen anlegen.'
            : 'Keine Entwürfe passen zu Suche/Filter.'}
        </div>
      ) : shown.map(d => (
        <Link key={d.id} to={ROUTES.email.draft(d.id)} className="list-item">
          <div className="grow">
            <div className="title">{d.subject || '(kein Betreff)'}</div>
            <div className="muted small">
              {d.recipient_count} Empfänger · {d.account?.from_email || 'kein Account'} · {relTime(d.updated_at)}
              {(d.failed_count ?? 0) > 0 && <span style={{ color: 'var(--red)' }}> · {d.failed_count} Fehler</span>}
            </div>
          </div>
          <span className={'badge ' + d.status}>{STATUS_LABEL[d.status]}</span>
          <button className="btn ghost sm icon-only" title="Duplizieren"
            onClick={e => { e.preventDefault(); duplicate(d); }}><Icon name="copy" size={14} /></button>
          <button className="btn danger sm icon-only" title="Löschen"
            onClick={e => { e.preventDefault(); del(d); }}><Icon name="trash" size={14} /></button>
        </Link>
      ))}
    </>
  );
}
