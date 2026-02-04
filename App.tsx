import React, { useState, useEffect, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { FaFolderOpen, FaSave, FaChevronLeft, FaChevronRight, FaStepBackward, FaStepForward, FaCodeBranch, FaInfoCircle, FaUserCircle, FaBars, FaChevronUp, FaChevronDown, FaTimes } from 'react-icons/fa';
import GoBoard from './components/GoBoard';
import GeminiChat from './components/GeminiChat';
import { StoneColor, BoardState, GameTree, GameNode, ChatMessage } from './types';
import { createEmptyGrid, playMove } from './utils/goLogic';
import { parseSGF, generateSGF } from './utils/sgfParser';
import { summarizeCommentary } from './services/geminiService';

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
            <button onClick={handleSaveSGF} className="flex items-center gap-1.5 hover:bg-slate-800 text-slate-400 hover:text-white px-3 py-1.5 rounded-lg transition-all text-xs font-semibold">
                <FaSave className="text-blue-400" />
                <span className="hidden sm:inline">Save</span>
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
                />
            </div>
        </div>

        {/* Sidebar Docked Layout */}
        <div className="w-full md:w-[400px] bg-slate-900 border-t md:border-t-0 md:border-l border-slate-800 flex flex-col shrink-0 z-20 h-auto md:h-full">
            
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