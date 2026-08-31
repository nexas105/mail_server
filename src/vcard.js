// vCard (.vcf) – das „Handy-Format" für Kontakte. Import (parse) & Export (generate).

function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
}
function unesc(v) {
  return v.replace(/\\n/gi, ' ').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\').trim();
}

// Parst .vcf-Text zu [{name, email, phone, company}] – ein Eintrag pro E-Mail.
export function parseVcf(text) {
  const out = [];
  const blocks = unfold(String(text || '')).split(/BEGIN:VCARD/i).slice(1);
  for (const block of blocks) {
    let fn = '', nFallback = '', phone = '', company = '';
    const emails = [];
    for (const raw of block.split('\n')) {
      const line = raw.trim();
      if (!line || /^END:VCARD/i.test(line)) continue;
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const prop = line.slice(0, idx).replace(/^item\d+\./i, '').split(';')[0].toUpperCase();
      const value = line.slice(idx + 1);
      if (prop === 'FN') fn = unesc(value);
      else if (prop === 'N' && !nFallback) nFallback = unesc(value.split(';').filter(Boolean).reverse().join(' '));
      else if (prop === 'EMAIL') { const e = value.split(',')[0].trim(); if (e) emails.push(e); }
      else if (prop === 'TEL' && !phone) phone = unesc(value.split(',')[0]);
      else if (prop === 'ORG' && !company) company = unesc(value.split(';')[0]);
    }
    const name = fn || nFallback || '';
    for (const email of emails) if (/@/.test(email)) out.push({ name, email, phone, company });
  }
  // Dedupe je E-Mail (erste gewinnt)
  const seen = new Set();
  return out.filter(c => { const k = c.email.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

function esc(v) {
  return String(v || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

// Erzeugt .vcf (vCard 3.0) aus Kontakten (name/email/phone/company optional).
export function contactsToVcf(contacts) {
  const cards = contacts.map(c => {
    const name = c.name || c.email;
    const lines = [
      'BEGIN:VCARD', 'VERSION:3.0',
      `FN:${esc(name)}`, `N:${esc(name)};;;;`,
      `EMAIL;TYPE=INTERNET:${c.email}`,
    ];
    if (c.phone) lines.push(`TEL;TYPE=CELL:${esc(c.phone)}`);
    if (c.company) lines.push(`ORG:${esc(c.company)}`);
    lines.push('END:VCARD');
    return lines.join('\r\n');
  });
  return cards.join('\r\n') + '\r\n';
}
