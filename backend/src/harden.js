/**
 * Dateirechte im data-Verzeichnis.
 *
 * Verschlüsselt sind nur Passwörter und Token. Mailinhalte, Kontakte,
 * WhatsApp-Verläufe und Anhänge liegen im Klartext in der Datenbank – wer die
 * Datei lesen kann, liest alles. Auf einem Server mit mehreren Benutzern ist
 * das der wichtigste Riegel überhaupt.
 *
 * Zwei Ebenen, weil eine allein nicht reicht:
 *   umask   – alles NEUE entsteht von vornherein privat
 *   Nachlauf – alles ALTE wird einmalig zurechtgerückt
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

// Die umask wird BEIM IMPORT gesetzt, nicht erst durch einen Funktionsaufruf.
// Grund: ESM wertet sämtliche Imports eines Moduls aus, bevor dessen Rumpf
// läuft. Ein `setRestrictiveUmask()` im Rumpf von server.js käme also erst
// NACH db.js dran – und db.js legt mail.db, .keyfile und Verzeichnisse an.
// Deshalb muss dieser Import in server.js und mcp-server.js der ERSTE sein;
// harden.js selbst zieht nur node:fs, node:path und paths.js mit, und paths.js
// legt nichts an.
// 0o077 = Gruppe und Andere bekommen keinerlei Rechte.
try { process.umask(0o077); } catch { /* auf manchen Plattformen nicht erlaubt */ }

/**
 * Bleibt als Alias erhalten – die eigentliche Arbeit passiert oben beim Import.
 * Ein erneuter Aufruf ist harmlos (idempotent).
 */
export function setRestrictiveUmask() {
  try { process.umask(0o077); } catch { /* s.o. */ }
}

/** Geht data/ einmal durch und zieht Rechte gerade. Meldet, was es geändert hat. */
export function hardenDataDir({ quiet = false } = {}) {
  if (!fs.existsSync(DATA_DIR)) return { changed: 0, skipped: 0 };
  let changed = 0;
  let skipped = 0;

  const walk = dir => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { skipped++; return; }

    fix(dir, DIR_MODE);
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) fix(p, FILE_MODE);
    }
  };

  const fix = (p, mode) => {
    try {
      const cur = fs.statSync(p).mode & 0o777;
      if (cur === mode) return;
      // Nur einschränken, nie aufweiten: wer bewusst enger gesetzt hat, behält das.
      if ((cur & ~mode) === 0) return;
      fs.chmodSync(p, mode);
      changed++;
    } catch { skipped++; }
  };

  walk(DATA_DIR);
  // stderr, nicht stdout – stdout gehört im MCP-Betrieb dem Protokoll.
  if (changed && !quiet) console.error(`[harden] Dateirechte in data/ korrigiert: ${changed} Einträge`);
  return { changed, skipped };
}
