// Tool registry for the local Go-review agent.
//
// Each tool is a thin, well-documented wrapper around the persistent KataGo
// analysis engine (katagoEngine.js). The agent loop (goAgent.js) advertises
// these to the model in its system prompt and dispatches the model's JSON tool
// calls here. Executors return COMPACT, plain-language-friendly observation
// objects — never raw 361-float arrays — so a small local model can read them.
//
// Conventions shared with the rest of the app:
//   - Moves are GTP pairs: [["B","D4"],["W","Q16"], ...].
//   - The engine runs reportAnalysisWinratesAs=BLACK, so EVERY winrate and
//     scoreLead below is from Black's perspective: scoreLead > 0 = Black ahead,
//     winrate is Black's win probability. The system prompt tells the model this.
//   - Ownership index = y*19 + x, y=0 top row, Black-positive (see ownershipSummary.ts).

import { analyzePosition } from './katagoEngine.js';

const SIZE = 19;

// Cap KataGo work per probe so an over-eager agent can't melt the GPU. The
// agent gets fast, shallow reads; the main per-move review still uses full visits.
const TOOL_VISITS = Number(process.env.AGENT_TOOL_VISITS || 200);
const MAX_TOOL_VISITS = Number(process.env.AGENT_TOOL_MAX_VISITS || 400);

// --- coordinate helpers ---------------------------------------------------

// GTP columns skip 'I'. Valid: A-H, J-T (cols) with row 1-19, or "pass".
const GTP_RE = /^([A-HJ-T])(1[0-9]|[1-9])$/i;

function isValidGtp(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  return t.toLowerCase() === 'pass' || GTP_RE.test(t);
}

// Resolve the board a tool should act on: the model's explicit `moves` if it
// gave a non-empty list, otherwise the reviewed position (the board right before
// the move under review, supplied via ctx). Defaulting this way means a small
// model can test alternatives with just {candidate:"Q4"} and never has to
// retype the whole game — the #1 source of bad tool calls.
function resolveBoard(argMoves, ctx) {
  if (Array.isArray(argMoves) && argMoves.length > 0) return normalizePairs(argMoves);
  if (Array.isArray(ctx?.beforeMoves)) return ctx.beforeMoves; // already normalized pairs
  return [];
}

// Normalize a move-pair list coming from the model: tolerate ["B","D4"] flat
// pairs, lowercase coords, and stray whitespace. Throws on anything malformed
// so the agent gets a clear observation it can correct, not a silent bad board.
function normalizePairs(moves) {
  if (!Array.isArray(moves)) throw new Error('`moves` must be an array of [color, coord] pairs.');
  return moves.map((pair, i) => {
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new Error(`moves[${i}] must be a [color, coord] pair, got: ${JSON.stringify(pair)}`);
    }
    const color = String(pair[0]).trim().toUpperCase();
    const coord = String(pair[1]).trim().toUpperCase();
    if (color !== 'B' && color !== 'W') throw new Error(`moves[${i}] color must be "B" or "W", got "${pair[0]}".`);
    if (!isValidGtp(coord)) throw new Error(`moves[${i}] coord "${pair[1]}" is not a valid GTP point.`);
    return [color, coord === 'PASS' ? 'pass' : coord];
  });
}

// Whose turn it is after a list of moves (simple alternation; defaults to Black
// on an empty board). Good enough for review of even games.
function sideToMove(pairs) {
  if (pairs.length === 0) return 'B';
  return pairs[pairs.length - 1][0] === 'B' ? 'W' : 'B';
}

const round1 = (n) => Math.round(n * 10) / 10;
const pct = (w) => Math.round((w ?? 0.5) * 100);

// --- ownership → region summary (ported from ownershipSummary.ts) ----------

function bandOf(i) {
  if (i <= 5) return 0;
  if (i <= 12) return 1;
  return 2;
}

function regionName(xBand, yBand) {
  const horiz = xBand === 0 ? 'left' : xBand === 2 ? 'right' : 'center';
  if (yBand === 1 && horiz === 'center') return 'center';
  if (yBand === 1) return `${horiz} side`;
  if (horiz === 'center') return `${yBand === 0 ? 'top' : 'bottom'} side`;
  const vert = yBand === 0 ? 'upper' : 'lower';
  return `${vert}-${horiz} corner`;
}

function regionSums(ownership) {
  const sums = new Map();
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const name = regionName(bandOf(x), bandOf(y));
      sums.set(name, (sums.get(name) ?? 0) + ownership[y * SIZE + x]);
    }
  }
  return sums;
}

// Compact territory snapshot: which regions Black/White control and rough net
// points (skips the contested middle ground to keep the observation short).
function territorySummary(ownership) {
  if (!Array.isArray(ownership) || ownership.length !== SIZE * SIZE) return null;
  const CONTROL = 4;
  const regions = [...regionSums(ownership).entries()]
    .map(([region, sum]) => ({
      region,
      controller: sum > CONTROL ? 'Black' : sum < -CONTROL ? 'White' : 'contested',
      points: round1(Math.abs(sum)),
    }))
    .filter((r) => r.controller !== 'contested')
    .sort((a, b) => b.points - a.points);
  let blackTotal = 0;
  let whiteTotal = 0;
  for (const v of ownership) {
    if (v > 0) blackTotal += v;
    else whiteTotal += -v;
  }
  return {
    regions,
    blackPointsApprox: Math.round(blackTotal),
    whitePointsApprox: Math.round(whiteTotal),
  };
}

