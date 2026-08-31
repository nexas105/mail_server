import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { onWaEvent } from '../lib/waStream';
import { confirmDialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { StatusBadge } from '../components/WaStatus';
import type { WaSession } from '../lib/types';

/**
 * Koppeln und Sitzungs-Zustand. Die dauerhaften Regeln (MCP-Versand, Stundenlimit)
 * stehen bewusst nicht hier, sondern unter Einstellungen – hier geht es um den
 * aktuellen Betrieb, dort um die Grundsatzentscheidungen.
 */
export function WhatsAppConnect() {
  const [sessions, setSessions] = useState<WaSession[]>([]);
  const reload = () => api<WaSession[]>('/whatsapp/accounts').then(setSessions);
  useEffect(() => { reload(); }, []);

  return (
    <>
      <div className="toolbar sticky-bar">
        <Icon name="smartphone" size={16} />
        <strong style={{ fontSize: 16 }}>WhatsApp-Verbindung</strong>
      </div>
      <ConnectionInner sessions={sessions} onChanged={reload} />
    </>
  );
}

/* ------------------------------------------------------------- Verbindung */

function ConnectionInner({ sessions, onChanged }: { sessions: WaSession[]; onChanged: () => void }) {
  const [qr, setQr] = useState<{ id: number; svg: string } | null>(null);
  const [code, setCode] = useState<{ id: number; code: string } | null>(null);
  const [sync, setSync] = useState<{ messages: number; done: boolean } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [newName, setNewName] = useState('');
  const [phone, setPhone] = useState('');

  useEffect(() => onWaEvent((event, data) => {
    if (event === 'qr') { setQr({ id: data.wa_account_id, svg: data.qr_svg }); setCode(null); }
    if (event === 'pairing_code') { setCode({ id: data.wa_account_id, code: data.code }); setQr(null); }
    if (event === 'sync') setSync({ messages: data.messages, done: data.done });
    if (event === 'status') {
      if ((data as WaSession[]).some(s => s.status === 'connected')) { setQr(null); setCode(null); }
      onChanged();
    }
  }), []);

  async function connect(id: number, method: 'qr' | 'pairing') {
    if (method === 'pairing' && !phone.trim()) return toast('Telefonnummer eingeben', 'err');
    setBusy(id); setQr(null); setCode(null);
    try { await api(`/whatsapp/accounts/${id}/connect`, { method: 'POST', body: { method, phone: phone.trim() } }); }
    catch (e) { toast((e as Error).message, 'err'); }
    setBusy(null);
  }
  async function disconnect(id: number) {
    setBusy(id);
    try { await api(`/whatsapp/accounts/${id}/disconnect`, { method: 'POST' }); onChanged(); }
    catch (e) { toast((e as Error).message, 'err'); }
    setBusy(null);
  }
  async function logout(s: WaSession) {
    if (!await confirmDialog({
      title: 'Gerät abmelden?',
      message: `„${s.name}" wird bei WhatsApp abgemeldet. Zum Weiterbenutzen musst du neu koppeln. `
        + 'Der bereits gespeicherte Verlauf bleibt erhalten.',
      danger: true, confirmLabel: 'Abmelden',
    })) return;
    setBusy(s.wa_account_id);
    try { await api(`/whatsapp/accounts/${s.wa_account_id}/logout`, { method: 'POST' }); onChanged(); }
    catch (e) { toast((e as Error).message, 'err'); }
    setBusy(null);
  }
  async function resyncContacts(sess: WaSession) {
    setBusy(sess.wa_account_id);
    try {
      const r = await api<{ before: number; after: number; added: number }>(
        `/whatsapp/accounts/${sess.wa_account_id}/resync-contacts`, { method: 'POST' });
      toast(r.added > 0
        ? `${r.added} Namen ergänzt (${r.after} Kontakte mit Namen)`
        : 'Keine neuen Namen – WhatsApp hat nichts nachgeliefert');
    } catch (e) { toast((e as Error).message, 'err'); }
    setBusy(null);
  }

  async function reset(sess: WaSession) {
    if (!await confirmDialog({
      title: 'Kopplung zurücksetzen?',
      message: `Die lokale Kopplung von „${sess.name}" wird gelöscht und du kannst neu koppeln. `
        + 'Der gespeicherte Verlauf bleibt erhalten. Entferne das Gerät danach auch am Telefon '
        + 'unter Verknüpfte Geräte.',
      danger: true, confirmLabel: 'Zurücksetzen',
    })) return;
    setBusy(sess.wa_account_id);
    try {
      await api(`/whatsapp/accounts/${sess.wa_account_id}/reset`, { method: 'POST' });
      toast('Zurückgesetzt – du kannst neu koppeln');
      setQr(null); setCode(null);
      onChanged();
    } catch (e) { toast((e as Error).message, 'err'); }
    setBusy(null);
  }

  async function removeAccount(sess: WaSession) {
    if (!await confirmDialog({
      title: 'Konto löschen?',
      message: `„${sess.name}" wird vollständig entfernt – Kopplung, Chats, Nachrichten und `
        + 'WhatsApp-Kontakte dieses Kontos. Das lässt sich nicht rückgängig machen.',
      danger: true, confirmLabel: 'Endgültig löschen',
    })) return;
    setBusy(sess.wa_account_id);
    try {
      await api(`/whatsapp/accounts/${sess.wa_account_id}`, { method: 'DELETE' });
      toast('Konto gelöscht');
      setQr(null); setCode(null);
      onChanged();
    } catch (e) { toast((e as Error).message, 'err'); }
    setBusy(null);
  }

  async function create() {
    if (!newName.trim()) return toast('Name eingeben', 'err');
    try { await api('/whatsapp/accounts', { method: 'POST', body: { name: newName.trim() } }); setNewName(''); onChanged(); }
    catch (e) { toast((e as Error).message, 'err'); }
  }

  return (
    <div style={{ maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card" style={{ borderColor: 'var(--amber)', background: 'var(--amber-soft)' }}>
        <strong><Icon name="alert" size={14} /> Inoffizieller Zugang</strong>
        <div className="small" style={{ marginTop: 6, lineHeight: 1.7 }}>
          Diese Anbindung nutzt Baileys, einen nachgebauten WhatsApp-Client. Das verstößt gegen die
          Nutzungsbedingungen, und WhatsApp kann die Nummer <strong>dauerhaft sperren</strong> – ohne
          Vorwarnung und ohne Widerspruch. Erkannt wird vor allem: Nachrichten an Fremde, geringe
          Antwortquote, maschinelle Taktung.
          <div style={{ marginTop: 6 }}>
            Also: möglichst eine <strong>Zweitnummer</strong>, kein Massenversand, und WhatsApp bleibt
            der Kanal für einzelne Gespräche. Serienversand gehört zur Mail-Seite.
          </div>
        </div>
      </div>

      {sessions.map(s => (
        <div key={s.wa_account_id} className="card">
          <div className="toolbar">
            <strong className="grow">{s.name}</strong>
            <StatusBadge status={s.status} />
            <button className="btn ghost sm icon-only danger" title="Konto löschen"
              disabled={busy === s.wa_account_id} onClick={() => removeAccount(s)}>
              <Icon name="trash" size={13} />
            </button>
          </div>
          <div className="meta-rows">
            {s.phone && <div><Icon name="smartphone" size={13} /> +{s.phone}{s.push_name && ` · ${s.push_name}`}</div>}
            {s.error && <div className="badge failed">{s.error}</div>}
          </div>

          {s.status === 'connected' ? (
            <div className="toolbar" style={{ marginTop: 10, marginBottom: 0 }}>
              <button className="btn ghost sm" disabled={busy === s.wa_account_id} onClick={() => disconnect(s.wa_account_id)}>Trennen</button>
              <button className="btn ghost sm" disabled={busy === s.wa_account_id}
                title="Telefonbuch-Namen erneut vom Telefon holen"
                onClick={() => resyncContacts(s)}>
                <Icon name="refresh" size={13} /> Namen abgleichen
              </button>
              <button className="btn ghost sm danger" disabled={busy === s.wa_account_id} onClick={() => logout(s)}>Abmelden</button>
              <span className="grow" />
              <button className="btn ghost sm danger" disabled={busy === s.wa_account_id} onClick={() => reset(s)}>Zurücksetzen</button>
            </div>
          ) : s.status === 'connecting' || s.status === 'pairing' ? (
            /* Auch im Zwischenzustand muss man rauskommen – sonst hängt man fest. */
            <>
              <div className="muted small" style={{ marginTop: 10 }}>
                {s.status === 'pairing'
                  ? 'Warte auf die Kopplung am Telefon …'
                  : 'Verbindungsaufbau läuft …'}
              </div>
              <div className="toolbar" style={{ marginTop: 10, marginBottom: 0 }}>
                <button className="btn ghost sm" disabled={busy === s.wa_account_id} onClick={() => disconnect(s.wa_account_id)}>Abbrechen</button>
                <span className="grow" />
                <button className="btn ghost sm danger" disabled={busy === s.wa_account_id} onClick={() => reset(s)}>Zurücksetzen</button>
              </div>
            </>
          ) : (
            <>
              <label style={{ marginTop: 10 }}>Telefonnummer (für den Kopplungs-Code)</label>
              <input value={phone} placeholder="491701234567" onChange={e => setPhone(e.target.value)} />
              <div className="toolbar" style={{ marginTop: 10, marginBottom: 0 }}>
                <button className="btn" disabled={busy === s.wa_account_id} onClick={() => connect(s.wa_account_id, 'pairing')}>
                  <Icon name="smartphone" size={14} /> Mit Code koppeln
                </button>
                <button className="btn ghost" disabled={busy === s.wa_account_id} onClick={() => connect(s.wa_account_id, 'qr')}>
                  QR-Code
                </button>
                <span className="grow" />
                <button className="btn ghost sm danger" disabled={busy === s.wa_account_id} onClick={() => reset(s)}
                  title="Lokale Kopplungsdaten löschen – hilft, wenn nichts mehr geht">
                  Zurücksetzen
                </button>
              </div>
            </>
          )}

          {code?.id === s.wa_account_id && (
            <div style={{ marginTop: 14, textAlign: 'center' }}>
              <div className="muted small">In WhatsApp: Einstellungen → Verknüpfte Geräte → Gerät verknüpfen → Mit Nummer verknüpfen</div>
              <div style={{ fontSize: 30, letterSpacing: 5, fontWeight: 700, margin: '10px 0', fontFamily: 'ui-monospace, monospace' }}>
                {code.code}
              </div>
            </div>
          )}
          {qr?.id === s.wa_account_id && (
            <div style={{ marginTop: 14, textAlign: 'center' }}>
              <div className="muted small">In WhatsApp: Einstellungen → Verknüpfte Geräte → Gerät verknüpfen</div>
              <img src={qr.svg} alt="QR-Code" style={{ width: 240, height: 240, marginTop: 8, background: '#fff', padding: 8, borderRadius: 8 }} />
            </div>
          )}
          {sync && s.status === 'connected' && !sync.done && (
            <div className="progress" style={{ marginTop: 12 }}>
              <div className="muted small">Verlauf wird geladen … {sync.messages} Nachrichten</div>
            </div>
          )}
        </div>
      ))}

      <div className="card">
        <div className="toolbar"><strong className="grow">Konto hinzufügen</strong></div>
        <label>Name</label>
        <input value={newName} placeholder="z.B. Zweitnummer" onChange={e => setNewName(e.target.value)} />
        <div className="toolbar" style={{ marginTop: 10, marginBottom: 0 }}>
          <button className="btn" onClick={create}><Icon name="plus" size={14} /> Anlegen</button>
        </div>
      </div>
    </div>
  );
}
