import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { csvToContacts, contactsToCsv, download, pickFile } from '../lib/csv';
import { confirmDialog } from '../components/Dialog';
import { resolveDefaultAccountId } from '../lib/settings';
import { Icon } from '../components/Icon';
import { Menu } from '../components/Menu';
import { relTime } from '../lib/dates';
import type { Contact, MailingList, Draft, Account, ContactRepo, GithubConnection, GithubRepoOption } from '../lib/types';
import { ROUTES } from '../lib/routes';

const DT_KEY = 'application/x-contact-id';
const emptyNew = { email: '', name: '', company: '', phone: '', notes: '' };

export function Contacts() {
  const nav = useNavigate();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [lists, setLists] = useState<MailingList[]>([]);
  const [nc, setNc] = useState(emptyNew);
  const [moreOpen, setMoreOpen] = useState(false);
  const [lName, setLName] = useState('');
  const [query, setQuery] = useState('');
  const [params, setParams] = useSearchParams();
  // /contacts?id=25 wählt den Kontakt direkt aus – so landet der Quicklink aus
  // dem WhatsApp-Chat nicht nur auf der Seite, sondern beim richtigen Eintrag.
  const [selected, setSelected] = useState<number | null>(
    params.get('id') ? Number(params.get('id')) : null);

  useEffect(() => {
    const id = params.get('id');
    if (id) {
      setSelected(Number(id));
      setParams({}, { replace: true });   // Adresse wieder aufräumen
    }
  }, [params]);
  const [dragId, setDragId] = useState<number | null>(null);
  const [dropList, setDropList] = useState<number | null>(null);

  const loadContacts = () => api<Contact[]>('/contacts').then(setContacts);
  const loadLists = () => api<MailingList[]>('/lists').then(setLists);
  useEffect(() => { loadContacts(); loadLists(); }, []);

  const membership = useMemo(() => {
    const m = new Map<number, MailingList[]>();
    for (const l of lists) for (const mem of l.members) {
      if (!m.has(mem.id)) m.set(mem.id, []);
      m.get(mem.id)!.push(l);
    }
    return m;
  }, [lists]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter(c =>
      [c.name, c.email, c.company, c.phone].some(v => (v || '').toLowerCase().includes(q)));
  }, [contacts, query]);

  const selectedContact = selected != null ? contacts.find(c => c.id === selected) ?? null : null;

  async function addContact() {
    if (!nc.email.trim()) return;
    await api('/contacts', { method: 'POST', body: {
      email: nc.email.trim(), name: nc.name.trim(),
      company: nc.company.trim(), phone: nc.phone.trim(), notes: nc.notes.trim(),
    } });
    setNc(emptyNew); setMoreOpen(false); loadContacts();
  }

  async function delContact(c: Contact) {
    const ok = await confirmDialog({
      title: 'Kontakt löschen?',
      message: `${c.name ? c.name + ' — ' : ''}${c.email} wird aus dem Adressbuch und allen Listen entfernt.`,
      danger: true,
    });
    if (!ok) return;
    await api('/contacts/' + c.id, { method: 'DELETE' });
    if (selected === c.id) setSelected(null);
    loadContacts(); loadLists();
  }

  function exportContacts() {
    if (!contacts.length) return toast('Keine Kontakte zum Export', 'err');
    download('kontakte.csv', contactsToCsv(contacts));
  }

  // vCard liefert der Server fertig aus – Download über die URL anstoßen.
  function exportVcf() {
    if (!contacts.length) return toast('Keine Kontakte zum Export', 'err');
    window.location.href = '/api/contacts/export.vcf';
  }

  function exportListVcf(l: MailingList) {
    if (!l.members.length) return toast('Liste ist leer', 'err');
    window.location.href = `/api/lists/${l.id}/export.vcf`;
  }

  async function importContacts() {
    const text = await pickFile('.csv,text/csv');
    if (text == null) return;
    const parsed = csvToContacts(text);
    if (!parsed.length) return toast('Keine gültigen Zeilen (email erforderlich)', 'err');
    const res = await api<{ imported: number }>('/contacts/import', { method: 'POST', body: { contacts: parsed } });
    toast(`${res.imported} Kontakte importiert`); loadContacts();
  }

  // vCard (.vcf) – das Format, das Handy-Adressbücher exportieren.
  async function importVcf() {
    const vcf = await pickFile('.vcf,text/vcard');
    if (vcf == null) return;
    try {
      const res = await api<{ imported: number }>('/contacts/import-vcf', { method: 'POST', body: { vcf } });
      if (!res.imported) return toast('Keine Kontakte in der vCard gefunden', 'err');
      toast(`${res.imported} Kontakte aus vCard importiert`); loadContacts();
    } catch (e) { toast('vCard-Fehler: ' + (e as Error).message, 'err'); }
  }

  async function importListVcf(l: MailingList) {
    const vcf = await pickFile('.vcf,text/vcard');
    if (vcf == null) return;
    try {
      const res = await api<{ imported: number }>('/lists/' + l.id + '/import-vcf', { method: 'POST', body: { vcf } });
      if (!res.imported) return toast('Keine Kontakte in der vCard gefunden', 'err');
      toast(`${res.imported} in Liste importiert`); loadLists(); loadContacts();
    } catch (e) { toast('vCard-Fehler: ' + (e as Error).message, 'err'); }
  }

  async function addList() {
    if (!lName.trim()) return;
    await api('/lists', { method: 'POST', body: { name: lName.trim() } }); setLName(''); loadLists();
  }

  async function delList(l: MailingList) {
    const ok = await confirmDialog({
      title: `Liste „${l.name}“ löschen?`,
      message: 'Die Kontakte selbst bleiben im Adressbuch erhalten.',
      danger: true,
    });
    if (ok) { await api('/lists/' + l.id, { method: 'DELETE' }); loadLists(); }
  }

  async function addExistingToList(listId: number, contactId: number) {
    const list = lists.find(l => l.id === listId);
    if (list?.members.some(m => m.id === contactId)) return;
    await api('/lists/' + listId + '/contacts', { method: 'POST', body: { contact_id: contactId } });
    loadLists();
  }

  async function removeMember(listId: number, contactId: number) {
    await api(`/lists/${listId}/contacts/${contactId}`, { method: 'DELETE' });
    loadLists();
  }

  function exportList(l: MailingList) {
    if (!l.members.length) return toast('Liste ist leer', 'err');
    download(`liste-${l.name}.csv`, contactsToCsv(l.members));
  }

  async function importList(l: MailingList) {
    const text = await pickFile('.csv,text/csv');
    if (text == null) return;
    const parsed = csvToContacts(text);
    if (!parsed.length) return toast('Keine gültigen Zeilen', 'err');
    const res = await api<{ imported: number }>('/lists/' + l.id + '/import', { method: 'POST', body: { contacts: parsed } });
    toast(`${res.imported} in Liste importiert`); loadLists(); loadContacts();
  }

  // Neuer Entwurf mit diesem Kontakt (oder dieser Liste) als Empfänger.
  async function mailToContact(c: Contact) {
    const accounts = await api<Account[]>('/accounts');
    const d = await api<Draft>('/drafts', {
      method: 'POST',
      body: {
        account_id: await resolveDefaultAccountId(accounts),
        subject: '',
        html: '<p>Hallo {{name}},</p>\n<p>…</p>',
        recipients: [{ email: c.email, name: c.name || null, kind: 'to' }],
      },
    });
    toast(`Entwurf an ${c.name || c.email} erstellt`);
    nav(ROUTES.email.draft(d.id));
  }

  async function mailToList(l: MailingList) {
    if (!l.members.length) return toast('Liste ist leer', 'err');
    const accounts = await api<Account[]>('/accounts');
    const d = await api<Draft>('/drafts', {
      method: 'POST',
      body: { account_id: await resolveDefaultAccountId(accounts), subject: '', html: '<p>Hallo {{name}},</p>\n<p>…</p>' },
    });
    await api(`/drafts/${d.id}/recipients/from-list/${l.id}`, { method: 'POST', body: { kind: 'to' } });
    toast(`Entwurf an Liste „${l.name}“ (${l.members.length}) erstellt`);
    nav(ROUTES.email.draft(d.id));
  }

  function onDrop(listId: number) {
    setDropList(null);
    const id = dragId;
    setDragId(null);
    if (id != null) addExistingToList(listId, id);
  }

  return (
    <>
      <div className="toolbar sticky-bar">
        <strong className="grow">Kontakte &amp; Listen</strong>
        <span className="muted small">Kontakt auf eine Liste ziehen, um ihn aufzunehmen</span>
      </div>

      <div className="cl-grid">
        {/* ---- Adressbuch ---- */}
        <div className="col">
          <div className="card fill">
            <div className="toolbar" style={{ marginBottom: 10 }}>
              <h2 className="grow" style={{ margin: 0 }}>Adressbuch <span className="muted">({filtered.length}/{contacts.length})</span></h2>
              <Menu
                trigger={<><Icon name="upload" size={13} /> Import</>}
                title="Kontakte importieren"
                items={[
                  { icon: 'upload', label: 'CSV-Datei', hint: '.csv', onSelect: importContacts },
                  { icon: 'smartphone', label: 'vCard (Handy-Export)', hint: '.vcf', onSelect: importVcf },
                ]}
              />
              <Menu
                trigger={<><Icon name="download" size={13} /> Export</>}
                title="Kontakte exportieren"
                items={[
                  { icon: 'download', label: 'CSV-Datei', hint: '.csv', onSelect: exportContacts },
                  { icon: 'smartphone', label: 'vCard (Handy-Import)', hint: '.vcf', onSelect: exportVcf },
                ]}
              />
            </div>
            <div className="inline">
              <input className="grow" style={{ minWidth: 140 }} placeholder="Neue E-Mail …" value={nc.email} onChange={e => setNc({ ...nc, email: e.target.value })} onKeyDown={e => e.key === 'Enter' && addContact()} />
              <input style={{ width: 130 }} placeholder="Name" value={nc.name} onChange={e => setNc({ ...nc, name: e.target.value })} onKeyDown={e => e.key === 'Enter' && addContact()} />
              <button className="btn" onClick={addContact}><Icon name="plus" size={14} /> Hinzufügen</button>
              <button className="btn ghost icon-only" title="Firma / Telefon / Notizen" onClick={() => setMoreOpen(o => !o)}>
                <Icon name={moreOpen ? 'chevronDown' : 'chevronRight'} size={14} />
              </button>
            </div>
            {moreOpen && (
              <div className="inline" style={{ marginTop: 8 }}>
                <input className="grow" placeholder="Firma" value={nc.company} onChange={e => setNc({ ...nc, company: e.target.value })} />
                <input className="grow" placeholder="Telefon" value={nc.phone} onChange={e => setNc({ ...nc, phone: e.target.value })} />
              </div>
            )}
            {moreOpen && <textarea style={{ marginTop: 8 }} rows={2} placeholder="Notizen" value={nc.notes} onChange={e => setNc({ ...nc, notes: e.target.value })} />}
            <div className="searchbox search" style={{ marginTop: 10 }}>
              <Icon name="search" size={15} />
              <input placeholder="Suchen (Name, E-Mail, Firma, Tel.) …" value={query} onChange={e => setQuery(e.target.value)} />
            </div>
            <div className="contact-scroll">
              {filtered.length === 0 ? <div className="muted" style={{ padding: '12px 4px' }}>Keine Kontakte.</div>
                : filtered.map(c => {
                  const inLists = membership.get(c.id) ?? [];
                  const sub = c.company || c.email;
                  return (
                    <div
                      key={c.id}
                      className={'contact-row' + (selected === c.id ? ' sel' : '') + (dragId === c.id ? ' dragging' : '')}
                      draggable
                      onDragStart={e => { setDragId(c.id); e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData(DT_KEY, String(c.id)); }}
                      onDragEnd={() => { setDragId(null); setDropList(null); }}
                      onClick={() => setSelected(selected === c.id ? null : c.id)}
                    >
                      <span className="drag-grip" title="Ziehen">⠿</span>
                      <div className="grow" style={{ minWidth: 0 }}>
                        <div className="title">{c.name || c.email}</div>
                        <div className="muted small" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</div>
                      </div>
                      {inLists.length > 0 && <span className="badge" title={inLists.map(l => l.name).join(', ')}>{inLists.length} {inLists.length === 1 ? 'Liste' : 'Listen'}</span>}
                      {!!c.repo_count && <span className="badge" title="Verknüpfte GitHub-Repos"><Icon name="git" size={11} /> {c.repo_count}</span>}
                      <button className="btn ghost sm icon-only" title="Mail an diesen Kontakt"
                        onClick={e => { e.stopPropagation(); mailToContact(c); }}><Icon name="send" size={13} /></button>
                      <span className="x muted" title="Löschen" style={{ cursor: 'pointer', display: 'inline-flex' }}
                        onClick={e => { e.stopPropagation(); delContact(c); }}><Icon name="x" size={14} /></span>
                    </div>
                  );
                })}
            </div>
          </div>

          {selectedContact && (
            <ContactDetail
              key={selectedContact.id}
              contact={selectedContact}
              lists={membership.get(selectedContact.id) ?? []}
              onClose={() => setSelected(null)}
              onRemoveFromList={lid => removeMember(lid, selectedContact.id)}
              onSaved={loadContacts}
              onMail={() => mailToContact(selectedContact)}
            />
          )}
        </div>

        {/* ---- Listen (Drop-Ziele) ---- */}
        <div className="col">
          <div className="card sticky-card">
            <h2>Neue Liste</h2>
            <div className="inline">
              <input className="grow" placeholder="Listenname" value={lName} onChange={e => setLName(e.target.value)} onKeyDown={e => e.key === 'Enter' && addList()} />
              <button className="btn" onClick={addList}><Icon name="plus" size={14} /> Erstellen</button>
            </div>
          </div>

          <div className="col-scroll">
          {lists.length === 0 ? <div className="empty"><Icon name="users" size={28} />Noch keine Listen. Lege oben eine an.</div>
            : lists.map(l => {
              const isDrop = dropList === l.id;
              const already = dragId != null && l.members.some(m => m.id === dragId);
              return (
                <div
                  key={l.id}
                  className={'card list-drop' + (isDrop ? (already ? ' drop-dupe' : ' drop-active') : '')}
                  onDragOver={e => { if (dragId != null) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDropList(l.id); } }}
                  onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropList(cur => cur === l.id ? null : cur); }}
                  onDrop={e => { e.preventDefault(); onDrop(l.id); }}
                >
                  <div className="toolbar" style={{ marginBottom: 6 }}>
                    <strong className="grow" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {l.name} <span className="muted">({l.members.length})</span>
                    </strong>
                    <button className="btn ghost sm icon-only" title="Mail an diese Liste" onClick={() => mailToList(l)}><Icon name="send" size={13} /></button>
                    <Menu align="right" title="Importieren" trigger={<Icon name="upload" size={13} />} items={[
                      { icon: 'upload', label: 'CSV in diese Liste', hint: '.csv', onSelect: () => importList(l) },
                      { icon: 'smartphone', label: 'vCard in diese Liste', hint: '.vcf', onSelect: () => importListVcf(l) },
                    ]} />
                    <Menu align="right" title="Exportieren" trigger={<Icon name="download" size={13} />} items={[
                      { icon: 'download', label: 'Als CSV exportieren', hint: '.csv', onSelect: () => exportList(l) },
                      { icon: 'smartphone', label: 'Als vCard exportieren', hint: '.vcf', onSelect: () => exportListVcf(l) },
                    ]} />
                    <button className="btn danger sm icon-only" title="Liste löschen" onClick={() => delList(l)}><Icon name="trash" size={13} /></button>
                  </div>
                  <div className="list-members">
                    {l.members.length === 0
                      ? <span className="muted" style={{ fontSize: 13 }}>Leer — Kontakt hierher ziehen.</span>
                      : l.members.map(m => (
                        <span key={m.id} className="pill">{m.name || m.email}
                          <span className="x" title="Aus Liste entfernen" onClick={() => removeMember(l.id, m.id)}><Icon name="x" size={12} /></span>
                        </span>))}
                  </div>
                  {isDrop && <div className="drop-hint">{already ? 'Bereits in dieser Liste' : '＋ Hier ablegen'}</div>}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}

function ContactDetail({ contact, lists, onClose, onRemoveFromList, onSaved, onMail }: {
  contact: Contact;
  lists: MailingList[];
  onClose: () => void;
  onRemoveFromList: (listId: number) => void;
  onSaved: () => void;
  onMail: () => void;
}) {
  const [f, setF] = useState({
    name: contact.name || '', company: contact.company || '',
    phone: contact.phone || '', notes: contact.notes || '',
  });
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await api('/contacts/' + contact.id, { method: 'PUT', body: f });
      toast('Kontakt gespeichert'); onSaved();
    } catch (e) { toast((e as Error).message, 'err'); }
    setSaving(false);
  }

  const [tab, setTab] = useState<'data' | 'repos'>('data');

  return (
    <div className="card contact-detail">
      <div className="toolbar" style={{ marginBottom: 8 }}>
        <h2 className="grow" style={{ margin: 0 }}>Kontakt-Detail</h2>
        <button className="btn sm" onClick={onMail}><Icon name="send" size={13} /> Mail senden</button>
        <button className="btn ghost sm icon-only" title="Schließen" onClick={onClose}><Icon name="x" size={14} /></button>
      </div>
      <div className="muted" style={{ marginBottom: 10 }}>{contact.email}</div>

      <div className="tabs2" style={{ marginBottom: 12 }}>
        <button className={tab === 'data' ? 'active' : ''} onClick={() => setTab('data')}>Stammdaten</button>
        <button className={tab === 'repos' ? 'active' : ''} onClick={() => setTab('repos')}>
          Repos{contact.repo_count ? ` (${contact.repo_count})` : ''}
        </button>
      </div>

      {tab === 'repos' ? <ContactRepos contact={contact} onChanged={onSaved} /> : <>
      <div className="inline">
        <div className="grow"><label>Name</label><input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></div>
        <div className="grow"><label>Firma</label><input value={f.company} onChange={e => setF({ ...f, company: e.target.value })} /></div>
      </div>
      <label>Telefon</label>
      <input value={f.phone} onChange={e => setF({ ...f, phone: e.target.value })} />
      <label>Notizen</label>
      <textarea rows={3} value={f.notes} onChange={e => setF({ ...f, notes: e.target.value })} />
      <div className="toolbar" style={{ marginTop: 12, marginBottom: 0 }}>
        <button className="btn" onClick={save} disabled={saving}><Icon name="save" size={14} /> {saving ? 'Speichert …' : 'Speichern'}</button>
      </div>
      <label>Mitglied in</label>
      {lists.length === 0
        ? <div className="muted" style={{ fontSize: 13 }}>In keiner Liste. Ziehe den Kontakt auf eine Liste →</div>
        : <div>{lists.map(l => (
            <span key={l.id} className="pill">{l.name}
              <span className="x" title="Aus Liste entfernen" onClick={() => onRemoveFromList(l.id)}><Icon name="x" size={12} /></span>
            </span>))}</div>}
      </>}
    </div>
  );
}

