// Server-side review queue: every uploaded/imported game is analyzed by the
// non-LLM pipeline before it appears in the public library.
//
// Deliberately minimal infrastructure — one in-process loop, one in-flight
// job, state in the games table itself. Survives Render deploys (recovery on
// boot), tolerates the GPU endpoint being offline or cold-starting (health
// gate + backoff, rows just stay pending), and distinguishes transient engine
// trouble (retried indefinitely) from bad input (failed after a few tries).

import db from './db.js';
import { engineHealth } from './katago.js';
import { runFullReview, serializeAnalysis } from './reviewPipeline';
import { serverEngineAdapter } from './engineServerAdapter';
import { seedCommentaryForGame } from './seedCommentary';

function cfg() {
  return {
    POLL_MS: Number(process.env.QUEUE_POLL_MS || 15000),
    MAX_ATTEMPTS: Number(process.env.QUEUE_MAX_ATTEMPTS || 3),
    JOB_TIMEOUT_MS: Number(process.env.QUEUE_JOB_TIMEOUT_MS || 20 * 60 * 1000),
    DEEP_MAX_POSITIONS: Number(process.env.REVIEW_DEEP_MAX_POSITIONS || 8),
  };
}

let running = false;        // a job is in flight
let timer = null;           // pending setTimeout tick
let engineOnline = true;    // last health-gate verdict, surfaced via queueStatus
let healthBackoffMs = 30000;
let currentGameId = null;
let jobToken = 0;           // invalidates zombie jobs that outlive their timeout

export function queueStatus() {
  const pending = db.prepare("SELECT COUNT(*) n FROM games WHERE status IN ('pending','analyzing')").get();
  return { engineOnline, pendingCount: pending.n, currentGameId };
}

/** Wake the loop immediately (called when a new game is saved). */
export function enqueueGame(_gameId) {
  scheduleTick(0);
}

export function initReviewQueue() {
  // Recovery: a deploy/crash mid-analysis leaves rows 'analyzing'. Re-queue
  // them (attempts preserved — a crash loop on a poison game still terminates).
  db.prepare(
    "UPDATE games SET status = 'pending', analysis_progress = 0, analysis_phase = 'queued' WHERE status = 'analyzing'",
  ).run();
  scheduleTick(0);
  console.log('[queue] review queue started', queueStatus());
}

function scheduleTick(delayMs) {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  timer = setTimeout(() => {
    timer = null;
    tick().catch((err) => console.error('[queue] tick error:', err));
  }, delayMs ?? cfg().POLL_MS);
  // Don't hold the process open just for the queue.
  if (timer.unref) timer.unref();
}

