import { parseSGF } from './sgfParser';
import { batchAnalyze } from './katagoService';
import {
  sgfHash,
  loadGameAnalysis,
  saveGameAnalysis,
  positionHash,
  cacheAnalysis,
} from './analysisCache';
import {
  classifyMove,
  normalizeAndClassify,
  detectMistakeType,
  detectGamePhase,
  detectThemes,
  identifyKeyMoments,
  estimatePlayerLevel,
} from './semanticExtractor';
import { toGtpCoordinate } from './goLogic';
import type {
  KataGoAnalysis,
  SemanticAnnotation,
  FullGameAnalysis,
  AnalysisProgressData,
  AnalysisSummary,
  MoveClassification,
  GamePhase,
  PlayerLevel,
  StoneColor,
  GameTree,
} from './types';

// ---------------------------------------------------------------------------
// In-memory cache for completed FullGameAnalysis results
// ---------------------------------------------------------------------------

const resultCache = new Map<string, FullGameAnalysis>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ExtractedMove {
  color: string; // 'B' | 'W'
  gtp: string;   // e.g. "D4"
  moveNumber: number;
}

/**
 * Walk the main line of a parsed game tree and extract moves as GTP.
 */
function extractMoves(tree: GameTree): ExtractedMove[] {
  const moves: ExtractedMove[] = [];
  let nodeId: string | null = tree.rootId;
  let moveNum = 0;

  while (nodeId) {
    const node = tree.nodes[nodeId];
    if (node?.move && node.move.x >= 0 && node.move.y >= 0) {
      moveNum++;
      moves.push({
        color: node.move.color as string,
        gtp: toGtpCoordinate(node.move.x, node.move.y),
        moveNumber: moveNum,
      });
    }
    nodeId = node?.childrenIds[0] ?? null;
  }

  return moves;
}

/**
 * Build the flat GTP move list the KataGo proxy expects.
 * Format: ["B", "D4", "W", "Q16", ...]
 */
function buildMoveList(moves: ExtractedMove[], upTo: number): string[] {
  const result: string[] = [];
  for (let i = 0; i < upTo; i++) {
    result.push(moves[i].color, moves[i].gtp);
  }
  return result;
}

/**
 * Extract komi from SGF root node properties, default 6.5.
 */
