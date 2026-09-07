/**
 * WhatsApp über Baileys.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ NIEMALS aus src/mcp-server.js laden – auch nicht mittelbar.              │
 * │ Der MCP-Server ist ein EIGENER Prozess auf derselben data/mail.db.       │
 * │ WhatsApp erlaubt pro Konto genau eine Sitzung; zwei Sockets auf demselben│
 * │ Auth-Verzeichnis zerstören sie unwiderruflich. Der MCP-Server liest      │
 * │ deshalb nur aus SQLite und schickt Sende-Aufträge per HTTP hierher.      │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
import fs from 'node:fs';
import path from 'node:path';
import makeWASocket, {
  useMultiFileAuthState, makeCacheableSignalKeyStore, fetchLatestBaileysVersion,
  DisconnectReason, Browsers, downloadMediaMessage, jidNormalizedUser, isJidGroup,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-generator';
import * as db from './db.js';
import { emit } from './wa-bus.js';
import { DATA_DIR } from './paths.js';

const WA_DIR = path.join(DATA_DIR, 'whatsapp');
const MEDIA_DIR = path.join(WA_DIR, 'media');

// Pino MUSS auf stderr schreiben: der Launcher greift stdout des Servers ab,
// und im MCP-Prozess wäre stdout sogar der Protokollkanal.
const logger = pino({ level: process.env.WA_LOG_LEVEL || 'silent' }, pino.destination(2));

/** id -> Session */
const sessions = new Map();

