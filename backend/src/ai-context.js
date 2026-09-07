/**
 * Wissen für die KI: Kontakt-Kontext, Schreibstile und Vermeiden-Regeln.
 *
 * Eigene Datei mit eigenen Tabellen, damit db.js nicht weiter wächst. Der
 * Datenbank-Griff kommt von dort, alles andere lebt hier. Konventionen wie
 * im Rest des Projekts: benannte Exporte, camelCase, deutsche Kommentare,
 * CREATE TABLE IF NOT EXISTS beim Laden.
 */
import { db } from './db.js';

db.exec(`
-- Einzelne Fakten zu einem Kontakt. Bewusst je Fakt eine Zeile statt eines
-- Textblocks: so kann die KI gezielt einen Wert nachtragen, ohne den Rest
-- neu zu schreiben, und "woher weiß ich das" bleibt nachvollziehbar.
CREATE TABLE IF NOT EXISTS contact_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  key TEXT NOT NULL,               -- rolle | anrede | projekt | …
  value TEXT NOT NULL,
  source TEXT,                     -- "Mail vom 19.08.", "manuell", "WhatsApp"
  confidence TEXT NOT NULL DEFAULT 'sicher',   -- sicher | vermutet
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(contact_id, key)
);
CREATE INDEX IF NOT EXISTS idx_contact_facts_contact ON contact_facts(contact_id);

-- Freitext daneben: alles, was sich nicht in ein Schlüssel-Wert-Paar pressen lässt.
CREATE TABLE IF NOT EXISTS contact_notes (
  contact_id INTEGER PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  notes TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Welche Angaben braucht ein Kontakt für welchen Zweck? Grundlage dafür,
-- dass die KI von sich aus nach Fehlendem fragt.
CREATE TABLE IF NOT EXISTS context_requirements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purpose TEXT NOT NULL,           -- kundenmail | bewerbung | whatsapp | …
  key TEXT NOT NULL,
  label TEXT NOT NULL,             -- "Anrede"
  question TEXT NOT NULL,          -- "Duzt oder siezt ihr euch?"
  required INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(purpose, key)
);

-- Schreibstile, je einem Zweck zugeordnet.
CREATE TABLE IF NOT EXISTS writing_styles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  purpose TEXT,                    -- NULL = für jeden Zweck brauchbar
  description TEXT,                -- wofür der Stil gedacht ist
  guidance TEXT,                   -- die eigentlichen Anweisungen
  sample TEXT,                     -- Textprobe, sagt mehr als jede Regel
  salutation TEXT,                 -- "Hallo {{name}}," …
  signoff TEXT,                    -- "Viele Grüße"
  is_default INTEGER NOT NULL DEFAULT 0,   -- Standard für diesen Zweck
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Was die KI vermeiden soll. scope entscheidet, wo die Regel greift:
--   global      – immer
--   style       – nur bei diesem Stil   (ref_id = writing_styles.id)
--   contact     – nur bei diesem Kontakt (ref_id = contacts.id)
CREATE TABLE IF NOT EXISTS avoid_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'global',
  ref_id INTEGER,
  rule TEXT NOT NULL,
  reason TEXT,                     -- warum – hilft der KI beim Abwägen
  kind TEXT NOT NULL DEFAULT 'vermeiden',   -- vermeiden | immer
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_avoid_scope ON avoid_rules(scope, ref_id);
`);

// Fester Stil je Kontakt – gewinnt gegen die Zweck-Zuordnung.
for (const [table, col, def] of [
  ['contacts', 'style_id', 'INTEGER REFERENCES writing_styles(id) ON DELETE SET NULL'],
]) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
  catch { /* Spalte existiert schon */ }
}

/* ------------------------------------------------------------------ Fakten */

export function listContactFacts(contactId) {
  return db.prepare(
    'SELECT * FROM contact_facts WHERE contact_id=? ORDER BY key').all(contactId);
}
/** Legt einen Fakt an oder aktualisiert ihn. Der Schlüssel wird normalisiert. */
export function setContactFact(contactId, key, value, { source = null, confidence = 'sicher' } = {}) {
  const k = String(key).trim().toLowerCase().replace(/[^\w.]/g, '_');
  if (!k) throw new Error('Schlüssel darf nicht leer sein');
  db.prepare(
    `INSERT INTO contact_facts (contact_id, key, value, source, confidence)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(contact_id, key) DO UPDATE SET
       value=excluded.value, source=excluded.source,
       confidence=excluded.confidence, updated_at=datetime('now')`)
    .run(contactId, k, String(value), source, confidence === 'vermutet' ? 'vermutet' : 'sicher');
  return db.prepare('SELECT * FROM contact_facts WHERE contact_id=? AND key=?').get(contactId, k);
}
export function deleteContactFact(contactId, key) {
  return db.prepare('DELETE FROM contact_facts WHERE contact_id=? AND key=?')
    .run(contactId, String(key).trim().toLowerCase()).changes > 0;
}

