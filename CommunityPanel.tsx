// Per-move community panel for saved games: the wiki commentary (engine-seeded,
// user-revised, vote-ranked) and the discussion thread, with the owner's
// "insightful" pick. Shown alongside the engine facts, never instead of them —
// the prose can be edited, the numbers can't.

import React, { useState, useEffect, useCallback } from 'react';
import { FaPen, FaHistory, FaStar, FaRegStar, FaChevronUp, FaTrash, FaRobot } from 'react-icons/fa';
import {
  getMoveBundle, postRevision, voteRevision, postComment, editComment,
  deleteComment, voteComment, markInsightful,
  type MoveBundle, type Revision, type MoveComment, type AccountUser,
} from './apiClient';

interface CommunityPanelProps {
  gameId: number;
  moveNumber: number; // 1-indexed move currently shown on the board
  user: AccountUser | null;
}

function timeAgo(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const CommunityPanel: React.FC<CommunityPanelProps> = ({ gameId, moveNumber, user }) => {
  const [tab, setTab] = useState<'annotation' | 'discussion'>('annotation');
  const [bundle, setBundle] = useState<MoveBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [commentDraft, setCommentDraft] = useState('');
  const [editingComment, setEditingComment] = useState<number | null>(null);
  const [commentEditDraft, setCommentEditDraft] = useState('');

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const b = await getMoveBundle(gameId, moveNumber);
      setBundle(b);
    } catch (e: any) {
      setError(e.message);
    }
  }, [gameId, moveNumber]);

  useEffect(() => {
    setBundle(null);
    setEditing(false);
    setShowHistory(false);
    setEditingComment(null);
    if (moveNumber >= 1) refresh();
  }, [refresh, moveNumber]);

  const act = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (moveNumber < 1) return null;

  const current = bundle?.commentary.current ?? null;
  const revisions = bundle?.commentary.revisions ?? [];
  const comments = bundle?.comments ?? [];

  const RevisionRow: React.FC<{ r: Revision; isCurrent?: boolean }> = ({ r, isCurrent }) => (
    <div className={`rounded-lg p-2.5 ${isCurrent ? 'bg-slate-800/80 border border-slate-700' : 'bg-slate-900/60 border border-slate-800'}`}>
      <p className="text-xs text-slate-200 leading-relaxed whitespace-pre-wrap">{r.body}</p>
      <div className="mt-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[10px] text-slate-500">
          {r.isEngine && <FaRobot size={9} className="text-cyan-500" />}
          {r.author} · {timeAgo(r.createdAt)}
        </span>
        <button
          onClick={() => user && act(() => voteRevision(r.id))}
          disabled={!user || (user && r.authorId === user.id)}
          title={!user ? 'Log in to vote' : r.authorId === user?.id ? 'Your revision' : r.votedByMe ? 'Remove vote' : 'This says it best'}
          className={`flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full transition-colors ${
            r.votedByMe ? 'bg-emerald-800/60 text-emerald-300' : 'bg-slate-800 text-slate-400 hover:text-white'
          } disabled:opacity-40 disabled:cursor-default`}
        >
          <FaChevronUp size={9} /> {r.votes}
        </button>
      </div>
    </div>
  );

  return (
    <div className="bg-slate-950/50 border border-slate-800 rounded-xl overflow-hidden">
      <div className="flex border-b border-slate-800 text-[11px] font-semibold">
        <button
          onClick={() => setTab('annotation')}
          className={`flex-1 py-2 transition-colors ${tab === 'annotation' ? 'text-emerald-400 bg-slate-900' : 'text-slate-500 hover:text-slate-300'}`}
        >
          Annotation
        </button>
        <button
          onClick={() => setTab('discussion')}
          className={`flex-1 py-2 transition-colors ${tab === 'discussion' ? 'text-emerald-400 bg-slate-900' : 'text-slate-500 hover:text-slate-300'}`}
        >
          Discussion{comments.length > 0 ? ` (${comments.length})` : ''}
        </button>
      </div>

      <div className="p-3 space-y-2">
        {error && <p className="text-[11px] text-red-400">{error}</p>}
        {!bundle && !error && <p className="text-[11px] text-slate-600">Loading…</p>}

        {bundle && tab === 'annotation' && (
          <>
            {current ? (
              <RevisionRow r={current} isCurrent />
            ) : (
              <p className="text-[11px] text-slate-600">No commentary on move {moveNumber} yet — write the first take.</p>
            )}

            {user && !editing && (
              <div className="flex gap-2">
                <button
                  onClick={() => { setDraft(current?.body ?? ''); setEditing(true); }}
                  className="flex items-center gap-1.5 text-[10px] font-semibold text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 px-2.5 py-1 rounded-lg transition-colors"
                >
                  <FaPen size={8} /> Suggest an edit
                </button>
                {revisions.length > 1 && (
                  <button
                    onClick={() => setShowHistory((v) => !v)}
                    className="flex items-center gap-1.5 text-[10px] font-semibold text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 px-2.5 py-1 rounded-lg transition-colors"
                  >
                    <FaHistory size={8} /> {showHistory ? 'Hide' : 'History'} ({revisions.length})
                  </button>
                )}
              </div>
            )}

            {editing && (
              <div className="space-y-2">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={4}
                  maxLength={4000}
                  placeholder="Say what this move is really doing — and what the better idea was."
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-emerald-600"
                  autoFocus
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => act(async () => { await postRevision(gameId, moveNumber, draft); setEditing(false); setDraft(''); })}
                    disabled={!draft.trim() || busy}
                    className="text-[10px] font-semibold bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white px-3 py-1.5 rounded-lg transition-colors"
                  >
                    Submit revision
                  </button>
                  <button onClick={() => setEditing(false)} className="text-[10px] text-slate-500 hover:text-white px-2">Cancel</button>
                </div>
              </div>
            )}

            {showHistory && revisions.filter((r) => r.id !== current?.id).map((r) => <RevisionRow key={r.id} r={r} />)}
          </>
        )}

        {bundle && tab === 'discussion' && (
          <>
            {comments.length === 0 && (
              <p className="text-[11px] text-slate-600">No discussion on move {moveNumber} yet.</p>
            )}
            {comments.map((c: MoveComment) => (
              <div key={c.id} className={`rounded-lg p-2.5 ${c.insightful ? 'bg-amber-950/30 border border-amber-800/40' : 'bg-slate-900/60 border border-slate-800'}`}>
                {editingComment === c.id ? (
                  <div className="space-y-2">
                    <textarea
                      value={commentEditDraft}
                      onChange={(e) => setCommentEditDraft(e.target.value)}
                      rows={3}
                      maxLength={4000}
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-2 text-xs text-white"
                      autoFocus
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => act(async () => { await editComment(c.id, commentEditDraft); setEditingComment(null); })}
                        disabled={!commentEditDraft.trim() || busy}
                        className="text-[10px] font-semibold bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white px-3 py-1 rounded-lg"
                      >
                        Save
                      </button>
                      <button onClick={() => setEditingComment(null)} className="text-[10px] text-slate-500 hover:text-white">Cancel</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="text-xs text-slate-200 leading-relaxed whitespace-pre-wrap">{c.body}</p>
                    <div className="mt-2 flex items-center justify-between">
                      <span className="text-[10px] text-slate-500">
                        <span className="text-slate-400 font-semibold">{c.author}</span>
                        <span className="text-emerald-600/80 ml-1">{c.authorPoints}pt</span>
                        {' · '}{timeAgo(c.createdAt)}{c.edited ? ' · edited' : ''}
                        {c.insightful && <span className="text-amber-400 ml-1.5">★ insightful</span>}
                      </span>
                      <span className="flex items-center gap-1.5">
                        {bundle.isOwner && user && c.authorId !== user.id && (
                          <button
                            onClick={() => act(() => markInsightful(gameId, moveNumber, c.id))}
                            title={c.insightful ? 'Remove insightful mark' : 'Mark as the most insightful comment on this move (+5)'}
                            className={`${c.insightful ? 'text-amber-400' : 'text-slate-600 hover:text-amber-400'} transition-colors`}
                          >
                            {c.insightful ? <FaStar size={11} /> : <FaRegStar size={11} />}
                          </button>
                        )}
                        {user && c.authorId === user.id && (
                          <>
                            <button
                              onClick={() => { setEditingComment(c.id); setCommentEditDraft(c.body); }}
                              className="text-slate-600 hover:text-white" title="Edit"
                            >
                              <FaPen size={9} />
                            </button>
                            <button
                              onClick={() => act(() => deleteComment(c.id))}
                              className="text-slate-600 hover:text-red-400" title="Delete"
                            >
                              <FaTrash size={9} />
                            </button>
                          </>
                        )}
                        <button
                          onClick={() => user && act(() => voteComment(c.id))}
                          disabled={!user || c.authorId === user?.id}
                          title={!user ? 'Log in to vote' : c.authorId === user?.id ? 'Your comment' : c.votedByMe ? 'Remove vote' : 'Good comment (+1)'}
                          className={`flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full transition-colors ${
                            c.votedByMe ? 'bg-emerald-800/60 text-emerald-300' : 'bg-slate-800 text-slate-400 hover:text-white'
                          } disabled:opacity-40 disabled:cursor-default`}
                        >
                          <FaChevronUp size={9} /> {c.votes}
                        </button>
                      </span>
                    </div>
                  </>
                )}
              </div>
            ))}

            {user ? (
              <div className="space-y-2 pt-1">
                <textarea
                  value={commentDraft}
                  onChange={(e) => setCommentDraft(e.target.value)}
                  rows={2}
                  maxLength={4000}
                  placeholder={`Thoughts on move ${moveNumber}?`}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-emerald-600"
                />
                <button
                  onClick={() => act(async () => { await postComment(gameId, moveNumber, commentDraft); setCommentDraft(''); })}
                  disabled={!commentDraft.trim() || busy}
                  className="text-[10px] font-semibold bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white px-3 py-1.5 rounded-lg transition-colors"
                >
                  Comment
                </button>
              </div>
            ) : (
              <p className="text-[10px] text-slate-600 pt-1">Log in (Library → sign up) to join the discussion and earn points.</p>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default CommunityPanel;
