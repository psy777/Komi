import { describe, it, expect, vi, beforeEach } from 'vitest';
import { analyzeGame, clearResultCache } from './analysisOrchestrator';
import type {
  KataGoAnalysis,
  AnalysisProgressData,
  FullGameAnalysis,
} from './types';
import { StoneColor } from './types';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock katagoService — avoid real network calls
vi.mock('./katagoService', () => ({
  batchAnalyze: vi.fn(),
}));

// Mock analysisCache — avoid IndexedDB in tests
vi.mock('./analysisCache', () => ({
  sgfHash: vi.fn((s: string) => `sgf_test_${s.length}`),
  positionHash: vi.fn((moves: string[]) => `pos_test_${moves.length}`),
  loadGameAnalysis: vi.fn().mockResolvedValue(null),
  saveGameAnalysis: vi.fn().mockResolvedValue(undefined),
  cacheAnalysis: vi.fn(),
}));

// Mock sgfParser — return a controlled game tree
vi.mock('./sgfParser', () => ({
  parseSGF: vi.fn(),
}));

// Mock goLogic — simple GTP coordinate generation
vi.mock('./goLogic', () => ({
  toGtpCoordinate: vi.fn((x: number, y: number) => {
    const cols = 'ABCDEFGHJKLMNOPQRST';
    return `${cols[x]}${19 - y}`;
  }),
}));

import { batchAnalyze } from './katagoService';
import { parseSGF } from './sgfParser';
import { sgfHash, saveGameAnalysis, cacheAnalysis } from './analysisCache';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeEval(overrides: Partial<KataGoAnalysis> & { scoreLead?: number; winrate?: number } = {}): KataGoAnalysis {
  return {
    rootInfo: {
      scoreLead: overrides.scoreLead ?? 0,
      winrate: overrides.winrate ?? 0.5,
      visits: 100,
    },
    moveInfos: overrides.moveInfos ?? [
      { move: 'D4', visits: 80, winrate: 0.5, scoreLead: 0, prior: 0.3, pv: ['D4'] },
      { move: 'Q16', visits: 20, winrate: 0.48, scoreLead: -0.2, prior: 0.2, pv: ['Q16'] },
    ],
    ownership: overrides.ownership ?? null,
    turnNumber: overrides.turnNumber ?? 1,
    currentPlayer: overrides.currentPlayer ?? StoneColor.BLACK,
  };
}

/** Build a minimal game tree with N moves, alternating B/W. */
function makeGameTree(numMoves: number) {
  const nodes: Record<string, any> = {};
  const rootId = 'root';
  nodes[rootId] = {
    id: rootId,
    parentId: null,
    childrenIds: numMoves > 0 ? ['move-1'] : [],
    properties: { SZ: '19', KM: '6.5' },
  };

  for (let i = 1; i <= numMoves; i++) {
    const nodeId = `move-${i}`;
    const nextId = i < numMoves ? `move-${i + 1}` : undefined;
    nodes[nodeId] = {
      id: nodeId,
      parentId: i === 1 ? rootId : `move-${i - 1}`,
      childrenIds: nextId ? [nextId] : [],
      properties: {},
      move: {
        color: i % 2 === 1 ? StoneColor.BLACK : StoneColor.WHITE,
        x: (i * 3) % 19,
        y: (i * 2) % 19,
      },
    };
  }

  return { nodes, rootId, currentId: rootId };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  clearResultCache();
});