const log = (...a) => console.error('[whatsapp]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);
// Nur @s.whatsapp.net trägt eine Telefonnummer. @lid sind WhatsApps neue
// Gerätekennungen und @g.us Gruppen – daraus eine "Nummer" zu basteln, erzeugt
// nur Unsinn wie +251925702410405.
const phoneOf = jid => {
  const j = String(jid || '');
  if (!j.endsWith('@s.whatsapp.net')) return null;
  return (j.split('@')[0] || '').split(':')[0] || null;
};

function ensureDirs(id) {
  const auth = path.join(WA_DIR, String(id), 'auth');
  fs.mkdirSync(auth, { recursive: true, mode: 0o700 });
  fs.mkdirSync(MEDIA_DIR, { recursive: true, mode: 0o700 });
  return auth;
}

/* ---------------------------------------------------------------- Sperrdatei */

/**
 * Verhindert, dass ein zweiter Prozess (z.B. ein manuelles `npm start` neben dem
 * Launcher) dieselbe Sitzung öffnet. Ohne das schreiben beide dieselben
 * Signal-Schlüsseldateien und die Kopplung ist danach hin.
 */
function acquireLock(id) {
  const lock = path.join(WA_DIR, String(id), 'session.lock');
  try {
    const fd = fs.openSync(lock, 'wx');
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
    return { fd, lock };
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let holder = null;
    try { holder = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch { /* kaputt */ }
    // Halten WIR die Sperre schon? Dann ist es kein Konflikt, sondern ein zweiter
    // Anlauf im selben Prozess (Neuverbindung, doppelter Klick). Übernehmen.
    if (holder?.pid && holder.pid !== process.pid) {
      let alive = false;
      try { process.kill(holder.pid, 0); alive = true; }   // 0 = nur prüfen, ob er lebt
      catch (err) { if (err.code !== 'ESRCH') throw err; } // ESRCH = tot, Sperre übernehmen
      if (alive) throw new Error(`Diese WhatsApp-Sitzung wird bereits von Prozess ${holder.pid} genutzt`);
    }
    fs.rmSync(lock, { force: true });
    return acquireLock(id);
  }
}
function releaseLock(session) {
  if (!session?.lock) return;
  try { fs.closeSync(session.lock.fd); } catch { /* egal */ }
  try { fs.rmSync(session.lock.lock, { force: true }); } catch { /* egal */ }
  session.lock = null;
}

/* -------------------------------------------------- Auth-Zustand mit Netz */

/**
 * useMultiFileAuthState schreibt mit einfachem writeFile. Ein SIGKILL mitten im
 * Schreiben kappt creds.json und die Kopplung ist weg. Deshalb: nach jedem
 * erfolgreichen Verbinden eine Sicherungskopie, und beim Start notfalls zurück.
 */
async function loadAuthState(dir) {
  const creds = path.join(dir, 'creds.json');
  const backup = path.join(dir, 'creds.json.bak');
  if (fs.existsSync(creds)) {
    try { JSON.parse(fs.readFileSync(creds, 'utf8')); }
    catch {
      if (fs.existsSync(backup)) {
        log('creds.json unlesbar – stelle Sicherungskopie wieder her');
        fs.copyFileSync(backup, creds);
      } else {
        log('creds.json unlesbar und keine Sicherung – Kopplung muss erneuert werden');
        fs.rmSync(creds, { force: true });
      }
    }
  }
  return useMultiFileAuthState(dir);
}
function backupCreds(dir) {
  const creds = path.join(dir, 'creds.json');
  if (fs.existsSync(creds)) {
    try {
      const bak = path.join(dir, 'creds.json.bak');
      fs.copyFileSync(creds, bak);
      fs.chmodSync(bak, 0o600);
    } catch { /* egal */ }
  }
  lockDownAuthFiles(dir);
}

/**
 * Dieses Verzeichnis IST die WhatsApp-Identität – wer es kopiert, kann als
 * dieser Nutzer lesen und schreiben. useMultiFileAuthState schreibt mit den
 * Standardrechten, deshalb ziehen wir sie nach jedem Schreibvorgang nach.
 * Der Ordner allein (0700) ist nur eine einzige Berechtigung zwischen den
 * Schlüsseln und dem Rest des Systems.
 */
function lockDownAuthFiles(dir) {
  try {
    fs.chmodSync(dir, 0o700);
    for (const f of fs.readdirSync(dir)) {
      try { fs.chmodSync(path.join(dir, f), 0o600); } catch { /* egal */ }
    }
  } catch { /* Verzeichnis weg – nicht schlimm */ }
}

/* ------------------------------------------------------------------ Status */

function setStatus(session, status, extra = {}) {
  session.status = status;
  db.setWaAccountStatus(session.id, status, extra);
  emit('status', listSessions());
}

export function sessionStatus(id) {
  const s = sessions.get(id);
  const row = db.getWaAccount(id);
  if (!row) return null;
  const status = s?.status || row.status || 'logged_out';
  return {
    wa_account_id: id,
    name: row.name,
    status,
    phone: row.phone,
    push_name: row.push_name,
    // Der Status kommt aus dem Speicher, der Fehler aus der Datenbank. Ohne diese
    // Bedingung stand ein alter Fehler neben einem fröhlichen "Verbunden".
    error: status === 'connected' ? null : row.last_error,
    live: !!s,
  };
}
export function listSessions() {
  return db.listWaAccounts().map(a => sessionStatus(a.id)).filter(Boolean);
}

/* -------------------------------------------------- Nachrichten-Umwandlung */

/** Zieht Typ, Text und Medien-Metadaten aus einer Baileys-Nachricht. */
function describeMessage(msg) {
  const m = msg.message || {};
  const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message
    || m.viewOnceMessageV2?.message || m.documentWithCaptionMessage?.message || m;

  const pick = (type, node, bodyKey = 'caption') => ({
    type,
    body: node?.[bodyKey] || null,
    media_mime: node?.mimetype || null,
    media_size: Number(node?.fileLength) || null,
    media_filename: node?.fileName || null,
  });

  if (inner.conversation) return { type: 'text', body: inner.conversation };
  if (inner.extendedTextMessage) return { type: 'text', body: inner.extendedTextMessage.text || null };
  if (inner.imageMessage) return pick('image', inner.imageMessage);
  if (inner.videoMessage) return pick('video', inner.videoMessage);
  if (inner.audioMessage) return { ...pick('audio', inner.audioMessage), body: null };
  if (inner.documentMessage) return pick('document', inner.documentMessage);
  if (inner.stickerMessage) return { ...pick('sticker', inner.stickerMessage), body: null };
  if (inner.locationMessage) {
    const l = inner.locationMessage;
    return { type: 'location', body: `${l.degreesLatitude}, ${l.degreesLongitude}` };
  }
  if (inner.contactMessage) return { type: 'contact', body: inner.contactMessage.displayName || null };
  if (inner.reactionMessage) return { type: 'reaction', body: inner.reactionMessage.text || null };
  if (inner.protocolMessage?.type === 0) return { type: 'revoked', body: null };
  return { type: 'unsupported', body: null };
}

const snippetOf = (type, body) => {
  if (body) return String(body).replace(/\s+/g, ' ').slice(0, 140);
  return ({ image: '📷 Bild', video: '🎥 Video', audio: '🎤 Sprachnachricht',
    document: '📄 Dokument', sticker: 'Sticker', location: '📍 Standort',
    contact: '👤 Kontakt', revoked: 'Nachricht gelöscht' })[type] || null;
};

/** Baileys-Nachricht → Zeile für wa_messages. Chat wird dabei angelegt. */
function toRow(session, msg, { origin = null } = {}) {
  const jid = msg.key?.remoteJid;
  if (!jid || jid === 'status@broadcast') return null;
  const d = describeMessage(msg);
  const ts = Number(msg.messageTimestamp?.low ?? msg.messageTimestamp ?? 0) || nowSec();
  const isGroup = isJidGroup(jid);
  const snippet = snippetOf(d.type, d.body);

  const chat = db.upsertWaChat(session.id, {
    jid, name: msg.pushName && !isGroup ? msg.pushName : undefined,
    is_group: isGroup, last_message_ts: ts, last_snippet: snippet,
  });
  // Der Gruppenbetreff steht nicht in der Nachricht – einmal nachfragen,
  // sonst zeigen UI und MCP nur die nackte JID (120363…@g.us).
  if (isGroup && !chat.name) queueGroupMeta(session, jid);

  if (!isGroup) {
    db.upsertWaContact(session.id, {
      jid, phone: phoneOf(jid), push_name: msg.key?.fromMe ? null : msg.pushName || null, is_group: 0,
    });
  }

  return {
    wa_account_id: session.id,
    chat_id: chat.id,
    wa_id: msg.key.id,
    chat_jid: jid,
    sender_jid: msg.key.participant || (msg.key.fromMe ? session.jid : jid),
    sender_name: msg.pushName || null,
    from_me: msg.key.fromMe ? 1 : 0,
    ts,
    type: d.type,
    body: d.body,
    snippet,
    quoted_wa_id: msg.message?.extendedTextMessage?.contextInfo?.stanzaId || null,
    media_mime: d.media_mime ?? null,
    media_size: d.media_size ?? null,
    media_filename: d.media_filename ?? null,
    status: msg.key.fromMe ? 'sent' : null,
    origin: msg.key.fromMe ? origin : null,
    // raw behalten für eigene Nachrichten (Baileys braucht es für
    // Zustell-Wiederholungen) UND für alles mit Medien: ohne das Original kann
    // eine Sprachnachricht später nicht mehr heruntergeladen werden.
    raw: (msg.key.fromMe || d.media_mime) ? JSON.stringify(msg.message ?? null) : null,
    _msg: msg,
  };
}

/* ----------------------------------------------------------------- Gruppen */

/**
 * Gruppen-Betreff und Teilnehmer holen. groupMetadata ist eine echte Abfrage
 * an WhatsApp, deshalb pro Gruppe nur einmal und nacheinander – ein Schwall
 * Abfragen beim ersten Sync ist genau das Muster, das Nummern auffällig macht.
 */
const groupMetaPending = new Set();

function queueGroupMeta(session, jid) {
  if (groupMetaPending.has(jid)) return;
  groupMetaPending.add(jid);
  session.groupQueue = (session.groupQueue || Promise.resolve())
    .then(() => fetchGroupMeta(session, jid))
    .catch(e => log('Gruppen-Stammdaten:', e.message))
    .finally(() => groupMetaPending.delete(jid));
}

async function fetchGroupMeta(session, jid) {
  if (!session.sock || session.status !== 'connected') return;
  await sleep(400);
  const meta = await session.sock.groupMetadata(jid);
  const chat = db.getWaChatByJid(session.id, jid);
  if (!chat) return;
  const participants = (meta.participants || []).map(p => ({
    jid: p.id,
    phone: phoneOf(p.id),
    admin: p.admin || null,
  }));
  db.setWaGroupMeta(chat.id, { name: meta.subject || null, participants });
  emit('chat', db.getWaChat(chat.id));
  log(`Gruppe "${meta.subject}" – ${participants.length} Teilnehmer`);
}

/* ------------------------------------------------------------------ Medien */

/** Welche Medientypen bei diesem Konto automatisch geladen werden. */
const WANTED = {
  off: [],
  images: ['image'],
  images_audio: ['image', 'audio'],
  all: ['image', 'audio', 'video', 'document', 'sticker'],
};

async function maybeDownloadMedia(session, row, dbId) {
  if (!row.media_mime || !row._msg) return;
  const acc = db.getWaAccount(session.id);
  const wanted = WANTED[acc?.media_download || 'images_audio'] || WANTED.images_audio;
  if (!wanted.includes(row.type)) return;
  const maxBytes = (acc?.media_max_mb || 5) * 1024 * 1024;
  if (row.media_size && row.media_size > maxBytes) return;
  try {
    await downloadMediaToDisk(session, dbId, row._msg);
  } catch (e) { log('Medien-Download fehlgeschlagen:', e.message); }
}

/**
 * Alte Mediendateien löschen. Nur die Dateien – die Nachricht bleibt mit Text
 * und Metadaten erhalten, und solange das Original gespeichert ist, lässt sie
 * sich später wieder herunterladen.
 */
export function cleanupMedia(waAccountId = null) {
  const accounts = waAccountId ? [db.getWaAccount(waAccountId)] : db.listWaAccounts();
  let removed = 0, freed = 0;
  for (const acc of accounts) {
    if (!acc || !acc.media_keep_days) continue;   // 0 = unbegrenzt aufheben
    for (const m of db.waMediaOlderThan(acc.id, acc.media_keep_days)) {
      try { fs.rmSync(m.stored_path, { force: true }); } catch { /* schon weg */ }
      db.clearWaMedia(m.id);
      removed++; freed += m.media_size || 0;
    }
  }
  if (removed) log(`Medien aufgeräumt: ${removed} Dateien, ${(freed / 1048576).toFixed(1)} MB frei`);
  return { removed, freed_mb: +(freed / 1048576).toFixed(1) };
}

async function downloadMediaToDisk(session, messageId, msg) {
  const buf = await downloadMediaMessage(msg, 'buffer', {}, {
    logger, reuploadRequest: session.sock.updateMediaMessage,
  });
  const row = db.getWaMessage(messageId);
  const safe = String(row?.media_filename || `${row?.type || 'datei'}`)
    .replace(/[^\w.\-]+/g, '_').slice(0, 100);
  const file = path.join(MEDIA_DIR, `${messageId}_${safe}`);
  fs.writeFileSync(file, buf);
  return db.setWaMessageMedia(messageId, { stored_path: file, media_size: buf.length });
}

/**
 * Alle Gruppen auf einen Schlag holen.
 *
 * queueGroupMeta greift erst, wenn in einer Gruppe etwas passiert – nach einem
 * Verlaufs-Sync stehen die Gruppen aber schon da und heißen nichts. Ein einziger
 * Aufruf liefert Betreff und Teilnehmer für alle.
 */
export async function syncAllGroups(id) {
  const session = sessions.get(id);
  if (!session?.sock || session.status !== 'connected') throw new Error('WhatsApp ist nicht verbunden');
  const all = await session.sock.groupFetchAllParticipating();
  let updated = 0;
  for (const meta of Object.values(all || {})) {
    if (!meta?.id) continue;
    db.upsertWaChat(id, { jid: meta.id, name: meta.subject || null, is_group: 1 });
    const chat = db.getWaChatByJid(id, meta.id);
    if (!chat) continue;
    db.setWaGroupMeta(chat.id, {
      name: meta.subject || null,
      participants: (meta.participants || []).map(p => ({
        jid: p.id, phone: phoneOf(p.id), admin: p.admin || null,
      })),
    });
    updated++;
  }
  emit('status', listSessions());
  log(`Gruppen abgeglichen: ${updated}`);
  return { groups: updated };
}

/**
 * Lädt die Medien einer Nachricht nachträglich.
 *
 * Liegt das Original vor, geht das direkt. Fehlt es – etwa bei Nachrichten aus
 * dem Verlaufs-Sync – wird die Datei beim Absendergerät neu angefordert
 * (updateMediaMessage). Das klappt nur, wenn dessen WhatsApp erreichbar ist und
 * die Nachricht dort noch liegt; bei alten Nachrichten oft nicht mehr.
 */
export async function downloadMessageMedia(messageId) {
  const row = db.getWaMessage(messageId);
  if (!row) throw new Error('Nachricht nicht gefunden');
  if (row.stored_path && fs.existsSync(row.stored_path)) return row;
  if (!row.media_mime) throw new Error('Diese Nachricht hat keine Medien');

  const session = sessions.get(row.wa_account_id);
  if (!session?.sock || session.status !== 'connected') {
    throw new Error('WhatsApp ist nicht verbunden');
  }

  const key = {
    remoteJid: row.chat_jid,
    id: row.wa_id,
    fromMe: !!row.from_me,
    ...(row.chat_jid.endsWith('@g.us') && row.sender_jid ? { participant: row.sender_jid } : {}),
  };

  if (row.raw) {
    const msg = { key, message: JSON.parse(row.raw) };
    try {
      return await downloadMediaToDisk(session, messageId, msg);
    } catch (e) {
      // WhatsApp lässt Medien-URLs nach einigen Tagen verfallen. MIT Original
      // lässt sich das erneuern – genau dafür ist updateMediaMessage da.
      log('Erster Versuch fehlgeschlagen, erneuere URL:', e.message);
      const refreshed = await session.sock.updateMediaMessage(msg);
      db.db.prepare('UPDATE wa_messages SET raw=? WHERE id=?')
        .run(JSON.stringify(refreshed.message), messageId);
      return downloadMediaToDisk(session, messageId, refreshed);
    }
  }

  // Ohne Original geht nichts: updateMediaMessage kann nur eine abgelaufene URL
  // erneuern, nicht eine Datei beschaffen, deren Beschreibung fehlt. Diese
  // Nachrichten stammen aus einem Verlaufs-Abgleich, bei dem das Original noch
  // nicht mitgespeichert wurde – das ist inzwischen behoben, hilft aber nur für
  // alles ab dann.
  throw new Error(
    'Diese Datei wurde nie mitgespeichert. Sie stammt aus einem Verlaufs-Abgleich von vor der '
    + 'Korrektur – nachträglich lässt sie sich nicht holen. Neue Medien werden gespeichert; '
    + 'für die alten hilft nur ein erneutes Koppeln, dann kommt der Verlauf samt Medien neu.');
}

/* ---------------------------------------------------------------- Sitzung */

export async function startSession(id, { method = 'qr', phone = null } = {}) {
  const account = db.getWaAccount(id);
  if (!account) throw new Error('WhatsApp-Konto nicht gefunden');

  const existing = sessions.get(id);
  if (existing?.starting) return sessionStatus(id);
  if (existing?.sock && existing.status === 'connected') return sessionStatus(id);
  if (existing) await stopSession(id);

  const authDir = ensureDirs(id);
  const session = {
    id, status: 'connecting', starting: true, attempts: existing?.attempts || 0,
    method, phone, sock: null, lock: null, stopping: false,
    sendQueue: Promise.resolve(), pairingRequested: false, jid: account.jid,
  };
  sessions.set(id, session);

  try {
    session.lock = acquireLock(id);
    const { state, saveCreds } = await loadAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      logger,
      browser: Browsers.appropriate('Relay'),
      // true würde Push-Nachrichten auf den "Web-Client" umleiten – das Handy
      // hört dann auf zu klingeln. Genau das will hier niemand.
      markOnlineOnConnect: false,
      // NUR wenn schon eine Identität existiert. Fordert ein noch nicht
      // gekoppelter Client den vollen Verlauf an, bricht WhatsApp die
      // Verbindung mit 428 ab – bevor überhaupt ein QR-Code entsteht.
      // Nach dem Koppeln verlangt WhatsApp ohnehin einen Neustart (515), und
      // genau bei dem greift die Einstellung dann.
      syncFullHistory: !!account.sync_full_history && !!state.creds?.me,
      generateHighQualityLinkPreview: false,
      shouldSyncHistoryMessage: () => true,
      getMessage: async key => db.getWaRawMessage(id, key.remoteJid, key.id),
    });
    session.sock = sock;
    session.authDir = authDir;
    session.saveCreds = saveCreds;

    // Direkt die Referenz, KEIN Wrapper: creds.update feuert während des
    // Verlaufs-Syncs hunderte Male. Alles, was hier zusätzlich passiert,
    // verzögert das Speichern der Zugangsdaten – und dann kappt WhatsApp die
    // Verbindung. Die Dateirechte erledigt die umask beim Serverstart
    // (siehe src/harden.js), nicht dieser Pfad.
    sock.ev.on('creds.update', saveCreds);
    wireEvents(session, sock, authDir);
    setStatus(session, 'connecting');
  } catch (e) {
    releaseLock(session);
    // Nur aufräumen, wenn in der Zwischenzeit keine andere Sitzung hochgekommen ist –
    // sonst reißt ein fehlgeschlagener zweiter Anlauf die funktionierende erste mit.
    if (sessions.get(id) === session) {
      sessions.delete(id);
      const live = db.getWaAccount(id);
      if (live?.status !== 'connected') db.setWaAccountStatus(id, 'logged_out', { error: e.message });
    }
    emit('status', listSessions());
    throw e;
  } finally {
    session.starting = false;
  }
  return sessionStatus(id);
}

