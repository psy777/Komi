/**
 * Ownership summary
 *
 * Turns KataGo's raw ownership map (361 floats in [-1, 1]) into a small,
 * human-readable picture the tutoring prompt can use to ground its claims:
 *   - which board regions a move shifted, and by how many points
 *   - who currently controls each region
 *
 * Conventions (must match the engine + board):
 *   - Array index = y * 19 + x, where y = 0 is the TOP row (GTP row 19) and
 *     x = 0 is column A. Same orientation as goLogic's grid[y][x].
 *   - Values are Black-positive (engine runs reportAnalysisWinratesAs=BLACK):
 *     +1 = certainly Black, -1 = certainly White. So summing a region's values
 *     yields its net points in Black's favor.
 */

import { StoneColor } from './types';
import type { OwnershipSummary } from './types';

const SIZE = 19;

/** Minimum net point swing for a region's change to be worth mentioning. */
const DELTA_THRESHOLD = 1.5;
/** Minimum net points for a region to count as controlled (else contested). */
const CONTROL_THRESHOLD = 4;
/** Max regions reported in each list, largest-magnitude first. */
const MAX_REGIONS = 4;

type Band = 0 | 1 | 2;

/** Map a 0–18 coordinate into low / middle / high thirds of the board. */
function band(i: number): Band {
  if (i <= 5) return 0;
  if (i <= 12) return 1;
  return 2;
}

/**
 * Name a board region from its column/row bands. y = 0 is the TOP row, so
 * yBand 0 = upper, 2 = lower; xBand 0 = left, 2 = right.
 */
function regionName(xBand: Band, yBand: Band): string {
  const horiz = xBand === 0 ? 'left' : xBand === 2 ? 'right' : 'center';
  if (yBand === 1 && horiz === 'center') return 'center';
  if (yBand === 1) return `${horiz} side`;
  const vert = yBand === 0 ? 'upper' : 'lower';
  if (horiz === 'center') return `${yBand === 0 ? 'top' : 'bottom'} side`;
  return `${vert}-${horiz} corner`;
}

/** Sum per-point values into the 9 named board regions. */
function aggregate(values: number[]): Map<string, number> {
  const sums = new Map<string, number>();
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const name = regionName(band(x), band(y));
      sums.set(name, (sums.get(name) ?? 0) + values[y * SIZE + x]);
    }
  }
  return sums;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Build an OwnershipSummary from the ownership maps before and after a move.
 *
 * @param before - ownership at the position before the move (may be null/absent)
 * @param after  - ownership at the position after the move (required)
 * @returns summary, or null if no usable ownership data
 */
export function summarizeOwnership(
  before: number[] | null | undefined,
  after: number[] | null | undefined,
): OwnershipSummary | null {
  if (!after || after.length !== SIZE * SIZE) return null;

  // Current control snapshot (regions with a clear owner).
  const territory = [...aggregate(after).entries()]
    .map(([region, sum]) => ({
      region,
      controller:
        sum > CONTROL_THRESHOLD
          ? StoneColor.BLACK
          : sum < -CONTROL_THRESHOLD
            ? StoneColor.WHITE
            : ('contested' as const),
      points: round1(Math.abs(sum)),
    }))
    .filter(t => t.controller !== 'contested')
    .sort((a, b) => b.points - a.points)
    .slice(0, MAX_REGIONS);

  // What this move changed (needs a matching before-map).
  let deltaRegions: OwnershipSummary['deltaRegions'] = [];
  let totalSwing = 0;
  if (before && before.length === after.length) {
    const delta = after.map((v, i) => v - before[i]);
    totalSwing = round1(delta.reduce((s, d) => s + Math.abs(d), 0));
    deltaRegions = [...aggregate(delta).entries()]
      .map(([region, sum]) => ({
        region,
        points: round1(Math.abs(sum)),
        towards: sum >= 0 ? StoneColor.BLACK : StoneColor.WHITE,
      }))
      .filter(d => d.points >= DELTA_THRESHOLD)
      .sort((a, b) => b.points - a.points)
      .slice(0, MAX_REGIONS);
  }

  if (territory.length === 0 && deltaRegions.length === 0) return null;
  return { deltaRegions, territory, totalSwing };
}
