import type {
  KataGoAnalysis,
  KataGoMoveInfo,
  SemanticAnnotation,
  MoveClassification,
  MistakeType,
  GamePhase,
  PlayerLevel,
  StoneColor,
  KeyMomentReason,
} from './types';

// ---------------------------------------------------------------------------
// Configurable thresholds (score-lead points)
// ---------------------------------------------------------------------------

/**
 * Mistake-size thresholds expressed as signed scoreDelta (= -pointsLost).
 * Retained for detectMistakeType, which keys off the "negative = worse"
 * convention (e.g. scoreDelta < -5.0 → blunder territory).
 */
export const CLASSIFICATION_THRESHOLDS = {
  brilliant:   2.0,
  good:        0.5,
  neutral:    -0.5,
  inaccuracy: -2.0,
  mistake:    -5.0,
} as const;

/**
 * Points-lost tiers — the primary classification axis with real engine data.
 * pointsLost = scoreLead(best move) - scoreLead(played move), mover's POV.
 */
export const POINTS_LOST_TIERS = {
  great:      0.5,   // <= 0.5 pts lost → great (or brilliant if hard to find)
  good:       1.0,   // <= 1.0 → good
  inaccuracy: 2.0,   // <= 2.0 → inaccuracy
  mistake:    5.0,   // <= 5.0 → mistake; above → blunder
  /** If the 2nd-best move is this many points worse, finding the best was hard. */
  brilliantHardnessGap: 3.0,
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
 * Compute move quality as points lost vs. the engine's best move.
 *
 * With real KataGo data (Black-perspective scores), the quality of a move
 * is read directly from a single position: the engine evaluates the best
 * move and the played move at evalBefore. We compare them from the mover's
 * perspective — no cross-position subtraction, no per-stone bias, no median
 * normalization (all of which the old proxy required).
 *
 *   pointsLost  = scoreLead(best) - scoreLead(played)   [mover's POV, >= 0]
 *   scoreDelta  = -pointsLost  (kept negative-is-bad for downstream consumers)
 *
 * @param evalBefore - engine eval of the position before the move (mover to play)
 * @param evalAfter  - engine eval after the move (used as fallback for the
 *                     played move's value when it isn't among the candidates)
 * @param actualMove - GTP coordinate of the move played
 * @param moverColor - 'B' | 'W' (or StoneColor) of the player who moved
 */
export function computeMoveQuality(
  evalBefore: KataGoAnalysis,
  evalAfter: KataGoAnalysis,
  actualMove: string,
  moverColor: StoneColor | string,
): {
  classification: MoveClassification;
  scoreDelta: number;
  winrateDelta: number;
  pointsLost: number;
  winrateLost: number;
} {
  const isBlack = moverColor === 'B' || moverColor === ('B' as StoneColor);

  const best = evalBefore.moveInfos[0];
  const bestScore = best?.scoreLead ?? evalBefore.rootInfo.scoreLead;
  const bestWin = best?.winrate ?? evalBefore.rootInfo.winrate;

  // The played move's resulting value (Black perspective). Prefer the engine's
  // own evaluation of it among the candidates; otherwise use the eval of the
  // resulting position (evalAfter's root).
  const played = evalBefore.moveInfos.find((m) => m.move === actualMove);
  const playedScore = played ? played.scoreLead : evalAfter.rootInfo.scoreLead;
  const playedWin = played ? played.winrate : evalAfter.rootInfo.winrate;

  // Loss from the mover's perspective: Black wants higher Black-score, White
  // wants lower. Clamp tiny negatives (search noise) to zero.
  const pointsLost = Math.max(0, isBlack ? bestScore - playedScore : playedScore - bestScore);
  const winrateLost = Math.max(0, isBlack ? bestWin - playedWin : playedWin - bestWin);

  // How hard was finding the best move? Gap to the 2nd-best candidate.
  const second = evalBefore.moveInfos[1];
  const hardnessGap = second ? Math.abs(bestScore - second.scoreLead) : 0;

  return {
    classification: classifyByPointsLost(pointsLost, hardnessGap),
    scoreDelta: -pointsLost,
    winrateDelta: -winrateLost,
    pointsLost,
    winrateLost,
  };
}

/** Map points-lost (and hardness) to a move classification. */
export function classifyByPointsLost(
  pointsLost: number,
  hardnessGap: number,
): MoveClassification {
  const t = POINTS_LOST_TIERS;
  if (pointsLost <= t.great) {
    return hardnessGap > t.brilliantHardnessGap ? 'brilliant' : 'good';
  }
  if (pointsLost <= t.good) return 'neutral';
  if (pointsLost <= t.inaccuracy) return 'inaccuracy';
  if (pointsLost <= t.mistake) return 'mistake';
  return 'blunder';
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
 *
 * Should be called AFTER normalizeAndClassify() so that classification
 * and scoreDelta reflect the corrected (bias-removed) values.
 *
 * @param actualMove   - GTP coordinate of the played move
 * @param engineTopMove - Engine's top recommended move
 * @param classification - Normalized move classification
 * @param scoreDelta   - Normalized score delta (positive = good for mover)
 * @param moverWinrate - Raw winrate from evalBefore (mover's POV)
 */
export function detectMistakeType(
  actualMove: string,
  engineTopMove: string,
  classification: MoveClassification,
  scoreDelta: number,
  moverWinrate: number,
): MistakeType | undefined {
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

  // Same fixed-scale convention as classifyMove: simple difference, no negation.
  const scoreDelta = evalBefore.rootInfo.scoreLead - evalAfter.rootInfo.scoreLead;
  const winrateDelta = evalBefore.rootInfo.winrate - evalAfter.rootInfo.winrate;

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
// 5. identifyKeyMoments — Filter for game-shifting positions
// ---------------------------------------------------------------------------

/** Winrate thresholds for game trajectory detection */
const TRAJECTORY_THRESHOLDS = {
  /** Winrate above which a position is "decided" for one side */
  decided: 0.70,
  /** Winrate above which the game is effectively over */
  gameOver: 0.90,
  /** Range [0.5 - competitive, 0.5 + competitive] is "competitive" */
  competitive: 0.15,
} as const;

/**
 * Detect the primary reason a move is a key moment.
 * Returns the highest-priority reason that applies.
 */
function detectKeyMomentReason(
  ann: SemanticAnnotation,
  idx: number,
  annotations: SemanticAnnotation[],
  winrateBefore?: number,
  winrateAfter?: number,
  engineBestWinrate?: number,
): { reason: KeyMomentReason; bonus: number } | null {
  const t = TRAJECTORY_THRESHOLDS;

  // --- Lead change: winrate crosses 0.5 ---
  if (winrateBefore !== undefined && winrateAfter !== undefined) {
    const leaderBefore = winrateBefore >= 0.5 ? 'B' : 'W';
    const leaderAfter  = winrateAfter >= 0.5 ? 'B' : 'W';
    if (leaderBefore !== leaderAfter) {
      return { reason: 'lead_change', bonus: 5 };
    }
  }

  // --- Decisive blow: game transitions from competitive to decided ---
  if (winrateBefore !== undefined && winrateAfter !== undefined) {
    const wasClosed = winrateBefore > (1 - t.decided) && winrateBefore < t.decided;
    const nowDecided = winrateAfter >= t.decided || winrateAfter <= (1 - t.decided);
    if (wasClosed && nowDecided) {
      return { reason: 'decisive_blow', bonus: 4 };
    }
  }

  // --- Missed opportunity: engine move would have been decisive but played move wasn't ---
  if (
    winrateBefore !== undefined &&
    winrateAfter !== undefined &&
    engineBestWinrate !== undefined
  ) {
    const engineWouldDecide = engineBestWinrate >= t.decided || engineBestWinrate <= (1 - t.decided);
    const actualStillClose = winrateAfter > (1 - t.decided) && winrateAfter < t.decided;
    if (engineWouldDecide && actualStillClose && ann.classification !== 'brilliant' && ann.classification !== 'good') {
      return { reason: 'missed_opportunity', bonus: 3 };
    }
  }

  // --- Classification-based reasons ---
  if (ann.classification === 'blunder' || ann.classification === 'mistake') {
    return { reason: 'big_mistake', bonus: ann.classification === 'blunder' ? 4 : 2 };
  }
  if (ann.classification === 'brilliant') {
    return { reason: 'brilliant_play', bonus: 3 };
  }

  // --- Momentum shift in competitive position ---
  if (Math.abs(ann.winrateDelta) > 0.15) {
    return { reason: 'momentum_shift', bonus: 2 };
  }

  // --- Phase transition ---
  if (idx > 0 && annotations[idx - 1].gamePhase !== ann.gamePhase) {
    return { reason: 'phase_transition', bonus: 2 };
  }

  return null;
}

/**
 * Identify the most important game-shifting moments.
 *
 * When `positions` are provided (engine evaluations for each board state),
 * uses the game trajectory to detect lead changes, decisive blows, and
 * missed opportunities — the moments where the game truly shifted or
 * could have shifted. Falls back to classification-only scoring when
 * positions are unavailable.
 */
export function identifyKeyMoments(
  annotations: SemanticAnnotation[],
  positions?: (KataGoAnalysis | null)[],
): SemanticAnnotation[] {
  if (annotations.length === 0) return [];

  const t = KEY_MOMENT_THRESHOLDS;

  // Score each annotation for "key-ness"
  const scored = annotations.map((ann, idx) => {
    let keyScore = 0;

    // --- Winrate trajectory from positions ---
    // positions[i] = eval BEFORE move i+1, positions[i+1] = eval AFTER move i+1
    const moveIdx = ann.moveNumber - 1;
    const posBefore = positions?.[moveIdx] ?? null;
    const posAfter  = positions?.[moveIdx + 1] ?? null;
    const winrateBefore = posBefore?.rootInfo.winrate;
    const winrateAfter  = posAfter?.rootInfo.winrate;

    // Engine's best move winrate (what would have happened with optimal play)
    const engineBestWinrate = posBefore?.moveInfos?.[0]?.winrate;

    // --- Detect game-shifting reason ---
    const detected = detectKeyMomentReason(
      ann, idx, annotations,
      winrateBefore, winrateAfter, engineBestWinrate,
    );
    let reason: KeyMomentReason | undefined;
    if (detected) {
      keyScore += detected.bonus;
      reason = detected.reason;
    }

    // --- Additional scoring factors ---

    // Large evaluation swings
    if (Math.abs(ann.scoreDelta) > t.scoreDeltaAbs) {
      keyScore += 3;
    }

    // Closeness boost: moments in competitive positions matter more
    if (winrateBefore !== undefined) {
      const closeness = 1 - 2 * Math.abs(winrateBefore - 0.5);
      if (closeness > 0.7) {
        // Scale up by 30% for very close positions
        keyScore = Math.round(keyScore * 1.3);
      }
    }

    // First move of the game is context-setting
    if (ann.moveNumber <= 1) {
      keyScore += 1;
    }

    return { annotation: ann, keyScore, reason };
  });

  // Sort by keyScore descending, take top N
  const sorted = [...scored].sort((a, b) => b.keyScore - a.keyScore);
  const keyMomentMap = new Map<number, KeyMomentReason | undefined>();
  for (const s of sorted) {
    if (s.keyScore > 0 && keyMomentMap.size < t.maxKeyMoments) {
      keyMomentMap.set(s.annotation.moveNumber, s.reason);
    }
  }

  // Return annotations with isKeyMoment and reason set
  return annotations.map(ann => ({
    ...ann,
    isKeyMoment: keyMomentMap.has(ann.moveNumber),
    keyMomentReason: keyMomentMap.get(ann.moveNumber),
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