async function tick() {
  if (running) return; // one in-flight job; the finally{} reschedules

  const row = db
    .prepare(
      "SELECT * FROM games WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY created_at LIMIT 1",
    )
    .get(Date.now());

  if (!row) {
    scheduleTick(cfg().POLL_MS);
    return;
  }

  // Health gate: don't claim (or burn attempts on) a game the engine can't
  // serve. Cold RunPod workers report 'starting'; wait those out too.
  const health = await engineHealth();
  if (!health.available) {
    engineOnline = false;
    scheduleTick(healthBackoffMs);
    healthBackoffMs = Math.min(healthBackoffMs * 2, 5 * 60 * 1000);
    return;
  }
  engineOnline = true;
  healthBackoffMs = 30000;

  running = true;
  currentGameId = row.id;
  const token = ++jobToken;

  db.prepare(
    "UPDATE games SET status = 'analyzing', analysis_started_at = ?, analysis_progress = 0, analysis_phase = 'engine' WHERE id = ?",
  ).run(Date.now(), row.id);

  try {
    const analysis = await withTimeout(analyzeJob(row, token), cfg().JOB_TIMEOUT_MS);
    if (token !== jobToken) return; // a zombie that outlived its timeout — result discarded
    completeJob(row, analysis);
    console.log(`[queue] game ${row.id} analyzed (${analysis.summary.totalMoves} moves)`);
  } catch (err) {
    if (token !== jobToken) return;
    failJob(row, err);
  } finally {
    if (token === jobToken) {
      running = false;
      currentGameId = null;
    }
    scheduleTick(0); // immediately look for the next job
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      jobToken++; // invalidate the zombie so a late result can't double-write
      const err = new Error(`analysis timed out after ${Math.round(ms / 1000)}s`);
      err.transient = true;
      reject(err);
    }, ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

async function analyzeJob(row, token) {
  // Progress fractions: engine sweep dominates wall-clock (~0-0.8), semantic
  // classification is fast (0.8-0.9), deep analysis rounds it out (0.9-1.0).
  let lastWrite = 0;
  let lastPct = -1;

  const onProgress = (p) => {
    if (token !== jobToken) return;
    let frac = 0;
    let phase = p.phase;
    const isDeep = /deep analysis|exploring/i.test(p.message || '');
    if (p.phase === 'engine') {
      frac = 0.8 * (p.total ? p.current / p.total : 0);
    } else if (p.phase === 'semantic' && !isDeep) {
      frac = 0.8 + 0.1 * (p.total ? p.current / p.total : 0);
    } else if (isDeep) {
      frac = 0.9;
      phase = 'deep';
    } else if (p.phase === 'complete') {
      frac = 1;
    }
    const pct = Math.round(frac * 100);
    const now = Date.now();
    if (pct !== lastPct && (now - lastWrite > 2000 || pct - lastPct >= 5 || pct === 100)) {
      lastWrite = now;
      lastPct = pct;
      db.prepare('UPDATE games SET analysis_progress = ?, analysis_phase = ? WHERE id = ?')
        .run(frac, phase, row.id);
    }
  };

  const analysis = await runFullReview(row.sgf, serverEngineAdapter, {
    onProgress,
    deepAnalysisBudget: { maxPositions: cfg().DEEP_MAX_POSITIONS },
  });
  if (analysis.summary.totalMoves === 0) {
    throw new Error('no moves found in SGF'); // deterministic — fails after MAX_ATTEMPTS
  }
  return analysis;
}

function completeJob(row, analysis) {
  const json = JSON.stringify(serializeAnalysis(analysis));
  const seeds = seedCommentaryForGame(analysis);
  const now = Date.now();

  db.exec('BEGIN');
  try {
    db.prepare(
      `UPDATE games SET status = 'ready', analysis = ?, analysis_error = NULL,
       analysis_progress = 1, analysis_phase = NULL, updated_at = ? WHERE id = ?`,
    ).run(json, now, row.id);

    // Seed the wiki once per game; a re-analysis must not duplicate or clobber
    // revisions the community has already written.
    const existing = db
      .prepare('SELECT COUNT(*) n FROM commentary_revisions WHERE game_id = ?')
      .get(row.id);
    if (existing.n === 0) {
      const ins = db.prepare(
        'INSERT INTO commentary_revisions (game_id, move_number, author_id, body, created_at) VALUES (?, ?, NULL, ?, ?)',
      );
      for (const seed of seeds) ins.run(row.id, seed.moveNumber, seed.body, now);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function isTransientError(err) {
  if (err?.transient) return true;
  if (err?.name === 'AbortError') return true;
  if (typeof err?.status === 'number') return err.status >= 500;
  return /katago-api 5\d\d|fetch failed|network|ECONNREFUSED|ETIMEDOUT|socket|engine unavailable|KataGo exited/i.test(
    err?.message || '',
  );
}

function failJob(row, err) {
  const attempts = (row.attempts ?? 0) + 1;
  const transient = isTransientError(err);
  const message = String(err?.message || err).slice(0, 500);

  if (transient) {
    // Engine trouble: retry indefinitely with capped exponential backoff.
    const backoff = Math.min(60000 * 2 ** Math.min(attempts - 1, 6), 60 * 60 * 1000);
    db.prepare(
      "UPDATE games SET status = 'pending', analysis_phase = 'queued', analysis_progress = 0, attempts = ?, next_attempt_at = ?, analysis_error = ? WHERE id = ?",
    ).run(attempts, Date.now() + backoff, message, row.id);
    console.warn(`[queue] game ${row.id} deferred (attempt ${attempts}, transient): ${message}`);
  } else if (attempts < cfg().MAX_ATTEMPTS) {
    db.prepare(
      "UPDATE games SET status = 'pending', analysis_phase = 'queued', analysis_progress = 0, attempts = ?, next_attempt_at = ?, analysis_error = ? WHERE id = ?",
    ).run(attempts, Date.now() + 10000, message, row.id);
    console.warn(`[queue] game ${row.id} retrying (attempt ${attempts}): ${message}`);
  } else {
    db.prepare(
      "UPDATE games SET status = 'failed', analysis_phase = NULL, attempts = ?, analysis_error = ? WHERE id = ?",
    ).run(attempts, message, row.id);
    console.error(`[queue] game ${row.id} failed permanently: ${message}`);
  }
}