function wireEvents(session, sock, authDir) {
  const guard = fn => async (...args) => {
    // Ein Fehler in einem Handler darf niemals den Serverprozess mitreißen.
    try { await fn(...args); } catch (e) { log('Handler-Fehler:', e.stack || e.message); }
  };

  sock.ev.on('connection.update', guard(async u => {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      // hasCreds: schon eine Identität vorhanden → wir sind mitten in einer
      // laufenden Kopplung oder Wiederanmeldung. Dann NIE einen neuen Code holen.
      const hasCreds = !!sock.authState?.creds?.me;
      if (session.method === 'pairing' && session.phone && !session.pairingRequested && !hasCreds) {
        // requestPairingCode geht erst, wenn der Socket offen ist – der erste
        // QR-Event ist der zuverlässigste Zeitpunkt dafür.
        session.pairingRequested = true;
        try {
          const code = await sock.requestPairingCode(String(session.phone).replace(/\D/g, ''));
          const pretty = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
          setStatus(session, 'pairing');
          emit('pairing_code', { wa_account_id: session.id, code: pretty, phone: session.phone });
        } catch (e) {
          log('Pairing-Code fehlgeschlagen:', e.message);
          emit('qr', { wa_account_id: session.id, qr_svg: qrDataUrl(qr), expires_in: 20 });
          setStatus(session, 'pairing');
        }
      } else {
        setStatus(session, 'pairing');
        emit('qr', { wa_account_id: session.id, qr_svg: qrDataUrl(qr), expires_in: 20 });
      }
    }

    if (connection === 'open') {
      session.attempts = 0;
      session.jid = jidNormalizedUser(sock.user?.id);
      backupCreds(authDir);
      setStatus(session, 'connected', {
        jid: session.jid, phone: phoneOf(session.jid), push_name: sock.user?.name || null,
        error: null,
      });
      log(`verbunden als ${session.jid}`);
      // Gruppennamen einmalig nachziehen – sonst heißen sie bis zur ersten
      // Nachricht nur "120363…@g.us".
      setTimeout(() => {
        syncAllGroups(session.id).catch(e => log('Gruppen-Abgleich:', e.message));
      }, 8000);
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (session.stopping) return;

      if (code === DisconnectReason.loggedOut) {
        setStatus(session, 'logged_out', { error: 'Gerät wurde in WhatsApp abgemeldet' });
        await stopSession(session.id);
        return;
      }
      if (code === DisconnectReason.connectionReplaced) {
        // Eine andere Sitzung hat übernommen. Neu verbinden würde in eine
        // Endlosschleife führen, in der sich beide gegenseitig rauswerfen.
        setStatus(session, 'conflict', { error: 'Eine andere WhatsApp-Web-Sitzung hat übernommen' });
        await stopSession(session.id);
        return;
      }
      if (code === DisconnectReason.forbidden) {
        setStatus(session, 'banned', { error: 'WhatsApp hat diese Nummer gesperrt' });
        await stopSession(session.id);
        return;
      }

      const immediate = code === DisconnectReason.restartRequired;
      // Während des Koppelns steht ein Mensch vor dem Bildschirm und wartet auf
      // einen Code. Minutenlange Wartezeiten sind hier sinnlos: entweder schnell
      // ein neuer Versuch mit frischem QR – oder aufhören und es sagen.
      const pairing = !sock.authState?.creds?.me;
      if (pairing && session.attempts >= 5) {
        setStatus(session, 'logged_out', {
          error: 'WhatsApp bricht die Verbindung beim Koppeln ab. Das passiert meist nach zu '
            + 'vielen Versuchen kurz hintereinander – bitte ein paar Minuten warten und erneut versuchen.',
        });
        await stopSession(session.id);
        return;
      }
      const wait = immediate ? 0
        : pairing ? 2000
          : Math.min(300_000, 2000 * 2 ** Math.min(session.attempts, 7)) * (0.8 + Math.random() * 0.4);
      session.attempts++;
      setStatus(session, 'connecting', { error: immediate ? null : `Verbindung getrennt (${code ?? '?'})` });
      log(`getrennt (${code ?? '?'}) – neuer Versuch in ${Math.round(wait / 1000)}s`);

      // Alten Socket loslassen, sonst verdoppeln sich die Handler bei jedem Neuaufbau.
      try { sock.ev.removeAllListeners(); } catch { /* egal */ }
      session.sock = null;
      // OHNE method/phone: nach dem Koppeln verlangt WhatsApp genau einen
      // Neustart (515). Würden wir dabei erneut einen Kopplungs-Code anfordern,
      // machten wir die eben erfolgte Kopplung wieder ungültig – und landeten
      // in einer Schleife aus halb registrierten Sitzungen.
      session.reconnectTimer = setTimeout(() => {
        startSession(session.id)
          .catch(e => log('Neuverbindung fehlgeschlagen:', e.message));
      }, wait);
    }
  }));

  sock.ev.on('messages.upsert', guard(async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;
    for (const msg of messages) {
      // Reaktionen sind keine Gesprächsbeiträge, sondern gehören an die
      // Nachricht, auf die sie zeigen – sonst zerreißt es den Verlauf.
      const react = msg.message?.reactionMessage;
      if (react?.key?.id) {
        const chatJid = msg.key.remoteJid;
        db.setWaReaction({
          wa_account_id: session.id,
          chat_jid: chatJid,
          target_wa_id: react.key.id,
          sender_jid: msg.key.participant || (msg.key.fromMe ? session.jid : chatJid),
          from_me: msg.key.fromMe ? 1 : 0,
          emoji: react.text || '',
          ts: Number(msg.messageTimestamp?.low ?? msg.messageTimestamp ?? 0) || nowSec(),
        });
        const chat = db.getWaChatByJid(session.id, chatJid);
        if (chat) emit('reaction', {
          chat_id: chat.id, target_wa_id: react.key.id,
          reactions: db.waReactionsFor(session.id, chatJid, [react.key.id])[react.key.id] || [],
        });
        continue;
      }

      const row = toRow(session, msg);
      if (!row) continue;
      const { _msg, ...clean } = row;
      const added = db.insertWaMessages([clean]);
      if (!added) continue;

      const stored = db.getWaMessageByWaId(session.id, clean.chat_jid, clean.wa_id);
      if (!clean.from_me) {
        const chat = db.getWaChat(clean.chat_id);
        db.setWaChatUnread(clean.chat_id, (chat?.unread || 0) + 1);
      }
      emit('message', { ...db.getWaChat(clean.chat_id), message: stored });
      if (stored) await maybeDownloadMedia(session, row, stored.id);
    }
  }));

  sock.ev.on('messages.update', guard(updates => {
    for (const u of updates) {
      const s = u.update?.status;
      if (s == null || !u.key?.id) continue;
      // Baileys-Status: 2=sent 3=delivered 4=read 5=played
      const map = { 2: 'sent', 3: 'delivered', 4: 'read', 5: 'read' };
      if (map[s]) db.updateWaMessageStatus(session.id, u.key.remoteJid, u.key.id, map[s]);
    }
  }));

  sock.ev.on('chats.update', guard(updates => {
    for (const c of updates) {
      if (!c.id) continue;
      const chat = db.getWaChatByJid(session.id, c.id);
      if (chat && c.unreadCount != null) {
        db.setWaChatUnread(chat.id, c.unreadCount);
        emit('chat', db.getWaChat(chat.id));
      }
    }
  }));

  // Neue Gruppe oder Betreff/Teilnehmer geändert.
  sock.ev.on('groups.upsert', guard(async groups => {
    for (const g of groups) {
      if (!g.id) continue;
      db.upsertWaChat(session.id, { jid: g.id, name: g.subject || null, is_group: 1 });
      const chat = db.getWaChatByJid(session.id, g.id);
      if (chat) {
        db.setWaGroupMeta(chat.id, {
          name: g.subject || null,
          participants: (g.participants || []).map(p => ({ jid: p.id, phone: phoneOf(p.id), admin: p.admin || null })),
        });
        emit('chat', db.getWaChat(chat.id));
      }
    }
  }));

  sock.ev.on('groups.update', guard(async updates => {
    for (const g of updates) {
      if (!g.id) continue;
      if (g.subject) db.upsertWaChat(session.id, { jid: g.id, name: g.subject, is_group: 1 });
      // Teilnehmerliste kommt hier nicht mit – nur nachziehen, wenn wir sie schon hatten.
      const chat = db.getWaChatByJid(session.id, g.id);
      if (chat?.meta_synced_at) queueGroupMeta(session, g.id);
      if (chat) emit('chat', db.getWaChat(chat.id));
    }
  }));

  sock.ev.on('group-participants.update', guard(async ({ id }) => {
    if (id) queueGroupMeta(session, id);
  }));

  // Die Namen aus dem Telefonbuch kommen über contacts.update beim
  // App-State-Abgleich – NICHT über contacts.upsert. Ohne diesen Handler
  // bleibt jeder Kontakt namenlos.
  const saveContacts = list => db.tx(() => {
    for (const c of list) {
      if (!c.id) continue;
      db.upsertWaContact(session.id, {
        jid: c.id, phone: phoneOf(c.id),
        push_name: c.notify || null,
        name: c.name || c.verifiedName || null,
        is_group: isJidGroup(c.id) ? 1 : 0,
      });
      // Einzelchats zeigen sonst nur die nackte Kennung.
      if (!isJidGroup(c.id)) {
        const nice = c.name || c.verifiedName || c.notify;
        if (nice) db.upsertWaChat(session.id, { jid: c.id, name: nice, is_group: 0 });
      }
    }
  });

  sock.ev.on('contacts.update', guard(updates => {
    saveContacts(updates);
    emit('status', listSessions());
  }));

  sock.ev.on('chats.upsert', guard(chats => db.tx(() => {
    for (const c of chats) {
      if (!c.id) continue;
      db.upsertWaChat(session.id, {
        jid: c.id, name: c.name || null, is_group: isJidGroup(c.id),
        unread: c.unreadCount ?? null,
        last_message_ts: c.conversationTimestamp ? Number(c.conversationTimestamp) : null,
      });
    }
  })));

  sock.ev.on('contacts.upsert', guard(contacts => saveContacts(contacts)));

  sock.ev.on('messaging-history.set', guard(({ chats, contacts, messages, isLatest, progress }) => {
    let added = 0;
    db.tx(() => {
      for (const c of chats || []) {
        if (!c.id) continue;
        db.upsertWaChat(session.id, {
          jid: c.id, name: c.name || null, is_group: isJidGroup(c.id),
          unread: c.unreadCount ?? null, archived: c.archived ?? null,
          last_message_ts: c.conversationTimestamp ? Number(c.conversationTimestamp) : null,
        });
      }
      for (const c of contacts || []) {
        if (!c.id) continue;
        db.upsertWaContact(session.id, {
          jid: c.id, phone: phoneOf(c.id), push_name: c.notify || null,
          name: c.name || c.verifiedName || null, is_group: isJidGroup(c.id) ? 1 : 0,
        });
        const nice = c.name || c.verifiedName || c.notify;
        if (nice && !isJidGroup(c.id)) db.upsertWaChat(session.id, { jid: c.id, name: nice, is_group: 0 });
      }
      const rows = [];
      for (const msg of messages || []) {
        const row = toRow(session, msg);
        if (row) { const { _msg, ...clean } = row; rows.push(clean); }
      }
      // In Blöcken, damit eine einzelne Transaktion nicht ewig die Schreibsperre hält.
      for (let i = 0; i < rows.length; i += 500) added += db.insertWaMessages(rows.slice(i, i + 500));
    });
    emit('sync', {
      wa_account_id: session.id, phase: 'history',
      progress: progress ?? null, chats: (chats || []).length, messages: added, done: !!isLatest,
    });
    if (isLatest) {
      db.setWaHistoryDone(session.id, true);
      try { db.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* egal */ }
      log(`Verlaufs-Sync abgeschlossen (${added} neue Nachrichten)`);
    }
  }));
}

