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
  // New formula: scoreDelta = evalBefore.scoreLead - evalAfter.scoreLead
  // Positive delta = score dropped (good for mover). Negative = score rose (bad).

  it('computes positive delta when score drops (good move)', () => {
    // before: -10, after: -13 → delta = -10 - (-13) = 3.0 → brilliant
    const before = makeEval({ scoreLead: -10, winrate: 0.5 });
    const after  = makeEval({ scoreLead: -13, winrate: 0.47 });
    const result = classifyMove(before, after);
    expect(result.scoreDelta).toBeCloseTo(3.0, 1);
    expect(result.classification).toBe('brilliant');
  });

  it('computes negative delta when score rises (bad move)', () => {
    // before: -10, after: -2 → delta = -10 - (-2) = -8.0 → blunder
    const before = makeEval({ scoreLead: -10, winrate: 0.5 });
    const after  = makeEval({ scoreLead: -2, winrate: 0.55 });
    const result = classifyMove(before, after);
    expect(result.scoreDelta).toBeCloseTo(-8.0, 1);
    expect(result.classification).toBe('blunder');
  });

  it('classifies near-zero delta as neutral', () => {
    // before: -10, after: -10.3 → delta = 0.3 → neutral
    const before = makeEval({ scoreLead: -10, winrate: 0.5 });
    const after  = makeEval({ scoreLead: -10.3, winrate: 0.49 });
    const result = classifyMove(before, after);
    expect(result.scoreDelta).toBeCloseTo(0.3, 1);
    expect(result.classification).toBe('neutral');
  });

  it('classifies a mistake (moderate loss)', () => {
    // before: -10, after: -7 → delta = -10 - (-7) = -3.0 → mistake
    const before = makeEval({ scoreLead: -10 });
    const after  = makeEval({ scoreLead: -7 });
    const result = classifyMove(before, after);
    expect(result.scoreDelta).toBeCloseTo(-3.0, 1);
    expect(result.classification).toBe('mistake');
  });

  it('classifies an inaccuracy (small loss)', () => {
    // before: -10, after: -8.5 → delta = -10 - (-8.5) = -1.5 → inaccuracy
    const before = makeEval({ scoreLead: -10 });
    const after  = makeEval({ scoreLead: -8.5 });
    const result = classifyMove(before, after);
    expect(result.scoreDelta).toBeCloseTo(-1.5, 1);
    expect(result.classification).toBe('inaccuracy');
  });

  it('classifies a good move', () => {
    // before: -10, after: -11 → delta = -10 - (-11) = 1.0 → good
    const before = makeEval({ scoreLead: -10 });
    const after  = makeEval({ scoreLead: -11 });
    const result = classifyMove(before, after);
    expect(result.scoreDelta).toBeCloseTo(1.0, 1);
    expect(result.classification).toBe('good');
  });

  it('computes winrate delta correctly', () => {
    // winrateDelta = before.winrate - after.winrate
    const before = makeEval({ scoreLead: 0, winrate: 0.5 });
    const after  = makeEval({ scoreLead: 0, winrate: 0.4 });
    const result = classifyMove(before, after);
    expect(result.winrateDelta).toBeCloseTo(0.1, 2);
  });
});

// ---------------------------------------------------------------------------
// detectMistakeType
// ---------------------------------------------------------------------------

