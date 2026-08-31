// Betriebs-Richtlinie des MCP-Servers.
//
// Lokal per stdio ist der MCP-Server so mächtig wie der Nutzer selbst – das ist
// gewollt. Sobald er über HTTP auf einem Server erreichbar ist, gelten andere
// Regeln: der Aufrufer sitzt woanders, und ein Werkzeug wie „Anhang von Pfad
// lesen" wäre sonst ein Lesezugriff auf das ganze Dateisystem des Servers.
//
// Alles hier ist Standard-sicher und per Umgebungsvariable wieder zu öffnen.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const list = value => String(value || '').split(',').map(s => s.trim()).filter(Boolean);

// Nur-Lesen-Betrieb: erlaubt sind Werkzeuge, die nichts verändern und nichts senden.
const READ_PREFIXES = ['list_', 'get_', 'search_', 'preview_', 'read_'];

export const policy = {
  transport: 'stdio',
  readonly: process.env.MCP_READONLY === '1',
  disabledTools: new Set(list(process.env.MCP_DISABLED_TOOLS)),
  enabledTools: new Set(list(process.env.MCP_ENABLED_TOOLS)),
  // null = „richtet sich nach dem Transport" (stdio: ja, http: nein)
  allowLocalFiles: process.env.MCP_ALLOW_LOCAL_FILES === '1' ? true
    : (process.env.MCP_ALLOW_LOCAL_FILES === '0' ? false : null),
  filesRoot: process.env.MCP_FILES_DIR ? path.resolve(process.env.MCP_FILES_DIR) : null,
};

/** Wird vom HTTP-Einstieg aufgerufen, bevor die erste Sitzung entsteht. */
export function configure({ transport }) {
  policy.transport = transport;
  if (policy.allowLocalFiles === null) policy.allowLocalFiles = transport === 'stdio';
  return policy;
}

export function localFilesAllowed() {
  return policy.allowLocalFiles === null ? policy.transport === 'stdio' : policy.allowLocalFiles;
}

/** Darf dieses Werkzeug registriert werden? */
/**
 * Darf dieses Werkzeug registriert werden?
 * `session.readonly` kommt von einem nur-lesenden Token und gilt zusätzlich zur
 * globalen Richtlinie – ein Token kann Rechte nur einschränken, nie ausweiten.
 */
export function assertToolAllowed(name, session = {}) {
  if (policy.enabledTools.size && !policy.enabledTools.has(name)) return false;
  if (policy.disabledTools.has(name)) return false;
  if ((policy.readonly || session.readonly) && !READ_PREFIXES.some(p => name.startsWith(p))) return false;
  return true;
}

export const isReadTool = name => READ_PREFIXES.some(p => name.startsWith(p));

/**
 * Prüft einen Datei-Pfad für Anhänge. Gibt den aufgelösten Pfad zurück oder
 * wirft mit einer Meldung, die dem Aufrufer sagt, was er stattdessen tun kann.
 */
export function resolveAttachmentPath(input) {
  const raw = String(input || '');
  const expanded = raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
  const file = path.resolve(expanded);

  if (policy.filesRoot) {
    const root = policy.filesRoot.endsWith(path.sep) ? policy.filesRoot : policy.filesRoot + path.sep;
    // realpath, damit ein Symlink nicht aus dem Ordner herausführt.
    let real = file;
    try { real = fs.realpathSync(file); } catch { /* existiert (noch) nicht – prüft der Aufrufer */ }
    if (real !== policy.filesRoot && !real.startsWith(root)) {
      throw new Error(`Zugriff verweigert: Anhänge dürfen nur aus ${policy.filesRoot} kommen (MCP_FILES_DIR). Alternativ base64 mitschicken.`);
    }
    return real;
  }

  if (!localFilesAllowed()) {
    throw new Error('Anhänge per Pfad sind im Server-Betrieb abgeschaltet – schick den Inhalt als base64 '
      + 'oder gib mit MCP_FILES_DIR=<Ordner> einen freigegebenen Ordner frei.');
  }
  return file;
}
