import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { confirmDialog, promptDialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { Menu } from '../components/Menu';
import { getSettings, setDefaultAccount } from '../lib/settings';
import type { Account, Template } from '../lib/types';

/**
 * E-Mail-Konten als Meister/Detail statt „Formular links, Liste rechts".
 *
 * Der alte Aufbau hatte drei Probleme, die hier gezielt gelöst sind:
 *   1. Das Formular war immer da, auch wenn man nur nachsehen wollte. Jetzt
 *      trägt die Liste die Seite, das Formular gehört sichtbar zum gewählten
 *      Konto (Auswahl bleibt markiert, kein Sprung nach oben).
 *   2. Ungespeicherte Änderungen verschwanden beim Umschalten still. Jetzt gibt
 *      es einen Dirty-Zustand, eine Speicherleiste (⌘S) und eine Rückfrage.
 *   3. „Testen" war ein Toast, der weg war, bevor man ihn lesen konnte. Jetzt
 *      bleibt das Ergebnis am Konto stehen – inklusive Fehlertext.
 */

interface Form {
  name: string; host: string; port: number; secure: boolean;
  username: string; password: string; from_name: string; from_email: string; reply_to: string;
  carddav_url: string; carddav_username: string; carddav_password: string;
  imap_host: string; imap_port: number | ''; imap_secure: boolean; imap_username: string; imap_password: string;
  default_header_template_id: number | ''; default_footer_template_id: number | '';
}

const EMPTY: Form = {
  name: '', host: '', port: 587, secure: false, username: '', password: '',
  from_name: '', from_email: '', reply_to: '',
  carddav_url: '', carddav_username: '', carddav_password: '',
  imap_host: '', imap_port: 993, imap_secure: true, imap_username: '', imap_password: '',
  default_header_template_id: '', default_footer_template_id: '',
};

const toForm = (a: Account): Form => ({
  name: a.name, host: a.host, port: a.port, secure: !!a.secure,
  username: a.username, password: '',
  from_name: a.from_name || '', from_email: a.from_email, reply_to: a.reply_to || '',
  carddav_url: a.carddav_url || '', carddav_username: a.carddav_username || '', carddav_password: '',
  imap_host: a.imap_host || '', imap_port: a.imap_port ?? 993,
  imap_secure: a.imap_secure != null ? !!a.imap_secure : true,
  imap_username: a.imap_username || '', imap_password: '',
  default_header_template_id: a.default_header_template_id ?? '',
  default_footer_template_id: a.default_footer_template_id ?? '',
});

type Section = 'sender' | 'inbox' | 'contacts' | 'templates';
type Probe = { state: 'busy' | 'ok' | 'err'; message?: string; at?: number };
type Selection = number | 'new' | null;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const initial = (s: string) => (s.trim().charAt(0) || '?').toUpperCase();

export function Accounts() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Selection>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [baseline, setBaseline] = useState<Form>(EMPTY);
  const [section, setSection] = useState<Section>('sender');
  const [defaultId, setDefaultId] = useState<number | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  // Prüfergebnisse je Konto und Protokoll, Schlüssel `${id}:smtp` / `${id}:imap`.
  const [probes, setProbes] = useState<Record<string, Probe>>({});

  const isNew = selected === 'new';
  const current = typeof selected === 'number' ? accounts.find(a => a.id === selected) ?? null : null;
  const dirty = (isNew || current != null) && JSON.stringify(form) !== JSON.stringify(baseline);

  const load = () => api<Account[]>('/accounts').then(list => { setAccounts(list); return list; });

  useEffect(() => {
    load().then(list => {
      setLoading(false);
      // Ohne Auswahl startet man sonst vor einer leeren Fläche.
      if (list.length) setSelected(prev => prev ?? list[0].id);
    }).catch(() => setLoading(false));
    api<Template[]>('/templates').then(setTemplates).catch(() => {});
    getSettings().then(s => setDefaultId(s.default_account_id ?? null)).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auswahl wechselt → Formular neu befüllen (nur wenn wirklich ein anderes Konto).
  useEffect(() => {
    if (isNew) { setForm(EMPTY); setBaseline(EMPTY); }
    else if (current) { const f = toForm(current); setForm(f); setBaseline(f); }
    setErrors({}); setSection('sender');
  }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  // ⌘S / Strg+S speichert, solange etwas offen ist.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && dirty) {
        e.preventDefault(); save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm(f => ({ ...f, [k]: v }));
    if (errors[k]) setErrors(e => ({ ...e, [k]: undefined }));
  };

  /** Verschlüsselung und Port gehören zusammen – sonst tippt man ewig aneinander vorbei. */
  const setSmtpSecure = (secure: boolean) => setForm(f => ({
    ...f, secure, port: f.port === 587 || f.port === 465 ? (secure ? 465 : 587) : f.port,
  }));
  const setImapSecure = (secure: boolean) => setForm(f => ({
    ...f, imap_secure: secure, imap_port: f.imap_port === 993 || f.imap_port === 143 ? (secure ? 993 : 143) : f.imap_port,
  }));

  /** Wechsel der Auswahl, aber nicht auf Kosten ungespeicherter Eingaben. */
  async function selectAccount(next: Selection) {
    if (next === selected) return;
    if (dirty) {
      const ok = await confirmDialog({
        title: 'Änderungen verwerfen?',
        message: 'Am gewählten Konto gibt es ungespeicherte Änderungen.',
        confirmLabel: 'Verwerfen', danger: true,
      });
      if (!ok) return;
    }
    setSelected(next);
  }

  function validate(): boolean {
    const next: Partial<Record<keyof Form, string>> = {};
    if (!form.name.trim()) next.name = 'Ein Anzeigename hilft beim Auseinanderhalten';
    if (!form.host.trim()) next.host = 'SMTP-Host erforderlich';
    if (!form.from_email.trim()) next.from_email = 'Absender-Adresse erforderlich';
    else if (!EMAIL_RE.test(form.from_email.trim())) next.from_email = 'Das sieht nicht nach einer E-Mail-Adresse aus';
    if (form.reply_to.trim() && !EMAIL_RE.test(form.reply_to.trim())) next.reply_to = 'Ungültige Adresse';
    if (!form.username.trim()) next.username = 'Benutzername erforderlich';
    if (isNew && !form.password) next.password = 'Passwort erforderlich';
    setErrors(next);
    if (Object.keys(next).length) {
      // Zum ersten Fehler springen: alle Pflichtfelder liegen im ersten Abschnitt.
      setSection('sender');
      toast('Bitte die markierten Felder prüfen', 'err');
      return false;
    }
    return true;
  }

  async function save() {
    if (saving || !validate()) return;
    const body: Record<string, unknown> = {
      name: form.name.trim(), host: form.host.trim(), port: form.port, secure: form.secure,
      username: form.username.trim(), from_name: form.from_name.trim(),
      from_email: form.from_email.trim(), reply_to: form.reply_to.trim(),
      carddav_url: form.carddav_url.trim(), carddav_username: form.carddav_username.trim(),
      imap_host: form.imap_host.trim(), imap_port: form.imap_port || null, imap_secure: form.imap_secure,
      imap_username: form.imap_username.trim(),
      default_header_template_id: form.default_header_template_id || null,
      default_footer_template_id: form.default_footer_template_id || null,
    };
    if (form.password) body.password = form.password;
    if (form.carddav_password) body.carddav_password = form.carddav_password;
    if (form.imap_password) body.imap_password = form.imap_password;

    setSaving(true);
    try {
      const saved = isNew
        ? await api<Account>('/accounts', { method: 'POST', body })
        : await api<Account>('/accounts/' + selected, { method: 'PUT', body });
      const list = await load();
      const fresh = list.find(a => a.id === saved.id);
      // Passwörter kommen nie zurück – Baseline aus dem Server-Stand, Felder leer.
      if (fresh) { const f = toForm(fresh); setForm(f); setBaseline(f); }
      setSelected(saved.id);
      toast(isNew ? `„${saved.name}" angelegt` : 'Gespeichert');
    } catch (e) { toast((e as Error).message, 'err'); }
    setSaving(false);
  }

  function discard() {
    setForm(baseline); setErrors({});
    if (isNew) setSelected(accounts[0]?.id ?? null);
  }

  async function toggleDefault(a: Account) {
    const next = defaultId === a.id ? null : a.id;
    await setDefaultAccount(next);
    setDefaultId(next);
    toast(next ? `„${a.name}" ist jetzt Standard-Absender`
      : 'Kein Standard-Absender mehr – neue Entwürfe nehmen das erste Konto');
  }

  async function probe(a: Account, kind: 'smtp' | 'imap') {
    const key = `${a.id}:${kind}`;
    setProbes(p => ({ ...p, [key]: { state: 'busy' } }));
    const path = kind === 'smtp' ? `/accounts/${a.id}/verify` : `/accounts/${a.id}/imap/verify`;
    try {
      await api(path, { method: 'POST' });
      setProbes(p => ({ ...p, [key]: { state: 'ok', at: Date.now() } }));
    } catch (e) {
      setProbes(p => ({ ...p, [key]: { state: 'err', message: (e as Error).message, at: Date.now() } }));
    }
  }

  async function duplicate(a: Account) {
    const name = await promptDialog({
      title: 'Konto duplizieren',
      message: 'Zugangsdaten und Einstellungen werden übernommen.',
      label: 'Name der Kopie', defaultValue: a.name + ' (Kopie)', confirmLabel: 'Duplizieren',
    });
    if (name === null) return;
    const copy = await api<Account>(`/accounts/${a.id}/duplicate`, { method: 'POST', body: { name } });
    await load();
    setSelected(copy.id);
    toast('Konto dupliziert');
  }

  async function remove(a: Account) {
    const ok = await confirmDialog({
      title: `Konto „${a.name}" löschen?`,
      message: 'Entwürfe mit diesem Absender behalten keinen Account mehr und müssen neu zugewiesen werden.',
      confirmLabel: 'Löschen', danger: true,
    });
    if (!ok) return;
    await api(`/accounts/${a.id}`, { method: 'DELETE' });
    const list = await load();
    setSelected(list[0]?.id ?? null);
  }

  async function syncCardDav(a: Account) {
    const list = await promptDialog({
      title: 'CardDAV-Kontakte importieren',
      message: 'In welche Liste sollen die Kontakte? Leer lassen für „nur Adressbuch".',
      label: 'Listenname (optional)', defaultValue: a.name, confirmLabel: 'Importieren',
    });
    if (list === null) return;
    setBusy(true);
    try {
      const r = await api<{ found: number; imported: number }>(`/accounts/${a.id}/carddav/sync`,
        { method: 'POST', body: { list: list || undefined } });
      toast(`${r.imported} von ${r.found} Kontakten importiert`);
    } catch (e) { toast('CardDAV: ' + (e as Error).message, 'err'); }
    setBusy(false);
  }

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return accounts;
    return accounts.filter(a => [a.name, a.from_email, a.host, a.username]
      .some(v => (v || '').toLowerCase().includes(q)));
  }, [accounts, query]);

  const headerTemplates = templates.filter(t => t.kind === 'header');
  const footerTemplates = templates.filter(t => t.kind === 'footer');

  const sections: { key: Section; label: string; icon: 'mail' | 'inbox' | 'users' | 'template'; on?: boolean }[] = [
    { key: 'sender', label: 'Absender', icon: 'mail' },
    { key: 'inbox', label: 'Empfang', icon: 'inbox', on: !!form.imap_host.trim() },
    { key: 'contacts', label: 'Kontakte', icon: 'users', on: !!form.carddav_url.trim() },
    { key: 'templates', label: 'Vorlagen', icon: 'template', on: !!(form.default_header_template_id || form.default_footer_template_id) },
  ];

  return (
    <>
      <div className="toolbar sticky-bar">
        <strong className="grow">
          E-Mail-Konten
          {accounts.length > 0 && <span className="badge" style={{ marginLeft: 8 }}>{accounts.length}</span>}
        </strong>
        <div className="searchbox" style={{ width: 240 }}>
          <Icon name="search" size={15} />
          <input placeholder="Name, Adresse oder Host …" value={query} onChange={e => setQuery(e.target.value)} />
        </div>
        <button className="btn" onClick={() => selectAccount('new')}>
          <Icon name="plus" size={14} /> Neues Konto
        </button>
      </div>

      {loading ? (
        <div className="acct-grid">
          <div>{[0, 1, 2].map(i => <div key={i} className="skel skel-row" />)}</div>
          <div className="card"><div className="skel" style={{ height: 220 }} /></div>
        </div>
      ) : accounts.length === 0 && !isNew ? (
        <div className="empty">
          <Icon name="server" size={28} />
          <div>Noch kein E-Mail-Konto hinterlegt.</div>
          <div className="muted small" style={{ maxWidth: 420, margin: '6px auto 14px' }}>
            Ein Konto besteht aus dem Postausgang (SMTP) und optional dem Posteingang (IMAP).
            Die Zugangsdaten deines Anbieters findest du dort unter „E-Mail-Programm einrichten".
          </div>
          <button className="btn" onClick={() => setSelected('new')}>
            <Icon name="plus" size={14} /> Erstes Konto anlegen
          </button>
        </div>
      ) : (
        <div className="acct-grid">
          {/* ---------------------------------------------------- Liste */}
          <div className="acct-list">
            {isNew && (
              <div className="list-item sel acct-row">
                <span className="acct-avatar new"><Icon name="plus" size={14} /></span>
                <div className="grow">
                  <div className="title">{form.name.trim() || 'Neues Konto'}</div>
                  <div className="muted small">wird angelegt …</div>
                </div>
              </div>
            )}

            {shown.map(a => {
              const smtp = probes[`${a.id}:smtp`];
              const imap = probes[`${a.id}:imap`];
              return (
                <div
                  key={a.id}
                  className={'list-item acct-row' + (selected === a.id ? ' sel' : '')}
                  onClick={() => selectAccount(a.id)}
                  role="button" tabIndex={0}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectAccount(a.id); } }}
                  aria-current={selected === a.id}
                >
                  <span className="acct-avatar">{initial(a.name || a.from_email)}</span>
                  <div className="grow">
                    <div className="title">
                      {a.name}
                      {defaultId === a.id && <span className="acct-default">Standard</span>}
                    </div>
                    <div className="muted small acct-mail">{a.from_email}</div>
                    <div className="acct-caps">
                      <Cap label="SMTP" on probe={smtp} />
                      <Cap label="IMAP" on={!!a.has_imap} probe={imap} />
                      <Cap label="CardDAV" on={!!a.has_carddav} />
                    </div>
                  </div>
                  <button
                    className={'flag-btn' + (defaultId === a.id ? ' flagged' : '')}
                    title={defaultId === a.id ? 'Standard-Absender entfernen' : 'Als Standard-Absender setzen'}
                    aria-label="Standard-Absender"
                    onClick={e => { e.stopPropagation(); toggleDefault(a); }}
                  >
                    <Icon name="sparkle" size={14} />
                  </button>
                </div>
              );
            })}

            {shown.length === 0 && !isNew && (
              <div className="empty" style={{ padding: 24 }}>
                <Icon name="search" size={22} />Nichts passt zu „{query}".
              </div>
            )}
          </div>

          {/* --------------------------------------------------- Detail */}
          <div className="acct-detail">
            {!isNew && !current ? (
              <div className="empty"><Icon name="server" size={28} />Wähle links ein Konto aus.</div>
            ) : (
              <div className="card" style={{ marginBottom: 0 }}>
                <div className="toolbar" style={{ marginBottom: 14 }}>
                  <strong className="grow">
                    {isNew ? 'Neues Konto' : current!.name}
                    {!isNew && defaultId === current!.id && <span className="badge sent" style={{ marginLeft: 8 }}>Standard</span>}
                  </strong>
                  {!isNew && current && (
                    <>
                      <button className="btn ghost sm" onClick={() => probe(current, 'smtp')}
                        disabled={probes[`${current.id}:smtp`]?.state === 'busy'}>
                        <Icon name="check" size={13} />
                        {probes[`${current.id}:smtp`]?.state === 'busy' ? 'Prüft …' : 'Verbindung testen'}
                      </button>
                      <Menu
                        title="Weitere Aktionen"
                        trigger={<Icon name="command" size={14} />}
                        items={[
                          {
                            icon: 'sparkle',
                            label: defaultId === current.id ? 'Standard-Absender entfernen' : 'Als Standard-Absender',
                            onSelect: () => toggleDefault(current),
                          },
                          ...(current.has_imap ? [{
                            icon: 'inbox' as const, label: 'IMAP testen', onSelect: () => probe(current, 'imap'),
                          }] : []),
                          ...(current.has_carddav ? [{
                            icon: 'refresh' as const, label: 'CardDAV synchronisieren', onSelect: () => syncCardDav(current),
                          }] : []),
                          { icon: 'copy', label: 'Duplizieren', onSelect: () => duplicate(current) },
                          { icon: 'trash', label: 'Löschen', onSelect: () => remove(current) },
                        ]}
                      />
                    </>
                  )}
                </div>

                {!isNew && current && <ProbeResults smtp={probes[`${current.id}:smtp`]} imap={probes[`${current.id}:imap`]} />}

                <div className="tabs2">
                  {sections.map(s => (
                    <button key={s.key} className={section === s.key ? 'active' : ''} onClick={() => setSection(s.key)}>
                      <Icon name={s.icon} size={13} />
                      {s.label}
                      {s.on && <span className="tab-dot" aria-label="konfiguriert" />}
                    </button>
                  ))}
                </div>

                {section === 'sender' && (
                  <>
                    <Field label="Anzeigename" hint="Nur intern – erscheint in Auswahllisten" error={errors.name}>
                      <input value={form.name} onChange={e => set('name', e.target.value)} placeholder="z.B. Firma Info" />
                    </Field>

                    <div className="acct-2col">
                      <Field label="Absender-Name" error={undefined}>
                        <input value={form.from_name} onChange={e => set('from_name', e.target.value)} placeholder="Firma GmbH" />
                      </Field>
                      <Field label="Absender-Adresse" error={errors.from_email}>
                        <input
                          value={form.from_email}
                          onChange={e => {
                            set('from_email', e.target.value);
                            // Beim Anlegen ist der Benutzername fast immer die Adresse.
                            if (isNew && !form.username) set('username', e.target.value);
                          }}
                          placeholder="info@example.com"
                        />
                      </Field>
                    </div>

                    <Field label="Antwort-Adresse (Reply-To)" hint="Optional – Antworten gehen sonst an die Absender-Adresse" error={errors.reply_to}>
                      <input value={form.reply_to} onChange={e => set('reply_to', e.target.value)} placeholder="antwort@example.com" />
                    </Field>

                    <div className="acct-sep">Postausgang (SMTP)</div>

                    <div className="acct-2col">
                      <Field label="Host" error={errors.host}>
                        <input value={form.host} onChange={e => set('host', e.target.value)} placeholder="smtp.example.com" />
                      </Field>
                      <Field label="Port">
                        <input type="number" value={form.port} onChange={e => set('port', Number(e.target.value))} />
                      </Field>
                    </div>

                    <Field label="Verschlüsselung">
                      <div className="tabs2" style={{ marginBottom: 0 }}>
                        <button className={!form.secure ? 'active' : ''} onClick={() => setSmtpSecure(false)}>STARTTLS · 587</button>
                        <button className={form.secure ? 'active' : ''} onClick={() => setSmtpSecure(true)}>SSL/TLS · 465</button>
                      </div>
                    </Field>

                    <div className="acct-2col">
                      <Field label="Benutzername" error={errors.username}>
                        <input value={form.username} onChange={e => set('username', e.target.value)} placeholder="user@example.com" />
                      </Field>
                      <Field
                        label="Passwort"
                        hint={isNew ? undefined : 'Leer lassen = unverändert'}
                        error={errors.password}
                      >
                        <input type="password" value={form.password} onChange={e => set('password', e.target.value)}
                          placeholder={isNew ? '' : '••••••••'} autoComplete="new-password" />
                      </Field>
                    </div>
                    <div className="muted small">Das Passwort wird AES-256-GCM-verschlüsselt gespeichert und nie wieder ausgeliefert.</div>
                  </>
                )}

                {section === 'inbox' && (
                  <>
                    <div className="muted small" style={{ marginBottom: 4 }}>
                      Mit IMAP holt der Server empfangene Mails in den <strong>Posteingang</strong>.
                      Ohne Angaben bleibt das Konto reiner Absender.
                    </div>
                    <div className="acct-2col">
                      <Field label="IMAP-Host">
                        <input value={form.imap_host} onChange={e => set('imap_host', e.target.value)} placeholder="imap.example.com" />
                      </Field>
                      <Field label="Port">
                        <input type="number" value={form.imap_port}
                          onChange={e => set('imap_port', e.target.value === '' ? '' : Number(e.target.value))} />
                      </Field>
                    </div>
                    <Field label="Verschlüsselung">
                      <div className="tabs2" style={{ marginBottom: 0 }}>
                        <button className={form.imap_secure ? 'active' : ''} onClick={() => setImapSecure(true)}>SSL/TLS · 993</button>
                        <button className={!form.imap_secure ? 'active' : ''} onClick={() => setImapSecure(false)}>STARTTLS · 143</button>
                      </div>
                    </Field>
                    <div className="acct-2col">
                      <Field label="Benutzername" hint="Leer = wie SMTP">
                        <input value={form.imap_username} onChange={e => set('imap_username', e.target.value)} placeholder={form.username || 'user@example.com'} />
                      </Field>
                      <Field label="Passwort" hint="Leer = wie SMTP">
                        <input type="password" value={form.imap_password} onChange={e => set('imap_password', e.target.value)} autoComplete="new-password" />
                      </Field>
                    </div>
                    {!isNew && current?.has_imap && (
                      <button className="btn ghost sm" style={{ marginTop: 12 }}
                        onClick={() => probe(current, 'imap')} disabled={probes[`${current.id}:imap`]?.state === 'busy'}>
                        <Icon name="inbox" size={13} />
                        {probes[`${current.id}:imap`]?.state === 'busy' ? 'Prüft …' : 'IMAP testen'}
                      </button>
                    )}
                  </>
                )}

                {section === 'contacts' && (
                  <>
                    <div className="muted small" style={{ marginBottom: 4 }}>
                      CardDAV holt das Adressbuch des Postfachs in die <strong>Kontakte</strong> – wahlweise direkt in eine Liste.
                    </div>
                    <Field label="Adressbuch-URL">
                      <input value={form.carddav_url} onChange={e => set('carddav_url', e.target.value)}
                        placeholder="https://carddav.provider.de/…/addressbook/" />
                    </Field>
                    <div className="acct-2col">
                      <Field label="Benutzername" hint="Leer = wie SMTP">
                        <input value={form.carddav_username} onChange={e => set('carddav_username', e.target.value)} placeholder={form.username || ''} />
                      </Field>
                      <Field label="Passwort" hint="Leer = wie SMTP">
                        <input type="password" value={form.carddav_password} onChange={e => set('carddav_password', e.target.value)} autoComplete="new-password" />
                      </Field>
                    </div>
                    {!isNew && current?.has_carddav && (
                      <button className="btn ghost sm" style={{ marginTop: 12 }} onClick={() => syncCardDav(current)} disabled={busy}>
                        <Icon name="refresh" size={13} /> {busy ? 'Synchronisiert …' : 'Jetzt synchronisieren'}
                      </button>
                    )}
                  </>
                )}

                {section === 'templates' && (
                  <>
                    <div className="muted small" style={{ marginBottom: 4 }}>
                      Neue Entwürfe mit diesem Absender erben Kopf- und Fußzeile automatisch.
                    </div>
                    {headerTemplates.length === 0 && footerTemplates.length === 0 ? (
                      <div className="empty" style={{ padding: 22 }}>
                        <Icon name="template" size={22} />
                        Noch keine Header- oder Footer-Vorlagen angelegt.
                      </div>
                    ) : (
                      <div className="acct-2col">
                        <Field label="Standard-Header">
                          <select value={form.default_header_template_id}
                            onChange={e => set('default_header_template_id', e.target.value ? Number(e.target.value) : '')}
                            style={{ width: '100%' }}>
                            <option value="">— keiner —</option>
                            {headerTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                          </select>
                        </Field>
                        <Field label="Standard-Footer">
                          <select value={form.default_footer_template_id}
                            onChange={e => set('default_footer_template_id', e.target.value ? Number(e.target.value) : '')}
                            style={{ width: '100%' }}>
                            <option value="">— keiner —</option>
                            {footerTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                          </select>
                        </Field>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Speicherleiste erscheint nur, wenn es etwas zu speichern gibt. */}
            {(dirty || isNew) && (
              <div className="acct-savebar">
                <span className="grow muted small">
                  {isNew ? 'Neues Konto – noch nicht gespeichert' : 'Ungespeicherte Änderungen'}
                </span>
                <button className="btn ghost sm" onClick={discard} disabled={saving}>Verwerfen</button>
                <button className="btn sm" onClick={save} disabled={saving}>
                  <Icon name="save" size={13} /> {saving ? 'Speichert …' : isNew ? 'Konto anlegen' : 'Speichern'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ Bausteine */

function Field({ label, hint, error, children }: {
  label: string; hint?: string; error?: string; children: React.ReactNode;
}) {
  return (
    <div className={'acct-field' + (error ? ' has-error' : '')}>
      <label>{label}</label>
      {children}
      {error ? <div className="acct-error"><Icon name="alert" size={12} /> {error}</div>
        : hint ? <div className="muted small">{hint}</div> : null}
    </div>
  );
}

/** Fähigkeits-Plakette in der Liste; färbt sich nach dem letzten Prüfergebnis. */
function Cap({ label, on, probe }: { label: string; on: boolean; probe?: Probe }) {
  const state = !on ? 'off' : probe?.state === 'ok' ? 'ok' : probe?.state === 'err' ? 'err' : 'on';
  const title = !on ? `${label} nicht konfiguriert`
    : state === 'ok' ? `${label}: Verbindung geprüft`
      : state === 'err' ? `${label}: ${probe?.message}` : `${label} konfiguriert`;
  return <span className={'acct-cap ' + state} title={title}>{label}</span>;
}

/** Prüfergebnis bleibt sichtbar – ein Toast ist weg, bevor man den Fehler liest. */
function ProbeResults({ smtp, imap }: { smtp?: Probe; imap?: Probe }) {
  const rows = [
    { key: 'SMTP', p: smtp },
    { key: 'IMAP', p: imap },
  ].filter(r => r.p && r.p.state !== 'busy');
  if (!rows.length) return null;
  return (
    <div className="acct-probes">
      {rows.map(({ key, p }) => (
        <div key={key} className={'acct-probe ' + p!.state}>
          <Icon name={p!.state === 'ok' ? 'check' : 'alert'} size={13} />
          <span className="grow">
            <strong>{key}</strong> {p!.state === 'ok' ? 'Verbindung und Anmeldung in Ordnung' : p!.message}
          </span>
        </div>
      ))}
    </div>
  );
}