function qrDataUrl(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const svg = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
  return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
}

/** Trennt die Verbindung. logout=true meldet das Gerät bei WhatsApp ab. */
export async function stopSession(id, { logout = false } = {}) {
  const session = sessions.get(id);
  if (session) {
    session.stopping = true;
    clearTimeout(session.reconnectTimer);
    try {
      if (logout && session.sock) await session.sock.logout();
      else if (session.sock) session.sock.end(undefined);
    } catch { /* Socket war schon tot */ }
    try { session.sock?.ev.removeAllListeners(); } catch { /* egal */ }
    if (session.saveCreds) { try { await session.saveCreds(); } catch { /* egal */ } }
    if (session.authDir) backupCreds(session.authDir);
    releaseLock(session);
    sessions.delete(id);
  }
  if (logout) {
    fs.rmSync(path.join(WA_DIR, String(id), 'auth'), { recursive: true, force: true });
    db.setWaAccountStatus(id, 'logged_out', { error: null, jid: null, phone: null });
    db.setWaHistoryDone(id, false);
  } else if (db.getWaAccount(id)) {
    const cur = db.getWaAccount(id);
    if (cur.status !== 'logged_out' && cur.status !== 'conflict' && cur.status !== 'banned') {
      db.setWaAccountStatus(id, 'logged_out');
    }
  }
  emit('status', listSessions());
  return sessionStatus(id);
}

