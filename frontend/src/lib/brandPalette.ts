// Farb-Palette einer Marke – Live-Rechnung für Editor und Vorschau.
// Reihenfolge, Beschriftungen und Standardwerte liefert das Backend über
// GET /api/brands/palette; hier steht nur die Ableitungs-Mathematik, damit die
// Oberfläche schon beim Ziehen am Farbwähler die abgeleiteten Farben zeigt.
// Gegenstück (maßgeblich beim Versand): BRAND_PALETTE in src/db.js.
import type { PaletteField, PaletteMeta } from './types';

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function isColor(v: string) {
  return HEX.test(String(v ?? '').trim());
}

function rgbOf(c: string): [number, number, number] | null {
  let h = String(c ?? '').trim();
  if (!HEX.test(h)) return null;
  h = h.slice(1);
  if (h.length <= 4) h = h.split('').map(x => x + x).join('');
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

const hexOf = (p: number[]) =>
  '#' + p.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

// t = 0 → a, t = 1 → b
export function mix(a: string, b: string, t: number) {
  const x = rgbOf(a), y = rgbOf(b);
  if (!x || !y) return a;
  return hexOf(x.map((v, i) => v + (y[i] - v) * t));
}

// t > 0 heller (Richtung Weiß), t < 0 dunkler (Richtung Schwarz)
const shade = (c: string, t: number) => mix(c, t > 0 ? '#ffffff' : '#000000', Math.abs(t));

// Farbton drehen – verwandte, aber klar unterscheidbare Akzentfarbe.
function rotate(c: string, deg: number) {
  const p = rgbOf(c);
  if (!p) return c;
  const [r, g, b] = p.map(v => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  h = (((h * 60 + deg) % 360) + 360) % 360;
  const cc = (1 - Math.abs(2 * l - 1)) * s, xx = cc * (1 - Math.abs((h / 60) % 2 - 1)), m = l - cc / 2;
  const seg = [[cc, xx, 0], [xx, cc, 0], [0, cc, xx], [0, xx, cc], [xx, 0, cc], [cc, 0, xx]][Math.floor(h / 60) % 6];
  return hexOf(seg.map(v => (v + m) * 255));
}

// Lesbare Schriftfarbe auf einer Fläche (WCAG-Relativhelligkeit). Schwelle wie
// in src/db.js: kräftige Markenfarben behalten weiße Schrift, helle Töne dunkle.
export function readableOn(c: string) {
  const p = rgbOf(c);
  if (!p) return '#ffffff';
  const [r, g, b] = p.map(v => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.35 ? '#0f172a' : '#ffffff';
}

type Derive = (p: Record<string, string>) => string;
const DERIVE: Record<string, Derive> = {
  brand_color: () => '#4f8cff',
  brand_color_2: p => shade(p.brand_color, -0.3),
  brand_accent: p => rotate(p.brand_color, 42),
  brand_bg: () => '#f4f5f7',
  brand_surface: () => '#ffffff',
  brand_text: () => '#0f172a',
  brand_muted: p => mix(p.brand_text, p.brand_surface, 0.48),
  brand_border: p => mix(p.brand_text, p.brand_surface, 0.88),
  brand_on_color: p => readableOn(p.brand_color),
  brand_on_color_2: p => readableOn(p.brand_color_2),
  brand_on_accent: p => readableOn(p.brand_accent),
  brand_soft: p => mix(p.brand_color, p.brand_surface, 0.88),
  brand_gradient: p => `linear-gradient(135deg, ${p.brand_color}, ${p.brand_color_2})`,
};

// Aufbau der Palette wie im Backend. Dient als Startwert und als Rückfall,
// falls GET /api/brands/palette (noch) nicht antwortet – der Farbeditor bleibt
// dadurch auch gegen eine ältere Server-Version bedienbar.
export const DEFAULT_PALETTE_META: PaletteMeta = {
  fields: [
    { key: 'brand_color', label: 'Primärfarbe', hint: 'Header, Buttons, Links', derived: false },
    { key: 'brand_color_2', label: 'Sekundärfarbe', hint: 'Zweite Fläche, Ende des Verlaufs', derived: false },
    { key: 'brand_accent', label: 'Akzentfarbe', hint: 'Badges, Hervorhebungen, Zahlen', derived: false },
    { key: 'brand_bg', label: 'Seitenhintergrund', hint: 'Fläche hinter der Mail', derived: false },
    { key: 'brand_surface', label: 'Inhaltsfläche', hint: 'Das „Papier“ der Mail', derived: false },
    { key: 'brand_text', label: 'Textfarbe', hint: 'Fließtext und Überschriften', derived: false },
    { key: 'brand_muted', label: 'Sekundärtext', hint: 'Footer, Hinweise, Labels', derived: false },
    { key: 'brand_border', label: 'Rahmenfarbe', hint: 'Linien und Trenner', derived: false },
  ],
  derived: [
    { key: 'brand_on_color', label: 'Text auf Primär', derived: true },
    { key: 'brand_on_color_2', label: 'Text auf Sekundär', derived: true },
    { key: 'brand_on_accent', label: 'Text auf Akzent', derived: true },
    { key: 'brand_soft', label: 'Primär, sehr hell', derived: true },
    { key: 'brand_gradient', label: 'Verlauf Primär → Sekundär', derived: true },
  ],
  defaults: {},
};

/** Gehört der Schlüssel zur Farb-Palette? (für Gruppierung in Variablen-Listen) */
export const isPaletteKey = (key: string) => key in DERIVE;

/** Dreifarbiger Verlauf (Primär/Sekundär/Akzent) als Mini-Vorschau einer Marke. */
export function brandSwatch(b: { vars?: Record<string, string>; palette?: Record<string, string> }) {
  const p = b.palette && Object.keys(b.palette).length ? b.palette : (b.vars ?? {});
  const primary = p.brand_color || '#4f8cff';
  const secondary = p.brand_color_2 || DERIVE.brand_color_2({ brand_color: primary });
  const accent = p.brand_accent || DERIVE.brand_accent({ brand_color: primary });
  return `linear-gradient(135deg, ${primary} 0 42%, ${secondary} 42% 71%, ${accent} 71% 100%)`;
}

export const allPaletteFields = (meta: PaletteMeta | null): PaletteField[] =>
  meta ? [...meta.fields, ...meta.derived] : [];

export const paletteKeys = (meta: PaletteMeta | null) => allPaletteFields(meta).map(f => f.key);

// Vollständige Palette: gesetzte Werte gewinnen, der Rest wird abgeleitet.
// Slots, für die es hier keine Regel gibt, fallen auf den Server-Standard zurück.
export function resolvePalette(vars: Record<string, string>, meta: PaletteMeta | null) {
  const out: Record<string, string> = {};
  for (const f of allPaletteFields(meta)) {
    const own = String(vars[f.key] ?? '').trim();
    // Halb getippte Hex-Werte („#1a“) gelten als leer – sonst flackert die
    // Vorschau beim Tippen auf eine ungültige Farbe.
    const usable = own && !(own.startsWith('#') && !HEX.test(own));
    out[f.key] = usable ? own : (DERIVE[f.key]?.(out) || meta?.defaults[f.key] || '');
  }
  return out;
}
