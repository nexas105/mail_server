/**
 * Der aktive Arbeitsbereich (E-Mail oder WhatsApp).
 *
 * Liegt hier statt im Header, weil ihn mehrere Stellen brauchen: die
 * Seitenleiste schaltet damit ihre Navigation um, die Einstellungen zeigen
 * danach nur die Karten des jeweiligen Kanals. Gleiches Muster wie lib/theme.ts.
 */
export type Workspace = 'mail' | 'wa';

const KEY = 'relay-workspace';
const listeners = new Set<() => void>();

export function getWorkspace(): Workspace {
  try { return localStorage.getItem(KEY) === 'wa' ? 'wa' : 'mail'; }
  catch { return 'mail'; }   // privates Fenster
}

export function setWorkspace(w: Workspace) {
  if (w === getWorkspace()) return;
  try { localStorage.setItem(KEY, w); } catch { /* privates Fenster */ }
  listeners.forEach(fn => fn());
}

export function onWorkspaceChange(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Zu welchem Bereich gehört ein Pfad? null = allgemein, ändert nichts. */
export function workspaceOf(pathname: string): Workspace | null {
  if (pathname.startsWith('/whatsapp')) return 'wa';
  if (pathname.startsWith('/email')) return 'mail';
  return null;
}
