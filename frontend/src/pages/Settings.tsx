import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { getSettings, setDefaultAccount } from '../lib/settings';
import { Icon } from '../components/Icon';
import { TrackingCard } from '../components/TrackingCard';
import { McpTokensCard, McpLogCard } from '../components/McpAccessCard';
import { BackupCard } from '../components/BackupCard';

import type {Account, WaAccount } from '../lib/types';
import { StatusBadge } from '../components/WaStatus';
import { getWorkspace, setWorkspace, onWorkspaceChange, type Workspace } from '../lib/workspace';
import { ROUTES } from '../lib/routes';

interface Health {
  ok: boolean; status: string; version: string; uptime_s: number;
  node: string; db_ok: boolean; accounts: number; pid: number;
}

/**
 * Zeigt die Einstellungen des Bereichs, der in der Seitenleiste aktiv ist.
 * Der Umschalter hier oben ist derselbe Zustand wie der Reiter links – kein
 * zweiter daneben, sonst könnten beide auseinanderlaufen.
 */
export function Settings() {
  const [ws, setWs] = useState<Workspace>(getWorkspace);
  useEffect(() => onWorkspaceChange(() => setWs(getWorkspace())), []);
  const switchTo = (w: Workspace) => { setWs(w); setWorkspace(w); };

  return (
    <>
      <div className="toolbar">
        <strong className="grow" style={{ fontSize: 18 }}>Einstellungen</strong>
        <div className="tabs2">
          <button className={ws === 'mail' ? 'active' : ''} onClick={() => switchTo('mail')}>
            <Icon name="mail" size={13} /> E-Mail
          </button>
          <button className={ws === 'wa' ? 'active' : ''} onClick={() => switchTo('wa')}>
            <Icon name="chat" size={13} /> WhatsApp
          </button>
        </div>
      </div>

      <div style={{ maxWidth: 780, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {ws === 'mail' ? (
          <>
            <div className="settings-section">E-Mail</div>
            <DefaultAccountCard />
            <TrackingCard />
          </>
        ) : (
          <>
            <div className="settings-section">WhatsApp</div>
            <WhatsappCard />
          </>
        )}

        <div className="settings-section">KI-Zugriff (MCP)</div>
        <McpTokensCard />
        <McpLogCard />

        <div className="settings-section">System</div>
        <BackupCard />
        <SystemCard />
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ GitHub */

/* --------------------------------------------------------- Standard-Absender */

function DefaultAccountCard() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [current, setCurrent] = useState<number | null>(null);

  useEffect(() => {
    api<Account[]>('/accounts').then(setAccounts);
    getSettings().then(s => setCurrent((s.default_account_id as number) ?? null));
  }, []);

  async function pick(id: number | null) {
    setCurrent(id);
    try { await setDefaultAccount(id); toast('Standard-Absender gesetzt'); }
    catch (e) { toast((e as Error).message, 'err'); }
  }

  return (
    <div className="card">
      <div className="toolbar">
        <Icon name="server" size={16} />
        <strong className="grow">Standard-Absender</strong>
      </div>
      <div className="muted small" style={{ marginBottom: 10 }}>
        Wird vorausgewählt, wenn ein neuer Entwurf entsteht. Lässt sich auch auf der Accounts-Seite
        per Stern setzen.
      </div>
      <select value={current ?? ''} onChange={e => pick(e.target.value ? +e.target.value : null)}>
        <option value="">— keiner —</option>
        {accounts.map(a => <option key={a.id} value={a.id}>{a.name} · {a.from_email}</option>)}
      </select>
    </div>
  );
}

/* --------------------------------------------------------------- WhatsApp */

/**
 * Die dauerhaften Regeln. Koppeln und Live-Status stehen unter WhatsApp →
 * Verbindung; was hier steht, gilt auf Dauer und ist bewusst hier gebündelt,
 * weil es die gleiche Art Entscheidung ist wie beim GitHub-Token.
 */
function WhatsappCard() {
  const [accounts, setAccounts] = useState<WaAccount[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const [usage, setUsage] = useState<{ files: number; bytes: number } | null>(null);

  const loadUsage = () => api<{ files: number; bytes: number }>('/whatsapp/media-usage')
    .then(setUsage).catch(() => setUsage(null));

  async function cleanup(a: WaAccount) {
    setBusy(a.id);
    try {
      const r = await api<{ removed: number; freed_mb: number }>(
        `/whatsapp/accounts/${a.id}/cleanup-media`, { method: 'POST' });
      toast(r.removed ? `${r.removed} Dateien gelöscht, ${r.freed_mb} MB frei`
        : 'Nichts zu löschen – nichts ist älter als eingestellt');
      await loadUsage();
    } catch (e) { toast((e as Error).message, 'err'); }
    setBusy(null);
  }

  const load = () => api<WaAccount[]>('/whatsapp/accounts/settings').then(setAccounts).catch(() => setAccounts([]));
  useEffect(() => { load(); loadUsage(); }, []);

  async function patch(a: WaAccount, body: Partial<WaAccount>) {
    setBusy(a.id);
    try { await api('/whatsapp/accounts/' + a.id, { method: 'PUT', body }); await load(); toast('Gespeichert'); }
    catch (e) { toast((e as Error).message, 'err'); }
    setBusy(null);
  }

  return (
    <div className="card">
      <div className="toolbar">
        <Icon name="chat" size={16} />
        <strong className="grow">Sicherheit &amp; Versand</strong>
      </div>

      {!accounts.length ? (
        <div className="muted small">
          Noch kein WhatsApp-Konto. Unter <Link to={ROUTES.whatsapp.connect}>WhatsApp → Verbindung</Link> anlegen.
        </div>
      ) : accounts.map(a => (
        <div key={a.id} style={{ paddingTop: 8 }}>
          <div className="toolbar" style={{ marginBottom: 6 }}>
            <strong className="grow">{a.name}</strong>
            <StatusBadge status={a.status} />
          </div>

          <label>Darf die KI von hier senden?</label>
          <select value={a.mcp_send_mode} disabled={busy === a.id}
            onChange={e => patch(a, { mcp_send_mode: e.target.value as WaAccount['mcp_send_mode'] })}>
            <option value="off">Nein – gar nicht</option>
            <option value="known">Nur antworten, wo schon geschrieben wurde (empfohlen)</option>
            <option value="all">Ja, auch neue Gespräche beginnen</option>
          </select>
          <div className="muted small" style={{ marginTop: 4 }}>
            {a.mcp_send_mode === 'known'
              ? 'Die KI kann nur in Chats schreiben, in denen bereits eine Nachricht eingegangen ist. Fremde anschreiben kann sie nicht — das ist zugleich der wirksamste Schutz gegen eine Nummernsperre.'
              : a.mcp_send_mode === 'all'
                ? 'Achtung: Die KI kann fremde Nummern anschreiben. Genau dieses Muster führt am schnellsten zu einer Sperre.'
                : 'Senden über MCP ist für dieses Konto abgeschaltet. Du kannst weiterhin in der Oberfläche schreiben.'}
          </div>

          <label style={{ marginTop: 10 }}>Höchstens Nachrichten pro Stunde</label>
          <input type="number" min={1} max={200} value={a.send_per_hour} disabled={busy === a.id}
            onChange={e => patch(a, { send_per_hour: +e.target.value })} />
          <div className="muted small" style={{ marginTop: 4 }}>
            Gilt für Oberfläche und KI gemeinsam. Zwischen zwei Nachrichten liegt zusätzlich eine
            zufällige Pause — gleichmäßige Takte verraten automatisierte Clients.
          </div>

          <label className="check inline" style={{ marginTop: 10 }}>
            <input type="checkbox" checked={a.autostart === 1} disabled={busy === a.id}
              onChange={e => patch(a, { autostart: (e.target.checked ? 1 : 0) as 0 | 1 })} />
            Beim Serverstart automatisch verbinden
          </label>
          <label className="check inline">
            <input type="checkbox" checked={a.sync_full_history === 1} disabled={busy === a.id}
              onChange={e => patch(a, { sync_full_history: (e.target.checked ? 1 : 0) as 0 | 1 })} />
            Beim Koppeln vollen Verlauf anfordern (dauert Minuten)
          </label>

          <div className="muted small" style={{ marginTop: 8 }}>
            Zusätzlich muss <code>MAIL_WA_MCP_SEND=1</code> in der Umgebung gesetzt sein — ohne das
            sendet die KI grundsätzlich nicht, egal was hier steht.
          </div>

          <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
            <strong className="small">Medien</strong>

            <label style={{ marginTop: 8 }}>Was wird automatisch heruntergeladen?</label>
            <select value={a.media_download} disabled={busy === a.id}
              onChange={e => patch(a, { media_download: e.target.value as WaAccount['media_download'] })}>
              <option value="off">Nichts – nur auf Klick</option>
              <option value="images">Nur Bilder</option>
              <option value="images_audio">Bilder und Sprachnachrichten (empfohlen)</option>
              <option value="all">Alles, auch Video und Dokumente</option>
            </select>

            <label style={{ marginTop: 10 }}>Höchstens MB je Datei</label>
            <input type="number" min={1} max={100} value={a.media_max_mb} disabled={busy === a.id}
              onChange={e => patch(a, { media_max_mb: +e.target.value })} />

            <label style={{ marginTop: 10 }}>Mediendateien löschen nach</label>
            <select value={a.media_keep_days} disabled={busy === a.id}
              onChange={e => patch(a, { media_keep_days: +e.target.value })}>
              <option value={0}>nie – alles aufheben</option>
              <option value={7}>7 Tagen</option>
              <option value={30}>30 Tagen</option>
              <option value={90}>90 Tagen</option>
              <option value={180}>180 Tagen</option>
              <option value={365}>einem Jahr</option>
            </select>
            <div className="muted small" style={{ marginTop: 4 }}>
              Betrifft nur die Dateien. Nachrichtentexte und die Angabe, dass es eine
              Sprachnachricht gab, bleiben erhalten — und solange das Original gespeichert ist,
              lässt sie sich später erneut laden. Wird täglich geprüft.
            </div>

            <div className="toolbar" style={{ marginTop: 10, marginBottom: 0 }}>
              <span className="muted small grow">
                Belegt: {usage ? `${usage.files} Dateien · ${(usage.bytes / 1048576).toFixed(1)} MB` : '…'}
              </span>
              <button className="btn ghost sm" disabled={busy === a.id} onClick={() => cleanup(a)}>
                <Icon name="trash" size={13} /> Jetzt aufräumen
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- Diagnose */

function SystemCard() {
  const [health, setHealth] = useState<Health | null>(null);
  const [info, setInfo] = useState<{ projectRoot: string; mcpServerPath: string } | null>(null);

  useEffect(() => {
    api<Health>('/health').then(setHealth).catch(() => {});
    api<{ projectRoot: string; mcpServerPath: string }>('/info').then(setInfo).catch(() => {});
  }, []);

  const uptime = (s: number) => s < 60 ? `${s} s`
    : s < 3600 ? `${Math.floor(s / 60)} Min.`
      : `${Math.floor(s / 3600)} Std. ${Math.floor((s % 3600) / 60)} Min.`;

  return (
    <div className="card">
      <div className="toolbar">
        <Icon name="monitor" size={16} />
        <strong className="grow">System</strong>
      </div>
      {!health ? <div className="skel skel-row" /> : (
        <div className="meta-rows">
          <div><Icon name="check" size={13} /> Datenbank {health.db_ok ? 'in Ordnung' : 'FEHLER'}</div>
          <div><Icon name="server" size={13} /> Node {health.node} · Version {health.version}</div>
          <div><Icon name="refresh" size={13} /> Läuft seit {uptime(health.uptime_s)} · PID {health.pid}</div>
          <div><Icon name="users" size={13} /> {health.accounts} SMTP-Accounts</div>
          {info && <div><Icon name="command" size={13} /> MCP: <code>{info.mcpServerPath}</code></div>}
        </div>
      )}
    </div>
  );
}
