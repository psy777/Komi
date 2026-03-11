import type { SemanticAnnotation, MistakeExplanation, PlayerLevel } from './types';
import { generateKeyMomentCommentary } from './geminiService';

// Session-level cache: moveNumber -> explanation text
const explanationCache = new Map<number, string>();

/**
 * Build a structured comparison for a move annotation.
 * Returns immediately with cached explanation if available.
 */
export function buildComparison(
  annotation: SemanticAnnotation,
  playedMove: string,
): MistakeExplanation {
  return {
    moveNumber: annotation.moveNumber,
    classification: annotation.classification,
    mistakeType: annotation.mistakeType,
    playedMove,
    engineMove: annotation.engineTopMove,
    enginePV: annotation.enginePV,
    scoreDelta: annotation.scoreDelta,
    winrateDelta: annotation.winrateDelta,
    gamePhase: annotation.gamePhase,
    explanation: explanationCache.get(annotation.moveNumber) ?? null,
  };
}

/**
 * Generate a natural-language explanation for a move.
 * Uses Gemini with level-aware prompts via generateKeyMomentCommentary.
 * Results are cached per session to avoid redundant API calls.
 */
export async function generateExplanation(
  annotation: SemanticAnnotation,
  playerLevel: PlayerLevel,
): Promise<string> {
  const cached = explanationCache.get(annotation.moveNumber);
  if (cached) return cached;

  const explanation = await generateKeyMomentCommentary(annotation, playerLevel);
  explanationCache.set(annotation.moveNumber, explanation);
  return explanation;
}

/**
 * Clear the explanation cache (call when loading a new game or re-analyzing).
 */
export function clearExplanationCache(): void {
  explanationCache.clear();
}
