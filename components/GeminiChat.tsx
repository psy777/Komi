import React, { useState, useRef, useEffect } from 'react';
import { FaPaperPlane, FaRobot, FaUser, FaSpinner, FaLightbulb, FaGhost, FaBolt, FaBars, FaVolumeUp, FaVolumeMute } from 'react-icons/fa';
import { analyzePosition, chatWithGemini } from '../services/geminiService';
import { BoardState, ChatMessage, StoneColor, GameTree } from '../types';
import { toGtpCoordinate } from '../utils/goLogic';

interface GeminiChatProps {
  currentNodeId: string;
  gameTree: GameTree;
  boardState: BoardState;
  currentPlayer: StoneColor;
  komi: number;
  messages: ChatMessage[];
  onMessagesUpdate: (newMessages: ChatMessage[]) => void;
  onToggleStats?: () => void;
  onInteractionComplete?: (nodeId: string, question: string, answer: string) => void;
  minimized?: boolean;
  showOnlyInput?: boolean;
  hideInput?: boolean;
}

const GeminiChat: React.FC<GeminiChatProps> = ({ 
    currentNodeId, 
    gameTree,
    boardState, 
    currentPlayer,
    komi,
    messages, 
    onMessagesUpdate, 
    onToggleStats,
    onInteractionComplete,
    minimized = false,
    showOnlyInput = false,
    hideInput = false
}) => {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [isTtsEnabled, setIsTtsEnabled] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const lastSpokenMessageId = useRef<string | null>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    if (!minimized && !showOnlyInput) {
        scrollToBottom();
    }
  }, [messages, loading, minimized, showOnlyInput]);

  // TTS Effect
  useEffect(() => {
    if (!isTtsEnabled) {
        window.speechSynthesis.cancel();
        return;
    }

    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === 'model' && lastMsg.id !== lastSpokenMessageId.current) {
        lastSpokenMessageId.current = lastMsg.id;
        const cleanText = lastMsg.content.replace(/[\*#]/g, '');
        const utterance = new SpeechSynthesisUtterance(cleanText);
        utterance.rate = 1.1;
        utterance.pitch = 1.0;
        const voices = window.speechSynthesis.getVoices();
        const preferredVoice = voices.find(v => v.name.includes("Google") && v.lang.includes("en")) || voices[0];
        if (preferredVoice) utterance.voice = preferredVoice;
        window.speechSynthesis.speak(utterance);
    }
  }, [messages, isTtsEnabled]);

  const getGtpHistory = (): string[] => {
      const moves: string[] = [];
      let ptr: string | null = currentNodeId;
      while(ptr && gameTree.nodes[ptr]) {
          const node = gameTree.nodes[ptr];
          if (node.move) {
              moves.push(toGtpCoordinate(node.move.x, node.move.y));
          }
          ptr = node.parentId;
      }
      return moves.reverse();
  };

  const handleSend = async () => {
    if (!input.trim() || loading) return;
    window.speechSynthesis.cancel();
    const question = input;
    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: question,
      timestamp: Date.now(),
    };
    const updatedHistory = [...messages, userMsg];
    onMessagesUpdate(updatedHistory);
    setInput('');
    setLoading(true);
    try {
      const gtpMoves = getGtpHistory();
      const historyForApi = updatedHistory.map(m => ({ role: m.role, content: m.content }));
      const responseText = await chatWithGemini(historyForApi, boardState, komi, gtpMoves);
      const aiMsg: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'model',
        content: responseText,
        timestamp: Date.now(),
      };
      onMessagesUpdate([...updatedHistory, aiMsg]);
      if (onInteractionComplete) onInteractionComplete(currentNodeId, question, responseText);
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const handleQuickAnalyze = async () => {
    if (loading) return;
    window.speechSynthesis.cancel();
    setLoading(true);
    const question = "Can you analyze this position for me?";
    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: question,
      timestamp: Date.now(),
    };
    const updatedHistory = [...messages, userMsg];
    onMessagesUpdate(updatedHistory);
    try {
      const gtpMoves = getGtpHistory();
      const analysis = await analyzePosition(boardState, currentPlayer, komi, undefined, gtpMoves);
      const aiMsg: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'model',
        content: analysis,
        timestamp: Date.now(),
      };
      onMessagesUpdate([...updatedHistory, aiMsg]);
      if (onInteractionComplete) onInteractionComplete(currentNodeId, question, analysis);
    } catch (err) {
        console.error(err);
    } finally {
        setLoading(false);
    }
  };

  if (showOnlyInput) {
      return (
        <div className="p-3 bg-slate-900 border-b border-slate-800 shrink-0">
            <div className="flex gap-2 items-center">
                <button 
                    onClick={handleQuickAnalyze}
                    disabled={loading}
                    title="Analyze Position"
                    className="flex items-center justify-center w-9 h-9 bg-purple-950/40 hover:bg-purple-800/60 border border-purple-800/50 text-purple-400 rounded-lg transition-all disabled:opacity-50 shrink-0"
                >
                    <FaBolt size={14} />
                </button>
                <button
                    onClick={() => setIsTtsEnabled(!isTtsEnabled)}
                    title={isTtsEnabled ? "Disable Voice Output" : "Enable Voice Output"}
                    className={`flex items-center justify-center w-9 h-9 rounded-lg border transition-all shrink-0 ${
                        isTtsEnabled 
                        ? 'bg-emerald-950/40 border-emerald-800 text-emerald-400 hover:bg-emerald-800/60' 
                        : 'bg-slate-800/50 border-slate-700 text-slate-500 hover:text-slate-300'
                    }`}
                >
                    {isTtsEnabled ? <FaVolumeUp size={14} /> : <FaVolumeMute size={14} />}
                </button>
                <div className="relative flex-1">
                    <input
                        type="text"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                        placeholder="Ask the ghost..."
                        className="w-full bg-slate-950/80 border border-slate-800 rounded-lg pl-3 pr-9 py-2 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-purple-600 focus:border-purple-600 placeholder-slate-700 transition-all shadow-inner"
                        disabled={loading}
                    />
                    <button
                        onClick={handleSend}
                        disabled={loading || !input.trim()}
                        className="absolute right-1 top-1 bottom-1 aspect-square flex items-center justify-center bg-purple-600 hover:bg-purple-500 text-white rounded-md transition-all disabled:opacity-0"
                    >
                        <FaPaperPlane size={10} />
                    </button>
                </div>
                {onToggleStats && (
                    <button 
                        onClick={onToggleStats}
                        title="Open Menu"
                        className="flex items-center justify-center w-9 h-9 bg-slate-800/50 hover:bg-slate-700 border border-slate-700 text-slate-400 hover:text-white rounded-lg transition-all shrink-0"
                    >
                        <FaBars size={14} />
                    </button>
                )}
            </div>
        </div>
      );
  }

  return (
    <div className="flex flex-col h-full w-full">
      <div className={`flex-1 overflow-y-auto p-4 space-y-4 min-h-0 custom-scrollbar ${minimized ? 'hidden md:block' : 'block'}`}>
        {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-slate-700 gap-4 opacity-50">
                <div className="w-16 h-16 rounded-full bg-purple-950/20 flex items-center justify-center border border-purple-900/30">
                     <FaGhost size={28} className="text-purple-600/50" />
                </div>
                <p className="text-[10px] font-black tracking-[0.2em] uppercase text-center max-w-[240px]">The void is listening</p>
            </div>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex items-start gap-3 ${
              msg.role === 'user' ? 'flex-row-reverse' : ''
            }`}
          >
            <div
              className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 border ${
                msg.role === 'user' ? 'bg-indigo-900 border-indigo-700' : 'bg-purple-900 border-purple-700'
              }`}
            >
              {msg.role === 'user' ? <FaUser size={10} className="text-indigo-200" /> : <FaGhost size={12} className="text-purple-200" />}
            </div>
            <div
              className={`max-w-[85%] px-3 py-2.5 rounded-2xl text-[11px] leading-relaxed whitespace-pre-wrap border ${
                msg.role === 'user'
                  ? 'bg-indigo-950/50 text-indigo-100 rounded-tr-none border-indigo-800/50'
                  : 'bg-slate-800/50 text-slate-300 rounded-tl-none border-slate-700/50'
              }`}
            >
              {msg.content}
            </div>
          </div>
        ))}
        {loading && (
             <div className="flex items-start gap-2">
             <div className="w-7 h-7 rounded-full bg-purple-900 border border-purple-700 flex items-center justify-center shrink-0">
               <FaGhost size={12} className="text-purple-200" />
             </div>
             <div className="bg-slate-800/50 px-3 py-2 rounded-2xl rounded-tl-none border border-slate-700/50">
                <div className="flex items-center gap-2">
                    <FaSpinner className="animate-spin text-purple-500 text-[10px]" />
                    <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest">Consulting...</span>
                </div>
             </div>
           </div>
        )}
        <div ref={messagesEndRef} />
      </div>
      {!hideInput && (
          <div className="p-3 bg-slate-900 border-t border-slate-800 shrink-0">
            <div className="flex gap-2 items-center">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                placeholder="Ask..."
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs"
              />
            </div>
          </div>
      )}
    </div>
  );
};

export default GeminiChat;