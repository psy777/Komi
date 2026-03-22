/**
 * Deep Analysis Module (Phase D)
 *
 * When the initial analysis shows ambiguous positions (close engine candidates,
 * complex fighting), this module runs additional KataGo queries on candidate
 * continuations to build a richer picture before generating explanations.
 *
 * Design:
 *  - Ambiguity detector scans annotations + positions for close-score candidates
 *  - Variation explorer queries KataGo on top-N candidate moves per ambiguous position
 *  - Budget controls limit total API calls
 *  - Results feed into the tutoring pipeline for richer "compare and contrast" explanations
 */

import { analyzePosition } from './katagoService';
import type {
  KataGoAnalysis,
  SemanticAnnotation,
  FullGameAnalysis,
  DeepAnalysisBudget,
  DeepAnalysisResult,
  VariationExploration,
  VariationEval,
  StoneColor,
} from './types';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_BUDGET: DeepAnalysisBudget = {
  maxPositions: 8,
  maxCandidatesPerPosition: 3,
  includeResponses: false,
};

/** Score gap threshold: top-2 candidates within this many points = ambiguous */
const AMBIGUITY_SCORE_GAP = 1.5;

/** Minimum number of engine candidates needed to detect ambiguity */
const MIN_CANDIDATES = 2;

// ---------------------------------------------------------------------------
// 1. Ambiguity Detection
// ---------------------------------------------------------------------------

interface AmbiguousPosition {
  moveNumber: number;
  annotationIndex: number;
  /** Score gap between top-2 engine candidates */
  gap: number;
  /** Why it was flagged */
  reason: 'close_candidates' | 'complex_fighting' | 'critical_moment';
  /** The position evaluation (before the move was played) */
  evalBefore: KataGoAnalysis;
}

/**
 * Scan a completed game analysis for positions worth deeper exploration.
 *
 * Criteria (any triggers inclusion):
 *  1. Top-2 engine candidates within AMBIGUITY_SCORE_GAP points
 *  2. Key moments with classification = mistake/blunder (player chose wrong;
 *     explore WHY the alternatives are better)
 *  3. Positions with momentum_shift or critical_move themes
 */
export function detectAmbiguousPositions(
  analysis: FullGameAnalysis,
): AmbiguousPosition[] {
  const results: AmbiguousPosition[] = [];

  for (let i = 0; i < analysis.annotations.length; i++) {
    const ann = analysis.annotations[i];
    // Position index: position[moveNumber-1] = eval BEFORE move moveNumber
    const evalBefore = analysis.positions[ann.moveNumber - 1];
    if (!evalBefore || evalBefore.moveInfos.length < MIN_CANDIDATES) continue;

    const top = evalBefore.moveInfos[0];
    const second = evalBefore.moveInfos[1];
    const gap = Math.abs(top.scoreLead - second.scoreLead);

    // Criterion 1: Close candidates
    if (gap <= AMBIGUITY_SCORE_GAP) {
      results.push({
        moveNumber: ann.moveNumber,
        annotationIndex: i,
        gap,
        reason: 'close_candidates',
        evalBefore,
      });
      continue;
    }

    // Criterion 2: Mistakes/blunders at key moments — worth exploring why
    if (
      ann.isKeyMoment &&
      (ann.classification === 'mistake' || ann.classification === 'blunder')
    ) {
      results.push({
        moveNumber: ann.moveNumber,
        annotationIndex: i,
        gap,
        reason: 'critical_moment',
        evalBefore,
      });
      continue;
    }

    // Criterion 3: Complex fighting themes
    if (
      ann.themes.includes('critical_move') ||
      ann.themes.includes('momentum_shift')
    ) {
      results.push({
        moveNumber: ann.moveNumber,
        annotationIndex: i,
        gap,
        reason: 'complex_fighting',
        evalBefore,
      });
    }
  }

  // Sort by ambiguity: close-candidate positions first, then by gap ascending
  results.sort((a, b) => {
    if (a.reason !== b.reason) {
      const priority = { close_candidates: 0, critical_moment: 1, complex_fighting: 2 };
      return priority[a.reason] - priority[b.reason];
    }
    return a.gap - b.gap;
  });

  return results;
}

// ---------------------------------------------------------------------------
// 2. Variation Explorer
// ---------------------------------------------------------------------------

/**
 * Build the move list for a position in a game up to a given move number.
 * Format: ["B", "D4", "W", "Q16", ...]
 *
 * This reconstructs the moves from the annotations, which store moveNumber
 * and engineTopMove. We need the actual game moves, which we reconstruct
 * from the position data.
 */
function buildMovesUpTo(
  positions: KataGoAnalysis[],
  annotations: SemanticAnnotation[],
  upToMoveNumber: number,
): { moveList: string[]; currentPlayer: StoneColor } {
  // The positions array has N+1 entries for N moves.
  // Position 0 = empty board, position i = after move i.
  // Each position records its currentPlayer (who is to move NEXT).
  // The move list we need is the sequence of moves played.

  // We can reconstruct the move list from positions:
  // Position[i-1].currentPlayer tells us who played move i
  // But we don't have the actual move coordinates stored on positions.
  // The annotations have engineTopMove but not the actual played move.

  // Instead: use position data to determine colors, and rely on the fact
  // that the proxy was originally called with the game's move list.
  // Since we don't store the move list on FullGameAnalysis, we need a
  // different approach: pass the move list in from the orchestrator.

  // For now, we'll accept a pre-built move list from the orchestrator.
  // This function becomes a no-op placeholder.
  throw new Error('Use exploreVariationsWithMoves instead');
}

