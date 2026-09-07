import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { AuthUser } from '../lib/auth';
import { toast } from '../lib/toast';
import { confirmDialog } from './Dialog';
import { Icon } from './Icon';

interface BackupStatus {
  pending: boolean;
  last: { at: string; ok: boolean; message: string; reencrypted?: number; warnings?: string[] } | null;
  key_fingerprint: string;
  data_dir_bytes: number;
}

interface RestoreResponse {
  ok: boolean;
  restarting: boolean;
  manifest: { created_at: string; includes_media: boolean; includes_keyfile: boolean; key_fingerprint: string };
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'uploading'; pct: number }
  | { kind: 'restarting'; since: number }
  | { kind: 'unreachable' };

const HEALTH_INTERVAL_MS = 2000;
const HEALTH_TIMEOUT_MS = 90_000;

function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '–';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024; let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Komplettsicherung des Datenverzeichnisses – herunterladen und wieder
 * einspielen. Nur für Administratoren: Das Archiv enthält alle Konten samt
 * (verschlüsselten) Passwörtern und den Schlüssel dazu.
 *
 * Die Karte ermittelt die Rolle selbst über /auth/me, so wie es die
 * Profilseite tut; Settings bekommt den Nutzer nicht als Prop gereicht.
 */
export function BackupCard() {
  const [me, setMe] = useState<AuthUser | null | undefined>(undefined);
  useEffect(() => {
    api<AuthUser>('/auth/me').then(setMe).catch(() => setMe(null));
  }, []);
  if (me?.role !== 'admin') return null;
  return <BackupCardInner />;
}

