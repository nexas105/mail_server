// HTTP-Schicht der Anmeldung: Cookie-Sitzung, Bearer-Token, Schutzwall vor
// /api/* und die Routen unter /api/auth/*.
//
// Der Ablauf beim allerersten Start ist bewusst „Setup statt Standardpasswort":
// solange kein Benutzer existiert, meldet /api/auth/state needs_setup=true und
// die Web-UI zeigt das Registrierungsformular. Ist der Administrator angelegt,
// schließt sich diese Tür für immer.
import crypto from 'node:crypto';
import * as auth from './auth.js';

// Ohne Anmeldung erreichbar. Bewusst kurz gehalten:
//  - /api/health   Monitoring & Launcher (verrät nur Betriebszustand)
//  - /api/auth/*   Anmeldung selbst
//  - /api/v1/*     externe Versand-API, hat mit MAIL_API_KEY einen eigenen Schutz
const PUBLIC_PATHS = [
  /^\/api\/health$/, /^\/api\/auth\//, /^\/api\/v1(\/|$)/,
  // Zählpixel: wird vom Mail-Client des Empfängers geladen, der sich
  // naturgemäß nicht anmelden kann. Das Token IST die Berechtigung.
  /^\/api\/t\/o\//,
];
const isPublic = path => PUBLIC_PATHS.some(re => re.test(path));

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function bearer(req) {
  const header = req.get('authorization') || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return String(req.get('x-api-key') || '').trim();
}

const cookieSecure = req => process.env.MAIL_COOKIE_SECURE === '1'
  || (process.env.MAIL_COOKIE_SECURE !== '0' && (req.secure || req.get('x-forwarded-proto') === 'https'));

