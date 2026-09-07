/**
 * MCP-Werkzeuge für Kontakt-Kontext, Schreibstile und Vermeiden-Regeln.
 *
 * Eigene Datei, damit mcp-tools.js nicht weiter wächst. Wird aus
 * createMcpServer() heraus registriert und bekommt dessen Helfer mit –
 * so gelten Richtlinie (MCP_READONLY) und Antwortformat unverändert.
 *
 * Fehlerstil hier: werfen. Ein nicht gefundener Kontakt ist ein Aufruffehler,
 * kein Ergebnis, und der Client soll das als Fehler sehen.
 */
import { z } from 'zod';
import * as db from './db.js';
import * as ctx from './ai-context.js';

export function registerContextTools({ tool, ok, UI }) {
  /** Kontakt über id oder E-Mail auflösen. */
  const findContact = (contact_id, email) => {
    const c = contact_id ? db.getContactById(contact_id) : (email ? db.getContactByEmail(email) : null);
    if (!c) throw new Error('Kontakt nicht gefunden – contact_id oder email angeben (siehe list_contacts).');
    return c;
  };

  // ---- Das eine Werkzeug, das vor jedem Schreiben dran ist -----------------
  tool(
    'get_writing_briefing',
    'VOR dem Verfassen einer Mail oder WhatsApp-Nachricht aufrufen. Liefert in einem Zug: '
    + 'was über den Kontakt bekannt ist, welcher Schreibstil gilt, was zu vermeiden ist – '
    + 'und unter "missing", welche Pflichtangaben für diesen Zweck fehlen. '
    + 'Steht dort etwas, stelle dem Nutzer die genannten Fragen und trage die Antworten '
    + 'mit set_contact_fact nach, bevor du schreibst.',
    {
      contact_id: z.number().int().optional(),
      email: z.string().optional().describe('Alternativ zum contact_id'),
      purpose: z.string().optional().describe('Zweck, z.B. "kundenmail", "bewerbung", "whatsapp" – siehe list_purposes'),
    },
    async ({ contact_id, email, purpose }) => {
      const c = findContact(contact_id, email);
      const b = ctx.briefingFor(c.id, purpose || null);
      return ok({
        ...b,
        hint: b.missing.length
          ? 'Es fehlen Angaben. Frage den Nutzer und trage die Antworten mit set_contact_fact nach.'
          : undefined,
        open_in_ui: `${UI}/contacts`,
      });
    },
  );

  // ---- Kontakt-Kontext ----------------------------------------------------
  tool(
    'get_contact_context',
    'Bekannte Fakten und Notizen zu einem Kontakt – ohne Stil und Regeln. '
    + 'Für den vollen Überblick vor dem Schreiben ist get_writing_briefing das richtige Werkzeug.',
    { contact_id: z.number().int().optional(), email: z.string().optional() },
    async ({ contact_id, email }) => {
      const c = findContact(contact_id, email);
      return ok({
        contact: { id: c.id, name: c.name, email: c.email, company: c.company },
        facts: ctx.listContactFacts(c.id),
        notes: ctx.getContactNotes(c.id),
        style_id: c.style_id ?? null,
        open_in_ui: `${UI}/contacts`,
      });
    },
  );

  tool(
    'set_contact_fact',
    'Trägt einen einzelnen Fakt zu einem Kontakt ein oder aktualisiert ihn – z.B. anrede=Du, '
    + 'rolle=Geschäftsführer. Gib bei source an, woher die Angabe stammt ("Mail vom 19.08.", '
    + '"vom Nutzer bestätigt"); bei Unsicherheit confidence auf "vermutet" setzen, damit später '
    + 'erkennbar ist, was geraten war.',
    {
      contact_id: z.number().int().optional(),
      email: z.string().optional(),
      key: z.string().describe('Kurzer Schlüssel, klein geschrieben, z.B. "anrede"'),
      value: z.string(),
      source: z.string().optional(),
      confidence: z.enum(['sicher', 'vermutet']).optional().default('sicher'),
    },
    async ({ contact_id, email, key, value, source, confidence }) => {
      const c = findContact(contact_id, email);
      return ok(ctx.setContactFact(c.id, key, value, { source, confidence }));
    },
  );

  tool(
    'delete_contact_fact',
    'Entfernt einen Fakt – etwa wenn er sich als falsch herausgestellt hat.',
    { contact_id: z.number().int().optional(), email: z.string().optional(), key: z.string() },
    async ({ contact_id, email, key }) => {
      const c = findContact(contact_id, email);
      return ok({ deleted: ctx.deleteContactFact(c.id, key) });
    },
  );

  tool(
    'set_contact_notes',
    'Setzt den Freitext zu einem Kontakt – für alles, was sich nicht als Fakt fassen lässt. '
    + 'ACHTUNG: ersetzt den bisherigen Text vollständig. Vorher get_contact_context lesen und '
    + 'den alten Inhalt mit übernehmen, sonst geht er verloren.',
    { contact_id: z.number().int().optional(), email: z.string().optional(), notes: z.string() },
    async ({ contact_id, email, notes }) => {
      const c = findContact(contact_id, email);
      return ok({ contact_id: c.id, notes: ctx.setContactNotes(c.id, notes) });
    },
  );

  tool(
    'check_contact_context',
    'Prüft, welche Pflichtangaben einem Kontakt für einen Zweck fehlen. Liefert je Lücke eine '
    + 'fertige Frage an den Nutzer.',
    {
      contact_id: z.number().int().optional(),
      email: z.string().optional(),
      purpose: z.string().describe('z.B. "kundenmail" – siehe list_purposes'),
    },
    async ({ contact_id, email, purpose }) => {
      const c = findContact(contact_id, email);
      const missing = ctx.missingFor(c.id, purpose);
      return ok({
        contact: { id: c.id, name: c.name, email: c.email },
        purpose, complete: missing.length === 0, missing,
        hint: missing.length ? 'Frage den Nutzer und trage die Antworten mit set_contact_fact nach.' : undefined,
      });
    },
  );

  // ---- Zwecke und Pflichtangaben -----------------------------------------
  tool(
    'list_purposes',
    'Bekannte Zwecke (kundenmail, bewerbung, whatsapp …) mit der Zahl ihrer Pflichtangaben.',
    {},
    async () => ok(ctx.listPurposes()),
  );

  tool(
    'list_context_requirements',
    'Welche Angaben ein Kontakt je Zweck braucht.',
    { purpose: z.string().optional() },
    async ({ purpose }) => ok(ctx.listRequirements(purpose ?? null)),
  );

  tool(
    'set_context_requirement',
    'Legt fest, dass ein Zweck eine bestimmte Angabe braucht – inklusive der Frage, die dem '
    + 'Nutzer dazu gestellt wird.',
    {
      purpose: z.string(),
      key: z.string(),
      label: z.string(),
      question: z.string().describe('Wörtlich die Frage an den Nutzer, z.B. "Duzt oder siezt ihr euch?"'),
      required: z.boolean().optional().default(true),
      sort: z.number().int().optional().default(0),
    },
    async (a) => ok(ctx.upsertRequirement({ ...a, required: a.required ? 1 : 0 })),
  );

  tool(
    'delete_context_requirement',
    'Entfernt eine Pflichtangabe (id aus list_context_requirements).',
    { id: z.number().int() },
    async ({ id }) => ok({ deleted: ctx.deleteRequirement(id) }),
  );

  // ---- Schreibstile -------------------------------------------------------
  tool(
    'list_writing_styles',
    'Angelegte Schreibstile. Mit purpose gefiltert auf die, die für diesen Zweck in Frage kommen.',
    { purpose: z.string().optional() },
    async ({ purpose }) => ok(ctx.listWritingStyles(purpose ?? null)),
  );

  tool(
    'set_writing_style',
    'Legt einen Schreibstil an oder ändert ihn. guidance sind die eigentlichen Anweisungen, '
    + 'sample eine Textprobe – die wirkt meist stärker als jede Regelbeschreibung. '
    + 'Ohne id wird neu angelegt.',
    {
      id: z.number().int().optional(),
      name: z.string().optional(),
      purpose: z.string().optional().describe('Zweck; weglassen = für alle Zwecke brauchbar'),
      description: z.string().optional(),
      guidance: z.string().optional().describe('Wie geschrieben werden soll'),
      sample: z.string().optional().describe('Beispieltext in diesem Stil'),
      salutation: z.string().optional().describe('z.B. "Hallo {{name}},"'),
      signoff: z.string().optional().describe('z.B. "Viele Grüße"'),
      is_default: z.boolean().optional().describe('Standard für diesen Zweck'),
    },
    async (a) => {
      const s = ctx.upsertWritingStyle(a);
      if (!s) throw new Error(`Kein Schreibstil mit der ID ${a.id}`);
      return ok({ ...s, open_in_ui: `${UI}/settings` });
    },
  );

  tool(
    'delete_writing_style',
    'Löscht einen Schreibstil. Kontakte, die ihn fest hatten, fallen auf den Zweck-Standard zurück.',
    { id: z.number().int() },
    async ({ id }) => ok({ deleted: ctx.deleteWritingStyle(id) }),
  );

  tool(
    'set_contact_style',
    'Nagelt einen Schreibstil an einem Kontakt fest – der gewinnt dann gegen jede Zweck-Zuordnung. '
    + 'style_id weglassen hebt die Festlegung wieder auf.',
    {
      contact_id: z.number().int().optional(),
      email: z.string().optional(),
      style_id: z.number().int().optional(),
    },
    async ({ contact_id, email, style_id }) => {
      const c = findContact(contact_id, email);
      if (style_id && !ctx.getWritingStyle(style_id)) throw new Error(`Kein Schreibstil mit der ID ${style_id}`);
      return ok(ctx.setContactStyle(c.id, style_id ?? null));
    },
  );

  // ---- Vermeiden-Regeln ---------------------------------------------------
  tool(
    'list_avoid_rules',
    'Regeln, was zu vermeiden (kind="vermeiden") und was immer zu tun ist (kind="immer"). '
    + 'Ohne scope kommen alle Ebenen: global, je Schreibstil, je Kontakt.',
    {
      scope: z.enum(['global', 'style', 'contact']).optional(),
      ref_id: z.number().int().optional().describe('Bei scope=style die Stil-ID, bei scope=contact die Kontakt-ID'),
    },
    async ({ scope, ref_id }) => ok(ctx.listAvoidRules({ scope: scope ?? null, refId: ref_id ?? null })),
  );

  tool(
    'add_avoid_rule',
    'Fügt eine Regel hinzu. scope="global" gilt immer, "style" nur für einen Schreibstil, '
    + '"contact" nur für einen Kontakt. Mit reason kurz begründen – das hilft beim Abwägen, '
    + 'wenn zwei Regeln sich widersprechen.',
    {
      scope: z.enum(['global', 'style', 'contact']).optional().default('global'),
      ref_id: z.number().int().optional(),
      rule: z.string().describe('z.B. „Keine Floskel: Ich hoffe, es geht Ihnen gut“'),
      reason: z.string().optional(),
      kind: z.enum(['vermeiden', 'immer']).optional().default('vermeiden'),
    },
    async (a) => {
      if (a.scope !== 'global' && !a.ref_id) throw new Error('Bei scope "style" oder "contact" wird ref_id gebraucht');
      return ok(ctx.addAvoidRule(a));
    },
  );

  tool(
    'delete_avoid_rule',
    'Löscht eine Regel (id aus list_avoid_rules).',
    { id: z.number().int() },
    async ({ id }) => ok({ deleted: ctx.deleteAvoidRule(id) }),
  );
}
