/**
 * MCP-Werkzeuge für Brain – Notizen und Dateien, allgemein und je Projekt.
 * Eigenes Werkzeug-Set "brain" (Endpunkt /mcp/brain), Logik in brain.js.
 *
 * Fehlerstil: werfen – ein falscher Pfad ist ein Aufruffehler.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import * as brain from './brain.js';
import * as db from './db.js';
import { takeUpload } from './mcp-uploads.js';
import { guardedFetch } from './net-guard.js';

// Bilder für das Modell: darüber wird es teuer und bringt nichts mehr.
const IMAGE_INLINE_MAX = 4 * 1024 * 1024;

export function registerBrainTools({ tool, ok, UI, uploadOwner }) {
  const link = p => `${UI}/brain${p ? `?datei=${encodeURIComponent(p)}` : ''}`;

  tool(
    'get_brain_overview',
    'Einstieg in Brain: allgemeine Notizen (allgemein/…), alle Projekte mit Beschreibung, Status und Zahl der '
    + 'Notizen/Dateien, dazu alle Tags. Zu Beginn aufrufen; für ein Projekt danach get_brain_context.',
    {},
    async () => ok({ ...brain.overview(), open_in_ui: link() }),
  );

  tool(
    'get_brain_context',
    'Alles Wichtige zu EINEM Projekt in einem Aufruf: README komplett, Notizen mit Tag "kontext" komplett '
    + '(auch allgemeine), alle übrigen Dateien als Liste. Vor jeder Arbeit an einem Projekt aufrufen.',
    {
      project: z.string().describe('Projektname oder Ordner aus get_brain_overview'),
      max_chars: z.number().int().optional().default(30000),
    },
    async ({ project, max_chars }) => ok(brain.projectContext(project, { maxChars: max_chars })),
  );

  tool(
    'list_brain_files',
    'Dateien eines Ordners mit Art (note/pdf/image/text/audio/video/file), Titel, Tags, Größe, Datum. '
    + 'Optional nach kind oder tag filtern.',
    {
      path: z.string().optional().default('').describe('Ordner, z.B. "projekte/relay" – leer = alles'),
      kind: z.enum(['note', 'pdf', 'image', 'text', 'audio', 'video', 'file']).optional(),
      tag: z.string().optional(),
    },
    async ({ path: p, kind, tag }) => ok(brain.listFiles(p, { kind, tag })),
  );

  tool(
    'read_brain_file',
    'Liest eine Datei. Notiz/Text: Inhalt (start_line/end_line für Ausschnitte), dazu Verknüpfungen und Rückverweise. '
    + 'PDF: Text je Seite (pages=[von,bis] für große PDFs). Bild: das Bild selbst zum Ansehen. '
    + 'Andere Dateien: nur Angaben. etag bei write/edit als if_match mitgeben.',
    {
      path: z.string().describe('z.B. "allgemein/schreibstil.md" oder "projekte/relay/dateien/angebot.pdf" (.md darf fehlen)'),
      start_line: z.number().int().optional(),
      end_line: z.number().int().optional(),
      pages: z.array(z.number().int()).length(2).optional().describe('PDF-Seitenbereich, z.B. [1, 3]'),
    },
    async ({ path: p, start_line, end_line, pages }) => {
      const r = await brain.readFile(p, { startLine: start_line, endLine: end_line, pages, withImage: true });
      if (r.kind === 'image' && r.base64) {
        const { base64, ...meta } = r;
        const tooBig = r.size > IMAGE_INLINE_MAX || r.mime === 'image/svg+xml';
        return {
          content: [
            ...(tooBig ? [] : [{ type: 'image', data: base64, mimeType: r.mime }]),
            { type: 'text', text: JSON.stringify({ ...meta, note: tooBig ? 'Bild zu groß oder SVG – nur Angaben, ansehen in der Oberfläche.' : undefined, open_in_ui: link(r.path) }) },
          ],
        };
      }
      return ok(r);
    },
  );

  tool(
    'search_brain',
    'Volltextsuche über Notizen, Textdateien UND den Text von PDFs (alle Wörter müssen vorkommen). '
    + 'Mit tag nur Notizen mit diesem Tag. Liefert Pfad, Art, Titel und bis zu drei Trefferzeilen.',
    {
      query: z.string().optional().default(''),
      tag: z.string().optional(),
      path: z.string().optional().default('').describe('Nur in diesem Ordner, z.B. "projekte/relay"'),
      limit: z.number().int().optional().default(20),
    },
    async ({ query, tag, path: p, limit }) => ok(brain.search(query, { dir: p, tag, limit })),
  );

  tool(
    'write_brain_file',
    'Legt eine Notiz an oder schreibt sie. mode: replace (ganze Datei), append (unten anfügen – ideal für '
    + 'Protokolle/Entscheidungen), prepend. Ordner entstehen automatisch. Kopf für Struktur: '
    + '"---\\ntags: [kunde]\\nstatus: aktiv\\nbeschreibung: …\\n---". Verweise: [[andere-notiz]], '
    + 'Bilder: ![](dateien/bild.png). Für kleine Änderungen lieber edit_brain_file.',
    {
      path: z.string(),
      content: z.string().describe('Markdown'),
      mode: z.enum(['replace', 'append', 'prepend']).optional().default('replace'),
      create_only: z.boolean().optional().default(false).describe('Fehler statt Überschreiben, falls die Datei existiert'),
      if_match: z.string().optional().describe('etag aus read_brain_file – schützt vor verlorenen Änderungen'),
    },
    async ({ path: p, content, mode, create_only, if_match }) => ok({
      ...brain.writeFile(p, content, { mode, createOnly: create_only, ifMatch: if_match }),
      open_in_ui: link(brain.cleanPath(p)),
    }),
  );

  tool(
    'edit_brain_file',
    'Ersetzt einen exakten Textausschnitt in einer Notiz (old_text → new_text). Spart, die ganze Datei neu '
    + 'zu schicken. old_text muss genau einmal vorkommen, sonst replace_all=true oder mehr Kontext.',
    {
      path: z.string(),
      old_text: z.string(),
      new_text: z.string(),
      replace_all: z.boolean().optional().default(false),
      if_match: z.string().optional(),
    },
    async ({ path: p, old_text, new_text, replace_all, if_match }) =>
      ok(brain.editFile(p, old_text, new_text, { replaceAll: replace_all, ifMatch: if_match })),
  );

  tool(
    'add_brain_file',
    'Legt eine Datei ab (PDF, Bild, Office, Audio, Video, Text – max. 50 MB). Quelle: upload_id (aus create_upload, '
    + 'dann curl -T <datei> <upload_url> – der Weg für Dateien vom eigenen Rechner), url (öffentliche https-Adresse) '
    + 'oder base64. PDFs werden sofort ausgelesen und sind danach durchsuchbar. Tipp: in Projekten nach '
    + 'projekte/<projekt>/dateien ablegen und in der README verlinken.',
    {
      folder: z.string().describe('Zielordner, z.B. "projekte/relay/dateien" oder "allgemein"'),
      filename: z.string().optional().describe('Dateiname; Standard: aus Upload/URL'),
      upload_id: z.string().optional(),
      url: z.string().optional(),
      base64: z.string().optional(),
      mimetype: z.string().optional(),
      overwrite: z.boolean().optional().default(false),
    },
    async ({ folder, filename, upload_id, url, base64, mimetype, overwrite }) => {
      let buf, name = filename, mime = mimetype;
      if (upload_id) {
        const up = takeUpload(upload_id, uploadOwner);
        buf = up.buffer; name = name || up.filename; mime = mime || up.mimetype;
      } else if (url) {
        const res = await guardedFetch(url, {}, { purpose: 'Datei' });
        if (!res.ok) throw new Error(`Download fehlgeschlagen: HTTP ${res.status}`);
        const len = Number(res.headers.get('content-length') || 0);
        if (len > brain.FILE_MAX_BYTES) throw new Error('Datei größer als 50 MB');
        buf = Buffer.from(await res.arrayBuffer());
        mime = mime || res.headers.get('content-type');
        name = name || decodeURIComponent(new URL(url).pathname.split('/').pop() || 'datei');
      } else if (base64) {
        if (!name) throw new Error('filename ist bei base64 Pflicht');
        buf = Buffer.from(base64, 'base64');
      } else {
        throw new Error('upload_id, url oder base64 angeben');
      }
      const info = await brain.saveFile(folder, name, buf, { mime, overwrite });
      return ok({ ...info, markdown: info.kind === 'image' ? `![](${path.posix.basename(info.path)})` : `[${path.posix.basename(info.path)}](${path.posix.basename(info.path)})`, open_in_ui: link(info.path) });
    },
  );

  tool(
    'save_to_brain',
    'Übernimmt einen Anhang aus dem Posteingang (message_attachment_id aus list_message_attachments) oder '
    + 'eine WhatsApp-Datei/-Bild/-Sprachnachricht (wa_message_id) ins Brain – ohne Umweg über den Client.',
    {
      folder: z.string().describe('Zielordner, z.B. "projekte/relay/dateien"'),
      message_attachment_id: z.number().int().optional(),
      wa_message_id: z.number().int().optional(),
      filename: z.string().optional(),
    },
    async ({ folder, message_attachment_id, wa_message_id, filename }) => {
      let file, name, mime;
      if (message_attachment_id) {
        const a = db.getMessageAttachment(message_attachment_id);
        if (!a) throw new Error('Anhang nicht gefunden – list_message_attachments aufrufen (ggf. vorher fetch_message_attachments)');
        file = a.stored_path; name = a.filename; mime = a.mimetype;
      } else if (wa_message_id) {
        const m = db.getWaMessage(wa_message_id);
        if (!m) throw new Error('WhatsApp-Nachricht nicht gefunden');
        if (!m.stored_path || !fs.existsSync(m.stored_path)) throw new Error('Die Datei dieser Nachricht ist nicht (mehr) heruntergeladen');
        file = m.stored_path; mime = m.media_mime;
        name = m.media_filename || `whatsapp-${m.type}-${new Date(m.ts * 1000).toISOString().slice(0, 10)}`;
      } else {
        throw new Error('message_attachment_id oder wa_message_id angeben');
      }
      if (!fs.existsSync(file)) throw new Error('Datei liegt nicht mehr auf dem Server');
      const info = await brain.saveFile(folder, filename || name, fs.readFileSync(file), { mime });
      return ok({ ...info, open_in_ui: link(info.path) });
    },
  );

  tool(
    'create_brain_project',
    'Legt ein Projekt an: Ordner projekte/<name>/ mit README.md (Vorlage mit Ziel, Stand, Beteiligte, '
    + 'Entscheidungen, Offene Punkte) und Unterordner dateien/ für Ablagen.',
    { name: z.string(), description: z.string().optional() },
    async ({ name, description }) => ok({ ...brain.createProject(name, { description }), open_in_ui: link() }),
  );

  tool(
    'create_brain_folder',
    'Legt einen Unterordner an, z.B. "projekte/relay/protokolle" oder "allgemein/personen".',
    { path: z.string() },
    async ({ path: p }) => ok(brain.createFolder(p)),
  );

  tool(
    'move_brain_file',
    'Verschiebt oder benennt eine Datei oder einen Ordner um. Pfad-Verweise in anderen Notizen werden angepasst.',
    { from: z.string(), to: z.string() },
    async ({ from, to }) => ok(brain.moveEntry(from, to)),
  );

  tool(
    'delete_brain_file',
    'Löscht eine Datei – mit folder=true einen Unterordner, mit project=true ein ganzes Projekt. Alles landet im '
    + 'Papierkorb (data/brain/.papierkorb) und ist wiederherstellbar. Nur auf Wunsch des Nutzers.',
    {
      path: z.string().describe('Datei, Ordner bzw. bei project=true der Projektname'),
      folder: z.boolean().optional().default(false),
      project: z.boolean().optional().default(false),
    },
    async ({ path: p, folder, project }) => ok(brain.deleteEntry(p, { folder, project })),
  );
}
