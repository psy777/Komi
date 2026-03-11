import { describe, it, expect } from 'vitest';
import {
  classifyMove,
  detectMistakeType,
  detectGamePhase,
  detectThemes,
  identifyKeyMoments,
  CLASSIFICATION_THRESHOLDS,
  PHASE_THRESHOLDS,
} from './semanticExtractor';
import type { KataGoAnalysis, SemanticAnnotation } from './types';
import { StoneColor } from './types';

// ---------------------------------------------------------------------------
// Test helpers — build minimal KataGoAnalysis objects
// ---------------------------------------------------------------------------

function makeEval(overrides: {
  scoreLead?: number;
  winrate?: number;
  visits?: number;
  turnNumber?: number;
  currentPlayer?: StoneColor;
  moveInfos?: KataGoAnalysis['moveInfos'];
  ownership?: number[] | null;
}): KataGoAnalysis {
  return {
    rootInfo: {
      scoreLead: overrides.scoreLead ?? 0,
      winrate: overrides.winrate ?? 0.5,
      visits: overrides.visits ?? 100,
    },
    moveInfos: overrides.moveInfos ?? [
      { move: 'D4', visits: 80, winrate: 0.5, scoreLead: 0, prior: 0.3, pv: ['D4'] },
      { move: 'Q16', visits: 20, winrate: 0.48, scoreLead: -0.2, prior: 0.2, pv: ['Q16'] },
    ],
    ownership: overrides.ownership ?? null,
    turnNumber: overrides.turnNumber ?? 50,
    currentPlayer: overrides.currentPlayer ?? StoneColor.BLACK,
  };
}

