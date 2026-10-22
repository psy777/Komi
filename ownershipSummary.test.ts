import { describe, it, expect } from 'vitest';
import { summarizeOwnership } from './ownershipSummary';
import { StoneColor } from './types';

const SIZE = 19;
const blank = (): number[] => new Array(SIZE * SIZE).fill(0);
const idx = (x: number, y: number) => y * SIZE + x;

function fill(arr: number[], x0: number, x1: number, y0: number, y1: number, val: number): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) arr[idx(x, y)] = val;
  }
}

describe('summarizeOwnership', () => {
  it('returns null without a usable after-map', () => {
    expect(summarizeOwnership(null, null)).toBeNull();
    expect(summarizeOwnership(null, [0, 0, 0])).toBeNull(); // wrong length
  });

  it('maps White-owned lower-right corner with correct orientation and sign', () => {
    // y=0 is the TOP row, so y/x in 13..18 is the lower-right corner.
    const after = blank();
    fill(after, 13, 18, 13, 18, -1); // 36 points certainly White
    const s = summarizeOwnership(null, after)!;
    expect(s).not.toBeNull();
    const lr = s.territory.find(t => t.region === 'lower-right corner');
    expect(lr?.controller).toBe(StoneColor.WHITE);
    expect(lr?.points).toBeCloseTo(36, 0);
    // No before-map → no delta and zero swing.
    expect(s.deltaRegions).toEqual([]);
    expect(s.totalSwing).toBe(0);
  });

  it('reports a Black territory swing in the upper-left when the move gains it', () => {
    const before = blank();
    const after = blank();
    fill(after, 0, 5, 0, 5, 1); // Black takes the upper-left corner
    const s = summarizeOwnership(before, after)!;
    const ul = s.deltaRegions.find(d => d.region === 'upper-left corner');
    expect(ul?.towards).toBe(StoneColor.BLACK);
    expect(ul?.points).toBeCloseTo(36, 0);
    expect(s.totalSwing).toBeCloseTo(36, 0);
  });

  it('names the center region', () => {
    const after = blank();
    fill(after, 6, 12, 6, 12, 1);
    const s = summarizeOwnership(null, after)!;
    expect(s.territory.some(t => t.region === 'center' && t.controller === StoneColor.BLACK)).toBe(true);
  });

  it('drops sub-threshold swings', () => {
    const before = blank();
    const after = blank();
    after[idx(0, 0)] = 1; // a single point, +1 — below the 1.5 delta threshold
    const s = summarizeOwnership(before, after);
    // Only a tiny swing and no clear territory → nothing worth reporting.
    expect(s).toBeNull();
  });
});