/**
 * Explore candidate variations for ambiguous positions.
 *
 * For each ambiguous position, queries KataGo with each top candidate move
 * appended to the game's move list at that point. Compares the resulting
 * evaluations to determine which candidate truly leads to a better position.
 *
 * @param ambiguous - Detected ambiguous positions
 * @param gameMoves - Full game move list as flat GTP array ["B","D4","W","Q16",...]
 * @param komi - Game komi
 * @param budget - Budget controls
 * @param onProgress - Optional progress callback
 */
export async function exploreVariations(
  ambiguous: AmbiguousPosition[],
  gameMoves: string[],
  komi: number,
  budget: DeepAnalysisBudget = DEFAULT_BUDGET,
  onProgress?: (completed: number, total: number) => void,
): Promise<DeepAnalysisResult> {
  const explorations = new Map<number, VariationExploration>();
  let apiCallsUsed = 0;

  // Apply budget: limit positions
  const toExplore = ambiguous.slice(0, budget.maxPositions);
  const totalQueries = toExplore.reduce(
    (sum, pos) =>
      sum +
      Math.min(pos.evalBefore.moveInfos.length, budget.maxCandidatesPerPosition) *
        (budget.includeResponses ? 2 : 1),
    0,
  );

  let completed = 0;

  for (const pos of toExplore) {
    const candidates = pos.evalBefore.moveInfos.slice(
      0,
      budget.maxCandidatesPerPosition,
    );

    // Build the move list up to this position (before the move was played)
    // gameMoves has pairs: ["B", "D4", "W", "Q16", ...]
    // Position before move N uses moves 0..(N-1), i.e. (N-1)*2 elements
    const movesBefore = gameMoves.slice(0, (pos.moveNumber - 1) * 2);
    const moverColor = pos.evalBefore.currentPlayer;
    const opponentColor: StoneColor =
      moverColor === ('B' as StoneColor) ? ('W' as StoneColor) : ('B' as StoneColor);

    const variations: VariationEval[] = [];

    for (const candidate of candidates) {
      // Query: what happens if we play this candidate?
      const candidateMoves = [...movesBefore, moverColor as string, candidate.move];
      const evalResult = await analyzePosition(candidateMoves, komi, opponentColor);
      apiCallsUsed++;
      completed++;
      onProgress?.(completed, totalQueries);

      if (!evalResult) continue;

      // evalResult is from opponent's POV; negate to get mover's POV
      const varEval: VariationEval = {
        move: candidate.move,
        scoreLead: -evalResult.rootInfo.scoreLead,
        winrate: 1 - evalResult.rootInfo.winrate,
      };

      // Optionally explore opponent's best response
      if (budget.includeResponses && evalResult.moveInfos.length > 0) {
        const response = evalResult.moveInfos[0];
        const responseMoves = [
          ...candidateMoves,
          opponentColor as string,
          response.move,
        ];
        const responseEval = await analyzePosition(responseMoves, komi, moverColor);
        apiCallsUsed++;
        completed++;
        onProgress?.(completed, totalQueries);

        if (responseEval) {
          varEval.bestResponse = response.move;
          varEval.scoreAfterResponse = responseEval.rootInfo.scoreLead;
        }
      }

      variations.push(varEval);
    }

    if (variations.length === 0) continue;

    // Determine best variation and spread
    variations.sort((a, b) => b.scoreLead - a.scoreLead);
    const best = variations[0];
    const worst = variations[variations.length - 1];

    explorations.set(pos.moveNumber, {
      moveNumber: pos.moveNumber,
      reason: pos.reason,
      ambiguityGap: pos.gap,
      variations,
      bestVariation: best.move,
      variationSpread: best.scoreLead - worst.scoreLead,
    });
  }

  return {
    explorations,
    apiCallsUsed,
    ambiguousCount: ambiguous.length,
    exploredCount: explorations.size,
  };
}

// ---------------------------------------------------------------------------
// 3. Budget Helpers
// ---------------------------------------------------------------------------

/** Estimate the number of API calls deep analysis will make. */
export function estimateApiCalls(
  ambiguousCount: number,
  budget: DeepAnalysisBudget = DEFAULT_BUDGET,
): number {
  const positions = Math.min(ambiguousCount, budget.maxPositions);
  const multiplier = budget.includeResponses ? 2 : 1;
  return positions * budget.maxCandidatesPerPosition * multiplier;
}

/** Merge default budget with partial overrides. */
export function createBudget(
  overrides?: Partial<DeepAnalysisBudget>,
): DeepAnalysisBudget {
  return { ...DEFAULT_BUDGET, ...overrides };
}
