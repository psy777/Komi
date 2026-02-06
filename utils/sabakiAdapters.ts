import Board from '@sabaki/go-board';
import boardMatcher from '@sabaki/boardmatcher';
import patternLibrary from '@sabaki/boardmatcher/library';
import deadstones from '@sabaki/deadstones';
import influence from '@sabaki/influence';
import { Coordinate, StoneColor } from '../types';

const resolveModule = <T,>(moduleRef: T): T => {
  const mod = moduleRef as T & { default?: T };
  return mod?.default ?? moduleRef;
};

export const toSign = (stone: StoneColor): number => {
  if (stone === StoneColor.BLACK) return 1;
  if (stone === StoneColor.WHITE) return -1;
  return 0;
};

export const toSignMap = (grid: StoneColor[][]): number[][] =>
  grid.map((row) => row.map((stone) => toSign(stone)));

export const createSabakiBoard = (grid: StoneColor[][]): any | null => {
  const BoardCtor = resolveModule(Board) as any;
  if (!BoardCtor) return null;

  try {
    if (typeof BoardCtor.fromDimensions === 'function') {
      const board = BoardCtor.fromDimensions(grid.length);
      board.signMap = toSignMap(grid);
      return board;
    }
    if (typeof BoardCtor === 'function') {
      return new BoardCtor(toSignMap(grid));
    }
  } catch {
    return null;
  }

  return null;
};

export const getInfluenceSummary = (
  grid: StoneColor[][],
  options: { maxDistance?: number; minRadiance?: number } = {}
): { blackArea: number; whiteArea: number } | null => {
  const influenceFn = resolveModule(influence) as any;
  if (!influenceFn) return null;

  try {
    const map =
      typeof influenceFn.areaMap === 'function'
        ? influenceFn.areaMap(toSignMap(grid))
        : typeof influenceFn.map === 'function'
          ? influenceFn.map(toSignMap(grid), options)
          : null;

    if (!Array.isArray(map)) return null;

    let blackArea = 0;
    let whiteArea = 0;
    for (const row of map) {
      for (const value of row) {
        if (value > 0) blackArea++;
        if (value < 0) whiteArea++;
      }
    }

    return { blackArea, whiteArea };
  } catch {
    return null;
  }
};

const normalizeVertices = (data: any): Coordinate[] => {
  if (!data) return [];
  const coords: Coordinate[] = [];

  const pushVertex = (vertex: any) => {
    if (!vertex) return;
    if (Array.isArray(vertex) && vertex.length >= 2) {
      coords.push({ x: vertex[0], y: vertex[1] });
      return;
    }
    if (typeof vertex.x === 'number' && typeof vertex.y === 'number') {
      coords.push({ x: vertex.x, y: vertex.y });
    }
  };

  if (Array.isArray(data)) {
    data.forEach((entry) => {
      if (Array.isArray(entry)) {
        entry.forEach(pushVertex);
        return;
      }
      pushVertex(entry);
    });
  }

  return coords;
};

export const getDeadStoneVertices = async (
  grid: StoneColor[][],
  options: { finished?: boolean; iterations?: number } = {}
): Promise<Coordinate[]> => {
  const deadstonesModule = resolveModule(deadstones) as any;
  if (!deadstonesModule?.guess) return [];

  try {
    const result = await deadstonesModule.guess(toSignMap(grid), options);
    return normalizeVertices(result);
  } catch {
    return [];
  }
};

export interface ShapePattern {
  name: string;
  size: number;
  grid: number[][];
  type: 'BAD' | 'GOOD';
}

type SignedVertex = [[number, number], number];

const toSignedVertices = (pattern: ShapePattern): { anchors: [number, number][]; vertices: SignedVertex[] } => {
  const vertices: SignedVertex[] = [];
  const anchors: [number, number][] = [];

  pattern.grid.forEach((row, y) => {
    row.forEach((value, x) => {
      if (value === 2) return;
      const signed = value === 0 ? 0 : value;
      const entry: SignedVertex = [[x, y], signed];
      vertices.push(entry);
      if (anchors.length === 0 && signed !== 0) anchors.push([x, y]);
    });
  });

  return { anchors, vertices };
};

export const getPatternMatches = (grid: StoneColor[][], patterns: ShapePattern[]): string[] => {
  const matcherModule = resolveModule(boardMatcher) as any;
  if (!matcherModule) return [];

  try {
    const data = toSignMap(grid);
    const matches: string[] = [];
    patterns.forEach((pattern) => {
      const { anchors, vertices } = toSignedVertices(pattern);
      if (anchors.length === 0) return;
      const matchPattern = {
        name: pattern.name,
        vertices,
        anchors: anchors.map((vertex) => [vertex, 1]),
      };

      const generator = matcherModule.matchShape?.(data, anchors[0], matchPattern);
      if (generator && typeof generator.next === 'function') {
        for (const _match of generator) {
          matches.push(pattern.name);
        }
      }
    });

    return matches;
  } catch {
    return [];
  }
};

export const getMoveName = (
  grid: StoneColor[][],
  sign: number,
  vertex: Coordinate
): string | null => {
  const matcherModule = resolveModule(boardMatcher) as any;
  if (!matcherModule?.nameMove) return null;

  try {
    const data = toSignMap(grid);
    return matcherModule.nameMove(data, sign, [vertex.x, vertex.y], {
      library: patternLibrary,
    });
  } catch {
    return null;
  }
};

export const createBoardForMove = (grid: StoneColor[][]): any | null => {
  const board = createSabakiBoard(grid);
  return board ?? null;
};
