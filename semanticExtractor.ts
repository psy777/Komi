import type {
  KataGoAnalysis,
  KataGoMoveInfo,
  SemanticAnnotation,
  MoveClassification,
  MistakeType,
  GamePhase,
  PlayerLevel,
  StoneColor,
} from './types';

// ---------------------------------------------------------------------------
// Configurable thresholds (score-lead points)
// ---------------------------------------------------------------------------

export const CLASSIFICATION_THRESHOLDS = {
  brilliant:   2.0,   // scoreDelta > +2.0
  good:        0.5,   // scoreDelta > +0.5
  neutral:    -0.5,   // scoreDelta > -0.5
  inaccuracy: -2.0,   // scoreDelta > -2.0
  mistake:    -5.0,   // scoreDelta > -5.0
  // anything below -5.0 is a blunder
} as const;

export const PHASE_THRESHOLDS = {
  /** Board occupancy below this AND moveNumber < earlyMoveLimit → opening */
  openingOccupancy: 0.12,
  /** Move number below this to qualify for opening */
  earlyMoveLimit: 60,
  /** Fraction of ownership values with |o| > 0.8 above which → endgame */
  settledRatio: 0.65,
  /** Fallback move-number heuristic when ownership is unavailable */
  endgameMoveNumber: 180,
  /** Fallback occupancy for endgame when ownership unavailable */
  endgameOccupancy: 0.55,
} as const;

export const KEY_MOMENT_THRESHOLDS = {
  /** Absolute scoreDelta beyond which a move is always a key moment */
  scoreDeltaAbs: 3.0,
  /** Maximum number of key moments to return */
  maxKeyMoments: 30,
} as const;

// ---------------------------------------------------------------------------
// 1. classifyMove — Score delta classification
// ---------------------------------------------------------------------------

/**
 * Classify a move based on the score delta between consecutive positions.
 *
 * `evalBefore` is the KataGo analysis *before* the move was played (from the
 * mover's perspective). `evalAfter` is the analysis *after* the move.
 *
 * Score delta = evalAfter.scoreLead - evalBefore.scoreLead
 *   (positive means the mover improved their position)
 *
 * Because the proxy evaluates from the *current player's* perspective and the
 * current player flips each move, we negate evalAfter so both evals are from
 * the same (mover's) perspective.
 */
export function classifyMove(
  evalBefore: KataGoAnalysis,
  evalAfter: KataGoAnalysis,
): { classification: MoveClassification; scoreDelta: number; winrateDelta: number } {
  // evalBefore.rootInfo is from the mover's POV.
  // evalAfter.rootInfo is from the *opponent's* POV (next player to move).
  // Negate evalAfter to get mover's perspective.
  const scoreBefore = evalBefore.rootInfo.scoreLead;
  const scoreAfter  = -evalAfter.rootInfo.scoreLead;
  const scoreDelta  = scoreAfter - scoreBefore;

  const winrateBefore = evalBefore.rootInfo.winrate;
  const winrateAfter  = 1 - evalAfter.rootInfo.winrate;
  const winrateDelta  = winrateAfter - winrateBefore;

  const t = CLASSIFICATION_THRESHOLDS;
  let classification: MoveClassification;

  if (scoreDelta > t.brilliant)        classification = 'brilliant';
  else if (scoreDelta > t.good)        classification = 'good';
  else if (scoreDelta > t.neutral)     classification = 'neutral';
  else if (scoreDelta > t.inaccuracy)  classification = 'inaccuracy';
  else if (scoreDelta > t.mistake)     classification = 'mistake';
  else                                 classification = 'blunder';

  return { classification, scoreDelta, winrateDelta };
}

// ---------------------------------------------------------------------------
// 2. detectMistakeType — Sub-classify mistakes/blunders
// ---------------------------------------------------------------------------

/**
 * Attempt to sub-classify a mistake based on available engine data.
 *
 * Uses heuristics on the actual move vs engine top move, board region,
 * and evaluation changes. Returns undefined for non-mistakes or when
 * the data is insufficient to classify.
 */
