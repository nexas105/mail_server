// OAuth 2.1 für Clients, die keinen festen Bearer-Header können (ChatGPT).
//
// ChatGPT kennt für eigene MCP-Server nur „OAuth" oder „keine Anmeldung".
// Damit der Relay trotzdem geschützt bleibt, spielt er hier selbst den
// Autorisierungsserver – bewusst schlicht:
//   * /.well-known/oauth-protected-resource[/…]  → verweist auf uns selbst
//   * /.well-known/oauth-authorization-server     → Endpunkte
//   * POST /oauth/register                        → dynamische Registrierung
//   * GET/POST /oauth/authorize                   → Anmeldeseite: der Nutzer
//     gibt ein vorhandenes MCP-Token ein (MCP_TOKEN oder UI-Token)
//   * POST /oauth/token                           → Code (mit PKCE) gegen Token
//
// Das ausgegebene Access-Token ist ein ganz normales UI-Token (mcp_tokens):
// Es trägt den Namen des Clients, erbt „nur lesen" vom eingegebenen Token und
// lässt sich in der Oberfläche einzeln abschalten oder löschen. Die bestehende
// Token-Prüfung in mcp-http.js braucht deshalb keine Sonderregel.
import crypto from 'node:crypto';
import express from 'express';
import { createMcpToken, verifyMcpToken } from './mcp-access.js';

const log = (...args) => console.error('[mcp-oauth]', ...args);
const list = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);

// Nur an diese Hosts darf nach der Anmeldung zurückgeleitet werden.
const REDIRECT_HOSTS = list(process.env.MCP_OAUTH_REDIRECT_HOSTS).length
  ? list(process.env.MCP_OAUTH_REDIRECT_HOSTS)
  : ['chatgpt.com', 'chat.openai.com', 'platform.openai.com', 'claude.ai', 'claude.com', 'localhost', '127.0.0.1'];
const CODE_TTL_MS = 10 * 60_000;

const codes = new Map();   // code → { clientId, redirectUri, challenge, method, tokenRow, clientName, exp }
const clients = new Map(); // clientId → { name, redirectUris }

const sha256b64url = v => crypto.createHash('sha256').update(v).digest('base64url');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function timingSafeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function baseUrl(req) {
  if (process.env.MCP_PUBLIC_URL) return process.env.MCP_PUBLIC_URL.replace(/\/+$/, '');
  return `${req.get('x-forwarded-proto') || req.protocol}://${req.get('x-forwarded-host') || req.get('host')}`;
}

