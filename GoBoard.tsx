import React, { useMemo } from 'react';
import { StoneColor, Coordinate, MoveClassification } from './types';

export interface MoveAnnotation {
  x: number;
  y: number;
  classification: MoveClassification;
  moveNumber: number;
}

export interface PVStone {
  x: number;
  y: number;
  color: 'B' | 'W';
  order: number;
}

const CLASSIFICATION_COLORS: Record<MoveClassification, string> = {
  brilliant: '#2196F3',
  good: '#4CAF50',
  neutral: '#9E9E9E',
  inaccuracy: '#FFC107',
  mistake: '#FF9800',
  blunder: '#F44336',
};

interface GoBoardProps {
  grid: StoneColor[][];
  lastMove: Coordinate | null;
  onIntersectionClick: (x: number, y: number) => void;
  markers?: { x: number; y: number; label: string }[];
  moveAnnotations?: MoveAnnotation[];
  pvStones?: PVStone[];
  ownershipData?: number[] | null;
  showOwnership?: boolean;
}

function getStarPoints(size: number): { x: number; y: number }[] {
  if (size === 19) return [
    { x: 3, y: 3 }, { x: 9, y: 3 }, { x: 15, y: 3 },
    { x: 3, y: 9 }, { x: 9, y: 9 }, { x: 15, y: 9 },
    { x: 3, y: 15 }, { x: 9, y: 15 }, { x: 15, y: 15 },
  ];
  if (size === 13) return [
    { x: 3, y: 3 }, { x: 6, y: 3 }, { x: 9, y: 3 },
    { x: 3, y: 6 }, { x: 6, y: 6 }, { x: 9, y: 6 },
    { x: 3, y: 9 }, { x: 6, y: 9 }, { x: 9, y: 9 },
  ];
  if (size === 9) return [
    { x: 2, y: 2 }, { x: 6, y: 2 },
    { x: 4, y: 4 },
    { x: 2, y: 6 }, { x: 6, y: 6 },
  ];
  return [];
}

