import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runFullReview, serializeAnalysis, hydrateAnalysis } from './reviewPipeline';
import type { EngineAdapter } from './reviewPipeline';
import type { KataGoAnalysis, AnalysisProgressData } from './types';
import { StoneColor } from './types';

// Mock sgfParser — return a controlled game tree
vi.mock('./sgfParser', () => ({
  parseSGF: vi.fn(),
}));

// Mock patternDetector — avoid needing full board replay
vi.mock('./patternDetector', () => ({
  detectPatternsForGame: vi.fn(() => []),
}));

import { parseSGF } from './sgfParser';

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

/** Stub engine returning the given evals from the shared-tree sweep. */
function makeEngine(evals: (KataGoAnalysis | null)[]): EngineAdapter & {
  gameCalls: number;
  positionCalls: number;
} {
  const engine = {
    gameCalls: 0,
    positionCalls: 0,
    async analyzeGamePositions(
      _movePairs: Array<[string, string]>,
      _komi: number,
      onProgress?: (c: number, t: number) => void,
    ) {
      engine.gameCalls++;
      onProgress?.(evals.length, evals.length);
      return evals;
    },
    async analyzePosition() {
      engine.positionCalls++;
      return makeEval();
    },
  };
  return engine;
}

// Deep analysis off by default: keeps the stub engine's call count deterministic.
const NO_DEEP = { deepAnalysisBudget: { maxPositions: 0 } };

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runFullReview', () => {
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

    const result = await runFullReview('(;GM[1];B[pd];W[dp];B[pq])', makeEngine(evals), NO_DEEP);

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

  it('fires progress callbacks for each phase', async () => {
    const tree = makeGameTree(2);
    (parseSGF as ReturnType<typeof vi.fn>).mockReturnValue(tree);

    const evals = [
      makeEval({ scoreLead: 0 }),
      makeEval({ scoreLead: -0.5 }),
      makeEval({ scoreLead: 0.3 }),
    ];

    const phases: string[] = [];
    await runFullReview('(;GM[1];B[pd];W[dp])', makeEngine(evals), {
      ...NO_DEEP,
      onProgress: (p: AnalysisProgressData) => phases.push(p.phase),
    });

    expect(phases).toContain('engine');
    expect(phases).toContain('semantic');
    expect(phases).toContain('complete');
  });

  it('handles partial engine failures gracefully (skip positions, dont crash)', async () => {
    const tree = makeGameTree(3);
    (parseSGF as ReturnType<typeof vi.fn>).mockReturnValue(tree);

    const evals = [
      makeEval({ scoreLead: 0 }),
      null, // failed
      makeEval({ scoreLead: 0.2 }),
      makeEval({ scoreLead: -0.1 }),
    ];

    const result = await runFullReview('(;GM[1];B[pd];W[dp];B[pq])', makeEngine(evals), NO_DEEP);

    // Move 1 needs evals[0] + evals[1] — evals[1] is null → skipped
    // Move 2 needs evals[1] + evals[2] — evals[1] is null → skipped
    // Move 3 needs evals[2] + evals[3] — both exist → annotated
    expect(result.annotations.length).toBe(1);
    expect(result.annotations[0].moveNumber).toBe(3);
  });

  it('returns empty analysis for SGF with no moves without calling the engine', async () => {
    const tree = makeGameTree(0);
    (parseSGF as ReturnType<typeof vi.fn>).mockReturnValue(tree);

    const engine = makeEngine([]);
    const result = await runFullReview('(;GM[1])', engine, NO_DEEP);

    expect(result.annotations).toEqual([]);
    expect(result.keyMoments).toEqual([]);
    expect(result.positions).toEqual([]);
    expect(result.summary.totalMoves).toBe(0);
    expect(engine.gameCalls).toBe(0);
  });

  it('uses provided playerLevel instead of estimating', async () => {
    const tree = makeGameTree(2);
    (parseSGF as ReturnType<typeof vi.fn>).mockReturnValue(tree);

    const evals = [
      makeEval({ scoreLead: 0 }),
      makeEval({ scoreLead: -0.1 }),
      makeEval({ scoreLead: 0.1 }),
    ];

    const result = await runFullReview('(;GM[1];B[pd];W[dp])', makeEngine(evals), {
      ...NO_DEEP,
      playerLevel: 'strong',
    });

    expect(result.playerLevel).toBe('strong');
  });

  it('estimates player level when not provided', async () => {
    const tree = makeGameTree(2);
    (parseSGF as ReturnType<typeof vi.fn>).mockReturnValue(tree);

    const evals = [
      makeEval({ scoreLead: 10.0, winrate: 0.8 }),
      makeEval({ scoreLead: 8.0, winrate: 0.7 }),
      makeEval({ scoreLead: 6.0, winrate: 0.6 }),
    ];

    const result = await runFullReview('(;GM[1];B[pd];W[dp])', makeEngine(evals), NO_DEEP);

    expect(['beginner', 'intermediate', 'advanced', 'strong']).toContain(
      result.playerLevel,
    );
  });

  it('correctly populates classificationCounts in summary', async () => {
    const tree = makeGameTree(3);
    (parseSGF as ReturnType<typeof vi.fn>).mockReturnValue(tree);

    const evals = [
      makeEval({ scoreLead: 0, winrate: 0.5 }),
      makeEval({ scoreLead: 0.1, winrate: 0.49 }),
      makeEval({ scoreLead: 10.0, winrate: 0.9 }),
      makeEval({ scoreLead: -9.8, winrate: 0.1 }),
    ];

    const result = await runFullReview('(;GM[1];B[pd];W[dp];B[pq])', makeEngine(evals), NO_DEEP);

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

    const result = await runFullReview('test-sgf-key-moments', makeEngine(evals), NO_DEEP);

    expect(result.keyMoments.length).toBeGreaterThan(0);
    expect(result.keyMoments.every((m) => m.isKeyMoment)).toBe(true);
  });
});

describe('serializeAnalysis / hydrateAnalysis', () => {
  it('round-trips the deepAnalysis explorations Map through JSON', () => {
    const exploration = {
      moveNumber: 5,
      reason: 'close_candidates',
      ambiguityGap: 0.5,
      variations: [],
      bestVariation: 'D4',
      variationSpread: 1.2,
    };
    const analysis: any = {
      sgfHash: 'sgf_x',
      deepAnalysis: {
        explorations: new Map([[5, exploration]]),
        apiCallsUsed: 3,
        ambiguousCount: 1,
        exploredCount: 1,
      },
    };

    const json = JSON.stringify(serializeAnalysis(analysis));
    const hydrated = hydrateAnalysis(JSON.parse(json));

    expect(hydrated.deepAnalysis!.explorations).toBeInstanceOf(Map);
    expect(hydrated.deepAnalysis!.explorations.get(5)).toEqual(exploration);
    expect(hydrated.deepAnalysis!.apiCallsUsed).toBe(3);
  });

  it('passes through analyses without deepAnalysis untouched', () => {
    const analysis: any = { sgfHash: 'sgf_y', annotations: [] };
    expect(serializeAnalysis(analysis)).toBe(analysis);
    expect(hydrateAnalysis(JSON.parse(JSON.stringify(analysis)))).toEqual(analysis);
  });
});
