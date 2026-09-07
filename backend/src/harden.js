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

/**
 * Setzt die umask des Prozesses, sodass neu angelegte Dateien niemandem sonst
 * gehören. Muss vor dem ersten Schreibzugriff laufen – also möglichst früh
 * beim Start, bevor db.js seine Datei anlegt.
 */
export function setRestrictiveUmask() {
  // 0o077 = Gruppe und Andere bekommen keinerlei Rechte.
  try { process.umask(0o077); } catch { /* auf manchen Plattformen nicht erlaubt */ }
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
