import React, { useState, useEffect, useRef, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { FaFolderOpen, FaSave, FaChevronLeft, FaChevronRight, FaStepBackward, FaStepForward, FaCodeBranch, FaInfoCircle, FaUserCircle, FaBars, FaChevronUp, FaChevronDown, FaTimes, FaLink } from 'react-icons/fa';
import GoBoard from './GoBoard';
import type { MoveAnnotation, PVStone } from './GoBoard';
import GeminiChat from './GeminiChat';
import AnalysisProgress from './AnalysisProgress';
import ScoreGraph from './ScoreGraph';
import KeyMomentNav from './KeyMomentNav';
import MistakePanel from './MistakePanel';
import { clearExplanationCache } from './mistakeExplainer';
import ConceptTagFilter from './ConceptTagFilter';
import { StoneColor, BoardState, GameTree, GameNode, ChatMessage, AnalysisProgressData, FullGameAnalysis, SemanticAnnotation } from './types';
import { createEmptyGrid, playMove } from './goLogic';
import { parseSGF, generateSGF } from './sgfParser';
import { summarizeCommentary } from './geminiService';
import { batchAnalyze } from './katagoService';
import { classifyMove, normalizeAndClassify, detectGamePhase, detectThemes, identifyKeyMoments, estimatePlayerLevel } from './semanticExtractor';
import { parseOgsGameId, fetchOgsSgf } from './ogsService';

const App: React.FC = () => {
  // --- State ---
  const [gameTree, setGameTree] = useState<GameTree>(() => {
    const rootId = uuidv4();
    return {
      nodes: {
        [rootId]: { id: rootId, parentId: null, childrenIds: [], properties: {}, chatHistory: [] }
      },
      rootId,
      currentId: rootId,
    };
  });

  const [boardState, setBoardState] = useState<BoardState>({
    grid: createEmptyGrid(),
    captures: { B: 0, W: 0 },
    lastMove: null,
    koPoint: null,
  });

  const [currentPlayer, setCurrentPlayer] = useState<StoneColor>(StoneColor.BLACK);
  
  // UI Toggles
  const [showStats, setShowStats] = useState(false);
  const [chatExpanded, setChatExpanded] = useState(window.innerWidth >= 768);

  // Input State for Move Number
  const [moveInput, setMoveInput] = useState<string>("0");
  const scrollThrottleRef = useRef<number>(0);

  // State to track if an interaction needs summarization upon leaving the node
  const [interactionToSummarize, setInteractionToSummarize] = useState<{nodeId: string, question: string, answer: string} | null>(null);

  // Analysis state
  const [analysisProgress, setAnalysisProgress] = useState<AnalysisProgressData | null>(null);
  const [analysisResult, setAnalysisResult] = useState<FullGameAnalysis | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  // PV visualization state
  const [pvStones, setPvStones] = useState<PVStone[]>([]);
  // Ownership heatmap toggle
  const [showOwnership, setShowOwnership] = useState(false);
  // Concept tag filter state
  const [activeThemes, setActiveThemes] = useState<Set<string>>(new Set());

  // OGS import state
  const [showOgsImport, setShowOgsImport] = useState(false);
  const [ogsUrl, setOgsUrl] = useState('');
  const [ogsLoading, setOgsLoading] = useState(false);
  const [ogsError, setOgsError] = useState<string | null>(null);

  // --- Derived State for Metadata ---
  const rootNode = gameTree.nodes[gameTree.rootId];
  const blackPlayer = rootNode.properties['PB'] || 'Black';
  const whitePlayer = rootNode.properties['PW'] || 'White';
  const blackRank = rootNode.properties['BR'] || '';
  const whiteRank = rootNode.properties['WR'] || '';
  const gameResult = rootNode.properties['RE'] || '?';
  
  const komiString = rootNode.properties['KM'] || '6.5';
  let parsedKomi = parseFloat(komiString);
  if (isNaN(parsedKomi)) parsedKomi = 6.5;
  const komi = parsedKomi;

  // Calculate current depth (Move Number)
  const currentDepth = React.useMemo(() => {
    let depth = 0;
    let ptr = gameTree.currentId;
    while (gameTree.nodes[ptr]?.parentId) {
        depth++;
        ptr = gameTree.nodes[ptr].parentId!;
    }
    return depth;
  }, [gameTree, gameTree.currentId]);

  useEffect(() => {
    setMoveInput(currentDepth.toString());
  }, [currentDepth]);

  useEffect(() => {
    const replayGame = () => {
      let tempState: BoardState = {
        grid: createEmptyGrid(),
        captures: { B: 0, W: 0 },
        lastMove: null,
        koPoint: null,
      };
      
      const path: string[] = [];
      let ptr = gameTree.currentId;
      while (ptr) {
        path.unshift(ptr);
        ptr = gameTree.nodes[ptr].parentId!;
      }

      for (const nodeId of path) {
        const node = gameTree.nodes[nodeId];
        if (node.move) {
          const result = playMove(tempState, node.move.x, node.move.y, node.move.color);
          if (result.valid) {
            tempState = result.newState;
          }
        }
      }

      setBoardState(tempState);
      
      const currentNode = gameTree.nodes[gameTree.currentId];
      if (currentNode.move) {
        setCurrentPlayer(currentNode.move.color === StoneColor.BLACK ? StoneColor.WHITE : StoneColor.BLACK);
      } else {
        setCurrentPlayer(StoneColor.BLACK);
        if (currentNode.parentId) {
            const p = gameTree.nodes[currentNode.parentId];
            if(p.move && p.move.color === StoneColor.BLACK) setCurrentPlayer(StoneColor.WHITE);
        }
      }
    };
    replayGame();
  }, [gameTree, gameTree.currentId]);

  useEffect(() => {
    if (interactionToSummarize && interactionToSummarize.nodeId !== gameTree.currentId) {
        const { nodeId, question, answer } = interactionToSummarize;
        summarizeCommentary(question, answer).then(summary => {
            if (!summary) return;
            setGameTree(prev => {
                const node = prev.nodes[nodeId];
                if (!node) return prev;
                const newComment = node.comment 
                    ? `${node.comment}\n\n[AI Summary]: ${summary}` 
                    : `[AI Summary]: ${summary}`;
                return {
                    ...prev,
                    nodes: { ...prev.nodes, [nodeId]: { ...node, comment: newComment } }
                };
            });
        });
        setInteractionToSummarize(null);
    }
  }, [gameTree.currentId, interactionToSummarize]);

  const handleIntersectionClick = (x: number, y: number) => {
    const currentNode = gameTree.nodes[gameTree.currentId];
    const existingChildId = currentNode.childrenIds.find(childId => {
      const child = gameTree.nodes[childId];
      return child.move && child.move.x === x && child.move.y === y && child.move.color === currentPlayer;
    });

    if (existingChildId) {
      setGameTree(prev => ({ ...prev, currentId: existingChildId }));
      return;
    }

    const result = playMove(boardState, x, y, currentPlayer);
    if (!result.valid) return;

    const newNodeId = uuidv4();
    const newNode: GameNode = {
      id: newNodeId,
      parentId: gameTree.currentId,
      childrenIds: [],
      move: { color: currentPlayer, x, y },
      properties: {},
      chatHistory: [],
    };

    setGameTree(prev => {
      const parent = prev.nodes[prev.currentId];
      return {
        ...prev,
        nodes: {
          ...prev.nodes,
          [prev.currentId]: {
            ...parent,
            childrenIds: [...parent.childrenIds, newNodeId],
          },
          [newNodeId]: newNode,
        },
        currentId: newNodeId,
      };
    });
  };

  const handleFirst = () => setGameTree(prev => ({ ...prev, currentId: prev.rootId }));
  const handlePrev = () => {
    const current = gameTree.nodes[gameTree.currentId];
    if (current.parentId) setGameTree(prev => ({ ...prev, currentId: current.parentId! }));
  };
  const handleNext = (childIndex: number = 0) => {
    const current = gameTree.nodes[gameTree.currentId];
    if (current.childrenIds.length > 0) {
      const targetId = current.childrenIds[childIndex] || current.childrenIds[0];
      setGameTree(prev => ({ ...prev, currentId: targetId }));
    }
  };
  const handleLast = () => {
    let ptr = gameTree.currentId;
    while (true) {
        const node = gameTree.nodes[ptr];
        if (node.childrenIds.length === 0) break;
        ptr = node.childrenIds[0];
    }
    setGameTree(prev => ({ ...prev, currentId: ptr }));
  };

  const handleJumpToMove = (targetMove: number) => {
    if (isNaN(targetMove) || targetMove < 0) return;
    const path: string[] = [];
    let currId: string | null = gameTree.currentId;
    while (currId) {
        path.unshift(currId);
        currId = gameTree.nodes[currId].parentId;
    }
    if (targetMove < path.length) {
        setGameTree(prev => ({ ...prev, currentId: path[targetMove] }));
        return;
    }
    let ptr = gameTree.currentId;
    let currentDepthPtr = path.length - 1;
    while (currentDepthPtr < targetMove) {
        const node = gameTree.nodes[ptr];
        if (node.childrenIds.length === 0) break;
        ptr = node.childrenIds[0];
        currentDepthPtr++;
    }
    setGameTree(prev => ({ ...prev, currentId: ptr }));
  };

  const handleMoveInputSubmit = (e: React.FormEvent) => {
      e.preventDefault();
      handleJumpToMove(parseInt(moveInput, 10));
  };

  const handleMoveBoxWheel = (e: React.WheelEvent) => {
      const now = Date.now();
      if (now - scrollThrottleRef.current < 50) return;
      scrollThrottleRef.current = now;
      if (e.deltaY > 0) handleNext();
      else if (e.deltaY < 0) handlePrev();
  };

  const handleChatUpdate = (nodeId: string, newHistory: ChatMessage[]) => {
    setGameTree(prev => ({
        ...prev,
        nodes: { ...prev.nodes, [nodeId]: { ...prev.nodes[nodeId], chatHistory: newHistory } }
    }));
  };

  const handleInteractionComplete = (nodeId: string, question: string, answer: string) => {
      setInteractionToSummarize({ nodeId, question, answer });
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      if (content) setGameTree(parseSGF(content));
    };
    reader.readAsText(file);
  };

  const handleOgsImport = async () => {
    const gameId = parseOgsGameId(ogsUrl);
    if (!gameId) {
      setOgsError('Invalid OGS URL or game ID. Use a link like online-go.com/game/12345 or just the numeric ID.');
      return;
    }
    setOgsLoading(true);
    setOgsError(null);
    try {
      const sgf = await fetchOgsSgf(gameId);
      setGameTree(parseSGF(sgf));
      setShowOgsImport(false);
      setOgsUrl('');
      setAnalysisResult(null);
      setAnalysisProgress(null);
    } catch (err) {
      setOgsError(err instanceof Error ? err.message : 'Failed to fetch game from OGS.');
    } finally {
      setOgsLoading(false);
    }
  };

  const handleSaveSGF = () => {
      const sgf = generateSGF(gameTree);
      const blob = new Blob([sgf], { type: 'application/x-go-sgf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'game.sgf';
      a.click();
      URL.revokeObjectURL(url);
  };

  // --- Analysis Handler ---
  const handleAnalyzeGame = useCallback(async () => {
    if (isAnalyzing) return;

    // Walk the main line to collect all moves
    const mainLine: GameNode[] = [];
    let ptr = gameTree.rootId;
    while (ptr) {
      const node = gameTree.nodes[ptr];
      mainLine.push(node);
      ptr = node.childrenIds[0]; // Follow main line
    }

    const moveNodes = mainLine.filter(n => n.move);
    if (moveNodes.length < 2) return;

    setIsAnalyzing(true);
    setAnalysisResult(null);
    clearExplanationCache();

    const GTP_COLS = 'ABCDEFGHJKLMNOPQRST';
    const toGtp = (x: number, y: number) => `${GTP_COLS[x]}${19 - y}`;

    // Build cumulative move lists for each position (including empty board)
    const positions: Array<{ moves: string[]; komi: number; currentPlayer: StoneColor }> = [];
    const gtpMoves: string[] = [];

    // Position 0: empty board
    positions.push({ moves: [], komi, currentPlayer: StoneColor.BLACK });

    for (const node of moveNodes) {
      const m = node.move!;
      // Proxy expects flat ["B", "D4", "W", "Q16"] format, not ["B D4", "W Q16"]
      gtpMoves.push(m.color === StoneColor.BLACK ? 'B' : 'W', toGtp(m.x, m.y));
      const nextPlayer = m.color === StoneColor.BLACK ? StoneColor.WHITE : StoneColor.BLACK;
      positions.push({ moves: [...gtpMoves], komi, currentPlayer: nextPlayer });
    }

    // Phase 1: Engine analysis
    const totalPositions = positions.length;
    setAnalysisProgress({ phase: 'engine', current: 0, total: totalPositions });

    const analysisResults = await batchAnalyze(positions, 3, (completed, total) => {
      setAnalysisProgress({ phase: 'engine', current: completed, total });
    });

    // Phase 2: Semantic classification
    setAnalysisProgress({ phase: 'semantic', current: 0, total: moveNodes.length });

    const annotations: SemanticAnnotation[] = [];
    const classificationCounts: Record<string, number> = {
      brilliant: 0, good: 0, neutral: 0, inaccuracy: 0, mistake: 0, blunder: 0,
    };
    const phaseBreakdown: Record<string, number> = { opening: 0, middlegame: 0, endgame: 0 };
    const allThemes: Set<string> = new Set();

    for (let i = 0; i < moveNodes.length; i++) {
      const evalBefore = analysisResults[i];
      const evalAfter = analysisResults[i + 1];

      if (!evalBefore || !evalAfter) {
        setAnalysisProgress({ phase: 'semantic', current: i + 1, total: moveNodes.length });
        continue;
      }

      const { classification, scoreDelta, winrateDelta } = classifyMove(evalBefore, evalAfter);
      const moveNode = moveNodes[i];
      const moveGtp = toGtp(moveNode.move!.x, moveNode.move!.y);

      // Board occupancy estimate
      const stoneCount = i + 1;
      const boardOccupancy = stoneCount / 361;

      const gamePhase = detectGamePhase(i + 1, evalBefore.ownership, boardOccupancy);
      const themes = detectThemes(evalBefore, evalAfter, evalBefore.moveInfos[0]);
      const engineTopMove = evalBefore.moveInfos[0]?.move ?? moveGtp;
      const enginePV = evalBefore.moveInfos[0]?.pv ?? [engineTopMove];

      classificationCounts[classification] = (classificationCounts[classification] ?? 0) + 1;
      phaseBreakdown[gamePhase] = (phaseBreakdown[gamePhase] ?? 0) + 1;
      themes.forEach(t => allThemes.add(t));

      annotations.push({
        moveNumber: i + 1,
        classification,
        scoreDelta,
        winrateDelta,
        gamePhase,
        themes,
        engineTopMove,
        enginePV,
        isKeyMoment: false,
      });

      setAnalysisProgress({ phase: 'semantic', current: i + 1, total: moveNodes.length });
    }

    // Normalize score deltas to remove proxy per-move drift, then re-classify
    const normalized = normalizeAndClassify(annotations);

    // Identify key moments
    const annotationsWithKeys = identifyKeyMoments(normalized);
    const keyMoments = annotationsWithKeys.filter(a => a.isKeyMoment);
    const playerLevel = estimatePlayerLevel(annotationsWithKeys);

    // Recount classifications after normalization
    for (const cls of Object.keys(classificationCounts)) {
      classificationCounts[cls] = 0;
    }
    for (const ann of annotationsWithKeys) {
      classificationCounts[ann.classification] = (classificationCounts[ann.classification] ?? 0) + 1;
    }

    const result: FullGameAnalysis = {
      sgfHash: '',
      playerLevel,
      positions: analysisResults.filter((r): r is NonNullable<typeof r> => r !== null),
      annotations: annotationsWithKeys,
      keyMoments,
      summary: {
        totalMoves: moveNodes.length,
        classificationCounts: classificationCounts as any,
        phaseBreakdown: phaseBreakdown as any,
        themes: Array.from(allThemes),
      },
      analyzedAt: Date.now(),
    };

    setAnalysisResult(result);
    setAnalysisProgress({ phase: 'complete', current: moveNodes.length, total: moveNodes.length });
    setIsAnalyzing(false);
  }, [gameTree, komi, isAnalyzing]);

  // Compute move annotations for GoBoard from analysis results
  const moveAnnotations: MoveAnnotation[] = React.useMemo(() => {
    if (!analysisResult) return [];

    // Walk main line to build moveNumber → (x, y) mapping
    const mainLine: GameNode[] = [];
    let ptr: string | undefined = gameTree.rootId;
    while (ptr) {
      const node = gameTree.nodes[ptr];
      mainLine.push(node);
      ptr = node.childrenIds[0];
    }

    return analysisResult.annotations
      .filter(ann => ann.classification !== 'neutral' && ann.classification !== 'good')
      .map(ann => {
        const node = mainLine[ann.moveNumber]; // moveNumber is 1-indexed, mainLine[0] is root
        if (!node?.move) return null;
        return {
          x: node.move.x,
          y: node.move.y,
          classification: ann.classification,
          moveNumber: ann.moveNumber,
        };
      })
      .filter((a): a is MoveAnnotation => a !== null);
  }, [analysisResult, gameTree]);

  // GTP coordinate → board coordinate conversion for PV display
  const GTP_COLS = 'ABCDEFGHJKLMNOPQRST';
  const gtpToBoard = useCallback((gtp: string): { x: number; y: number } | null => {
    if (!gtp || gtp.length < 2) return null;
    const col = GTP_COLS.indexOf(gtp[0].toUpperCase());
    const row = parseInt(gtp.slice(1), 10);
    if (col < 0 || isNaN(row)) return null;
    return { x: col, y: 19 - row };
  }, []);

  // Show PV for a given annotation
  const handleShowPV = useCallback((annotation: SemanticAnnotation | null) => {
    if (!annotation || !annotation.enginePV || annotation.enginePV.length === 0) {
      setPvStones([]);
      return;
    }
    // Determine starting color from the engine's perspective (the player to move at that position)
    // The annotation is for a move that was played, so the engine PV starts with the move the engine recommends
    // The engine top move is what the current player should have played, so PV starts with that player's color
    const moveNode = (() => {
      const mainLine: GameNode[] = [];
      let ptr: string | undefined = gameTree.rootId;
      while (ptr) {
        mainLine.push(gameTree.nodes[ptr]);
        ptr = gameTree.nodes[ptr].childrenIds[0];
      }
      return mainLine[annotation.moveNumber];
    })();
    const startColor = moveNode?.move?.color === StoneColor.BLACK ? 'B' : 'W';

    const stones: PVStone[] = [];
    let color: 'B' | 'W' = startColor === 'B' ? 'W' : 'B'; // PV is what should have been played instead, starts with same player
    // Actually: enginePV is the best continuation from the position BEFORE the move was played.
    // So the first move of PV is the engine's recommended move for the current player.
    color = moveNode?.move?.color === StoneColor.BLACK ? 'B' : 'W';
    // Wait — the move at annotation.moveNumber was played by some color. The enginePV is what
    // the engine thinks should have been played instead. So PV[0] is the same player's best move.
    // Subsequent moves alternate.
    for (let i = 0; i < annotation.enginePV.length; i++) {
      const coord = gtpToBoard(annotation.enginePV[i]);
      if (!coord) continue;
      stones.push({ x: coord.x, y: coord.y, color, order: i + 1 });
      color = color === 'B' ? 'W' : 'B';
    }
    setPvStones(stones);
  }, [gameTree, gtpToBoard]);

  // Clear PV when navigating
  useEffect(() => {
    setPvStones([]);
  }, [gameTree.currentId]);

  // Get ownership data for current position
  const currentOwnership = React.useMemo(() => {
    if (!analysisResult || !showOwnership) return null;
    // currentDepth corresponds to position index in analysisResult.positions
    const pos = analysisResult.positions[currentDepth];
    return pos?.ownership ?? null;
  }, [analysisResult, currentDepth, showOwnership]);

  // Compute highlighted moves for concept filter
  const highlightedMoves = React.useMemo(() => {
    if (!analysisResult || activeThemes.size === 0) return undefined;
    const moves = new Set<number>();
    for (const ann of analysisResult.annotations) {
      if (ann.themes.some(t => activeThemes.has(t))) {
        moves.add(ann.moveNumber);
      }
    }
    return moves;
  }, [analysisResult, activeThemes]);

  // Selected annotation for MistakePanel (non-neutral/non-good move at current position)
  const selectedAnnotation = React.useMemo(() => {
    if (!analysisResult) return null;
    const ann = analysisResult.annotations.find(a => a.moveNumber === currentDepth);
    if (!ann || ann.classification === 'neutral' || ann.classification === 'good') return null;
    return ann;
  }, [analysisResult, currentDepth]);

  // Played move GTP coordinate for the selected annotation
  const selectedPlayedMove = React.useMemo(() => {
    if (!selectedAnnotation) return '';
    const mainLine: GameNode[] = [];
    let ptr: string | undefined = gameTree.rootId;
    while (ptr) {
      mainLine.push(gameTree.nodes[ptr]);
      ptr = gameTree.nodes[ptr].childrenIds[0];
    }
    const node = mainLine[selectedAnnotation.moveNumber];
    if (!node?.move) return '';
    return `${GTP_COLS[node.move.x]}${19 - node.move.y}`;
  }, [selectedAnnotation, gameTree]);

  const handleToggleTheme = useCallback((theme: string) => {
    setActiveThemes(prev => {
      const next = new Set(prev);
      if (next.has(theme)) next.delete(theme);
      else next.add(theme);
      return next;
    });
  }, []);

  const handleClearThemes = useCallback(() => {
    setActiveThemes(new Set());
  }, []);

  // Has ownership data available at all?
  const hasOwnershipData = React.useMemo(() => {
    if (!analysisResult) return false;
    return analysisResult.positions.some(p => p.ownership && p.ownership.length === 361);
  }, [analysisResult]);

  const currentNode = gameTree.nodes[gameTree.currentId];
  const nextNodes = currentNode.childrenIds.map(id => gameTree.nodes[id]);

  return (
    <div className="h-screen bg-slate-950 text-slate-100 font-sans flex flex-col overflow-hidden relative">
      
      {/* Menu Data Overlay (Top of Screen) */}
      {showStats && (
        <div className="absolute inset-x-0 top-0 z-50 bg-slate-900/95 backdrop-blur-md border-b border-slate-700 shadow-2xl p-6 animate-in slide-in-from-top duration-300">
            <div className="max-w-4xl mx-auto">
                <div className="flex items-center justify-between mb-8">
                    <h2 className="text-xs font-bold text-slate-400 uppercase tracking-[0.2em]">Game Information</h2>
                    <button onClick={() => setShowStats(false)} className="p-2 hover:bg-slate-800 rounded-full transition-colors text-slate-400 hover:text-white">
                        <FaTimes size={20} />
                    </button>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                    <div className="space-y-4">
                        <div className="flex items-center justify-between p-4 bg-slate-800/50 rounded-xl border border-slate-700/50">
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 rounded-full bg-slate-950 flex items-center justify-center border border-slate-800">
                                    <FaUserCircle className="text-slate-600 text-2xl" />
                                </div>
                                <div>
                                    <div className="font-bold text-lg text-white">{blackPlayer}</div>
                                    <div className="text-xs text-slate-500 uppercase tracking-tighter">{blackRank || 'No Rank'}</div>
                                </div>
                            </div>
                            <div className="text-emerald-400 font-mono font-bold text-2xl bg-slate-950 px-3 py-1 rounded-lg border border-slate-800 shadow-inner">
                                {boardState.captures.B}
                            </div>
                        </div>
                        <div className="flex items-center justify-between p-4 bg-slate-800/50 rounded-xl border border-slate-700/50">
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 rounded-full bg-slate-200 flex items-center justify-center border border-slate-400">
                                    <FaUserCircle className="text-slate-600 text-2xl" />
                                </div>
                                <div>
                                    <div className="font-bold text-lg text-white">{whitePlayer}</div>
                                    <div className="text-xs text-slate-500 uppercase tracking-tighter">{whiteRank || 'No Rank'}</div>
                                </div>
                            </div>
                            <div className="text-slate-300 font-mono font-bold text-2xl bg-slate-950 px-3 py-1 rounded-lg border border-slate-800 shadow-inner">
                                {boardState.captures.W}
                            </div>
                        </div>
                    </div>
                    <div className="flex flex-col justify-center space-y-4">
                        <div className="bg-slate-950/50 p-6 rounded-xl border border-slate-800 text-sm">
                            <div className="flex justify-between mb-3"><span className="text-slate-500 font-medium">Komi:</span> <span className="text-emerald-400 font-bold">{komi}</span></div>
                            <div className="flex justify-between mb-3"><span className="text-slate-500 font-medium">Result:</span> <span className="text-purple-400 font-bold">{gameResult}</span></div>
                            <div className="flex justify-between border-t border-slate-800 pt-3"><span className="text-slate-500 font-medium">Status:</span> <span className="text-slate-300 font-bold">{currentPlayer === StoneColor.BLACK ? 'Black' : 'White'}'s turn</span></div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
      )}

      {/* OGS Import Modal */}
      {showOgsImport && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => !ogsLoading && setShowOgsImport(false)}>
          <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl p-6 w-full max-w-md mx-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-bold text-slate-300 uppercase tracking-widest">Import from OGS</h2>
              <button onClick={() => setShowOgsImport(false)} className="p-1.5 hover:bg-slate-800 rounded-full text-slate-500 hover:text-white transition-colors" disabled={ogsLoading}>
                <FaTimes size={14} />
              </button>
            </div>
            <p className="text-xs text-slate-500 mb-4">Paste an OGS game link or numeric game ID.</p>
            <form onSubmit={(e) => { e.preventDefault(); handleOgsImport(); }} className="space-y-3">
              <input
                type="text"
                value={ogsUrl}
                onChange={e => { setOgsUrl(e.target.value); setOgsError(null); }}
                placeholder="https://online-go.com/game/12345"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500/30 transition-all"
                autoFocus
                disabled={ogsLoading}
              />
              {ogsError && (
                <p className="text-xs text-red-400">{ogsError}</p>
              )}
              <button
                type="submit"
                disabled={ogsLoading || !ogsUrl.trim()}
                className={`w-full py-2.5 rounded-lg text-sm font-semibold transition-all ${
                  ogsLoading || !ogsUrl.trim()
                    ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                    : 'bg-amber-600 hover:bg-amber-500 text-white'
                }`}
              >
                {ogsLoading ? 'Fetching game...' : 'Import Game'}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Navbar */}
      <header className="h-12 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-4 shadow-md z-20 shrink-0">
        <div className="flex items-center">
            <h1 className="text-2xl font-bold italic tracking-tight text-white font-google">komi</h1>
        </div>
        
        <div className="flex items-center gap-2 md:gap-4">
            <label className="flex items-center gap-1.5 cursor-pointer hover:bg-slate-800 text-slate-400 hover:text-white px-3 py-1.5 rounded-lg transition-all text-xs font-semibold">
                <FaFolderOpen className="text-emerald-400" />
                <span className="hidden sm:inline">Open</span>
                <input type="file" accept=".sgf" className="hidden" onChange={handleFileUpload} />
            </label>
            <button onClick={() => { setShowOgsImport(true); setOgsError(null); }} className="flex items-center gap-1.5 hover:bg-slate-800 text-slate-400 hover:text-white px-3 py-1.5 rounded-lg transition-all text-xs font-semibold">
                <FaLink className="text-amber-400" />
                <span className="hidden sm:inline">OGS</span>
            </button>
            <button onClick={handleSaveSGF} className="flex items-center gap-1.5 hover:bg-slate-800 text-slate-400 hover:text-white px-3 py-1.5 rounded-lg transition-all text-xs font-semibold">
                <FaSave className="text-blue-400" />
                <span className="hidden sm:inline">Save</span>
            </button>
            <button
              onClick={handleAnalyzeGame}
              disabled={isAnalyzing}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all text-xs font-semibold ${
                isAnalyzing
                  ? 'bg-emerald-900/50 text-emerald-400/60 cursor-not-allowed'
                  : 'bg-emerald-600 hover:bg-emerald-500 text-white'
              }`}
            >
              {isAnalyzing ? 'Analyzing...' : 'Analyze Game'}
            </button>
        </div>
      </header>

      {/* Main Layout */}
      <main className="flex-1 flex flex-col md:flex-row overflow-hidden bg-slate-950">
        
        {/* Left Panel: Board (Priority - maximized space) */}
        <div className="flex-1 flex flex-col min-w-0 relative">
            <div className="flex-1 overflow-hidden flex items-center justify-center p-2 sm:p-4">
                 <GoBoard
                    grid={boardState.grid}
                    lastMove={boardState.lastMove}
                    onIntersectionClick={handleIntersectionClick}
                    moveAnnotations={moveAnnotations}
                    pvStones={pvStones}
                    ownershipData={currentOwnership}
                    showOwnership={showOwnership}
                />
            </div>
        </div>

        {/* Sidebar Docked Layout */}
        <div className="w-full md:w-[400px] bg-slate-900 border-t md:border-t-0 md:border-l border-slate-800 flex flex-col shrink-0 z-20 h-auto md:h-full">
            
            {/* Analysis Panel */}
            {(analysisProgress || analysisResult) && (
              <div className="p-3 space-y-2 border-b border-slate-800 overflow-y-auto max-h-[50%] shrink-0">
                {analysisProgress && (
                  <AnalysisProgress progress={analysisProgress} result={analysisResult} />
                )}
                {analysisResult && (
                  <>
                    {/* Overlay toggles */}
                    <div className="flex gap-2">
                      {hasOwnershipData && (
                        <button
                          onClick={() => setShowOwnership(v => !v)}
                          className={`px-2.5 py-1 rounded-lg text-[10px] font-semibold transition-all border ${
                            showOwnership
                              ? 'bg-blue-600 border-blue-500 text-white'
                              : 'bg-slate-700/50 border-slate-600/50 text-slate-400 hover:bg-slate-700'
                          }`}
                        >
                          Territory
                        </button>
                      )}
                      {pvStones.length > 0 && (
                        <button
                          onClick={() => setPvStones([])}
                          className="px-2.5 py-1 rounded-lg text-[10px] font-semibold transition-all border bg-indigo-600 border-indigo-500 text-white"
                        >
                          Hide PV
                        </button>
                      )}
                    </div>
                    <ScoreGraph
                      annotations={analysisResult.annotations}
                      currentMove={currentDepth}
                      onMoveSelect={handleJumpToMove}
                      highlightedMoves={highlightedMoves}
                    />
                    <ConceptTagFilter
                      themes={analysisResult.summary.themes}
                      activeThemes={activeThemes}
                      onToggleTheme={handleToggleTheme}
                      onClearAll={handleClearThemes}
                    />
                    <KeyMomentNav
                      keyMoments={analysisResult.keyMoments}
                      currentMove={currentDepth}
                      onMoveSelect={handleJumpToMove}
                      activeThemes={activeThemes}
                      onShowPV={handleShowPV}
                    />
                    {selectedAnnotation && (
                      <MistakePanel
                        annotation={selectedAnnotation}
                        playedMove={selectedPlayedMove}
                        playerLevel={analysisResult.playerLevel}
                        onShowEngineLine={() => handleShowPV(selectedAnnotation)}
                      />
                    )}
                  </>
                )}
              </div>
            )}

            {/* Chat History Section (Expands UPWARD on mobile) */}
            <div className={`flex-1 overflow-hidden bg-slate-950/20 flex flex-col transition-all duration-300 ease-in-out ${chatExpanded ? 'h-[250px] md:h-full opacity-100' : 'h-0 opacity-0 md:opacity-100 md:h-full'}`}>
                 <GeminiChat 
                    currentNodeId={gameTree.currentId}
                    gameTree={gameTree}
                    boardState={boardState} 
                    currentPlayer={currentPlayer}
                    komi={komi}
                    messages={gameTree.nodes[gameTree.currentId].chatHistory || []}
                    onMessagesUpdate={(msgs) => handleChatUpdate(gameTree.currentId, msgs)}
                    onInteractionComplete={handleInteractionComplete}
                    minimized={!chatExpanded}
                    hideInput={true}
                 />
            </div>

            {/* Bottom Controls Hub */}
            <div className="bg-slate-900 flex flex-col border-t border-slate-800">
                
                {/* Mobile Expand Button (Above Chatbar) */}
                <div 
                    className="md:hidden flex items-center justify-center h-6 bg-slate-800/50 hover:bg-slate-800 cursor-pointer border-b border-slate-700/30 transition-colors"
                    onClick={() => setChatExpanded(!chatExpanded)}
                >
                    {chatExpanded ? <FaChevronDown className="text-slate-600 text-[10px]" /> : <FaChevronUp className="text-slate-600 text-[10px]" />}
                </div>

                {/* Gemini Chat Input Area (Directly above nav controls) */}
                <GeminiChat 
                    currentNodeId={gameTree.currentId}
                    gameTree={gameTree}
                    boardState={boardState} 
                    currentPlayer={currentPlayer}
                    komi={komi}
                    messages={gameTree.nodes[gameTree.currentId].chatHistory || []}
                    onMessagesUpdate={(msgs) => handleChatUpdate(gameTree.currentId, msgs)}
                    onToggleStats={() => setShowStats(!showStats)}
                    onInteractionComplete={handleInteractionComplete}
                    showOnlyInput={true}
                 />

                {/* Navigation Controls (Absolute Bottom of UI) */}
                <div className="p-3 bg-slate-900 flex flex-col gap-2 shrink-0">
                    <div className="flex items-center justify-between gap-1 max-w-sm mx-auto w-full">
                        <button onClick={handleFirst} className="p-2 rounded-lg hover:bg-slate-800 text-slate-500 hover:text-white transition-all" title="Start"><FaStepBackward size={14}/></button>
                        <button onClick={handlePrev} className="p-2 rounded-lg hover:bg-slate-800 text-slate-300 hover:text-white transition-all" title="Back"><FaChevronLeft size={16}/></button>
                        
                        <div className="flex items-center justify-center bg-slate-950 rounded-lg px-3 py-1 border border-slate-800 shadow-inner group cursor-ns-resize" onWheel={handleMoveBoxWheel}>
                            <span className="text-[10px] text-slate-600 font-black mr-2 uppercase tracking-widest select-none">Move</span>
                            <form onSubmit={handleMoveInputSubmit}>
                                <input 
                                className="w-10 bg-transparent text-center font-mono font-bold text-emerald-500 focus:outline-none text-base"
                                value={moveInput}
                                onChange={e => setMoveInput(e.target.value)}
                                onBlur={() => handleJumpToMove(parseInt(moveInput, 10))}
                                />
                            </form>
                        </div>

                        <button onClick={() => handleNext()} className="p-2 rounded-lg hover:bg-slate-800 text-slate-300 hover:text-white transition-all" title="Next"><FaChevronRight size={16}/></button>
                        <button onClick={handleLast} className="p-2 rounded-lg hover:bg-slate-800 text-slate-500 hover:text-white transition-all" title="End"><FaStepForward size={14}/></button>
                    </div>

                    {/* Variations */}
                    {nextNodes.length > 1 && (
                        <div className="flex items-center justify-center gap-1.5 overflow-x-auto py-1 border-t border-slate-800/40">
                            <span className="text-[9px] text-emerald-600 font-black uppercase tracking-[0.1em] mr-1 flex items-center shrink-0"><FaCodeBranch size={10} className="mr-1"/> Vars</span>
                            <div className="flex gap-1">
                                {nextNodes.map((node, idx) => (
                                    <button
                                    key={node.id}
                                    onClick={() => handleNext(idx)}
                                    className="h-6 min-w-[28px] px-2 flex items-center justify-center text-[10px] font-bold bg-slate-800 hover:bg-emerald-600 border border-slate-700 rounded-md text-slate-400 hover:text-white transition-all shadow-sm"
                                    >
                                        {String.fromCharCode(65 + idx)}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
                
                {/* Micro Footer */}
                <div className="px-4 py-1.5 border-t border-slate-800 text-[9px] text-slate-600 flex items-center justify-between bg-slate-950/40 shrink-0">
                    <span className="flex items-center gap-1 opacity-50"><FaInfoCircle /> v1.7.5</span>
                    <span className="opacity-40 font-medium">Stone Ghost Analysis Active</span>
                </div>
            </div>
        </div>
      </main>
    </div>
  );
};

export default App;