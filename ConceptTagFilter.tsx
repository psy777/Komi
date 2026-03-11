import React from 'react';

interface ConceptTagFilterProps {
  themes: string[];
  activeThemes: Set<string>;
  onToggleTheme: (theme: string) => void;
  onClearAll: () => void;
}

const ConceptTagFilter: React.FC<ConceptTagFilterProps> = ({ themes, activeThemes, onToggleTheme, onClearAll }) => {
  if (themes.length === 0) return null;

  return (
    <div className="bg-slate-800/60 rounded-xl border border-slate-700/50 p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Concepts</span>
        {activeThemes.size > 0 && (
          <button
            onClick={onClearAll}
            className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors uppercase tracking-wider font-semibold"
          >
            Clear
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {themes.map((theme) => {
          const isActive = activeThemes.has(theme);
          return (
            <button
              key={theme}
              onClick={() => onToggleTheme(theme)}
              className={`px-2.5 py-1 rounded-full text-[10px] font-semibold transition-all border ${
                isActive
                  ? 'bg-emerald-600 border-emerald-500 text-white'
                  : 'bg-slate-700/50 border-slate-600/50 text-slate-400 hover:bg-slate-700 hover:text-slate-300'
              }`}
            >
              {theme}
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default ConceptTagFilter;
