import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ConceptTagFilter from './ConceptTagFilter';

describe('ConceptTagFilter', () => {
  const themes = ['influence', 'territory', 'fighting', 'endgame'];

  it('renders nothing when themes array is empty', () => {
    const { container } = render(
      <ConceptTagFilter themes={[]} activeThemes={new Set()} onToggleTheme={() => {}} onClearAll={() => {}} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders all themes as buttons', () => {
    render(
      <ConceptTagFilter themes={themes} activeThemes={new Set()} onToggleTheme={() => {}} onClearAll={() => {}} />
    );
    for (const theme of themes) {
      expect(screen.getByText(theme)).toBeTruthy();
    }
  });

  it('calls onToggleTheme when a tag is clicked', () => {
    const onToggle = vi.fn();
    render(
      <ConceptTagFilter themes={themes} activeThemes={new Set()} onToggleTheme={onToggle} onClearAll={() => {}} />
    );
    fireEvent.click(screen.getByText('fighting'));
    expect(onToggle).toHaveBeenCalledWith('fighting');
  });

  it('shows Clear button only when themes are active', () => {
    const { rerender } = render(
      <ConceptTagFilter themes={themes} activeThemes={new Set()} onToggleTheme={() => {}} onClearAll={() => {}} />
    );
    expect(screen.queryByText('Clear')).toBeNull();

    rerender(
      <ConceptTagFilter themes={themes} activeThemes={new Set(['influence'])} onToggleTheme={() => {}} onClearAll={() => {}} />
    );
    expect(screen.getByText('Clear')).toBeTruthy();
  });

  it('calls onClearAll when Clear is clicked', () => {
    const onClear = vi.fn();
    render(
      <ConceptTagFilter themes={themes} activeThemes={new Set(['influence'])} onToggleTheme={() => {}} onClearAll={onClear} />
    );
    fireEvent.click(screen.getByText('Clear'));
    expect(onClear).toHaveBeenCalled();
  });

  it('applies active styling to selected themes', () => {
    render(
      <ConceptTagFilter themes={themes} activeThemes={new Set(['territory'])} onToggleTheme={() => {}} onClearAll={() => {}} />
    );
    const btn = screen.getByText('territory');
    expect(btn.className).toContain('bg-emerald-600');
  });
});
