// Wiederherstellung beim Start: liegt <DATA_DIR>/restore-pending.tgz (per
// Upload über /api/backup/restore abgelegt), wird sie eingespielt, BEVOR
// irgendein Modul die Datenbank öffnet.
//
// Muss in server.js und mcp-server.js der ZWEITE Import sein (direkt nach
// harden.js). Der Rumpf ist bewusst SYNCHRON: ein top-level await hier würde
// db.js nicht aufhalten – ESM wertet Geschwister-Module, die nicht von diesem
// abhängen, trotzdem sofort aus. Deshalb läuft die eigentliche (asynchrone,
// streamende) Wiederherstellung in einem Kindprozess per spawnSync, und
// dieser Prozess wartet blockierend auf dessen Ende.
//
// Web-Server und MCP-Server können gleichzeitig starten: wer das Umbenennen
// nach restore-processing.tgz gewinnt, stellt wieder her; der andere wartet,
// bis die Datei verschwunden ist, und startet dann normal.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './paths.js';

const PENDING = path.join(DATA_DIR, 'restore-pending.tgz');
const PROCESSING = path.join(DATA_DIR, 'restore-processing.tgz');
const LAST = path.join(DATA_DIR, 'restore-last.json');
const BACKUP_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'backup.js');
const WAIT_MAX_MS = 15 * 60_000;

const log = (...a) => console.error('[restore]', ...a);
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
// Blockierendes Warten – im Modulrumpf gibt es kein await, das db.js aufhielte.
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function writeFailure(message) {
  try {
    fs.writeFileSync(LAST, JSON.stringify({
      at: new Date().toISOString(), ok: false, message, reencrypted: 0, warnings: [],
    }, null, 2) + '\n', { mode: 0o600 });
  } catch { /* egal */ }
}

function waitForOther() {
  const started = Date.now();
  let announced = false;
  while (fs.existsSync(PROCESSING)) {
    if (!announced) { log('Ein anderer Prozess stellt gerade wieder her – warte …'); announced = true; }
    if (Date.now() - started > WAIT_MAX_MS) {
      log('restore-processing.tgz bleibt liegen – vermutlich Abbruch eines früheren Laufs. Starte trotzdem.');
      return;
    }
    sleepSync(500);
  }
  if (announced) log('Wiederherstellung durch anderen Prozess abgeschlossen.');
}

function runRestore() {
  const startedAt = Date.now();
  log(`Spiele ${path.basename(PROCESSING)} ein …`);
  const r = spawnSync(process.execPath, [BACKUP_CLI, 'import', PROCESSING, '--force'], {
    env: process.env,
    // stdout des Kindes auf UNSER stderr: im MCP-stdio-Betrieb gehört stdout dem Protokoll.
    stdio: ['ignore', process.stderr.fd, process.stderr.fd],
    maxBuffer: 1 << 20,
  });
  if (r.status === 0) {
    fs.rmSync(PROCESSING, { force: true });
    let last = null;
    try { last = JSON.parse(fs.readFileSync(LAST, 'utf8')); } catch { /* unten */ }
    log(last?.ok ? `Fertig: ${last.message}` : 'Fertig.');
    for (const w of last?.warnings || []) log('Warnung:', w);
    return;
  }
  const failed = path.join(DATA_DIR, `restore-failed-${stamp()}.tgz`);
  try { fs.renameSync(PROCESSING, failed); } catch { /* egal */ }
  // Hat der Kindprozess selbst ein Ergebnis hinterlassen (ok:false), bleibt es.
  let fresh = false;
  try { fresh = fs.statSync(LAST).mtimeMs >= startedAt; } catch { /* fehlt */ }
  if (!fresh) writeFailure(r.error ? `Wiederherstellung nicht startbar: ${r.error.message}` : `Wiederherstellung fehlgeschlagen (Exit ${r.status ?? r.signal})`);
  log(`FEHLGESCHLAGEN – Archiv liegt unter ${path.basename(failed)}, Details in restore-last.json. Starte mit bisherigen Daten.`);
}

if (fs.existsSync(PENDING)) {
  let won = false;
  try { fs.renameSync(PENDING, PROCESSING); won = true; }
  catch { /* der andere Prozess war schneller */ }
  if (won) runRestore();
  else waitForOther();
} else if (fs.existsSync(PROCESSING)) {
  waitForOther();
}
