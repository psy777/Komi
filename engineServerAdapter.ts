// Server-side EngineAdapter: feeds the review pipeline from the engine
// selector (katago.js — local spawn in dev, remote katago-api in production).
// Node-only; never import from browser code.

// @ts-ignore - plain JS module without type declarations
import { analyzeGame, analyzePosition as engineAnalyzePosition } from './katago.js';
import { mapNativeResult, currentPlayerAtTurn } from './katagoMapping';
import type { EngineAdapter } from './reviewPipeline';
import type { KataGoAnalysis, StoneColor } from './types';

/** Fold a flat GTP list ["B","D4","W","Q16",...] into [["B","D4"],...]. */
function pairify(moves: string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i + 1 < moves.length; i += 2) {
    pairs.push([moves[i], moves[i + 1]]);
  }
  return pairs;
}

export const serverEngineAdapter: EngineAdapter = {
  async analyzeGamePositions(movePairs, komi, onProgress) {
    const total = movePairs.length + 1;
    let completed = 0;
    onProgress?.(0, total);

    const results = await analyzeGame(movePairs, {
      komi,
      includeOwnership: true,
      onResult: () => {
        completed++;
        onProgress?.(completed, total);
      },
    });

    const out: (KataGoAnalysis | null)[] = new Array(total).fill(null);
    for (const raw of results || []) {
      const t = raw.turnNumber ?? 0;
      if (t < 0 || t >= total) continue;
      out[t] = mapNativeResult(raw, currentPlayerAtTurn(movePairs, t));
    }
    return out;
  },

  async analyzePosition(moves, komi, currentPlayer) {
    const raw = await engineAnalyzePosition(pairify(moves), { komi });
    if (!raw) return null;
    return mapNativeResult(raw, currentPlayer as StoneColor);
  },
};
