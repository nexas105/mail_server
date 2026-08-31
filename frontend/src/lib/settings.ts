import { api } from './api';
import type { Account } from './types';

export interface Settings { default_account_id?: number | null; [key: string]: unknown; }

export function getSettings(): Promise<Settings> {
  return api<Settings>('/settings').catch(() => ({} as Settings));
}

export function setDefaultAccount(id: number | null): Promise<Settings> {
  return api<Settings>('/settings', { method: 'PUT', body: { default_account_id: id } });
}

// Account-ID für neue Entwürfe: gesetzter Standard-Account, sonst der erste.
export async function resolveDefaultAccountId(accounts: Account[]): Promise<number | null> {
  const s = await getSettings();
  const id = s.default_account_id;
  if (id && accounts.some(a => a.id === id)) return id;
  return accounts[0]?.id ?? null;
}
