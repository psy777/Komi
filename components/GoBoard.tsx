import React, { useMemo } from 'react';
import Goban from '@sabaki/shudan';
import { StoneColor, Coordinate } from '../types';

interface GoBoardProps {
  grid: StoneColor[][];
  lastMove: Coordinate | null;
  onIntersectionClick: (x: number, y: number) => void;
  markers?: { x: number; y: number; label: string }[];
}

const GoBoard: React.FC<GoBoardProps> = ({ grid, lastMove, onIntersectionClick, markers }) => {
  const boardSize = grid.length;
  const signMap = useMemo(
    () =>
      grid.map((row) =>
        row.map((stone) => (stone === StoneColor.BLACK ? 1 : stone === StoneColor.WHITE ? -1 : 0))
      ),
    [grid]
  );

  const markerMap = useMemo(() => {
    const map = Array.from({ length: boardSize }, () => Array(boardSize).fill(null as string | null));
    if (lastMove) {
      map[lastMove.y][lastMove.x] = 'circle';
    }
    if (markers) {
      markers.forEach((marker) => {
        if (map[marker.y] && map[marker.y][marker.x] !== undefined) {
          map[marker.y][marker.x] = marker.label;
        }
      });
    }
    return map;
  }, [boardSize, lastMove, markers]);

  const handleVertexClick = (vertex: number | [number, number] | { x: number; y: number }, y?: number) => {
    if (Array.isArray(vertex)) {
      onIntersectionClick(vertex[0], vertex[1]);
      return;
    }
    if (typeof vertex === 'object' && vertex) {
      onIntersectionClick(vertex.x, vertex.y);
      return;
    }
    if (typeof vertex === 'number' && typeof y === 'number') {
      onIntersectionClick(vertex, y);
    }
  };

  return (
    <div className="relative inline-block h-full w-full max-w-full max-h-full flex items-center justify-center p-2">
      <div className="relative aspect-square h-full max-h-full w-auto max-w-full rounded shadow-2xl bg-wood-300 overflow-hidden">
        {/* Wood Texture Overlay */}
        <div className="absolute inset-0 pointer-events-none opacity-20" style={{ backgroundImage: 'url("https://www.transparenttextures.com/patterns/wood-pattern.png")' }}></div>

        <Goban
          boardSize={boardSize}
          signMap={signMap}
          markerMap={markerMap}
          vertexSize={30}
          onVertexClick={handleVertexClick}
          className="block relative z-10"
          style={{ maxHeight: '100%', maxWidth: '100%' }}
        />
      </div>
    </div>
  );
};

export default GoBoard;
