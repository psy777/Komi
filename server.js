import dotenv from 'dotenv';
dotenv.config({ path: '.env' });
dotenv.config({ path: '.env.local', override: true });

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { analyzeGame, analyzePosition, isAvailable, engineHealth } from './katago.js';
import { llmGenerate, llmInfo } from './llmProvider.js';
import { runGoAgentReview } from './goAgent.js';
import db from './db.js';
import { initReviewQueue, enqueueGame, queueStatus } from './reviewQueue.js';
import {
  ogsResolvePlayer,
  ogsListRecentGames,
  ogsFetchSgf,
  parseOgsGameId,
  LINKABLE_SERVERS,
} from './gameServers.js';
import { registerCommunityRoutes } from './communityRoutes.js';
import {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  tokenFromReq,
  currentUser,
  requireAuth,
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: '10mb' }));

// CORS — the Next.js frontend runs on a different origin (e.g. :3000) and calls
// this engine service cross-origin. The KataGo/LLM endpoints carry no cookies,
// so a permissive origin is fine; set CORS_ORIGIN to lock it down in production.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// LLM commentary — dispatches to Gemini or a local OpenAI-compatible server
// (LM Studio) based on LLM_PROVIDER. Route name kept for client compatibility.
app.post('/api/gemini/generate', async (req, res) => {
  // If the browser gives up (e.g. a keep-alive reset) and retries, cancel the
  // in-flight LM Studio generation instead of leaving it running. Orphaned
  // generations pile up past LM Studio's parallel limit and saturate it, which
  // is what turns one transient failure into an unrecoverable spin.
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });
  try {
    const { model, contents, config } = req.body;
    if (!model || !contents) {
      return res.status(400).json({ error: 'model and contents are required' });
    }
    const text = await llmGenerate({ model, contents, config, signal: ac.signal });
    res.json({ text });
  } catch (err) {
    if (ac.signal.aborted) return; // client already gone; nothing to send
    console.error('LLM proxy error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Streamed LLM generation. Emits NDJSON lines as tokens arrive:
//   {"type":"reasoning","delta":"..."}  - hidden chain-of-thought (if any)
//   {"type":"content","delta":"..."}    - the actual answer text
//   {"type":"done","text":"<full content>"} | {"type":"error","error":"..."}
app.post('/api/gemini/stream', async (req, res) => {
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  try {
    const { model, contents, config } = req.body;
    if (!model || !contents) {
      return res.status(400).json({ error: 'model and contents are required' });
    }
    const text = await llmGenerate({
      model,
      contents,
      config,
      signal: ac.signal,
      onToken: (t) => {
        if (t.content) res.write(JSON.stringify({ type: 'content', delta: t.content }) + '\n');
        else if (t.reasoning) res.write(JSON.stringify({ type: 'reasoning', delta: t.reasoning }) + '\n');
      },
    });
    res.write(JSON.stringify({ type: 'done', text }) + '\n');
    res.end();
  } catch (err) {
    if (ac.signal.aborted) { try { res.end(); } catch { /* gone */ } return; }
    console.error('LLM stream error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      try {
        res.write(JSON.stringify({ type: 'error', error: err.message }) + '\n');
        res.end();
      } catch { /* connection already gone */ }
    }
  }
});

app.get('/api/llm/info', (_req, res) => {
  res.json(llmInfo());
});

// --- Agentic move review -------------------------------------------------
// Drives the local model through a KataGo tool loop (goAgent.js) to review one
// move. Streamed NDJSON so the UI can show the agent investigating live:
//   {"type":"status"|"baseline"|"thought"|"tool_call"|"observation"}  - progress
//   {"type":"done","review":{...}} | {"type":"error","error":"..."}
app.post('/api/agent/review/stream', async (req, res) => {
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  try {
    const { moves, moveNumber, komi, playerLevel, context } = req.body;
    if (!Array.isArray(moves) || !moveNumber) {
      return res.status(400).json({ error: 'moves (pairs) and moveNumber are required' });
    }
    const review = await runGoAgentReview(
      { moves: normalizeMoves(moves), moveNumber, komi, playerLevel, context },
      {
        signal: ac.signal,
        onEvent: (e) => { try { res.write(JSON.stringify(e) + '\n'); } catch { /* gone */ } },
      },
    );
    res.write(JSON.stringify({ type: 'done', review }) + '\n');
    res.end();
  } catch (err) {
    if (ac.signal.aborted) { try { res.end(); } catch { /* gone */ } return; }
    console.error('Agent review error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else { try { res.write(JSON.stringify({ type: 'error', error: err.message }) + '\n'); res.end(); } catch { /* gone */ } }
  }
});

// Non-streamed convenience variant: returns the final review only.
app.post('/api/agent/review', async (req, res) => {
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  try {
    const { moves, moveNumber, komi, playerLevel, context } = req.body;
    if (!Array.isArray(moves) || !moveNumber) {
      return res.status(400).json({ error: 'moves (pairs) and moveNumber are required' });
    }
    const review = await runGoAgentReview(
      { moves: normalizeMoves(moves), moveNumber, komi, playerLevel, context },
      { signal: ac.signal },
    );
    res.json({ review });
  } catch (err) {
    if (ac.signal.aborted) return;
    console.error('Agent review error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- KataGo analysis engine ---------------------------------------------

// Accept moves either as flat GTP ["B","D4","W","Q16"] or as pairs
// [["B","D4"],["W","Q16"]] and normalize to pairs for the engine.
function normalizeMoves(moves) {
  if (!Array.isArray(moves)) return [];
  if (moves.length === 0) return [];
  if (Array.isArray(moves[0])) return moves; // already pairs
  const pairs = [];
  for (let i = 0; i + 1 < moves.length; i += 2) {
    pairs.push([moves[i], moves[i + 1]]);
  }
  return pairs;
}

// Single position: board after all supplied moves. Back-compatible with the
// old proxy payload shape { moves, config: { komi, request_id } }.
app.post('/api/katago', async (req, res) => {
  try {
    const { moves = [], komi, rules, maxVisits, includeOwnership, config } = req.body;
    const result = await analyzePosition(normalizeMoves(moves), {
      komi: komi ?? config?.komi ?? 6.5,
      rules,
      maxVisits,
      includeOwnership: includeOwnership ?? true,
    });
    res.json({ ...result, request_id: config?.request_id });
  } catch (err) {
    console.error('KataGo error:', err.message);
    res.status(503).json({ error: err.message });
  }
});

// Whole game: one shared-tree query analyzing every requested turn.
app.post('/api/katago/game', async (req, res) => {
  try {
    const { moves = [], komi, rules, maxVisits, includeOwnership, analyzeTurns } = req.body;
    const results = await analyzeGame(normalizeMoves(moves), {
      komi: komi ?? 6.5,
      rules,
      maxVisits,
      includeOwnership: includeOwnership ?? true,
      analyzeTurns,
    });
    res.json({ results });
  } catch (err) {
    console.error('KataGo game error:', err.message);
    res.status(503).json({ error: err.message });
  }
});

// Whole game, streamed: emits one NDJSON line per turn as KataGo finishes it,
// so the client can animate progress (e.g. the score graph) instead of waiting
// for the entire game. Lines: {"type":"result","result":{...}} then {"type":"done"}.
app.post('/api/katago/game/stream', async (req, res) => {
  const { moves = [], komi, rules, maxVisits, includeOwnership, analyzeTurns } = req.body;
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering so lines flush
  try {
    await analyzeGame(normalizeMoves(moves), {
      komi: komi ?? 6.5,
      rules,
      maxVisits,
      includeOwnership: includeOwnership ?? true,
      analyzeTurns,
      onResult: (msg) => {
        res.write(JSON.stringify({ type: 'result', result: msg }) + '\n');
      },
    });
    res.write(JSON.stringify({ type: 'done' }) + '\n');
    res.end();
  } catch (err) {
    console.error('KataGo game stream error:', err.message);
    if (!res.headersSent) {
      res.status(503).json({ error: err.message });
    } else {
      // Headers already flushed with the first result line; signal in-band.
      try {
        res.write(JSON.stringify({ type: 'error', error: err.message }) + '\n');
        res.end();
      } catch { /* connection already gone */ }
    }
  }
});

app.get('/api/katago/health', async (_req, res) => {
  try {
    const health = await engineHealth();
    res.json(health);
  } catch {
    res.json({ mode: 'remote', available: false, status: 'offline' });
  }
});

// --- Auth ----------------------------------------------------------------

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const USERNAME_RE = /^[a-zA-Z0-9_-]{3,20}$/;

function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    username: u.username ?? null,
    points: u.points ?? 0,
    role: u.role ?? 'user',
    createdAt: u.created_at,
  };
}

app.post('/api/auth/register', (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const username = String(req.body?.username || '').trim();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Invalid email' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'Username must be 3-20 characters (letters, numbers, - or _)' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) return res.status(409).json({ error: 'Email already registered' });
    const nameTaken = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(username);
    if (nameTaken) return res.status(409).json({ error: 'Username already taken' });

    const info = db
      .prepare('INSERT INTO users (email, password_hash, username, created_at) VALUES (?, ?, ?, ?)')
      .run(email, hashPassword(password), username, Date.now());
    const userId = Number(info.lastInsertRowid);

    const { token, expiresAt } = createSession(userId);
    setSessionCookie(res, token, expiresAt);
    res.json({ user: publicUser({ id: userId, email, username, created_at: Date.now() }) });
  } catch (err) {
    console.error('register error:', err.message);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Pre-username accounts pick a name on next visit.
app.post('/api/auth/username', requireAuth, (req, res) => {
  const username = String(req.body?.username || '').trim();
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-20 characters (letters, numbers, - or _)' });
  }
  const taken = db
    .prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE AND id != ?')
    .get(username, req.user.id);
  if (taken) return res.status(409).json({ error: 'Username already taken' });
  db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, req.user.id);
  res.json({ ok: true, username });
});

app.post('/api/auth/login', (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const { token, expiresAt } = createSession(user.id);
    setSessionCookie(res, token, expiresAt);
    res.json({ user: publicUser(user) });
  } catch (err) {
    console.error('login error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  destroySession(tokenFromReq(req));
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const user = currentUser(req);
  res.json({ user: user ? publicUser(user) : null });
});

// --- Games ---------------------------------------------------------------

// Root-property metadata straight off the SGF text (names, ranks) for
// library listings — no full parse needed.
function sgfMeta(sgf) {
  const prop = (name) => {
    const m = sgf.match(new RegExp(`${name}\\[([^\\]]*)\\]`));
    return m ? m[1].trim().slice(0, 80) || null : null;
  };
  return {
    blackName: prop('PB'),
    whiteName: prop('PW'),
    blackRank: prop('BR'),
    whiteRank: prop('WR'),
    size: Number(prop('SZ') || 19),
  };
}

// The review pipeline (engine queries, coordinates, occupancy heuristics) is
// 19x19-only today; reject other sizes at intake instead of reviewing garbage.
function rejectNon19(meta, res) {
  if (meta.size !== 19) {
    res.status(400).json({ error: `Only 19×19 games can be reviewed right now (this one is ${meta.size}×${meta.size})` });
    return true;
  }
  return false;
}

function gameRow(row, includeBody) {
  const base = {
    id: row.id,
    ownerId: row.owner_id,
    title: row.title,
    isPublic: !!row.is_public,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status,
    source: row.source,
    blackName: row.black_name,
    whiteName: row.white_name,
    blackRank: row.black_rank,
    whiteRank: row.white_rank,
  };
  if (row.status === 'pending' || row.status === 'analyzing') {
    base.progress = {
      percent: Math.round((row.analysis_progress ?? 0) * 100),
      phase: row.analysis_phase,
    };
    base.engineOnline = queueStatus().engineOnline;
  }
  if (row.status === 'failed') {
    base.error = row.analysis_error;
  }
  if (includeBody) {
    base.sgf = row.sgf;
    base.analysis =
      row.status === 'ready' && row.analysis ? JSON.parse(row.analysis) : null;
  }
  return base;
}

const GAME_SOURCES = new Set(['upload', 'ogs', 'kgs', 'fox', 'curated']);

// Save a new game (public by default). Without a client-computed analysis the
// game enters the review queue and only reaches the public library when the
// engine review completes.
app.post('/api/games', requireAuth, (req, res) => {
  try {
    const title = String(req.body?.title || 'Untitled game').slice(0, 200);
    const sgf = String(req.body?.sgf || '');
    if (!sgf) return res.status(400).json({ error: 'sgf is required' });
    if (sgf.length > 1_000_000) return res.status(400).json({ error: 'SGF too large' });
    const meta = sgfMeta(sgf);
    const analysis = req.body?.analysis ? JSON.stringify(req.body.analysis) : null;
    if (!analysis && rejectNon19(meta, res)) return;
    const isPublic = req.body?.isPublic === false ? 0 : 1;
    const status = analysis ? 'ready' : 'pending';
    let source = String(req.body?.source || 'upload');
    if (!GAME_SOURCES.has(source)) source = 'upload';
    if (analysis) source = 'client';
    if (source === 'curated' && req.user.role !== 'admin') source = 'upload';
    const now = Date.now();
    const info = db
      .prepare(
        `INSERT INTO games (owner_id, title, sgf, analysis, is_public, created_at, updated_at,
         status, source, analysis_phase, black_name, white_name, black_rank, white_rank)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        req.user.id, title, sgf, analysis, isPublic, now, now,
        status, source, analysis ? null : 'queued',
        meta.blackName, meta.whiteName, meta.blackRank, meta.whiteRank,
      );
    const id = Number(info.lastInsertRowid);
    if (!analysis) enqueueGame(id);
    res.json({ id, status });
  } catch (err) {
    console.error('save game error:', err.message);
    res.status(500).json({ error: 'Failed to save game' });
  }
});

// Re-queue a game for analysis (owner only): retry a failure or re-analyze.
app.post('/api/games/:id/analyze', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM games WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.owner_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Not your game' });
  }
  if (row.status === 'analyzing') return res.status(409).json({ error: 'Already analyzing' });
  db.prepare(
    `UPDATE games SET status = 'pending', attempts = 0, next_attempt_at = 0,
     analysis_progress = 0, analysis_phase = 'queued', analysis_error = NULL WHERE id = ?`,
  ).run(row.id);
  enqueueGame(row.id);
  res.json({ ok: true, status: 'pending' });
});

// List the current user's games.
app.get('/api/games', requireAuth, (req, res) => {
  const rows = db
    .prepare('SELECT * FROM games WHERE owner_id = ? ORDER BY updated_at DESC')
    .all(req.user.id);
  res.json({ games: rows.map((r) => gameRow(r, false)) });
});

// List public games — only ones whose engine review is complete.
app.get('/api/games/public', (req, res) => {
  const filters = ["is_public = 1", "status = 'ready'"];
  const params = [];
  const source = String(req.query.source || '');
  if (GAME_SOURCES.has(source) || source === 'client') {
    filters.push('source = ?');
    params.push(source);
  }
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (q) {
    filters.push('(title LIKE ? OR black_name LIKE ? OR white_name LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  const rows = db
    .prepare(`SELECT * FROM games WHERE ${filters.join(' AND ')} ORDER BY updated_at DESC LIMIT 100`)
    .all(...params);
  res.json({ games: rows.map((r) => gameRow(r, false)) });
});

// Fetch a single game — allowed if public or owned by the requester.
app.get('/api/games/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM games WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!row.is_public) {
    const user = currentUser(req);
    if (!user || user.id !== row.owner_id) return res.status(403).json({ error: 'Private game' });
  }
  res.json({ game: gameRow(row, true) });
});

// Update a game (owner only): title, visibility, sgf, analysis.
app.patch('/api/games/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM games WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.owner_id !== req.user.id) return res.status(403).json({ error: 'Not your game' });

  const title = req.body?.title != null ? String(req.body.title).slice(0, 200) : row.title;
  const isPublic = req.body?.isPublic != null ? (req.body.isPublic ? 1 : 0) : row.is_public;
  const sgf = req.body?.sgf != null ? String(req.body.sgf) : row.sgf;
  const analysis =
    req.body?.analysis !== undefined
      ? req.body.analysis ? JSON.stringify(req.body.analysis) : null
      : row.analysis;

  db.prepare(
    'UPDATE games SET title = ?, is_public = ?, sgf = ?, analysis = ?, updated_at = ? WHERE id = ?',
  ).run(title, isPublic, sgf, analysis, Date.now(), row.id);
  res.json({ ok: true });
});

// Delete a game (owner only).
app.delete('/api/games/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT owner_id FROM games WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.owner_id !== req.user.id) return res.status(403).json({ error: 'Not your game' });
  db.prepare('DELETE FROM games WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// --- Linked game-server accounts ------------------------------------------

app.get('/api/me/accounts', requireAuth, (req, res) => {
  const rows = db
    .prepare('SELECT server, handle, created_at FROM linked_accounts WHERE user_id = ?')
    .all(req.user.id);
  res.json({ accounts: rows.map((r) => ({ server: r.server, handle: r.handle, linkedAt: r.created_at })) });
});

app.post('/api/me/accounts', requireAuth, async (req, res) => {
  try {
    const server = String(req.body?.server || '').toLowerCase();
    const handle = String(req.body?.handle || '').trim().slice(0, 40);
    if (!LINKABLE_SERVERS.has(server)) return res.status(400).json({ error: 'Unknown server' });
    if (!handle) return res.status(400).json({ error: 'Handle is required' });

    // For OGS we can verify the account exists (and normalize its casing).
    let stored = handle;
    if (server === 'ogs') {
      const player = await ogsResolvePlayer(handle);
      if (!player) return res.status(404).json({ error: `No OGS player named "${handle}"` });
      stored = player.username;
    }

    db.prepare(
      `INSERT INTO linked_accounts (user_id, server, handle, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, server) DO UPDATE SET handle = excluded.handle, created_at = excluded.created_at`,
    ).run(req.user.id, server, stored, Date.now());
    res.json({ ok: true, server, handle: stored });
  } catch (err) {
    console.error('link account error:', err.message);
    res.status(502).json({ error: 'Could not verify the account right now' });
  }
});

app.delete('/api/me/accounts/:server', requireAuth, (req, res) => {
  db.prepare('DELETE FROM linked_accounts WHERE user_id = ? AND server = ?').run(
    req.user.id,
    String(req.params.server).toLowerCase(),
  );
  res.json({ ok: true });
});

// --- OGS browsing & import -------------------------------------------------

// Recent finished games for an OGS handle (defaults to the caller's linked one).
app.get('/api/ogs/games', requireAuth, async (req, res) => {
  try {
    let handle = String(req.query.handle || '').trim();
    if (!handle) {
      const linked = db
        .prepare("SELECT handle FROM linked_accounts WHERE user_id = ? AND server = 'ogs'")
        .get(req.user.id);
      if (!linked) return res.status(400).json({ error: 'No OGS account linked' });
      handle = linked.handle;
    }
    const player = await ogsResolvePlayer(handle);
    if (!player) return res.status(404).json({ error: `No OGS player named "${handle}"` });
    const games = await ogsListRecentGames(player.id, Number(req.query.limit) || 20);
    res.json({ player, games });
  } catch (err) {
    console.error('ogs games error:', err.message);
    res.status(502).json({ error: 'OGS is not reachable right now' });
  }
});

// Import one OGS game by id or URL: fetch the SGF server-side and queue it.
app.post('/api/games/import/ogs', requireAuth, async (req, res) => {
  try {
    const gameId = parseOgsGameId(req.body?.game);
    if (!gameId) return res.status(400).json({ error: 'Provide an OGS game id or URL' });

    const existing = db
      .prepare("SELECT id, status FROM games WHERE owner_id = ? AND source = 'ogs' AND title LIKE ?")
      .get(req.user.id, `%#${gameId}`);
    if (existing) return res.json({ id: existing.id, status: existing.status, duplicate: true });

    const sgf = await ogsFetchSgf(gameId);
    const meta = sgfMeta(sgf);
    if (rejectNon19(meta, res)) return;
    const title = `${meta.blackName ?? 'Black'} vs ${meta.whiteName ?? 'White'} — OGS #${gameId}`;
    const now = Date.now();
    const info = db
      .prepare(
        `INSERT INTO games (owner_id, title, sgf, is_public, created_at, updated_at,
         status, source, analysis_phase, black_name, white_name, black_rank, white_rank)
         VALUES (?, ?, ?, 1, ?, ?, 'pending', 'ogs', 'queued', ?, ?, ?, ?)`,
      )
      .run(req.user.id, title, sgf, now, now, meta.blackName, meta.whiteName, meta.blackRank, meta.whiteRank);
    const id = Number(info.lastInsertRowid);
    enqueueGame(id);
    res.json({ id, status: 'pending' });
  } catch (err) {
    console.error('ogs import error:', err.message);
    const status = err.status === 404 ? 404 : 502;
    res.status(status).json({ error: err.message || 'OGS import failed' });
  }
});

registerCommunityRoutes(app);

// In production, serve the built Vite app
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'dist')));
  app.get('{*path}', (_req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
  });
}

const server = app.listen(PORT, () => {
  console.log(`Komi server listening on port ${PORT}`);
  initReviewQueue();
});

// LLM and whole-game analysis requests can stay open for minutes. Node's default
// 5s keepAliveTimeout closes pooled sockets between calls, and the browser then
// races to reuse a socket the server is closing — surfacing as a bare
// "fetch failed" on POSTs (which are not auto-retried). Outlast the client's
// idle timeout so the browser, not the server, closes idle connections.
// headersTimeout must be >= keepAliveTimeout. requestTimeout=0 removes the cap on
// how long a request may take overall (long searches / cold model loads).
server.keepAliveTimeout = 75_000;
server.headersTimeout = 80_000;
server.requestTimeout = 0;
