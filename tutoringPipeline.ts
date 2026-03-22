/**
 * Tutoring Prompt Pipeline (Phase B)
 *
 * Combines KataGo evaluation data, boardmatcher pattern info, and semantic
 * annotations into rich Gemini prompts that produce tutoring-quality
 * natural-language explanations adapted to the student's level.
 *
 * Key design decisions:
 *  - Structured JSON output from Gemini, parsed into TutoringExplanation
 *  - Context builder assembles all available data before prompt composition
 *  - Prompt templates vary by move classification (mistake vs brilliant vs neutral)
 *  - Session-level cache keyed on (moveNumber, playerLevel) avoids redundant calls
 */

import type {
  SemanticAnnotation,
  TutoringExplanation,
  TutoringContext,
  FullGameAnalysis,
  KataGoAnalysis,
  PlayerLevel,
  MoveClassification,
  PatternInfo,
  VariationExploration,
} from './types';
import { LEVEL_INSTRUCTION_SETS } from './geminiService';
import { geminiGenerate } from './geminiProxy';

// ---------------------------------------------------------------------------
// Session cache: "moveNumber:playerLevel" -> TutoringExplanation
// ---------------------------------------------------------------------------

const tutoringCache = new Map<string, TutoringExplanation>();

function cacheKey(moveNumber: number, level: PlayerLevel): string {
  return `${moveNumber}:${level}`;
}

export function clearTutoringCache(): void {
  tutoringCache.clear();
}

// ---------------------------------------------------------------------------
// 1. Context Builder
// ---------------------------------------------------------------------------

/**
 * Assemble all available context for a single move into a TutoringContext.
 *
 * Pulls annotation data, engine alternatives, pattern info, and surrounding
 * key moments from the full game analysis. This is the single source of truth
 * the prompt composer uses — no prompt template should reach into raw data.
 */
export function buildTutoringContext(
  moveNumber: number,
  analysis: FullGameAnalysis,
  playerLevel?: PlayerLevel,
): TutoringContext | null {
  const annotation = analysis.annotations.find(a => a.moveNumber === moveNumber);
  if (!annotation) return null;

  const level = playerLevel ?? analysis.playerLevel;

  // Engine position data: position at moveNumber index gives eval AFTER that move;
  // position at moveNumber-1 gives eval BEFORE the move (the one with alternatives).
  const evalBefore: KataGoAnalysis | undefined = analysis.positions[moveNumber - 1];
  const evalAfter: KataGoAnalysis | undefined = analysis.positions[moveNumber];

  const engineAlternatives = evalBefore
    ? evalBefore.moveInfos.slice(0, 5).map(m => ({
        move: m.move,
        scoreLead: m.scoreLead,
        winrate: m.winrate,
      }))
    : [];

  const currentScore = evalAfter?.rootInfo.scoreLead ?? 0;
  const currentWinrate = evalAfter?.rootInfo.winrate ?? 0.5;

  // Find surrounding key moments for narrative context
  const keyMoments = analysis.keyMoments;
  const thisIdx = keyMoments.findIndex(k => k.moveNumber === moveNumber);
  const surroundingMoments = {
    previous: thisIdx > 0
      ? { moveNumber: keyMoments[thisIdx - 1].moveNumber, classification: keyMoments[thisIdx - 1].classification }
      : annotation.moveNumber > 1
        ? findNearestKeyMoment(keyMoments, moveNumber, 'before')
        : undefined,
    next: thisIdx >= 0 && thisIdx < keyMoments.length - 1
      ? { moveNumber: keyMoments[thisIdx + 1].moveNumber, classification: keyMoments[thisIdx + 1].classification }
      : findNearestKeyMoment(keyMoments, moveNumber, 'after'),
  };

  // Deep analysis for this position (Phase D)
  const deepAnalysis = analysis.deepAnalysis?.explorations.get(moveNumber);

  return {
    annotation,
    playerLevel: level,
    gameContext: {
      totalMoves: analysis.summary.totalMoves,
      komi: 6.5, // TODO: extract from SGF when available on FullGameAnalysis
      currentScore,
      currentWinrate,
    },
    pattern: annotation.pattern,
    engineAlternatives,
    surroundingMoments: (surroundingMoments.previous || surroundingMoments.next)
      ? surroundingMoments
      : undefined,
    deepAnalysis,
  };
}

