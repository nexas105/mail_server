// Sanitizer für gespeichertes E-Mail-HTML (Vorlagen, Entwürfe, Snippets), bevor es
// in den WYSIWYG-Editor gelangt.
//
// Warum: Der TinyMCE-Editor rendert den Inhalt in einem same-origin-iframe ohne
// sandbox – alles, was dort als Script läuft, hat die Sitzung des angemeldeten
// Nutzers (Cookies, /api/…). Das Editor-Schema ist absichtlich offen
// (valid_elements '*[*]'), damit E-Mail-Markup (Tabellen, Inline-Styles,
// {{variablen}}, Conditional Comments) unangetastet bleibt. Gespeichertes HTML
// kann aber von jedem Nutzer bzw. jedem schreibenden MCP-Client stammen; ein
// `<img onerror=…>` in einer Vorlage würde beim Öffnen durch einen Admin mit
// dessen Rechten ausgeführt (Stored XSS). Die Vorschau-iframes sind sandboxed,
// der Editor nicht – deshalb wird hier vorher ohne externe Abhängigkeit per
// DOMParser aufgeräumt. TinyMCE selbst (xss_sanitization/DOMPurify,
// invalid_elements) ist die zweite Linie.
//
// Wichtig: Wird nichts Gefährliches gefunden, kommt der Eingabestring
// unverändert zurück. Der React-Wrapper von TinyMCE vergleicht den value-Prop
// per `!==` mit dem Editorinhalt und ruft bei Abweichung setContent auf – eine
// Re-Serialisierung bei jedem Tastendruck würde Cursor-Sprünge erzeugen und
// zudem Nutzer-Markup (Attribut-Quoting, Whitespace) ungefragt umschreiben.

// Elemente, die komplett (inkl. Inhalt) entfernt werden.
// Nicht dabei: form (in Mails üblich, ohne Script harmlos), style/head
// (E-Mail-HTML braucht <style>), meta ohne http-equiv (charset/viewport sind inert).
const REMOVE_ELEMENTS = 'script,iframe,frame,frameset,object,embed,applet,svg,math,base,link,template,noscript';

// Attribute, die unabhängig vom Wert entfernt werden (zusätzlich zu on*).
const REMOVE_ATTRS = new Set(['srcdoc', 'formaction', 'xlink:href', 'ping']);

// Attribute, deren Wert eine URL ist und auf gefährliche Schemata geprüft wird.
const URL_ATTRS = new Set(['href', 'src', 'action', 'background', 'poster', 'cite', 'data']);

const SAFE_DATA_IMAGE = /^data:image\/(png|jpeg|jpg|gif|webp)[;,]/;

const CSS_PATTERNS: RegExp[] = [
  /expression\s*\(/gi,
  /url\s*\(\s*(['"]?)\s*(javascript|vbscript):/gi,
  /@import\b[^;]*;?/gi,
];

function normalizeUrl(value: string): string {
  // Steuerzeichen und Whitespace entfernen (Browser ignorieren sie beim
  // Parsen des Schemas: "java\nscript:" oder "\tjavascript:" laufen trotzdem).
  return value.replace(/[\u0000-\u0020\u007f-\u009f]+/g, '').toLowerCase();
}

function isDangerousUrl(attr: string, value: string): boolean {
  const v = normalizeUrl(value);
  if (v.startsWith('javascript:') || v.startsWith('vbscript:')) return true;
  if (v.startsWith('data:')) {
    // Inline-Bilder in Mails erlauben, SVG (kann Script enthalten) nicht.
    return !(attr === 'src' && SAFE_DATA_IMAGE.test(v));
  }
  return false;
}

function cleanCss(css: string): { out: string; changed: boolean } {
  let out = css;
  for (const re of CSS_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, '');
  }
  return { out, changed: out !== css };
}

export function sanitizeEmailHtml(html: string): string {
  if (!html || typeof DOMParser === 'undefined') return html;

  const isDocument = /<!doctype\b|<html[\s>]/i.test(html);
  // Fragmente explizit in <body> einbetten, sonst würde der Parser ein
  // führendes <style> in den <head> verschieben und es ginge beim
  // body.innerHTML-Rückweg verloren.
  const source = isDocument ? html : `<!DOCTYPE html><html><head></head><body>${html}</body></html>`;
  const doc = new DOMParser().parseFromString(source, 'text/html');
  let changed = false;

  // 1) Gefährliche Elemente samt Inhalt entfernen.
  doc.querySelectorAll(REMOVE_ELEMENTS).forEach(el => { el.remove(); changed = true; });
  doc.querySelectorAll('meta[http-equiv]').forEach(el => { el.remove(); changed = true; });

  // 2) Attribute prüfen.
  doc.querySelectorAll('*').forEach(el => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || REMOVE_ATTRS.has(name)) {
        el.removeAttribute(attr.name);
        changed = true;
      } else if (URL_ATTRS.has(name) && isDangerousUrl(name, attr.value)) {
        el.removeAttribute(attr.name);
        changed = true;
      } else if (name === 'style') {
        const r = cleanCss(attr.value);
        if (r.changed) { el.setAttribute(attr.name, r.out); changed = true; }
      }
    }
  });

  // 3) <style>-Inhalte.
  doc.querySelectorAll('style').forEach(el => {
    const r = cleanCss(el.textContent ?? '');
    if (r.changed) { el.textContent = r.out; changed = true; }
  });

  if (!changed) return html;

  if (isDocument) {
    const doctype = doc.doctype ? new XMLSerializer().serializeToString(doc.doctype) + '\n' : '';
    return doctype + doc.documentElement.outerHTML;
  }
  return doc.body.innerHTML;
}