function makeAnnotation(overrides: Partial<SemanticAnnotation> = {}): SemanticAnnotation {
  return {
    moveNumber: 1,
    classification: 'neutral',
    scoreDelta: 0,
    winrateDelta: 0,
    gamePhase: 'middlegame',
    themes: [],
    engineTopMove: 'D4',
    enginePV: ['D4'],
    isKeyMoment: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// classifyMove
// ---------------------------------------------------------------------------

describe('classifyMove', () => {
  it('classifies a neutral move (small score change)', () => {
    // Before: mover leads by 2.0. After (opponent POV): opponent trails by 1.8
    // scoreDelta = -(-1.8) - 2.0 = 1.8 - 2.0 = -0.2 → neutral
    const before = makeEval({ scoreLead: 2.0, winrate: 0.55 });
    const after  = makeEval({ scoreLead: -1.8, winrate: 0.45 }); // opponent POV
    const result = classifyMove(before, after);
    expect(result.classification).toBe('neutral');
    expect(result.scoreDelta).toBeCloseTo(-0.2, 1);
  });

  it('classifies a blunder (huge score loss)', () => {
    // Before: mover leads by 5.0. After (opponent): opponent leads by 3.0
    // scoreDelta = -(3.0) - 5.0 = -3.0 - 5.0 = -8.0 → blunder
    const before = makeEval({ scoreLead: 5.0, winrate: 0.7 });
    const after  = makeEval({ scoreLead: 3.0, winrate: 0.65 });
    const result = classifyMove(before, after);
    expect(result.classification).toBe('blunder');
    expect(result.scoreDelta).toBeLessThan(-5.0);
  });

  it('classifies a brilliant move (large positive delta)', () => {
    // Before: mover leads by 1.0. After (opponent): opponent trails by 4.0
    // scoreDelta = -(-4.0) - 1.0 = 4.0 - 1.0 = 3.0 → brilliant
    const before = makeEval({ scoreLead: 1.0, winrate: 0.55 });
    const after  = makeEval({ scoreLead: -4.0, winrate: 0.3 });
    const result = classifyMove(before, after);
    expect(result.classification).toBe('brilliant');
    expect(result.scoreDelta).toBeGreaterThan(2.0);
  });

  it('classifies a mistake (moderate loss)', () => {
    // scoreDelta = -(1.0) - 2.0 = -3.0 → mistake
    const before = makeEval({ scoreLead: 2.0 });
    const after  = makeEval({ scoreLead: 1.0 });
    const result = classifyMove(before, after);
    expect(result.classification).toBe('mistake');
  });

  it('classifies an inaccuracy (small loss)', () => {
    // scoreDelta = -(-0.5) - 2.0 = 0.5 - 2.0 = -1.5 → inaccuracy
    const before = makeEval({ scoreLead: 2.0 });
    const after  = makeEval({ scoreLead: -0.5 });
    const result = classifyMove(before, after);
    expect(result.classification).toBe('inaccuracy');
  });

  it('classifies a good move', () => {
    // scoreDelta = -(- 2.0) - 1.0 = 2.0 - 1.0 = 1.0 → good
    const before = makeEval({ scoreLead: 1.0 });
    const after  = makeEval({ scoreLead: -2.0 });
    const result = classifyMove(before, after);
    expect(result.classification).toBe('good');
  });

  it('computes winrate delta correctly', () => {
    const before = makeEval({ scoreLead: 0, winrate: 0.5 });
    const after  = makeEval({ scoreLead: 0, winrate: 0.4 }); // opponent has 0.4 → mover has 0.6
    const result = classifyMove(before, after);
    expect(result.winrateDelta).toBeCloseTo(0.1, 2);
  });
});

// ---------------------------------------------------------------------------
// detectMistakeType
// ---------------------------------------------------------------------------

describe('detectMistakeType', () => {
  it('returns undefined for non-mistakes', () => {
    const before = makeEval({ scoreLead: 1.0 });
    const after  = makeEval({ scoreLead: -1.2 }); // small positive delta
    const result = detectMistakeType('D4', 'D4', before, after);
    expect(result).toBeUndefined();
  });

  it('detects direction error (different board region)', () => {
    // Played in top-left, engine wanted bottom-right → direction
    const before = makeEval({ scoreLead: 3.0 });
    const after  = makeEval({ scoreLead: 0.0 }); // scoreDelta = 0 - 3 = -3 → mistake
    const result = detectMistakeType('C17', 'R3', before, after);
    expect(result).toBe('direction');
  });

  it('detects timing error (large distance between moves)', () => {
    // Played at D4, engine wanted D16 — same column but far apart
    const before = makeEval({ scoreLead: 3.0 });
    const after  = makeEval({ scoreLead: 0.0 });
    const result = detectMistakeType('D4', 'D16', before, after);
    expect(result).toBe('timing');
  });

  it('detects shape error (close moves, same region)', () => {
    // Played D4, engine wanted E5 — very close, same region → shape
    const before = makeEval({ scoreLead: 2.0 });
    const after  = makeEval({ scoreLead: 0.7 }); // scoreDelta = -0.7 - 2.0 = -2.7 → mistake
    const result = detectMistakeType('D4', 'E5', before, after);
    expect(result).toBe('shape');
  });

  it('detects overplay (losing side plays aggressively)', () => {
    // Mover was behind (winrate 0.3), blunders further
    const before = makeEval({ scoreLead: -5.0, winrate: 0.3 });
    const after  = makeEval({ scoreLead: 3.0 }); // scoreDelta = -3 - (-5) = -3+5= ... wait
    // scoreDelta = -(3.0) - (-5.0) = -3 + 5 = 2.0 that's positive... need bigger loss
    // Let's make it clearer: before scoreLead = -3 (behind), after opponent has +10
    const before2 = makeEval({ scoreLead: -3.0, winrate: 0.3 });
    const after2  = makeEval({ scoreLead: 10.0 }); // scoreDelta = -10 - (-3) = -7 → blunder
    const result = detectMistakeType('D4', 'E5', before2, after2);
    expect(result).toBe('overplay');
  });

  it('detects passivity (winning side loses advantage)', () => {
    const before = makeEval({ scoreLead: 8.0, winrate: 0.75 });
    const after  = makeEval({ scoreLead: -4.0 }); // scoreDelta = 4.0 - 8.0 = -4.0 → mistake
    // Mover was ahead (0.75) and lost ground → passivity
    const result = detectMistakeType('D4', 'E5', before, after);
    expect(result).toBe('passivity');
  });

  it('defaults to reading for ambiguous mistakes', () => {
    // Same region, not particularly close or far, moderate loss
    const before = makeEval({ scoreLead: 2.0, winrate: 0.55 });
    const after  = makeEval({ scoreLead: -1.0 }); // scoreDelta = 1.0 - 2.0 = -1.0... that's inaccuracy not mistake
    // Need bigger loss in same region
    const before2 = makeEval({ scoreLead: 4.0, winrate: 0.55 });
    const after2  = makeEval({ scoreLead: 2.0 }); // scoreDelta = -2 - 4 = -6 → blunder
    // D10 and F8 are both center-ish, ~4 apart
    const result = detectMistakeType('D10', 'F8', before2, after2);
    expect(result).toBe('reading');
  });
});

// ---------------------------------------------------------------------------
// detectGamePhase
// ---------------------------------------------------------------------------

describe('detectGamePhase', () => {
  it('detects opening with low occupancy and low move number', () => {
    expect(detectGamePhase(20, null, 0.05)).toBe('opening');
  });

  it('detects middlegame for mid-game positions', () => {
    expect(detectGamePhase(100, null, 0.3)).toBe('middlegame');
  });

  it('detects endgame with high move number', () => {
    expect(detectGamePhase(200, null, 0.5)).toBe('endgame');
  });

  it('detects endgame with high occupancy', () => {
    expect(detectGamePhase(150, null, 0.6)).toBe('endgame');
  });

  it('uses ownership data when available (settled → endgame)', () => {
    // 80% of board has |ownership| > 0.8 → settled
    const ownership = new Array(361).fill(0).map((_, i) =>
      i < 290 ? 0.9 : 0.3 // 290/361 ≈ 0.80
    );
    expect(detectGamePhase(150, ownership, 0.4)).toBe('endgame');
  });

  it('uses ownership data when available (unsettled → middlegame)', () => {
    const ownership = new Array(361).fill(0.3); // nothing settled
    expect(detectGamePhase(100, ownership, 0.3)).toBe('middlegame');
  });

  it('detects opening even with ownership data', () => {
    const ownership = new Array(361).fill(0.1);
    expect(detectGamePhase(15, ownership, 0.04)).toBe('opening');
  });
});

// ---------------------------------------------------------------------------
// detectThemes
// ---------------------------------------------------------------------------

describe('detectThemes', () => {
  it('detects momentum_shift on large winrate change', () => {
    const before = makeEval({ winrate: 0.4 });
    const after  = makeEval({ winrate: 0.8 }); // opponent 0.8 → mover 0.2, delta = -0.2
    // Actually: winrateAfter (mover) = 1 - 0.8 = 0.2, delta = 0.2 - 0.4 = -0.2 → |delta| > 0.1
    const themes = detectThemes(before, after);
    expect(themes).toContain('momentum_shift');
  });

  it('detects critical_move when top moves differ significantly', () => {
    const before = makeEval({
      moveInfos: [
        { move: 'D4', visits: 80, winrate: 0.6, scoreLead: 5.0, prior: 0.4, pv: ['D4'] },
        { move: 'Q16', visits: 20, winrate: 0.45, scoreLead: 1.0, prior: 0.2, pv: ['Q16'] },
      ],
    });
    const after = makeEval({});
    const themes = detectThemes(before, after);
    expect(themes).toContain('critical_move');
  });

  it('detects endgame_technique for late small-delta moves', () => {
    const before = makeEval({ scoreLead: 3.0, turnNumber: 200 });
    const after  = makeEval({ scoreLead: -3.5 }); // delta = 3.5 - 3.0 = 0.5
    const themes = detectThemes(before, after);
    expect(themes).toContain('endgame_technique');
  });

  it('detects sente when engine response is nearby', () => {
    const before = makeEval({});
    const after  = makeEval({
      moveInfos: [
        { move: 'E5', visits: 80, winrate: 0.5, scoreLead: 0, prior: 0.3, pv: ['E5'] },
      ],
    });
    const moveInfo = { move: 'D4', visits: 50, winrate: 0.5, scoreLead: 0, prior: 0.3, pv: ['D4'] };
    const themes = detectThemes(before, after, moveInfo);
    expect(themes).toContain('sente');
  });

  it('detects territory for 3rd-line moves in the opening', () => {
    const before = makeEval({ turnNumber: 20 });
    const after  = makeEval({});
    const moveInfo = { move: 'D3', visits: 50, winrate: 0.5, scoreLead: 0, prior: 0.3, pv: ['D3'] };
    const themes = detectThemes(before, after, moveInfo);
    expect(themes).toContain('territory');
  });

  it('detects influence for 4th+ line moves in the opening', () => {
    const before = makeEval({ turnNumber: 20 });
    const after  = makeEval({});
    const moveInfo = { move: 'D4', visits: 50, winrate: 0.5, scoreLead: 0, prior: 0.3, pv: ['D4'] };
    const themes = detectThemes(before, after, moveInfo);
    expect(themes).toContain('influence');
  });
});

// ---------------------------------------------------------------------------
// identifyKeyMoments
// ---------------------------------------------------------------------------

describe('identifyKeyMoments', () => {
  it('returns empty array for empty input', () => {
    expect(identifyKeyMoments([])).toEqual([]);
  });

  it('marks blunders as key moments', () => {
    const anns = [
      makeAnnotation({ moveNumber: 1, classification: 'neutral', scoreDelta: 0 }),
      makeAnnotation({ moveNumber: 50, classification: 'blunder', scoreDelta: -8.0 }),
      makeAnnotation({ moveNumber: 100, classification: 'neutral', scoreDelta: 0.1 }),
    ];
    const result = identifyKeyMoments(anns);
    expect(result[1].isKeyMoment).toBe(true);
  });

  it('marks game phase transitions as key moments', () => {
    const anns = [
      makeAnnotation({ moveNumber: 55, gamePhase: 'opening', classification: 'neutral', scoreDelta: 0 }),
      makeAnnotation({ moveNumber: 56, gamePhase: 'middlegame', classification: 'neutral', scoreDelta: 0 }),
    ];
    const result = identifyKeyMoments(anns);
    expect(result[1].isKeyMoment).toBe(true);
  });

  it('marks brilliant moves as key moments', () => {
    const anns = [
      makeAnnotation({ moveNumber: 80, classification: 'brilliant', scoreDelta: 4.0 }),
    ];
    const result = identifyKeyMoments(anns);
    expect(result[0].isKeyMoment).toBe(true);
  });

  it('respects maxKeyMoments limit', () => {
    // Create 50 blunders
    const anns = Array.from({ length: 50 }, (_, i) =>
      makeAnnotation({ moveNumber: i, classification: 'blunder', scoreDelta: -10 })
    );
    const result = identifyKeyMoments(anns);
    const keyCount = result.filter(a => a.isKeyMoment).length;
    expect(keyCount).toBeLessThanOrEqual(30);
  });

  it('marks large winrate swings as key moments', () => {
    const anns = [
      makeAnnotation({ moveNumber: 10, classification: 'neutral', scoreDelta: 0, winrateDelta: 0 }),
      makeAnnotation({ moveNumber: 11, classification: 'good', scoreDelta: 1.0, winrateDelta: 0.2 }),
    ];
    const result = identifyKeyMoments(anns);
    expect(result[1].isKeyMoment).toBe(true);
  });
});