export function getContactNotes(contactId) {
  return db.prepare('SELECT notes, updated_at FROM contact_notes WHERE contact_id=?').get(contactId)?.notes || '';
}
export function setContactNotes(contactId, notes) {
  db.prepare(
    `INSERT INTO contact_notes (contact_id, notes) VALUES (?, ?)
     ON CONFLICT(contact_id) DO UPDATE SET notes=excluded.notes, updated_at=datetime('now')`)
    .run(contactId, String(notes ?? ''));
  return getContactNotes(contactId);
}

/* ------------------------------------------------------- Pflichtangaben */

export function listRequirements(purpose = null) {
  return purpose
    ? db.prepare('SELECT * FROM context_requirements WHERE purpose=? ORDER BY sort, id').all(purpose)
    : db.prepare('SELECT * FROM context_requirements ORDER BY purpose, sort, id').all();
}
export function upsertRequirement(r = {}) {
  db.prepare(
    `INSERT INTO context_requirements (purpose, key, label, question, required, sort)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(purpose, key) DO UPDATE SET
       label=excluded.label, question=excluded.question,
       required=excluded.required, sort=excluded.sort`)
    .run(r.purpose, String(r.key).trim().toLowerCase(), r.label || r.key,
      r.question || `Was gilt für „${r.label || r.key}“?`,
      r.required === 0 ? 0 : 1, Number(r.sort) || 0);
  return db.prepare('SELECT * FROM context_requirements WHERE purpose=? AND key=?')
    .get(r.purpose, String(r.key).trim().toLowerCase());
}
export function deleteRequirement(id) {
  return db.prepare('DELETE FROM context_requirements WHERE id=?').run(id).changes > 0;
}

/** Welche Zwecke gibt es überhaupt? Aus Anforderungen und Stilen zusammengesucht. */
export function listPurposes() {
  return db.prepare(
    `SELECT purpose, COUNT(*) AS requirements FROM context_requirements GROUP BY purpose
     UNION
     SELECT purpose, 0 FROM writing_styles WHERE purpose IS NOT NULL
       AND purpose NOT IN (SELECT purpose FROM context_requirements)
     ORDER BY purpose`).all();
}

/* ------------------------------------------------------------- Schreibstile */

