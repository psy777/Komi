export enum StoneColor {
  BLACK = 'B',
  WHITE = 'W',
  EMPTY = '.',
}

export interface Coordinate {
  x: number;
  y: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'model';
  content: string;
  timestamp: number;
}

export interface GameNode {
  id: string;
  parentId: string | null;
  childrenIds: string[];
  move?: {
    color: StoneColor;
    x: number;
    y: number;
  };
  properties: Record<string, string>;
  comment?: string;
  chatHistory?: ChatMessage[];
}

export interface GameTree {
  nodes: Record<string, GameNode>;
  rootId: string;
  currentId: string;
}

export interface BoardState {
  grid: StoneColor[][];
  captures: {
    B: number;
    W: number;
  };
  lastMove: Coordinate | null;
  koPoint: Coordinate | null;
}

export enum GameTool {
  PLAY = 'PLAY',
  EDIT = 'EDIT',
  SCORE = 'SCORE',
}
