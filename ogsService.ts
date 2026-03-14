/**
 * OGS (Online Go Server) integration service.
 * Fetches game data from online-go.com public API.
 */

const OGS_API_BASE = 'https://online-go.com/api/v1';

/** Supported OGS URL patterns */
const OGS_URL_PATTERNS = [
  /online-go\.com\/game\/(\d+)/,       // https://online-go.com/game/12345
  /online-go\.com\/game\/view\/(\d+)/,  // https://online-go.com/game/view/12345
  /ogs\.com\/game\/(\d+)/,             // short domain variant
];

/**
 * Extract a numeric game ID from an OGS URL or raw numeric string.
 * Returns null if the input doesn't match any known pattern.
 */
export function parseOgsGameId(input: string): string | null {
  const trimmed = input.trim();

  // Raw numeric ID
  if (/^\d+$/.test(trimmed)) return trimmed;

  for (const pattern of OGS_URL_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) return match[1];
  }

  return null;
}

/**
 * Fetch the SGF content for a public OGS game.
 * Throws on network errors or non-public games.
 */
export async function fetchOgsSgf(gameId: string): Promise<string> {
  const url = `${OGS_API_BASE}/games/${gameId}/sgf`;
  const res = await fetch(url);

  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(`Game not found on OGS (ID: ${gameId}). Check the URL and make sure the game exists.`);
    }
    throw new Error(`OGS API error: ${res.status} ${res.statusText}`);
  }

  const sgf = await res.text();
  if (!sgf || !sgf.includes('(;')) {
    throw new Error('OGS returned invalid SGF data.');
  }

  return sgf;
}
