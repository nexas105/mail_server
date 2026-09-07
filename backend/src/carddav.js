// Minimaler CardDAV-Client (ohne externe Libs). Holt vCards aus einer Adressbuch-
// Collection-URL via REPORT (addressbook-query); fällt bei Bedarf auf PROPFIND + GET
// der einzelnen .vcf-Ressourcen zurück. Parst FN/EMAIL zu {name, email}.
//
// Jede Zieladresse läuft vorher durch src/net-guard.js: die URL kommt aus der
// Account-Konfiguration, und das Passwort geht per Basic-Auth genau dorthin.

import { assertSafeTarget, assertSafeUrl, assertSameOrigin } from './net-guard.js';

const TIMEOUT_MS = 20_000;
/** Obergrenze für Server-Antworten – schützt Speicher und die Regex-Auswertung. */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/** Liest den Body, bricht aber ab, sobald er zu groß wird (Content-Length allein ist nicht verlässlich). */
async function readCapped(res, what) {
  const declared = Number(res.headers.get('content-length')) || 0;
  if (declared > MAX_RESPONSE_BYTES) throw new Error(`CardDAV ${what}: Antwort zu groß (${declared} Bytes)`);
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) throw new Error(`CardDAV ${what}: Antwort zu groß (> ${MAX_RESPONSE_BYTES} Bytes)`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Inhalt aller <ns:tag …>…</ns:tag>-Elemente, in linearer Zeit: Öffnungs-Tag
 * per (eng begrenzter) Regex, dann vorwärts zum nächsten Schluss-Tag. Ein
 * einziger „[\s\S]*?“-Ausdruck über die ganze Antwort wäre bei fehlendem
 * Schluss-Tag quadratisch – ein böser Server könnte uns damit minutenlang
 * beschäftigen.
 */
function xmlElements(xml, tag) {
  const open = new RegExp(`<(?:[\\w.-]+:)?${tag}(?:\\s[^<>]*)?>`, 'gi');
  const close = new RegExp(`</(?:[\\w.-]+:)?${tag}\\s*>`, 'gi');
  const out = [];
  let m;
  while ((m = open.exec(xml))) {
    close.lastIndex = open.lastIndex;
    const c = close.exec(xml);
    if (!c) break;
    out.push(xml.slice(open.lastIndex, c.index));
    open.lastIndex = close.lastIndex;
  }
  return out;
}

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, '&');
}

function unfold(vcardText) {
  // vCard-Folding: Fortsetzungszeilen beginnen mit Space/Tab.
  return vcardText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
}

function unescapeValue(v) {
  return v.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

// Parst einen Text mit einer oder mehreren vCards zu [{name, email}] (pro E-Mail ein Eintrag).
export function parseVcards(text) {
  const out = [];
  const blocks = unfold(text).split(/BEGIN:VCARD/i).slice(1);
  for (const block of blocks) {
    const lines = block.split('\n');
    let fn = '', nFallback = '';
    const emails = [];
    for (let raw of lines) {
      const line = raw.trim();
      if (!line || /^END:VCARD/i.test(line)) continue;
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      let namePart = line.slice(0, idx);
      const value = line.slice(idx + 1).trim();
      namePart = namePart.replace(/^item\d+\./i, ''); // Apple item1.EMAIL
      const prop = namePart.split(';')[0].toUpperCase();
      if (prop === 'FN') fn = unescapeValue(value);
      else if (prop === 'N' && !nFallback) nFallback = unescapeValue(value.split(';').filter(Boolean).reverse().join(' ')).trim();
      else if (prop === 'EMAIL') { const e = value.split(',')[0].trim(); if (e) emails.push(e); }
    }
    const name = fn || nFallback || '';
    for (const email of emails) if (/@/.test(email)) out.push({ name, email });
  }
  return out;
}

function authHeader(user, pass) {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

async function report(url, user, pass) {
  await assertSafeTarget(url, { purpose: 'CardDAV' });
  const body = `<?xml version="1.0" encoding="utf-8" ?>
<C:addressbook-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
  <D:prop><D:getetag/><C:address-data/></D:prop>
</C:addressbook-query>`;
  const res = await fetch(url, {
    method: 'REPORT',
    headers: { Authorization: authHeader(user, pass), 'Content-Type': 'application/xml; charset=utf-8', Depth: '1' },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`CardDAV REPORT ${res.status} ${res.statusText}`);
  const xml = await readCapped(res, 'REPORT');
  const cards = xmlElements(xml, 'address-data').map(decodeXmlEntities);
  return cards.join('\n');
}

async function propfindThenGet(url, user, pass) {
  await assertSafeTarget(url, { purpose: 'CardDAV' });
  const res = await fetch(url, {
    method: 'PROPFIND',
    headers: { Authorization: authHeader(user, pass), 'Content-Type': 'application/xml; charset=utf-8', Depth: '1' },
    body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:getcontenttype/></D:prop></D:propfind>',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`CardDAV PROPFIND ${res.status} ${res.statusText}`);
  const xml = await readCapped(res, 'PROPFIND');
  const hrefs = xmlElements(xml, 'href')
    .map(h => decodeXmlEntities(h).trim())
    .filter(h => /\.vcf$/i.test(h));
  const base = new URL(url);
  let all = '';
  for (const href of hrefs) {
    // hrefs liefert der Server. Nur Ziele auf derselben Origin wie die
    // Collection – sonst könnte er uns samt Passwort woandershin schicken.
    let target;
    try {
      target = new URL(href, base);
      assertSameOrigin(target, base);
      assertSafeUrl(target, { purpose: 'CardDAV' });
    } catch { continue; }
    const r = await fetch(target.toString(), {
      headers: { Authorization: authHeader(user, pass) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (r.ok) all += '\n' + await readCapped(r, 'GET');
  }
  return all;
}

// Holt und parst alle Kontakte einer Adressbuch-URL. Gibt [{name, email}] zurück.
export async function fetchContacts(url, user, pass) {
  if (!url) throw new Error('Keine CardDAV-URL konfiguriert');
  let text = '';
  try { text = await report(url, user, pass); } catch (e) { text = ''; if (String(e.message).includes(' 401')) throw e; }
  let contacts = parseVcards(text);
  if (contacts.length === 0) {
    const fallback = await propfindThenGet(url, user, pass);
    contacts = parseVcards(fallback);
  }
  // Dedupe per E-Mail (case-insensitive)
  const seen = new Set();
  return contacts.filter(c => {
    const k = c.email.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}
