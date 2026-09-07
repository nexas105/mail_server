// Einzige Quelle für Verzeichnispfade. Importiert absichtlich nur node:path
// und node:url – harden.js lädt dieses Modul, bevor db.js überhaupt existiert,
// und darf dabei keine Datei anlegen und kein weiteres Modul mitziehen.
//
// Aufbau des Repos:
//   backend/   dieser Node-Service (package.json, src/, content.seed.json)
//   frontend/  Vite/React – der Build landet in frontend/dist
//   data/      Laufzeitdaten im Repo-Root (SQLite, Anhänge, WhatsApp-Sitzungen)
//
// Im Docker-Betrieb liegt data unter /data (MAIL_DATA_DIR), und das Frontend
// liefert nginx aus – STATIC_DIR ist dann leer bzw. nicht vorhanden. server.js
// meldet das beim Start und liefert die UI schlicht nicht selbst aus.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Repo-Root (enthält backend/, frontend/, data/, docker-compose.yml). */
export const ROOT_DIR = path.join(__dirname, '..', '..');

/** backend/ – cwd des Launchers, Ablage der Seed-Dateien. */
export const BACKEND_DIR = path.join(__dirname, '..');

/** Laufzeitdaten: SQLite, Schlüsseldatei, Anhänge, Assets, WhatsApp. */
export const DATA_DIR = process.env.MAIL_DATA_DIR
  ? path.resolve(process.env.MAIL_DATA_DIR)
  : path.join(ROOT_DIR, 'data');

/** Fertiger Frontend-Build, den der Server bei Bedarf selbst ausliefert. */
export const STATIC_DIR = process.env.MAIL_STATIC_DIR
  ? path.resolve(process.env.MAIL_STATIC_DIR)
  : path.join(ROOT_DIR, 'frontend', 'dist');

/** Vorlagen + Custom-Felder – versionierbar, wird auch vom Export beschrieben. */
export const CONTENT_SEED_FILE = process.env.CONTENT_SEED_FILE
  || path.join(BACKEND_DIR, 'content.seed.json');

/** SMTP-Konten zum Erstbefüllen – gitignored, Vorlage: accounts.seed.example.json. */
export const ACCOUNTS_SEED_FILE = process.env.SEED_FILE
  || path.join(BACKEND_DIR, 'accounts.seed.json');
