/**
 * Deterministic seed commentary for the per-move wiki.
 *
 * When the review queue finishes analyzing a game, each noteworthy move gets
 * one engine-authored revision built from the classification data. These are
 * deliberately dry and factual — the community edits them into real teaching
 * prose, and that corrected corpus later trains the annotation model.
 *
 * Style rules (house voice): state facts, not authority ("this lost about 4
 * points", never "the engine says"); name a stronger alternative without
 * belittling the played move; show the follow-up line so readers can verify
 * on the board; no invented narratives about intent.
 */

import type { FullGameAnalysis, SemanticAnnotation } from './types';

const MISTAKE_PHRASES: Record<string, string> = {
  direction: 'The direction of play is the issue — the bigger area lay elsewhere.',
  shape: 'The shape here leaves weaknesses that better placement avoids.',
  reading: 'This looks like a reading slip — the tactical sequence does not hold up.',
  timing: 'A question of timing: this move is playable, but something else was urgent first.',
  overplay: 'This asks for more than the position supports.',
  passivity: 'This is solid but passive — the position allowed something more active.',
};

function points(n: number): string {
  const abs = Math.abs(n);
  return abs >= 10 ? String(Math.round(abs)) : abs.toFixed(1);
}

function pvLine(pv: string[] | undefined, max = 6): string | null {
  if (!pv || pv.length === 0) return null;
  const shown = pv.slice(0, max).join(' ');
  return pv.length > max ? `${shown} …` : shown;
}

/** Render the seed body for one annotation, or null if the move needs no seed. */
export function seedCommentaryForMove(ann: SemanticAnnotation): string | null {
  const noteworthy =
    ann.isKeyMoment ||
    ann.classification === 'brilliant' ||
    ann.classification === 'inaccuracy' ||
    ann.classification === 'mistake' ||
    ann.classification === 'blunder';
  if (!noteworthy) return null;

  const lines: string[] = [];

  switch (ann.classification) {
    case 'brilliant':
      lines.push(
        `An excellent find — this gains where the obvious moves don't. The main continuation: ${pvLine(ann.enginePV) ?? ann.engineTopMove}.`,
      );
      break;
    case 'good':
    case 'neutral':
      // Key moment that wasn't an error: describe why the position mattered.
      lines.push(
        `A key moment in the game. The position stays on track here; the main line continues ${pvLine(ann.enginePV) ?? ann.engineTopMove}.`,
      );
      break;
    case 'inaccuracy':
      lines.push(
        `A small slip, costing about ${points(ann.pointsLost)} points. ${ann.engineTopMove} was a touch bigger.`,
      );
      break;
    case 'mistake':
    case 'blunder': {
      const cost = `This lost about ${points(ann.pointsLost)} points`;
      const better = ann.engineTopMove ? ` — compare ${ann.engineTopMove}.` : '.';
      lines.push(cost + better);
      if (ann.mistakeType && MISTAKE_PHRASES[ann.mistakeType]) {
        lines.push(MISTAKE_PHRASES[ann.mistakeType]);
      }
      const refutation = pvLine(ann.refutationPV);
      if (refutation) {
        lines.push(`The punishing follow-up to verify on the board: ${refutation}.`);
      }
      break;
    }
  }

  if (ann.pattern?.name) {
    lines.push(`Pattern: ${ann.pattern.name}.`);
  }

  return lines.join(' ');
}

/** Seed bodies for every noteworthy move of a finished analysis. */
export function seedCommentaryForGame(
  analysis: FullGameAnalysis,
): Array<{ moveNumber: number; body: string }> {
  const seeds: Array<{ moveNumber: number; body: string }> = [];
  for (const ann of analysis.annotations) {
    const body = seedCommentaryForMove(ann);
    if (body) seeds.push({ moveNumber: ann.moveNumber, body });
  }
  return seeds;
}
