// Minimaler CardDAV-Client (ohne externe Libs). Holt vCards aus einer Adressbuch-
// Collection-URL via REPORT (addressbook-query); fällt bei Bedarf auf PROPFIND + GET
// der einzelnen .vcf-Ressourcen zurück. Parst FN/EMAIL zu {name, email}.

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
  const body = `<?xml version="1.0" encoding="utf-8" ?>
<C:addressbook-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
  <D:prop><D:getetag/><C:address-data/></D:prop>
</C:addressbook-query>`;
  const res = await fetch(url, {
    method: 'REPORT',
    headers: { Authorization: authHeader(user, pass), 'Content-Type': 'application/xml; charset=utf-8', Depth: '1' },
    body,
  });
  if (!res.ok) throw new Error(`CardDAV REPORT ${res.status} ${res.statusText}`);
  const xml = await res.text();
  const cards = [...xml.matchAll(/<[^>]*address-data[^>]*>([\s\S]*?)<\/[^>]*address-data>/gi)]
    .map(m => decodeXmlEntities(m[1]));
  return cards.join('\n');
}

async function propfindThenGet(url, user, pass) {
  const res = await fetch(url, {
    method: 'PROPFIND',
    headers: { Authorization: authHeader(user, pass), 'Content-Type': 'application/xml; charset=utf-8', Depth: '1' },
    body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:getcontenttype/></D:prop></D:propfind>',
  });
  if (!res.ok) throw new Error(`CardDAV PROPFIND ${res.status} ${res.statusText}`);
  const xml = await res.text();
  const hrefs = [...xml.matchAll(/<[^>]*href[^>]*>([\s\S]*?)<\/[^>]*href>/gi)]
    .map(m => decodeXmlEntities(m[1]).trim())
    .filter(h => /\.vcf$/i.test(h));
  const base = new URL(url);
  let all = '';
  for (const href of hrefs) {
    const target = new URL(href, base).toString();
    const r = await fetch(target, { headers: { Authorization: authHeader(user, pass) } });
    if (r.ok) all += '\n' + await r.text();
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
