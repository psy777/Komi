import React, { useState, useEffect, useCallback } from 'react';
import type {
  SemanticAnnotation,
  MoveClassification,
  MistakeType,
  PlayerLevel,
  FullGameAnalysis,
  TutoringExplanation,
} from './types';
import { generateRichExplanation } from './mistakeExplainer';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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

const LEVEL_LABELS: Record<PlayerLevel, string> = {
  beginner: 'Beginner',
  intermediate: 'SDK',
  advanced: 'Dan',
  strong: 'Expert',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isMistake(cls: MoveClassification): boolean {
  return cls === 'blunder' || cls === 'mistake' || cls === 'inaccuracy';
}

// ---------------------------------------------------------------------------
// Section Components
// ---------------------------------------------------------------------------

/** Collapsible section with a heading and chevron toggle */
const Section: React.FC<{
  title: string;
  icon?: string;
  defaultOpen?: boolean;
  accentColor?: string;
  children: React.ReactNode;
}> = ({ title, icon, defaultOpen = true, accentColor, children }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 w-full text-left group"
      >
        {icon && <span className="text-xs">{icon}</span>}
        <span
          className="text-[10px] font-bold uppercase tracking-wider"
          style={{ color: accentColor ?? '#94a3b8' }}
        >
          {title}
        </span>
        <span className="text-[8px] text-slate-600 ml-auto transition-transform" style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}>
          ▼
        </span>
      </button>
      {open && <div className="mt-1.5">{children}</div>}
    </div>
  );
};

/** Spinner used while waiting for Gemini */
const Spinner: React.FC<{ label?: string }> = ({ label }) => (
  <div className="flex items-center gap-2 text-slate-500 text-xs py-2">
    <div className="w-3 h-3 border-2 border-slate-600 border-t-emerald-400 rounded-full animate-spin" />
    {label ?? 'Generating explanation…'}
  </div>
);

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export interface TutoringPanelProps {
  annotation: SemanticAnnotation;
  playedMove: string;
  playerLevel: PlayerLevel;
  analysis: FullGameAnalysis;
  onShowEngineLine?: () => void;
  onNavigateToMove?: (moveNumber: number) => void;
}

