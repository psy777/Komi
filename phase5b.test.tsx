import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import KeyMomentNav from './KeyMomentNav';
import type { SemanticAnnotation } from './types';

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

function makeMoment(overrides: Partial<SemanticAnnotation> & { moveNumber: number }): SemanticAnnotation {
  return {
    classification: 'mistake',
    mistakeType: 'shape',
    scoreDelta: -3,
    winrateDelta: -0.1,
    gamePhase: 'middlegame',
    themes: ['fighting'],
    engineTopMove: 'D4',
    enginePV: ['D4', 'Q16'],
    isKeyMoment: true,
    ...overrides,
  };
}

const moments: SemanticAnnotation[] = [
  makeMoment({ moveNumber: 15, themes: ['influence', 'opening'], gamePhase: 'opening' }),
  makeMoment({ moveNumber: 42, themes: ['fighting', 'reading'] }),
  makeMoment({ moveNumber: 87, themes: ['endgame', 'territory'], gamePhase: 'endgame' }),
];

// ---------------------------------------------------------------------------
// KeyMomentNav filtering tests
// ---------------------------------------------------------------------------

describe('KeyMomentNav — theme filtering', () => {
  it('shows all moments when no themes are active', () => {
    render(
      <KeyMomentNav keyMoments={moments} currentMove={0} onMoveSelect={() => {}} />
    );
    expect(screen.getByText('#15')).toBeTruthy();
    expect(screen.getByText('#42')).toBeTruthy();
    expect(screen.getByText('#87')).toBeTruthy();
  });

  it('filters moments by active themes', () => {
    render(
      <KeyMomentNav
        keyMoments={moments}
        currentMove={0}
        onMoveSelect={() => {}}
        activeThemes={new Set(['endgame'])}
      />
    );
    expect(screen.queryByText('#15')).toBeNull();
    expect(screen.queryByText('#42')).toBeNull();
    expect(screen.getByText('#87')).toBeTruthy();
  });

  it('shows moments matching any active theme (multi-select)', () => {
    render(
      <KeyMomentNav
        keyMoments={moments}
        currentMove={0}
        onMoveSelect={() => {}}
        activeThemes={new Set(['influence', 'fighting'])}
      />
    );
    expect(screen.getByText('#15')).toBeTruthy();
    expect(screen.getByText('#42')).toBeTruthy();
    expect(screen.queryByText('#87')).toBeNull();
  });

  it('renders PV button when onShowPV is provided', () => {
    const onShowPV = vi.fn();
    render(
      <KeyMomentNav
        keyMoments={moments}
        currentMove={0}
        onMoveSelect={() => {}}
        onShowPV={onShowPV}
      />
    );
    const pvButtons = screen.getAllByText('PV');
    expect(pvButtons.length).toBe(3);
    fireEvent.click(pvButtons[0]);
    expect(onShowPV).toHaveBeenCalledWith(moments[0]);
  });

  it('returns null when all moments are filtered out', () => {
    const { container } = render(
      <KeyMomentNav
        keyMoments={moments}
        currentMove={0}
        onMoveSelect={() => {}}
        activeThemes={new Set(['nonexistent'])}
      />
    );
    expect(container.firstChild).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GTP coordinate conversion tests (unit — extracted logic)
// ---------------------------------------------------------------------------

describe('GTP coordinate conversion', () => {
  const GTP_COLS = 'ABCDEFGHJKLMNOPQRST';

  function gtpToBoard(gtp: string): { x: number; y: number } | null {
    if (!gtp || gtp.length < 2) return null;
    const col = GTP_COLS.indexOf(gtp[0].toUpperCase());
    const row = parseInt(gtp.slice(1), 10);
    if (col < 0 || isNaN(row)) return null;
    return { x: col, y: 19 - row };
  }

  it('converts D4 correctly', () => {
    expect(gtpToBoard('D4')).toEqual({ x: 3, y: 15 });
  });

  it('converts Q16 correctly', () => {
    expect(gtpToBoard('Q16')).toEqual({ x: 15, y: 3 });
  });

  it('converts A1 (lower-left corner)', () => {
    expect(gtpToBoard('A1')).toEqual({ x: 0, y: 18 });
  });

  it('converts T19 (upper-right corner)', () => {
    expect(gtpToBoard('T19')).toEqual({ x: 18, y: 0 });
  });

  it('skips I column (J is index 8)', () => {
    expect(gtpToBoard('J4')).toEqual({ x: 8, y: 15 });
  });

  it('returns null for invalid input', () => {
    expect(gtpToBoard('')).toBeNull();
    expect(gtpToBoard('Z')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PV stone generation tests (unit)
// ---------------------------------------------------------------------------

describe('PV stone generation', () => {
  const GTP_COLS = 'ABCDEFGHJKLMNOPQRST';

  function gtpToBoard(gtp: string): { x: number; y: number } | null {
    if (!gtp || gtp.length < 2) return null;
    const col = GTP_COLS.indexOf(gtp[0].toUpperCase());
    const row = parseInt(gtp.slice(1), 10);
    if (col < 0 || isNaN(row)) return null;
    return { x: col, y: 19 - row };
  }

  function buildPVStones(pv: string[], startColor: 'B' | 'W') {
    const stones: Array<{ x: number; y: number; color: 'B' | 'W'; order: number }> = [];
    let color = startColor;
    for (let i = 0; i < pv.length; i++) {
      const coord = gtpToBoard(pv[i]);
      if (!coord) continue;
      stones.push({ x: coord.x, y: coord.y, color, order: i + 1 });
      color = color === 'B' ? 'W' : 'B';
    }
    return stones;
  }

  it('builds correct PV stones with alternating colors', () => {
    const stones = buildPVStones(['D4', 'Q16', 'D16'], 'B');
    expect(stones).toEqual([
      { x: 3, y: 15, color: 'B', order: 1 },
      { x: 15, y: 3, color: 'W', order: 2 },
      { x: 3, y: 3, color: 'B', order: 3 },
    ]);
  });

  it('handles empty PV', () => {
    expect(buildPVStones([], 'B')).toEqual([]);
  });

  it('skips invalid GTP coordinates', () => {
    const stones = buildPVStones(['D4', 'INVALID', 'Q16'], 'W');
    expect(stones).toEqual([
      { x: 3, y: 15, color: 'W', order: 1 },
      { x: 15, y: 3, color: 'B', order: 3 },
    ]);
  });
});
