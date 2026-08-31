// Läuft die Sitzung ab (oder wurde sie widerrufen), antwortet der Server auf
// jeden Aufruf mit 401. Statt jede Seite einzeln damit umgehen zu lassen,
// meldet die api()-Hülle das einmal zentral – App.tsx zeigt dann die Anmeldung.
type UnauthorizedHandler = () => void;
const unauthorizedHandlers = new Set<UnauthorizedHandler>();

export function onUnauthorized(fn: UnauthorizedHandler): () => void {
  unauthorizedHandlers.add(fn);
  return () => { unauthorizedHandlers.delete(fn); };
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function api<T = any>(
  path: string,
  opts: Omit<RequestInit, 'body'> & { body?: unknown } = {},
): Promise<T> {
  const { body, ...rest } = opts;
  const res = await fetch('/api' + path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...rest,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const msg = await res.json().catch(() => ({} as any));
    if (res.status === 401 && !path.startsWith('/auth/')) {
      for (const fn of unauthorizedHandlers) fn();
    }
    throw new ApiError(msg.error || res.statusText, res.status);
  }
  return (res.status === 204 ? null : await res.json()) as T;
}