/**
 * Kopplung hart zurücksetzen. Anders als logout() braucht das KEINE
 * funktionierende Verbindung – genau dafür ist es da: wenn die Sitzung in
 * einem kaputten Zwischenzustand hängt und nichts mehr geht.
 */
export async function resetSession(id) {
  const session = sessions.get(id);
  if (session) {
    session.stopping = true;
    clearTimeout(session.reconnectTimer);
    try { session.sock?.end(undefined); } catch { /* egal */ }
    try { session.sock?.ev.removeAllListeners(); } catch { /* egal */ }
    releaseLock(session);
    sessions.delete(id);
  }
  // Verwaiste Sperre eines abgestürzten Vorgängers mit wegräumen.
  try { fs.rmSync(path.join(WA_DIR, String(id), 'session.lock'), { force: true }); } catch { /* egal */ }
  fs.rmSync(path.join(WA_DIR, String(id), 'auth'), { recursive: true, force: true });
  db.setWaAccountStatus(id, 'logged_out', { error: null, jid: null, phone: null });
  db.setWaHistoryDone(id, false);
  emit('status', listSessions());
  log(`Kopplung für Konto ${id} zurückgesetzt`);
  return sessionStatus(id);
}

export async function shutdownAll() {
  for (const id of [...sessions.keys()]) {
    const s = sessions.get(id);
    if (s) s.stopping = true;
    clearTimeout(s?.reconnectTimer);
    try { s?.sock?.end(undefined); } catch { /* egal */ }
    if (s?.saveCreds) { try { await s.saveCreds(); } catch { /* egal */ } }
    if (s?.authDir) backupCreds(s.authDir);
    releaseLock(s);
    sessions.delete(id);
  }
}

