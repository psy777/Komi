// Export a full review as an annotated SGF: per-move comments, move-quality
// glyphs (TE/BM/IT/DO), key-moment hotspots (HO), and the engine line +
// refutation line as replayable variation branches. Reuses generateSGF by
// building an augmented copy of the game tree.

import { generateSGF } from './sgfParser';
import { StoneColor } from './types';
import type {
  GameTree, GameNode, FullGameAnalysis, SemanticAnnotation, MoveClassification,
} from './types';

const GTP_COLS = 'ABCDEFGHJKLMNOPQRST'; // no 'I'

// Map classification → SGF move-annotation glyph that viewers render as a symbol.
const GLYPH: Partial<Record<MoveClassification, string>> = {
  brilliant: 'TE', // tesuji / good move
  good: 'TE',
  inaccuracy: 'IT', // interesting
  mistake: 'BM', // bad move
  blunder: 'BM',
};

const LABEL: Record<MoveClassification, string> = {
  brilliant: 'Brilliant', good: 'Good', neutral: 'Neutral',
  inaccuracy: 'Inaccuracy', mistake: 'Mistake', blunder: 'Blunder',
};

/** Escape a string for use inside an SGF property value. */
function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
}

/** GTP coord ("D16", "pass") → SGF coord ("dd", "" for pass), or null if invalid. */
function gtpToSgf(gtp: string): string | null {
  if (!gtp) return null;
  if (gtp.toLowerCase() === 'pass') return '';
  const col = GTP_COLS.indexOf(gtp[0].toUpperCase());
  const row = parseInt(gtp.slice(1), 10);
  if (col < 0 || Number.isNaN(row)) return null;
  const x = col;
  const y = 19 - row;
  if (x < 0 || x > 18 || y < 0 || y > 18) return null;
  return String.fromCharCode(x + 97) + String.fromCharCode(y + 97);
}

/** A move node's x/y back to GTP, for comparing against engineTopMove. */
function nodeGtp(node: GameNode): string {
  if (!node.move || node.move.x < 0) return '';
  return `${GTP_COLS[node.move.x]}${19 - node.move.y}`;
}

function buildComment(ann: SemanticAnnotation): string {
  const lines: string[] = [];
  lines.push(`${LABEL[ann.classification]}${ann.isKeyMoment ? '  ★ KEY MOMENT' : ''}`);
  const lost = ann.pointsLost ?? Math.max(0, -ann.scoreDelta);
  if (lost > 0.05 && ann.engineTopMove) {
    lines.push(`Lost ${lost.toFixed(1)} pts vs best (${ann.engineTopMove})`);
  }
  if (ann.mistakeType) lines.push(`Error type: ${ann.mistakeType}`);
  if (ann.themes && ann.themes.length) lines.push(`Themes: ${ann.themes.join(', ')}`);
  if (ann.commentary) lines.push('', ann.commentary.trim());
  return lines.join('\n');
}

/**
 * Append a PV line as a chain of new nodes under `parentId`.
 * Returns the id of the first node (caller links it into parent.childrenIds),
 * or null if the PV produced no valid moves.
 */
function buildLine(
  nodes: Record<string, GameNode>,
  parentId: string,
  pv: string[],
  firstColor: StoneColor,
  newId: () => string,
  firstComment: string,
): string | null {
  let firstId: string | null = null;
  let prevId = parentId;
  let color = firstColor;

  for (let i = 0; i < pv.length; i++) {
    const coord = gtpToSgf(pv[i]);
    if (coord === null) break;
    const x = coord ? coord.charCodeAt(0) - 97 : -1;
    const y = coord ? coord.charCodeAt(1) - 97 : -1;
    const id = newId();
    nodes[id] = {
      id,
      parentId: i === 0 ? parentId : prevId,
      childrenIds: [],
      properties: {},
      move: { color, x, y },
      comment: i === 0 ? esc(firstComment) : undefined,
    };
    if (i === 0) firstId = id;
    else nodes[prevId].childrenIds.push(id);
    prevId = id;
    color = color === StoneColor.BLACK ? StoneColor.WHITE : StoneColor.BLACK;
  }
  return firstId;
}

/** Build an annotated copy of the game tree with review data baked in. */
export function buildReviewTree(tree: GameTree, analysis: FullGameAnalysis | null): GameTree {
  // Shallow-clone every node (own copies of mutable fields).
  const nodes: Record<string, GameNode> = {};
  for (const [id, n] of Object.entries(tree.nodes)) {
    nodes[id] = { ...n, properties: { ...n.properties }, childrenIds: [...n.childrenIds] };
  }
  const cloned: GameTree = { nodes, rootId: tree.rootId, currentId: tree.currentId };

  // Mark this as a Komi review.
  nodes[tree.rootId].properties['AP'] = 'Komi Review';
  if (analysis) {
    const c = analysis.summary?.classificationCounts;
    const summary = c
      ? `Komi review — level ${analysis.playerLevel}. ` +
        `Blunders ${c.blunder}, mistakes ${c.mistake}, inaccuracies ${c.inaccuracy}, ` +
        `good ${c.good}, brilliant ${c.brilliant}.`
      : 'Komi review.';
    nodes[tree.rootId].comment = esc(
      (nodes[tree.rootId].comment ? nodes[tree.rootId].comment + '\n\n' : '') + summary,
    );
  }

  if (!analysis) return cloned;

  const annByMove = new Map<number, SemanticAnnotation>();
  for (const a of analysis.annotations) annByMove.set(a.moveNumber, a);

  // Walk the main line; annotate each real move in order.
  let idCounter = 0;
  const newId = () => `rev_${idCounter++}`;
  let moveNum = 0;
  let cur: string | null = tree.rootId;

  while (cur) {
    const node = nodes[cur];
    const next: string | null = node.childrenIds[0] ?? null;

    if (node.move && node.move.x >= 0) {
      moveNum++;
      const ann = annByMove.get(moveNum);
      if (ann) {
        node.comment = esc(buildComment(ann));
        const glyph = GLYPH[ann.classification];
        if (glyph) node.properties[glyph] = '1';
        if (ann.isKeyMoment) node.properties['HO'] = '1';

        // Engine's recommended line — variation off the PARENT (alternative to
        // the move actually played). Only when it differs from the played move.
        if (node.parentId && ann.enginePV && ann.enginePV.length && ann.engineTopMove &&
            ann.engineTopMove !== nodeGtp(node)) {
          const varId = buildLine(
            nodes, node.parentId, ann.enginePV, node.move.color, newId,
            `Engine's line (best: ${ann.engineTopMove})`,
          );
          if (varId) nodes[node.parentId].childrenIds.push(varId); // after main → variation
        }

        // Refutation — how the played move gets punished. Variation off THIS node.
        if (ann.refutationPV && ann.refutationPV.length) {
          const oppColor = node.move.color === StoneColor.BLACK ? StoneColor.WHITE : StoneColor.BLACK;
          const varId = buildLine(
            nodes, node.id, ann.refutationPV, oppColor, newId,
            'Refutation — how this move is punished',
          );
          if (varId) nodes[node.id].childrenIds.push(varId);
        }
      }
    }
    cur = next;
  }

  return cloned;
}

/** Serialize a full review to an annotated SGF string. */
export function exportReviewSGF(tree: GameTree, analysis: FullGameAnalysis | null): string {
  return generateSGF(buildReviewTree(tree, analysis));
}
