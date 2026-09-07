/**
 * Sprachnachrichten in Text: spricht einen OpenAI-kompatiblen Transkriptions-
 * Dienst an (POST /audio/transcriptions). Das kann ein lokaler Whisper-Server
 * sein (im Compose der Dienst „whisper", speaches mit faster-whisper) oder die
 * OpenAI-API selbst – der Code ist derselbe, nur URL, Schlüssel und Modell
 * unterscheiden sich.
 *
 * Bewusst ohne eigenes Whisper im Node-Prozess: das wäre ein natives Modul,
 * und Sprachnachrichten transkribieren darf den Web-Server nicht blockieren.
 *
 *   MAIL_TRANSCRIBE_URL    Basis-URL, z.B. http://whisper:8000/v1 oder https://api.openai.com/v1
 *   MAIL_TRANSCRIBE_KEY    Bearer-Token (bei OpenAI Pflicht, lokal leer)
 *   MAIL_TRANSCRIBE_MODEL  z.B. Systran/faster-whisper-small (speaches) oder whisper-1 (OpenAI)
 *   MAIL_TRANSCRIBE_LANG   Sprachcode, Standard de; leer = automatisch erkennen
 */
import { openAsBlob } from 'node:fs';
import path from 'node:path';

export function transcribeConfig() {
  return {
    url: String(process.env.MAIL_TRANSCRIBE_URL || '').replace(/\/+$/, ''),
    key: process.env.MAIL_TRANSCRIBE_KEY || '',
    model: process.env.MAIL_TRANSCRIBE_MODEL || 'Systran/faster-whisper-small',
    lang: process.env.MAIL_TRANSCRIBE_LANG === undefined ? 'de' : process.env.MAIL_TRANSCRIBE_LANG,
  };
}

export const transcriptionEnabled = () => !!transcribeConfig().url;

const headers = cfg => (cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {});

/**
 * Datei transkribieren. Liefert den Text (getrimmt) oder wirft mit einer
 * Meldung, die dem Nutzer sagt, woran es liegt.
 */
export async function transcribeFile(filePath, mime = 'audio/ogg', { timeoutMs = 5 * 60_000 } = {}) {
  const cfg = transcribeConfig();
  if (!cfg.url) throw new Error('Transkription nicht konfiguriert (MAIL_TRANSCRIBE_URL fehlt)');

  const form = new FormData();
  // WhatsApp-Sprachnachrichten sind Opus im Ogg-Container; die Endung hilft
  // Diensten, die den Typ am Namen erkennen.
  const ext = /ogg|opus/.test(mime) ? '.ogg' : (path.extname(filePath) || '.bin');
  form.append('file', await openAsBlob(filePath, { type: mime }), `audio${ext}`);
  form.append('model', cfg.model);
  form.append('response_format', 'json');
  if (cfg.lang) form.append('language', cfg.lang);

  let res;
  try {
    res = await fetch(`${cfg.url}/audio/transcriptions`, {
      method: 'POST', headers: headers(cfg), body: form, signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new Error(`Transkriptions-Dienst nicht erreichbar (${cfg.url}): ${e.message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try { msg = JSON.parse(text).error?.message || JSON.parse(text).detail || msg; } catch { /* Rohtext */ }
    throw new Error(`Transkription fehlgeschlagen (HTTP ${res.status}): ${msg}`);
  }
  let out = text;
  try { out = JSON.parse(text).text ?? text; } catch { /* der Dienst hat Klartext geschickt */ }
  return String(out || '').trim();
}

/**
 * Modell beim Dienst anfordern (speaches lädt es dann aus dem Hugging-Face-Hub).
 * Andere Dienste kennen den Aufruf nicht – dann ist das kein Fehler.
 */
export async function ensureModel() {
  const cfg = transcribeConfig();
  if (!cfg.url) return { ok: false, reason: 'nicht konfiguriert' };
  try {
    const r = await fetch(`${cfg.url}/models/${encodeURIComponent(cfg.model)}`, {
      method: 'POST', headers: headers(cfg), signal: AbortSignal.timeout(10 * 60_000),
    });
    return { ok: r.ok || r.status === 409 || r.status === 405 || r.status === 404, status: r.status };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/** Für die Oberfläche: konfiguriert? erreichbar? Modell da? */
export async function transcriberStatus() {
  const cfg = transcribeConfig();
  const out = { enabled: !!cfg.url, url: cfg.url || null, model: cfg.model, language: cfg.lang || 'auto',
    reachable: false, model_ready: null, error: null };
  if (!cfg.url) return out;
  try {
    const r = await fetch(`${cfg.url}/models`, { headers: headers(cfg), signal: AbortSignal.timeout(8000) });
    out.reachable = r.ok;
    if (r.ok) {
      const j = await r.json().catch(() => null);
      const ids = (j?.data || []).map(m => m.id);
      out.model_ready = ids.length ? ids.includes(cfg.model) : null;
    } else {
      out.error = `HTTP ${r.status}`;
    }
  } catch (e) {
    out.error = e.message;
  }
  return out;
}
