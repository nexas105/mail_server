import { useCallback, useEffect, useState } from 'react';
import { Routes, Route, Navigate, useLocation, useParams } from 'react-router-dom';
import { onUnauthorized } from './lib/api';
import { authState, type AuthState } from './lib/auth';
import { Login } from './pages/Login';
import { Header } from './components/Header';
import { DialogHost } from './components/Dialog';
import { CommandPalette } from './components/CommandPalette';
import { DraftsList } from './pages/DraftsList';
import { DraftEditor } from './pages/DraftEditor';
import { Accounts } from './pages/Accounts';
import { Contacts } from './pages/Contacts';
import { Outbox } from './pages/Outbox';
import { Inbox } from './pages/Inbox';
import { Templates } from './pages/Templates';
import { Media } from './pages/Media';
import { Brands } from './pages/Brands';
import { Guide } from './pages/Guide';
import { Settings } from './pages/Settings';
import { Profile } from './pages/Profile';
import { WhatsApp } from './pages/WhatsApp';
import { WhatsAppConnect } from './pages/WhatsAppConnect';
import { WhatsAppContacts } from './pages/WhatsAppContacts';
import { Dashboard } from './pages/Dashboard';
import { LEGACY_ROUTES, ROUTES } from './lib/routes';

/**
 * Türsteher: solange nicht klar ist, wer da ist, wird nichts von der App
 * gerendert. Der Server würde ohnehin jeden /api-Aufruf mit 401 beantworten –
 * so sieht der Nutzer statt einer Wand aus Fehlermeldungen die Anmeldung.
 */
export default function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);

  const refresh = useCallback(() => authState()
    .then(setAuth)
    .catch(() => setAuth({ needs_setup: false, setup_token_required: false, authenticated: false, user: null })), []);

  useEffect(() => { refresh(); }, [refresh]);

  // Abgelaufene Sitzung: irgendein Aufruf bekommt 401 → zurück zur Anmeldung.
  useEffect(() => onUnauthorized(() => {
    setAuth(prev => (prev?.authenticated ? { ...prev, authenticated: false, user: null } : prev));
  }), []);

  if (!auth) return <div className="auth-screen" aria-busy="true" />;
  if (!auth.authenticated) return <Login state={auth} onDone={refresh} />;

  return <Shell user={auth.user} onSignedOut={refresh} />;
}

function Shell({ user, onSignedOut }: { user: AuthState['user']; onSignedOut: () => void }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(o => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app-shell">
      <Header onOpenPalette={() => setPaletteOpen(true)} user={user} onSignedOut={onSignedOut} />
      {/* key erzwingt Remount pro Route → Eintritts-Animation der Seite */}
      <main key={location.pathname} className="page-enter">
        <Routes>
          <Route path={ROUTES.dashboard} element={<Dashboard />} />
          <Route path={ROUTES.email.root} element={<Navigate to={ROUTES.email.drafts} replace />} />
          <Route path={ROUTES.email.drafts} element={<DraftsList />} />
          <Route path="/email/entwuerfe/:id" element={<DraftEditor />} />
          <Route path={ROUTES.email.inbox} element={<Inbox />} />
          <Route path={ROUTES.email.outbox} element={<Outbox />} />
          <Route path={ROUTES.email.templates} element={<Templates />} />
          <Route path={ROUTES.manage.accounts} element={<Accounts />} />
          <Route path={ROUTES.manage.contacts} element={<Contacts />} />
          <Route path={ROUTES.manage.media} element={<Media />} />
          <Route path={ROUTES.manage.brands} element={<Brands />} />
          <Route path={ROUTES.whatsapp.chats} element={<WhatsApp />} />
          <Route path={ROUTES.whatsapp.connect} element={<WhatsAppConnect />} />
          <Route path={ROUTES.whatsapp.contacts} element={<WhatsAppContacts />} />
          <Route path={ROUTES.profile} element={<Profile />} />
          <Route path={ROUTES.settings} element={<Settings />} />
          <Route path={ROUTES.guide} element={<Guide />} />
          <Route path="/draft/:id" element={<LegacyDraftRedirect />} />
          {Object.entries(LEGACY_ROUTES).map(([from, to]) => <Route key={from} path={from} element={<Navigate to={to} replace />} />)}
          <Route path="*" element={<Navigate to={ROUTES.dashboard} replace />} />
        </Routes>
      </main>
      <DialogHost />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}

function LegacyDraftRedirect() {
  const { id } = useParams();
  return <Navigate to={ROUTES.email.draft(id || '')} replace />;
}
