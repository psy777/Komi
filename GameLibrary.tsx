import React, { useState, useEffect, useCallback } from 'react';
import { FaArrowLeft, FaUserCircle, FaLock, FaGlobe, FaTrash } from 'react-icons/fa';
import {
  me, register, login, logout,
  saveGame, listMyGames, listPublicGames, getGame, deleteGame, updateGame,
  type AccountUser, type GameSummary,
} from './apiClient';

interface GameLibraryProps {
  onClose: () => void;
  /** Current game serialized as SGF, for "Save current game". */
  getCurrentSgf: () => string;
  /** Current full analysis (saved alongside the SGF so reviews persist). */
  getCurrentAnalysis: () => unknown;
  /** Load a saved game (SGF + its stored analysis) into the editor. */
  onLoad: (sgf: string, analysis: unknown | null) => void;
}

function timeAgo(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

const GameLibrary: React.FC<GameLibraryProps> = ({ onClose, getCurrentSgf, getCurrentAnalysis, onLoad }) => {
  const [user, setUser] = useState<AccountUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [title, setTitle] = useState('');
  const [isPublic, setIsPublic] = useState(true);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const [myGames, setMyGames] = useState<GameSummary[]>([]);
  const [publicGames, setPublicGames] = useState<GameSummary[]>([]);

  const refreshLists = useCallback(async (authed: boolean) => {
    try {
      const pub = await listPublicGames();
      setPublicGames(pub.games);
      if (authed) setMyGames((await listMyGames()).games);
      else setMyGames([]);
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const { user } = await me();
        setUser(user);
        await refreshLists(!!user);
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [refreshLists]);

  const submitAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const { user } = mode === 'login' ? await login(email, password) : await register(email, password);
      setUser(user);
      setPassword('');
      await refreshLists(true);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const doLogout = async () => {
    await logout().catch(() => {});
    setUser(null);
    setMyGames([]);
  };

  const doSave = async () => {
    setSaveMsg(null);
    setError(null);
    try {
      await saveGame(title.trim() || 'Untitled game', getCurrentSgf(), isPublic, getCurrentAnalysis() ?? undefined);
      setTitle('');
      setSaveMsg('Saved to your library');
      await refreshLists(true);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const doLoad = async (id: number) => {
    setError(null);
    try {
      const { game } = await getGame(id);
      onLoad(game.sgf, game.analysis ?? null);
      onClose();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const doDelete = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await deleteGame(id);
      await refreshLists(true);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const toggleVisibility = async (g: GameSummary, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await updateGame(g.id, { isPublic: !g.isPublic });
      await refreshLists(true);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const GameCard: React.FC<{ g: GameSummary; owned: boolean }> = ({ g, owned }) => (
    <button
      onClick={() => doLoad(g.id)}
      className="group text-left bg-slate-800/60 hover:bg-slate-800 border border-slate-700/50 hover:border-emerald-700/50 rounded-xl p-4 transition-all"
    >
      <div className="flex items-start justify-between gap-2">
        <h4 className="text-sm font-semibold text-slate-100 truncate group-hover:text-emerald-400 transition-colors">{g.title}</h4>
        {owned && (
          <button onClick={(e) => doDelete(g.id, e)} className="text-slate-600 hover:text-red-400 shrink-0" title="Delete">
            <FaTrash size={11} />
          </button>
        )}
      </div>
      <div className="mt-3 flex items-center justify-between">
        <span className="text-[11px] text-slate-500">{timeAgo(g.updatedAt)}</span>
        {owned ? (
          <button
            onClick={(e) => toggleVisibility(g, e)}
            className={`flex items-center gap-1 text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full ${g.isPublic ? 'text-emerald-400 bg-emerald-900/30' : 'text-amber-400 bg-amber-900/30'}`}
            title="Click to toggle"
          >
            {g.isPublic ? <FaGlobe size={9} /> : <FaLock size={9} />}
            {g.isPublic ? 'Public' : 'Private'}
          </button>
        ) : (
          <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-slate-500"><FaGlobe size={9} />Public</span>
        )}
      </div>
    </button>
  );

  const Grid: React.FC<{ games: GameSummary[]; owned: boolean; empty: string }> = ({ games, owned, empty }) =>
    games.length === 0 ? (
      <p className="text-sm text-slate-600">{empty}</p>
    ) : (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {games.map((g) => <GameCard key={g.id} g={g} owned={owned} />)}
      </div>
    );

  return (
    <div className="fixed inset-0 z-50 bg-slate-950 overflow-y-auto">
      {/* Top bar */}
      <header className="sticky top-0 z-10 bg-slate-900/90 backdrop-blur border-b border-slate-800">
        <div className="max-w-5xl mx-auto px-5 h-14 flex items-center justify-between">
          <button onClick={onClose} className="flex items-center gap-2 text-slate-300 hover:text-white text-sm font-medium">
            <FaArrowLeft size={13} /> Back to editor
          </button>
          <span className="text-sm font-bold text-white tracking-wide">Library</span>
          <div className="flex items-center gap-2 text-sm text-slate-400">
            {user ? (
              <>
                <FaUserCircle className="text-emerald-400" />
                <span className="hidden sm:inline">{user.email}</span>
                <button onClick={doLogout} className="ml-2 text-xs text-slate-500 hover:text-white">Log out</button>
              </>
            ) : (
              <span className="text-xs text-slate-500">Not signed in</span>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-5 py-8 space-y-10">
        {error && <div className="text-sm text-red-400 bg-red-900/20 border border-red-800/40 rounded-lg px-4 py-3">{error}</div>}

        {loading ? (
          <div className="text-slate-500">Loading…</div>
        ) : !user ? (
          // --- Auth (centered card) ---
          <div className="max-w-sm mx-auto mt-6">
            <div className="text-center mb-6">
              <FaUserCircle className="text-emerald-400 mx-auto mb-3" size={40} />
              <h1 className="text-xl font-bold text-white">{mode === 'login' ? 'Welcome back' : 'Create your account'}</h1>
              <p className="text-sm text-slate-500 mt-1">Save your reviews and access them anywhere.</p>
            </div>
            <form onSubmit={submitAuth} className="space-y-3 bg-slate-900 border border-slate-800 rounded-2xl p-6">
              <div className="flex gap-2 text-sm mb-2">
                <button type="button" onClick={() => setMode('login')} className={`flex-1 py-2 rounded-lg font-semibold ${mode === 'login' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-400'}`}>Log in</button>
                <button type="button" onClick={() => setMode('register')} className={`flex-1 py-2 rounded-lg font-semibold ${mode === 'register' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-400'}`}>Sign up</button>
              </div>
              <input type="email" required placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-white" />
              <input type="password" required minLength={8} placeholder="Password (min 8 characters)" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-white" />
              <button type="submit" className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-semibold py-2.5 rounded-lg transition-colors">
                {mode === 'login' ? 'Log in' : 'Create account'}
              </button>
            </form>
          </div>
        ) : (
          // --- Logged in ---
          <>
            <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
              <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Save current game</h2>
              <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                <input placeholder="Title (e.g. League game vs. Daniel)" value={title} onChange={(e) => setTitle(e.target.value)} className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-white" />
                <label className="flex items-center gap-2 text-sm text-slate-400 select-none">
                  <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
                  {isPublic ? <><FaGlobe size={11} /> Public</> : <><FaLock size={11} /> Private</>}
                </label>
                <button onClick={doSave} className="bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold px-6 py-2.5 rounded-lg transition-colors">Save</button>
              </div>
              {saveMsg && <p className="text-xs text-emerald-400 mt-2">{saveMsg}</p>}
            </section>

            <section>
              <h2 className="text-sm font-semibold text-white mb-3">My games <span className="text-slate-500 font-normal">({myGames.length})</span></h2>
              <Grid games={myGames} owned empty="No saved games yet — analyze a game and hit Save above." />
            </section>
          </>
        )}

        <section>
          <h2 className="text-sm font-semibold text-white mb-3">Public games <span className="text-slate-500 font-normal">({publicGames.length})</span></h2>
          <Grid games={publicGames} owned={false} empty="No public games yet." />
        </section>
      </main>
    </div>
  );
};

export default GameLibrary;
