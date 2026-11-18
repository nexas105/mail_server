// Werkzeug-Sets: welcher Client sieht welche Werkzeuge.
//
// Warum: Jedes registrierte Werkzeug landet mit Name, Beschreibung und Schema
// im Kontext des KI-Clients – bei über hundert Werkzeugen sind das zigtausend
// Token, bevor überhaupt etwas passiert ist. Wer nur WhatsApp lesen will,
// braucht keine Marken, SMTP-Konten und GitHub-Repos.
//
// Auswahl:
//   HTTP   /mcp            → alle Sets (wie bisher)
//          /mcp/mail      → nur Mail (+ Schreib-Briefing)
//          /mcp/whatsapp  → nur WhatsApp (+ Schreib-Briefing)
//          /mcp/brain     → nur Brain (Markdown-Notizen)
//          /mcp/contacts, /mcp/design, /mcp/github, /mcp/admin
//          /mcp/mail+contacts → mehrere Sets mit „+" (oder „,") verbinden
//   stdio  --toolset=mail  oder  MCP_TOOLSETS=whatsapp,contacts
//
// Ein Werkzeug kann in mehreren Sets stecken (get_writing_briefing gehört
// zu Mail UND WhatsApp, weil man vor jedem Schreiben den Kontext braucht).

export const TOOLSETS = {
  mail: 'E-Mail: Posteingang lesen/suchen/sortieren, Entwürfe, Antworten, Anhänge, Versand',
  whatsapp: 'WhatsApp: Chats, Nachrichten, Senden, Planen, Sprachnachrichten',
  contacts: 'Adressbuch, Listen, Kontakt-Kontext, Schreibstile, Regeln',
  github: 'GitHub-Repos, die an Kontakten hängen',
  design: 'Newsletter-Gestaltung: Vorlagen, Marken, Platzhalter-Felder, Bilder',
  admin: 'Konten (SMTP/IMAP), Einstellungen, Tracking',
  brain: 'Brain: Markdown-Wissen, allgemein und je Projekt – lesen, schreiben, suchen',
};

const DESIGN = new Set([
  'get_template', 'create_template', 'update_template', 'delete_template',
  'list_custom_fields', 'set_custom_field', 'delete_custom_field',
  'list_brands', 'set_brand', 'apply_brand_to_draft', 'set_default_brand', 'delete_brand',
  'list_assets', 'add_asset', 'delete_asset',
]);

// Werkzeuge, die jeder Kanal zum Schreiben braucht – stecken in mail und whatsapp.
const WRITING_CORE = new Set([
  'get_writing_briefing', 'get_contact_context', 'set_contact_fact', 'check_contact_context',
]);

const ADMIN = new Set([
  'list_smtp_accounts', 'create_smtp_account', 'update_smtp_account', 'delete_smtp_account',
  'duplicate_smtp_account', 'verify_smtp_account', 'verify_imap_account',
  'get_settings', 'set_default_account', 'set_tracking',
]);

const CONTACTS = new Set([
  'list_contacts', 'add_contact', 'update_contact', 'import_contacts', 'delete_contact',
  'list_lists', 'create_list', 'delete_list', 'add_contact_to_list', 'remove_contact_from_list',
  'import_contacts_to_list', 'sync_carddav_contacts',
  'set_contact_notes', 'delete_contact_fact', 'set_contact_style',
  'list_purposes', 'list_context_requirements', 'set_context_requirement', 'delete_context_requirement',
  'list_writing_styles', 'set_writing_style', 'delete_writing_style',
  'list_avoid_rules', 'add_avoid_rule', 'delete_avoid_rule',
]);

/** In welchen Sets steckt ein Werkzeug? */
export function toolsetsOf(name) {
  if (name.includes('brain')) return ['brain'];
  if (WRITING_CORE.has(name)) return ['mail', 'whatsapp', 'contacts'];
  if (/(^|_)wa(_|$)/.test(name)) return ['whatsapp'];
  if (name.includes('repo')) return ['github'];
  if (ADMIN.has(name)) return ['admin'];
  if (CONTACTS.has(name)) return ['contacts'];
  if (DESIGN.has(name)) return ['design'];
  // Mail ist der Rest: Entwürfe, Empfänger, Vorlagen, Marken, Assets, Posteingang …
  // Kontoliste braucht der Mail-Client trotzdem, um eine account_id zu wählen.
  return ['mail'];
}

// Lesende Konto-Infos braucht man beim Schreiben einer Mail – zusätzlich in mail.
const ALSO_IN_MAIL = new Set(['list_smtp_accounts', 'list_contacts', 'list_lists']);
// Datei-Upload brauchen Mail (Anhänge) und Brain (Ablage).
const ALSO_IN_BRAIN = new Set(['create_upload']);

/**
 * Liest eine Set-Angabe („mail", „mail+contacts", „all", leer) und gibt
 * null (= alle) oder ein Set gültiger Namen zurück. Unbekanntes wirft.
 */
export function parseToolsets(spec) {
  const raw = String(spec || '').toLowerCase().split(/[+,\s]+/).map(s => s.trim()).filter(Boolean);
  if (!raw.length || raw.includes('all')) return null;
  const alias = { wa: 'whatsapp', email: 'mail', kontakte: 'contacts', gh: 'github', vorlagen: 'design', templates: 'design', notizen: 'brain', wissen: 'brain' };
  const out = new Set();
  for (const r of raw) {
    const n = alias[r] || r;
    if (!TOOLSETS[n]) throw new Error(`Unbekanntes Werkzeug-Set "${r}" – erlaubt: ${Object.keys(TOOLSETS).join(', ')}, all`);
    out.add(n);
  }
  return out;
}

/** Gehört das Werkzeug zur gewählten Auswahl? null = alle. */
export function inToolsets(name, selected) {
  if (!selected) return true;
  if (selected.has('mail') && ALSO_IN_MAIL.has(name)) return true;
  if (selected.has('brain') && ALSO_IN_BRAIN.has(name)) return true;
  return toolsetsOf(name).some(s => selected.has(s));
}
