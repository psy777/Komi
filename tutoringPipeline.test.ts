import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildTutoringContext, clearTutoringCache, generateTutoringExplanation } from './tutoringPipeline';
import type {
  FullGameAnalysis,
  KataGoAnalysis,
  SemanticAnnotation,
  TutoringContext,
} from './types';

// ---------------------------------------------------------------------------
// Mock geminiProxy so tests don't hit the network
// ---------------------------------------------------------------------------

vi.mock('./geminiProxy', () => ({
  geminiGenerate: vi.fn().mockResolvedValue(JSON.stringify({
    headline: 'Black missed a vital cutting point',
    explanation: 'The attachment at D10 was locally reasonable but ignored the bigger picture.',
    whatWasPlayed: 'Black played D10, an attachment on the white stone.',
    whatWasBetter: 'The engine recommends Q5, securing the corner while threatening to cut.',
    concept: 'direction of play',
    followUpHint: 'What happens if Black plays Q5 instead?',
  })),
}));

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeEval(scoreLead: number, winrate: number, turnNumber: number, topMove: string): KataGoAnalysis {
  return {
    moveInfos: [
      { move: topMove, visits: 1000, winrate, scoreLead, prior: 0.5, pv: [topMove, 'D4'] },
      { move: 'E5', visits: 500, winrate: winrate - 0.05, scoreLead: scoreLead - 1, prior: 0.3, pv: ['E5'] },
    ],
    rootInfo: { winrate, scoreLead, visits: 1500 },
    ownership: null,
    turnNumber,
    currentPlayer: turnNumber % 2 === 0 ? 'B' as any : 'W' as any,
  };
}

function makeAnnotation(
  moveNumber: number,
  classification: SemanticAnnotation['classification'],
  overrides?: Partial<SemanticAnnotation>,
): SemanticAnnotation {
  return {
    moveNumber,
    classification,
    scoreDelta: classification === 'blunder' ? -8.0 : classification === 'brilliant' ? 3.0 : -0.2,
    winrateDelta: classification === 'blunder' ? -0.2 : classification === 'brilliant' ? 0.15 : -0.01,
    gamePhase: 'middlegame',
    themes: ['momentum_shift'],
    engineTopMove: 'Q5',
    enginePV: ['Q5', 'R4', 'Q3'],
    isKeyMoment: true,
    ...overrides,
  };
}

function makeAnalysis(annotations: SemanticAnnotation[]): FullGameAnalysis {
  // positions array must cover indices 0..maxMoveNumber so that
  // positions[moveNumber-1] (eval before) and positions[moveNumber] (eval after) exist.
  const maxMove = Math.max(...annotations.map(a => a.moveNumber), 0);
  const positions: KataGoAnalysis[] = [];
  for (let i = 0; i <= maxMove; i++) {
    positions.push(makeEval(5.0 - i * 0.1, 0.55, i, 'Q5'));
  }

  return {
    sgfHash: 'test-hash',
    playerLevel: 'intermediate',
    positions,
    annotations,
    keyMoments: annotations.filter(a => a.isKeyMoment),
    summary: {
      totalMoves: maxMove,
      classificationCounts: { brilliant: 0, good: 0, neutral: 0, inaccuracy: 0, mistake: 0, blunder: 0 },
      phaseBreakdown: { opening: 0, middlegame: maxMove, endgame: 0 },
      themes: ['momentum_shift'],
    },
    analyzedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildTutoringContext', () => {
  const blunderAnn = makeAnnotation(10, 'blunder', {
    mistakeType: 'direction',
    pattern: { name: "Tiger's Mouth", category: 'shape' },
  });
  const brilliantAnn = makeAnnotation(20, 'brilliant', { themes: ['sente', 'influence'] });
  const neutralAnn = makeAnnotation(15, 'neutral');
  const analysis = makeAnalysis([blunderAnn, neutralAnn, brilliantAnn]);

  it('returns null for a move not in annotations', () => {
    expect(buildTutoringContext(999, analysis)).toBeNull();
  });

  it('assembles context for a blunder with pattern info', () => {
    const ctx = buildTutoringContext(10, analysis);
    expect(ctx).not.toBeNull();
    expect(ctx!.annotation.classification).toBe('blunder');
    expect(ctx!.annotation.mistakeType).toBe('direction');
    expect(ctx!.pattern?.name).toBe("Tiger's Mouth");
    expect(ctx!.playerLevel).toBe('intermediate');
    expect(ctx!.engineAlternatives.length).toBeGreaterThan(0);
  });

  it('uses overridden player level when provided', () => {
    const ctx = buildTutoringContext(10, analysis, 'beginner');
    expect(ctx!.playerLevel).toBe('beginner');
  });

  it('includes engine alternatives from the position before the move', () => {
    const ctx = buildTutoringContext(10, analysis);
    // Position index 9 (moveNumber - 1) should provide alternatives
    expect(ctx!.engineAlternatives).toHaveLength(2);
    expect(ctx!.engineAlternatives[0].move).toBe('Q5');
  });

  it('includes surrounding key moments', () => {
    const ctx = buildTutoringContext(15, analysis);
    expect(ctx!.surroundingMoments).toBeDefined();
    // Move 10 (blunder) should be the previous key moment
    expect(ctx!.surroundingMoments?.previous?.moveNumber).toBe(10);
    // Move 20 (brilliant) should be the next key moment
    expect(ctx!.surroundingMoments?.next?.moveNumber).toBe(20);
  });

  it('includes game context with score and winrate', () => {
    const ctx = buildTutoringContext(10, analysis);
    expect(ctx!.gameContext.totalMoves).toBe(20);
    expect(typeof ctx!.gameContext.currentScore).toBe('number');
    expect(typeof ctx!.gameContext.currentWinrate).toBe('number');
  });
});

