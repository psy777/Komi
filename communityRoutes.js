// Community layer: per-move wiki commentary (engine-seeded, user-revised,
// vote-ranked), per-move discussion comments, and the points economy.
//
// Points: an upvote is +1 to the author; the game owner marking a comment
// "insightful" is +5 (one pick per move, re-assignable). Every change goes
// through the append-only point_events ledger in the same transaction that
// records the vote/mark, so users.points always equals the ledger sum.

import db from './db.js';
import { currentUser, requireAuth } from './auth.js';

const MAX_BODY = 4000;
const ENGINE_AUTHOR = 'Komi review engine';

// --- points ledger ---------------------------------------------------------

function awardPoints(userId, delta, reason, refType, refId) {
  if (!userId || !delta) return;
  db.prepare(
    'INSERT INTO point_events (user_id, delta, reason, ref_type, ref_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(userId, delta, reason, refType, refId, Date.now());
  db.prepare('UPDATE users SET points = points + ? WHERE id = ?').run(delta, userId);
}

function tx(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// --- simple per-user write rate limit (in-memory token bucket) --------------

const buckets = new Map(); // userId -> { count, resetAt }
const WRITE_LIMIT = 30; // writes per minute

function rateLimit(req, res, next) {
  const now = Date.now();
  const b = buckets.get(req.user.id);
  if (!b || now > b.resetAt) {
    buckets.set(req.user.id, { count: 1, resetAt: now + 60_000 });
    return next();
  }
  if (b.count >= WRITE_LIMIT) {
    return res.status(429).json({ error: 'Slow down a little — try again in a minute' });
  }
  b.count++;
  next();
}

// --- helpers ----------------------------------------------------------------

function loadGame(req, res) {
  const game = db.prepare('SELECT * FROM games WHERE id = ?').get(Number(req.params.id));
  if (!game) {
    res.status(404).json({ error: 'Game not found' });
    return null;
  }
  if (!game.is_public) {
    const user = currentUser(req);
    if (!user || (user.id !== game.owner_id && user.role !== 'admin')) {
      res.status(403).json({ error: 'Private game' });
      return null;
    }
  }
  return game;
}

function moveNumber(req, res) {
  const n = Number(req.params.n);
  if (!Number.isInteger(n) || n < 1 || n > 1000) {
    res.status(400).json({ error: 'Bad move number' });
    return null;
  }
  return n;
}

function cleanBody(raw, res) {
  const body = String(raw || '').trim();
  if (!body) {
    res.status(400).json({ error: 'Body is required' });
    return null;
  }
  return body.slice(0, MAX_BODY);
}

function revisionView(r, viewerId) {
  return {
    id: r.id,
    author: r.author_id == null ? ENGINE_AUTHOR : r.username ?? 'deleted user',
    authorId: r.author_id,
    isEngine: r.author_id == null,
    body: r.body,
    createdAt: r.created_at,
    votes: r.votes,
    votedByMe: viewerId ? !!r.voted_by_me : false,
  };
}

const REVISIONS_SQL = `
  SELECT r.*, u.username,
         (SELECT COUNT(*) FROM revision_votes v WHERE v.revision_id = r.id) AS votes,
         (SELECT COUNT(*) FROM revision_votes v WHERE v.revision_id = r.id AND v.voter_id = ?) AS voted_by_me
  FROM commentary_revisions r LEFT JOIN users u ON u.id = r.author_id
  WHERE r.game_id = ? AND r.move_number = ?
  ORDER BY votes DESC, r.created_at DESC`;

const COMMENTS_SQL = `
  SELECT c.*, u.username, u.points AS author_points,
         (SELECT COUNT(*) FROM comment_votes v WHERE v.comment_id = c.id) AS votes,
         (SELECT COUNT(*) FROM comment_votes v WHERE v.comment_id = c.id AND v.voter_id = ?) AS voted_by_me
  FROM move_comments c JOIN users u ON u.id = c.author_id
  WHERE c.game_id = ? AND c.move_number = ? AND c.deleted = 0
  ORDER BY votes DESC, c.created_at ASC`;

function commentView(c, viewerId, insightfulId) {
  return {
    id: c.id,
    author: c.username ?? 'deleted user',
    authorId: c.author_id,
    authorPoints: c.author_points ?? 0,
    body: c.body,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    edited: c.updated_at !== c.created_at,
    votes: c.votes,
    votedByMe: viewerId ? !!c.voted_by_me : false,
    insightful: c.id === insightfulId,
  };
}

// --- routes -----------------------------------------------------------------

export function registerCommunityRoutes(app) {
  // Everything about one move, in one call: canonical commentary (top-voted
  // revision), full history, discussion, and the owner's insightful pick.
  app.get('/api/games/:id/moves/:n', (req, res) => {
    const game = loadGame(req, res);
    if (!game) return;
    const n = moveNumber(req, res);
    if (n == null) return;
    const viewer = currentUser(req);
    const viewerId = viewer?.id ?? 0;

    const revisions = db.prepare(REVISIONS_SQL).all(viewerId, game.id, n);
    const mark = db
      .prepare('SELECT comment_id FROM insightful_marks WHERE game_id = ? AND move_number = ?')
      .get(game.id, n);
    const comments = db.prepare(COMMENTS_SQL).all(viewerId, game.id, n);

    res.json({
      moveNumber: n,
      commentary: {
        current: revisions.length ? revisionView(revisions[0], viewerId) : null,
        revisions: revisions.map((r) => revisionView(r, viewerId)),
      },
      comments: comments.map((c) => commentView(c, viewerId, mark?.comment_id ?? null)),
      isOwner: viewerId === game.owner_id,
    });
  });

  // Every commented/annotated move of a game — the "all comments" index.
  app.get('/api/games/:id/activity', (req, res) => {
    const game = loadGame(req, res);
    if (!game) return;
    const rows = db
      .prepare(
        `SELECT move_number,
                SUM(kind = 'comment') AS comments,
                SUM(kind = 'revision' AND author_id IS NOT NULL) AS user_revisions,
                SUM(kind = 'revision' AND author_id IS NULL) AS engine_notes
         FROM (
           SELECT move_number, 'comment' AS kind, author_id FROM move_comments WHERE game_id = ? AND deleted = 0
           UNION ALL
           SELECT move_number, 'revision', author_id FROM commentary_revisions WHERE game_id = ?
         )
         GROUP BY move_number ORDER BY move_number`,
      )
      .all(game.id, game.id);
    res.json({
      moves: rows.map((r) => ({
        moveNumber: r.move_number,
        comments: r.comments,
        userRevisions: r.user_revisions,
        engineNotes: r.engine_notes,
      })),
    });
  });

  // Propose a new revision of a move's commentary.
  app.post('/api/games/:id/moves/:n/revisions', requireAuth, rateLimit, (req, res) => {
    const game = loadGame(req, res);
    if (!game) return;
    const n = moveNumber(req, res);
    if (n == null) return;
    const body = cleanBody(req.body?.body, res);
    if (body == null) return;

    const info = db
      .prepare(
        'INSERT INTO commentary_revisions (game_id, move_number, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(game.id, n, req.user.id, body, Date.now());
    res.json({ id: Number(info.lastInsertRowid) });
  });

  // Toggle a vote on a revision. +1 to the author on vote, reversed on unvote.
  app.post('/api/revisions/:id/vote', requireAuth, rateLimit, (req, res) => {
    const rev = db
      .prepare('SELECT r.*, g.is_public, g.owner_id FROM commentary_revisions r JOIN games g ON g.id = r.game_id WHERE r.id = ?')
      .get(Number(req.params.id));
    if (!rev) return res.status(404).json({ error: 'Revision not found' });
    if (rev.author_id === req.user.id) return res.status(400).json({ error: 'No votes for your own writing' });

    const result = tx(() => {
      const existing = db
        .prepare('SELECT 1 FROM revision_votes WHERE revision_id = ? AND voter_id = ?')
        .get(rev.id, req.user.id);
      if (existing) {
        db.prepare('DELETE FROM revision_votes WHERE revision_id = ? AND voter_id = ?').run(rev.id, req.user.id);
        awardPoints(rev.author_id, -1, 'revision_vote_removed', 'revision', rev.id);
        return { voted: false };
      }
      db.prepare('INSERT INTO revision_votes (revision_id, voter_id, created_at) VALUES (?, ?, ?)').run(
        rev.id, req.user.id, Date.now(),
      );
      awardPoints(rev.author_id, 1, 'revision_vote', 'revision', rev.id);
      return { voted: true };
    });
    const votes = db.prepare('SELECT COUNT(*) n FROM revision_votes WHERE revision_id = ?').get(rev.id).n;
    res.json({ ...result, votes });
  });

  // Add a discussion comment to a move.
  app.post('/api/games/:id/moves/:n/comments', requireAuth, rateLimit, (req, res) => {
    const game = loadGame(req, res);
    if (!game) return;
    const n = moveNumber(req, res);
    if (n == null) return;
    const body = cleanBody(req.body?.body, res);
    if (body == null) return;

    const now = Date.now();
    const info = db
      .prepare(
        'INSERT INTO move_comments (game_id, move_number, author_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(game.id, n, req.user.id, body, now, now);
    res.json({ id: Number(info.lastInsertRowid) });
  });

  // Edit own comment.
  app.patch('/api/comments/:id', requireAuth, rateLimit, (req, res) => {
    const c = db.prepare('SELECT * FROM move_comments WHERE id = ? AND deleted = 0').get(Number(req.params.id));
    if (!c) return res.status(404).json({ error: 'Comment not found' });
    if (c.author_id !== req.user.id) return res.status(403).json({ error: 'Not your comment' });
    const body = cleanBody(req.body?.body, res);
    if (body == null) return;
    db.prepare('UPDATE move_comments SET body = ?, updated_at = ? WHERE id = ?').run(body, Date.now(), c.id);
    res.json({ ok: true });
  });

  // Soft-delete own comment (admins may moderate).
  app.delete('/api/comments/:id', requireAuth, (req, res) => {
    const c = db.prepare('SELECT * FROM move_comments WHERE id = ? AND deleted = 0').get(Number(req.params.id));
    if (!c) return res.status(404).json({ error: 'Comment not found' });
    if (c.author_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not your comment' });
    }
    db.prepare('UPDATE move_comments SET deleted = 1, updated_at = ? WHERE id = ?').run(Date.now(), c.id);
    res.json({ ok: true });
  });

  // Toggle a vote on a comment. +1 to the author on vote, reversed on unvote.
  app.post('/api/comments/:id/vote', requireAuth, rateLimit, (req, res) => {
    const c = db.prepare('SELECT * FROM move_comments WHERE id = ? AND deleted = 0').get(Number(req.params.id));
    if (!c) return res.status(404).json({ error: 'Comment not found' });
    if (c.author_id === req.user.id) return res.status(400).json({ error: 'No votes for your own writing' });

    const result = tx(() => {
      const existing = db
        .prepare('SELECT 1 FROM comment_votes WHERE comment_id = ? AND voter_id = ?')
        .get(c.id, req.user.id);
      if (existing) {
        db.prepare('DELETE FROM comment_votes WHERE comment_id = ? AND voter_id = ?').run(c.id, req.user.id);
        awardPoints(c.author_id, -1, 'comment_vote_removed', 'comment', c.id);
        return { voted: false };
      }
      db.prepare('INSERT INTO comment_votes (comment_id, voter_id, created_at) VALUES (?, ?, ?)').run(
        c.id, req.user.id, Date.now(),
      );
      awardPoints(c.author_id, 1, 'comment_vote', 'comment', c.id);
      return { voted: true };
    });
    const votes = db.prepare('SELECT COUNT(*) n FROM comment_votes WHERE comment_id = ?').get(c.id).n;
    res.json({ ...result, votes });
  });

  // Owner marks one comment per move as insightful (+5); re-assignable; mark
  // the same comment again to clear it.
  app.post('/api/games/:id/moves/:n/insightful', requireAuth, rateLimit, (req, res) => {
    const game = loadGame(req, res);
    if (!game) return;
    if (game.owner_id !== req.user.id) return res.status(403).json({ error: 'Only the game owner can mark insightful comments' });
    const n = moveNumber(req, res);
    if (n == null) return;
    const commentId = Number(req.body?.commentId);
    const c = db
      .prepare('SELECT * FROM move_comments WHERE id = ? AND game_id = ? AND move_number = ? AND deleted = 0')
      .get(commentId, game.id, n);
    if (!c) return res.status(404).json({ error: 'Comment not found on this move' });
    if (c.author_id === req.user.id) return res.status(400).json({ error: 'No marking your own comment' });

    const result = tx(() => {
      const prev = db
        .prepare('SELECT * FROM insightful_marks WHERE game_id = ? AND move_number = ?')
        .get(game.id, n);
      if (prev) {
        const prevComment = db.prepare('SELECT author_id FROM move_comments WHERE id = ?').get(prev.comment_id);
        db.prepare('DELETE FROM insightful_marks WHERE game_id = ? AND move_number = ?').run(game.id, n);
        awardPoints(prevComment?.author_id, -5, 'insightful_removed', 'comment', prev.comment_id);
        if (prev.comment_id === c.id) return { insightful: null }; // toggled off
      }
      db.prepare(
        'INSERT INTO insightful_marks (game_id, move_number, comment_id, created_at) VALUES (?, ?, ?, ?)',
      ).run(game.id, n, c.id, Date.now());
      awardPoints(c.author_id, 5, 'insightful', 'comment', c.id);
      return { insightful: c.id };
    });
    res.json(result);
  });

  // Public profile.
  app.get('/api/users/:username', (req, res) => {
    const u = db
      .prepare('SELECT id, username, points, role, created_at FROM users WHERE username = ?')
      .get(String(req.params.username));
    if (!u || !u.username) return res.status(404).json({ error: 'User not found' });

    const accounts = db
      .prepare('SELECT server, handle FROM linked_accounts WHERE user_id = ?')
      .all(u.id);
    const stats = {
      comments: db.prepare('SELECT COUNT(*) n FROM move_comments WHERE author_id = ? AND deleted = 0').get(u.id).n,
      revisions: db.prepare('SELECT COUNT(*) n FROM commentary_revisions WHERE author_id = ?').get(u.id).n,
      games: db.prepare('SELECT COUNT(*) n FROM games WHERE owner_id = ? AND is_public = 1').get(u.id).n,
    };
    const recent = db
      .prepare(
        `SELECT c.game_id, c.move_number, substr(c.body, 1, 140) AS excerpt, c.created_at, g.title
         FROM move_comments c JOIN games g ON g.id = c.game_id
         WHERE c.author_id = ? AND c.deleted = 0 AND g.is_public = 1
         ORDER BY c.created_at DESC LIMIT 10`,
      )
      .all(u.id);

    res.json({
      user: {
        username: u.username,
        points: u.points,
        role: u.role,
        joinedAt: u.created_at,
        accounts,
        stats,
        recentComments: recent.map((r) => ({
          gameId: r.game_id,
          gameTitle: r.title,
          moveNumber: r.move_number,
          excerpt: r.excerpt,
          createdAt: r.created_at,
        })),
      },
    });
  });
}
