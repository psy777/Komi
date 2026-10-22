// Client for the self-hosted auth + game persistence + community API.
// Cookies (session) are sent automatically for same-origin requests.

export interface AccountUser {
  id: number;
  email: string;
  username: string | null;
  points: number;
  role: 'user' | 'admin';
  createdAt: number;
}

export type GameStatus = 'pending' | 'analyzing' | 'ready' | 'failed';
export type GameSource = 'upload' | 'ogs' | 'kgs' | 'fox' | 'curated' | 'client' | null;

export interface GameSummary {
  id: number;
  ownerId: number;
  title: string;
  isPublic: boolean;
  createdAt: number;
  updatedAt: number;
  status: GameStatus;
  source: GameSource;
  blackName: string | null;
  whiteName: string | null;
  blackRank: string | null;
  whiteRank: string | null;
  progress?: { percent: number; phase: string | null };
  engineOnline?: boolean;
  error?: string | null;
}

export interface GameFull extends GameSummary {
  sgf: string;
  analysis: unknown | null;
}

export interface Revision {
  id: number;
  author: string;
  authorId: number | null;
  isEngine: boolean;
  body: string;
  createdAt: number;
  votes: number;
  votedByMe: boolean;
}

export interface MoveComment {
  id: number;
  author: string;
  authorId: number;
  authorPoints: number;
  body: string;
  createdAt: number;
  updatedAt: number;
  edited: boolean;
  votes: number;
  votedByMe: boolean;
  insightful: boolean;
}

export interface MoveBundle {
  moveNumber: number;
  commentary: { current: Revision | null; revisions: Revision[] };
  comments: MoveComment[];
  isOwner: boolean;
}

export interface LinkedAccount {
  server: 'ogs' | 'kgs' | 'fox';
  handle: string;
  linkedAt?: number;
}

export interface OgsGameSummary {
  id: number;
  name: string;
  black: string;
  white: string;
  blackRank: string | null;
  whiteRank: string | null;
  size: number;
  ranked: boolean;
  ended: number | null;
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

const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) });

// --- Auth ---
export const me = () => req<{ user: AccountUser | null }>('/api/auth/me');

export const register = (email: string, password: string, username: string) =>
  req<{ user: AccountUser }>('/api/auth/register', post({ email, password, username }));

export const login = (email: string, password: string) =>
  req<{ user: AccountUser }>('/api/auth/login', post({ email, password }));

export const logout = () => req<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });

export const setUsername = (username: string) =>
  req<{ ok: boolean; username: string }>('/api/auth/username', post({ username }));

// --- Games ---
export const saveGame = (
  title: string,
  sgf: string,
  isPublic: boolean,
  opts: { analysis?: unknown; source?: GameSource } = {},
) =>
  req<{ id: number; status: GameStatus }>('/api/games', post({
    title, sgf, isPublic, analysis: opts.analysis, source: opts.source,
  }));

export const listMyGames = () => req<{ games: GameSummary[] }>('/api/games');
export const listPublicGames = (filters: { source?: string; q?: string } = {}) => {
  const params = new URLSearchParams();
  if (filters.source) params.set('source', filters.source);
  if (filters.q) params.set('q', filters.q);
  const qs = params.toString();
  return req<{ games: GameSummary[] }>(`/api/games/public${qs ? `?${qs}` : ''}`);
};
export const getGame = (id: number) => req<{ game: GameFull }>(`/api/games/${id}`);

export const updateGame = (
  id: number,
  patch: Partial<{ title: string; isPublic: boolean; sgf: string; analysis: unknown }>,
) => req<{ ok: boolean }>(`/api/games/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });

export const deleteGame = (id: number) =>
  req<{ ok: boolean }>(`/api/games/${id}`, { method: 'DELETE' });

export const reanalyzeGame = (id: number) =>
  req<{ ok: boolean; status: GameStatus }>(`/api/games/${id}/analyze`, { method: 'POST' });

// --- Linked accounts & OGS ---
export const listAccounts = () => req<{ accounts: LinkedAccount[] }>('/api/me/accounts');
export const linkAccount = (server: string, handle: string) =>
  req<{ ok: boolean; server: string; handle: string }>('/api/me/accounts', post({ server, handle }));
export const unlinkAccount = (server: string) =>
  req<{ ok: boolean }>(`/api/me/accounts/${server}`, { method: 'DELETE' });

export const listOgsGames = (handle?: string) =>
  req<{ player: { id: number; username: string; rating: number | null }; games: OgsGameSummary[] }>(
    `/api/ogs/games${handle ? `?handle=${encodeURIComponent(handle)}` : ''}`,
  );
export const importOgsGame = (game: string | number) =>
  req<{ id: number; status: GameStatus; duplicate?: boolean }>('/api/games/import/ogs', post({ game }));

// --- Community: per-move commentary & discussion ---
export const getMoveBundle = (gameId: number, moveNumber: number) =>
  req<MoveBundle>(`/api/games/${gameId}/moves/${moveNumber}`);

export const getGameActivity = (gameId: number) =>
  req<{ moves: Array<{ moveNumber: number; comments: number; userRevisions: number; engineNotes: number }> }>(
    `/api/games/${gameId}/activity`,
  );

export const postRevision = (gameId: number, moveNumber: number, body: string) =>
  req<{ id: number }>(`/api/games/${gameId}/moves/${moveNumber}/revisions`, post({ body }));

export const voteRevision = (revisionId: number) =>
  req<{ voted: boolean; votes: number }>(`/api/revisions/${revisionId}/vote`, { method: 'POST' });

export const postComment = (gameId: number, moveNumber: number, body: string) =>
  req<{ id: number }>(`/api/games/${gameId}/moves/${moveNumber}/comments`, post({ body }));

export const editComment = (commentId: number, body: string) =>
  req<{ ok: boolean }>(`/api/comments/${commentId}`, { method: 'PATCH', body: JSON.stringify({ body }) });

export const deleteComment = (commentId: number) =>
  req<{ ok: boolean }>(`/api/comments/${commentId}`, { method: 'DELETE' });

export const voteComment = (commentId: number) =>
  req<{ voted: boolean; votes: number }>(`/api/comments/${commentId}/vote`, { method: 'POST' });

export const markInsightful = (gameId: number, moveNumber: number, commentId: number) =>
  req<{ insightful: number | null }>(`/api/games/${gameId}/moves/${moveNumber}/insightful`, post({ commentId }));

export const getUserProfile = (username: string) =>
  req<{ user: unknown }>(`/api/users/${encodeURIComponent(username)}`);
