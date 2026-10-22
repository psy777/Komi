import type { KataGoAnalysis, KataGoMoveInfo, KataGoProxyResponse, StoneColor } from './types';
import { mapNativeResult, currentPlayerAtTurn } from './katagoMapping';
import type { EngineAdapter } from './reviewPipeline';

// Local self-hosted KataGo analysis engine (served by server.js, proxied by
// Vite at /api). Override with VITE_KATAGO_ENDPOINT if hosting elsewhere.
const PROXY_ENDPOINT =
  (import.meta as any).env?.VITE_KATAGO_ENDPOINT || "/api/katago";
const GAME_ENDPOINT =
  (import.meta as any).env?.VITE_KATAGO_GAME_ENDPOINT || "/api/katago/game";
const MAX_RETRIES = 3;
const TIMEOUT_MS = 60000; // local engine searches can take longer than the old proxy

/**
 * Raw fetch from KataGo proxy. Returns the proxy response shape as-is.
 * Preserves backward compatibility with existing geminiService usage.
 */
export const fetchKataGoAnalysis = async (
    moves: string[],
    komi: number = 6.5
): Promise<any | null> => {
    for (let i = 0; i < MAX_RETRIES; i++) {
        const requestId = Math.random().toString();

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

            const payload = {
                board_size: 19,
                moves: moves,
                config: {
                    komi: komi,
                    request_id: requestId
                }
            };

            const response = await fetch(PROXY_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorText = await response.text().catch(() => 'No error details');
                console.warn(`KataGo server error: ${response.status}`, errorText);
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }

            const data = await response.json();

            // Validate Request ID
            const receivedId = data.request_id || data.config?.request_id;
            if (receivedId !== undefined && receivedId !== null && String(receivedId) !== requestId) {
                console.warn(`KataGo ID mismatch: expected ${requestId}, got ${receivedId}. Retrying...`);
                await new Promise(r => setTimeout(r, 500));
                continue;
            }

            return data as KataGoProxyResponse;

        } catch (error) {
            console.warn(`KataGo fetch attempt ${i + 1} failed:`, error);
            await new Promise(r => setTimeout(r, 1000));
        }
    }

    console.error("KataGo analysis failed after max retries.");
    return null;
};

/**
 * Normalize proxy response into the rich KataGoAnalysis type.
 * Extracts maximum information from the proxy's limited response.
 * When ownership/full data is unavailable, fields are approximated or null.
 */
function normalizeProxyResponse(
    proxyData: KataGoProxyResponse,
    moveCount: number,
    currentPlayer: StoneColor
): KataGoAnalysis {
    const diag = proxyData.diagnostics;

    // Build moveInfos from best_ten candidates
    const totalPsv = diag.best_ten.reduce((sum, m) => sum + m.psv, 0) || 1;
    const moveInfos: KataGoMoveInfo[] = diag.best_ten.map((m) => ({
        move: m.move,
        visits: m.psv,
        winrate: m.winrate ?? m.winprob ?? diag.winprob,
        scoreLead: m.score ?? diag.score,
        prior: m.psv / totalPsv,  // Approximate prior from visit distribution
        pv: [m.move],             // Proxy doesn't provide PV lines
    }));

    return {
        moveInfos,
        rootInfo: {
            winrate: diag.winprob,
            scoreLead: diag.score,
            visits: totalPsv,
        },
        ownership: null,          // Proxy does not support ownership
        turnNumber: moveCount,
        currentPlayer,
    };
}

/**
 * Analyze a position and return structured KataGoAnalysis.
 * This is the primary analysis function for the semantic pipeline.
 *
 * @param moves - GTP move list (e.g., [["B","D4"],["W","Q16"]])
 * @param komi - Komi value
 * @param currentPlayer - Whose turn it is
 * @returns KataGoAnalysis or null on failure
 */
export const analyzePosition = async (
    moves: string[],
    komi: number = 6.5,
    currentPlayer: StoneColor = 'B' as StoneColor
): Promise<KataGoAnalysis | null> => {
    const raw = await fetchKataGoAnalysis(moves, komi);
    if (!raw) return null;

    // If the response already has moveInfos (future: direct KataGo API),
    // use it directly
    const rawAny = raw as any;
    if (rawAny.moveInfos && Array.isArray(rawAny.moveInfos)) {
        return {
            moveInfos: rawAny.moveInfos,
            rootInfo: rawAny.rootInfo ?? {
                winrate: raw.diagnostics?.winprob ?? 0.5,
                scoreLead: raw.diagnostics?.score ?? 0,
                visits: 0,
            },
            ownership: rawAny.ownership ?? null,
            turnNumber: moves.length,
            currentPlayer,
        };
    }

    // Normalize proxy response
    return normalizeProxyResponse(raw, moves.length, currentPlayer);
};