export function listWritingStyles(purpose = null) {
  return purpose
    ? db.prepare('SELECT * FROM writing_styles WHERE purpose=? OR purpose IS NULL ORDER BY is_default DESC, name').all(purpose)
    : db.prepare('SELECT * FROM writing_styles ORDER BY purpose, is_default DESC, name').all();
}
export function getWritingStyle(id) {
  return db.prepare('SELECT * FROM writing_styles WHERE id=?').get(id);
}
export function upsertWritingStyle(s = {}) {
  if (s.id) {
    const cur = getWritingStyle(s.id);
    if (!cur) return null;
    db.prepare(
      `UPDATE writing_styles SET name=?, purpose=?, description=?, guidance=?, sample=?,
         salutation=?, signoff=? WHERE id=?`)
      .run(s.name ?? cur.name, s.purpose !== undefined ? s.purpose : cur.purpose,
        s.description ?? cur.description, s.guidance ?? cur.guidance, s.sample ?? cur.sample,
        s.salutation ?? cur.salutation, s.signoff ?? cur.signoff, s.id);
    if (s.is_default) setDefaultStyle(s.id);
    return getWritingStyle(s.id);
  }
  const r = db.prepare(
    `INSERT INTO writing_styles (name, purpose, description, guidance, sample, salutation, signoff)
     VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(String(s.name || 'Stil'), s.purpose || null, s.description || null,
      s.guidance || null, s.sample || null, s.salutation || null, s.signoff || null);
  if (s.is_default) setDefaultStyle(r.lastInsertRowid);
  return getWritingStyle(r.lastInsertRowid);
}
/** Standard je Zweck – zwei Stile desselben Zwecks können nicht beide Standard sein. */
export function setDefaultStyle(id) {
  const st = getWritingStyle(id);
  if (!st) return null;
  db.prepare('UPDATE writing_styles SET is_default = CASE WHEN id=? THEN 1 ELSE 0 END WHERE purpose IS ?')
    .run(id, st.purpose);
  return getWritingStyle(id);
}
export function deleteWritingStyle(id) {
  return db.prepare('DELETE FROM writing_styles WHERE id=?').run(id).changes > 0;
}
/** Stil eines Kontakts festnageln (null hebt auf). */
export function setContactStyle(contactId, styleId) {
  db.prepare('UPDATE contacts SET style_id=? WHERE id=?').run(styleId ?? null, contactId);
  return db.prepare('SELECT id, email, style_id FROM contacts WHERE id=?').get(contactId);
}

/* --------------------------------------------------------- Vermeiden-Regeln */

export function listAvoidRules({ scope = null, refId = null } = {}) {
  if (!scope) return db.prepare('SELECT * FROM avoid_rules ORDER BY scope, id').all();
  return refId == null
    ? db.prepare('SELECT * FROM avoid_rules WHERE scope=? ORDER BY id').all(scope)
    : db.prepare('SELECT * FROM avoid_rules WHERE scope=? AND ref_id=? ORDER BY id').all(scope, refId);
}
export function addAvoidRule({ scope = 'global', ref_id = null, rule, reason = null, kind = 'vermeiden' }) {
  if (!rule || !String(rule).trim()) throw new Error('Regel darf nicht leer sein');
  const r = db.prepare(
    'INSERT INTO avoid_rules (scope, ref_id, rule, reason, kind) VALUES (?, ?, ?, ?, ?)')
    .run(scope, scope === 'global' ? null : ref_id, String(rule).trim(), reason,
      kind === 'immer' ? 'immer' : 'vermeiden');
  return db.prepare('SELECT * FROM avoid_rules WHERE id=?').get(r.lastInsertRowid);
}
export function deleteAvoidRule(id) {
  return db.prepare('DELETE FROM avoid_rules WHERE id=?').run(id).changes > 0;
}

/* ---------------------------------------------------- Zusammengesetzte Sicht */

/**
 * Alles, was die KI vor dem Schreiben wissen muss – in einem Rutsch.
 *
 * Die Auflösung des Stils folgt der Absprache: ein am Kontakt festgenagelter
 * Stil gewinnt immer, sonst der Standard des Zwecks, sonst irgendein passender.
 */
export function briefingFor(contactId, purpose = null) {
  const contact = db.prepare('SELECT * FROM contacts WHERE id=?').get(contactId);
  if (!contact) return null;

  let style = contact.style_id ? getWritingStyle(contact.style_id) : null;
  const styleSource = style ? 'fest am Kontakt' : null;
  if (!style && purpose) {
    const candidates = listWritingStyles(purpose);
    style = candidates.find(c => c.is_default && c.purpose === purpose)
      || candidates.find(c => c.purpose === purpose)
      || candidates.find(c => c.is_default) || null;
  }

  const avoid = [
    ...listAvoidRules({ scope: 'global' }),
    ...(style ? listAvoidRules({ scope: 'style', refId: style.id }) : []),
    ...listAvoidRules({ scope: 'contact', refId: contactId }),
  ];

  return {
    contact: {
      id: contact.id, name: contact.name, email: contact.email,
      company: contact.company, phone: contact.phone,
    },
    purpose,
    facts: listContactFacts(contactId).map(f => ({
      key: f.key, value: f.value, source: f.source,
      confidence: f.confidence, updated_at: f.updated_at,
    })),
    notes: getContactNotes(contactId),
    style: style ? {
      id: style.id, name: style.name, purpose: style.purpose,
      guidance: style.guidance, sample: style.sample,
      salutation: style.salutation, signoff: style.signoff,
      source: styleSource || (style.is_default ? 'Standard für diesen Zweck' : 'passend zum Zweck'),
    } : null,
    avoid: avoid.filter(a => a.kind === 'vermeiden').map(a => ({ rule: a.rule, reason: a.reason, scope: a.scope })),
    always: avoid.filter(a => a.kind === 'immer').map(a => ({ rule: a.rule, reason: a.reason, scope: a.scope })),
    missing: purpose ? missingFor(contactId, purpose) : [],
  };
}

/** Welche Pflichtangaben fehlen für diesen Zweck? Das ist die Frageliste der KI. */
export function missingFor(contactId, purpose) {
  const have = new Set(listContactFacts(contactId).map(f => f.key));
  return listRequirements(purpose)
    .filter(r => r.required && !have.has(r.key))
    .map(r => ({ key: r.key, label: r.label, question: r.question }));
}

/* ------------------------------------------------------------ Startwerte */

/**
 * Einmalige Grundausstattung, damit die Werkzeuge nicht ins Leere greifen.
 * Idempotent wie die übrigen Seeds im Projekt: läuft nur, wenn noch nichts da ist,
 * und meldet sich über console.error – stdout gehört dem MCP-Protokoll.
 */
function seedContext() {
  const has = db.prepare('SELECT COUNT(*) n FROM context_requirements').get().n
    + db.prepare('SELECT COUNT(*) n FROM writing_styles').get().n
    + db.prepare('SELECT COUNT(*) n FROM avoid_rules').get().n;
  if (has > 0) return;

  const reqs = [
    ['kundenmail', 'anrede', 'Anrede', 'Duzt oder siezt ihr euch?', 1, 1],
    ['kundenmail', 'rolle', 'Rolle', 'Welche Rolle hat die Person im Unternehmen?', 1, 2],
    ['kundenmail', 'projekt', 'Projekt', 'Um welches Projekt oder Thema geht es bei diesem Kunden?', 0, 3],
    ['bewerbung', 'stelle', 'Stelle', 'Auf welche Stelle bewirbst du dich dort?', 1, 1],
    ['bewerbung', 'ansprechpartner', 'Ansprechpartner', 'Gibt es einen namentlichen Ansprechpartner?', 0, 2],
    ['bewerbung', 'quelle', 'Fundstelle', 'Wo hast du die Ausschreibung gefunden?', 0, 3],
    ['whatsapp', 'anrede', 'Anrede', 'Duzt oder siezt ihr euch?', 1, 1],
    ['whatsapp', 'verhaeltnis', 'Verhältnis', 'Privat oder geschäftlich?', 1, 2],
  ];
  for (const [purpose, key, label, question, required, sort] of reqs) {
    upsertRequirement({ purpose, key, label, question, required, sort });
  }

  const styles = [
    {
      name: 'Kundenmail sachlich', purpose: 'kundenmail', is_default: 1,
      description: 'Für laufende Kundenkommunikation: freundlich, aber ohne Umschweife.',
      guidance: 'Kurze Absätze, ein Gedanke pro Absatz. Zuerst das Ergebnis, dann die Begründung. '
        + 'Konkrete Zahlen und Termine statt „zeitnah“. Am Ende ein klarer nächster Schritt.',
      salutation: 'Hallo {{name}},', signoff: 'Viele Grüße',
    },
    {
      name: 'Bewerbung', purpose: 'bewerbung',  is_default: 1,
      description: 'Anschreiben: erzählend, konkret, ohne Bewerbungsdeutsch.',
      guidance: 'In ganzen Sätzen schreiben, keine Stichpunkte. Behauptungen immer mit einer '
        + 'konkreten Station oder Zahl belegen. Fehlende Kenntnisse offen benennen statt umschreiben. '
        + 'Keine Superlative über die eigene Person.',
      salutation: 'Sehr geehrte Damen und Herren,', signoff: 'Mit freundlichen Grüßen',
    },
    {
      name: 'WhatsApp kurz', purpose: 'whatsapp', is_default: 1,
      description: 'Wie man tatsächlich tippt: knapp, ohne Briefform.',
      guidance: 'Zwei bis vier Sätze. Keine Anrede, keine Grußformel. Eine Frage pro Nachricht. '
        + 'Normale Sprache, keine Geschäftsfloskeln.',
    },
  ];
  for (const s of styles) upsertWritingStyle(s);

  const rules = [
    ['Floskeln als Einstieg, z.B. „Ich hoffe, es geht Ihnen gut“', 'Sagt nichts und kostet die erste Zeile.'],
    ['Werbesprache: „proaktiv“, „zeitnah“, „Synergie“, „ganzheitlich“', 'Klingt nach Textbaustein, nicht nach einem Menschen.'],
    ['Mehrere Ausrufezeichen oder Emojis in Geschäftsmails', 'Wirkt aufgesetzt.'],
    ['Den Empfänger für etwas loben, das ihn nicht betrifft', 'Durchschaubar.'],
    ['Etwas behaupten, das nicht in den Fakten steht', 'Lieber nachfragen als erfinden.'],
  ];
  for (const [rule, reason] of rules) addAvoidRule({ scope: 'global', rule, reason });

  console.error(`[seed] KI-Kontext: ${reqs.length} Pflichtangaben, ${styles.length} Schreibstile, ${rules.length} Regeln`);
}
seedContext();