function BackupCardInner() {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [media, setMedia] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const fileRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = () => api<BackupStatus>('/backup/status')
    .then(s => { setStatus(s); setState('ready'); })
    .catch(() => { setStatus(null); setState('unavailable'); });
  useEffect(() => { load(); }, []);

  function download() {
    // Reiner Download über die Cookie-Sitzung; der Browser übernimmt den
    // Dateinamen aus Content-Disposition.
    window.location.href = '/api/backup/export?media=' + (media ? 1 : 0);
  }

  async function restore() {
    if (!file) return;
    const ok = await confirmDialog({
      title: 'Sicherung wiederherstellen?',
      message: `Ersetzt ALLE Daten dieses Servers (Mails, Kontakte, Konten, WhatsApp-Sitzungen) durch die Sicherung „${file.name}“. Der Server startet danach neu. Die bisherigen Daten bleiben als Rückfallkopie im Datenverzeichnis.`,
      confirmLabel: 'Wiederherstellen',
      danger: true,
    });
    if (!ok) return;

    setPhase({ kind: 'uploading', pct: 0 });
    try {
      const res = await upload(file, pct => {
        if (alive.current) setPhase({ kind: 'uploading', pct });
      });
      if (!alive.current) return;
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      if (res.restarting) {
        setPhase({ kind: 'restarting', since: Date.now() });
        await waitForRestart();
      } else {
        setPhase({ kind: 'idle' });
        toast('Sicherung eingespielt – Server bitte neu starten', 'info');
        load();
      }
    } catch (e) {
      if (!alive.current) return;
      setPhase({ kind: 'idle' });
      toast((e as Error).message, 'err');
    }
  }

  async function waitForRestart() {
    const started = Date.now();
    // Kurz warten, damit der noch laufende alte Prozess nicht fälschlich als
    // „wieder da" gilt.
    await sleep(HEALTH_INTERVAL_MS);
    while (alive.current && Date.now() - started < HEALTH_TIMEOUT_MS) {
      try {
        const r = await fetch('/api/health', { credentials: 'same-origin', cache: 'no-store' });
        if (r.ok) {
          const s = await api<BackupStatus>('/backup/status').catch(() => null);
          if (!alive.current) return;
          setPhase({ kind: 'idle' });
          if (s) {
            setStatus(s); setState('ready');
            if (s.last?.ok) toast('Wiederherstellung abgeschlossen');
            else if (s.last) toast(s.last.message || 'Wiederherstellung fehlgeschlagen', 'err', 8000);
            else toast('Server ist wieder da – kein Wiederherstellungsergebnis gemeldet', 'info');
          } else {
            toast('Server ist wieder da – Status konnte nicht geladen werden', 'info');
          }
          return;
        }
      } catch { /* noch nicht erreichbar */ }
      await sleep(HEALTH_INTERVAL_MS);
    }
    if (alive.current) setPhase({ kind: 'unreachable' });
  }

  const busy = phase.kind === 'uploading' || phase.kind === 'restarting';

  return (
    <div className="card">
      <div className="toolbar">
        <Icon name="save" size={16} />
        <strong className="grow">Sicherung &amp; Umzug</strong>
        <button className="btn ghost sm" onClick={() => { setState('loading'); load(); }} disabled={busy} title="Status neu laden">
          <Icon name="refresh" size={13} />
        </button>
      </div>

      {/* ---------------------------------------------------------- Status */}
      {state === 'loading' ? <div className="skel skel-row" /> : state === 'unavailable' ? (
        <div className="acct-probe err">
          <Icon name="alert" size={13} />
          <span className="grow">
            Der laufende Server kennt die Sicherung noch nicht — er wurde vor dem Update
            gestartet. Backend neu starten (<code>npm start</code>), danach{' '}
            <button className="linklike" onClick={() => { setState('loading'); load(); }}>hier neu laden</button>.
          </span>
        </div>
      ) : status && (
        <div className="meta-rows" style={{ marginBottom: 12 }}>
          <div><Icon name="server" size={13} /> Datenverzeichnis: {humanBytes(status.data_dir_bytes)}</div>
          <div>
            <Icon name="command" size={13} /> Schlüssel:{' '}
            <code style={{ fontFamily: 'ui-monospace, monospace' }}>{status.key_fingerprint || '–'}</code>
          </div>
          {status.pending && (
            <div style={{ color: 'var(--amber)' }}>
              <Icon name="alert" size={13} /> Wiederherstellung wartet auf Neustart
            </div>
          )}
          {status.last && (
            <div style={{ color: status.last.ok ? undefined : 'var(--red)' }}>
              <Icon name={status.last.ok ? 'check' : 'alert'} size={13} />
              Letzte Wiederherstellung {fmtDate(status.last.at)}: {status.last.ok ? 'erfolgreich' : 'fehlgeschlagen'}
              {status.last.message ? ` – ${status.last.message}` : ''}
              {status.last.ok && status.last.reencrypted ? ` (${status.last.reencrypted} Passwörter umgeschlüsselt)` : ''}
            </div>
          )}
          {status.last?.warnings?.map((w, i) => (
            <div key={i} style={{ color: 'var(--amber)' }}><Icon name="alert" size={13} /> {w}</div>
          ))}
        </div>
      )}

      {/* --------------------------------------------------------- Download */}
      <strong className="small">Sicherung herunterladen</strong>
      <label className="check inline" style={{ marginTop: 6 }}>
        <input type="checkbox" checked={media} disabled={busy} onChange={e => setMedia(e.target.checked)} />
        WhatsApp-Medien einschließen
      </label>
      <div className="toolbar" style={{ marginTop: 8, marginBottom: 0 }}>
        <span className="muted small grow">
          Enthält alle Konten samt Passwörtern (verschlüsselt) und den Schlüssel dazu – sicher aufbewahren.
        </span>
        <button className="btn sm" onClick={download} disabled={busy || state !== 'ready'}>
          <Icon name="download" size={13} /> Sicherung herunterladen
        </button>
      </div>

      {/* ---------------------------------------------------------- Restore */}
      <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
        <strong className="small">Wiederherstellen</strong>
        <div className="muted small" style={{ marginTop: 4, marginBottom: 8 }}>
          Ersetzt alle Daten dieses Servers durch die Sicherung und startet ihn neu. Die bisherigen
          Daten bleiben als Rückfallkopie im Datenverzeichnis.
        </div>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <input
            ref={fileRef} type="file" className="grow" disabled={busy}
            accept=".tgz,.tar.gz,application/gzip"
            onChange={e => setFile(e.target.files?.[0] ?? null)}
          />
          <button className="btn danger-solid sm" onClick={restore} disabled={busy || !file || state !== 'ready'}>
            <Icon name="upload" size={13} /> Wiederherstellen
          </button>
        </div>

        {phase.kind === 'uploading' && (
          <div className="progress">
            <div className="muted small" style={{ marginBottom: 4 }}>Wird hochgeladen … {phase.pct} %</div>
            <div className="bar"><div style={{ width: `${phase.pct}%` }} /></div>
          </div>
        )}
        {phase.kind === 'restarting' && (
          <div className="acct-probe" style={{ marginTop: 12 }}>
            <Icon name="refresh" size={13} />
            <span className="grow">Server startet neu … Die Seite prüft alle 2 Sekunden, ob er wieder erreichbar ist.</span>
          </div>
        )}
        {phase.kind === 'unreachable' && (
          <div className="acct-probe err" style={{ marginTop: 12 }}>
            <Icon name="alert" size={13} />
            <span className="grow">
              Server antwortet nicht – lokal bitte von Hand starten (<code>npm start</code>). Danach{' '}
              <button className="linklike" onClick={() => { setPhase({ kind: 'idle' }); setState('loading'); load(); }}>hier neu laden</button>.
            </span>
          </div>
        )}
      </div>

      <div className="muted small" style={{ marginTop: 12 }}>
        Beim Umzug auf einen anderen Server mit anderem Schlüssel werden gespeicherte Passwörter
        automatisch umgeschlüsselt. Die alte Instanz vorher stoppen, sonst kollidieren
        WhatsApp-Sitzungen.
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Upload */

/**
 * XMLHttpRequest statt fetch, weil nur XHR den Upload-Fortschritt meldet.
 * 401 wird wie in api.ts behandelt: ein abgelaufenes Cookie soll zur
 * Anmeldung führen, nicht zu einer kryptischen Fehlermeldung.
 */
function upload(file: File, onProgress: (pct: number) => void): Promise<RestoreResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/backup/restore');
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/gzip');
    xhr.responseType = 'json';
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) onProgress(Math.min(100, Math.round((e.loaded / e.total) * 100)));
    };
    xhr.onerror = () => reject(new Error('Verbindung zum Server abgebrochen'));
    xhr.onabort = () => reject(new Error('Upload abgebrochen'));
    xhr.onload = () => {
      const body = (xhr.response ?? {}) as Partial<RestoreResponse> & { error?: string };
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        resolve({ ok: !!body.ok, restarting: !!body.restarting, manifest: body.manifest! });
        return;
      }
      if (xhr.status === 401) notifyUnauthorized();
      reject(new Error(body.error || xhr.statusText || `HTTP ${xhr.status}`));
    };
    xhr.send(file);
  });
}

/**
 * api.ts kapselt seine Handler-Liste; ein Aufruf über api() auf eine Route,
 * die dann ebenfalls 401 liefert, löst dieselben Handler aus (App zeigt die
 * Anmeldung). /auth/-Pfade sind dort bewusst ausgenommen, deshalb nicht /auth/me.
 */
function notifyUnauthorized() {
  api('/backup/status').catch(() => {});
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
