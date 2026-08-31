/** Einheitliche Statusanzeige für WhatsApp – von Chats, Verbindung und Einstellungen genutzt. */
export const WA_STATUS_LABEL: Record<string, string> = {
  logged_out: 'Nicht verbunden',
  pairing: 'Warten auf Kopplung',
  connecting: 'Verbindet …',
  connected: 'Verbunden',
  conflict: 'Von anderer Sitzung verdrängt',
  banned: 'Nummer gesperrt',
};

export function StatusBadge({ status }: { status: string }) {
  const cls = status === 'connected' ? 'sent'
    : status === 'pairing' || status === 'connecting' ? 'sending'
      : status === 'banned' || status === 'conflict' ? 'failed' : '';
  return <span className={'badge ' + cls}>{WA_STATUS_LABEL[status] || status}</span>;
}