function redirectAllowed(uri) {
  try {
    const u = new URL(uri);
    const local = ['localhost', '127.0.0.1'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return false;
    return REDIRECT_HOSTS.some(h => u.hostname === h || u.hostname.endsWith(`.${h}`));
  } catch { return false; }
}

function sweep() {
  const now = Date.now();
  for (const [k, v] of codes) if (v.exp <= now) codes.delete(k);
  if (clients.size > 1000) clients.clear();
}

/** Header für 401-Antworten, damit der Client die Metadaten findet. */
export function oauthChallenge(req, path) {
  return `Bearer realm="mail-server-mcp", resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource${path}"`;
}

/**
 * Hängt die OAuth-Endpunkte an. `checkToken(supplied)` liefert für ein gültiges
 * Eingabe-Token { readonly, name } oder null.
 */
export function mountOAuth(app, { mcpPath, envToken }) {
  const form = express.urlencoded({ extended: false, limit: '20kb' });
  const json = express.json({ limit: '20kb' });

  const checkToken = (supplied, ip) => {
    const v = String(supplied || '').trim();
    if (!v) return null;
    if (envToken && timingSafeEqual(v, envToken)) return { readonly: false, name: 'MCP_TOKEN' };
    const row = verifyMcpToken(v, { ip });
    return row ? { readonly: !!row.readonly, name: row.name } : null;
  };

  const resourceMeta = (req, res) => {
    const base = baseUrl(req);
    const suffix = req.params[0] ? `/${req.params[0]}` : mcpPath;
    res.json({
      resource: `${base}${suffix}`,
      authorization_servers: [base],
      bearer_methods_supported: ['header'],
      resource_name: 'Mail-Server MCP',
    });
  };
  app.get('/.well-known/oauth-protected-resource', resourceMeta);
  app.get('/.well-known/oauth-protected-resource/*', resourceMeta);

  const asMeta = (req, res) => {
    const base = baseUrl(req);
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      scopes_supported: ['mcp'],
    });
  };
  app.get('/.well-known/oauth-authorization-server', asMeta);
  app.get('/.well-known/oauth-authorization-server/*', asMeta);
  app.get('/.well-known/openid-configuration', asMeta);

  app.post('/oauth/register', json, (req, res) => {
    sweep();
    const uris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris.map(String) : [];
    if (!uris.length || !uris.every(redirectAllowed)) {
      return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uri nicht erlaubt' });
    }
    const clientId = `client_${crypto.randomBytes(12).toString('base64url')}`;
    const name = String(req.body?.client_name || 'OAuth-Client').slice(0, 60);
    clients.set(clientId, { name, redirectUris: uris });
    log(`Client registriert: ${name} (${clientId})`);
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: uris,
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  });

  const page = (q, error = '') => `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Mail-Server verbinden</title>
<style>body{font-family:system-ui,sans-serif;background:#f4f5f7;color:#111;margin:0;display:grid;place-items:center;min-height:100vh}
main{background:#fff;padding:28px;border-radius:12px;max-width:420px;width:calc(100% - 32px);box-shadow:0 2px 12px rgba(0,0,0,.08)}
h1{font-size:20px;margin:0 0 8px}p{color:#555;line-height:1.5}input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #ccc;border-radius:8px;font:inherit}
button{margin-top:14px;width:100%;padding:11px;border:0;border-radius:8px;background:#1d3b6e;color:#fff;font:inherit;cursor:pointer}
.err{color:#b00020}</style></head><body><main>
<h1>Mail-Server verbinden</h1>
<p><strong>${esc(q.clientName)}</strong> möchte auf den Mail-Server zugreifen. Gib dafür ein MCP-Token ein. Der Client bekommt ein eigenes Token, das du in der Oberfläche unter MCP-Zugriff jederzeit widerrufen kannst.</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/oauth/authorize">
${['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource']
    .map(k => `<input type="hidden" name="${k}" value="${esc(q[k])}">`).join('')}
<input type="password" name="mcp_token" placeholder="MCP-Token" autocomplete="off" required autofocus>
<button type="submit">Zugriff erlauben</button></form></main></body></html>`;

  const readParams = src => {
    const q = {};
    for (const k of ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource', 'response_type']) {
      q[k] = typeof src[k] === 'string' ? src[k] : '';
    }
    const c = clients.get(q.client_id);
    q.clientName = c?.name || 'Ein KI-Client';
    return q;
  };

  const validate = q => {
    if (!q.redirect_uri || !redirectAllowed(q.redirect_uri)) return 'redirect_uri nicht erlaubt';
    const c = clients.get(q.client_id);
    if (c && !c.redirectUris.includes(q.redirect_uri)) return 'redirect_uri passt nicht zum Client';
    if (!q.code_challenge || (q.code_challenge_method && q.code_challenge_method !== 'S256')) return 'PKCE (S256) erforderlich';
    return null;
  };

  app.get('/oauth/authorize', (req, res) => {
    const q = readParams(req.query);
    const err = validate(q);
    if (err) return res.status(400).type('text').send(err);
    res.set('Cache-Control', 'no-store').type('html').send(page(q));
  });

  app.post('/oauth/authorize', form, (req, res) => {
    sweep();
    const q = readParams(req.body || {});
    const err = validate(q);
    if (err) return res.status(400).type('text').send(err);
    const who = checkToken(req.body?.mcp_token, req.ip);
    if (!who) {
      log(`Anmeldung abgewiesen (${q.clientName}, ${req.ip})`);
      return res.status(401).set('Cache-Control', 'no-store').type('html').send(page(q, 'Token ungültig.'));
    }
    const code = crypto.randomBytes(24).toString('base64url');
    codes.set(code, {
      clientId: q.client_id, redirectUri: q.redirect_uri, challenge: q.code_challenge,
      readonly: who.readonly, clientName: q.clientName, exp: Date.now() + CODE_TTL_MS,
    });
    const u = new URL(q.redirect_uri);
    u.searchParams.set('code', code);
    if (q.state) u.searchParams.set('state', q.state);
    res.redirect(302, u.toString());
  });

  app.post('/oauth/token', form, json, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const b = req.body || {};
    if (b.grant_type !== 'authorization_code') return res.status(400).json({ error: 'unsupported_grant_type' });
    const entry = codes.get(String(b.code || ''));
    codes.delete(String(b.code || ''));
    if (!entry || entry.exp <= Date.now()) return res.status(400).json({ error: 'invalid_grant' });
    if (b.redirect_uri && b.redirect_uri !== entry.redirectUri) return res.status(400).json({ error: 'invalid_grant' });
    let clientId = b.client_id;
    const basic = req.get('authorization') || '';
    if (!clientId && basic.startsWith('Basic ')) {
      clientId = Buffer.from(basic.slice(6), 'base64').toString().split(':')[0];
    }
    if (clientId && entry.clientId && clientId !== entry.clientId) return res.status(400).json({ error: 'invalid_client' });
    if (!b.code_verifier || sha256b64url(String(b.code_verifier)) !== entry.challenge) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE fehlgeschlagen' });
    }
    const t = createMcpToken({
      name: `${entry.clientName} (OAuth)`.slice(0, 80), readonly: entry.readonly, createdBy: 'oauth',
    });
    log(`Token ausgegeben: ${t.name} (#${t.id}${entry.readonly ? ', nur lesen' : ''})`);
    res.json({ access_token: t.token, token_type: 'Bearer', scope: 'mcp' });
  });
}