/**
 * GitHub-Repos eines Kontakts. Die Auswahlliste kommt live vom Token; wer ein Repo
 * aus einer fremden Organisation verknüpfen will, kann "owner/name" auch tippen –
 * /user/repos liefert nicht immer alles.
 */
function ContactRepos({ contact, onChanged }: { contact: Contact; onChanged: () => void }) {
  const [repos, setRepos] = useState<ContactRepo[] | null>(null);
  const [conns, setConns] = useState<GithubConnection[]>([]);
  const [options, setOptions] = useState<GithubRepoOption[] | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => api<ContactRepo[]>('/contacts/' + contact.id + '/repos').then(setRepos);
  useEffect(() => {
    load();
    api<GithubConnection[]>('/github/connections').then(setConns).catch(() => setConns([]));
  }, [contact.id]);

  const conn = conns.find(c => c.is_default === 1) || conns[0];

  // Repo-Liste erst beim ersten Tippen holen – spart einen API-Aufruf pro Kontakt.
  async function loadOptions() {
    if (options || !conn) return;
    try { setOptions(await api<GithubRepoOption[]>('/github/connections/' + conn.id + '/repos')); }
    catch (e) { toast((e as Error).message, 'err'); setOptions([]); }
  }

  async function link(fullName: string) {
    setBusy(true);
    try {
      await api('/contacts/' + contact.id + '/repos', { method: 'POST', body: { full_name: fullName } });
      toast(fullName + ' verknüpft');
      setQ(''); await load(); onChanged();
    } catch (e) { toast((e as Error).message, 'err'); }
    setBusy(false);
  }

  async function unlink(r: ContactRepo) {
    if (!await confirmDialog({
      title: 'Verknüpfung lösen?',
      message: `${r.full_name} wird von diesem Kontakt gelöst. Bei GitHub ändert sich nichts.`,
      confirmLabel: 'Lösen',
    })) return;
    try { await api('/contact-repos/' + r.id, { method: 'DELETE' }); await load(); onChanged(); }
    catch (e) { toast((e as Error).message, 'err'); }
  }

  if (!conn) {
    return (
      <div className="empty" style={{ padding: '20px 0' }}>
        <Icon name="git" size={26} />
        <div>Kein GitHub-Token hinterlegt</div>
        <div className="muted small">Unter <strong>Einstellungen</strong> anlegen, dann lassen sich hier Repos verknüpfen.</div>
      </div>
    );
  }

  const typed = q.trim();
  const matches = (options || []).filter(o => o.full_name.toLowerCase().includes(typed.toLowerCase())).slice(0, 12);
  const linked = new Set((repos || []).map(r => r.full_name));
  const canLinkTyped = typed.includes('/') && !matches.some(m => m.full_name === typed) && !linked.has(typed);

  return (
    <>
      {repos === null ? <div className="skel skel-row" /> : repos.length === 0 ? (
        <div className="muted small" style={{ marginBottom: 10 }}>Noch keine Repos verknüpft.</div>
      ) : repos.map(r => (
        <div key={r.id} className="list-item static" style={{ alignItems: 'flex-start' }}>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="title">
              {r.full_name}
              {r.private === 1 && <span className="badge" style={{ marginLeft: 6 }}>Privat</span>}
            </div>
            {r.description && <div className="muted small">{r.description}</div>}
            <div className="muted small">
              {r.default_branch}{r.pushed_at && <> · zuletzt {relTime(r.pushed_at)}</>}
            </div>
          </div>
          {r.html_url && (
            <a className="btn ghost sm icon-only" href={r.html_url} target="_blank" rel="noreferrer" title="Bei GitHub öffnen">
              <Icon name="external" size={13} />
            </a>
          )}
          <span className="x muted" title="Verknüpfung lösen" style={{ cursor: 'pointer', display: 'inline-flex' }}
            onClick={() => unlink(r)}><Icon name="x" size={14} /></span>
        </div>
      ))}

      <label style={{ marginTop: 12 }}>Repo verknüpfen</label>
      <div className="searchbox">
        <Icon name="search" size={14} />
        <input value={q} placeholder="Suchen oder owner/name eingeben"
          onFocus={loadOptions} onChange={e => setQ(e.target.value)} />
      </div>
      {typed && (
        <div style={{ marginTop: 6 }}>
          {matches.filter(m => !linked.has(m.full_name)).map(m => (
            <div key={m.repo_id} className="list-item" onClick={() => !busy && link(m.full_name)}>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="title">{m.full_name}</div>
                {m.description && <div className="muted small">{m.description}</div>}
              </div>
              {m.private === 1 && <span className="badge">Privat</span>}
            </div>
          ))}
          {canLinkTyped && (
            <div className="list-item" onClick={() => !busy && link(typed)}>
              <div className="grow"><div className="title">„{typed}" trotzdem verknüpfen</div>
                <div className="muted small">Wird bei GitHub aufgelöst – z.B. für Repos aus fremden Organisationen.</div>
              </div>
              <Icon name="plus" size={14} />
            </div>
          )}
          {options !== null && !matches.length && !canLinkTyped &&
            <div className="muted small" style={{ marginTop: 6 }}>Nichts gefunden.</div>}
        </div>
      )}
    </>
  );
}