export function detectMistakeType(
  actualMove: string,
  engineTopMove: string,
  evalBefore: KataGoAnalysis,
  evalAfter: KataGoAnalysis,
): MistakeType | undefined {
  const { classification, scoreDelta } = classifyMove(evalBefore, evalAfter);

  // Only sub-classify mistakes and blunders
  if (classification !== 'mistake' && classification !== 'blunder' && classification !== 'inaccuracy') {
    return undefined;
  }

  const actualRegion  = getMoveRegion(actualMove);
  const engineRegion  = getMoveRegion(engineTopMove);

  // --- Direction error ---
  // Played locally when a whole-board move was needed (different region)
  if (actualRegion !== 'tengen' && engineRegion !== 'tengen' && actualRegion !== engineRegion) {
    return 'direction';
  }

  // --- Timing error ---
  // Check if the engine's top move was in a completely different area (tenuki situation)
  // A large distance between actual and engine move suggests wrong timing
  const actualCoords  = gtpToCoords(actualMove);
  const engineCoords  = gtpToCoords(engineTopMove);
  if (actualCoords && engineCoords) {
    const distance = Math.abs(actualCoords.x - engineCoords.x) + Math.abs(actualCoords.y - engineCoords.y);
    // If moves are far apart (> 8 intersections Manhattan distance), likely timing
    if (distance > 8) {
      return 'timing';
    }
  }

  // --- Overplay ---
  // Large negative scoreDelta when mover was already behind (winrate < 0.4)
  const moverWinrate = evalBefore.rootInfo.winrate;
  if (moverWinrate < 0.4 && scoreDelta < CLASSIFICATION_THRESHOLDS.mistake) {
    return 'overplay';
  }

  // --- Passivity ---
  // Mover was ahead but lost advantage — defensive when attack was available
  if (moverWinrate > 0.6 && scoreDelta < CLASSIFICATION_THRESHOLDS.inaccuracy) {
    return 'passivity';
  }

  // --- Shape error ---
  // Moves in the same region (close together) suggest a local shape mistake
  if (actualCoords && engineCoords) {
    const distance = Math.abs(actualCoords.x - engineCoords.x) + Math.abs(actualCoords.y - engineCoords.y);
    if (distance <= 3) {
      return 'shape';
    }
  }

  // --- Reading error (fallback) ---
  // If none of the above matched, default to reading error for significant losses
  if (scoreDelta < CLASSIFICATION_THRESHOLDS.inaccuracy) {
    return 'reading';
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// 3. detectGamePhase — Opening / Middlegame / Endgame
// ---------------------------------------------------------------------------

/**
 * Detect the current game phase.
 *
 * When ownership data is available (from full KataGo), uses settled-territory
 * ratio. When ownership is null (proxy), falls back to move number and
 * board occupancy heuristics.
 *
 * @param moveNumber - Current move number
 * @param ownership  - 361-length ownership array or null
 * @param boardOccupancy - Fraction of board occupied by stones [0, 1]
 */
export function detectGamePhase(
  moveNumber: number,
  ownership: number[] | null,
  boardOccupancy: number,
): GamePhase {
  const t = PHASE_THRESHOLDS;

  if (ownership && ownership.length > 0) {
    // Rich path: use ownership data
    const settledCount = ownership.filter(o => Math.abs(o) > 0.8).length;
    const settledRatio = settledCount / ownership.length;

    if (boardOccupancy < t.openingOccupancy && moveNumber < t.earlyMoveLimit) {
      return 'opening';
    }
    if (settledRatio > t.settledRatio) {
      return 'endgame';
    }
    return 'middlegame';
  }

  // Fallback path: no ownership data (proxy limitation)
  if (moveNumber < t.earlyMoveLimit && boardOccupancy < t.openingOccupancy) {
    return 'opening';
  }
  if (moveNumber > t.endgameMoveNumber || boardOccupancy > t.endgameOccupancy) {
    return 'endgame';
  }
  return 'middlegame';
}

// ---------------------------------------------------------------------------
// 4. detectThemes — Strategic theme detection
// ---------------------------------------------------------------------------

/**
 * Detect strategic themes present in a position transition.
 *
 * Works with limited proxy data by analyzing score/winrate changes,
 * move locations, and engine candidate differences. Returns an array
 * of theme strings (e.g., ["territory", "sente"]).
 */
export function detectThemes(
  evalBefore: KataGoAnalysis,
  evalAfter: KataGoAnalysis,
  moveInfo?: KataGoMoveInfo,
): string[] {
  const themes: string[] = [];

  const scoreDelta = -evalAfter.rootInfo.scoreLead - evalBefore.rootInfo.scoreLead;
  const winrateBefore = evalBefore.rootInfo.winrate;
  const winrateAfter = 1 - evalAfter.rootInfo.winrate;
  const winrateDelta = winrateAfter - winrateBefore;

  // --- Momentum shift ---
  // Large winrate swing indicates a critical fighting moment
  if (Math.abs(winrateDelta) > 0.1) {
    themes.push('momentum_shift');
  }

  // --- Fighting ---
  // Top engine moves have high variance in score → complex position
  if (evalBefore.moveInfos.length >= 2) {
    const topScore = evalBefore.moveInfos[0].scoreLead;
    const secondScore = evalBefore.moveInfos[1].scoreLead;
    if (Math.abs(topScore - secondScore) > 3.0) {
      themes.push('critical_move');
    }
  }

  // --- Territory / Endgame themes ---
  // Small score changes in late game suggest yose (endgame)
  if (evalBefore.turnNumber > 150 && Math.abs(scoreDelta) < 1.0) {
    themes.push('endgame_technique');
  }

  // --- Sente / Initiative detection ---
  // If the engine's top move for the opponent (evalAfter) is in the same
  // region as the move just played, the move forced a response (sente).
  if (moveInfo && evalAfter.moveInfos.length > 0) {
    const responseMove = evalAfter.moveInfos[0].move;
    const playedCoords = gtpToCoords(moveInfo.move);
    const responseCoords = gtpToCoords(responseMove);
    if (playedCoords && responseCoords) {
      const dist = Math.abs(playedCoords.x - responseCoords.x) +
                   Math.abs(playedCoords.y - responseCoords.y);
      if (dist <= 4) {
        themes.push('sente');
      } else {
        themes.push('tenuki_opportunity');
      }
    }
  }

  // --- Influence vs Territory ---
  // Moves on the 4th line or higher suggest influence-oriented play
  // Moves on the 3rd line suggest territory-oriented play
  if (moveInfo) {
    const coords = gtpToCoords(moveInfo.move);
    if (coords) {
      const line = Math.min(coords.x, coords.y, 18 - coords.x, 18 - coords.y) + 1;
      if (line >= 4 && evalBefore.turnNumber < 80) {
        themes.push('influence');
      } else if (line <= 3 && evalBefore.turnNumber < 80) {
        themes.push('territory');
      }
    }
  }

  // --- Invasion / Reduction ---
  // Large score swings from a move deep in opponent territory
  if (moveInfo && Math.abs(scoreDelta) > 2.0) {
    const coords = gtpToCoords(moveInfo.move);
    if (coords) {
      const line = Math.min(coords.x, coords.y, 18 - coords.x, 18 - coords.y) + 1;
      if (line >= 3 && line <= 6) {
        themes.push(scoreDelta > 0 ? 'successful_invasion' : 'failed_invasion');
      }
    }
  }

  return themes;
}

// ---------------------------------------------------------------------------
// 5. identifyKeyMoments — Filter for pedagogically important positions
// ---------------------------------------------------------------------------

/**
 * Filter annotations to find the most pedagogically important moments.
 *
 * Key moments include: blunders, mistakes, brilliant moves, game phase
 * transitions, and large evaluation swings. Returns the input annotations
 * with `isKeyMoment` set appropriately.
 */
export function identifyKeyMoments(
  annotations: SemanticAnnotation[],
): SemanticAnnotation[] {
  if (annotations.length === 0) return [];

  const t = KEY_MOMENT_THRESHOLDS;

  // Score each annotation for "key-ness"
  const scored = annotations.map((ann, idx) => {
    let keyScore = 0;

    // Large evaluation swings are always important
    if (Math.abs(ann.scoreDelta) > t.scoreDeltaAbs) {
      keyScore += 3;
    }

    // Blunders and brilliant moves
    if (ann.classification === 'blunder')   keyScore += 4;
    if (ann.classification === 'mistake')   keyScore += 2;
    if (ann.classification === 'brilliant') keyScore += 3;

    // Game phase transitions
    if (idx > 0 && annotations[idx - 1].gamePhase !== ann.gamePhase) {
      keyScore += 2;
    }

    // Momentum shifts (large winrate delta)
    if (Math.abs(ann.winrateDelta) > 0.15) {
      keyScore += 2;
    }

    // First move of the game is context-setting
    if (ann.moveNumber <= 1) {
      keyScore += 1;
    }

    return { annotation: ann, keyScore };
  });

  // Sort by keyScore descending, take top N
  const sorted = [...scored].sort((a, b) => b.keyScore - a.keyScore);
  const keyMoveNumbers = new Set(
    sorted.slice(0, t.maxKeyMoments)
      .filter(s => s.keyScore > 0)
      .map(s => s.annotation.moveNumber)
  );

  // Return annotations with isKeyMoment set
  return annotations.map(ann => ({
    ...ann,
    isKeyMoment: keyMoveNumbers.has(ann.moveNumber),
  }));
}

// ---------------------------------------------------------------------------
// 6. estimatePlayerLevel — Auto-suggest player strength from game data
// ---------------------------------------------------------------------------

/**
 * Estimate player strength from semantic annotations of a full game.
 *
 * Method: average absolute score loss per move. Lower average loss
 * correlates with stronger play.
 *
 * Thresholds (calibrated to amateur ranks):
 *   - strong (2d+):       avg loss < 1.0
 *   - advanced (4k–1d):   avg loss < 2.5
 *   - intermediate (14k–5k): avg loss < 5.0
 *   - beginner (25k–15k): avg loss >= 5.0
 *
 * This is a secondary auto-suggestion — the UI (Phase 4) will let
 * users override with their actual rank.
 */
export function estimatePlayerLevel(annotations: SemanticAnnotation[]): PlayerLevel {
  if (annotations.length === 0) return 'beginner';

  const totalLoss = annotations.reduce((sum, ann) => {
    // Only count moves that lost points (negative scoreDelta)
    return sum + Math.max(0, -ann.scoreDelta);
  }, 0);

  const avgLoss = totalLoss / annotations.length;

  if (avgLoss < 1.0) return 'strong';
  if (avgLoss < 2.5) return 'advanced';
  if (avgLoss < 5.0) return 'intermediate';
  return 'beginner';
}

// ---------------------------------------------------------------------------
// Utility: GTP coordinate helpers
// ---------------------------------------------------------------------------

const GTP_COLS = 'ABCDEFGHJKLMNOPQRST'; // I is skipped

function gtpToCoords(gtp: string): { x: number; y: number } | null {
  if (!gtp || gtp.toLowerCase() === 'pass') return null;
  const col = gtp[0].toUpperCase();
  const row = parseInt(gtp.slice(1), 10);
  const x = GTP_COLS.indexOf(col);
  if (x < 0 || isNaN(row) || row < 1 || row > 19) return null;
  const y = 19 - row;
  return { x, y };
}

type BoardRegion = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center' | 'tengen';

function getMoveRegion(gtp: string): BoardRegion {
  const coords = gtpToCoords(gtp);
  if (!coords) return 'tengen';

  const mid = 9; // center of 19x19
  const margin = 3;

  // Close to tengen
  if (Math.abs(coords.x - mid) <= margin && Math.abs(coords.y - mid) <= margin) {
    return 'center';
  }

  if (coords.x <= mid && coords.y <= mid) return 'top-left';
  if (coords.x > mid && coords.y <= mid) return 'top-right';
  if (coords.x <= mid && coords.y > mid) return 'bottom-left';
  return 'bottom-right';
}
