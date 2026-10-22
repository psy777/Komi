// Engine selector: one import site for "analyze with KataGo", two transports.
//
//   KATAGO_API_URL set   -> remote HTTP transport (katagoRemote.js) — production,
//                           where the GPU lives behind katago-api (RunPod/home box)
//   otherwise            -> local spawned process (katagoEngine.js) — dev on the
//                           Mac with the Metal config
//
// Selection happens per call, not at import time (env loads after ESM imports).

import * as local from './katagoEngine.js';
import * as remote from './katagoRemote.js';

function impl() {
  return process.env.KATAGO_API_URL ? remote : local;
}

/** 'remote' | 'local' */
export function engineMode() {
  return process.env.KATAGO_API_URL ? 'remote' : 'local';
}

export function analyzeGame(moves, opts) {
  return impl().analyzeGame(moves, opts);
}

export function analyzePosition(moves, opts) {
  return impl().analyzePosition(moves, opts);
}

export function isAvailable() {
  return impl().isAvailable();
}

/**
 * Unified health view for the queue and /api/katago/health.
 * Local engines are either configured or not; remote ones can also be warming up.
 * @returns {Promise<{mode: 'remote'|'local', available: boolean, status: 'ok'|'starting'|'offline'}>}
 */
export async function engineHealth() {
  const mode = engineMode();
  if (mode === 'local') {
    const available = local.isAvailable();
    return { mode, available, status: available ? 'ok' : 'offline' };
  }
  const health = await remote.checkHealth();
  return { mode, available: health.ok, status: health.status };
}
