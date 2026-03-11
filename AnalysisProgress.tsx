import React from 'react';
import type { AnalysisProgressData, FullGameAnalysis } from './types';

const PHASE_LABELS: Record<string, string> = {
  engine: 'Engine Analysis',
  semantic: 'Move Classification',
  commentary: 'Generating Commentary',
  complete: 'Analysis Complete',
};

interface AnalysisProgressProps {
  progress: AnalysisProgressData;
  result?: FullGameAnalysis | null;
}

const AnalysisProgress: React.FC<AnalysisProgressProps> = ({ progress, result }) => {
  const { phase, current, total } = progress;
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  const isComplete = phase === 'complete';

  if (isComplete && result) {
    const counts = result.summary.classificationCounts;
    const blunders = counts.blunder ?? 0;
    const mistakes = counts.mistake ?? 0;
    const brilliant = counts.brilliant ?? 0;
    return (
      <div className="bg-slate-800/60 rounded-xl border border-slate-700/50 p-4">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-2 h-2 rounded-full bg-emerald-400" />
          <span className="text-xs font-bold text-emerald-400 uppercase tracking-wider">Analysis Complete</span>
        </div>
        <div className="flex gap-4 text-xs">
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-[#2196F3]" />
            <span className="text-slate-400">Brilliant: <span className="text-white font-bold">{brilliant}</span></span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-[#FF9800]" />
            <span className="text-slate-400">Mistakes: <span className="text-white font-bold">{mistakes}</span></span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-[#F44336]" />
            <span className="text-slate-400">Blunders: <span className="text-white font-bold">{blunders}</span></span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-slate-800/60 rounded-xl border border-slate-700/50 p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-bold text-slate-300 uppercase tracking-wider">
          {PHASE_LABELS[phase] ?? phase}
        </span>
        <span className="text-xs text-slate-500 font-mono">{current}/{total}</span>
      </div>
      <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
        <div
          className="h-full bg-emerald-500 rounded-full transition-all duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      {progress.message && (
        <p className="text-[10px] text-slate-500 mt-1.5">{progress.message}</p>
      )}
    </div>
  );
};

export default AnalysisProgress;