describe('generateTutoringExplanation', () => {
  const ann = makeAnnotation(5, 'mistake', { mistakeType: 'shape' });
  const analysis = makeAnalysis([ann]);

  beforeEach(() => {
    clearTutoringCache();
  });

  it('returns a structured TutoringExplanation', async () => {
    const result = await generateTutoringExplanation(5, analysis);
    expect(result.moveNumber).toBe(5);
    expect(result.playerLevel).toBe('intermediate');
    expect(result.headline).toBe('Black missed a vital cutting point');
    expect(result.explanation).toContain('attachment');
    expect(result.whatWasBetter).toContain('Q5');
    expect(result.concept).toBe('direction of play');
    expect(result.followUpHint).toBeTruthy();
  });

  it('caches results for repeated calls without user question', async () => {
    const { geminiGenerate } = await import('./geminiProxy');
    const mockFn = geminiGenerate as ReturnType<typeof vi.fn>;
    mockFn.mockClear();

    await generateTutoringExplanation(5, analysis);
    await generateTutoringExplanation(5, analysis);

    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('does not cache when a user question is provided', async () => {
    const { geminiGenerate } = await import('./geminiProxy');
    const mockFn = geminiGenerate as ReturnType<typeof vi.fn>;
    mockFn.mockClear();

    await generateTutoringExplanation(5, analysis, undefined, 'Why not D10?');
    await generateTutoringExplanation(5, analysis, undefined, 'What about E5?');

    expect(mockFn).toHaveBeenCalledTimes(2);
  });

  it('returns fallback for a move with no annotation', async () => {
    const result = await generateTutoringExplanation(999, analysis);
    expect(result.headline).toBe('No analysis data');
    expect(result.explanation).toContain('999');
  });

  it('handles Gemini returning malformed JSON gracefully', async () => {
    const { geminiGenerate } = await import('./geminiProxy');
    const mockFn = geminiGenerate as ReturnType<typeof vi.fn>;
    mockFn.mockResolvedValueOnce('This is just plain text, not JSON');

    clearTutoringCache();
    const result = await generateTutoringExplanation(5, analysis);
    expect(result.headline).toBe('Analysis');
    expect(result.explanation).toBe('This is just plain text, not JSON');
  });

  it('handles Gemini error gracefully', async () => {
    const { geminiGenerate } = await import('./geminiProxy');
    const mockFn = geminiGenerate as ReturnType<typeof vi.fn>;
    mockFn.mockRejectedValueOnce(new Error('API rate limit'));

    clearTutoringCache();
    const result = await generateTutoringExplanation(5, analysis);
    expect(result.headline).toBe('Error');
    expect(result.explanation).toContain('Failed');
  });
});
