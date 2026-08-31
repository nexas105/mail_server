import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { Icon } from './Icon';
import type { TrackingStatus } from '../lib/types';

/**
 * Öffnungs-Messung global schalten.
 *
 * Standardmäßig aus, und das bleibt eine bewusste Entscheidung des Nutzers: ein
 * Zählpixel misst Verhalten einer identifizierbaren Person und braucht in der EU
 * eine Rechtsgrundlage. Der Text hier sagt das, statt es zu verstecken.
 */
export function TrackingCard() {
  const [status, setStatus] = useState<TrackingStatus | null>(null);
  // Drei Zustände statt zwei: „lädt noch" und „Server kennt die Route nicht"
  // sehen sonst beide wie ein toter Schalter aus.
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [busy, setBusy] = useState(false);

  const load = () => api<TrackingStatus>('/tracking/status')
    .then(s => { setStatus(s); setState('ready'); })
    .catch(() => { setStatus(null); setState('unavailable'); });
  useEffect(() => { load(); }, []);

  async function toggle(on: boolean) {
    setBusy(true);
    try {
      await api('/settings', { method: 'PUT', body: { track_opens: on ? '1' : '0' } });
      setStatus(s => (s ? { ...s, opens_enabled: on } : s));
      toast(on ? 'Öffnungen werden ab jetzt gemessen' : 'Öffnungs-Messung aus');
    } catch (e) { toast((e as Error).message, 'err'); }
    setBusy(false);
  }

  return (
    <div className="card">
      <div className="toolbar">
        <Icon name="eye" size={16} />
        <strong className="grow">Zustellung nachverfolgen</strong>
      </div>

      <div className="muted small" style={{ marginBottom: 12 }}>
        <strong>Unzustellbarkeit</strong> wird immer erkannt: Kommt eine Bounce-Meldung im
        Posteingang an, ordnet der Server sie beim IMAP-Abruf dem Empfänger zu und markiert
        ihn im Postausgang. Dafür ist nichts einzustellen — nur IMAP muss am Konto eingerichtet sein.
      </div>

      {state === 'unavailable' ? (
        // Häufigster Fall: Das Backend läuft noch in der Fassung von vor dem
        // Update und kennt /api/tracking/status nicht. Ohne diesen Hinweis
        // sieht es aus wie ein kaputter Schalter.
        <div className="acct-probe err">
          <Icon name="alert" size={13} />
          <span className="grow">
            Der laufende Server kennt die Nachverfolgung noch nicht — er wurde vor dem
            Update gestartet. Backend neu starten (<code>npm start</code> bzw. im Launcher
            auf <strong>Neustart</strong>), danach{' '}
            <button className="linklike" onClick={() => { setState('loading'); load(); }}>hier neu laden</button>.
          </span>
        </div>
      ) : (
        <label className="check inline">
          <input
            type="checkbox" checked={!!status?.opens_enabled} disabled={busy || state === 'loading'}
            onChange={e => toggle(e.target.checked)}
          />
          Öffnungen messen (Zählpixel in jeder gesendeten Mail)
        </label>
      )}

      <div className="muted small" style={{ marginTop: 8 }}>
        Ein 1×1-Pixel wird beim Öffnen vom Mail-Programm nachgeladen. Die Zahl ist eine
        <strong> Untergrenze</strong>: Wer Bilder unterdrückt, wird nie gezählt — und Apple Mail
        lädt Pixel auf Vorrat, erzeugt also Öffnungen, die keine sind. Für Tendenzen taugt das,
        als Lesebeweis nicht.
      </div>

      <div className="muted small" style={{ marginTop: 8 }}>
        Rechtlich ist die Messung personenbezogen und braucht in der EU eine Grundlage
        (Einwilligung oder berechtigtes Interesse mit Hinweis in der Datenschutzerklärung).
        Deshalb ist sie standardmäßig aus. Pro Entwurf lässt sie sich im Schritt „Senden"
        abweichend schalten.
      </div>

      {state === 'ready' && status && (
        status.reachable ? (
          <div className="muted small" style={{ marginTop: 10 }}>
            Öffentliche Adresse: <code>{status.base_url}</code>
          </div>
        ) : (
          <div className="acct-probe err" style={{ marginTop: 10 }}>
            <Icon name="alert" size={13} />
            <span className="grow">
              {status.base_url
                ? <>Die öffentliche Adresse <code>{status.base_url}</code> zeigt auf diesen Rechner. Empfänger können das Pixel nicht laden — es würde nichts gemessen.</>
                : <>Es ist keine öffentliche Adresse gesetzt. Ohne <code>MAIL_PUBLIC_URL</code> wird kein Pixel eingebaut.</>}
            </span>
          </div>
        )
      )}
    </div>
  );
}