function extractKomi(tree: GameTree): number {
  const root = tree.nodes[tree.rootId];
  const km = root?.properties?.KM;
  if (km) {
    const parsed = parseFloat(km);
    if (!isNaN(parsed)) return parsed;
  }
  return 6.5;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Analyze a full Go game from SGF content.
 *
 * Flow:
 *  1. Check cache (sgfHash) -- return immediately on hit
 *  2. Batch KataGo via batchAnalyze() -- report engine progress
 *  3. Semantic extraction -- classifyMove, detectMistakeType, etc.
 *  4. identifyKeyMoments on annotations
 *  5. Aggregate summary
 *  6. Cache result (memory + IndexedDB)
 *  7. Return FullGameAnalysis
 *
 * Commentary is lazy -- NOT generated here. UI calls
 * generateKeyMomentCommentary() on demand.
 */
export async function analyzeGame(
  sgfContent: string,
  playerLevel?: PlayerLevel,
  onProgress?: (progress: AnalysisProgressData) => void,
): Promise<FullGameAnalysis> {
  const hash = sgfHash(sgfContent);

  // ------------------------------------------------------------------
  // 1. Cache check
  // ------------------------------------------------------------------

  const memoryCached = resultCache.get(hash);
  if (memoryCached) {
    onProgress?.({ phase: 'complete', current: 1, total: 1 });
    return memoryCached;
  }

  // ------------------------------------------------------------------
  // 2. Parse SGF
  // ------------------------------------------------------------------

  const tree = parseSGF(sgfContent);
  const moves = extractMoves(tree);
  const totalMoves = moves.length;
  const komi = extractKomi(tree);

  if (totalMoves === 0) {
    const empty = emptyResult(hash, playerLevel ?? 'beginner');
    onProgress?.({ phase: 'complete', current: 0, total: 0 });
    return empty;
  }

  // ------------------------------------------------------------------
  // 3. Batch KataGo analysis
  // ------------------------------------------------------------------
  // We need N+1 evaluations for N moves:
  //   position 0 = empty board (eval before move 1)
  //   position i = board after moves 1..i (eval after move i / before move i+1)

  const positionsToAnalyze = [];
  for (let i = 0; i <= totalMoves; i++) {
    const moveList = buildMoveList(moves, i);
    // Current player at position i: whoever plays move i+1
    // (or the opponent of the last mover if i == totalMoves)
    const currentPlayer: string =
      i < totalMoves
        ? moves[i].color
        : moves[totalMoves - 1].color === 'B'
          ? 'W'
          : 'B';
    positionsToAnalyze.push({
      moves: moveList,
      komi,
      currentPlayer: currentPlayer as StoneColor,
    });
  }

  onProgress?.({
    phase: 'engine',
    current: 0,
    total: totalMoves + 1,
    message: 'Fetching engine analysis...',
  });

  const analysisResults = await batchAnalyze(
    positionsToAnalyze,
    3,
    (completed, total) => {
      onProgress?.({
        phase: 'engine',
        current: completed,
        total,
        message: `Analyzing position ${completed}/${total}`,
      });
    },
  );

  // ------------------------------------------------------------------
  // 4. Semantic extraction
  // ------------------------------------------------------------------

  onProgress?.({
    phase: 'semantic',
    current: 0,
    total: totalMoves,
    message: 'Classifying moves...',
  });

  const annotations: SemanticAnnotation[] = [];

  for (let i = 0; i < totalMoves; i++) {
    const evalBefore = analysisResults[i];
    const evalAfter = analysisResults[i + 1];

    // Skip positions where either eval failed (partial failure tolerance)
    if (!evalBefore || !evalAfter) {
      onProgress?.({ phase: 'semantic', current: i + 1, total: totalMoves });
      continue;
    }

    const { classification, scoreDelta, winrateDelta } = classifyMove(
      evalBefore,
      evalAfter,
    );

    const engineTopMove = evalBefore.moveInfos[0]?.move ?? '';
    const enginePV = evalBefore.moveInfos[0]?.pv ?? [];
    const actualMove = moves[i].gtp;

    const mistakeType = detectMistakeType(
      actualMove,
      engineTopMove,
      evalBefore,
      evalAfter,
    );

    // Approximate board occupancy from move count
    const boardOccupancy = (i + 1) / 361;
    const gamePhase = detectGamePhase(
      i + 1,
      evalBefore.ownership,
      boardOccupancy,
    );

    const moveInfo = evalBefore.moveInfos.find((m) => m.move === actualMove);
    const themes = detectThemes(evalBefore, evalAfter, moveInfo);

    annotations.push({
      moveNumber: i + 1,
      classification,
      mistakeType,
      scoreDelta,
      winrateDelta,
      gamePhase,
      themes,
      engineTopMove,
      enginePV,
      isKeyMoment: false,
    });

    onProgress?.({ phase: 'semantic', current: i + 1, total: totalMoves });
  }

  // ------------------------------------------------------------------
  // 5. Normalize score deltas & re-classify
  // ------------------------------------------------------------------
  // The proxy's score drifts ~-12 pts/move, inflating all raw deltas.
  // Subtract the median so classifications reflect relative quality.

  const normalized = normalizeAndClassify(annotations);

  // ------------------------------------------------------------------
  // 6. Key moments
  // ------------------------------------------------------------------

  const annotated = identifyKeyMoments(normalized);
  const keyMoments = annotated.filter((a) => a.isKeyMoment);

  // ------------------------------------------------------------------
  // 7. Summary
  // ------------------------------------------------------------------

  const estimatedLevel = playerLevel ?? estimatePlayerLevel(annotated);

  const classificationCounts = {} as Record<MoveClassification, number>;
  for (const cls of [
    'brilliant', 'good', 'neutral', 'inaccuracy', 'mistake', 'blunder',
  ] as MoveClassification[]) {
    classificationCounts[cls] = annotated.filter(
      (a) => a.classification === cls,
    ).length;
  }

  const phaseBreakdown = {} as Record<GamePhase, number>;
  for (const phase of ['opening', 'middlegame', 'endgame'] as GamePhase[]) {
    phaseBreakdown[phase] = annotated.filter(
      (a) => a.gamePhase === phase,
    ).length;
  }

  const allThemes = [
    ...new Set(annotated.flatMap((a) => a.themes)),
  ];

  const summary: AnalysisSummary = {
    totalMoves,
    classificationCounts,
    phaseBreakdown,
    themes: allThemes,
  };

  // Collect valid engine positions (non-null results)
  const positions = analysisResults.filter(
    (r): r is KataGoAnalysis => r !== null,
  );

  const result: FullGameAnalysis = {
    sgfHash: hash,
    playerLevel: estimatedLevel,
    positions,
    annotations: annotated,
    keyMoments,
    summary,
    analyzedAt: Date.now(),
  };

  // ------------------------------------------------------------------
  // 7. Cache result
  // ------------------------------------------------------------------

  resultCache.set(hash, result);

  // Persist position-level cache to IndexedDB (best-effort)
  const positionDict: Record<string, KataGoAnalysis> = {};
  for (let i = 0; i < positionsToAnalyze.length; i++) {
    const analysis = analysisResults[i];
    if (analysis) {
      const posHash = positionHash(positionsToAnalyze[i].moves);
      positionDict[posHash] = analysis;
      cacheAnalysis(positionsToAnalyze[i].moves, analysis);
    }
  }

  try {
    await saveGameAnalysis(hash, positionDict);
  } catch {
    // IndexedDB persistence is best-effort
  }

  onProgress?.({
    phase: 'complete',
    current: totalMoves,
    total: totalMoves,
    message: 'Analysis complete',
  });

  return result;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function emptyResult(hash: string, level: PlayerLevel): FullGameAnalysis {
  return {
    sgfHash: hash,
    playerLevel: level,
    positions: [],
    annotations: [],
    keyMoments: [],
    summary: {
      totalMoves: 0,
      classificationCounts: {
        brilliant: 0,
        good: 0,
        neutral: 0,
        inaccuracy: 0,
        mistake: 0,
        blunder: 0,
      },
      phaseBreakdown: { opening: 0, middlegame: 0, endgame: 0 },
      themes: [],
    },
    analyzedAt: Date.now(),
  };
}

/** Clear the in-memory result cache (useful for testing). */
export function clearResultCache(): void {
  resultCache.clear();
}
