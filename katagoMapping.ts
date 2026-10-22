// Pure mapping helpers shared by the browser engine adapter (katagoService.ts)
// and the server engine adapter (engineServerAdapter.ts). No I/O, no env.

import type { KataGoAnalysis, StoneColor } from './types';

/** Normalize a raw KataGo analysis result into the app's KataGoAnalysis shape. */
export function mapNativeResult(raw: any, currentPlayer: StoneColor): KataGoAnalysis {
  return {
    moveInfos: (raw.moveInfos || []).map((m: any) => ({
      move: m.move,
      visits: m.visits,
      winrate: m.winrate,
      scoreLead: m.scoreLead,
      prior: m.prior,
      pv: m.pv || [m.move],
    })),
    rootInfo: {
      winrate: raw.rootInfo?.winrate ?? 0.5,
      scoreLead: raw.rootInfo?.scoreLead ?? 0,
      visits: raw.rootInfo?.visits ?? 0,
    },
    ownership: raw.ownership ?? null,
    turnNumber: raw.turnNumber ?? 0,
    currentPlayer,
  };
}

/**
 * Side to move at turn t of a game: the player of move t+1, or the opponent
 * of the last mover once the game's moves are exhausted (t == movePairs.length).
 */
export function currentPlayerAtTurn(
  movePairs: Array<[string, string]>,
  t: number,
): StoneColor {
  return (
    t < movePairs.length
      ? movePairs[t][0]
      : movePairs[movePairs.length - 1]?.[0] === 'B' ? 'W' : 'B'
  ) as StoneColor;
}
