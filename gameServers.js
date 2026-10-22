// Server-side clients for external Go servers.
//
// OGS (online-go.com) has a public REST API — we resolve usernames, list a
// player's recent games, and fetch SGFs here on the server (no CORS, no OGS
// auth needed for public data).
//
// KGS and Fox have no anonymous API (KGS put its archives behind login in
// 2026; Fox never had a public one), so those accounts are stored as plain
// handles and games arrive via SGF upload tagged with the right source. If a
// KGS session-based fetcher lands later, it slots in beside the OGS client.

const OGS_API = 'https://online-go.com/api/v1';

async function ogsFetch(path) {
  const res = await fetch(`${OGS_API}${path}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    const err = new Error(`OGS API error: ${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** Resolve an OGS username (case-insensitive) to a player, or null if none. */
export async function ogsResolvePlayer(username) {
  const handle = String(username || '').trim();
  if (!handle) return null;
  const data = await ogsFetch(`/players/?username=${encodeURIComponent(handle)}`);
  const p = data.results?.[0];
  if (!p) return null;
  const rating = p.ratings?.overall?.rating;
  return {
    id: p.id,
    username: p.username,
    rating: typeof rating === 'number' ? Math.round(rating) : null,
  };
}

/** List a player's most recently finished games (default 20, max 50). */
export async function ogsListRecentGames(playerId, limit = 20) {
  const size = Math.min(Math.max(limit, 1), 50);
  const data = await ogsFetch(
    `/players/${playerId}/games/?ended__isnull=false&ordering=-ended&page_size=${size}`,
  );
  return (data.results ?? []).map((g) => ({
    id: g.id,
    name: g.name?.trim() || 'Game',
    black: g.players?.black?.username ?? '?',
    white: g.players?.white?.username ?? '?',
    blackRank: formatOgsRank(g.players?.black?.ranking),
    whiteRank: formatOgsRank(g.players?.white?.ranking),
    size: g.width ?? 19,
    ranked: !!g.ranked,
    ended: g.ended ? Date.parse(g.ended) : null,
  }));
}

/** OGS numeric ranking -> human rank string (30k..9d). */
function formatOgsRank(ranking) {
  if (typeof ranking !== 'number') return null;
  const r = Math.floor(ranking);
  return r < 30 ? `${30 - r}k` : `${Math.min(r - 29, 9)}d`;
}

/** Accept a bare game id, "...online-go.com/game/12345", or "/game/view/12345". */
export function parseOgsGameId(input) {
  const s = String(input || '').trim();
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/online-go\.com\/(?:game\/view\/|game\/)(\d+)/);
  return m ? m[1] : null;
}

/** Download the SGF for an OGS game. */
export async function ogsFetchSgf(gameId) {
  const res = await fetch(`${OGS_API}/games/${gameId}/sgf`, {
    headers: { Accept: 'application/x-go-sgf, text/plain' },
  });
  if (!res.ok) {
    const err = new Error(`Could not fetch OGS game ${gameId} (${res.status})`);
    err.status = res.status;
    throw err;
  }
  const sgf = await res.text();
  if (!sgf.startsWith('(;')) throw new Error('OGS returned something that is not an SGF');
  return sgf;
}

export const LINKABLE_SERVERS = new Set(['ogs', 'kgs', 'fox']);
