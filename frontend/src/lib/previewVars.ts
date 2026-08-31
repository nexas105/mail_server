import type { CustomField, Brand } from './types';

// Variablen für eine Vorschau zusammenstellen. Vorrang wie beim Versand:
// globaler Standardwert < Marken-/Entwurfswerte < Beispielwerte für name/email.
// Felder ohne Wert behalten ihren Platzhalter, damit sichtbar bleibt, was fehlt.
export function previewVars(
  fields: CustomField[],
  overrides: Record<string, string> = {},
  sample: { name?: string; email?: string } = {},
): Record<string, string> {
  const defaults = Object.fromEntries(
    fields.map(f => [f.field_key, f.default_value || `{{${f.field_key}}}`]),
  );
  const filled = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== ''));
  return {
    ...defaults,
    ...filled,
    name: sample.name ?? 'Max Mustermann',
    email: sample.email ?? 'max@example.com',
  };
}

// Werte einer Marke für Vorschauen: gespeicherte Felder, aufgelöste Farb-Palette
// (leere Slots kommen abgeleitet vom Server) und die Logo-URL – wie beim Versand.
export function brandPreviewVars(b: Brand | null | undefined): Record<string, string> {
  if (!b) return {};
  return { ...b.vars, ...(b.palette ?? {}), ...(b.logo_url ? { brand_logo: b.logo_url } : {}) };
}

// Findet die Marke, deren Werte vollständig in den gegebenen Variablen stecken.
export function activeBrand(brands: Brand[], vars: Record<string, string>): Brand | null {
  return brands.find(b =>
    Object.keys(b.vars).length > 0 &&
    Object.entries(b.vars).every(([k, v]) => !v || vars[k] === v)) ?? null;
}
