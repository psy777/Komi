import type {
  SemanticAnnotation,
  MistakeExplanation,
  PlayerLevel,
  FullGameAnalysis,
  TutoringExplanation,
} from './types';
import { generateKeyMomentCommentary } from './geminiService';
import { generateTutoringExplanation, clearTutoringCache } from './tutoringPipeline';

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
 * Generate a rich, structured tutoring explanation using the Phase B pipeline.
 *
 * Requires the full game analysis context for richer prompts.
 * Falls back to the simple generateExplanation path if analysis is unavailable.
 */
export async function generateRichExplanation(
  annotation: SemanticAnnotation,
  playerLevel: PlayerLevel,
  analysis?: FullGameAnalysis,
  userQuestion?: string,
): Promise<TutoringExplanation> {
  if (!analysis) {
    // Fallback: use legacy path and wrap in TutoringExplanation shape
    const text = await generateExplanation(annotation, playerLevel);
    return {
      moveNumber: annotation.moveNumber,
      playerLevel,
      headline: `Move ${annotation.moveNumber}: ${annotation.classification}`,
      explanation: text,
      whatWasPlayed: '',
    };
  }

  return generateTutoringExplanation(
    annotation.moveNumber,
    analysis,
    playerLevel,
    userQuestion,
  );
}

/**
 * Clear all explanation caches (call when loading a new game or re-analyzing).
 */
export function clearExplanationCache(): void {
  explanationCache.clear();
  clearTutoringCache();
}
