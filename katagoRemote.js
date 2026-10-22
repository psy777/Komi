// Remote KataGo transport: same contract as katagoEngine.js, but queries go
// over HTTP to a katago-api instance (FastAPI wrapper, /v1/analyze passthrough)
// instead of a locally spawned process. Used in production where the web host
// has no GPU; the GPU lives behind KATAGO_API_URL (RunPod / kata.komireview.com).
//
// Whole-game queries are split into chunks of analyzeTurns so each HTTP request
// stays seconds-long. One mega-request for a 250-move game would sit silent for
// minutes and trip proxy/load-balancer response timeouts (~100s). The cost is
// slightly less search-tree sharing across chunks — tune with KATAGO_REMOTE_CHUNK.

// Read lazily, not at module load: server.js calls dotenv.config() AFTER its
// ESM imports are evaluated, so process.env isn't populated yet at import time.
function cfg() {
  return {
    URL: (process.env.KATAGO_API_URL || '').replace(/\/+$/, ''),
    KEY: process.env.KATAGO_API_KEY || '',
    DEFAULT_VISITS: Number(process.env.KATAGO_VISITS || 500),
    DEFAULT_RULES: process.env.KATAGO_RULES || 'japanese',
    CHUNK: Math.max(1, Number(process.env.KATAGO_REMOTE_CHUNK || 8)),
    TIMEOUT_MS: Number(process.env.KATAGO_REMOTE_TIMEOUT_MS || 90000),
  };
}

// Same komi snapping as the local engine (see katagoEngine.js for rationale).
function sanitizeKomi(komi) {
  if (komi === null || komi === undefined || komi === '') return 6.5;
  const n = Number(komi);
  if (!Number.isFinite(n)) return 6.5;
  const snapped = Math.round(n * 2) / 2;
  return Math.max(-150, Math.min(150, snapped));
}

async function postAnalyze(body, { URL, KEY, TIMEOUT_MS }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${URL}/v1/analyze`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(KEY ? { 'x-api-key': KEY } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`katago-api ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// /v1/analyze returns a single object when one turn was requested, else a list.
function asResultArray(payload) {
  return Array.isArray(payload) ? payload : [payload];
}

function isTransient(err) {
  // Network failures, aborts/timeouts, and 5xx are worth one in-transport retry.
  if (err?.name === 'AbortError') return true;
  if (typeof err?.status === 'number') return err.status >= 500;
  return true; // fetch TypeError (DNS, conn refused, tunnel down)
}

/**
 * Analyze every requested turn of a game, chunked over HTTP.
 * Same signature and return shape as katagoEngine.analyzeGame.
 * @param {Array<[string,string]>} moves - [["B","Q16"],["W","D4"],...]
 */
export async function analyzeGame(moves, opts = {}) {
  const c = cfg();
  if (!c.URL) throw new Error('KATAGO_API_URL is not set');
  const {
    komi = 6.5,
    rules = c.DEFAULT_RULES,
    maxVisits = c.DEFAULT_VISITS,
    includeOwnership = true,
    analyzeTurns,
    onResult,
  } = opts;

  const turns = analyzeTurns ?? Array.from({ length: moves.length + 1 }, (_, i) => i);
  const base = {
    moves,
    rules,
    komi: sanitizeKomi(komi),
    boardXSize: 19,
    boardYSize: 19,
    maxVisits,
    includeOwnership,
    includePolicy: false,
  };

  const all = [];
  for (let i = 0; i < turns.length; i += c.CHUNK) {
    const chunkTurns = turns.slice(i, i + c.CHUNK);
    const body = { ...base, analyzeTurns: chunkTurns };
    let payload;
    try {
      payload = await postAnalyze(body, c);
    } catch (err) {
      if (!isTransient(err)) throw err;
      // One in-transport retry; persistent failure propagates to the caller
      // (the review queue owns real backoff).
      await new Promise((r) => setTimeout(r, 2000));
      payload = await postAnalyze(body, c);
    }
    for (const msg of asResultArray(payload)) {
      all.push(msg);
      if (onResult) {
        try { onResult(msg); } catch { /* never let a consumer break the loop */ }
      }
    }
  }
  all.sort((a, b) => (a.turnNumber ?? 0) - (b.turnNumber ?? 0));
  return all;
}

/** Analyze a single position (the board after all given moves). */
export async function analyzePosition(moves, opts = {}) {
  const results = await analyzeGame(moves, { ...opts, analyzeTurns: [moves.length] });
  return results[0] ?? null;
}

/** True if a remote endpoint is configured. */
export function isAvailable() {
  return Boolean(cfg().URL);
}

/**
 * Probe the remote engine. Distinguishes 'starting' (cold GPU worker loading
 * the model) from 'offline' so the review queue can wait instead of erroring.
 * @returns {Promise<{ok: boolean, status: 'ok'|'starting'|'offline', detail?: string}>}
 */
export async function checkHealth() {
  const c = cfg();
  if (!c.URL) return { ok: false, status: 'offline', detail: 'KATAGO_API_URL not set' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`${c.URL}/v1/health`, { signal: controller.signal });
    if (!res.ok) return { ok: false, status: 'offline', detail: `health ${res.status}` };
    const body = await res.json();
    if (body.status === 'ok' && body.engine_running) return { ok: true, status: 'ok' };
    return { ok: false, status: 'starting' };
  } catch (err) {
    return { ok: false, status: 'offline', detail: err?.message };
  } finally {
    clearTimeout(timer);
  }
}