describe('analyzeGame', () => {
  it('returns FullGameAnalysis with all required fields', async () => {
    const tree = makeGameTree(3);
    (parseSGF as ReturnType<typeof vi.fn>).mockReturnValue(tree);

    // 4 positions for 3 moves (before move 1, after 1, after 2, after 3)
    const evals = [
      makeEval({ scoreLead: 0, winrate: 0.5, turnNumber: 0 }),
      makeEval({ scoreLead: -0.3, winrate: 0.48, turnNumber: 1 }),
      makeEval({ scoreLead: 0.2, winrate: 0.52, turnNumber: 2 }),
      makeEval({ scoreLead: -0.1, winrate: 0.49, turnNumber: 3 }),
    ];
    (batchAnalyze as ReturnType<typeof vi.fn>).mockResolvedValue(evals);

    const result = await analyzeGame('(;GM[1];B[pd];W[dp];B[pq])');

    expect(result).toHaveProperty('sgfHash');
    expect(result).toHaveProperty('playerLevel');
    expect(result).toHaveProperty('positions');
    expect(result).toHaveProperty('annotations');
    expect(result).toHaveProperty('keyMoments');
    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('analyzedAt');

    expect(result.positions).toHaveLength(4);
    expect(result.annotations).toHaveLength(3);
    expect(result.summary.totalMoves).toBe(3);
    expect(typeof result.summary.classificationCounts.neutral).toBe('number');
    expect(typeof result.summary.phaseBreakdown.opening).toBe('number');
    expect(Array.isArray(result.summary.themes)).toBe(true);
  });

  it('returns cached result on second call without calling batchAnalyze again', async () => {
    const tree = makeGameTree(2);
    (parseSGF as ReturnType<typeof vi.fn>).mockReturnValue(tree);

    const evals = [
      makeEval({ scoreLead: 0 }),
      makeEval({ scoreLead: -0.1 }),
      makeEval({ scoreLead: 0.1 }),
    ];
    (batchAnalyze as ReturnType<typeof vi.fn>).mockResolvedValue(evals);

    const result1 = await analyzeGame('(;GM[1];B[pd];W[dp])');
    const result2 = await analyzeGame('(;GM[1];B[pd];W[dp])');

    expect(result1.sgfHash).toBe(result2.sgfHash);
    expect(batchAnalyze).toHaveBeenCalledTimes(1);
  });

  it('fires progress callbacks for each phase', async () => {
    const tree = makeGameTree(2);
    (parseSGF as ReturnType<typeof vi.fn>).mockReturnValue(tree);

    const evals = [
      makeEval({ scoreLead: 0 }),
      makeEval({ scoreLead: -0.5 }),
      makeEval({ scoreLead: 0.3 }),
    ];
    // Simulate batchAnalyze calling onProgress
    (batchAnalyze as ReturnType<typeof vi.fn>).mockImplementation(
      async (_positions: any, _concurrency: any, onProgress?: (c: number, t: number) => void) => {
        onProgress?.(1, 3);
        onProgress?.(2, 3);
        onProgress?.(3, 3);
        return evals;
      },
    );

    const phases: string[] = [];
    const onProgress = (p: AnalysisProgressData) => {
      phases.push(p.phase);
    };

    await analyzeGame('(;GM[1];B[pd];W[dp])', undefined, onProgress);

    expect(phases).toContain('engine');
    expect(phases).toContain('semantic');
    expect(phases).toContain('complete');
  });

  it('handles partial KataGo failures gracefully (skip positions, dont crash)', async () => {
    const tree = makeGameTree(3);
    (parseSGF as ReturnType<typeof vi.fn>).mockReturnValue(tree);

    // Position 1 failed (null)
    const evals = [
      makeEval({ scoreLead: 0 }),
      null, // failed
      makeEval({ scoreLead: 0.2 }),
      makeEval({ scoreLead: -0.1 }),
    ];
    (batchAnalyze as ReturnType<typeof vi.fn>).mockResolvedValue(evals);

    const result = await analyzeGame('(;GM[1];B[pd];W[dp];B[pq])');

    // Move 1 needs evals[0] + evals[1] — evals[1] is null → skipped
    // Move 2 needs evals[1] + evals[2] — evals[1] is null → skipped
    // Move 3 needs evals[2] + evals[3] — both exist → annotated
    expect(result.annotations.length).toBe(1);
    expect(result.annotations[0].moveNumber).toBe(3);
  });

  it('returns empty analysis for SGF with no moves', async () => {
    const tree = makeGameTree(0);
    (parseSGF as ReturnType<typeof vi.fn>).mockReturnValue(tree);

    const result = await analyzeGame('(;GM[1])');

    expect(result.annotations).toEqual([]);
    expect(result.keyMoments).toEqual([]);
    expect(result.positions).toEqual([]);
    expect(result.summary.totalMoves).toBe(0);
    expect(batchAnalyze).not.toHaveBeenCalled();
  });

  it('persists results to IndexedDB via saveGameAnalysis', async () => {
    const tree = makeGameTree(1);
    (parseSGF as ReturnType<typeof vi.fn>).mockReturnValue(tree);

    const evals = [
      makeEval({ scoreLead: 0 }),
      makeEval({ scoreLead: -0.3 }),
    ];
    (batchAnalyze as ReturnType<typeof vi.fn>).mockResolvedValue(evals);

    await analyzeGame('(;GM[1];B[pd])');

    expect(saveGameAnalysis).toHaveBeenCalledTimes(1);
    expect(cacheAnalysis).toHaveBeenCalled();
  });

  it('uses provided playerLevel instead of estimating', async () => {
    const tree = makeGameTree(2);
    (parseSGF as ReturnType<typeof vi.fn>).mockReturnValue(tree);

    const evals = [
      makeEval({ scoreLead: 0 }),
      makeEval({ scoreLead: -0.1 }),
      makeEval({ scoreLead: 0.1 }),
    ];
    (batchAnalyze as ReturnType<typeof vi.fn>).mockResolvedValue(evals);

    const result = await analyzeGame('(;GM[1];B[pd];W[dp])', 'strong');

    expect(result.playerLevel).toBe('strong');
  });

  it('estimates player level when not provided', async () => {
    const tree = makeGameTree(2);
    (parseSGF as ReturnType<typeof vi.fn>).mockReturnValue(tree);

    // Large losses → beginner
    const evals = [
      makeEval({ scoreLead: 10.0, winrate: 0.8 }),
      makeEval({ scoreLead: 8.0, winrate: 0.7 }),  // after move 1: opponent has +8
      makeEval({ scoreLead: 6.0, winrate: 0.6 }),  // after move 2: opponent has +6
    ];
    (batchAnalyze as ReturnType<typeof vi.fn>).mockResolvedValue(evals);

    const result = await analyzeGame('(;GM[1];B[pd];W[dp])', undefined);

    // playerLevel is estimated from annotations
    expect(['beginner', 'intermediate', 'advanced', 'strong']).toContain(
      result.playerLevel,
    );
  });

  it('correctly populates classificationCounts in summary', async () => {
    const tree = makeGameTree(3);
    (parseSGF as ReturnType<typeof vi.fn>).mockReturnValue(tree);

    // Create scenario: move 1 neutral, move 2 blunder, move 3 neutral
    const evals = [
      makeEval({ scoreLead: 0, winrate: 0.5 }),
      makeEval({ scoreLead: 0.1, winrate: 0.49 }),   // neutral delta for move 1
      makeEval({ scoreLead: 10.0, winrate: 0.9 }),    // huge swing for move 2 (blunder)
      makeEval({ scoreLead: -9.8, winrate: 0.1 }),    // neutral delta for move 3
    ];
    (batchAnalyze as ReturnType<typeof vi.fn>).mockResolvedValue(evals);

    const result = await analyzeGame('(;GM[1];B[pd];W[dp];B[pq])');

    const counts = result.summary.classificationCounts;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(3);
  });

  it('identifies key moments among annotations', async () => {
    const tree = makeGameTree(3);
    (parseSGF as ReturnType<typeof vi.fn>).mockReturnValue(tree);

    // Move 2 is a blunder — should be a key moment
    const evals = [
      makeEval({ scoreLead: 0, winrate: 0.5 }),
      makeEval({ scoreLead: 0.1, winrate: 0.49 }),
      makeEval({ scoreLead: 10.0, winrate: 0.9 }),
      makeEval({ scoreLead: -9.5, winrate: 0.1 }),
    ];
    (batchAnalyze as ReturnType<typeof vi.fn>).mockResolvedValue(evals);

    const result = await analyzeGame('test-sgf-key-moments');

    expect(result.keyMoments.length).toBeGreaterThan(0);
    expect(result.keyMoments.every((m) => m.isKeyMoment)).toBe(true);
  });
});
