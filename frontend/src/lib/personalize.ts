// Ersetzt {{name}}, {{email}} und beliebige {{feld}} aus vars – identisch zur Backend-Logik.
export function personalize(str: string, vars: Record<string, string>): string {
  if (!str) return str;
  return str.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
}
