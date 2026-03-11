import React, { useMemo } from 'react';
import type { SemanticAnnotation, MoveClassification } from './types';

const CLASSIFICATION_COLORS: Record<MoveClassification, string> = {
  brilliant: '#2196F3',
  good: '#4CAF50',
  neutral: '#9E9E9E',
  inaccuracy: '#FFC107',
  mistake: '#FF9800',
  blunder: '#F44336',
};

interface ScoreGraphProps {
  annotations: SemanticAnnotation[];
  currentMove: number;
  onMoveSelect: (moveNumber: number) => void;
  highlightedMoves?: Set<number>;
}

const GRAPH_W = 600;
const GRAPH_H = 120;
const PAD_X = 32;
const PAD_Y = 16;
const PLOT_W = GRAPH_W - PAD_X * 2;
const PLOT_H = GRAPH_H - PAD_Y * 2;
const SCORE_CAP = 30; // Clamp score lead to +-30

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

const ScoreGraph: React.FC<ScoreGraphProps> = ({ annotations, currentMove, onMoveSelect, highlightedMoves }) => {
  const { points, pathD } = useMemo(() => {
    if (annotations.length === 0) return { points: [], pathD: '' };

    const pts = annotations.map((ann) => {
      // Compute cumulative score lead from score deltas
      // We use scoreDelta accumulated — but we actually need absolute score at each move.
      // Since annotations have scoreDelta (change per move), we track running score.
      return ann;
    });

    // Build running score from deltas
    let runningScore = 0;
    const scores: { moveNumber: number; score: number; classification: MoveClassification }[] = [];
    for (const ann of pts) {
      runningScore += ann.scoreDelta;
      scores.push({
        moveNumber: ann.moveNumber,
        score: runningScore,
        classification: ann.classification,
      });
    }

    const maxMove = scores[scores.length - 1]?.moveNumber || 1;

    const mapped = scores.map((s) => {
      const x = PAD_X + (s.moveNumber / maxMove) * PLOT_W;
      const clamped = clamp(s.score, -SCORE_CAP, SCORE_CAP);
      const y = PAD_Y + PLOT_H / 2 - (clamped / SCORE_CAP) * (PLOT_H / 2);
      return { x, y, ...s };
    });

    // SVG path
    const d = mapped
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
      .join(' ');

    return { points: mapped, pathD: d };
  }, [annotations]);

  if (annotations.length === 0) {
    return null;
  }

  const maxMove = annotations[annotations.length - 1]?.moveNumber || 1;
  const currentX = PAD_X + (currentMove / maxMove) * PLOT_W;

  return (
    <div className="bg-slate-800/60 rounded-xl border border-slate-700/50 p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Score Graph</span>
        <div className="flex gap-2 text-[9px] text-slate-500">
          <span>B+</span>
          <span className="text-slate-600">|</span>
          <span>W+</span>
        </div>
      </div>
      <svg
        viewBox={`0 0 ${GRAPH_W} ${GRAPH_H}`}
        className="w-full cursor-pointer"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const relX = ((e.clientX - rect.left) / rect.width) * GRAPH_W;
          const moveNum = Math.round(((relX - PAD_X) / PLOT_W) * maxMove);
          if (moveNum >= 0 && moveNum <= maxMove) {
            onMoveSelect(moveNum);
          }
        }}
      >
        {/* Zero line */}
        <line
          x1={PAD_X}
          y1={PAD_Y + PLOT_H / 2}
          x2={PAD_X + PLOT_W}
          y2={PAD_Y + PLOT_H / 2}
          stroke="#475569"
          strokeWidth="0.5"
          strokeDasharray="4 2"
        />
        {/* Y-axis labels */}
        <text x={PAD_X - 4} y={PAD_Y + 4} textAnchor="end" fontSize="8" fill="#64748b">+{SCORE_CAP}</text>
        <text x={PAD_X - 4} y={PAD_Y + PLOT_H / 2 + 3} textAnchor="end" fontSize="8" fill="#64748b">0</text>
        <text x={PAD_X - 4} y={PAD_Y + PLOT_H} textAnchor="end" fontSize="8" fill="#64748b">-{SCORE_CAP}</text>

        {/* Black/White territory shading */}
        <rect x={PAD_X} y={PAD_Y} width={PLOT_W} height={PLOT_H / 2} fill="#fff" opacity="0.02" />
        <rect x={PAD_X} y={PAD_Y + PLOT_H / 2} width={PLOT_W} height={PLOT_H / 2} fill="#000" opacity="0.05" />

        {/* Score line */}
        <path d={pathD} fill="none" stroke="#10b981" strokeWidth="1.5" strokeLinejoin="round" />

        {/* Colored dots for non-neutral moves */}
        {points
          .filter((p) => p.classification !== 'neutral' && p.classification !== 'good')
          .map((p) => (
            <circle
              key={p.moveNumber}
              cx={p.x}
              cy={p.y}
              r={p.classification === 'blunder' ? 3 : 2.5}
              fill={CLASSIFICATION_COLORS[p.classification]}
              opacity={0.9}
            />
          ))}

        {/* Highlighted moves from concept filter */}
        {highlightedMoves && highlightedMoves.size > 0 && points
          .filter((p) => highlightedMoves.has(p.moveNumber))
          .map((p) => (
            <line
              key={`hl-${p.moveNumber}`}
              x1={p.x}
              y1={PAD_Y}
              x2={p.x}
              y2={PAD_Y + PLOT_H}
              stroke="#10b981"
              strokeWidth="1"
              opacity={0.25}
            />
          ))}

        {/* Current move indicator */}
        <line
          x1={currentX}
          y1={PAD_Y}
          x2={currentX}
          y2={PAD_Y + PLOT_H}
          stroke="#10b981"
          strokeWidth="1"
          opacity={0.6}
        />
      </svg>
    </div>
  );
};

export default ScoreGraph;
