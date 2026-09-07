/**
 * GitHub-API (REST v3) – reines fetch, keine zusätzliche Abhängigkeit.
 *
 * Wie src/carddav.js: dieses Modul kennt die Datenbank NICHT. Es bekommt die
 * Verbindung als { token, apiBase } übergeben und wirft im Fehlerfall einen
 * Error mit deutscher Meldung – was damit passiert, entscheidet der Aufrufer.
 * Dadurch benutzen Web-Server und MCP-Server dasselbe Modul identisch.
 */

import { assertSameOrigin, guardedFetch } from './net-guard.js';

const UA = 'mail-server/1.0';
const API_VERSION = '2022-11-28';
const TIMEOUT_MS = 15_000;

/** Standard-Obergrenze für Dateiinhalte. Nicht GitHubs Limit, sondern unseres:
 *  darüber sprengt eine einzige Datei das Kontextfenster der KI. */
export const DEFAULT_MAX_BYTES = 60_000;
/** Darüber wird gar nicht erst heruntergeladen. */
const HARD_MAX_BYTES = 2 * 1024 * 1024;

/** Zuletzt gesehenes Rate-Limit, für Anzeige und Fehlermeldungen. */
let lastRateLimit = null;
export function rateLimit() { return lastRateLimit; }

/** Entfernt Tokens aus Texten, bevor irgendetwas geloggt oder geworfen wird. */
export function redact(text) {
  return String(text ?? '').replace(/gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/g, '***');
}

/**
 * Baut Pfadsegmente in eine URL ein. Die Segmente kommen vom Aufrufer (KI,
 * Web-UI) – „..“ (auch kodiert als %2e%2e) oder ein eingeschmuggelter „/“
 * würden sonst aus /repos/o/r/contents/… herauslaufen und einen ganz anderen
 * API-Endpunkt mit dem Token ansprechen.
 */
const enc = p => String(p || '').split('/').filter(Boolean).map(seg => {
  let plain;
  try { plain = decodeURIComponent(seg); } catch { throw new Error('Ungültiger Pfad'); }
  if (plain === '.' || plain === '..' || plain.includes('/') || plain.includes('\\') || /[\0-\x1f]/.test(plain)) {
    throw new Error('Ungültiger Pfad');
  }
  return encodeURIComponent(seg);
}).join('/');

/**
 * Prüfung der API-Adresse, BEVOR das Token dorthin geschickt wird – siehe
 * src/net-guard.js. api_base ist frei einstellbar (GitHub Enterprise); ohne
 * Prüfung könnte dort eine interne Adresse stehen und das Token ginge im
 * Authorization-Header genau dahin. MAIL_GITHUB_ALLOW_PRIVATE=1 (alt) oder
 * MAIL_ALLOW_PRIVATE_HOSTS=1 heben die Sperre für ein wirklich intern
 * betriebenes GitHub Enterprise auf.
 */
const guardOpts = () => ({ purpose: 'GitHub-API', allowPrivate: process.env.MAIL_GITHUB_ALLOW_PRIVATE === '1' });


/** Link-Header der letzten Antwort – paginate() folgt ihm. */
let lastLinkHeader = null;

function readRateLimit(res) {
  lastLinkHeader = res.headers.get('link');
  const remaining = res.headers.get('x-ratelimit-remaining');
  if (remaining == null) return null;
  lastRateLimit = {
    limit: Number(res.headers.get('x-ratelimit-limit')) || null,
    remaining: Number(remaining),
    used: Number(res.headers.get('x-ratelimit-used')) || null,
    reset: Number(res.headers.get('x-ratelimit-reset')) || null,
    resource: res.headers.get('x-ratelimit-resource') || null,
  };
  return lastRateLimit;
}