/**
 * Telefonbuch-Namen erneut vom Telefon holen.
 *
 * WhatsApp schickt die Namen nur beim ersten App-State-Abgleich nach dem
 * Koppeln – ein Neustart holt sie NICHT nach, es kommen nur Änderungen.
 * resyncAppState fordert die Sammlungen komplett neu an.
 */
export async function resyncContacts(id) {
  const session = sessions.get(id);
  if (!session?.sock || session.status !== 'connected') {
    throw new Error('WhatsApp ist nicht verbunden');
  }
  const before = db.listWaContacts({ waAccountId: id, limit: 5000 })
    .filter(c => c.name || c.push_name).length;
  await session.sock.resyncAppState(
    ['critical_block', 'critical_unblock_low', 'regular_high', 'regular_low', 'regular'], false);
  // Die Namen trudeln über contacts.update ein – kurz Zeit lassen.
  await sleep(6000);
  const after = db.listWaContacts({ waAccountId: id, limit: 5000 })
    .filter(c => c.name || c.push_name).length;
  log(`Namens-Abgleich: ${before} → ${after} Kontakte mit Namen`);
  emit('status', listSessions());
  return { before, after, added: after - before };
}

/** Beim Serverstart: Konten mit gültiger Kopplung wieder verbinden. */
/** Räumt beim Start einmal auf und danach täglich. */
export function startMediaCleanup() {
  try { cleanupMedia(); } catch (e) { log('Aufräumen:', e.message); }
  const t = setInterval(() => {
    try { cleanupMedia(); } catch (e) { log('Aufräumen:', e.message); }
  }, 24 * 3600 * 1000);
  t.unref();
}

