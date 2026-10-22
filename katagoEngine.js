// Persistent KataGo Analysis Engine manager.
//
// Spawns a single long-lived `katago analysis` subprocess and keeps the
// neural net resident in GPU memory. Queries are written as line-delimited
// JSON to stdin; results arrive as line-delimited JSON on stdout, matched
// back to callers by query id.
//
// Why a persistent process: model load + Metal init costs several seconds.
// Per-request spawning would make every analysis unusably slow. One warm
// process serves the whole app.

import { spawn } from 'child_process';
import readline from 'readline';
import fs from 'fs';

// Read lazily, not at module load: server.js calls dotenv.config() AFTER its
// ESM imports are evaluated, so process.env isn't populated yet at import time.
function cfg() {
  return {
    BIN: process.env.KATAGO_BIN || 'katago',
    MODEL: process.env.KATAGO_MODEL || '',
    CONFIG: process.env.KATAGO_CONFIG || '',
    DEFAULT_VISITS: Number(process.env.KATAGO_VISITS || 500),
    DEFAULT_RULES: process.env.KATAGO_RULES || 'japanese',
  };
}

let proc = null;          // the child process (or null until started)
let started = false;      // spawn attempted
let startError = null;    // fatal startup error, if any
const pending = new Map(); // id -> { resolve, reject, turns, results }
let idCounter = 0;

function nextId() {
  idCounter += 1;
  return `q${idCounter}`;
}

// KataGo only accepts a komi that is an integer or half-integer in
// [-150, 150]; anything else makes it reject the whole query (surfaced to the
// client as a 503). SGFs in the wild carry odd komi values (quarter points,
// out-of-range, NaN), so snap to the nearest legal half-point before sending.
function sanitizeKomi(komi) {
  if (komi === null || komi === undefined || komi === '') return 6.5;
  const n = Number(komi);
  if (!Number.isFinite(n)) return 6.5;
  const snapped = Math.round(n * 2) / 2;
  return Math.max(-150, Math.min(150, snapped));
}

function fail(message) {
  startError = new Error(message);
  console.error(`[katago] ${message}`);
}

/** Lazily spawn the engine on first use. Returns false if unavailable. */
function ensureStarted() {
  if (started) return !startError;
  started = true;

  const { BIN, MODEL, CONFIG } = cfg();
  if (!MODEL || !fs.existsSync(MODEL)) {
    fail(`KATAGO_MODEL is not set or missing: "${MODEL}". Set it in .env.local.`);
    return false;
  }
  if (!CONFIG || !fs.existsSync(CONFIG)) {
    fail(`KATAGO_CONFIG is not set or missing: "${CONFIG}". Set it in .env.local.`);
    return false;
  }

  const args = [
    'analysis',
    '-config', CONFIG,
    '-model', MODEL,
    // Black-perspective scores so downstream sign handling is unambiguous.
    '-override-config', 'reportAnalysisWinratesAs=BLACK',
  ];

  try {
    proc = spawn(BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    fail(`Failed to spawn KataGo: ${err.message}`);
    return false;
  }

  proc.on('error', (err) => fail(`KataGo process error: ${err.message}`));
  proc.on('exit', (code) => {
    const msg = `KataGo exited (code ${code})`;
    for (const p of pending.values()) p.reject(new Error(msg));
    pending.clear();
    proc = null;
    startError = new Error(msg);
  });

  // KataGo logs readiness + diagnostics to stderr; surface only notable lines.
  const errRl = readline.createInterface({ input: proc.stderr });
  errRl.on('line', (line) => {
    if (/error|exception|ready to begin/i.test(line)) console.error(`[katago] ${line}`);
  });

  const outRl = readline.createInterface({ input: proc.stdout });
  outRl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // not JSON (shouldn't happen on stdout, but be safe)
    }
    const entry = pending.get(msg.id);
    if (!entry) return;

    if (msg.error) {
      entry.reject(new Error(msg.error));
      pending.delete(msg.id);
      return;
    }

    // Collect one result per analyzed turn; resolve once all arrive. Fire the
    // optional per-turn callback as each arrives so callers can stream progress.
    entry.results.push(msg);
    if (entry.onResult) {
      try { entry.onResult(msg); } catch { /* never let a consumer break the engine */ }
    }
    if (entry.results.length >= entry.turns) {
      entry.results.sort((a, b) => (a.turnNumber ?? 0) - (b.turnNumber ?? 0));
      entry.resolve(entry.results);
      pending.delete(msg.id);
    }
  });

  console.log(`[katago] engine started (model: ${MODEL.split('/').pop()})`);
  return true;
}

/**
 * Send a raw analysis query and resolve with an array of per-turn results.
 * @param {object} query - KataGo analysis query (id is assigned internally).
 * @param {number} turns - number of results expected (= analyzeTurns.length).
 */
function send(query, turns, onResult) {
  return new Promise((resolve, reject) => {
    if (!ensureStarted()) {
      reject(startError || new Error('KataGo engine unavailable'));
      return;
    }
    const id = nextId();
    pending.set(id, { resolve, reject, turns, results: [], onResult });
    proc.stdin.write(JSON.stringify({ ...query, id }) + '\n');
  });
}

/**
 * Analyze every requested turn of a game in a single shared-tree query.
 * @param {Array<[string,string]>} moves - [["B","Q16"],["W","D4"],...]
 * @param {object} [opts]
 * @returns {Promise<object[]>} one KataGo result per analyzed turn, ordered.
 */
export async function analyzeGame(moves, opts = {}) {
  const { DEFAULT_RULES, DEFAULT_VISITS } = cfg();
  const {
    komi = 6.5,
    rules = DEFAULT_RULES,
    maxVisits = DEFAULT_VISITS,
    includeOwnership = true,
    analyzeTurns,
    onResult,
  } = opts;

  const turns = analyzeTurns ?? Array.from({ length: moves.length + 1 }, (_, i) => i);
  const query = {
    moves,
    rules,
    komi: sanitizeKomi(komi),
    boardXSize: 19,
    boardYSize: 19,
    analyzeTurns: turns,
    maxVisits,
    includeOwnership,
    includePolicy: false,
  };
  return send(query, turns.length, onResult);
}

/** Analyze a single position (the board after all given moves). */
export async function analyzePosition(moves, opts = {}) {
  const results = await analyzeGame(moves, { ...opts, analyzeTurns: [moves.length] });
  return results[0] ?? null;
}

/** True if the engine is configured and hasn't fatally failed. */
export function isAvailable() {
  if (!started) {
    const { MODEL, CONFIG } = cfg();
    return Boolean(MODEL && CONFIG);
  }
  return !startError;
}