/**
 * Batch analyze multiple positions concurrently.
 * Respects concurrency limit to avoid overwhelming the proxy.
 *
 * @param positions - Array of {moves, komi, currentPlayer}
 * @param concurrency - Max concurrent requests (default 3)
 * @param onProgress - Optional callback for progress tracking
 */
export const batchAnalyze = async (
    positions: Array<{
        moves: string[];
        komi: number;
        currentPlayer: StoneColor;
    }>,
    concurrency: number = 3,
    onProgress?: (completed: number, total: number) => void
): Promise<(KataGoAnalysis | null)[]> => {
    const results: (KataGoAnalysis | null)[] = new Array(positions.length).fill(null);
    let completed = 0;

    // Process in chunks to respect concurrency limit
    for (let i = 0; i < positions.length; i += concurrency) {
        const chunk = positions.slice(i, i + concurrency);
        const chunkResults = await Promise.all(
            chunk.map(pos => analyzePosition(pos.moves, pos.komi, pos.currentPlayer))
        );

        chunkResults.forEach((result, idx) => {
            results[i + idx] = result;
            completed++;
            onProgress?.(completed, positions.length);
        });
    }

    return results;
};

/**
 * Analyze every position of a game in a SINGLE shared-tree query.
 *
 * Far faster than analyzing positions one-by-one: KataGo reuses its search
 * tree across turns. Returns one KataGoAnalysis per turn (index t = board
 * after t moves), with nulls only on total failure.
 *
 * @param movePairs - [["B","Q16"],["W","D4"],...]
 * @param komi - game komi
 * @param onProgress - (completed, total) callback
 */
export const analyzeGamePositions = async (
  movePairs: Array<[string, string]>,
  komi: number = 6.5,
  onProgress?: (completed: number, total: number) => void,
): Promise<(KataGoAnalysis | null)[]> => {
  const total = movePairs.length + 1;
  onProgress?.(0, total);

  try {
    const res = await fetch(GAME_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ moves: movePairs, komi, includeOwnership: true }),
    });
    if (!res.ok) throw new Error(`Game analysis failed: ${res.status}`);

    const { results } = await res.json();
    const out: (KataGoAnalysis | null)[] = new Array(total).fill(null);

    for (const raw of results || []) {
      const t = raw.turnNumber ?? 0;
      if (t < 0 || t >= total) continue;
      out[t] = mapNativeResult(raw, currentPlayerAtTurn(movePairs, t));
    }

    onProgress?.(total, total);
    return out;
  } catch (error) {
    console.error('analyzeGamePositions failed:', error);
    return new Array(total).fill(null);
  }
};

/**
 * Browser-side EngineAdapter for the review pipeline: routes engine queries
 * through the server's /api/katago endpoints (which pick local vs remote).
 */
export const browserEngineAdapter: EngineAdapter = {
  analyzeGamePositions: (movePairs, komi, onProgress) =>
    analyzeGamePositions(movePairs, komi, onProgress),
  analyzePosition: (moves, komi, currentPlayer) =>
    analyzePosition(moves, komi, currentPlayer),
};

/**
 * Build a PV (principal variation) line by iteratively querying the proxy.
 *
 * Since the proxy only returns the top move per query (no full PV sequences),
 * we extend the line by appending the best move, querying the next position,
 * and repeating until the desired depth.
 *
 * @param baseMoves - GTP move list up to (but not including) the starting position
 * @param startingPlayer - Whose turn it is at the starting position
 * @param depth - Number of moves to extend (default 6)
 * @param komi - Game komi
 * @returns Array of GTP move strings forming the variation line
 */
export const buildPVLine = async (
    baseMoves: string[],
    startingPlayer: StoneColor,
    depth: number = 6,
    komi: number = 6.5,
): Promise<string[]> => {
    const line: string[] = [];
    const currentMoves = [...baseMoves];
    let player = startingPlayer;

    for (let i = 0; i < depth; i++) {
        const result = await analyzePosition(currentMoves, komi, player);
        if (!result || result.moveInfos.length === 0) break;

        const bestMove = result.moveInfos[0].move;
        if (!bestMove || bestMove === 'pass') break;

        line.push(bestMove);
        currentMoves.push(player as string, bestMove);
        player = player === ('B' as StoneColor)
            ? ('W' as StoneColor)
            : ('B' as StoneColor);
    }

    return line;
};
