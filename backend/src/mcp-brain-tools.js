/**
 * MCP-Werkzeuge für Brain – Markdown-Wissen, allgemein und je Projekt.
 * Eigenes Werkzeug-Set "brain" (Endpunkt /mcp/brain), Logik in brain.js.
 *
 * Fehlerstil: werfen – ein falscher Pfad ist ein Aufruffehler.
 */
import { z } from 'zod';
import * as brain from './brain.js';

export function registerBrainTools({ tool, ok, UI }) {
  const link = p => `${UI}/brain${p ? `?datei=${encodeURIComponent(p)}` : ''}`;

  tool(
    'get_brain_overview',
    'Einstieg in Brain: allgemeine Notizen (allgemein/…) und alle Projekte mit Beschreibung und Dateizahl. '
    + 'Zu Beginn einer Aufgabe aufrufen, dann gezielt read_brain_file. Inhalte kommen hier noch nicht mit.',
    {},
    async () => ok({ ...brain.overview(), open_in_ui: link() }),
  );

  tool(
    'list_brain_files',
    'Dateien eines Ordners mit Titel, Größe und Änderungsdatum, z.B. path="projekte/relay" oder "allgemein".',
    { path: z.string().optional().default('').describe('Ordner; leer = alles') },
    async ({ path }) => ok(brain.listFiles(path)),
  );

  tool(
    'read_brain_file',
    'Liest eine Markdown-Datei. Bei langen Dateien mit start_line/end_line nur einen Ausschnitt holen '
    + '(lines_total steht in der Antwort). etag bei write/edit als if_match mitgeben, damit keine '
    + 'gleichzeitige Änderung des Nutzers überschrieben wird.',
    {
      path: z.string().describe('z.B. "allgemein/schreibstil.md" oder "projekte/relay/README.md" (.md darf fehlen)'),
      start_line: z.number().int().optional(),
      end_line: z.number().int().optional(),
    },
    async ({ path, start_line, end_line }) => ok(brain.readFile(path, { startLine: start_line, endLine: end_line })),
  );

  tool(
    'search_brain',
    'Volltextsuche über alle Notizen (alle Wörter müssen in der Datei vorkommen). Liefert Pfad, Titel und '
    + 'bis zu drei Trefferzeilen je Datei.',
    {
      query: z.string(),
      path: z.string().optional().default('').describe('Nur in diesem Ordner, z.B. "projekte/relay"'),
      limit: z.number().int().optional().default(20),
    },
    async ({ query, path, limit }) => ok(brain.search(query, { dir: path, limit })),
  );

  tool(
    'write_brain_file',
    'Legt eine Markdown-Datei an oder schreibt sie. mode: replace (ganze Datei), append (unten anfügen – '
    + 'ideal für Protokolle/Entscheidungen), prepend. Ordner entstehen automatisch. Pfade: allgemein/… oder '
    + 'projekte/<projekt>/…. Für kleine Änderungen an bestehenden Dateien lieber edit_brain_file.',
    {
      path: z.string(),
      content: z.string().describe('Markdown'),
      mode: z.enum(['replace', 'append', 'prepend']).optional().default('replace'),
      create_only: z.boolean().optional().default(false).describe('Fehler statt Überschreiben, falls die Datei existiert'),
      if_match: z.string().optional().describe('etag aus read_brain_file – schützt vor verlorenen Änderungen'),
    },
    async ({ path, content, mode, create_only, if_match }) => ok({
      ...brain.writeFile(path, content, { mode, createOnly: create_only, ifMatch: if_match }),
      open_in_ui: link(brain.cleanPath(path)),
    }),
  );

  tool(
    'edit_brain_file',
    'Ersetzt einen exakten Textausschnitt in einer Datei (old_text → new_text). Spart, die ganze Datei neu '
    + 'zu schicken. old_text muss genau einmal vorkommen, sonst replace_all=true oder mehr Kontext.',
    {
      path: z.string(),
      old_text: z.string(),
      new_text: z.string(),
      replace_all: z.boolean().optional().default(false),
      if_match: z.string().optional(),
    },
    async ({ path, old_text, new_text, replace_all, if_match }) =>
      ok(brain.editFile(path, old_text, new_text, { replaceAll: replace_all, ifMatch: if_match })),
  );

  tool(
    'create_brain_project',
    'Legt ein Projekt an (Ordner projekte/<name>/ mit README.md als Überblick). Die Beschreibung landet im README '
    + 'und erscheint in get_brain_overview.',
    { name: z.string(), description: z.string().optional() },
    async ({ name, description }) => ok({ ...brain.createProject(name, { description }), open_in_ui: link() }),
  );

  tool(
    'move_brain_file',
    'Verschiebt oder benennt eine Datei um (auch zwischen allgemein und Projekten).',
    { from: z.string(), to: z.string() },
    async ({ from, to }) => ok(brain.moveFile(from, to)),
  );

  tool(
    'delete_brain_file',
    'Löscht eine Datei – oder mit project=true ein ganzes Projekt. Landet im Papierkorb (data/brain/.papierkorb), '
    + 'ist also wiederherstellbar. Nur auf Wunsch des Nutzers.',
    {
      path: z.string().describe('Datei, bzw. bei project=true der Projektname'),
      project: z.boolean().optional().default(false),
    },
    async ({ path, project }) => ok(brain.deleteEntry(path, { project })),
  );
}
