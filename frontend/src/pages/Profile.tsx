import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { logout, type AuthUser } from '../lib/auth';
import { relTime } from '../lib/dates';
import { confirmDialog } from '../components/Dialog';
import { Icon, type IconName } from '../components/Icon';
import { AccountCard, UsersCard } from '../components/AccessCards';
import { GithubCard } from '../components/GithubCard';
import { ROUTES } from '../lib/routes';

type Tab = 'konto' | 'github' | 'benutzer';

/**
 * Alles, was an einer Person hängt – erreichbar über den Namen unten in der
 * Seitenleiste. Bewusst getrennt von den Einstellungen: dort geht es darum,
 * wie der Server sich verhält, hier darum, wer ihn benutzt.
 *
 * Der aktive Reiter steht in der Adresse (?tab=github), damit sich ein Reiter
 * verlinken lässt und ein Neuladen nicht zurückspringt.
 */
export function Profile() {
  const [me, setMe] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();

  useEffect(() => {
    api<AuthUser>('/auth/me').then(setMe).catch(() => setMe(null)).finally(() => setLoading(false));
  }, []);

  const isAdmin = me?.role === 'admin';
  const raw = params.get('tab');
  const tab: Tab = raw === 'github' ? 'github'
    : raw === 'benutzer' && isAdmin ? 'benutzer' : 'konto';

  const setTab = (t: Tab) => setParams(t === 'konto' ? {} : { tab: t }, { replace: true });

  async function signOut() {
    if (!await confirmDialog({
      title: 'Abmelden?',
      message: 'Du wirst zur Anmeldung zurückgeschickt. Laufende Versände und die '
        + 'WhatsApp-Verbindung laufen auf dem Server weiter.',
      confirmLabel: 'Abmelden',
    })) return;
    try { await logout(); } catch { /* Sitzung war ohnehin weg */ }
    toast('Abgemeldet');
    nav(ROUTES.dashboard);
    location.reload();
  }

  if (loading) {
    return (
      <>
        <div className="toolbar"><strong className="grow" style={{ fontSize: 18 }}>Profil</strong></div>
        <div style={{ maxWidth: 780 }}><div className="skel skel-row" /></div>
      </>
    );
  }

  if (!me) {
    return (
      <div className="empty" style={{ padding: '48px 0' }}>
        <Icon name="users" size={28} />
        <div>Nicht angemeldet</div>
      </div>
    );
  }

  const initial = (me.name || me.email || '?').trim().charAt(0).toUpperCase();
  const tabs: { key: Tab; label: string; icon: IconName }[] = [
    { key: 'konto', label: 'Mein Konto', icon: 'users' },
    { key: 'github', label: 'GitHub', icon: 'git' },
    ...(isAdmin ? [{ key: 'benutzer' as Tab, label: 'Benutzer', icon: 'server' as IconName }] : []),
  ];

  return (
    <>
      <div className="toolbar">
        <strong className="grow" style={{ fontSize: 18 }}>Profil</strong>
        <button className="btn ghost sm" onClick={signOut}>
          <Icon name="external" size={13} /> Abmelden
        </button>
      </div>

      <div style={{ maxWidth: 780, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="card profile-head">
          <span className="profile-avatar" aria-hidden="true">{initial}</span>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="profile-name">{me.name || me.email}</div>
            <div className="muted small">{me.email}</div>
            <div style={{ marginTop: 6 }}>
              <span className={'badge' + (isAdmin ? ' sent' : '')}>
                {isAdmin ? 'Administrator' : 'Benutzer'}
              </span>
              {me.created_at && (
                <span className="muted small" style={{ marginLeft: 8 }}>
                  dabei seit {relTime(me.created_at)}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="tabs2">
          {tabs.map(t => (
            <button key={t.key} className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)}>
              <Icon name={t.icon} size={13} /> {t.label}
            </button>
          ))}
        </div>

        {tab === 'konto' && <AccountCard user={me} />}
        {tab === 'github' && <GithubCard />}
        {tab === 'benutzer' && isAdmin && <UsersCard me={me} />}
      </div>
    </>
  );
}