function setSessionCookie(req, res, token, maxAgeSeconds) {
  const bits = [
    `${auth.COOKIE_NAME}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (cookieSecure(req)) bits.push('Secure');
  res.append('Set-Cookie', bits.join('; '));
}
function clearSessionCookie(req, res) {
  const bits = [`${auth.COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (cookieSecure(req)) bits.push('Secure');
  res.append('Set-Cookie', bits.join('; '));
}

/**
 * Ist die Anfrage von einer fremden Seite ausgelöst worden? Zählt nur für
 * Cookie-Sitzungen – Token-Clients schicken keine Cookies und können nicht
 * per CSRF missbraucht werden.
 *
 * Sec-Fetch-Site deckt auch den unangenehmen Fall ab, dass jemand per <a href>
 * oder <img> ein GET auslöst, das etwas verändert (z.B. der SSE-Versand).
 */
function crossSite(req) {
  const site = req.get('sec-fetch-site');
  if (site) return !(site === 'same-origin' || site === 'none');
  const origin = req.get('origin');
  if (origin) {
    const self = `${req.protocol}://${req.get('host')}`;
    return origin !== self;
  }
  return false; // Kein Browser (curl, native App) – dort schützt schon das Token
}

const authHits = new Map();
function authRateLimit(req, res, next) {
  const limit = Math.max(5, Number(process.env.MAIL_AUTH_RATE_LIMIT || 30));
  const key = req.ip || 'unknown';
  const now = Date.now();
  const entry = authHits.get(key);
  const current = !entry || entry.resetAt <= now ? { count: 0, resetAt: now + 60_000 } : entry;
  current.count++;
  authHits.set(key, current);
  if (authHits.size > 5000) authHits.clear();
  if (current.count > limit) return res.status(429).json({ error: 'Zu viele Anfragen – bitte kurz warten' });
  next();
}

// new Promise statt Promise.resolve(fn()): so landet auch ein synchroner
// throw im catch – sonst fliegt er an Express vorbei und wird zur HTML-Fehlerseite.
const wrap = fn => (req, res) => new Promise(resolve => resolve(fn(req, res))).catch(e => {
  res.status(e.status || 400).json({ error: e.message });
});

function requireUser(req, res, next) {
  if (!req.auth?.user) return res.status(401).json({ error: 'Nicht angemeldet' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.auth?.user) return res.status(401).json({ error: 'Nicht angemeldet' });
  if (req.auth.user.role !== 'admin' && req.auth.via !== 'service') {
    return res.status(403).json({ error: 'Nur für Administratoren' });
  }
  next();
}

const publicUser = u => u && ({ id: u.id, email: u.email, name: u.name, role: u.role });

export function installAuth(app) {
  // ---- 1. Wer ist das? ----------------------------------------------------
  app.use((req, res, next) => {
    const cookies = parseCookies(req.get('cookie'));
    const token = bearer(req);

    if (token) {
      const service = auth.isServiceToken(token);
      if (service) { req.auth = { via: 'service', service: service.name, user: { id: 0, email: `service:${service.name}`, role: 'admin' } }; return next(); }
      const user = auth.resolveApiToken(token);
      if (user) { req.auth = { via: 'token', user }; return next(); }
    }

    const sid = cookies[auth.COOKIE_NAME];
    if (sid) {
      const session = auth.getSession(sid);
      if (session) {
        auth.touchSession(session.row.id);
        req.auth = { via: 'cookie', user: session.user, sessionId: session.row.id };
        return next();
      }
      // Abgelaufen oder widerrufen: Cookie wegräumen, damit der Browser nicht ewig weiterprobiert.
      if (!isPublic(req.path)) clearSessionCookie(req, res);
    }
    req.auth = { via: null, user: null };
    next();
  });

  // ---- 2. CSRF: Cookie-Sitzungen nur von der eigenen Seite ----------------
  app.use((req, res, next) => {
    if (req.auth?.via === 'cookie' && crossSite(req)) {
      return res.status(403).json({ error: 'Anfrage von fremder Herkunft abgelehnt' });
    }
    next();
  });

  // ---- 3. Routen ----------------------------------------------------------
  app.get('/api/auth/state', authRateLimit, (req, res) => res.json({
    needs_setup: auth.needsSetup(),
    setup_token_required: !!process.env.MAIL_SETUP_TOKEN,
    authenticated: !!req.auth?.user,
    user: publicUser(req.auth?.user),
  }));

  // Erstinbetriebnahme: legt den ersten Administrator an und meldet ihn gleich an.
  app.post('/api/auth/setup', authRateLimit, wrap((req, res) => {
    if (!auth.needsSetup()) {
      const e = new Error('Es existiert bereits ein Konto – bitte anmelden'); e.status = 409; throw e;
    }
    const expected = process.env.MAIL_SETUP_TOKEN;
    if (expected) {
      const supplied = String(req.body?.setup_token || '');
      const a = Buffer.from(supplied), b = Buffer.from(expected);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        const e = new Error('Einrichtungs-Schlüssel ist falsch'); e.status = 403; throw e;
      }
    }
    const user = auth.registerFirstAdmin({
      email: req.body?.email, name: req.body?.name, password: req.body?.password,
    });
    const session = auth.createSession(user.id, { ip: req.ip, userAgent: req.get('user-agent'), remember: true });
    setSessionCookie(req, res, session.token, session.maxAgeSeconds);
    console.log(`[auth] Administrator angelegt: ${user.email}`);
    res.status(201).json({ ok: true, user });
  }));

  app.post('/api/auth/login', authRateLimit, wrap((req, res) => {
    const user = auth.authenticate({ email: req.body?.email, password: req.body?.password, ip: req.ip });
    const session = auth.createSession(user.id, {
      ip: req.ip, userAgent: req.get('user-agent'), remember: !!req.body?.remember,
    });
    setSessionCookie(req, res, session.token, session.maxAgeSeconds);
    res.json({ ok: true, user: publicUser(user) });
  }));

  app.post('/api/auth/logout', (req, res) => {
    const sid = parseCookies(req.get('cookie'))[auth.COOKIE_NAME];
    if (sid) auth.deleteSession(sid);
    clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  app.get('/api/auth/me', requireUser, (req, res) => res.json(publicUser(req.auth.user)));

  app.post('/api/auth/password', requireUser, wrap((req, res) => {
    auth.changePassword(req.auth.user.id, req.body?.current_password, req.body?.new_password);
    // Alle anderen Sitzungen fliegen raus – die eigene bleibt.
    auth.deleteUserSessions(req.auth.user.id, req.auth.sessionId || null);
    res.json({ ok: true });
  }));

  app.get('/api/auth/sessions', requireUser, (req, res) => res.json(
    auth.listSessions(req.auth.user.id).map(s => ({ ...s, current: s.id === req.auth.sessionId, id: undefined })),
  ));
  app.delete('/api/auth/sessions', requireUser, (req, res) => res.json({
    revoked: auth.deleteUserSessions(req.auth.user.id, req.auth.sessionId || null),
  }));

  // API-Token für native Clients (macOS-App) und Skripte.
  app.get('/api/auth/tokens', requireUser, (req, res) => res.json(auth.listApiTokens(req.auth.user.id)));
  app.post('/api/auth/tokens', requireUser, wrap((req, res) => res.status(201).json(
    auth.createApiToken(req.auth.user.id, { name: req.body?.name, days: req.body?.days || null }),
  )));
  app.delete('/api/auth/tokens/:id', requireUser, (req, res) => res.json({
    ok: auth.deleteApiToken(req.auth.user.id, +req.params.id),
  }));

  // Benutzerverwaltung (nur Administratoren).
  app.get('/api/auth/users', requireAdmin, (req, res) => res.json(auth.listUsers()));
  app.post('/api/auth/users', requireAdmin, wrap((req, res) => res.status(201).json(auth.createUser({
    email: req.body?.email, name: req.body?.name, password: req.body?.password, role: req.body?.role,
  }))));
  app.put('/api/auth/users/:id', requireAdmin, wrap((req, res) => {
    const u = auth.updateUser(+req.params.id, req.body || {});
    if (!u) return res.status(404).json({ error: 'not found' });
    res.json(u);
  }));
  app.post('/api/auth/users/:id/password', requireAdmin, wrap((req, res) => {
    auth.setPassword(+req.params.id, req.body?.password);
    auth.deleteUserSessions(+req.params.id);
    res.json({ ok: true });
  }));
  app.delete('/api/auth/users/:id', requireAdmin, wrap((req, res) => {
    if (+req.params.id === req.auth.user.id) throw new Error('Das eigene Konto kann hier nicht gelöscht werden');
    res.json({ ok: auth.deleteUser(+req.params.id) });
  }));

  // ---- 4. Schutzwall ------------------------------------------------------
  app.use('/api', (req, res, next) => {
    if (isPublic(req.originalUrl.split('?')[0])) return next();
    if (req.auth?.user) return next();
    if (auth.needsSetup()) {
      return res.status(401).json({ error: 'Server ist noch nicht eingerichtet', needs_setup: true });
    }
    res.status(401).json({ error: 'Nicht angemeldet' });
  });
}

export { requireAdmin, requireUser };
