// SQLite speichert datetime('now') als UTC ohne Zeitzonen-Suffix – beim Parsen
// als UTC interpretieren, sonst verschieben sich alle Zeiten um den Offset.
export function parseDbDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? s.replace(' ', 'T') + 'Z' : s;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

export function relTime(s: string | null | undefined): string {
  const d = parseDbDate(s);
  if (!d) return '';
  const diff = Date.now() - d.getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} Min.`;
  const h = Math.round(min / 60);
  if (h < 24) return `vor ${h} Std.`;
  const days = Math.floor(diff / 86400000);
  if (days === 1) return 'gestern';
  if (days < 7) return `vor ${days} Tagen`;
  return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
}

export function fullDateTime(s: string | null | undefined): string {
  const d = parseDbDate(s);
  return d ? d.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : (s || '');
}
