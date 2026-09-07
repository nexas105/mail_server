import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { setTheme } from '../lib/theme';
import { resolveDefaultAccountId } from '../lib/settings';
import { Icon, type IconName } from './Icon';
import type { Draft, Contact, Account } from '../lib/types';
import { ROUTES } from '../lib/routes';

interface Item {
  id: string;
  icon: IconName;
  title: string;
  hint?: string;
  section: string;
  keywords?: string;
  run: () => void | Promise<void>;
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [closing, setClosing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery(''); setActive(0); setClosing(false);
    setTimeout(() => inputRef.current?.focus(), 30);
    api<Draft[]>('/drafts').then(setDrafts).catch(() => {});
    api<Contact[]>('/contacts').then(setContacts).catch(() => {});
  }, [open]);

  const close = () => {
    setClosing(true);
    setTimeout(onClose, 130);
  };

  const go = (to: string) => { nav(to); close(); };

  async function newDraft() {
    try {
      const accounts = await api<Account[]>('/accounts');
      const d = await api<Draft>('/drafts', {
        method: 'POST',
        body: { subject: '', html: '<p>Hallo {{name}},</p>\n<p>…</p>', account_id: await resolveDefaultAccountId(accounts) },
      });
      nav(ROUTES.email.draft(d.id));
      close();
    } catch (e) { toast((e as Error).message, 'err'); }
  }

  const items = useMemo<Item[]>(() => {
    const base: Item[] = [
      { id: 'new-draft', icon: 'plus', title: 'Neuer Entwurf', hint: 'Aktion', section: 'Aktionen', keywords: 'anlegen erstellen mail', run: newDraft },
      { id: 'nav-dashboard', icon: 'monitor', title: 'Übersicht', section: 'Navigation', run: () => go(ROUTES.dashboard) },
      { id: 'nav-drafts', icon: 'draft', title: 'Entwürfe', section: 'Navigation', run: () => go(ROUTES.email.drafts) },
      { id: 'nav-inbox', icon: 'inbox', title: 'Posteingang', section: 'Navigation', keywords: 'mails empfangen imap', run: () => go(ROUTES.email.inbox) },
      { id: 'nav-outbox', icon: 'send', title: 'Postausgang', section: 'Navigation', keywords: 'gesendet versand', run: () => go(ROUTES.email.outbox) },
      { id: 'nav-contacts', icon: 'users', title: 'Kontakte & Listen', section: 'Navigation', keywords: 'adressbuch', run: () => go(ROUTES.manage.contacts) },
      { id: 'nav-templates', icon: 'template', title: 'Vorlagen', section: 'Navigation', keywords: 'templates variablen', run: () => go(ROUTES.email.templates) },
      { id: 'nav-media', icon: 'image', title: 'Medien', section: 'Navigation', keywords: 'bilder logo assets bibliothek', run: () => go(ROUTES.manage.media) },
      { id: 'nav-brands', icon: 'sparkle', title: 'Marken', section: 'Navigation', keywords: 'brand farbe corporate identity preset', run: () => go(ROUTES.manage.brands) },
      { id: 'nav-accounts', icon: 'server', title: 'E-Mail-Konten', section: 'Navigation', keywords: 'smtp imap carddav accounts', run: () => go(ROUTES.manage.accounts) },
      { id: 'nav-whatsapp', icon: 'chat', title: 'WhatsApp-Chats', section: 'Navigation', keywords: 'whatsapp wa nachrichten chat', run: () => go(ROUTES.whatsapp.chats) },
      { id: 'nav-wa-scheduled', icon: 'clock', title: 'Geplante WhatsApp-Nachrichten', section: 'Navigation', keywords: 'whatsapp geplant später senden zeitplan timer', run: () => go(ROUTES.whatsapp.scheduled) },
      { id: 'nav-wa-connect', icon: 'smartphone', title: 'WhatsApp-Verbindung', section: 'Navigation', keywords: 'whatsapp koppeln qr pairing verbinden', run: () => go(ROUTES.whatsapp.connect) },
      { id: 'nav-settings', icon: 'settings', title: 'Einstellungen', section: 'Navigation', keywords: 'github token einstellungen konfiguration', run: () => go(ROUTES.settings) },
      { id: 'nav-guide', icon: 'book', title: 'Anleitung', section: 'Navigation', keywords: 'mcp hilfe setup', run: () => go(ROUTES.guide) },
      { id: 'theme-light', icon: 'sun', title: 'Helles Design', section: 'Darstellung', keywords: 'theme light hell', run: () => { setTheme('light'); close(); } },
      { id: 'theme-dark', icon: 'moon', title: 'Dunkles Design', section: 'Darstellung', keywords: 'theme dark dunkel', run: () => { setTheme('dark'); close(); } },
      { id: 'theme-system', icon: 'monitor', title: 'System-Design', section: 'Darstellung', keywords: 'theme auto', run: () => { setTheme('system'); close(); } },
    ];
    const q = query.trim().toLowerCase();
    if (!q) return base;

    const matches = (s: string | null | undefined) => (s || '').toLowerCase().includes(q);
    const filtered = base.filter(i => matches(i.title) || matches(i.keywords));

    const draftHits: Item[] = drafts
      .filter(d => matches(d.subject) || String(d.id) === q)
      .slice(0, 6)
      .map(d => ({
        id: 'draft-' + d.id, icon: 'draft' as IconName,
        title: d.subject || `(kein Betreff) #${d.id}`,
        hint: `${d.status} · ${d.recipient_count ?? 0} Empf.`,
        section: 'Entwürfe',
        run: () => go(ROUTES.email.draft(d.id)),
      }));

    const contactHits: Item[] = contacts
      .filter(c => matches(c.name) || matches(c.email) || matches(c.company))
      .slice(0, 6)
      .map(c => ({
        id: 'contact-' + c.id, icon: 'users' as IconName,
        title: c.name || c.email,
        hint: c.name ? c.email : undefined,
        section: 'Kontakte',
        run: () => go(ROUTES.manage.contacts),
      }));

    return [...filtered, ...draftHits, ...contactHits];
  }, [query, drafts, contacts]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setActive(0); }, [query]);

  useEffect(() => {
    const el = listRef.current?.querySelector('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); items[active]?.run(); }
  };

  let lastSection = '';
  return (
    <div className={'overlay palette-overlay' + (closing ? ' closing' : '')}
      onMouseDown={e => { if (e.target === e.currentTarget) close(); }} onKeyDown={onKey}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Befehlspalette">
        <div className="palette-input">
          <Icon name="search" size={17} />
          <input
            ref={inputRef}
            value={query}
            placeholder="Seite, Entwurf, Kontakt oder Befehl suchen …"
            onChange={e => setQuery(e.target.value)}
          />
          <kbd>esc</kbd>
        </div>
        <div className="palette-list" ref={listRef}>
          {items.length === 0 && <div className="palette-empty">Nichts gefunden für „{query}“</div>}
          {items.map((item, i) => {
            const showSection = item.section !== lastSection;
            lastSection = item.section;
            return (
              <div key={item.id}>
                {showSection && <div className="palette-section">{item.section}</div>}
                <button
                  className={'palette-item' + (i === active ? ' active' : '')}
                  data-active={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => item.run()}
                >
                  <Icon name={item.icon} size={16} />
                  <span className="palette-title">{item.title}</span>
                  {item.hint && <span className="palette-hint">{item.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
