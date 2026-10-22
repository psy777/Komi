// Client for the self-hosted auth + game persistence API.
// Cookies (session) are sent automatically for same-origin requests.

export interface AccountUser {
  id: number;
  email: string;
  createdAt: number;
}

export interface GameSummary {
  id: number;
  ownerId: number;
  title: string;
  isPublic: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface GameFull extends GameSummary {
  sgf: string;
  analysis: unknown | null;
}

async function req<T>(url: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as any)?.error || `Request failed (${res.status})`);
  return data as T;
}

// --- Auth ---
export const me = () => req<{ user: AccountUser | null }>('/api/auth/me');

export const register = (email: string, password: string) =>
  req<{ user: AccountUser }>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });

export const login = (email: string, password: string) =>
  req<{ user: AccountUser }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });

export const logout = () => req<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });

// --- Games ---
export const saveGame = (title: string, sgf: string, isPublic: boolean, analysis?: unknown) =>
  req<{ id: number }>('/api/games', {
    method: 'POST',
    body: JSON.stringify({ title, sgf, isPublic, analysis }),
  });

export const listMyGames = () => req<{ games: GameSummary[] }>('/api/games');
export const listPublicGames = () => req<{ games: GameSummary[] }>('/api/games/public');
export const getGame = (id: number) => req<{ game: GameFull }>(`/api/games/${id}`);

export const updateGame = (
  id: number,
  patch: Partial<{ title: string; isPublic: boolean; sgf: string; analysis: unknown }>,
) => req<{ ok: boolean }>(`/api/games/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });

export const deleteGame = (id: number) =>
  req<{ ok: boolean }>(`/api/games/${id}`, { method: 'DELETE' });