export async function autostart() {
  if (process.env.WA_AUTOSTART === '0') return;
  for (const a of db.listWaAccounts()) {
    if (!a.autostart) continue;
    const creds = path.join(WA_DIR, String(a.id), 'auth', 'creds.json');
    if (!fs.existsSync(creds)) continue;
    try { await startSession(a.id); }
    catch (e) { log(`Autostart für Konto ${a.id} fehlgeschlagen:`, e.message); }
  }
}

/* ----------------------------------------------------------------- Senden */

function assertConnected(id) {
  const session = sessions.get(id);
  if (!session?.sock || session.status !== 'connected') {
    throw new Error('WhatsApp ist nicht verbunden');
  }
  return session;
}

/** Prüft, ob eine Nummer überhaupt bei WhatsApp registriert ist. */
export async function resolveJid(id, phone) {
  const session = assertConnected(id);
  const digits = String(phone).replace(/\D/g, '');
  const [hit] = await session.sock.onWhatsApp(digits + '@s.whatsapp.net');
  return hit?.exists ? jidNormalizedUser(hit.jid) : null;
}

/**
 * Sendet Text. Läuft pro Konto in einer Warteschlange mit menschlicher Pause –
 * gleichmäßige Sekundentakte sind eines der Muster, an denen WhatsApp
 * automatisierte Clients erkennt.
 */
export async function sendText(id, jid, text, { quotedWaId = null, origin = 'ui' } = {}) {
  const session = assertConnected(id);
  const account = db.getWaAccount(id);

  const sent = db.waSentLastHour(id);
  if (sent >= (account.send_per_hour || 30)) {
    throw new Error(`Stundenlimit erreicht (${sent}/${account.send_per_hour}) – Schutz vor Nummernsperre`);
  }

  const run = async () => {
    await sleep(800 + Math.random() * 800);
    let quoted;
    if (quotedWaId) {
      const q = db.getWaMessageByWaId(id, jid, quotedWaId);
      if (q?.raw) quoted = { key: { remoteJid: jid, id: q.wa_id, fromMe: !!q.from_me }, message: JSON.parse(q.raw) };
    }
    const res = await session.sock.sendMessage(jid, { text }, quoted ? { quoted } : {});
    const row = toRow(session, res, { origin });
    if (row) {
      const { _msg, ...clean } = row;
      db.insertWaMessages([clean]);
      const stored = db.getWaMessageByWaId(id, clean.chat_jid, clean.wa_id);
      emit('message', { ...db.getWaChat(clean.chat_id), message: stored });
      return stored;
    }
    return null;
  };

  session.sendQueue = session.sendQueue.then(run, run);
  return session.sendQueue;
}

