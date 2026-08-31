import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { relTime, fullDateTime } from '../lib/dates';
import { confirmDialog } from './Dialog';
import { Icon } from './Icon';
import { CodeBlock } from './CodeBlock';

export interface McpToken {
  id: number; name: string; prefix: string;
  readonly: boolean; disabled: boolean;
  created_at: string; created_by: string | null;
  last_used_at: string | null; last_used_ip: string | null;
  use_count: number; expires_at: string | null;
}

interface McpEvent {
  id: number; at: string; transport: string; token_name: string | null; client: string | null;
  tool: string; ok: 0 | 1; duration_ms: number | null; summary: string | null; error: string | null;
}

interface EventPayload {
  stats: { total: number; errors: number; last_day: number; last_at: string | null; top: { tool: string; n: number }[] };
  events: McpEvent[];
}

/**
 * Zugang zum MCP-Server über HTTP.
 *
 * Bis hierher gab es nur MCP_TOKEN in der Umgebung — ein einziger Wert, den man
 * weder einem Client zuordnen noch einzeln widerrufen kann. Diese Token liegen
 * als Hash in der Datenbank, tragen einen Namen und lassen sich abschalten;
 * „nur lesend" nimmt einer Verbindung alle schreibenden Werkzeuge, bevor sie
 * angeboten werden.
 */
export function McpTokensCard() {
  const [tokens, setTokens] = useState<McpToken[]>([]);
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);
  const [name, setName] = useState('');
  const [readonly, setReadonly] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = () => api<McpToken[]>('/mcp/tokens').then(setTokens).catch(() => setTokens([]));
  useEffect(() => { load(); }, []);

  async function create() {
    if (!name.trim()) return toast('Name erforderlich', 'err');
    setBusy(true);
    try {
      const t = await api<McpToken & { token: string }>('/mcp/tokens', {
        method: 'POST', body: { name: name.trim(), readonly },
      });
      setFresh({ name: t.name, token: t.token });
      setName(''); setReadonly(false);
      load();
    } catch (e) { toast((e as Error).message, 'err'); }
    setBusy(false);
  }

  async function patch(t: McpToken, body: Partial<Pick<McpToken, 'disabled' | 'readonly'>>) {
    try { await api('/mcp/tokens/' + t.id, { method: 'PUT', body }); load(); }
    catch (e) { toast((e as Error).message, 'err'); }
  }

  async function remove(t: McpToken) {
    const ok = await confirmDialog({
      title: `Token „${t.name}" löschen?`,
      message: 'Der Client, der es benutzt, verliert sofort den Zugang. Das lässt sich nicht rückgängig machen.',
      confirmLabel: 'Löschen', danger: true,
    });
    if (!ok) return;
    await api('/mcp/tokens/' + t.id, { method: 'DELETE' });
    load();
  }

  return (
    <div className="card">
      <div className="toolbar">
        <Icon name="command" size={16} />
        <strong className="grow">MCP-Zugriff (HTTP)</strong>
        {tokens.length > 0 && <span className="badge">{tokens.filter(t => !t.disabled).length} aktiv</span>}
      </div>

      <div className="muted small" style={{ marginBottom: 12 }}>
        Nur für den <strong>Server-Betrieb</strong> nötig (<code>npm run mcp:http</code>). Startet der
        KI-Client den MCP-Server selbst auf diesem Rechner (stdio), braucht es kein Token.
        Ein Token ist ein Vollzugang zu deinen Mails — behandle es wie ein Passwort.
      </div>

      {fresh && (
        <div className="auth-token-reveal">
          <div className="muted small">Token für „{fresh.name}" — einmalig sichtbar, jetzt kopieren:</div>
          <code>{fresh.token}</code>
          <div className="toolbar" style={{ marginTop: 6 }}>
            <button className="btn sm ghost" onClick={() => { navigator.clipboard.writeText(fresh.token); toast('Kopiert'); }}>
              <Icon name="copy" size={13} /> Token kopieren
            </button>
            <button className="btn sm ghost" onClick={() => {
              navigator.clipboard.writeText(JSON.stringify({
                mcpServers: {
                  'mail-server': {
                    type: 'http',
                    url: `${location.origin.replace(/:\d+$/, ':3010')}/mcp`,
                    headers: { Authorization: `Bearer ${fresh.token}` },
                  },
                },
              }, null, 2));
              toast('Client-Konfiguration kopiert');
            }}>
              <Icon name="download" size={13} /> Als Client-Konfiguration
            </button>
            <span className="grow" />
            <button className="btn sm ghost" onClick={() => setFresh(null)}>Verbergen</button>
          </div>
        </div>
      )}

      {tokens.length === 0 ? (
        <div className="muted small">Noch kein Token angelegt — der HTTP-Endpunkt weist damit jede Anfrage ab.</div>
      ) : tokens.map(t => (
        <div key={t.id} className="list-item static">
          <div className="grow">
            <div className="title">
              {t.name}
              {t.readonly && <span className="badge" style={{ marginLeft: 6 }}>nur lesend</span>}
              {t.disabled && <span className="badge failed" style={{ marginLeft: 6 }}>abgeschaltet</span>}
            </div>
            <div className="muted small">
              <code>{t.prefix}…</code> · angelegt {relTime(t.created_at)}
              {t.created_by ? ` von ${t.created_by}` : ''} ·{' '}
              {t.last_used_at
                ? <span title={fullDateTime(t.last_used_at)}>zuletzt benutzt {relTime(t.last_used_at)} ({t.use_count}×{t.last_used_ip ? `, ${t.last_used_ip}` : ''})</span>
                : 'noch nie benutzt'}
            </div>
          </div>
          <button className="btn sm ghost" title={t.readonly ? 'Schreiben erlauben' : 'Auf nur lesend setzen'}
            onClick={() => patch(t, { readonly: !t.readonly })}>
            <Icon name={t.readonly ? 'eye' : 'edit'} size={13} />
          </button>
          <button className="btn sm ghost" title={t.disabled ? 'Wieder aktivieren' : 'Abschalten'}
            onClick={() => patch(t, { disabled: !t.disabled })}>
            <Icon name={t.disabled ? 'check' : 'x'} size={13} />
          </button>
          <button className="btn danger sm icon-only" title="Löschen" onClick={() => remove(t)}>
            <Icon name="trash" size={14} />
          </button>
        </div>
      ))}

      <div className="toolbar" style={{ marginTop: 12, flexWrap: 'wrap' }}>
        <input placeholder="Name, z.B. Claude auf dem Laptop" value={name}
          onChange={e => setName(e.target.value)} style={{ minWidth: 220 }} />
        <label className="check inline">
          <input type="checkbox" checked={readonly} onChange={e => setReadonly(e.target.checked)} />
          nur lesend
        </label>
        <button className="btn sm" onClick={create} disabled={busy || !name.trim()}>
          <Icon name="plus" size={14} /> Token anlegen
        </button>
      </div>
      <div className="muted small" style={{ marginTop: 6 }}>
        „Nur lesend" bietet der Verbindung ausschließlich <code>list_</code>, <code>get_</code>,
        <code> search_</code>, <code>preview_</code> und <code>read_</code>-Werkzeuge an — Senden,
        Ändern und Löschen tauchen dort gar nicht erst auf.
      </div>
    </div>
  );
}

