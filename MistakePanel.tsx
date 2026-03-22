import React, { useState, useEffect } from 'react';
import type { SemanticAnnotation, MoveClassification, MistakeType, PlayerLevel } from './types';
import { buildComparison, generateExplanation } from './mistakeExplainer';

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

const MISTAKE_TYPE_LABELS: Record<MistakeType, string> = {
  direction: 'Wrong Direction',
  shape: 'Shape Error',
  reading: 'Reading Mistake',
  timing: 'Bad Timing',
  overplay: 'Overplay',
  passivity: 'Too Passive',
};

interface MistakePanelProps {
  annotation: SemanticAnnotation;
  playedMove: string;
  playerLevel: PlayerLevel;
  onShowEngineLine?: () => void;
}

const MistakePanel: React.FC<MistakePanelProps> = ({
  annotation,
  playedMove,
  playerLevel,
  onShowEngineLine,
}) => {
  const [explanation, setExplanation] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const comparison = buildComparison(annotation, playedMove);
  const color = CLASSIFICATION_COLORS[annotation.classification];

  useEffect(() => {
    if (comparison.explanation) {
      setExplanation(comparison.explanation);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setExplanation(null);

    generateExplanation(annotation, playerLevel)
      .then(text => {
        if (!cancelled) {
          setExplanation(text);
          setIsLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setExplanation('Failed to generate explanation.');
          setIsLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [annotation.moveNumber, playerLevel]);

  return (
    <div className="bg-slate-800/60 rounded-xl border border-slate-700/50 p-3 space-y-3">
      {/* Header: Classification badge + move number */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className="px-2 py-0.5 rounded-full text-xs font-bold text-white"
            style={{ backgroundColor: color }}
          >
            {CLASSIFICATION_LABELS[annotation.classification]}
          </span>
          <span className="text-xs font-mono text-slate-500">Move #{annotation.moveNumber}</span>
        </div>
        <span className="text-[9px] text-slate-600 uppercase tracking-wider">
          {annotation.gamePhase}
        </span>
      </div>

      {/* Comparison: Played vs Engine */}
      <div className="grid grid-cols-2 gap-2">
        <div className="bg-slate-900/60 rounded-lg p-2 border border-slate-700/30">
          <div className="text-[9px] text-slate-500 uppercase tracking-wider mb-1">Played</div>
          <div className="text-sm font-mono font-bold text-slate-300">{playedMove}</div>
        </div>
        <div className="bg-slate-900/60 rounded-lg p-2 border border-emerald-800/30">
          <div className="text-[9px] text-emerald-500 uppercase tracking-wider mb-1">Engine</div>
          <div className="text-sm font-mono font-bold text-emerald-400">{annotation.engineTopMove}</div>
        </div>
      </div>

      {/* Pattern badge */}
      {annotation.pattern && (
        <div className="flex items-center gap-1.5">
          <span className="text-[9px] text-indigo-400 uppercase tracking-wider font-bold">{annotation.pattern.category}</span>
          <span className="text-xs text-indigo-300 bg-indigo-900/30 border border-indigo-800/30 px-1.5 py-0.5 rounded font-medium">
            {annotation.pattern.name}
          </span>
        </div>
      )}

      {/* Score delta + Mistake type */}
      <div className="flex items-center gap-3 text-xs">
        <span className={`font-mono font-bold ${annotation.scoreDelta < 0 ? 'text-red-400' : 'text-emerald-400'}`}>
          {annotation.scoreDelta > 0 ? '+' : ''}{annotation.scoreDelta.toFixed(1)} pts
        </span>
        <span className={`font-mono ${annotation.winrateDelta < 0 ? 'text-red-400/70' : 'text-emerald-400/70'}`}>
          {annotation.winrateDelta > 0 ? '+' : ''}{(annotation.winrateDelta * 100).toFixed(1)}% WR
        </span>
        {annotation.mistakeType && (
          <span className="text-slate-400 bg-slate-700/50 px-1.5 py-0.5 rounded text-[10px]">
            {MISTAKE_TYPE_LABELS[annotation.mistakeType]}
          </span>
        )}
      </div>

      {/* Explanation */}
      <div className="text-xs text-slate-300 leading-relaxed">
        {isLoading && (
          <div className="flex items-center gap-2 text-slate-500">
            <div className="w-3 h-3 border-2 border-slate-600 border-t-emerald-400 rounded-full animate-spin" />
            Generating explanation...
          </div>
        )}
        {explanation && !isLoading && (
          <div className="whitespace-pre-wrap">{explanation}</div>
        )}
      </div>

      {/* Show engine line button (Phase 5b will render the PV) */}
      {annotation.enginePV.length > 0 && (
        <button
          onClick={onShowEngineLine}
          className="w-full text-xs text-emerald-400 hover:text-emerald-300 bg-emerald-900/20 hover:bg-emerald-900/40 border border-emerald-800/30 rounded-lg py-1.5 transition-all font-medium"
        >
          Show Engine Line ({annotation.enginePV.length} moves)
        </button>
      )}
    </div>
  );
};

export default MistakePanel;