/**
 * Sticker senden.
 *
 * WhatsApp verlangt WebP, quadratisch, 512×512. Umgerechnet wird im BROWSER
 * (Canvas kann WebP ausgeben) – dadurch bleibt der Server frei von sharp oder
 * jimp, also von nativen Modulen. Hier kommt nur noch fertiges WebP an.
 */
export async function sendSticker(id, jid, base64, { origin = 'ui' } = {}) {
  const session = assertConnected(id);
  const buf = Buffer.from(String(base64).replace(/^data:[^,]+,/, ''), 'base64');
  if (!buf.length) throw new Error('Leeres Bild');
  if (buf.length > 1024 * 1024) {
    throw new Error(`Sticker ist ${(buf.length / 1024).toFixed(0)} KB – WhatsApp mag höchstens etwa 1 MB`);
  }
  // RIFF….WEBP – schnelle Gegenprobe, damit kein PNG als Sticker durchrutscht.
  if (buf.subarray(0, 4).toString() !== 'RIFF' || buf.subarray(8, 12).toString() !== 'WEBP') {
    throw new Error('Sticker muss im WebP-Format vorliegen');
  }

  const run = async () => {
    await sleep(600 + Math.random() * 600);
    const res = await session.sock.sendMessage(jid, { sticker: buf });
    const row = toRow(session, res, { origin });
    if (!row) return null;
    const { _msg, ...clean } = row;
    db.insertWaMessages([clean]);
    const stored = db.getWaMessageByWaId(id, clean.chat_jid, clean.wa_id);
    emit('message', { ...db.getWaChat(clean.chat_id), message: stored });
    return stored;
  };
  session.sendQueue = session.sendQueue.then(run, run);
  return session.sendQueue;
}

/**
 * Auf eine Nachricht reagieren. Leerer Text nimmt die Reaktion zurück –
 * so macht es WhatsApp selbst auch.
 */
export async function sendReaction(id, chatJid, targetWaId, emoji) {
  const session = assertConnected(id);
  const target = db.getWaMessageByWaId(id, chatJid, targetWaId);
  if (!target) throw new Error('Nachricht nicht gefunden');

  const key = {
    remoteJid: chatJid,
    id: targetWaId,
    fromMe: !!target.from_me,
    ...(chatJid.endsWith('@g.us') && target.sender_jid ? { participant: target.sender_jid } : {}),
  };
  await session.sock.sendMessage(chatJid, { react: { text: emoji || '', key } });

  db.setWaReaction({
    wa_account_id: id, chat_jid: chatJid, target_wa_id: targetWaId,
    sender_jid: session.jid, from_me: 1, emoji: emoji || '', ts: nowSec(),
  });
  const chat = db.getWaChatByJid(id, chatJid);
  const reactions = db.waReactionsFor(id, chatJid, [targetWaId])[targetWaId] || [];
  if (chat) emit('reaction', { chat_id: chat.id, target_wa_id: targetWaId, reactions });
  return { ok: true, reactions };
}

/** Lesebestätigungen für einen Chat senden und lokal auf gelesen setzen. */
export async function markRead(id, chatId) {
  const chat = db.getWaChat(chatId);
  if (!chat) throw new Error('Chat nicht gefunden');
  db.setWaChatUnread(chatId, 0);
  emit('chat', db.getWaChat(chatId));
  const session = sessions.get(id);
  if (!session?.sock || session.status !== 'connected') return { ok: true, remote: false };
  const unread = db.listWaMessages({ chatId, limit: 20 }).filter(m => !m.from_me);
  if (unread.length) {
    try {
      await session.sock.readMessages(unread.map(m => ({
        remoteJid: chat.jid, id: m.wa_id, participant: chat.is_group ? m.sender_jid : undefined,
      })));
    } catch (e) { log('Lesebestätigung fehlgeschlagen:', e.message); }
  }
  return { ok: true, remote: true };
}

/**
 * Ältere Nachrichten nachladen.
 *
 * Ehrlichkeitshinweis: WhatsApp liefert hier nur, was das Telefon noch hat und
 * herausrücken will – 50 Nachrichten pro Anfrage, mit Rate-Limit, und manchmal
 * kommt schlicht nichts. Deshalb `complete` im Ergebnis.
 */
export async function backfillChat(id, chatId, { days = 90, maxRounds = 10 } = {}) {
  const session = assertConnected(id);
  const chat = db.getWaChat(chatId);
  if (!chat) throw new Error('Chat nicht gefunden');
  const untilTs = nowSec() - days * 86400;

  let rounds = 0, emptyRounds = 0, addedTotal = 0, complete = false;
  while (rounds < Math.min(maxRounds, 40)) {
    const oldest = db.oldestWaMessage(chatId);
    if (!oldest) break;
    if (oldest.ts <= untilTs) { complete = true; break; }

    const before = db.listWaMessages({ chatId, limit: 1 }).length;
    try {
      await session.sock.fetchMessageHistory(50,
        { remoteJid: chat.jid, id: oldest.wa_id, fromMe: !!oldest.from_me }, oldest.ts);
    } catch (e) {
      log('fetchMessageHistory:', e.message);
      break;
    }
    // Die Antwort kommt asynchron als messaging-history.set – kurz warten.
    await sleep(4000);
    const nowOldest = db.oldestWaMessage(chatId);
    const added = nowOldest && nowOldest.ts < oldest.ts ? 1 : 0;
    addedTotal += added ? 1 : 0;
    emptyRounds = added ? 0 : emptyRounds + 1;
    if (emptyRounds >= 3) break;
    rounds++;
    void before;
    await sleep(1500);
  }

  const oldest = db.oldestWaMessage(chatId);
  if (oldest) db.setWaChatOldest(chatId, oldest.ts);
  return {
    requested_days: days,
    oldest_reached: oldest ? new Date(oldest.ts * 1000).toISOString() : null,
    rounds, complete,
    note: 'WhatsApp liefert Verlauf nur, soweit das Telefon ihn hergibt – mehrfaches Nachladen kann helfen.',
  };
}
