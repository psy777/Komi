import { describe, it, expect } from 'vitest';
import { parseSGF } from './sgfParser';
import { exportReviewSGF } from './reviewExport';
import { StoneColor } from './types';
import type { FullGameAnalysis, SemanticAnnotation } from './types';

function ann(over: Partial<SemanticAnnotation>): SemanticAnnotation {
  return {
    moveNumber: 1,
    classification: 'neutral',
    scoreDelta: 0,
    winrateDelta: 0,
    gamePhase: 'opening',
    themes: [],
    engineTopMove: '',
    enginePV: [],
    isKeyMoment: false,
    ...over,
  };
}

function analysis(annotations: SemanticAnnotation[]): FullGameAnalysis {
  return {
    sgfHash: 'h',
    playerLevel: 'intermediate',
    positions: [],
    annotations,
    keyMoments: annotations.filter((a) => a.isKeyMoment),
    summary: {
      totalMoves: annotations.length,
      classificationCounts: { brilliant: 0, good: 1, neutral: 0, inaccuracy: 0, mistake: 0, blunder: 1 },
      phaseBreakdown: { opening: 2, middlegame: 0, endgame: 0 },
      themes: [],
    },
    analyzedAt: 0,
  };
}

describe('exportReviewSGF', () => {
  // Game: B Q16 (pd), W D4 (dp). Move 1 = blunder + key moment with engine line
  // and refutation; move 2 = good.
  const tree = parseSGF('(;GM[1]SZ[19];B[pd];W[dp])');
  const a = analysis([
    ann({
      moveNumber: 1,
      color: StoneColor.BLACK,
      classification: 'blunder',
      pointsLost: 8.2,
      scoreDelta: -8.2,
      engineTopMove: 'R16',
      enginePV: ['R16', 'D4'],
      refutationPV: ['D16', 'Q3'],
      isKeyMoment: true,
      mistakeType: 'direction',
      themes: ['momentum_shift'],
      commentary: 'This move loses points [bracket test].',
    }),
    ann({ moveNumber: 2, color: StoneColor.WHITE, classification: 'good', pointsLost: 0.2, scoreDelta: -0.2, engineTopMove: 'D4' }),
  ]);

  const sgf = exportReviewSGF(tree, a);

  it('embeds per-move comments', () => {
    expect(sgf).toContain('C[');
    expect(sgf).toContain('Blunder');
    expect(sgf).toContain('Lost 8.2 pts');
  });

  it('adds move-quality glyph and key-moment hotspot', () => {
    expect(sgf).toContain('BM[1]'); // blunder glyph
    expect(sgf).toContain('HO[1]'); // key moment
  });

  it('includes engine line and refutation as variation branches', () => {
    // Engine best R16 → SGF coord; refutation D16/Q3. Expect variation parens.
    expect(sgf).toContain("Engine's line");
    expect(sgf).toContain('Refutation');
    // At least two '(' beyond the outer wrapper → branches exist
    expect((sgf.match(/\(/g) || []).length).toBeGreaterThan(1);
  });

  it('escapes closing brackets in commentary so the SGF stays valid', () => {
    // SGF only requires escaping ']' and '\' inside a value, not '['.
    expect(sgf).toContain('bracket test\\]');
  });

  it('round-trips: the annotated SGF re-parses without throwing', () => {
    expect(() => parseSGF(sgf)).not.toThrow();
    const reparsed = parseSGF(sgf);
    expect(Object.keys(reparsed.nodes).length).toBeGreaterThan(2);
  });

  it('marks the file as a Komi review', () => {
    expect(sgf).toContain('AP[Komi Review]');
  });
});
