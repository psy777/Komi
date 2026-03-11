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

// --- KataGo Analysis Types ---

/** Per-move candidate from KataGo analysis */
export interface KataGoMoveInfo {
  move: string;               // GTP coordinate (e.g., "D4")
  visits: number;             // Search visits for this move
  winrate: number;            // Win probability [0, 1]
  scoreLead: number;          // Expected score lead
  prior: number;              // Neural net policy prior [0, 1]
  pv: string[];               // Principal variation (best continuation)
}

/** Root position evaluation from KataGo */
export interface KataGoRootInfo {
  winrate: number;            // Current win probability [0, 1]
  scoreLead: number;          // Current score estimate (positive = current player leads)
  visits: number;             // Total search visits
}

/** Full KataGo analysis result for a position */
export interface KataGoAnalysis {
  moveInfos: KataGoMoveInfo[];   // Top N candidate moves, sorted by visits
  rootInfo: KataGoRootInfo;      // Overall position evaluation
  ownership: number[] | null;    // 361 values (-1 to 1), null if unavailable
  turnNumber: number;            // Move number in the game
  currentPlayer: StoneColor;     // Whose turn it is
}

/** Proxy-specific response shape (katago-proxy.vercel.app) */
export interface KataGoProxyResponse {
  bot_move: string;
  diagnostics: {
    best_ten: Array<{ move: string; psv: number; score?: number; winrate?: number; winprob?: number }>;
    score: number;
    winprob: number;
    bot_move: string;
  };
  request_id?: string;
}

/** Cached analysis for a full game */
export interface GameAnalysisResult {
  sgfHash: string;
  analyzedAt: number;
  positions: Map<number, KataGoAnalysis> | Record<number, KataGoAnalysis>;
}

// --- Semantic Analysis Types (Phase 2) ---

// --- Player Level Types (Phase 3) ---

export type PlayerLevel = 'beginner' | 'intermediate' | 'advanced' | 'strong';

export interface PlayerLevelConfig {
  level: PlayerLevel;
  label: string;
  rankRange: string;
  vocabulary: 'basic' | 'standard' | 'full' | 'professional';
  focusAreas: string[];
  style: {
    useAnalogies: boolean;
    encouragement: boolean;
    showExactValues: boolean;
    technicalDepth: 'shallow' | 'moderate' | 'deep' | 'expert';
  };
}

// --- Semantic Analysis Types (Phase 2) ---

export type MoveClassification = 'brilliant' | 'good' | 'neutral' | 'inaccuracy' | 'mistake' | 'blunder';

export type MistakeType = 'direction' | 'shape' | 'reading' | 'timing' | 'overplay' | 'passivity';

export type GamePhase = 'opening' | 'middlegame' | 'endgame';

/** Semantic annotation for a single move in a game */
export interface SemanticAnnotation {
  moveNumber: number;
  classification: MoveClassification;
  mistakeType?: MistakeType;
  scoreDelta: number;
  winrateDelta: number;
  gamePhase: GamePhase;
  themes: string[];
  engineTopMove: string;
  enginePV: string[];
  isKeyMoment: boolean;
  commentary?: string;
}