describe('detectMistakeType', () => {
  // New signature: detectMistakeType(actualMove, engineTopMove, classification, scoreDelta, moverWinrate)

  it('returns undefined for non-mistakes', () => {
    const result = detectMistakeType('D4', 'D4', 'good', 1.0, 0.5);
    expect(result).toBeUndefined();
  });

  it('detects direction error (different board region)', () => {
    // Played in top-left, engine wanted bottom-right → direction
    const result = detectMistakeType('C17', 'R3', 'mistake', -3.0, 0.5);
    expect(result).toBe('direction');
  });

  it('detects timing error (large distance between moves)', () => {
    // Both A19 and A10 are in the top-left region but far apart (distance=9 > 8)
    const result = detectMistakeType('A19', 'A10', 'mistake', -3.0, 0.5);
    expect(result).toBe('timing');
  });

  it('detects shape error (close moves, same region)', () => {
    // Played D4, engine wanted E5 — very close, same region → shape
    const result = detectMistakeType('D4', 'E5', 'mistake', -2.7, 0.5);
    expect(result).toBe('shape');
  });

  it('detects overplay (losing side plays aggressively)', () => {
    // Mover was behind (winrate 0.3), blunders further
    const result = detectMistakeType('D4', 'E5', 'blunder', -7.0, 0.3);
    expect(result).toBe('overplay');
  });

  it('detects passivity (winning side loses advantage)', () => {
    // Mover was ahead (winrate 0.75) and lost ground → passivity
    const result = detectMistakeType('D4', 'E5', 'mistake', -4.0, 0.75);
    expect(result).toBe('passivity');
  });

  it('defaults to reading for ambiguous mistakes', () => {
    // D4 and H4 are both bottom-left region, distance=4 (not shape ≤3, not timing >8)
    const result = detectMistakeType('D4', 'H4', 'blunder', -6.0, 0.55);
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
    // New formula: winrateDelta = before - after = 0.4 - 0.8 = -0.4, |delta| > 0.1
    const before = makeEval({ winrate: 0.4 });
    const after  = makeEval({ winrate: 0.8 });
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
    // New formula: delta = before - after. Small |delta| + late game → endgame technique
    const before = makeEval({ scoreLead: -20.0, turnNumber: 200 });
    const after  = makeEval({ scoreLead: -20.5 }); // delta = -20.0 - (-20.5) = 0.5
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

  it('marks blunders as key moments with big_mistake reason', () => {
    const anns = [
      makeAnnotation({ moveNumber: 1, classification: 'neutral', scoreDelta: 0 }),
      makeAnnotation({ moveNumber: 50, classification: 'blunder', scoreDelta: -8.0 }),
      makeAnnotation({ moveNumber: 100, classification: 'neutral', scoreDelta: 0.1 }),
    ];
    const result = identifyKeyMoments(anns);
    expect(result[1].isKeyMoment).toBe(true);
    expect(result[1].keyMomentReason).toBe('big_mistake');
  });

  it('marks game phase transitions as key moments', () => {
    const anns = [
      makeAnnotation({ moveNumber: 55, gamePhase: 'opening', classification: 'neutral', scoreDelta: 0 }),
      makeAnnotation({ moveNumber: 56, gamePhase: 'middlegame', classification: 'neutral', scoreDelta: 0 }),
    ];
    const result = identifyKeyMoments(anns);
    expect(result[1].isKeyMoment).toBe(true);
    expect(result[1].keyMomentReason).toBe('phase_transition');
  });

  it('marks brilliant moves as key moments', () => {
    const anns = [
      makeAnnotation({ moveNumber: 80, classification: 'brilliant', scoreDelta: 4.0 }),
    ];
    const result = identifyKeyMoments(anns);
    expect(result[0].isKeyMoment).toBe(true);
    expect(result[0].keyMomentReason).toBe('brilliant_play');
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

  // --- Game trajectory tests (with positions) ---

  it('detects lead change when winrate crosses 0.5', () => {
    const anns = [
      makeAnnotation({ moveNumber: 1, classification: 'neutral', scoreDelta: 0 }),
      makeAnnotation({ moveNumber: 2, classification: 'inaccuracy', scoreDelta: -1.5 }),
    ];
    // positions[0] = before move 1, positions[1] = after move 1 / before move 2, positions[2] = after move 2
    const positions = [
      makeEval({ winrate: 0.55 }),  // Black ahead
      makeEval({ winrate: 0.52 }),  // Still Black
      makeEval({ winrate: 0.45 }),  // Now White ahead — lead change on move 2
    ];
    const result = identifyKeyMoments(anns, positions);
    expect(result[1].isKeyMoment).toBe(true);
    expect(result[1].keyMomentReason).toBe('lead_change');
  });

  it('detects decisive blow when game goes from competitive to decided', () => {
    const anns = [
      makeAnnotation({ moveNumber: 1, classification: 'brilliant', scoreDelta: 3.0 }),
    ];
    const positions = [
      makeEval({ winrate: 0.60 }),  // Competitive (within 0.30-0.70)
      makeEval({ winrate: 0.78 }),  // Decided (> 0.70)
    ];
    const result = identifyKeyMoments(anns, positions);
    expect(result[0].isKeyMoment).toBe(true);
    expect(result[0].keyMomentReason).toBe('decisive_blow');
  });

  it('detects missed opportunity when engine move would have been decisive', () => {
    const anns = [
      makeAnnotation({ moveNumber: 1, classification: 'inaccuracy', scoreDelta: -1.5 }),
    ];
    // Engine's top move would push to 0.75 (decisive), but played move stays at 0.58 (competitive)
    const positions = [
      makeEval({
        winrate: 0.60,
        moveInfos: [
          { move: 'D4', visits: 80, winrate: 0.75, scoreLead: 8.0, prior: 0.4, pv: ['D4'] },
          { move: 'Q16', visits: 20, winrate: 0.58, scoreLead: 2.0, prior: 0.2, pv: ['Q16'] },
        ],
      }),
      makeEval({ winrate: 0.58 }),
    ];
    const result = identifyKeyMoments(anns, positions);
    expect(result[0].isKeyMoment).toBe(true);
    expect(result[0].keyMomentReason).toBe('missed_opportunity');
  });

  it('gives closeness boost to moments in competitive positions', () => {
    // Two identical blunders, but one in a close game, one in a decided game
    const anns = [
      makeAnnotation({ moveNumber: 1, classification: 'mistake', scoreDelta: -3.5 }),
      makeAnnotation({ moveNumber: 2, classification: 'mistake', scoreDelta: -3.5 }),
    ];
    const positions = [
      makeEval({ winrate: 0.50 }),  // Very close — move 1 gets closeness boost
      makeEval({ winrate: 0.48 }),
      makeEval({ winrate: 0.85 }),  // Already decided — move 2 gets no boost
    ];
    const result = identifyKeyMoments(anns, positions);
    // Both should be key moments but move 1 should have higher priority
    expect(result[0].isKeyMoment).toBe(true);
    expect(result[1].isKeyMoment).toBe(true);
  });

  it('works without positions (backward compatibility)', () => {
    const anns = [
      makeAnnotation({ moveNumber: 50, classification: 'blunder', scoreDelta: -8.0 }),
    ];
    const result = identifyKeyMoments(anns);
    expect(result[0].isKeyMoment).toBe(true);
    expect(result[0].keyMomentReason).toBe('big_mistake');
  });

  it('lead_change takes priority over classification-based reasons', () => {
    // A blunder that also causes a lead change should be labeled as lead_change
    const anns = [
      makeAnnotation({ moveNumber: 1, classification: 'blunder', scoreDelta: -8.0 }),
    ];
    const positions = [
      makeEval({ winrate: 0.55 }),  // Black ahead
      makeEval({ winrate: 0.40 }),  // White ahead — lead change
    ];
    const result = identifyKeyMoments(anns, positions);
    expect(result[0].isKeyMoment).toBe(true);
    expect(result[0].keyMomentReason).toBe('lead_change');
  });
});
