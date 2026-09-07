import { useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { getTheme, setTheme, onThemeChange, type Theme } from '../lib/theme';
import { logout, type AuthUser } from '../lib/auth';
import { toast } from '../lib/toast';
import { onWaEvent } from '../lib/waStream';
import { getWorkspace, setWorkspace, onWorkspaceChange, workspaceOf, type Workspace } from '../lib/workspace';
import { Icon, type IconName } from './Icon';
import { ROUTES } from '../lib/routes';

const active = ({ isActive }: { isActive: boolean }) => (isActive ? 'active' : '');

type NavItem = { to: string; end?: boolean; icon: IconName; label: string; badge?: 'mail' | 'wa' };
type WorkspaceKey = Workspace;

/**
 * Zwei Arbeitsbereiche, umschaltbar über den Reiter ganz oben. Die Seitenleiste
 * zeigt immer nur den aktiven – Mail-Werkzeuge und WhatsApp-Werkzeuge haben
 * nichts miteinander zu tun und sollen sich nicht gegenseitig zuschütten.
 * Was für beide gilt, steht unten und bleibt immer sichtbar.
 */
const WORKSPACES: {
  key: WorkspaceKey; label: string; icon: IconName; badge: 'mail' | 'wa'; items: NavItem[];
}[] = [
  {
    key: 'mail', label: 'E-Mail', icon: 'mail', badge: 'mail',
    items: [
      { to: ROUTES.email.inbox, icon: 'inbox', label: 'Posteingang', badge: 'mail' },
      { to: ROUTES.email.drafts, icon: 'draft', label: 'Entwürfe' },
      { to: ROUTES.email.outbox, icon: 'send', label: 'Postausgang' },
      { to: ROUTES.email.templates, icon: 'template', label: 'Vorlagen' },
      { to: ROUTES.manage.media, icon: 'image', label: 'Medien' },
      { to: ROUTES.manage.brands, icon: 'sparkle', label: 'Marken' },
      { to: ROUTES.manage.accounts, icon: 'server', label: 'Konten' },
    ],
  },
  {
    key: 'wa', label: 'WhatsApp', icon: 'chat', badge: 'wa',
    items: [
      { to: ROUTES.whatsapp.chats, end: true, icon: 'chat', label: 'Chats', badge: 'wa' },
      { to: ROUTES.whatsapp.scheduled, icon: 'clock', label: 'Geplant' },
      { to: ROUTES.whatsapp.connect, icon: 'smartphone', label: 'Verbindung' },
      { to: ROUTES.whatsapp.contacts, icon: 'users', label: 'WhatsApp-Kontakte' },
    ],
  },
];

/** Immer sichtbar, unabhängig vom Arbeitsbereich. */
const general: NavItem[] = [
  { to: ROUTES.dashboard, end: true, icon: 'monitor', label: 'Dashboard' },
  // Das Adressbuch gehört zu beiden Kanälen – an einem Kontakt hängen
  // Mailadresse, WhatsApp-Nummer und verknüpfte Repos.
  { to: ROUTES.manage.contacts, icon: 'users', label: 'Kontakte' },
  { to: ROUTES.settings, icon: 'settings', label: 'Einstellungen' },
  { to: ROUTES.guide, icon: 'book', label: 'Anleitung' },
];

const THEMES: { key: Theme; icon: IconName; label: string }[] = [
  { key: 'light', icon: 'sun', label: 'Hell' },
  { key: 'system', icon: 'monitor', label: 'System' },
  { key: 'dark', icon: 'moon', label: 'Dunkel' },
];

interface HeaderProps {
  onOpenPalette: () => void;
  user: AuthUser | null;
  onSignedOut: () => void;
}

export function Header({ onOpenPalette, user, onSignedOut }: HeaderProps) {
  const [theme, setThemeState] = useState<Theme>(getTheme());
  const [mailUnread, setMailUnread] = useState(0);
  const [waUnread, setWaUnread] = useState(0);
  const location = useLocation();
  const navigate = useNavigate();

  // Der Pfad bestimmt den Bereich; auf den allgemeinen Seiten bleibt der letzte stehen.
  const [ws, setWs] = useState<WorkspaceKey>(() => workspaceOf(location.pathname) ?? getWorkspace());

  // Andere Stellen (z.B. die Einstellungen) hören auf denselben Zustand mit.
  useEffect(() => onWorkspaceChange(() => setWs(getWorkspace())), []);

  useEffect(() => {
    const w = workspaceOf(location.pathname);
    if (w && w !== ws) { setWs(w); setWorkspace(w); }
  }, [location.pathname]);

  useEffect(() => onThemeChange(() => setThemeState(getTheme())), []);

  useEffect(() => {
    let alive = true;
    const load = () => {
      api<{ count: number }>('/messages/unread-count')
        .then(r => { if (alive) setMailUnread(r.count); }).catch(() => {});
      api<{ unread: number }>('/whatsapp/unread-count')
        .then(r => { if (alive) setWaUnread(r.unread); }).catch(() => {});
    };
    load();
    const t = setInterval(load, 45000);
    return () => { alive = false; clearInterval(t); };
  }, [location.pathname]);

  // WhatsApp meldet sich von selbst – nicht auf den 45-Sekunden-Takt warten.
  useEffect(() => onWaEvent(event => {
    if (event === 'message' || event === 'chat') {
      api<{ unread: number }>('/whatsapp/unread-count').then(r => setWaUnread(r.unread)).catch(() => {});
    }
  }), []);

  const isMac = navigator.platform.toUpperCase().includes('MAC');
  const counts = { mail: mailUnread, wa: waUnread };
  const current = WORKSPACES.find(w => w.key === ws) || WORKSPACES[0];

  function switchTo(key: WorkspaceKey) {
    setWs(key);
    setWorkspace(key);
    // Vom Dashboard und innerhalb eines Kanals öffnet der Reiter direkt dessen
    // Startseite. Verwaltungsseiten behalten dagegen ihren aktuellen Kontext.
    if (location.pathname === ROUTES.dashboard || workspaceOf(location.pathname)) {
      navigate(WORKSPACES.find(w => w.key === key)!.items[0].to);
    }
  }

  const renderItem = (item: NavItem) => {
    const n = item.badge ? counts[item.badge] : 0;
    return (
      <NavLink key={item.to} to={item.to} end={item.end} className={active}>
        <Icon name={item.icon} size={16} />
        <span>{item.label}</span>
        {n > 0 && <span className="nav-badge">{n > 99 ? '99+' : n}</span>}
      </NavLink>
    );
  };

  return (
    <header>
      <div className="brand">
        <span className="brand-mark" aria-hidden="true"><i /></span>
        <span><small>Mail operations</small><strong>Relay</strong></span>
        <span className="version">V3</span>
      </div>

      <div className="ws-tabs" role="tablist" aria-label="Bereich">
        {WORKSPACES.map(w => {
          const n = counts[w.badge];
          return (
            <button
              key={w.key}
              role="tab"
              aria-selected={ws === w.key}
              className={ws === w.key ? 'active' : ''}
              onClick={() => switchTo(w.key)}
            >
              <Icon name={w.icon} size={14} />
              <span>{w.label}</span>
              {n > 0 && <span className="ws-dot" aria-label={`${n} ungelesen`} />}
            </button>
          );
        })}
      </div>

      <button className="palette-trigger" onClick={onOpenPalette}>
        <Icon name="search" size={14} />
        <span>Suchen …</span>
        <kbd>{isMac ? '⌘' : 'Strg'} K</kbd>
      </button>

      <nav aria-label="Hauptnavigation">
        <div className="nav-group" key={current.key}>
          {current.items.map(renderItem)}
        </div>
        <div className="nav-group nav-general">
          <div className="nav-group-label">Allgemein</div>
          {general.map(renderItem)}
        </div>
      </nav>

      <div className="theme-switch" role="radiogroup" aria-label="Design">
        {THEMES.map(t => (
          <button
            key={t.key}
            role="radio"
            aria-checked={theme === t.key}
            className={theme === t.key ? 'active' : ''}
            title={t.label}
            onClick={() => setTheme(t.key)}
          >
            <Icon name={t.icon} size={14} />
          </button>
        ))}
      </div>
      <div className="account-strip">
        {/* Name und Bild führen aufs eigene Profil, der Knopf daneben meldet ab. */}
        <NavLink to={ROUTES.profile} className={({ isActive }) => 'account-link' + (isActive ? ' active' : '')}
          title="Profil öffnen">
          <span className="account-avatar" aria-hidden="true">{(user?.name || user?.email || '?').trim().charAt(0).toUpperCase()}</span>
          <span className="account-who">
            <strong title={user?.email}>{user?.name || user?.email}</strong>
            <small>{user?.role === 'admin' ? 'Administrator' : 'Benutzer'}</small>
          </span>
        </NavLink>
        <button
          type="button" className="account-signout" title="Abmelden" aria-label="Abmelden"
          onClick={async () => {
            try { await logout(); } catch { /* Sitzung war ohnehin weg */ }
            toast('Abgemeldet');
            onSignedOut();
          }}
        >
          <Icon name="external" size={14} />
        </button>
      </div>
      <div className="system-state"><span /> System bereit</div>
    </header>
  );
}
