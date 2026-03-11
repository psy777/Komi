import React from 'react';
import type { SemanticAnnotation, MoveClassification } from './types';

const CLASSIFICATION_COLORS: Record<MoveClassification, string> = {
  brilliant: '#2196F3',
  good: '#4CAF50',
  neutral: '#9E9E9E',
  inaccuracy: '#FFC107',
  mistake: '#FF9800',
  blunder: '#F44336',
};

const CLASSIFICATION_LABELS: Record<MoveClassification, string> = {
  brilliant: 'Brilliant',
  good: 'Good',
  neutral: 'Neutral',
  inaccuracy: 'Inaccuracy',
  mistake: 'Mistake',
  blunder: 'Blunder',
};

interface KeyMomentNavProps {
  keyMoments: SemanticAnnotation[];
  currentMove: number;
  onMoveSelect: (moveNumber: number) => void;
  activeThemes?: Set<string>;
  onShowPV?: (annotation: SemanticAnnotation) => void;
}

const KeyMomentNav: React.FC<KeyMomentNavProps> = ({ keyMoments, currentMove, onMoveSelect, activeThemes, onShowPV }) => {
  const filteredMoments = activeThemes && activeThemes.size > 0
    ? keyMoments.filter(m => m.themes.some(t => activeThemes.has(t)))
    : keyMoments;

  if (filteredMoments.length === 0) return null;

  return (
    <div className="bg-slate-800/60 rounded-xl border border-slate-700/50 p-3">
      <span className="text-xs font-bold text-slate-400 uppercase tracking-wider block mb-2">Key Moments</span>
      <div className="flex flex-col gap-1 max-h-40 overflow-y-auto pr-1 scrollbar-thin">
        {filteredMoments.map((moment) => {
          const isActive = moment.moveNumber === currentMove;
          const color = CLASSIFICATION_COLORS[moment.classification];
          return (
            <button
              key={moment.moveNumber}
              onClick={() => onMoveSelect(moment.moveNumber)}
              className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left transition-all w-full ${
                isActive
                  ? 'bg-slate-700 border border-slate-600'
                  : 'hover:bg-slate-700/50 border border-transparent'
              }`}
            >
              {/* Classification badge */}
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: color }}
              />
              {/* Move number */}
              <span className="text-xs font-mono text-slate-500 w-8 shrink-0">#{moment.moveNumber}</span>
              {/* Classification label */}
              <span className="text-xs font-semibold" style={{ color }}>
                {CLASSIFICATION_LABELS[moment.classification]}
              </span>
              {/* PV button */}
              {onShowPV && moment.enginePV.length > 0 && (
                <button
                  onClick={(e) => { e.stopPropagation(); onShowPV(moment); }}
                  className="text-[9px] text-indigo-400 hover:text-indigo-300 font-semibold uppercase tracking-wider shrink-0"
                  title="Show engine line"
                >
                  PV
                </button>
              )}
              {/* Phase badge */}
              <span className="text-[9px] text-slate-600 ml-auto uppercase tracking-wider">
                {moment.gamePhase}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default KeyMomentNav;
