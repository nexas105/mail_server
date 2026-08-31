import { api } from './api';

export interface AuthUser {
  id: number;
  email: string;
  name: string | null;
  role: 'admin' | 'user';
  disabled?: boolean;
  created_at?: string;
  last_login_at?: string | null;
}

export interface AuthState {
  /** true, solange kein einziges Konto existiert – dann zeigt die UI die Ersteinrichtung. */
  needs_setup: boolean;
  setup_token_required: boolean;
  authenticated: boolean;
  user: AuthUser | null;
}

export interface ApiToken {
  id: number; name: string; created_at: string;
  last_used_at: string | null; expires_at: string | null;
}

export interface SessionInfo {
  created_at: string; last_seen_at: string; expires_at: string;
  ip: string | null; user_agent: string | null; current: boolean;
}

export const authState = () => api<AuthState>('/auth/state');

export const setup = (body: { email: string; name?: string; password: string; setup_token?: string }) =>
  api<{ ok: true; user: AuthUser }>('/auth/setup', { method: 'POST', body });

export const login = (body: { email: string; password: string; remember: boolean }) =>
  api<{ ok: true; user: AuthUser }>('/auth/login', { method: 'POST', body });

export const logout = () => api<{ ok: true }>('/auth/logout', { method: 'POST' });

export const changePassword = (current_password: string, new_password: string) =>
  api<{ ok: true }>('/auth/password', { method: 'POST', body: { current_password, new_password } });

export const listSessions = () => api<SessionInfo[]>('/auth/sessions');
export const revokeOtherSessions = () => api<{ revoked: number }>('/auth/sessions', { method: 'DELETE' });

export const listTokens = () => api<ApiToken[]>('/auth/tokens');
export const createToken = (name: string, days?: number | null) =>
  api<ApiToken & { token: string }>('/auth/tokens', { method: 'POST', body: { name, days: days || null } });
export const deleteToken = (id: number) => api<{ ok: boolean }>('/auth/tokens/' + id, { method: 'DELETE' });

export const listUsers = () => api<AuthUser[]>('/auth/users');
export const createUser = (body: { email: string; name?: string; password: string; role: 'admin' | 'user' }) =>
  api<AuthUser>('/auth/users', { method: 'POST', body });
export const updateUser = (id: number, body: Partial<Pick<AuthUser, 'name' | 'role' | 'disabled'>>) =>
  api<AuthUser>('/auth/users/' + id, { method: 'PUT', body });
export const resetUserPassword = (id: number, password: string) =>
  api<{ ok: true }>(`/auth/users/${id}/password`, { method: 'POST', body: { password } });
export const deleteUser = (id: number) => api<{ ok: boolean }>('/auth/users/' + id, { method: 'DELETE' });
