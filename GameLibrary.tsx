import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  FaArrowLeft, FaUserCircle, FaLock, FaGlobe, FaTrash, FaRedo, FaLink, FaPlug,
} from 'react-icons/fa';
import {
  me, register, login, logout, setUsername as apiSetUsername,
  saveGame, listMyGames, listPublicGames, getGame, deleteGame, updateGame, reanalyzeGame,
  listAccounts, linkAccount, unlinkAccount, listOgsGames, importOgsGame,
  type AccountUser, type GameSummary, type LinkedAccount, type OgsGameSummary,
} from './apiClient';

interface GameLibraryProps {
  onClose: () => void;
  /** Current game serialized as SGF, for "Save current game". */
  getCurrentSgf: () => string;
  /** Load a saved game (SGF + its stored analysis) into the editor. */
  onLoad: (sgf: string, analysis: unknown | null, game: GameSummary) => void;
  /** Called whenever the session user changes (login/logout). */
  onUser?: (user: AccountUser | null) => void;
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

const SOURCE_LABEL: Record<string, string> = {
  upload: 'SGF', ogs: 'OGS', kgs: 'KGS', fox: 'Fox', curated: 'Curated', client: 'Review',
};

const StatusBadge: React.FC<{ g: GameSummary }> = ({ g }) => {
  if (g.status === 'ready') return null;
  if (g.status === 'failed') {
    return <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full text-red-400 bg-red-900/30" title={g.error ?? undefined}>Failed</span>;
  }
  if (g.status === 'analyzing') {
    return <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full text-blue-300 bg-blue-900/30">Analyzing {g.progress?.percent ?? 0}%</span>;
  }
  return (
    <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full text-amber-300 bg-amber-900/30">
      {g.engineOnline === false ? 'Queued · engine offline' : 'Queued'}
    </span>
  );
};

const GameLibrary: React.FC<GameLibraryProps> = ({ onClose, getCurrentSgf, onLoad, onUser }) => {
  const [user, setUser] = useState<AccountUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');

  const [title, setTitle] = useState('');
  const [isPublic, setIsPublic] = useState(true);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const [myGames, setMyGames] = useState<GameSummary[]>([]);
  const [publicGames, setPublicGames] = useState<GameSummary[]>([]);

  const [accounts, setAccounts] = useState<LinkedAccount[]>([]);
  const [linkServer, setLinkServer] = useState<'ogs' | 'kgs' | 'fox'>('ogs');
  const [linkHandle, setLinkHandle] = useState('');
  const [ogsGames, setOgsGames] = useState<OgsGameSummary[] | null>(null);
  const [ogsBusy, setOgsBusy] = useState(false);
  const [importingId, setImportingId] = useState<number | null>(null);

  const setUserBoth = useCallback((u: AccountUser | null) => {
    setUser(u);
    onUser?.(u);
  }, [onUser]);

  const refreshLists = useCallback(async (authed: boolean) => {
    try {
      const pub = await listPublicGames();
      setPublicGames(pub.games);
      if (authed) {
        setMyGames((await listMyGames()).games);
        setAccounts((await listAccounts()).accounts);
      } else {
        setMyGames([]);
        setAccounts([]);
      }
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const { user } = await me();
        setUserBoth(user);
        await refreshLists(!!user);
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [refreshLists, setUserBoth]);

  // Poll while any of my games are still being reviewed.
  const pollRef = useRef<number | null>(null);
  useEffect(() => {
    const active = myGames.some((g) => g.status === 'pending' || g.status === 'analyzing');
    if (!active || !user) return;
    pollRef.current = window.setTimeout(async () => {
      try { setMyGames((await listMyGames()).games); } catch { /* transient */ }
    }, 3000);
    return () => { if (pollRef.current) window.clearTimeout(pollRef.current); };
  }, [myGames, user]);

  const submitAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const { user } = mode === 'login'
        ? await login(email, password)
        : await register(email, password, username.trim());
      setUserBoth(user);
      setPassword('');
      await refreshLists(true);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const doLogout = async () => {
    await logout().catch(() => {});
    setUserBoth(null);
    setMyGames([]);
    setAccounts([]);
  };

  const doSave = async () => {
    setSaveMsg(null);
    setError(null);
    try {
      const { status } = await saveGame(title.trim() || 'Untitled game', getCurrentSgf(), isPublic, { source: 'upload' });
      setTitle('');
      setSaveMsg(status === 'pending'
        ? 'Saved — queued for engine review. It appears publicly once the review finishes.'
        : 'Saved to your library');
      await refreshLists(true);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const doLoad = async (id: number) => {
    setError(null);
    try {
      const { game } = await getGame(id);
      onLoad(game.sgf, game.analysis ?? null, game);
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

  const doRetry = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await reanalyzeGame(id);
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

  const doLink = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await linkAccount(linkServer, linkHandle.trim());
      setLinkHandle('');
      setAccounts((await listAccounts()).accounts);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const browseOgs = async () => {
    setOgsBusy(true);
    setError(null);
    try {
      const { games } = await listOgsGames();
      setOgsGames(games);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setOgsBusy(false);
    }
  };

  const doImportOgs = async (gameId: number) => {
    setImportingId(gameId);
    setError(null);
    try {
      await importOgsGame(gameId);
      await refreshLists(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setImportingId(null);
    }
  };

  const GameCard: React.FC<{ g: GameSummary; owned: boolean }> = ({ g, owned }) => (
    <button
      onClick={() => doLoad(g.id)}
      className="group text-left bg-slate-800/60 hover:bg-slate-800 border border-slate-700/50 hover:border-emerald-700/50 rounded-xl p-4 transition-all"
    >
      <div className="flex items-start justify-between gap-2">
        <h4 className="text-sm font-semibold text-slate-100 truncate group-hover:text-emerald-400 transition-colors">{g.title}</h4>
        <span className="flex items-center gap-1.5 shrink-0">
          {owned && g.status === 'failed' && (
            <button onClick={(e) => doRetry(g.id, e)} className="text-slate-600 hover:text-blue-400" title="Retry analysis">
              <FaRedo size={11} />
            </button>
          )}
          {owned && (
            <button onClick={(e) => doDelete(g.id, e)} className="text-slate-600 hover:text-red-400" title="Delete">
              <FaTrash size={11} />
            </button>
          )}
        </span>
      </div>
      {(g.blackName || g.whiteName) && (
        <p className="text-[11px] text-slate-500 mt-1 truncate">
          {g.blackName ?? '?'} {g.blackRank ? `(${g.blackRank})` : ''} vs {g.whiteName ?? '?'} {g.whiteRank ? `(${g.whiteRank})` : ''}
        </p>
      )}
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <span className="text-[11px] text-slate-500">{timeAgo(g.updatedAt)}</span>
          {g.source && <span className="text-[10px] text-slate-600 uppercase">{SOURCE_LABEL[g.source] ?? g.source}</span>}
        </span>
        <span className="flex items-center gap-1.5">
          <StatusBadge g={g} />
          {owned ? (
            <button
              onClick={(e) => toggleVisibility(g, e)}
              className={`flex items-center gap-1 text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full ${g.isPublic ? 'text-emerald-400 bg-emerald-900/30' : 'text-amber-400 bg-amber-900/30'}`}
              title="Click to toggle"
            >
              {g.isPublic ? <FaGlobe size={9} /> : <FaLock size={9} />}
              {g.isPublic ? 'Public' : 'Private'}
            </button>
          ) : null}
        </span>
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
                <span className="hidden sm:inline font-semibold text-slate-200">{user.username ?? user.email}</span>
                <span className="text-xs text-emerald-500">{user.points}pt</span>
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
              <p className="text-sm text-slate-500 mt-1">Upload games, read the reviews, improve the commentary, earn points.</p>
            </div>
            <form onSubmit={submitAuth} className="space-y-3 bg-slate-900 border border-slate-800 rounded-2xl p-6">
              <div className="flex gap-2 text-sm mb-2">
                <button type="button" onClick={() => setMode('login')} className={`flex-1 py-2 rounded-lg font-semibold ${mode === 'login' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-400'}`}>Log in</button>
                <button type="button" onClick={() => setMode('register')} className={`flex-1 py-2 rounded-lg font-semibold ${mode === 'register' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-400'}`}>Sign up</button>
              </div>
              {mode === 'register' && (
                <input required minLength={3} maxLength={20} pattern="[a-zA-Z0-9_\-]+" placeholder="Username (public)" value={username} onChange={(e) => setUsername(e.target.value)} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-white" />
              )}
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
            {!user.username && (
              <section className="bg-amber-950/30 border border-amber-800/40 rounded-2xl p-5">
                <h2 className="text-xs font-semibold text-amber-300 uppercase tracking-wider mb-2">Pick a username</h2>
                <p className="text-xs text-slate-400 mb-3">Your comments and edits appear under this name.</p>
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    try {
                      const { username: name } = await apiSetUsername(username.trim());
                      setUserBoth({ ...user, username: name });
                    } catch (err: any) { setError(err.message); }
                  }}
                  className="flex gap-2"
                >
                  <input required minLength={3} maxLength={20} pattern="[a-zA-Z0-9_\-]+" placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white" />
                  <button type="submit" className="bg-amber-600 hover:bg-amber-500 text-white text-sm font-semibold px-4 rounded-lg">Set</button>
                </form>
              </section>
            )}

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

            {/* Connected accounts */}
            <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
              <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3 flex items-center gap-2"><FaPlug size={10} /> Connected accounts</h2>
              <div className="flex flex-wrap items-center gap-2 mb-3">
                {accounts.map((a) => (
                  <span key={a.server} className="flex items-center gap-2 bg-slate-800 border border-slate-700 rounded-full pl-3 pr-2 py-1 text-xs text-slate-200">
                    <span className="uppercase text-[10px] text-slate-500">{a.server}</span>
                    {a.handle}
                    {a.server === 'ogs' && (
                      <button onClick={browseOgs} disabled={ogsBusy} className="text-emerald-400 hover:text-emerald-300 text-[10px] font-semibold px-1.5 py-0.5 bg-emerald-900/30 rounded-full">
                        {ogsBusy ? '…' : 'Browse games'}
                      </button>
                    )}
                    <button onClick={async () => { await unlinkAccount(a.server); setAccounts((await listAccounts()).accounts); setOgsGames(null); }} className="text-slate-600 hover:text-red-400" title="Unlink">×</button>
                  </span>
                ))}
                {accounts.length === 0 && <span className="text-xs text-slate-600">None linked yet.</span>}
              </div>
              <form onSubmit={doLink} className="flex flex-col sm:flex-row gap-2">
                <select value={linkServer} onChange={(e) => setLinkServer(e.target.value as any)} className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white">
                  <option value="ogs">OGS</option>
                  <option value="kgs">KGS</option>
                  <option value="fox">Fox</option>
                </select>
                <input required placeholder={linkServer === 'ogs' ? 'OGS username' : `${linkServer.toUpperCase()} handle`} value={linkHandle} onChange={(e) => setLinkHandle(e.target.value)} className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white" />
                <button type="submit" className="flex items-center justify-center gap-1.5 bg-slate-700 hover:bg-slate-600 text-white text-sm font-semibold px-4 py-2 rounded-lg"><FaLink size={10} /> Link</button>
              </form>
              <p className="text-[11px] text-slate-600 mt-2">
                OGS games import directly. KGS and Fox don't offer public APIs — link your handle, then upload SGFs exported from the client; they'll be tagged to your account.
              </p>

              {ogsGames && (
                <div className="mt-4 border-t border-slate-800 pt-3 space-y-1.5 max-h-72 overflow-y-auto">
                  {ogsGames.length === 0 && <p className="text-xs text-slate-600">No recent finished games found.</p>}
                  {ogsGames.map((g) => (
                    <div key={g.id} className="flex items-center justify-between gap-2 bg-slate-800/50 rounded-lg px-3 py-2">
                      <span className="text-xs text-slate-300 truncate">
                        {g.black} {g.blackRank ? `(${g.blackRank})` : ''} vs {g.white} {g.whiteRank ? `(${g.whiteRank})` : ''}
                        <span className="text-slate-600 ml-2">{g.size}×{g.size}{g.ended ? ` · ${timeAgo(g.ended)}` : ''}</span>
                      </span>
                      {g.size === 19 ? (
                        <button
                          onClick={() => doImportOgs(g.id)}
                          disabled={importingId === g.id}
                          className="shrink-0 text-[10px] font-semibold bg-emerald-700/60 hover:bg-emerald-600 text-white px-2.5 py-1 rounded-full"
                        >
                          {importingId === g.id ? 'Importing…' : 'Import'}
                        </button>
                      ) : (
                        <span className="shrink-0 text-[10px] text-slate-600" title="Only 19×19 games can be reviewed right now">19×19 only</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section>
              <h2 className="text-sm font-semibold text-white mb-3">My games <span className="text-slate-500 font-normal">({myGames.length})</span></h2>
              <Grid games={myGames} owned empty="No saved games yet — upload an SGF or import from OGS." />
            </section>
          </>
        )}

        <section>
          <h2 className="text-sm font-semibold text-white mb-3">Community games <span className="text-slate-500 font-normal">({publicGames.length})</span></h2>
          <p className="text-xs text-slate-600 mb-3">Every game here has a full engine review. Open one, read the move commentary, and make it better — good comments earn points.</p>
          <Grid games={publicGames} owned={false} empty="No reviewed public games yet." />
        </section>
      </main>
    </div>
  );
};

export default GameLibrary;
