import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { confirmDialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import type { Contact } from '../lib/types';
import { ROUTES } from '../lib/routes';

interface WaContactRow {
  id: number;
  jid: string;
  phone: string | null;
  push_name: string | null;
  name: string | null;
  is_group: 0 | 1;
  contact_id: number | null;
  contact_email: string | null;
  chat_id: number | null;
}

/**
 * WhatsApp-Kontakte und ihre Verknüpfung ins Adressbuch.
 *
 * Getrennt gehalten, weil ein WhatsApp-Kontakt keine Mailadresse haben muss –
 * das Adressbuch verlangt aber eine. Wer beides ist, wird hier verbunden.
 */
export function WhatsAppContacts() {
  const [rows, setRows] = useState<WaContactRow[] | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'linked' | 'unlinked'>('all');
  const [busy, setBusy] = useState<number | null>(null);
  const nav = useNavigate();

  const load = () => api<WaContactRow[]>('/whatsapp/contacts?limit=500').then(setRows);
  useEffect(() => {
    load();
    api<Contact[]>('/contacts').then(setContacts);
  }, []);

  /** Nummer im Adressbuch suchen – Vorschlag, nie automatisch verknüpfen. */
  const suggestion = useMemo(() => {
    const byPhone = new Map<string, Contact>();
    for (const c of contacts) {
      const digits = (c.phone || '').replace(/\D/g, '');
      if (digits.length >= 8) byPhone.set(digits.slice(-9), c);
    }
    return (phone: string | null) => {
      if (!phone) return null;
      return byPhone.get(phone.replace(/\D/g, '').slice(-9)) || null;
    };
  }, [contacts]);

  async function link(row: WaContactRow, contactId: number) {
    setBusy(row.id);
    try {
      await api(`/whatsapp/contacts/${row.id}/link`, { method: 'POST', body: { contact_id: contactId } });
      toast('Verknüpft'); await load();
    } catch (e) { toast((e as Error).message, 'err'); }
    setBusy(null);
  }

  /**
   * Ins Adressbuch übernehmen. Die Mailadresse ist optional – der Name genügt.
   * Wer nur eine WhatsApp-Nummer hat, gehört trotzdem ins Adressbuch und wird
   * beim Mailversand einfach übersprungen.
   */
  async function takeOver(row: WaContactRow) {
    const display = row.name || row.push_name || row.phone || 'Unbekannt';
    if (!await confirmDialog({
      title: 'Ins Adressbuch übernehmen?',
      message: `„${display}" wird als Kontakt angelegt und mit dieser WhatsApp-Nummer verknüpft. `
        + 'Eine Mailadresse kannst du später im Adressbuch ergänzen.',
      confirmLabel: 'Übernehmen',
    })) return;
    setBusy(row.id);
    try {
      await api(`/whatsapp/contacts/${row.id}/link`, {
        method: 'POST', body: { name: display, phone: row.phone || undefined },
      });
      toast('Übernommen und verknüpft');
      await load();
      setContacts(await api<Contact[]>('/contacts'));
    } catch (e) { toast((e as Error).message, 'err'); }
    setBusy(null);
  }

  async function unlink(row: WaContactRow) {
    setBusy(row.id);
    try { await api(`/whatsapp/contacts/${row.id}/link`, { method: 'DELETE' }); await load(); }
    catch (e) { toast((e as Error).message, 'err'); }
    setBusy(null);
  }

  const visible = (rows || []).filter(r => {
    if (r.is_group) return false;
    if (filter === 'linked' && !r.contact_id) return false;
    if (filter === 'unlinked' && r.contact_id) return false;
    if (!q.trim()) return true;
    const t = q.toLowerCase();
    return [r.name, r.push_name, r.phone, r.contact_email]
      .some(v => (v || '').toLowerCase().includes(t));
  });

  const people = (rows || []).filter(r => !r.is_group);
  const linkedCount = people.filter(r => r.contact_id).length;

  return (
    <>
      <div className="toolbar sticky-bar">
        <Icon name="users" size={16} />
        <strong style={{ fontSize: 16 }}>WhatsApp-Kontakte</strong>
        <span className="grow" />
        <span className="muted small">{linkedCount} von {people.length} mit dem Adressbuch verknüpft</span>
      </div>

      <div className="toolbar">
        <div className="searchbox grow">
          <Icon name="search" size={14} />
          <input value={q} placeholder="Name oder Nummer" onChange={e => setQ(e.target.value)} />
        </div>
        <div className="chips">
          <button className={'chip' + (filter === 'all' ? ' active' : '')} onClick={() => setFilter('all')}>
            Alle <span className="count">{people.length}</span>
          </button>
          <button className={'chip' + (filter === 'unlinked' ? ' active' : '')} onClick={() => setFilter('unlinked')}>
            Ohne Adressbuch <span className="count">{people.length - linkedCount}</span>
          </button>
          <button className={'chip' + (filter === 'linked' ? ' active' : '')} onClick={() => setFilter('linked')}>
            Verknüpft <span className="count">{linkedCount}</span>
          </button>
        </div>
      </div>

      <div className="card">
        {!rows ? <>{[0, 1, 2].map(i => <div key={i} className="skel skel-row" />)}</>
          : !visible.length ? (
            <div className="empty" style={{ padding: '32px 0' }}>
              <Icon name="users" size={26} />
              <div>Keine Kontakte</div>
              <div className="muted small">
                WhatsApp-Kontakte erscheinen, sobald eine Verbindung besteht und Chats eingehen.
              </div>
            </div>
          ) : visible.map(r => {
            const hint = !r.contact_id ? suggestion(r.phone) : null;
            return (
              <div key={r.id} className="list-item static" style={{ alignItems: 'flex-start' }}>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="title">{r.name || r.push_name || r.phone}</div>
                  <div className="muted small">
                    {r.phone && <>+{r.phone}</>}
                    {r.contact_email && <> · verknüpft mit {r.contact_email}</>}
                  </div>
                  {hint && (
                    <div className="small" style={{ marginTop: 4 }}>
                      Passt vermutlich zu <strong>{hint.name || hint.email}</strong>
                      {' '}
                      <button className="btn ghost sm" disabled={busy === r.id}
                        onClick={() => link(r, hint.id)}>Verknüpfen</button>
                    </div>
                  )}
                </div>

                {r.chat_id && (
                  <button className="btn ghost sm icon-only" title="Chat öffnen"
                    onClick={() => nav(ROUTES.whatsapp.chats)}><Icon name="chat" size={13} /></button>
                )}
                {r.contact_id ? (
                  <>
                    <button className="btn ghost sm" onClick={() => nav(ROUTES.manage.contacts)}>Kontakt</button>
                    <span className="x muted" title="Verknüpfung lösen" style={{ cursor: 'pointer', display: 'inline-flex' }}
                      onClick={() => unlink(r)}><Icon name="x" size={14} /></span>
                  </>
                ) : (
                  <button className="btn ghost sm" disabled={busy === r.id} onClick={() => takeOver(r)}>
                    <Icon name="plus" size={13} /> Ins Adressbuch
                  </button>
                )}
              </div>
            );
          })}
      </div>
    </>
  );
}
