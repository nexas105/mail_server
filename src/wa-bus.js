/**
 * Winziger Ereignis-Bus für den WhatsApp-Live-Stream (Server-Sent Events).
 *
 * Bewusst ein eigenes Modul ohne Abhängigkeiten: server.js braucht subscribe()
 * für die SSE-Route, whatsapp.js braucht emit() – und so bleibt der Stream
 * testbar, ohne dass Baileys überhaupt geladen ist.
 *
 * Unterschied zum bestehenden Sende-Stream in server.js: der hier lebt, solange
 * der Browser die Verbindung offen hält, nicht nur für die Dauer einer Aktion.
 */

const subscribers = new Set();

/** Trägt eine offene Antwort ein. Gibt die Abmelde-Funktion zurück. */
export function subscribe(res) {
  subscribers.add(res);
  return () => subscribers.delete(res);
}

export function emit(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of subscribers) {
    try { res.write(frame); } catch { subscribers.delete(res); }
  }
}

/** Kommentar-Frame; hält Verbindung und Zwischenstationen wach. */
export function ping() {
  for (const res of subscribers) {
    try { res.write(':ping\n\n'); } catch { subscribers.delete(res); }
  }
}

export function closeAllStreams() {
  for (const res of subscribers) { try { res.end(); } catch { /* egal */ } }
  subscribers.clear();
}

export function streamCount() { return subscribers.size; }