const resetTime = res => {
  const s = Number(res.headers.get('x-ratelimit-reset'));
  return s ? new Date(s * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : 'später';
};

/** Übersetzt eine GitHub-Fehlerantwort in eine verständliche deutsche Meldung. */
async function toError(res) {
  let body = {};
  try { body = await res.json(); } catch { /* kein JSON */ }
  const detail = redact(body.message || res.statusText);
  switch (res.status) {
    case 401:
      return new Error('GitHub-Token ungültig oder abgelaufen (401)');
    case 403:
      if (res.headers.get('x-ratelimit-remaining') === '0')
        return new Error(`GitHub-Rate-Limit erreicht – wieder verfügbar um ${resetTime(res)}`);
      if (res.headers.get('retry-after'))
        return new Error(`GitHub drosselt gerade – in ${res.headers.get('retry-after')} s erneut versuchen`);
      if (res.headers.get('x-github-sso'))
        return new Error('Token muss für diese Organisation per SSO freigegeben werden');
      return new Error(`Zugriff verweigert (403) – Token-Berechtigungen prüfen: ${detail}`);
    case 404:
      return new Error('Nicht gefunden – oder das Token hat keinen Zugriff darauf (404)');
    case 409:
      return new Error('Repository ist leer (noch keine Commits)');
    case 451:
      return new Error('Repository aus rechtlichen Gründen gesperrt (DMCA)');
    default:
      return new Error(`GitHub ${res.status}: ${detail}`);
  }
}

/**
 * Eine GitHub-Anfrage. `accept` steuert das Format – für Dateiinhalte nutzen wir
 * 'application/vnd.github.raw', dann entfällt die base64-Kodierung und die
 * 1-MB-Grenze der Contents-API komplett.
 */
async function gh(conn, pathOrUrl, { method = 'GET', accept = 'application/vnd.github+json', query, raw = false } = {}) {
  const base = conn.apiBase || 'https://api.github.com';
  // Nachgereichte URLs (paginate() folgt dem Link-Header, den liefert die
  // Gegenstelle) müssen zur konfigurierten API-Adresse gehören.
  if (pathOrUrl.startsWith('http')) assertSameOrigin(pathOrUrl, base);
  let url = pathOrUrl.startsWith('http') ? pathOrUrl : base.replace(/\/$/, '') + pathOrUrl;
  if (query) {
    const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== ''));
    if (String(qs)) url += (url.includes('?') ? '&' : '?') + qs;
  }
  let res;
  try {
    // guardedFetch prüft `url` (gleicher Host wie base) und jede Weiterleitung
    // gegen net-guard; Redirects auf fremde Origins werden abgelehnt.
    res = await guardedFetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${conn.token}`,
        Accept: accept,
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': UA,   // ohne User-Agent antwortet GitHub mit 403
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }, { base, ...guardOpts() });
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError')
      throw new Error(`GitHub-Anfrage hat das Zeitlimit (${TIMEOUT_MS / 1000} s) überschritten`);
    throw new Error(`GitHub nicht erreichbar: ${redact(e.message)}`);
  }
  readRateLimit(res);
  if (!res.ok) throw await toError(res);
  return raw ? res : res.json();
}

/** Folgt dem Link-Header, bricht bei `max` Einträgen ab. */
async function paginate(conn, path, { query = {}, perPage = 100, max = 100 } = {}) {
  const out = [];
  let url = null;
  for (let page = 0; page < 20 && out.length < max; page++) {
    const data = url
      ? await gh(conn, url)
      : await gh(conn, path, { query: { ...query, per_page: Math.min(perPage, max) } });
    if (!Array.isArray(data) || !data.length) break;
    out.push(...data);
    const next = lastLinkHeader && /<([^>]+)>;\s*rel="next"/.exec(lastLinkHeader);
    if (!next) break;
    url = next[1];
  }
  return out.slice(0, max);
}

/** Prüft ein Token und liefert, wem es gehört. */
export async function verifyToken(conn) {
  const res = await gh(conn, '/user', { raw: true });
  const user = await res.json();
  const scopeHeader = res.headers.get('x-oauth-scopes');
  // Fine-grained PATs senden keinen x-oauth-scopes-Header.
  const tokenType = scopeHeader == null ? 'fine_grained' : 'classic';
  return {
    login: user.login,
    name: user.name || null,
    id: user.id,
    token_type: tokenType,
    scopes: scopeHeader ? scopeHeader.split(',').map(s => s.trim()).filter(Boolean) : [],
    rate_limit: rateLimit(),
  };
}

/** Repos des Tokens – für die Auswahl beim Verknüpfen.
 *  /user/repos statt /users/:login/repos, sonst fehlen die privaten. */
export async function listRepos(conn, { limit = 100, sort = 'pushed',
  affiliation = 'owner,collaborator,organization_member' } = {}) {
  const repos = await paginate(conn, '/user/repos', { query: { sort, affiliation }, max: limit });
  return repos.map(slimRepo);
}

const slimRepo = r => ({
  repo_id: r.id,
  owner: r.owner?.login,
  name: r.name,
  full_name: r.full_name,
  private: r.private ? 1 : 0,
  default_branch: r.default_branch,
  description: r.description || null,
  html_url: r.html_url,
  pushed_at: r.pushed_at,
  language: r.language || null,
});

export async function getRepo(conn, { owner, repo }) {
  return slimRepo(await gh(conn, `/repos/${enc(owner)}/${enc(repo)}`));
}
/** Über die numerische ID – überlebt Umbenennen und Transfer. */
export async function getRepoById(conn, id) {
  return slimRepo(await gh(conn, `/repositories/${Number(id)}`));
}

/**
 * Dateibaum. Ohne `recursive` nur eine Ebene über die Contents-API (günstig);
 * mit `recursive` der ganze Baum über die Git-Trees-API – der kann bei großen
 * Repos abgeschnitten sein, das meldet GitHub mit `truncated`.
 */
export async function getTree(conn, { owner, repo, ref, path = '', recursive = false, limit = 200 } = {}) {
  const base = `/repos/${enc(owner)}/${enc(repo)}`;
  if (!recursive) {
    const data = await gh(conn, `${base}/contents/${enc(path)}`, { query: { ref } });
    const list = Array.isArray(data) ? data : [data];
    return {
      repo: `${owner}/${repo}`, ref: ref || null, path, recursive: false,
      entries: list.slice(0, limit).map(e => ({ path: e.path, type: e.type, size: e.size ?? null })),
      total: list.length, returned: Math.min(list.length, limit), truncated: false,
    };
  }
  const branch = ref || (await getRepo(conn, { owner, repo })).default_branch;
  const data = await gh(conn, `${base}/git/trees/${enc(branch)}`, { query: { recursive: 1 } });
  let entries = (data.tree || [])
    .filter(e => !path || e.path.startsWith(path))
    .map(e => ({ path: e.path, type: e.type === 'blob' ? 'file' : 'dir', size: e.size ?? null }));
  const total = entries.length;
  entries = entries.slice(0, limit);
  return {
    repo: `${owner}/${repo}`, ref: branch, path, recursive: true,
    entries, total, returned: entries.length,
    truncated: !!data.truncated || total > entries.length,
    hint: total > entries.length
      ? 'Nur ein Ausschnitt. Mit path einschränken oder limit erhöhen.' : undefined,
  };
}

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|pdf|zip|gz|tgz|bz2|xz|7z|rar|mp[34]|mov|avi|mkv|wav|flac|ttf|otf|woff2?|eot|so|dylib|dll|exe|bin|class|jar|wasm|db|sqlite3?)$/i;

/**
 * Dateiinhalt. Mit Accept: raw gibt es keine base64-Kodierung und keine
 * 1-MB-Grenze – die Obergrenze setzen wir selbst (Kontextfenster).
 */
export async function readFile(conn, { owner, repo, ref, path,
  maxBytes = DEFAULT_MAX_BYTES, startLine, endLine } = {}) {
  if (!path) throw new Error('path fehlt');
  const url = `/repos/${enc(owner)}/${enc(repo)}/contents/${enc(path)}`;
  const res = await gh(conn, url, { accept: 'application/vnd.github.raw', query: { ref }, raw: true });

  const declared = Number(res.headers.get('content-length')) || 0;
  if (declared > HARD_MAX_BYTES) {
    return { repo: `${owner}/${repo}`, ref: ref || null, path, size: declared, too_large: true,
      hint: `Datei ist ${(declared / 1048576).toFixed(1)} MB – zu groß zum Einlesen.` };
  }
  const buf = Buffer.from(await res.arrayBuffer());

  // Binär? NUL-Byte in den ersten 8 KB oder bekannte Endung.
  const isBinary = BINARY_EXT.test(path) || buf.subarray(0, 8192).includes(0);
  if (isBinary) {
    return { repo: `${owner}/${repo}`, ref: ref || null, path, size: buf.length, binary: true,
      hint: 'Binärdatei – Inhalt wird nicht eingelesen.' };
  }

  let text = buf.toString('utf8');
  const allLines = text.split('\n');
  const linesTotal = allLines.length;
  let from = 1, to = linesTotal;
  if (startLine || endLine) {
    from = Math.max(1, Number(startLine) || 1);
    to = Math.min(linesTotal, Number(endLine) || linesTotal);
    text = allLines.slice(from - 1, to).join('\n');
  }
  let truncated = false;
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    text = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
    truncated = true;
  }
  return {
    repo: `${owner}/${repo}`, ref: ref || null, path,
    size: buf.length, lines_total: linesTotal, start_line: from, end_line: to,
    truncated, content: text,
    hint: truncated ? `Gekürzt auf ${maxBytes} Bytes – mit start_line/end_line gezielt nachladen.` : undefined,
  };
}

export async function listCommits(conn, { owner, repo, ref, path, author, since, until, limit = 20 } = {}) {
  const data = await paginate(conn, `/repos/${enc(owner)}/${enc(repo)}/commits`, {
    query: { sha: ref, path, author, since, until }, max: limit,
  });
  return data.map(c => ({
    sha: c.sha.slice(0, 7),
    full_sha: c.sha,
    author: c.commit?.author?.name || c.author?.login || null,
    date: c.commit?.author?.date || null,
    message: (c.commit?.message || '').split('\n')[0],
    html_url: c.html_url,
  }));
}

export async function getCommit(conn, { owner, repo, sha, includePatch = false, maxPatchBytes = 20_000 } = {}) {
  const c = await gh(conn, `/repos/${enc(owner)}/${enc(repo)}/commits/${enc(sha)}`);
  return {
    repo: `${owner}/${repo}`,
    sha: c.sha, author: c.commit?.author?.name || null, date: c.commit?.author?.date || null,
    message: c.commit?.message || '', stats: c.stats || null, html_url: c.html_url,
    files: (c.files || []).map(f => ({
      filename: f.filename, status: f.status,
      additions: f.additions, deletions: f.deletions,
      patch: includePatch && f.patch ? f.patch.slice(0, maxPatchBytes) : undefined,
    })),
  };
}

/** Achtung: /issues liefert auch Pull Requests. `kind` filtert das. */
export async function listIssues(conn, { owner, repo, state = 'open', kind = 'all', labels, limit = 20 } = {}) {
  const path = kind === 'pr'
    ? `/repos/${enc(owner)}/${enc(repo)}/pulls`
    : `/repos/${enc(owner)}/${enc(repo)}/issues`;
  const data = await paginate(conn, path, { query: { state, labels }, max: limit * 2 });
  return data
    .filter(i => kind === 'all' || (kind === 'issue' ? !i.pull_request : true))
    .slice(0, limit)
    .map(i => ({
      number: i.number, title: i.title, state: i.state,
      kind: i.pull_request || kind === 'pr' ? 'pr' : 'issue',
      user: i.user?.login || null,
      labels: (i.labels || []).map(l => (typeof l === 'string' ? l : l.name)),
      comments: i.comments ?? null, updated_at: i.updated_at, html_url: i.html_url,
    }));
}

export async function getIssue(conn, { owner, repo, number, includeComments = false, maxBodyBytes = 8000 } = {}) {
  const i = await gh(conn, `/repos/${enc(owner)}/${enc(repo)}/issues/${Number(number)}`);
  const out = {
    repo: `${owner}/${repo}`, number: i.number, title: i.title, state: i.state,
    kind: i.pull_request ? 'pr' : 'issue', user: i.user?.login || null,
    labels: (i.labels || []).map(l => (typeof l === 'string' ? l : l.name)),
    created_at: i.created_at, updated_at: i.updated_at, html_url: i.html_url,
    body: (i.body || '').slice(0, maxBodyBytes),
  };
  if (includeComments && i.comments) {
    const cs = await paginate(conn, `/repos/${enc(owner)}/${enc(repo)}/issues/${Number(number)}/comments`, { max: 30 });
    out.comments = cs.map(c => ({
      user: c.user?.login || null, created_at: c.created_at, body: (c.body || '').slice(0, 2000),
    }));
  }
  return out;
}
