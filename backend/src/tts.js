/**
 * Text → Sprache mit geklonter Stimme über einen Voicebox-Dienst.
 *
 * Gegenstück zu transcribe.js: dort wird aus einer Sprachnachricht Text, hier
 * aus Text eine Sprachnachricht. Der Dienst läuft auf einer GPU-Maschine und
 * liefert WAV; die Umwandlung ins WhatsApp-Format (Ogg/Opus) macht danach
 * whatsapp.js mit ffmpeg. Kein Modell im Node-Prozess – das wäre ein natives
 * Schwergewicht und würde den Web-Server minutenlang blockieren.
 *
 *   VOICE_URL         Basis-URL, z.B. https://voice.example.com
 *   VOICE_USER        HTTP-Basic-Auth vor dem Dienst (Reverse-Proxy)
 *   VOICE_PASS
 *   VOICE_PROFILE_ID  Stimmprofil (die geklonte Stimme) für alle Aufrufe ohne eigenes
 *   VOICE_LANGUAGE    Sprachcode, Standard de
 *   VOICE_ENGINE      TTS-Modell in Voicebox (qwen, chatterbox …), Standard: das des Profils
 *   VOICE_RVC         1 = Ergebnis zusätzlich durch RVC (${VOICE_URL}/rvc/convert) schicken.
 *                     Das TTS liefert Sprechweise und Betonung, RVC die echte Klangfarbe –
 *                     der Zero-Shot-Klon allein klingt nur ungefähr nach der Person.
 */

/** Längere Texte werden zur Hörbuch-Sprachnachricht – und blockieren die GPU. */
export const TTS_MAX_CHARS = 1500;

export function ttsConfig() {
  return {
    url: String(process.env.VOICE_URL || '').trim().replace(/\/+$/, ''),
    user: process.env.VOICE_USER || '',
    pass: process.env.VOICE_PASS || '',
    profileId: process.env.VOICE_PROFILE_ID || '',
    language: process.env.VOICE_LANGUAGE || 'de',
    engine: process.env.VOICE_ENGINE || '',
    rvc: process.env.VOICE_RVC === '1',
  };
}

export const ttsEnabled = () => !!ttsConfig().url;

/**
 * Text vorlesen lassen. Liefert das WAV als Buffer oder wirft mit einer
 * Meldung, die sagt, woran es lag (Status und Anfang der Antwort).
 *
 * Großzügiges Zeitlimit: Die Erzeugung läuft auf der GPU, und nach einer
 * Ruhepause muss der Dienst das Modell erst wieder laden – das allein kann
 * eine Minute dauern.
 */
export async function synthesize(text, { profileId, language, timeoutMs = 180_000 } = {}) {
  const cfg = ttsConfig();
  if (!cfg.url) throw new Error('Sprachausgabe nicht konfiguriert (VOICE_URL fehlt)');
  const t = String(text || '').trim();
  if (!t) throw new Error('Text zum Vorlesen fehlt');
  if (t.length > TTS_MAX_CHARS) {
    throw new Error(`Text ist ${t.length} Zeichen lang – höchstens ${TTS_MAX_CHARS} für eine Sprachnachricht`);
  }
  const profile = profileId || cfg.profileId;
  if (!profile) throw new Error('Kein Stimmprofil angegeben (profile_id oder VOICE_PROFILE_ID)');

  const headers = { 'Content-Type': 'application/json', Accept: 'audio/wav, audio/*' };
  if (cfg.user || cfg.pass) {
    headers.Authorization = 'Basic ' + Buffer.from(`${cfg.user}:${cfg.pass}`).toString('base64');
  }

  let res;
  try {
    res = await fetch(`${cfg.url}/generate/stream`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        profile_id: profile, text: t, language: language || cfg.language,
        ...(cfg.engine ? { engine: cfg.engine } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
      // Keine Weiterleitungen: sonst ginge der Basic-Auth-Header womöglich an ein anderes Ziel.
      redirect: 'error',
    });
  } catch (e) {
    const why = e.name === 'TimeoutError' ? `keine Antwort nach ${Math.round(timeoutMs / 1000)} s` : e.message;
    throw new Error(`Sprachdienst nicht erreichbar (${cfg.url}): ${why}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (!res.ok) {
    let msg = buf.toString('utf8', 0, Math.min(buf.length, 400)).trim();
    try { const j = JSON.parse(buf.toString('utf8')); msg = j.detail || j.error?.message || j.error || msg; } catch { /* Rohtext */ }
    if (typeof msg !== 'string') msg = JSON.stringify(msg).slice(0, 400);
    throw new Error(`Sprachausgabe fehlgeschlagen (HTTP ${res.status}): ${msg}`);
  }
  if (!buf.length) throw new Error('Sprachdienst hat leeres Audio geliefert');
  return cfg.rvc ? convertVoice(buf, { headers, timeoutMs }) : buf;
}

/** WAV durch RVC schicken – gleiche Basis-URL und Zugangsdaten wie Voicebox. */
async function convertVoice(wav, { headers, timeoutMs }) {
  const cfg = ttsConfig();
  let res;
  try {
    res = await fetch(`${cfg.url}/rvc/convert`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'audio/wav' },
      body: wav,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
  } catch (e) {
    const why = e.name === 'TimeoutError' ? `keine Antwort nach ${Math.round(timeoutMs / 1000)} s` : e.message;
    throw new Error(`Stimmumwandlung (RVC) nicht erreichbar: ${why}`);
  }
  const out = Buffer.from(await res.arrayBuffer());
  if (!res.ok) {
    throw new Error(`Stimmumwandlung (RVC) fehlgeschlagen (HTTP ${res.status}): ${out.toString('utf8', 0, Math.min(out.length, 400))}`);
  }
  if (!out.length) throw new Error('RVC hat leeres Audio geliefert');
  return out;
}
