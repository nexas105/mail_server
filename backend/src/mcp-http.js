// MCP über Streamable HTTP – der Betrieb auf einem Server.
//
// Gegenüber stdio ändert sich das Bedrohungsmodell komplett: der Endpunkt ist
// über das Netz erreichbar, also gilt hier
//   * Bearer-Token-Pflicht: MCP_TOKEN aus der Umgebung ODER ein in der
//     Oberfläche angelegtes Token (einzeln widerrufbar, optional nur-lesend)
//   * Host-/Origin-Allowlist gegen DNS-Rebinding
//   * eine Sitzung je Client mit Obergrenze und Leerlauf-Ablauf
//   * Ratenbegrenzung und begrenzte Body-Größe
//   * Standard: nur an 127.0.0.1 gebunden. TLS macht der Reverse-Proxy davor.
import crypto from 'node:crypto';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './mcp-tools.js';
import { policy, configure } from './mcp-policy.js';
import { verifyMcpToken, countActiveMcpTokens } from './mcp-access.js';

const log = (...args) => console.error('[mcp-http]', ...args);
const list = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);

const PORT = Number(process.env.MCP_PORT || 3010);
const HOST = process.env.MCP_BIND_HOST || '127.0.0.1';
const PATH_ = process.env.MCP_PATH || '/mcp';
const TOKEN = process.env.MCP_TOKEN || '';
const ALLOW_ANONYMOUS = process.env.MCP_ALLOW_ANONYMOUS === '1';
const MAX_SESSIONS = Math.max(1, Number(process.env.MCP_MAX_SESSIONS || 32));
const IDLE_MS = Math.max(1, Number(process.env.MCP_SESSION_IDLE_MINUTES || 30)) * 60_000;
const RATE_LIMIT = Math.max(1, Number(process.env.MCP_RATE_LIMIT || 120)); // Anfragen/Minute/IP
const BODY_LIMIT = process.env.MCP_MAX_BODY || '30mb';
const LOOPBACK = ['127.0.0.1', '::1', 'localhost'].includes(HOST);

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const allowedHosts = list(process.env.MCP_ALLOWED_HOSTS).length
  ? list(process.env.MCP_ALLOWED_HOSTS)
  : (LOOPBACK ? [...LOCAL_HOSTS, ...LOCAL_HOSTS.map(h => `${h}:${PORT}`)] : undefined);
const allowedOrigins = list(process.env.MCP_ALLOWED_ORIGINS).length
  ? list(process.env.MCP_ALLOWED_ORIGINS)
  : undefined;

function timingSafeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export async function startHttpServer() {
  configure({ transport: 'http' });

  const dbTokens = countActiveMcpTokens();
  if (!TOKEN && !dbTokens && !ALLOW_ANONYMOUS) {
    log('FEHLER: Kein Zugang hinterlegt. Entweder MCP_TOKEN setzen (z.B. `openssl rand -hex 32`), '
      + 'in der Web-UI unter Einstellungen → MCP-Zugriff ein Token anlegen, oder – nur für einen '
      + 'rein lokalen Test – MCP_ALLOW_ANONYMOUS=1.');
    process.exit(1);
  }
  if (!TOKEN && !LOOPBACK) {
    log('FEHLER: MCP_ALLOW_ANONYMOUS ist nur zusammen mit einer Loopback-Bindung erlaubt.');
    process.exit(1);
  }

  const app = express();
  app.disable('x-powered-by');
  if (process.env.MCP_TRUST_PROXY) {
    const t = process.env.MCP_TRUST_PROXY;
    app.set('trust proxy', /^\d+$/.test(t) ? Number(t) : (t === 'true' ? true : t));
  }

  // ---- Ratenbegrenzung ----------------------------------------------------
  const hits = new Map();
  app.use((req, res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const entry = hits.get(key);
    const cur = !entry || entry.resetAt <= now ? { count: 0, resetAt: now + 60_000 } : entry;
    cur.count++;
    hits.set(key, cur);
    if (hits.size > 5000) hits.clear();
    if (cur.count > RATE_LIMIT) {
      res.set('Retry-After', String(Math.ceil((cur.resetAt - now) / 1000)));
      return res.status(429).json({ jsonrpc: '2.0', error: { code: -32029, message: 'Rate limit exceeded' }, id: null });
    }
    next();
  });

  // Betriebszustand – bewusst ohne Token, verrät nur, dass hier ein MCP-Server steht.
  app.get('/health', (req, res) => res.json({
    ok: true, service: 'mail-server-mcp', transport: 'http',
    sessions: sessions.size, readonly: policy.readonly, time: new Date().toISOString(),
  }));

  // ---- Token-Prüfung ------------------------------------------------------
  app.use(PATH_, (req, res, next) => {
    const header = req.get('authorization') || '';
    const supplied = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

    // 1. Das Token aus der Umgebung: ein Wert, volle Rechte, für den einfachen Fall.
    if (TOKEN && supplied && timingSafeEqual(supplied, TOKEN)) {
      req.mcpAuth = { transport: 'http', tokenName: 'MCP_TOKEN (Umgebung)', readonly: false };
      return next();
    }
    // 2. In der Oberfläche angelegte Token: benannt, widerrufbar, optional nur-lesend.
    const row = supplied ? verifyMcpToken(supplied, { ip: req.ip }) : null;
    if (row) {
      req.mcpAuth = { transport: 'http', tokenId: row.id, tokenName: row.name, readonly: !!row.readonly };
      return next();
    }
    if (!TOKEN && ALLOW_ANONYMOUS) {
      req.mcpAuth = { transport: 'http', tokenName: 'anonym' };
      return next();
    }
    res.set('WWW-Authenticate', 'Bearer realm="mail-server-mcp"');
    return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
  });

  app.use(PATH_, express.json({ limit: BODY_LIMIT }));

  // ---- Sitzungen ----------------------------------------------------------
  /** sessionId → { transport, server, lastSeen, tokenId, tokenName } */
  const sessions = new Map();

  // Eine Sitzung gehört dem Token, das sie eröffnet hat. Ohne diese Prüfung
  // reichte irgendein gültiges Token plus eine erratene/abgefangene Session-ID,
  // um in einer fremden Sitzung weiterzuarbeiten – etwa ein nur-lesendes Token
  // in der Sitzung eines Voll-Tokens, denn die Werkzeugliste wurde beim
  // Anlegen der Sitzung festgelegt, nicht je Anfrage.
  const sessionOwner = auth => ({ tokenId: auth?.tokenId ?? null, tokenName: auth?.tokenName ?? null });
  const ownsSession = (auth, entry) => {
    const a = sessionOwner(auth);
    // UI-Token: die Datenbank-ID ist eindeutig. MCP_TOKEN/anonym haben keine ID –
    // dort muss der (feste) Name übereinstimmen.
    if (entry.tokenId != null || a.tokenId != null) return entry.tokenId === a.tokenId;
    return entry.tokenName === a.tokenName;
  };

  async function closeSession(id, reason) {
    const entry = sessions.get(id);
    if (!entry) return;
    sessions.delete(id);
    log(`Sitzung ${id.slice(0, 8)}… beendet (${reason})`);
    await entry.transport.close().catch(() => {});
    await entry.server.close().catch(() => {});
  }

  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of sessions) {
      if (now - entry.lastSeen > IDLE_MS) closeSession(id, 'Leerlauf');
    }
  }, 60_000);
  sweeper.unref();

  const isInitialize = body => (Array.isArray(body) ? body : [body])
    .some(m => m && typeof m === 'object' && m.method === 'initialize');

  app.all(PATH_, async (req, res) => {
    const sessionId = req.get('mcp-session-id');

    try {
      // Bestehende Sitzung
      if (sessionId && sessions.has(sessionId)) {
        const entry = sessions.get(sessionId);
        if (!ownsSession(req.mcpAuth, entry)) {
          log(`Sitzung ${sessionId.slice(0, 8)}… mit fremdem Token angefragt (${req.mcpAuth?.tokenName || '?'}) – abgewiesen`);
          return res.status(403).json({ jsonrpc: '2.0', error: { code: -32003, message: 'Session belongs to another token' }, id: null });
        }
        entry.lastSeen = Date.now();
        await entry.transport.handleRequest(req, res, req.body);
        if (req.method === 'DELETE') await closeSession(sessionId, 'Client-Abmeldung');
        return;
      }
      if (sessionId) {
        return res.status(404).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Session not found' }, id: null });
      }
      // Neue Sitzung – nur mit initialize
      if (req.method !== 'POST' || !isInitialize(req.body)) {
        return res.status(400).json({
          jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: Mcp-Session-Id header required' }, id: null,
        });
      }
      if (sessions.size >= MAX_SESSIONS) {
        log(`Sitzungsgrenze erreicht (${MAX_SESSIONS}) – neue Verbindung abgewiesen`);
        return res.status(503).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Too many sessions' }, id: null });
      }

      // Herkunft der Sitzung: landet im Protokoll, und ein nur-lesendes Token
      // bekommt gar nicht erst die schreibenden Werkzeuge angeboten.
      const server = createMcpServer(req.mcpAuth || { transport: 'http' });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        // Schützt davor, dass eine Website im Browser des Nutzers per DNS-Rebinding
        // auf einen lokal laufenden MCP-Server zugreift.
        enableDnsRebindingProtection: !!(allowedHosts || allowedOrigins),
        allowedHosts,
        allowedOrigins,
        onsessioninitialized: id => {
          sessions.set(id, { transport, server, lastSeen: Date.now(), ...sessionOwner(req.mcpAuth) });
          log(`Sitzung ${id.slice(0, 8)}… geöffnet (${sessions.size}/${MAX_SESSIONS})`);
        },
        onsessionclosed: id => closeSession(id, 'Transport geschlossen'),
      });
      transport.onclose = () => { if (transport.sessionId) closeSession(transport.sessionId, 'Verbindung getrennt'); };

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      log('Fehler:', e.message);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });

  const http = app.listen(PORT, HOST, () => {
    log(`läuft auf http://${HOST}:${PORT}${PATH_}`);
    log(`Token: ${TOKEN || dbTokens ? `erforderlich (${TOKEN ? 'Umgebung' : ''}${TOKEN && dbTokens ? ' + ' : ''}${dbTokens ? `${dbTokens} aus der UI` : ''})` : 'AUS (anonym, nur Loopback)'} · `
      + `Nur-Lesen: ${policy.readonly ? 'ja' : 'nein'} · `
      + `Datei-Anhänge: ${policy.filesRoot || (policy.allowLocalFiles ? 'ganzes Dateisystem' : 'nur base64')}`);
    if (!LOOPBACK) log('Hinweis: Der Endpunkt ist über das Netz erreichbar – bitte TLS über einen Reverse-Proxy davorschalten.');
  });
  http.headersTimeout = 65_000;
  http.requestTimeout = 0; // SSE-Streams dürfen leben

  let closing = false;
  const shutdown = async signal => {
    if (closing) return;
    closing = true;
    log(`${signal} – fahre herunter …`);
    clearInterval(sweeper);
    for (const id of [...sessions.keys()]) await closeSession(id, 'Server-Stopp');
    http.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return http;
}
