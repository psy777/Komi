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

// --- Analysis Orchestration Types (Phase 4b UI) ---

export type AnalysisPhase = 'engine' | 'semantic' | 'commentary' | 'complete';

export interface AnalysisProgressData {
  phase: AnalysisPhase;
  current: number;
  total: number;
  message?: string;
}

export interface AnalysisSummary {
  totalMoves: number;
  classificationCounts: Record<MoveClassification, number>;
  phaseBreakdown: Record<GamePhase, number>;
  themes: string[];
}

export interface FullGameAnalysis {
  sgfHash: string;
  playerLevel: PlayerLevel;
  positions: KataGoAnalysis[];
  annotations: SemanticAnnotation[];
  keyMoments: SemanticAnnotation[];
  summary: AnalysisSummary;
  /** Deep analysis of ambiguous positions (Phase D) */
  deepAnalysis?: DeepAnalysisResult;
  analyzedAt: number;
}

// --- Semantic Analysis Types (Phase 2) ---

export type MoveClassification = 'brilliant' | 'good' | 'neutral' | 'inaccuracy' | 'mistake' | 'blunder';

export type MistakeType = 'direction' | 'shape' | 'reading' | 'timing' | 'overplay' | 'passivity';

export type GamePhase = 'opening' | 'middlegame' | 'endgame';

/** Pattern/formation detected by boardmatcher */
export interface PatternInfo {
  name: string;
  category: 'opening' | 'approach' | 'shape' | 'joseki' | 'tactical' | 'placement' | 'connection';
  url?: string;
}

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
  /** Pattern/formation detected at this move (e.g. "Tiger's Mouth", "3-3 Point Invasion") */
  pattern?: PatternInfo;
}

/** Structured mistake explanation with comparative analysis (Phase 5a) */
export interface MistakeExplanation {
  moveNumber: number;
  classification: MoveClassification;
  mistakeType?: MistakeType;
  playedMove: string;
  engineMove: string;
  enginePV: string[];
  scoreDelta: number;
  winrateDelta: number;
  gamePhase: GamePhase;
  explanation: string | null;
}

// --- Tutoring Pipeline Types (Phase B) ---

/** Structured tutoring output from the Gemini prompt pipeline */
export interface TutoringExplanation {
  moveNumber: number;
  playerLevel: PlayerLevel;
  /** One-line summary, e.g. "Black's attachment was too aggressive" */
  headline: string;
  /** Main NL explanation (2-4 paragraphs, level-adapted) */
  explanation: string;
  /** Description of the actual move in context */
  whatWasPlayed: string;
  /** Description of the engine's recommendation (omitted for good/brilliant moves) */
  whatWasBetter?: string;
  /** Go concept being taught, e.g. "shape", "direction of play" */
  concept?: string;
  /** Prompt for deeper exploration, e.g. "What happens after the cut at D10?" */
  followUpHint?: string;
}

/** Input context assembled by the tutoring pipeline's context builder */
export interface TutoringContext {
  annotation: SemanticAnnotation;
  playerLevel: PlayerLevel;
  /** Board state serialized as relevant context (move sequence, score, etc.) */
  gameContext: {
    totalMoves: number;
    komi: number;
    currentScore: number;
    currentWinrate: number;
  };
  /** Pattern info from boardmatcher, if detected */
  pattern?: PatternInfo;
  /** Top engine alternatives with scores */
  engineAlternatives: Array<{ move: string; scoreLead: number; winrate: number }>;
  /** Neighboring annotations for narrative flow (previous/next key moments) */
  surroundingMoments?: {
    previous?: { moveNumber: number; classification: MoveClassification };
    next?: { moveNumber: number; classification: MoveClassification };
  };
  /** Deep analysis results for ambiguous positions (Phase D) */
  deepAnalysis?: VariationExploration;
}

// --- Deep Analysis Types (Phase D) ---

/** Evaluation of a single candidate continuation */
export interface VariationEval {
  /** The candidate move played */
  move: string;
  /** Score lead after this move (from mover's POV) */
  scoreLead: number;
  /** Win rate after this move */
  winrate: number;
  /** Engine's best response to this candidate */
  bestResponse?: string;
  /** Score after best response */
  scoreAfterResponse?: number;
}

/** Deep analysis of an ambiguous position — compares candidate continuations */
export interface VariationExploration {
  moveNumber: number;
  /** Why this position was flagged for deeper analysis */
  reason: 'close_candidates' | 'complex_fighting' | 'critical_moment';
  /** Score gap between top-2 candidates (smaller = more ambiguous) */
  ambiguityGap: number;
  /** Evaluated candidate continuations */
  variations: VariationEval[];
  /** Which candidate comes out best after deeper analysis */
  bestVariation: string;
  /** Score difference between best and worst explored variation */
  variationSpread: number;
}

/** Budget configuration for deep analysis */
export interface DeepAnalysisBudget {
  /** Max positions to explore (default 8) */
  maxPositions: number;
  /** Max candidate moves to evaluate per position (default 3) */
  maxCandidatesPerPosition: number;
  /** Whether to also query the opponent's response (doubles API calls) */
  includeResponses: boolean;
}

/** Full result of the deep analysis pass */
export interface DeepAnalysisResult {
  /** Map from move number to its variation exploration */
  explorations: Map<number, VariationExploration>;
  /** Total KataGo API calls made */
  apiCallsUsed: number;
  /** Positions that were identified as ambiguous */
  ambiguousCount: number;
  /** Positions actually explored (may be less than ambiguous due to budget) */
  exploredCount: number;
}
