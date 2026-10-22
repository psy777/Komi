/**
 * The non-LLM review pipeline — single source of truth.
 *
 * Runs in the browser (ad-hoc "Analyze" on an open game, via the adapter in
 * katagoService.ts) and on the server (review queue analyzing uploaded games,
 * via engineServerAdapter.ts). The engine is injected so this module stays
 * free of fetch endpoints, env vars, and caching concerns.
 *
 * Pipeline: SGF → shared-tree engine sweep → joseki/shape pattern detection →
 * per-move quality classification → mistake typing → key moments → deep
 * analysis of ambiguous positions → summary.
 */

import { parseSGF } from './sgfParser';
import {
  computeMoveQuality,
  detectMistakeType,
  detectGamePhase,
  detectThemes,
  identifyKeyMoments,
  estimatePlayerLevel,
} from './semanticExtractor';
import { detectPatternsForGame } from './patternDetector';
import { detectAmbiguousPositions, exploreVariations, createBudget } from './deepAnalysis';
import { toGtpCoordinate } from './goLogic';
import { StoneColor } from './types';
import type {
  KataGoAnalysis,
  SemanticAnnotation,
  FullGameAnalysis,
  AnalysisProgressData,
  AnalysisSummary,
  MoveClassification,
  GamePhase,
  PlayerLevel,
  GameTree,
  DeepAnalysisBudget,
} from './types';

// ---------------------------------------------------------------------------
// Engine abstraction
// ---------------------------------------------------------------------------

export interface EngineAdapter {
  /** Analyze every turn of a game in one shared-tree query. Index t = board after t moves. */
  analyzeGamePositions(
    movePairs: Array<[string, string]>,
    komi: number,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<(KataGoAnalysis | null)[]>;
  /** Analyze a single position given a flat GTP move list ["B","D4","W","Q16",...]. */
  analyzePosition(
    moves: string[],
    komi: number,
    currentPlayer: StoneColor,
  ): Promise<KataGoAnalysis | null>;
}

export interface ReviewOptions {
  playerLevel?: PlayerLevel;
  deepAnalysisBudget?: Partial<DeepAnalysisBudget>;
  onProgress?: (progress: AnalysisProgressData) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ExtractedMove {
  color: string; // 'B' | 'W'
  gtp: string;   // e.g. "D4"
  moveNumber: number;
  x: number;
  y: number;
}

/** Walk the main line of a parsed game tree and extract moves as GTP. */
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
        x: node.move.x,
        y: node.move.y,
      });
    }
    nodeId = node?.childrenIds[0] ?? null;
  }

  return moves;
}

/** Extract komi from SGF root node properties, default 6.5. */
function extractKomi(tree: GameTree): number {
  const root = tree.nodes[tree.rootId];
  const km = root?.properties?.KM;
  if (km) {
    const parsed = parseFloat(km);
    if (!isNaN(parsed)) return parsed;
  }
  return 6.5;
}