const GoBoard: React.FC<GoBoardProps> = ({ grid, lastMove, onIntersectionClick, markers, moveAnnotations, pvStones, ownershipData, showOwnership }) => {
  const size = grid.length;
  const cellSize = 30;
  const padding = 30;
  const boardPixelSize = (size - 1) * cellSize + padding * 2;

  // Render Grid Lines
  const gridLines = useMemo(() => {
    const lines = [];
    for (let i = 0; i < size; i++) {
      // Vertical
      lines.push(
        <line
          key={`v-${i}`}
          x1={padding + i * cellSize}
          y1={padding}
          x2={padding + i * cellSize}
          y2={boardPixelSize - padding}
          stroke="#000"
          strokeWidth="1"
        />
      );
      // Horizontal
      lines.push(
        <line
          key={`h-${i}`}
          x1={padding}
          y1={padding + i * cellSize}
          x2={boardPixelSize - padding}
          y2={padding + i * cellSize}
          stroke="#000"
          strokeWidth="1"
        />
      );
    }
    return lines;
  }, [boardPixelSize, size]);

  // Render Star Points
  const starPoints = getStarPoints(size).map((p, i) => (
    <circle
      key={`star-${i}`}
      cx={padding + p.x * cellSize}
      cy={padding + p.y * cellSize}
      r={3}
      fill="#000"
    />
  ));

  // Render Stones
  const stones = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const stone = grid[y][x];
      if (stone !== StoneColor.EMPTY) {
        const cx = padding + x * cellSize;
        const cy = padding + y * cellSize;
        
        // Gradient ID
        const gradId = stone === StoneColor.BLACK ? 'grad-black' : 'grad-white';

        stones.push(
          <g key={`stone-${x}-${y}`}>
            {/* Shadow simulation */}
            <circle
              cx={cx + 1}
              cy={cy + 2}
              r={cellSize / 2 - 1}
              fill="rgba(0,0,0,0.3)"
            />
            <circle
              cx={cx}
              cy={cy}
              r={cellSize / 2 - 1}
              fill={`url(#${gradId})`}
              stroke={stone === StoneColor.WHITE ? '#ccc' : '#000'}
              strokeWidth={0.5}
            />
            {/* Last Move Marker */}
            {lastMove && lastMove.x === x && lastMove.y === y && (
              <circle
                cx={cx}
                cy={cy}
                r={cellSize / 5}
                fill="transparent"
                stroke={stone === StoneColor.BLACK ? 'white' : 'black'}
                strokeWidth={2}
              />
            )}
            {/* Classification Annotation Ring — only on last move */}
            {moveAnnotations && lastMove && lastMove.x === x && lastMove.y === y && (() => {
              const ann = moveAnnotations.find(a => a.x === x && a.y === y);
              if (!ann || ann.classification === 'neutral' || ann.classification === 'good') return null;
              return (
                <circle
                  cx={cx}
                  cy={cy}
                  r={cellSize / 2 + 1}
                  fill="none"
                  stroke={CLASSIFICATION_COLORS[ann.classification]}
                  strokeWidth={2.5}
                  opacity={0.85}
                />
              );
            })()}
          </g>
        );
      }
    }
  }

  // Ownership Heatmap overlay
  const ownershipOverlay = useMemo(() => {
    if (!showOwnership || !ownershipData || ownershipData.length !== size * size) return null;
    const rects = [];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const val = ownershipData[y * size + x];
        if (Math.abs(val) < 0.05) continue;
        const cx = padding + x * cellSize;
        const cy = padding + y * cellSize;
        // Black ownership → blue, White ownership → red
        const color = val > 0 ? '59, 130, 246' : '239, 68, 68';
        const intensity = Math.min(Math.abs(val), 1) * 0.45;
        rects.push(
          <rect
            key={`own-${x}-${y}`}
            x={cx - cellSize / 2}
            y={cy - cellSize / 2}
            width={cellSize}
            height={cellSize}
            fill={`rgba(${color}, ${intensity})`}
            rx={2}
          />
        );
      }
    }
    return rects;
  }, [ownershipData, showOwnership, padding, cellSize, size]);

  // PV Ghost Stones
  const pvOverlay = useMemo(() => {
    if (!pvStones || pvStones.length === 0) return null;
    return pvStones.map((stone) => {
      const cx = padding + stone.x * cellSize;
      const cy = padding + stone.y * cellSize;
      const isBlack = stone.color === 'B';
      return (
        <g key={`pv-${stone.order}`}>
          <circle
            cx={cx}
            cy={cy}
            r={cellSize / 2 - 2}
            fill={isBlack ? 'rgba(0,0,0,0.4)' : 'rgba(255,255,255,0.4)'}
            stroke={isBlack ? 'rgba(0,0,0,0.6)' : 'rgba(200,200,200,0.6)'}
            strokeWidth={1}
          />
          <text
            x={cx}
            y={cy + 1}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={cellSize * 0.4}
            fontWeight="bold"
            fill={isBlack ? '#a5b4fc' : '#1e293b'}
            className="select-none"
          >
            {stone.order}
          </text>
        </g>
      );
    });
  }, [pvStones, padding, cellSize]);

  // Click Handlers (transparent rects over intersections)
  const clickTargets = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      clickTargets.push(
        <rect
          key={`click-${x}-${y}`}
          x={padding + x * cellSize - cellSize / 2}
          y={padding + y * cellSize - cellSize / 2}
          width={cellSize}
          height={cellSize}
          fill="transparent"
          onClick={() => onIntersectionClick(x, y)}
          className="cursor-pointer hover:fill-black/10 transition-colors"
        />
      );
    }
  }

  // Coordinates
  const coords = [];
  const coordLabels = 'ABCDEFGHJKLMNOPQRST';
  for (let i = 0; i < size; i++) {
    // Top
    coords.push(<text key={`ct-${i}`} x={padding + i * cellSize} y={padding - 15} textAnchor="middle" fontSize="12" fill="#444" className="font-sans font-bold select-none">{coordLabels[i]}</text>);
    // Bottom
    coords.push(<text key={`cb-${i}`} x={padding + i * cellSize} y={boardPixelSize - padding + 20} textAnchor="middle" fontSize="12" fill="#444" className="font-sans font-bold select-none">{coordLabels[i]}</text>);
    // Left
    coords.push(<text key={`cl-${i}`} x={padding - 15} y={padding + i * cellSize + 4} textAnchor="end" fontSize="12" fill="#444" className="font-sans font-bold select-none">{size - i}</text>);
    // Right
    coords.push(<text key={`cr-${i}`} x={boardPixelSize - padding + 15} y={padding + i * cellSize + 4} textAnchor="start" fontSize="12" fill="#444" className="font-sans font-bold select-none">{size - i}</text>);
  }

  return (
    <div className="relative inline-block h-full w-full max-w-full max-h-full flex items-center justify-center p-2">
      <div className="relative aspect-square h-full max-h-full w-auto max-w-full rounded shadow-2xl bg-wood-300 overflow-hidden">
        {/* Wood Texture Overlay */}
        <div className="absolute inset-0 pointer-events-none opacity-20" style={{ backgroundImage: 'url("https://www.transparenttextures.com/patterns/wood-pattern.png")' }}></div>
        
        <svg 
            viewBox={`0 0 ${boardPixelSize} ${boardPixelSize}`}
            width="100%" 
            height="100%" 
            className="block relative z-10"
            style={{ maxHeight: '100%', maxWidth: '100%' }}
        >
        <defs>
            <radialGradient id="grad-black" cx="30%" cy="30%" r="70%">
            <stop offset="0%" stopColor="#666" />
            <stop offset="20%" stopColor="#333" />
            <stop offset="100%" stopColor="#000" />
            </radialGradient>
            <radialGradient id="grad-white" cx="35%" cy="35%" r="70%">
            <stop offset="0%" stopColor="#fff" />
            <stop offset="50%" stopColor="#f0f0f0" />
            <stop offset="100%" stopColor="#dcdcdc" />
            </radialGradient>
        </defs>

        {/* Board Background */}
        <rect width="100%" height="100%" fill="transparent" />

        {gridLines}
        {starPoints}
        {coords}
        {ownershipOverlay}
        {stones}
        {pvOverlay}
        {clickTargets}
        </svg>
      </div>
    </div>
  );
};

export default GoBoard;
