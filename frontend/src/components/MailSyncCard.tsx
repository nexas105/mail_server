import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { relTime, fullDateTime } from '../lib/dates';
import { Icon } from './Icon';

interface SyncAccount { account_id: number; account: string; folders: number; saved: number; errors: string[] }
interface SyncLast {
  started_at: string; finished_at: string; reason: string; scope: string;
  saved: number; ok: boolean; accounts: SyncAccount[];
}
interface SyncStatus { per_day: number; scope: 'all' | 'known'; last: SyncLast | null; next_at: string | null; running: boolean }

const FREQUENCIES = [
  { value: 0, label: 'Aus' },
  { value: 1, label: '1× am Tag' },
  { value: 2, label: '2× am Tag (alle 12 Std.)' },
  { value: 4, label: '4× am Tag (alle 6 Std.)' },
  { value: 6, label: '6× am Tag (alle 4 Std.)' },
  { value: 12, label: '12× am Tag (alle 2 Std.)' },
  { value: 24, label: 'Stündlich' },
];

/** Automatischer IMAP-Abruf aller Ordner – Takt, Umfang, letzter Lauf, sofort abrufen. */
export function MailSyncCard() {
  const [s, setS] = useState<SyncStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  const load = () => api<SyncStatus>('/mail-sync').then(v => { setS(v); setUnavailable(false); }).catch(() => setUnavailable(true));
  useEffect(() => { load(); }, []);

  async function save(patch: Partial<Pick<SyncStatus, 'per_day' | 'scope'>>) {
    try {
      setS(await api<SyncStatus>('/mail-sync', { method: 'PUT', body: patch }));
      toast('Gespeichert');
    } catch (e) { toast((e as Error).message, 'err'); }
  }

  async function runNow() {
    setBusy(true);
    try {
      const r = await api<SyncStatus>('/mail-sync/run', { method: 'POST' });
      setS(r);
      toast(r.last ? `${r.last.saved} neue Mails abgerufen` : 'Abgerufen');
    } catch (e) { toast((e as Error).message, 'err'); }
    setBusy(false);
  }

  const last = s?.last;
  const errors = last?.accounts.flatMap(a => a.errors.map(e => `${a.account}: ${e}`)) || [];

  return (
    <div className="card">
      <div className="toolbar">
        <Icon name="inbox" size={16} />
        <strong className="grow">Automatischer Abruf</strong>
        <button className="btn sm" disabled={busy || !s || s.running} onClick={runNow}>
          <Icon name="download" size={13} /> {busy || s?.running ? 'Ruft ab …' : 'Jetzt abrufen'}
        </button>
      </div>

      {unavailable ? (
        <div className="acct-probe err">
          <Icon name="alert" size={13} />
          <span className="grow">Der laufende Server kennt den automatischen Abruf noch nicht – Backend neu starten.</span>
        </div>
      ) : (
        <>
          <div className="muted small" style={{ marginBottom: 12 }}>
            Holt neue Mails aller Konten mit IMAP – auch aus „Gesendet", damit der Gesprächsverlauf
            (und <code>get_thread</code> für die KI) deine eigenen Antworten kennt.
          </div>
          <div className="acct-2col">
            <div>
              <label>Wie oft</label>
              <select value={s?.per_day ?? 4} disabled={!s} onChange={e => save({ per_day: Number(e.target.value) })}>
                {FREQUENCIES.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
            </div>
            <div>
              <label>Welche Ordner</label>
              <select value={s?.scope ?? 'all'} disabled={!s} onChange={e => save({ scope: e.target.value as SyncStatus['scope'] })}>
                <option value="all">Alle (ohne Papierkorb, Spam, Entwürfe)</option>
                <option value="known">Posteingang, Gesendet und schon abgerufene</option>
              </select>
            </div>
          </div>

          <div className="muted small" style={{ marginTop: 10 }}>
            {last ? (
              <>
                Zuletzt <span title={fullDateTime(last.finished_at)}>{relTime(last.finished_at)}</span> ({last.reason}):{' '}
                {last.saved} neue Mails aus {last.accounts.reduce((n, a) => n + a.folders, 0)} Ordnern
                {last.accounts.length > 1 ? ` in ${last.accounts.length} Konten` : ''}.
              </>
            ) : 'Noch kein automatischer Abruf gelaufen.'}
            {s?.per_day && s.next_at ? <> Nächster: <span title={fullDateTime(s.next_at)}>{fullDateTime(s.next_at)}</span>.</> : null}
          </div>
          {errors.length > 0 && (
            <div className="acct-probe err" style={{ marginTop: 8 }}>
              <Icon name="alert" size={13} />
              <span className="grow">{errors.slice(0, 4).join(' · ')}{errors.length > 4 ? ` · +${errors.length - 4} weitere` : ''}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
