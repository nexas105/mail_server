import type { Contact } from './types';

// Minimaler CSV-Parser (unterstützt Anführungszeichen, Kommas & Zeilenumbrüche in Feldern).
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', inQuotes = false;
  const s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',' || c === ';') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ''));
}

// Wandelt CSV-Text in Kontakte. Erkennt eine optionale Kopfzeile (email/name),
// sonst wird die Spalte mit "@" als E-Mail und die andere als Name interpretiert.
export function csvToContacts(text: string): { email: string; name: string }[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  let emailIdx = -1, nameIdx = -1, start = 0;
  const head = rows[0].map(h => h.trim().toLowerCase());
  if (head.some(h => ['email', 'e-mail', 'mail'].includes(h))) {
    emailIdx = head.findIndex(h => ['email', 'e-mail', 'mail'].includes(h));
    nameIdx = head.findIndex(h => ['name', 'vorname', 'anzeigename'].includes(h));
    start = 1;
  }
  const out: { email: string; name: string }[] = [];
  for (let i = start; i < rows.length; i++) {
    const cells = rows[i];
    let email = '', name = '';
    if (emailIdx >= 0) { email = (cells[emailIdx] || '').trim(); name = (cells[nameIdx] || '').trim(); }
    else {
      const ei = cells.findIndex(c => c.includes('@'));
      if (ei < 0) continue;
      email = cells[ei].trim();
      name = (cells.find((_, j) => j !== ei) || '').trim();
    }
    if (email) out.push({ email, name });
  }
  return out;
}

export function contactsToCsv(contacts: Contact[]): string {
  const esc = (v: string) => /[",;\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  return 'name,email\n' + contacts.map(c => `${esc(c.name || '')},${esc(c.email)}`).join('\n') + '\n';
}

export function download(filename: string, content: string, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function pickFile(accept: string): Promise<string | null> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = accept;
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    };
    input.click();
  });
}