const TutoringPanel: React.FC<TutoringPanelProps> = ({
  annotation,
  playedMove,
  playerLevel,
  analysis,
  onShowEngineLine,
  onNavigateToMove,
}) => {
  const [tutoring, setTutoring] = useState<TutoringExplanation | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [drillDownQ, setDrillDownQ] = useState<string | null>(null);
  const [drillDownA, setDrillDownA] = useState<TutoringExplanation | null>(null);
  const [isDrilling, setIsDrilling] = useState(false);
  const [customQuestion, setCustomQuestion] = useState('');

  const color = CLASSIFICATION_COLORS[annotation.classification];
  const mistake = isMistake(annotation.classification);

  // -----------------------------------------------------------------------
  // Fetch tutoring explanation when annotation or level changes
  // -----------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setTutoring(null);
    setDrillDownQ(null);
    setDrillDownA(null);

    generateRichExplanation(annotation, playerLevel, analysis)
      .then(result => {
        if (!cancelled) {
          setTutoring(result);
          setIsLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTutoring({
            moveNumber: annotation.moveNumber,
            playerLevel,
            headline: 'Error',
            explanation: 'Failed to generate explanation. Please try again.',
            whatWasPlayed: '',
          });
          setIsLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [annotation.moveNumber, playerLevel, analysis]);

  // -----------------------------------------------------------------------
  // Drill-down handler
  // -----------------------------------------------------------------------
  const handleDrillDown = useCallback((question: string) => {
    if (!question.trim()) return;
    setDrillDownQ(question);
    setIsDrilling(true);
    setDrillDownA(null);

    generateRichExplanation(annotation, playerLevel, analysis, question)
      .then(result => {
        setDrillDownA(result);
        setIsDrilling(false);
      })
      .catch(() => {
        setDrillDownA({
          moveNumber: annotation.moveNumber,
          playerLevel,
          headline: 'Error',
          explanation: 'Could not generate a deeper explanation.',
          whatWasPlayed: '',
        });
        setIsDrilling(false);
      });
  }, [annotation, playerLevel, analysis]);

  const handleCustomSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (customQuestion.trim()) {
      handleDrillDown(customQuestion.trim());
      setCustomQuestion('');
    }
  }, [customQuestion, handleDrillDown]);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------
  return (
    <div className="bg-slate-800/60 rounded-xl border border-slate-700/50 p-3 space-y-3">

      {/* === Header: Classification badge + move number + phase === */}
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
        <div className="flex items-center gap-2">
          <span className="text-[9px] text-slate-500 bg-slate-700/40 px-1.5 py-0.5 rounded uppercase tracking-wider">
            {LEVEL_LABELS[playerLevel]}
          </span>
          <span className="text-[9px] text-slate-600 uppercase tracking-wider">
            {annotation.gamePhase}
          </span>
        </div>
      </div>

      {/* === Headline === */}
      {tutoring?.headline && !isLoading && (
        <div className="text-sm font-semibold text-slate-200 leading-snug">
          {tutoring.headline}
        </div>
      )}

      {/* === Played vs Engine comparison === */}
      {mistake && (
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-slate-900/60 rounded-lg p-2 border border-slate-700/30">
            <div className="text-[9px] text-slate-500 uppercase tracking-wider mb-1">Played</div>
            <div className="text-sm font-mono font-bold text-slate-300">{playedMove}</div>
          </div>
          <div className="bg-slate-900/60 rounded-lg p-2 border border-emerald-800/30">
            <div className="text-[9px] text-emerald-500 uppercase tracking-wider mb-1">Better</div>
            <div className="text-sm font-mono font-bold text-emerald-400">{annotation.engineTopMove}</div>
          </div>
        </div>
      )}

      {/* === Pattern context === */}
      {annotation.pattern && (
        <div className="flex items-center gap-1.5 bg-indigo-900/20 border border-indigo-800/30 rounded-lg px-2.5 py-1.5">
          <span className="text-[9px] text-indigo-400 uppercase tracking-wider font-bold">{annotation.pattern.category}</span>
          <span className="text-xs text-indigo-300 font-medium">{annotation.pattern.name}</span>
          {annotation.pattern.url && (
            <a
              href={annotation.pattern.url}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto text-[9px] text-indigo-500 hover:text-indigo-400 underline"
            >
              Learn more
            </a>
          )}
        </div>
      )}

      {/* === Score & mistake type === */}
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

      {/* === Loading state === */}
      {isLoading && <Spinner />}

      {/* === Structured Explanation === */}
      {tutoring && !isLoading && (
        <div className="space-y-2.5">
          {/* What Was Played */}
          {tutoring.whatWasPlayed && (
            <Section title="What happened" icon="📍" defaultOpen={true} accentColor="#94a3b8">
              <p className="text-xs text-slate-300 leading-relaxed">{tutoring.whatWasPlayed}</p>
            </Section>
          )}

          {/* Why It's Wrong / What Was Better */}
          {tutoring.whatWasBetter && (
            <Section title="Why it's wrong" icon="❌" defaultOpen={true} accentColor="#f87171">
              <p className="text-xs text-slate-300 leading-relaxed">{tutoring.whatWasBetter}</p>
            </Section>
          )}

          {/* Full explanation */}
          <Section
            title={mistake ? 'Full explanation' : 'Analysis'}
            icon="📖"
            defaultOpen={!tutoring.whatWasBetter}
            accentColor="#60a5fa"
          >
            <p className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap">{tutoring.explanation}</p>
          </Section>

          {/* Concept tag */}
          {tutoring.concept && (
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] text-amber-500 uppercase tracking-wider font-bold">Concept</span>
              <span className="text-xs text-amber-300 bg-amber-900/20 border border-amber-800/30 px-2 py-0.5 rounded-full font-medium">
                {tutoring.concept}
              </span>
            </div>
          )}

          {/* Theme tags */}
          {annotation.themes.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {annotation.themes.map(theme => (
                <span
                  key={theme}
                  className="text-[9px] text-cyan-400/80 bg-cyan-900/20 border border-cyan-800/20 px-1.5 py-0.5 rounded"
                >
                  {theme}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* === Show engine line button === */}
      {annotation.enginePV.length > 0 && (
        <button
          onClick={onShowEngineLine}
          className="w-full text-xs text-emerald-400 hover:text-emerald-300 bg-emerald-900/20 hover:bg-emerald-900/40 border border-emerald-800/30 rounded-lg py-1.5 transition-all font-medium"
        >
          Show Engine Line ({annotation.enginePV.length} moves)
        </button>
      )}

      {/* === Drill-down section === */}
      {tutoring && !isLoading && (
        <div className="border-t border-slate-700/40 pt-2.5 space-y-2">
          {/* Follow-up hint as clickable prompt */}
          {tutoring.followUpHint && !drillDownQ && (
            <button
              onClick={() => handleDrillDown(tutoring.followUpHint!)}
              className="w-full text-left text-xs text-sky-400 hover:text-sky-300 bg-sky-900/15 hover:bg-sky-900/30 border border-sky-800/30 rounded-lg px-3 py-2 transition-all"
            >
              <span className="text-[9px] text-sky-500 uppercase tracking-wider font-bold block mb-0.5">Dig deeper</span>
              {tutoring.followUpHint}
            </button>
          )}

          {/* Drill-down result */}
          {drillDownQ && (
            <div className="bg-slate-900/40 rounded-lg p-2.5 border border-sky-800/20 space-y-2">
              <div className="text-[10px] text-sky-400 font-semibold">{drillDownQ}</div>
              {isDrilling && <Spinner label="Thinking deeper…" />}
              {drillDownA && !isDrilling && (
                <p className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap">
                  {drillDownA.explanation}
                </p>
              )}
            </div>
          )}

          {/* Custom question input */}
          <form onSubmit={handleCustomSubmit} className="flex gap-1.5">
            <input
              type="text"
              value={customQuestion}
              onChange={e => setCustomQuestion(e.target.value)}
              placeholder="Ask about this move…"
              className="flex-1 text-xs bg-slate-900/60 border border-slate-700/50 rounded-lg px-2.5 py-1.5 text-slate-300 placeholder-slate-600 focus:outline-none focus:border-sky-700/50 transition-colors"
            />
            <button
              type="submit"
              disabled={!customQuestion.trim() || isDrilling}
              className="px-2.5 py-1.5 text-xs font-semibold bg-sky-900/30 hover:bg-sky-900/50 border border-sky-800/30 text-sky-400 hover:text-sky-300 rounded-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Ask
            </button>
          </form>
        </div>
      )}
    </div>
  );
};

export default TutoringPanel;