// Shape a raw KataGo result into a compact candidate list. `limit` top moves.
function topMoves(result, limit = 5) {
  return (result?.moveInfos || []).slice(0, limit).map((m) => ({
    move: m.move,
    scoreLead: round1(m.scoreLead),          // Black POV
    winratePct: pct(m.winrate),              // Black POV
    policyPct: m.prior != null ? Math.round(m.prior * 100) : null, // "naturalness"
    pv: (m.pv || [m.move]).slice(0, 6),
  }));
}

function rootEval(result) {
  return {
    scoreLead: round1(result?.rootInfo?.scoreLead ?? 0), // Black POV (>0 Black ahead)
    winratePct: pct(result?.rootInfo?.winrate),          // Black POV
  };
}

// --- tool schemas (advertised to the model) -------------------------------

export const TOOL_DOCS = [
  {
    name: 'analyze_position',
    summary:
      "Run KataGo on a board and get the top candidate moves (with score, winrate, and policy/naturalness %), plus the current evaluation.",
    params: {
      moves: 'OPTIONAL array of [color, coord] GTP pairs for the WHOLE board. OMIT it to use the position right before the move under review (the usual case). Only pass it to analyze a different board.',
      komi: 'optional number, defaults to the game komi',
    },
  },
  {
    name: 'evaluate_candidate',
    summary:
      "Play one hypothetical move and see the result: the new score/winrate and the opponent's best reply. Use this to test 'what if THIS move were played instead?'.",
    params: {
      candidate: 'REQUIRED single GTP coord to play, e.g. "F3". The side to move plays it.',
      moves: 'OPTIONAL board BEFORE the candidate. OMIT it to test an alternative to the actual move under review (the usual case) — then the candidate is played by the same side, at the same point in the game.',
      komi: 'optional number',
    },
  },
  {
    name: 'get_territory',
    summary:
      "Get KataGo's territory estimate for a board: which regions Black and White control and rough point totals. Use this to see who owns what, or (by comparing two boards) whether a group lived or died.",
    params: {
      moves: 'OPTIONAL array of [color, coord] pairs. OMIT it to use the position before the move under review. Pass an explicit board (e.g. the position AFTER the played move) to compare territory before vs. after.',
      komi: 'optional number',
    },
  },
];

// --- executors ------------------------------------------------------------

async function analyze_position(args, ctx) {
  const pairs = resolveBoard(args.moves, ctx);
  const komi = Number.isFinite(args.komi) ? args.komi : ctx.komi;
  const result = await analyzePosition(pairs, {
    komi,
    maxVisits: TOOL_VISITS,
    includeOwnership: false,
  });
  if (!result) throw new Error('KataGo returned no result for this position.');
  return {
    sideToMove: sideToMove(pairs) === 'B' ? 'Black' : 'White',
    currentEval: rootEval(result),
    topMoves: topMoves(result, 5),
    note: 'scoreLead and winrate are from BLACK\'s perspective. policyPct = how natural/expected the move is (raw policy, no reading).',
  };
}

async function evaluate_candidate(args, ctx) {
  const pairs = resolveBoard(args.moves, ctx);
  const side = sideToMove(pairs);
  const coordRaw = String(args.candidate ?? '').trim().toUpperCase();
  if (!isValidGtp(coordRaw)) throw new Error(`candidate "${args.candidate}" is not a valid GTP coord.`);
  const coord = coordRaw === 'PASS' ? 'pass' : coordRaw;
  const komi = Number.isFinite(args.komi) ? args.komi : ctx.komi;

  const after = [...pairs, [side, coord]];
  const result = await analyzePosition(after, { komi, maxVisits: TOOL_VISITS, includeOwnership: false });
  if (!result) throw new Error('KataGo returned no result for the candidate position.');
  const reply = (result.moveInfos || [])[0];
  return {
    played: { side: side === 'B' ? 'Black' : 'White', move: coord },
    resultingEval: rootEval(result), // Black POV, AFTER the candidate is played
    opponentBestReply: reply
      ? { move: reply.move, scoreLead: round1(reply.scoreLead), winratePct: pct(reply.winrate), pv: (reply.pv || []).slice(0, 6) }
      : null,
    note: 'resultingEval is Black-POV after your candidate. Compare it to analyze_position\'s currentEval to judge the candidate.',
  };
}

async function get_territory(args, ctx) {
  const pairs = resolveBoard(args.moves, ctx);
  const komi = Number.isFinite(args.komi) ? args.komi : ctx.komi;
  const result = await analyzePosition(pairs, { komi, maxVisits: TOOL_VISITS, includeOwnership: true });
  if (!result) throw new Error('KataGo returned no result for this position.');
  const terr = territorySummary(result.ownership);
  if (!terr) throw new Error('KataGo did not return ownership data for this position.');
  return {
    scoreLead: rootEval(result).scoreLead,
    territory: terr,
    note: 'points are Black-positive net estimates per region; contested regions are omitted.',
  };
}

const EXECUTORS = { analyze_position, evaluate_candidate, get_territory };

/**
 * Dispatch a tool call from the agent. Never throws to the caller for a bad
 * call — instead returns an `{ error }` observation so the agent can read the
 * problem and correct itself (a malformed call should cost a turn, not crash
 * the review). `ctx` carries shared defaults like komi and a max-visit budget.
 */
export async function executeTool(name, args, ctx = {}) {
  const fn = EXECUTORS[name];
  if (!fn) {
    return { error: `Unknown tool "${name}". Available: ${Object.keys(EXECUTORS).join(', ')}.` };
  }
  try {
    return await fn(args || {}, { komi: 6.5, ...ctx });
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

export const TOOL_NAMES = Object.keys(EXECUTORS);
export { TOOL_VISITS, MAX_TOOL_VISITS };
