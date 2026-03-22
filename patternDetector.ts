/**
 * Pattern detection using @sabaki/boardmatcher and @sabaki/influence.
 *
 * Converts Komi's board representation to Sabaki format and identifies
 * joseki patterns, common shapes, and formations for each move.
 */

import { StoneColor } from './types';
import type { BoardState, PatternInfo } from './types';
import { createEmptyGrid, playMove } from './goLogic';

// @ts-ignore — CJS modules without type declarations
import boardmatcher from '@sabaki/boardmatcher';
// @ts-ignore
import influence from '@sabaki/influence';

// Re-export for convenience
export type { PatternInfo } from './types';

type PatternCategory = PatternInfo['category'];

// ---------------------------------------------------------------------------
// Category classification
// ---------------------------------------------------------------------------

const OPENING_PATTERNS = new Set([
  'Low Chinese Opening', 'High Chinese Opening', 'Orthodox Opening',
  'Enclosure Opening', 'Kobayashi Opening', 'Small Chinese Opening',
  'Micro Chinese Opening', 'Sanrensei Opening', 'Nirensei Opening',
  'Shūsaku Opening',
]);

const APPROACH_PATTERNS = new Set([
  'Low Approach', 'High Approach', 'Low Enclosure', 'High Enclosure',
  'Shoulder Hit', '3-3 Point Invasion',
]);

const SHAPE_PATTERNS = new Set([
  'Mouth Shape', 'Table Shape', 'Tippy Table', 'Bamboo Joint',
  'Trapezium', 'Diamond', "Tiger's Mouth", 'Empty Triangle',
  'Turn', 'Stretch', 'Diagonal', 'Square', 'Throwing Star',
  'Parallelogram', "Dog's Head", "Horse's Head", 'Big Bulge',
]);

const PLACEMENT_PATTERNS = new Set([
  '3-4 Point', '4-4 Point', '3-3 Point', '3-5 Point',
  '4-5 Point', '6-3 Point', '6-4 Point', '5-5 Point',
  'Tengen', 'Hoshi',
]);

const CONNECTION_PATTERNS = new Set([
  'Connect', 'Attachment', 'One-Point Jump', 'Small Knight',
  'Two-Point Jump', 'Large Knight', 'Diagonal Jump',
]);

const TACTICAL_PATTERNS = new Set([
  'Wedge', 'Hane', 'Cut', 'Take', 'Atari',
]);

function categorize(name: string): PatternCategory {
  if (OPENING_PATTERNS.has(name)) return 'opening';
  if (APPROACH_PATTERNS.has(name)) return 'approach';
  if (SHAPE_PATTERNS.has(name)) return 'shape';
  if (PLACEMENT_PATTERNS.has(name)) return 'placement';
  if (CONNECTION_PATTERNS.has(name)) return 'connection';
  if (TACTICAL_PATTERNS.has(name)) return 'tactical';
  // Default: if it's a corner-type pattern, call it joseki
  return 'shape';
}

// ---------------------------------------------------------------------------
// Board conversion
// ---------------------------------------------------------------------------

/**
 * Convert Komi's StoneColor[][] grid to Sabaki's number[][] format.
 * Sabaki: 1 = black, -1 = white, 0 = empty.
 */
export function toSabakiBoard(grid: StoneColor[][]): number[][] {
  return grid.map(row =>
    row.map(cell => {
      if (cell === StoneColor.BLACK) return 1;
      if (cell === StoneColor.WHITE) return -1;
      return 0;
    })
  );
}

// ---------------------------------------------------------------------------
// Pattern detection for a single move
// ---------------------------------------------------------------------------

/**
 * Detect the pattern/formation for a move played on the given board.
 *
 * @param gridBeforeMove - Board state BEFORE the move is played
 * @param x - Column (0-based from left)
 * @param y - Row (0-based from top)
 * @param color - Color of the stone being played
 * @returns PatternInfo if a known pattern is detected, null otherwise
 */
export function detectPattern(
  gridBeforeMove: StoneColor[][],
  x: number,
  y: number,
  color: StoneColor,
): PatternInfo | null {
  const sabakiBoard = toSabakiBoard(gridBeforeMove);
  const sign = color === StoneColor.BLACK ? 1 : -1;
  const vertex: [number, number] = [x, y];

  const result = boardmatcher.findPatternInMove(sabakiBoard, sign, vertex);
  if (!result) return null;

  const name: string = result.pattern.name;
  if (!name || name === 'Pass' || name === 'Fill' || name === 'Suicide') {
    return null;
  }

  return {
    name,
    category: categorize(name),
    url: result.pattern.url ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Influence snapshot
// ---------------------------------------------------------------------------

export interface InfluenceSnapshot {
  /** Per-vertex influence values, same shape as the board. Range [-1, 1]. */
  map: number[][];
  /** Discrete area map (-1 = white, 0 = neutral, 1 = black) */
  area: number[][];
}

/**
 * Compute influence and area maps for a board position.
 */
export function computeInfluence(grid: StoneColor[][]): InfluenceSnapshot {
  const sabakiBoard = toSabakiBoard(grid);
  return {
    map: influence.map(sabakiBoard, { discrete: false }),
    area: influence.areaMap(sabakiBoard),
  };
}

// ---------------------------------------------------------------------------
// Batch detection for the analysis orchestrator
// ---------------------------------------------------------------------------

interface MoveSpec {
  x: number;
  y: number;
  color: StoneColor;
}

/**
 * Detect patterns for a sequence of moves (main line of a game).
 *
 * Replays the game move-by-move, calling detectPattern at each step.
 * Returns an array aligned with the input moves (null where no pattern found).
 */
export function detectPatternsForGame(
  moves: MoveSpec[],
  boardSize: number = 19,
): (PatternInfo | null)[] {
  const results: (PatternInfo | null)[] = [];
  let boardState: BoardState = {
    grid: createEmptyGrid(boardSize),
    captures: { B: 0, W: 0 },
    lastMove: null,
    koPoint: null,
  };

  for (const move of moves) {
    // Detect pattern on the board BEFORE this move
    const pattern = detectPattern(boardState.grid, move.x, move.y, move.color);
    results.push(pattern);

    // Play the move to advance the board state
    const result = playMove(boardState, move.x, move.y, move.color);
    if (result.valid) {
      boardState = result.newState;
    }
  }

  return results;
}