function findNearestKeyMoment(
  keyMoments: SemanticAnnotation[],
  moveNumber: number,
  direction: 'before' | 'after',
): { moveNumber: number; classification: MoveClassification } | undefined {
  if (direction === 'before') {
    for (let i = keyMoments.length - 1; i >= 0; i--) {
      if (keyMoments[i].moveNumber < moveNumber) {
        return { moveNumber: keyMoments[i].moveNumber, classification: keyMoments[i].classification };
      }
    }
  } else {
    for (const km of keyMoments) {
      if (km.moveNumber > moveNumber) {
        return { moveNumber: km.moveNumber, classification: km.classification };
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 2. Prompt Templates
// ---------------------------------------------------------------------------

const STRUCTURED_OUTPUT_SCHEMA = `
Respond ONLY with valid JSON matching this schema (no markdown fences, no extra text):
{
  "headline": "One-line summary of the move's significance",
  "explanation": "2-4 paragraph explanation adapted to the student level",
  "whatWasPlayed": "Description of the actual move and its immediate intent",
  "whatWasBetter": "Description of engine recommendation and why (omit key if move was good/brilliant)",
  "concept": "Go concept being taught (e.g. 'shape', 'direction of play', 'timing')",
  "followUpHint": "A question to prompt deeper exploration"
}`;

/**
 * Format deep analysis variation data into a prompt context block.
 * Only included when deep analysis explored this position.
 */
function buildDeepAnalysisBlock(deep?: VariationExploration): string {
  if (!deep || deep.variations.length === 0) return '';

  const reasonLabel = {
    close_candidates: 'Multiple candidate moves are very close in evaluation',
    complex_fighting: 'Complex fighting makes this position hard to read',
    critical_moment: 'This was a critical moment where the choice of move matters greatly',
  }[deep.reason];

  const lines = deep.variations.map(v => {
    let line = `  - ${v.move}: score ${v.scoreLead > 0 ? '+' : ''}${v.scoreLead.toFixed(1)}, win ${(v.winrate * 100).toFixed(0)}%`;
    if (v.bestResponse) {
      line += ` → opponent responds ${v.bestResponse}`;
      if (v.scoreAfterResponse != null) {
        line += ` (score then ${v.scoreAfterResponse > 0 ? '+' : ''}${v.scoreAfterResponse.toFixed(1)})`;
      }
    }
    return line;
  });

  return `
DEEPER ANALYSIS (variations explored):
- Reason: ${reasonLabel}
- Ambiguity gap: ${deep.ambiguityGap.toFixed(1)} pts between top candidates
- Best variation: ${deep.bestVariation}
- Variation spread: ${deep.variationSpread.toFixed(1)} pts
${lines.join('\n')}

IMPORTANT: Use this variation analysis to explain the CONCRETE CONSEQUENCES of each candidate.
Explain what happens after each move, not just the numeric difference.`;
}

function buildMistakePrompt(ctx: TutoringContext): string {
  const { annotation: ann, playerLevel } = ctx;
  const levelInstr = LEVEL_INSTRUCTION_SETS[playerLevel];
  const patternBlock = ctx.pattern
    ? `\nPATTERN DETECTED: ${ctx.pattern.name} (${ctx.pattern.category})`
    : '';
  const alternativesBlock = ctx.engineAlternatives.length > 0
    ? ctx.engineAlternatives.map(a =>
        `  - ${a.move} (score: ${a.scoreLead > 0 ? '+' : ''}${a.scoreLead.toFixed(1)}, win: ${(a.winrate * 100).toFixed(0)}%)`
      ).join('\n')
    : '  (no alternatives available)';

  const deepBlock = buildDeepAnalysisBlock(ctx.deepAnalysis);

  return `You are an expert Go (Baduk/Weiqi) tutor explaining a ${ann.classification} to a student.

${levelInstr}

MOVE CONTEXT:
- Move ${ann.moveNumber} in a ${ctx.gameContext.totalMoves}-move game
- Game Phase: ${ann.gamePhase}
- Classification: ${ann.classification.toUpperCase()}${ann.mistakeType ? ` (${ann.mistakeType})` : ''}
- Score Delta: ${ann.scoreDelta > 0 ? '+' : ''}${ann.scoreDelta.toFixed(1)} points
- Winrate Delta: ${ann.winrateDelta > 0 ? '+' : ''}${(ann.winrateDelta * 100).toFixed(1)}%
- Engine Top Move: ${ann.engineTopMove}
- Principal Variation: ${ann.enginePV.slice(0, 6).join(' ') || '(unavailable)'}${patternBlock}
- Themes: ${ann.themes.length > 0 ? ann.themes.join(', ') : 'none detected'}

ENGINE ALTERNATIVES:
${alternativesBlock}

CURRENT POSITION:
- Score: ${ctx.gameContext.currentScore > 0 ? 'Black' : 'White'} leads by ${Math.abs(ctx.gameContext.currentScore).toFixed(1)}
- Win Probability: Black ${(ctx.gameContext.currentWinrate * 100).toFixed(0)}%
${deepBlock}
INSTRUCTIONS:
- Explain the NATURE of the error — not just that it was bad, but WHY it was bad.
- ${ann.mistakeType === 'direction' ? 'Focus on whole-board thinking. The player chose the wrong area of the board.' : ''}
- ${ann.mistakeType === 'shape' ? 'Focus on local shape. The player made an inefficient or bad shape.' : ''}
- ${ann.mistakeType === 'timing' ? 'Focus on timing/urgency. The player played in the wrong area at the wrong time.' : ''}
- ${ann.mistakeType === 'reading' ? 'Focus on tactical reading. The player missed a sequence.' : ''}
- ${ann.mistakeType === 'overplay' ? 'The player tried too hard from a losing position.' : ''}
- ${ann.mistakeType === 'passivity' ? 'The player was too conservative when they had the advantage.' : ''}
- Compare the played move to the engine recommendation with specific reasoning.${ctx.deepAnalysis ? '\n- USE the variation analysis above to explain concrete consequences of each candidate move.' : ''}
- Suggest a concept the student should study.

${STRUCTURED_OUTPUT_SCHEMA}`;
}

function buildBrilliantPrompt(ctx: TutoringContext): string {
  const { annotation: ann, playerLevel } = ctx;
  const levelInstr = LEVEL_INSTRUCTION_SETS[playerLevel];
  const patternBlock = ctx.pattern
    ? `\nPATTERN: ${ctx.pattern.name} (${ctx.pattern.category})`
    : '';
  const deepBlock = buildDeepAnalysisBlock(ctx.deepAnalysis);

  return `You are an expert Go (Baduk/Weiqi) tutor praising a brilliant move.

${levelInstr}

MOVE CONTEXT:
- Move ${ann.moveNumber}: classified as ${ann.classification.toUpperCase()}
- Game Phase: ${ann.gamePhase}
- Score Delta: +${ann.scoreDelta.toFixed(1)} points gained
- Winrate Delta: +${(ann.winrateDelta * 100).toFixed(1)}%
- Engine Top Move: ${ann.engineTopMove}${patternBlock}
- Themes: ${ann.themes.length > 0 ? ann.themes.join(', ') : 'none detected'}
${deepBlock}
INSTRUCTIONS:
- Explain what made this move strong — the strategic or tactical insight behind it.
- Connect it to a broader Go concept the student can learn from.
- If a pattern was detected, explain its significance.${ctx.deepAnalysis ? '\n- USE the variation data to show WHY this move was better than the alternatives.' : ''}
- Do NOT include "whatWasBetter" in your response — the move was already excellent.

${STRUCTURED_OUTPUT_SCHEMA}`;
}

function buildNeutralPrompt(ctx: TutoringContext): string {
  const { annotation: ann, playerLevel } = ctx;
  const levelInstr = LEVEL_INSTRUCTION_SETS[playerLevel];
  const patternBlock = ctx.pattern
    ? `\nPATTERN: ${ctx.pattern.name} (${ctx.pattern.category})`
    : '';
  const deepBlock = buildDeepAnalysisBlock(ctx.deepAnalysis);

  return `You are an expert Go (Baduk/Weiqi) tutor explaining a key moment in a game.

${levelInstr}

MOVE CONTEXT:
- Move ${ann.moveNumber}: classified as ${ann.classification.toUpperCase()}
- Game Phase: ${ann.gamePhase}
- Score Delta: ${ann.scoreDelta > 0 ? '+' : ''}${ann.scoreDelta.toFixed(1)} points
- Winrate Delta: ${ann.winrateDelta > 0 ? '+' : ''}${(ann.winrateDelta * 100).toFixed(1)}%
- Engine Top Move: ${ann.engineTopMove}
- Themes: ${ann.themes.length > 0 ? ann.themes.join(', ') : 'none detected'}${patternBlock}
${deepBlock}
INSTRUCTIONS:
- Explain why this moment is significant for the student's learning.
- Focus on the strategic situation — what is the game about at this point?${ctx.deepAnalysis ? '\n- USE the variation analysis to illustrate how different choices lead to different outcomes.' : ''}
- If this is a game phase transition, explain how the priorities shift.
- If the move was slightly off, mention the engine alternative briefly.

${STRUCTURED_OUTPUT_SCHEMA}`;
}

/**
 * Select the appropriate prompt template based on move classification.
 */
function selectPrompt(ctx: TutoringContext): string {
  const cls = ctx.annotation.classification;
  if (cls === 'blunder' || cls === 'mistake' || cls === 'inaccuracy') {
    return buildMistakePrompt(ctx);
  }
  if (cls === 'brilliant') {
    return buildBrilliantPrompt(ctx);
  }
  return buildNeutralPrompt(ctx);
}

// ---------------------------------------------------------------------------
// 3. Gemini Call + Structured Output Parsing
// ---------------------------------------------------------------------------

/**
 * Parse Gemini's JSON response into a TutoringExplanation.
 * Falls back gracefully if the model returns malformed JSON.
 */
function parseResponse(
  raw: string,
  moveNumber: number,
  playerLevel: PlayerLevel,
): TutoringExplanation {
  // Strip markdown fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }

  try {
    const parsed = JSON.parse(cleaned);
    return {
      moveNumber,
      playerLevel,
      headline: parsed.headline || 'Analysis',
      explanation: parsed.explanation || raw,
      whatWasPlayed: parsed.whatWasPlayed || '',
      whatWasBetter: parsed.whatWasBetter || undefined,
      concept: parsed.concept || undefined,
      followUpHint: parsed.followUpHint || undefined,
    };
  } catch {
    // Fallback: treat entire response as explanation text
    return {
      moveNumber,
      playerLevel,
      headline: 'Analysis',
      explanation: raw,
      whatWasPlayed: '',
    };
  }
}

// ---------------------------------------------------------------------------
// 4. Public API
// ---------------------------------------------------------------------------

/**
 * Generate a structured tutoring explanation for a single move.
 *
 * This is the main entry point for Phase C's UI. It:
 *  1. Builds context from the full game analysis
 *  2. Selects the right prompt template
 *  3. Calls Gemini for structured output
 *  4. Parses and caches the result
 *
 * @param moveNumber - The move to explain
 * @param analysis - Full game analysis from the orchestrator
 * @param playerLevel - Override level (uses analysis.playerLevel if omitted)
 * @param userQuestion - Optional student question for drill-down
 */
export async function generateTutoringExplanation(
  moveNumber: number,
  analysis: FullGameAnalysis,
  playerLevel?: PlayerLevel,
  userQuestion?: string,
): Promise<TutoringExplanation> {
  const level = playerLevel ?? analysis.playerLevel;
  const key = cacheKey(moveNumber, level);

  // Return cached if no custom question
  if (!userQuestion) {
    const cached = tutoringCache.get(key);
    if (cached) return cached;
  }

  // Build context
  const ctx = buildTutoringContext(moveNumber, analysis, level);
  if (!ctx) {
    return {
      moveNumber,
      playerLevel: level,
      headline: 'No analysis data',
      explanation: `No annotation data available for move ${moveNumber}.`,
      whatWasPlayed: '',
    };
  }

  // Compose prompt
  let prompt = selectPrompt(ctx);

  if (userQuestion) {
    prompt += `\n\nSTUDENT QUESTION: "${userQuestion}"\nAddress this question in your explanation while still following the structured output format.`;
  }

  // Call Gemini
  try {
    const raw = await geminiGenerate(
      'gemini-3-flash-preview',
      [{ role: 'user', parts: [{ text: prompt }] }],
      { temperature: 0.3, maxOutputTokens: 1024 },
    );

    const result = parseResponse(raw, moveNumber, level);

    // Cache only non-question results
    if (!userQuestion) {
      tutoringCache.set(key, result);
    }

    return result;
  } catch (error) {
    console.error(`Tutoring pipeline error for move ${moveNumber}:`, error);
    return {
      moveNumber,
      playerLevel: level,
      headline: 'Error',
      explanation: `Failed to generate explanation for move ${moveNumber}. Please try again.`,
      whatWasPlayed: '',
    };
  }
}

/**
 * Batch-generate tutoring explanations for all key moments.
 *
 * Processes key moments sequentially to respect rate limits.
 * Reports progress via callback.
 */
export async function generateKeyMomentExplanations(
  analysis: FullGameAnalysis,
  playerLevel?: PlayerLevel,
  onProgress?: (completed: number, total: number) => void,
): Promise<TutoringExplanation[]> {
  const moments = analysis.keyMoments;
  const results: TutoringExplanation[] = [];

  for (let i = 0; i < moments.length; i++) {
    const explanation = await generateTutoringExplanation(
      moments[i].moveNumber,
      analysis,
      playerLevel,
    );
    results.push(explanation);
    onProgress?.(i + 1, moments.length);
  }

  return results;
}
