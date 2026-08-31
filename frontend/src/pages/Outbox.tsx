import { useEffect, useMemo, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { relTime, fullDateTime } from '../lib/dates';
import { confirmDialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import type { Draft, Recipient, SendEvent } from '../lib/types';
import { ROUTES } from '../lib/routes';

type Filter = 'all' | 'failed' | 'sent' | 'sending' | 'bounced' | 'opened';

/**
 * Zustell-Zustand eines Empfängers, von hart nach weich gelesen:
 * unzustellbar > Fehler beim Einliefern > geöffnet > eingeliefert > offen.
 * „Gesendet" heißt nur, dass der SMTP-Server angenommen hat – erst Bounce oder
 * Öffnung sagen etwas über das, was beim Empfänger ankam.
 */
function deliveryState(r: Recipient) {
  if (r.bounced_at) return r.bounce_type === 'soft' ? 'soft' : 'bounced';
  if (r.status === 'failed') return 'failed';
  if (r.opened_at) return 'opened';
  if (r.status === 'sent') return 'sent';
  return 'pending';
}

const STATE_UI: Record<string, { icon: string; cls: string; label: string }> = {
  bounced: { icon: '⦸', cls: 'err', label: 'unzustellbar' },
  soft: { icon: '⏸', cls: 'warn', label: 'vorübergehend abgelehnt' },
  failed: { icon: '✗', cls: 'err', label: 'Versand fehlgeschlagen' },
  opened: { icon: '👁', cls: 'ok', label: 'geöffnet' },
  sent: { icon: '✓', cls: 'ok', label: 'eingeliefert' },
  pending: { icon: '•', cls: '', label: 'offen' },
};

export function Outbox() {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const [detail, setDetail] = useState<{ recipients: Recipient[]; events: SendEvent[] } | null>(null);
  const [retryLog, setRetryLog] = useState<Record<number, string[]>>({});
  const [retrying, setRetrying] = useState<number | null>(null);

  const load = useCallback(async () => {
    const all = await api<Draft[]>('/drafts');
    setDrafts(all.filter(d => d.status !== 'draft'));
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  // Auto-Refresh solange etwas sendet
  useEffect(() => {
    if (!drafts.some(d => d.status === 'sending')) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [drafts, load]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return drafts
      .filter(d =>
        filter === 'all' ? true
        : filter === 'failed' ? (d.status === 'failed' || d.status === 'partial')
        : filter === 'bounced' ? (d.bounced_count ?? 0) > 0
        : filter === 'opened' ? (d.opened_count ?? 0) > 0
        : filter === 'sent' ? d.status === 'sent'
        : d.status === 'sending')
      .filter(d => !q
        || (d.subject || '').toLowerCase().includes(q)
        || (d.account?.from_email || '').toLowerCase().includes(q));
  }, [drafts, filter, query]);

  const loadDetail = useCallback(async (id: number) => {
    const [draft, events] = await Promise.all([
      api<Draft>('/drafts/' + id),
      api<SendEvent[]>('/drafts/' + id + '/events'),
    ]);
    setDetail({ recipients: draft.recipients, events });
  }, []);

  async function toggle(id: number) {
    if (openId === id) { setOpenId(null); setDetail(null); return; }
    setOpenId(id); setDetail(null);
    loadDetail(id);
  }

  async function del(id: number) {
    const ok = await confirmDialog({
      title: 'Versand-Eintrag löschen?',
      message: 'Der zugrunde liegende Entwurf wird mitsamt Empfänger-Status gelöscht. Das Versand-Protokoll bleibt erhalten.',
      danger: true,
    });
    if (!ok) return;
    await api('/drafts/' + id, { method: 'DELETE' });
    if (openId === id) { setOpenId(null); setDetail(null); }
    load();
  }

  function resendFailed(id: number) {
    setRetrying(id); setRetryLog(l => ({ ...l, [id]: [] }));
    const push = (line: string) => setRetryLog(l => ({ ...l, [id]: [...(l[id] || []), line] }));
    const es = new EventSource('/api/drafts/' + id + '/send?failed=1');
    es.addEventListener('progress', e => {
      const p = JSON.parse((e as MessageEvent).data);
      if (p.status === 'sent') push('✓ ' + p.email);
      else if (p.status === 'failed') push('✗ ' + p.email + ' — ' + p.error);
    });
    es.addEventListener('done', e => {
      const r = JSON.parse((e as MessageEvent).data);
      toast(`Erneut gesendet: ${r.sent} ok, ${r.failed} fehlgeschlagen`, r.failed ? 'err' : 'ok');
      es.close(); setRetrying(null); load();
      if (openId === id) loadDetail(id);
    });
    es.addEventListener('error', e => {
      try { push('Fehler: ' + JSON.parse((e as MessageEvent).data).error); } catch { push('Verbindungsfehler'); }
      es.close(); setRetrying(null);
    });
  }

  return (
    <>
      <div className="toolbar sticky-bar">
        <strong className="grow">Postausgang</strong>
        <div className="searchbox" style={{ width: 240 }}>
          <Icon name="search" size={15} />
          <input placeholder="Betreff oder Account …" value={query} onChange={e => setQuery(e.target.value)} />
        </div>
        <button className="btn ghost icon-only" title="Aktualisieren" onClick={load}><Icon name="refresh" size={15} /></button>
      </div>

      <div className="chips" style={{ marginBottom: 16 }}>
        {(['all', 'sending', 'failed', 'bounced', 'opened', 'sent'] as Filter[]).map(f => {
          const n = f === 'bounced' ? drafts.reduce((a, d) => a + (d.bounced_count ?? 0), 0)
            : f === 'opened' ? drafts.reduce((a, d) => a + (d.opened_count ?? 0), 0) : null;
          if ((f === 'bounced' || f === 'opened') && !n) return null;
          const label = { all: 'Alle', sending: 'Läuft', failed: 'Mit Fehlern', bounced: 'Unzustellbar', opened: 'Geöffnet', sent: 'Gesendet' }[f];
          return (
            <button key={f} className={'chip' + (filter === f ? ' active' : '')} onClick={() => setFilter(f)}>
              {label}{n != null && <span className="count">{n}</span>}
            </button>
          );
        })}
      </div>

      {loading ? (
        <>{[0, 1, 2].map(i => <div key={i} className="skel skel-row" />)}</>
      ) : shown.length === 0 ? (
        <div className="empty">
          <Icon name="send" size={28} />
          Keine Versendungen{filter !== 'all' || query ? ' in dieser Ansicht' : ''}.
        </div>
      ) : shown.map(d => (
        <div key={d.id} className="card">
          <div className="toolbar" style={{ cursor: 'pointer', marginBottom: 4 }} onClick={() => toggle(d.id)}>
            <Icon name={openId === d.id ? 'chevronDown' : 'chevronRight'} size={15} className="muted" />
            <span className={'badge ' + d.status}>{d.status}</span>
            <strong className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {d.subject || '(kein Betreff)'}
            </strong>
            <span className="muted small">
              {d.sent_count ?? 0} ok
              {(d.failed_count ?? 0) > 0 && <span style={{ color: 'var(--red)' }}> · {d.failed_count} Fehler</span>}
              {(d.bounced_count ?? 0) > 0 && <span style={{ color: 'var(--red)' }}> · {d.bounced_count} unzustellbar</span>}
              {(d.opened_count ?? 0) > 0 && <span style={{ color: 'var(--accent)' }}> · {d.opened_count} geöffnet</span>}
              {' · '}{d.recipient_count} gesamt
            </span>
            <span className="muted small" title={fullDateTime(d.sent_at || d.updated_at)}>{relTime(d.sent_at || d.updated_at)}</span>
          </div>
          <div className="muted small" style={{ paddingLeft: 25 }}>{d.account?.from_email}</div>

          {openId === d.id && (
            <div style={{ marginTop: 12 }}>
              <div className="toolbar" style={{ marginBottom: 10 }}>
                <Link to={ROUTES.email.draft(d.id)} className="btn ghost sm"><Icon name="edit" size={13} /> Entwurf öffnen</Link>
                {(d.failed_count ?? 0) > 0 && (
                  <button className="btn sm" onClick={() => resendFailed(d.id)} disabled={retrying === d.id}>
                    <Icon name="refresh" size={13} /> {retrying === d.id ? 'Sendet …' : `Fehlgeschlagene erneut senden (${d.failed_count})`}
                  </button>
                )}
                <span className="grow" />
                <button className="btn danger sm icon-only" title="Löschen" onClick={() => del(d.id)}><Icon name="trash" size={13} /></button>
              </div>

              {retryLog[d.id]?.length > 0 && (
                <div className="log" style={{ marginBottom: 10 }}>
                  {retryLog[d.id].map((l, i) => <div key={i} className={l.startsWith('✓') ? 'ok' : l.startsWith('✗') ? 'err' : ''}>{l}</div>)}
                </div>
              )}

              {!detail ? <div className="skel" style={{ height: 60 }} /> : (
                <>
                  <h2 style={{ fontSize: 13 }}>Zustellung je Empfänger</h2>
                  <div style={{ marginBottom: 12 }}>
                    {detail.recipients.map(r => {
                      const st = deliveryState(r);
                      const ui = STATE_UI[st];
                      const title = [
                        ui.label,
                        r.opened_at && `zuerst geöffnet ${fullDateTime(r.opened_at)}${(r.open_count ?? 0) > 1 ? ` (${r.open_count}×)` : ''}`,
                        r.bounce_reason && `Grund: ${r.bounce_reason}`,
                        r.bounce_code && `Code ${r.bounce_code}`,
                        r.error,
                      ].filter(Boolean).join(' · ');
                      return (
                        <span key={r.id} className={'pill ' + r.kind} title={title}>
                          <span className={ui.cls}>
                            {ui.icon} {r.kind !== 'to' ? r.kind + ': ' : ''}{r.email}
                          </span>
                          {r.opened_at && <span className="muted"> · {relTime(r.opened_at)}</span>}
                          {r.bounced_at && <span className="muted"> · {r.bounce_code || ui.label}</span>}
                        </span>
                      );
                    })}
                  </div>
                  {detail.recipients.some(r => r.opened_at) && (
                    <div className="muted small" style={{ margin: '-6px 0 12px' }}>
                      Öffnungen sind eine Untergrenze: Wer Bilder unterdrückt, taucht nie auf –
                      und Apple Mail lädt Zählpixel auf Vorrat, auch ohne dass jemand liest.
                    </div>
                  )}

                  <h2 style={{ fontSize: 13 }}>Protokoll ({detail.events.length})</h2>
                  <div className="log" style={{ maxHeight: 220 }}>
                    {detail.events.length === 0 ? <span className="muted">Noch keine Ereignisse.</span>
                      : detail.events.map(ev => (
                        <div key={ev.id} className={ev.status === 'sent' || ev.status === 'opened' ? 'ok' : 'err'}>
                          {fullDateTime(ev.created_at)} · {ev.attempt === 'resend' ? '↻ ' : ''}
                          {ev.status === 'sent' ? '✓' : ev.status === 'opened' ? '👁' : ev.status === 'bounced' ? '⦸' : '✗'} {ev.email}
                          {ev.message_id ? ` · id=${ev.message_id}` : ''}{ev.error ? ` · ${ev.error}` : ''}
                        </div>
                      ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      ))}
    </>
  );
}