/** djb2 hash of SGF content — stable identity for an analysis result. */
export function sgfHash(sgfContent: string): string {
  let hash = 5381;
  for (let i = 0; i < sgfContent.length; i++) {
    hash = ((hash << 5) + hash + sgfContent.charCodeAt(i)) & 0xffffffff;
  }
  return `sgf_${hash.toString(36)}`;
}

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
        brilliant: 0, good: 0, neutral: 0, inaccuracy: 0, mistake: 0, blunder: 0,
      },
      phaseBreakdown: { opening: 0, middlegame: 0, endgame: 0 },
      themes: [],
    },
    analyzedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runFullReview(
  sgfContent: string,
  engine: EngineAdapter,
  opts: ReviewOptions = {},
): Promise<FullGameAnalysis> {
  const { playerLevel, deepAnalysisBudget, onProgress } = opts;
  const hash = sgfHash(sgfContent);

  // --- Parse ---------------------------------------------------------------

  const tree = parseSGF(sgfContent);
  const moves = extractMoves(tree);
  const totalMoves = moves.length;
  const komi = extractKomi(tree);

  if (totalMoves === 0) {
    onProgress?.({ phase: 'complete', current: 0, total: 0 });
    return emptyResult(hash, playerLevel ?? 'beginner');
  }

  // --- Engine sweep (one shared-tree query over all turns) ------------------

  const movePairs: Array<[string, string]> = moves.map((m) => [m.color, m.gtp]);

  onProgress?.({
    phase: 'engine',
    current: 0,
    total: totalMoves + 1,
    message: 'Fetching engine analysis...',
  });

  const analysisResults = await engine.analyzeGamePositions(
    movePairs,
    komi,
    (completed, total) => {
      onProgress?.({
        phase: 'engine',
        current: completed,
        total,
        message: `Analyzing position ${completed}/${total}`,
      });
    },
  );

  // --- Semantic extraction ---------------------------------------------------

  onProgress?.({
    phase: 'semantic',
    current: 0,
    total: totalMoves,
    message: 'Classifying moves...',
  });

  // Joseki/shape pattern detection (replays the game internally)
  const patterns = detectPatternsForGame(
    moves.map((m) => ({
      x: m.x,
      y: m.y,
      color: m.color === 'B' ? StoneColor.BLACK : StoneColor.WHITE,
    })),
  );

  const annotations: SemanticAnnotation[] = [];

  for (let i = 0; i < totalMoves; i++) {
    const evalBefore = analysisResults[i];
    const evalAfter = analysisResults[i + 1];

    // Skip positions where either eval failed (partial failure tolerance)
    if (!evalBefore || !evalAfter) {
      onProgress?.({ phase: 'semantic', current: i + 1, total: totalMoves });
      continue;
    }

    const actualMove = moves[i].gtp;
    const { classification, scoreDelta, winrateDelta, pointsLost, winrateLost } =
      computeMoveQuality(evalBefore, evalAfter, actualMove, moves[i].color);

    const engineTopMove = evalBefore.moveInfos[0]?.move ?? actualMove;
    const enginePV = evalBefore.moveInfos[0]?.pv ?? [engineTopMove];

    // The opponent's best reply after the played move IS the punishment line.
    const refutationPV =
      classification === 'mistake' || classification === 'blunder'
        ? evalAfter.moveInfos[0]?.pv
        : undefined;

    const boardOccupancy = (i + 1) / 361;
    const gamePhase = detectGamePhase(i + 1, evalBefore.ownership, boardOccupancy);

    const moveInfo = evalBefore.moveInfos.find((m) => m.move === actualMove);
    const themes = detectThemes(evalBefore, evalAfter, moveInfo);

    annotations.push({
      moveNumber: i + 1,
      color: moves[i].color === 'B' ? StoneColor.BLACK : StoneColor.WHITE,
      classification,
      // mistakeType is computed in the pass below
      scoreDelta,
      winrateDelta,
      pointsLost,
      winrateLost,
      gamePhase,
      themes,
      engineTopMove,
      enginePV,
      refutationPV,
      isKeyMoment: false,
      pattern: patterns[i] ?? undefined,
    });

    onProgress?.({ phase: 'semantic', current: i + 1, total: totalMoves });
  }

  // --- Mistake typing --------------------------------------------------------

  for (let j = 0; j < annotations.length; j++) {
    const ann = annotations[j];
    const moveIdx = ann.moveNumber - 1;
    const evalBefore = analysisResults[moveIdx];
    if (!evalBefore) continue;

    annotations[j] = {
      ...ann,
      mistakeType: detectMistakeType(
        moves[moveIdx].gtp,
        ann.engineTopMove,
        ann.classification,
        ann.scoreDelta,
        evalBefore.rootInfo.winrate,
      ),
    };
  }

  // --- Key moments -----------------------------------------------------------

  const annotated = identifyKeyMoments(annotations, analysisResults);
  const keyMoments = annotated.filter((a) => a.isKeyMoment);
  const estimatedLevel = playerLevel ?? estimatePlayerLevel(annotated);

  // --- Deep analysis of ambiguous positions ----------------------------------

  const positions = analysisResults.filter(
    (r): r is KataGoAnalysis => r !== null,
  );

  const flatMoveList: string[] = [];
  for (const m of moves) flatMoveList.push(m.color, m.gtp);

  const prelimResult: FullGameAnalysis = {
    sgfHash: hash,
    playerLevel: estimatedLevel,
    positions,
    annotations: annotated,
    keyMoments,
    summary: { totalMoves, classificationCounts: {} as any, phaseBreakdown: {} as any, themes: [] },
    analyzedAt: Date.now(),
  };

  let deepAnalysisResult = undefined;
  const budget = createBudget(deepAnalysisBudget);

  if (budget.maxPositions > 0) {
    const ambiguous = detectAmbiguousPositions(prelimResult);

    if (ambiguous.length > 0) {
      onProgress?.({
        phase: 'semantic',
        current: totalMoves,
        total: totalMoves,
        message: `Exploring ${Math.min(ambiguous.length, budget.maxPositions)} ambiguous positions...`,
      });

      deepAnalysisResult = await exploreVariations(
        ambiguous,
        flatMoveList,
        komi,
        budget,
        (completed, total) => {
          onProgress?.({
            phase: 'semantic',
            current: totalMoves,
            total: totalMoves,
            message: `Deep analysis: ${completed}/${total} variations`,
          });
        },
        (ms, k, p) => engine.analyzePosition(ms, k, p),
      );
    }
  }

  // --- Summary ---------------------------------------------------------------

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
    phaseBreakdown[phase] = annotated.filter((a) => a.gamePhase === phase).length;
  }

  const allThemes = [...new Set(annotated.flatMap((a) => a.themes))];

  const patternCategories = [
    ...new Set(
      annotated.filter((a) => a.pattern).map((a) => a.pattern!.category),
    ),
  ];
  allThemes.push(...patternCategories.filter((c) => !allThemes.includes(c)));

  const summary: AnalysisSummary = {
    totalMoves,
    classificationCounts,
    phaseBreakdown,
    themes: allThemes,
  };

  const result: FullGameAnalysis = {
    sgfHash: hash,
    playerLevel: estimatedLevel,
    positions,
    annotations: annotated,
    keyMoments,
    summary,
    deepAnalysis: deepAnalysisResult,
    analyzedAt: Date.now(),
  };

  onProgress?.({
    phase: 'complete',
    current: totalMoves,
    total: totalMoves,
    message: 'Analysis complete',
  });

  return result;
}

// ---------------------------------------------------------------------------
// Serialization (deepAnalysis.explorations is a Map — JSON turns it into {})
// ---------------------------------------------------------------------------

/** Convert a FullGameAnalysis to a JSON-safe plain object. */
export function serializeAnalysis(analysis: FullGameAnalysis): any {
  if (!analysis.deepAnalysis) return analysis;
  return {
    ...analysis,
    deepAnalysis: {
      ...analysis.deepAnalysis,
      explorations: [...analysis.deepAnalysis.explorations.entries()],
    },
  };
}

/** Rebuild a FullGameAnalysis from JSON (restores the explorations Map). */
export function hydrateAnalysis(raw: any): FullGameAnalysis {
  if (!raw?.deepAnalysis?.explorations) return raw as FullGameAnalysis;
  const entries = Array.isArray(raw.deepAnalysis.explorations)
    ? raw.deepAnalysis.explorations
    : Object.entries(raw.deepAnalysis.explorations).map(
        ([k, v]) => [Number(k), v] as [number, any],
      );
  return {
    ...raw,
    deepAnalysis: { ...raw.deepAnalysis, explorations: new Map(entries) },
  } as FullGameAnalysis;
}