/**
 * Was hat die KI getan?
 *
 * Ein MCP-Server handelt im Namen des Nutzers, ohne dass jemand zusieht. Hier
 * steht jeder Werkzeug-Aufruf mit Dauer und Ergebnis — bewusst ohne Inhalte:
 * HTML-Rümpfe und Nachrichtentexte gehören nicht in ein Protokoll.
 */
export function McpLogCard() {
  const [data, setData] = useState<EventPayload | null>(null);
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = (errors = onlyErrors) => {
    setLoading(true);
    api<EventPayload>('/mcp/events?limit=100' + (errors ? '&errors=1' : ''))
      .then(setData).catch(() => setData(null)).finally(() => setLoading(false));
  };
  useEffect(() => { load(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const stats = data?.stats;

  return (
    <div className="card">
      <div className="toolbar">
        <Icon name="filter" size={16} />
        <strong className="grow">MCP-Protokoll</strong>
        <button className={'chip' + (onlyErrors ? ' active' : '')}
          onClick={() => { const next = !onlyErrors; setOnlyErrors(next); load(next); }}>
          Nur Fehler{stats?.errors ? <span className="count">{stats.errors}</span> : null}
        </button>
        <button className="btn ghost sm icon-only" title="Aktualisieren" onClick={() => load()}>
          <Icon name="refresh" size={13} />
        </button>
      </div>

      {stats && (
        <div className="muted small" style={{ marginBottom: 10 }}>
          {stats.total} Aufrufe insgesamt · {stats.last_day} in den letzten 24 Stunden ·{' '}
          {stats.errors} mit Fehler
          {stats.last_at && <> · zuletzt {relTime(stats.last_at)}</>}
          {stats.top.length > 0 && (
            <> · meistgenutzt: {stats.top.map(t => `${t.tool} (${t.n}×)`).join(', ')}</>
          )}
        </div>
      )}

      {loading ? <div className="skel" style={{ height: 80 }} />
        : !data?.events.length ? (
          <div className="muted small">
            Noch keine Aufrufe protokolliert. Sobald ein KI-Client ein Werkzeug benutzt — lokal per
            stdio oder über HTTP — steht es hier.
          </div>
        ) : (
          <div className="log" style={{ maxHeight: 320 }}>
            {data.events.map(e => (
              <div key={e.id} className={e.ok ? '' : 'err'} title={e.error || ''}>
                {fullDateTime(e.at)} · {e.ok ? '✓' : '✗'} <strong>{e.tool}</strong>
                {e.duration_ms != null && ` · ${e.duration_ms} ms`}
                {' · '}{e.transport}{e.token_name ? ` (${e.token_name})` : ''}
                {e.summary ? ` · ${e.summary}` : ''}
                {e.error ? ` · ${e.error}` : ''}
              </div>
            ))}
          </div>
        )}

      <div className="muted small" style={{ marginTop: 8 }}>
        Protokolliert werden Werkzeug, Dauer, Erfolg und eine gekürzte Zusammenfassung der
        Argumente — keine Mail-Inhalte, keine Anhänge. Ältere Einträge fallen automatisch heraus
        (<code>MCP_LOG_CAP</code>, Standard 5000).
      </div>
      <CodeBlock code={'# Läuft der HTTP-Endpunkt?\ncurl http://127.0.0.1:3010/health'} lang="bash" />
    </div>
  );
}
