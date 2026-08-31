import { useState } from 'react';
import { Icon } from '../components/Icon';
import { setup, login, type AuthState } from '../lib/auth';

/**
 * Anmeldung – und beim allerersten Start die Einrichtung.
 *
 * Es gibt bewusst kein Standard-Passwort und keinen offenen Zustand: solange
 * kein Konto existiert, zeigt der Server needs_setup=true und hier entsteht der
 * Administrator. Danach schließt sich diese Tür dauerhaft.
 */
export function Login({ state, onDone }: { state: AuthState; onDone: () => void }) {
  const first = state.needs_setup;
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (first && password !== repeat) return setError('Die Passwörter stimmen nicht überein');
    if (first && password.length < 10) return setError('Das Passwort braucht mindestens 10 Zeichen');
    setBusy(true);
    try {
      if (first) {
        await setup({
          email: email.trim(), name: name.trim() || undefined, password,
          ...(state.setup_token_required ? { setup_token: setupToken } : {}),
        });
      } else {
        await login({ email: email.trim(), password, remember });
      }
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand">
          <span className="brand-mark" aria-hidden="true"><i /></span>
          <div>
            <small>Mail operations</small>
            <strong>Relay</strong>
          </div>
        </div>

        <h1>{first ? 'Ersteinrichtung' : 'Anmelden'}</h1>
        <p className="muted small">
          {first
            ? 'Dieser Server hat noch kein Konto. Lege jetzt den Administrator an – danach ist die Registrierung geschlossen.'
            : 'Bitte melde dich an, um Entwürfe, Posteingang und Konten zu sehen.'}
        </p>

        {first && state.setup_token_required && (
          <>
            <label>Einrichtungs-Schlüssel</label>
            <input
              type="password" autoComplete="off" value={setupToken}
              onChange={e => setSetupToken(e.target.value)}
              placeholder="Wert aus MAIL_SETUP_TOKEN" required
            />
            <div className="muted small">Steht in der Umgebung des Servers – schützt die Ersteinrichtung im Netz.</div>
          </>
        )}

        <label>E-Mail-Adresse</label>
        <input
          type="email" autoComplete={first ? 'email' : 'username'} value={email}
          onChange={e => setEmail(e.target.value)} required autoFocus
          placeholder="du@example.de"
        />

        {first && (
          <>
            <label>Name (optional)</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Vorname Nachname" />
          </>
        )}

        <label>Passwort</label>
        <input
          type="password" value={password} onChange={e => setPassword(e.target.value)}
          autoComplete={first ? 'new-password' : 'current-password'} required
          placeholder={first ? 'mindestens 10 Zeichen' : ''}
        />

        {first ? (
          <>
            <label>Passwort wiederholen</label>
            <input
              type="password" value={repeat} onChange={e => setRepeat(e.target.value)}
              autoComplete="new-password" required
            />
          </>
        ) : (
          <label className="check inline" style={{ marginTop: 10 }}>
            <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
            Angemeldet bleiben
          </label>
        )}

        {error && (
          <div className="auth-error" role="alert">
            <Icon name="alert" size={15} />
            <span>{error}</span>
          </div>
        )}

        <button className="btn" type="submit" disabled={busy} style={{ marginTop: 14, width: '100%' }}>
          {busy ? 'Einen Moment …' : (first ? 'Administrator anlegen' : 'Anmelden')}
        </button>

        <div className="muted small auth-foot">
          {first
            ? 'Das Passwort wird als scrypt-Hash gespeichert – im Klartext liegt es nirgends.'
            : 'Passwort vergessen? Ein Administrator kann es in den Einstellungen zurücksetzen.'}
        </div>
      </form>
    </div>
  );
}
