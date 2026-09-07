/**
 * Eine einzige EventSource für den WhatsApp-Live-Stream, geteilt von allen
 * Komponenten. Browser erlauben nur ~6 offene Verbindungen pro Herkunft –
 * jede Seite ihre eigene aufmachen zu lassen, wäre verschwenderisch.
 */
type Handler = (event: string, data: any) => void;

const handlers = new Set<Handler>();
let es: EventSource | null = null;

const EVENTS = ['status', 'qr', 'pairing_code', 'message', 'chat', 'sync', 'reaction', 'scheduled'] as const;

function open() {
  if (es) return;
  es = new EventSource('/api/whatsapp/stream');
  for (const name of EVENTS) {
    es.addEventListener(name, e => {
      let data: any = null;
      try { data = JSON.parse((e as MessageEvent).data); } catch { /* egal */ }
      for (const h of handlers) h(name, data);
    });
  }
  // Bei einem Abbruch schließt der Browser nicht von selbst – EventSource
  // verbindet sich automatisch neu, der Server schickt dann sofort wieder
  // einen status-Frame als Startbild.
}

function close() {
  es?.close();
  es = null;
}

/** Meldet einen Empfänger an; die Rückgabe meldet ihn wieder ab. */
export function onWaEvent(handler: Handler): () => void {
  handlers.add(handler);
  open();
  return () => {
    handlers.delete(handler);
    if (!handlers.size) close();
  };
}
