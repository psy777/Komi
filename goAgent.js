// Local agentic Go reviewer.
//
// Instead of stuffing a single static prompt with pre-computed KataGo numbers,
// this drives a tool-using loop: a local model (via llmChat) investigates a
// position by calling KataGo tools (goAgentTools.js) — probing candidate moves,
// checking territory, testing "what if" lines — and then writes its review from
// what it actually observed. This is the "agent mode" pattern: the model forms
// and tests its own hypotheses rather than restating numbers it can't verify.
//
// Why a text/JSON ReAct protocol instead of OpenAI native tool-calls: the local
// LM Studio build emits tool intentions as JSON in the message content with an
// empty `tool_calls` array, so we parse the content ourselves. This is also more
// portable across local models. If a model ever DOES return native tool_calls,
// llmChat would surface them in content too (LM Studio inlines them), so this
// parser remains the single source of truth.

import { llmChat } from './llmProvider.js';
import { executeTool, TOOL_DOCS, TOOL_NAMES } from './goAgentTools.js';

const MAX_ITERS = Number(process.env.AGENT_MAX_ITERS || 8);

// ---------------------------------------------------------------------------
// System prompt: interpretive guidance + tool protocol + grounding rules.
// ---------------------------------------------------------------------------

function toolReference() {
  return TOOL_DOCS.map((t) => {
    const params = Object.entries(t.params)
      .map(([k, v]) => `      - ${k}: ${v}`)
      .join('\n');
    return `  • ${t.name} — ${t.summary}\n    parameters:\n${params}`;
  }).join('\n');
}

function systemPrompt(level) {
  return `You are a strong Go (Baduk/Weiqi) teacher reviewing one move of a student's game.
You have a KataGo engine you can query through TOOLS. You do not guess at numbers —
you INVESTIGATE with tools, then explain in plain language what you found.

HOW TO READ THE DATA (read carefully — this is the #1 source of mistakes):
- Every scoreLead and winrate from the tools is from BLACK's perspective.
  scoreLead > 0 means Black is ahead by that many points; < 0 means White is ahead.
  winratePct is Black's win probability. A move is good FOR THE SIDE THAT PLAYS IT
  if it moves the Black-POV numbers in that side's favor (up for Black, down for White).
- policyPct is KataGo's raw policy: how natural/expected a move is BEFORE any reading.
  A high-policy move is one a strong player plays "without thinking"; a low-policy move
  is unusual and needs justification. Use this to say things like "the natural move was X,
  but here the position called for Y".
- To judge a move the student played, compare the evaluation BEFORE it to AFTER it.
  To test an alternative, use evaluate_candidate and compare its resultingEval to the
  current eval. To tell whether a group lived or died, compare get_territory before and after.

TOOLS AVAILABLE:
${toolReference()}

REQUIRED INVESTIGATION — you may NOT finalize until you have done ALL of these:
  1. Tested at least ONE genuine ALTERNATIVE to the move played — a DIFFERENT coordinate —
     with evaluate_candidate, and compared its result to the played move. Re-checking the
     move that was actually played does NOT count: its evaluation is already in the baseline.
  2. Called get_territory at least once, so any claim about territory, influence, frameworks,
     or a group living/dying is grounded in real numbers instead of guessed.
  3. Read the concrete CONTINUATION — the "pv" sequence in your observations — to see what
     actually happens next, rather than imagining it.
A review built on a single probe is unacceptable. Investigate as if you expect to be proven wrong.

GROUNDING — DO NOT HALLUCINATE (the most important rule):
- Every factual claim must trace to a SPECIFIC observation: a score/winrate number, a policy %,
  a pv line, or a territory figure you actually retrieved. If you did not observe it, do not say it.
- These words are BANNED unless a tool observation concretely demonstrates them: "vital point",
  "thickness", "influence", "framework", "good shape", "connects", "kills", "lives", "neutralizes",
  "sabaki". Example of allowed use: get_territory shows White's corner dropped from +12 to contested,
  so you may say the move reduced that corner. Without such evidence, do not use these words.
- Refer to moves ONLY by coordinates that appear in your observations. Never invent stones.
- If the played move is already KataGo's top choice, do NOT pad with praise. Explain it CONCRETELY:
  what the continuation (pv) accomplishes, and contrast it with the best ALTERNATIVE you tested —
  show with the numbers why that alternative is worse. Vague approval is a failure.

PROTOCOL — every message you send MUST be exactly ONE JSON object and nothing else:
- To call a tool:
  {"action":"tool","tool":"<name>","parameters":{ ... }}
- Only after the REQUIRED INVESTIGATION above, give your final review:
  {"action":"final",
   "headline":"one-line summary grounded in what you found",
   "explanation":"2-4 short paragraphs — concrete lines and numbers, not abstract principles",
   "whatWasPlayed":"the move played and its intent",
   "whatWasBetter":"the better move and why, citing the numbers (empty if the move was best)",
   "concept":"one Go concept to study",
   "followUpHint":"a question prompting deeper thought"}

RULES:
- Cite ONLY coordinates from a tool observation or the move context. If a tool errors, read it
  and correct your next call.
- Teach at this level: ${level}. Prefer concrete continuations and numbers over generalities.
- Output ONLY the JSON object. No prose outside it, no markdown fences.`;
}

// ---------------------------------------------------------------------------
// Robust JSON extraction from a model turn.
// ---------------------------------------------------------------------------

// Pull the first balanced {...} object out of arbitrary model text (handles
// markdown fences, leading prose, and braces inside strings). Returns the raw
// JSON substring plus any prose that preceded it (the model's "thinking").
function extractJsonObject(text) {
  const cleaned = text.replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return { json: cleaned.slice(start, i + 1), prose: cleaned.slice(0, start).trim() };
      }
    }
  }
  return null;
}

// Classify a parsed object into a tool call or a final answer, tolerant of the
// loose shapes small models emit ({tool,parameters} without "action", etc.).
function interpret(obj) {
  if (!obj || typeof obj !== 'object') return { kind: 'unknown' };
  const action = String(obj.action || '').toLowerCase();
  const toolName = obj.tool || obj.name || obj.tool_name;
  const params = obj.parameters || obj.arguments || obj.args || obj.params || {};

  if (action === 'final' || (!toolName && (obj.headline || obj.explanation))) {
    return { kind: 'final', answer: obj };
  }
  if (toolName) {
    return { kind: 'tool', tool: String(toolName), params };
  }
  return { kind: 'unknown' };
}

function clip(s, n) {
  if (typeof s !== 'string') return s;
  return s.length > n ? s.slice(0, n) : s;
}

// Shape whatever the model returned into the explanation object the UI expects.
function normalizeFinal(answer, trace) {
  return {
    headline: clip(answer.headline, 200) || 'Analysis',
    explanation: clip(answer.explanation, 4000) || '',
    whatWasPlayed: clip(answer.whatWasPlayed, 1500) || '',
    whatWasBetter: clip(answer.whatWasBetter, 1500) || undefined,
    concept: clip(answer.concept, 200) || undefined,
    followUpHint: clip(answer.followUpHint, 400) || undefined,
    trace,
  };
}

// ---------------------------------------------------------------------------
// The loop.
// ---------------------------------------------------------------------------

/**
 * Run the agentic review of a single move.
 *
 * @param {object} input
 * @param {Array<[string,string]>} input.moves  full game move pairs
 * @param {number} input.moveNumber             1-based move under review
 * @param {number} [input.komi]
 * @param {string} [input.playerLevel]          e.g. "beginner (around 18 kyu)"
 * @param {object} [input.context]              optional pre-computed hints (classification, pointsLost, engineTopMove)
 * @param {object} [opts]
 * @param {(e:object)=>void} [opts.onEvent]     progress callback (tool_call, observation, thought, final, error)
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<object>} normalized explanation + trace
 */
export async function runGoAgentReview(input, opts = {}) {
  const { moves = [], moveNumber, komi = 6.5, playerLevel = 'an intermediate player', context = {} } = input;
  const { onEvent = () => {}, signal } = opts;

  const idx = Math.max(1, Math.min(moveNumber, moves.length));
  const before = moves.slice(0, idx - 1);   // board the student faced
  const played = moves[idx - 1];            // the move under review: [color, coord]
  const movedSide = played?.[0] === 'B' ? 'Black' : 'White';
  // beforeMoves lets the tools default to the reviewed position, so the model
  // can probe alternatives without ever retyping the board.
  const ctx = { komi, beforeMoves: before };

  const emit = (e) => { try { onEvent(e); } catch { /* never let the UI break the loop */ } };

  // Seed with an engine baseline of the position the student faced, so the agent
  // starts grounded and doesn't spend its first turn on the obvious query.
  emit({ type: 'status', message: 'Reading the position with KataGo…' });
  const baseline = await executeTool('analyze_position', { moves: before, komi }, ctx);
  emit({ type: 'baseline', observation: baseline });

  const moveList = before.length
    ? before.map((m, i) => `${i + 1}.${m[0]} ${m[1]}`).join('  ')
    : '(empty board)';

  const userBrief =
    `MOVE UNDER REVIEW: move ${idx} — ${movedSide} played ${played?.[1] ?? '(unknown)'}.\n` +
    `Komi ${komi}.\n` +
    `PRIOR MOVES (the board ${movedSide} faced, GTP):\n${moveList}\n` +
    (context.classification ? `Pre-classified as: ${context.classification}` +
      (context.pointsLost != null ? ` (~${context.pointsLost} pts lost)` : '') + '.\n' : '') +
    `\nENGINE BASELINE (KataGo on that position, Black-POV):\n` +
    JSON.stringify(baseline) +
    `\n\nTOOL TIP: to test an alternative to ${movedSide}'s actual move, call evaluate_candidate with just a "candidate" and OMIT "moves" — it defaults to this exact position with ${movedSide} to play. ` +
    `To check what the played move ${played?.[1] ?? ''} actually did, evaluate it as a candidate too.\n` +
    `\nInvestigate as needed with tools, then deliver your final review of ${movedSide}'s move ${played?.[1] ?? ''}.`;

  const messages = [
    { role: 'system', content: systemPrompt(playerLevel) },
    { role: 'user', content: userBrief },
  ];

  const trace = [{ tool: 'analyze_position', params: { moves: `…${before.length} moves`, komi }, observation: baseline, seeded: true }];

  // Investigation gate: a final answer is only accepted once the agent has done
  // real work — at minimum tested a genuine alternative AND checked territory.
  // Re-evaluating the played move (already in the baseline) does not count. This
  // is what stops the "looked at one move, then wrote confident filler" failure.
  const playedCoord = String(played?.[1] ?? '').toUpperCase();
  let testedAlternative = false;
  let checkedTerritory = false;
  let finalNudges = 0;
  const MAX_FINAL_NUDGES = 2;

  for (let iter = 0; iter < MAX_ITERS; iter++) {
    if (signal?.aborted) throw new Error('Agent review cancelled.');

    const lastTurn = iter === MAX_ITERS - 1;
    if (lastTurn) {
      messages.push({
        role: 'user',
        content: 'You have no tool calls left. Respond now with ONLY the final JSON object (action:"final").',
      });
    }

    const raw = await llmChat({
      messages,
      config: { temperature: 0.3, maxOutputTokens: 1200 },
      signal,
    });

    const extracted = extractJsonObject(raw || '');
    if (!extracted) {
      // Model produced no parseable JSON; nudge it once and retry the turn.
      emit({ type: 'thought', text: clip(raw, 400) });
      messages.push({ role: 'assistant', content: raw || '' });
      messages.push({ role: 'user', content: 'That was not a JSON object. Reply with EXACTLY one JSON object per the protocol.' });
      continue;
    }
    if (extracted.prose) emit({ type: 'thought', text: clip(extracted.prose, 600) });

    let parsed;
    try {
      parsed = JSON.parse(extracted.json);
    } catch {
      messages.push({ role: 'assistant', content: raw });
      messages.push({ role: 'user', content: 'Your JSON did not parse. Send one valid JSON object.' });
      continue;
    }

    const decision = interpret(parsed);

    if (decision.kind === 'final') {
      // Refuse a premature conclusion: require a real alternative + a territory
      // read before accepting. Nudge with exactly what's missing, up to a cap
      // (and never on the forced last turn, where we just take what we get).
      const missing = [];
      if (!testedAlternative) missing.push(`test a genuine ALTERNATIVE to ${playedCoord || 'the move'} (a DIFFERENT point) with evaluate_candidate and compare the numbers`);
      if (!checkedTerritory) missing.push('call get_territory to ground any claim about territory, influence, or a group living/dying');
      if (missing.length > 0 && finalNudges < MAX_FINAL_NUDGES && !lastTurn) {
        finalNudges++;
        emit({ type: 'status', message: 'Pushing the agent to investigate before concluding…' });
        messages.push({ role: 'assistant', content: extracted.json });
        messages.push({
          role: 'user',
          content:
            `Not enough investigation to conclude yet. Before finalizing you must still: ${missing.join('; ')}. ` +
            `Do ONE of these now as a tool call, then continue. Re-checking ${playedCoord || 'the played move'} itself does not count.`,
        });
        continue;
      }
      emit({ type: 'final', answer: decision.answer });
      return normalizeFinal(decision.answer, trace);
    }

    if (decision.kind === 'tool') {
      if (!TOOL_NAMES.includes(decision.tool)) {
        messages.push({ role: 'assistant', content: extracted.json });
        messages.push({ role: 'user', content: `OBSERVATION: ${JSON.stringify({ error: `Unknown tool "${decision.tool}". Use one of: ${TOOL_NAMES.join(', ')}.` })}` });
        continue;
      }
      emit({ type: 'tool_call', tool: decision.tool, params: decision.params });
      const observation = await executeTool(decision.tool, decision.params, ctx);
      emit({ type: 'observation', tool: decision.tool, observation });
      trace.push({ tool: decision.tool, params: decision.params, observation });

      // Track whether this was real investigation (ignore errors and redundant
      // re-tests of the played move, which add nothing over the baseline).
      const errored = observation && typeof observation === 'object' && observation.error;
      if (!errored) {
        if (decision.tool === 'get_territory') checkedTerritory = true;
        if (decision.tool === 'evaluate_candidate') {
          const cand = String(decision.params?.candidate ?? '').trim().toUpperCase();
          if (cand && cand !== playedCoord) testedAlternative = true;
        }
      }

      messages.push({ role: 'assistant', content: extracted.json });
      messages.push({ role: 'user', content: `OBSERVATION: ${JSON.stringify(observation)}` });
      continue;
    }

    // Unknown shape: ask for a valid action.
    messages.push({ role: 'assistant', content: extracted.json });
    messages.push({ role: 'user', content: 'That JSON had no recognizable action. Send {"action":"tool",...} or {"action":"final",...}.' });
  }

  // Ran out of iterations without a final answer — make one last, explicit ask.
  emit({ type: 'status', message: 'Wrapping up…' });
  messages.push({ role: 'user', content: 'Stop investigating. Output ONLY the final review JSON now (action:"final").' });
  const raw = await llmChat({ messages, config: { temperature: 0.3, maxOutputTokens: 1200 }, signal });
  const extracted = extractJsonObject(raw || '');
  if (extracted) {
    try {
      const answer = JSON.parse(extracted.json);
      const decision = interpret(answer);
      if (decision.kind === 'final') {
        emit({ type: 'final', answer: decision.answer });
        return normalizeFinal(decision.answer, trace);
      }
    } catch { /* fall through to fallback */ }
  }

  // Last resort: synthesize a minimal answer from the baseline so the UI always
  // gets something grounded rather than an error.
  const fallback = {
    headline: `${movedSide}'s move ${played?.[1] ?? ''}`,
    explanation: 'The reviewer could not complete a full analysis in time. Engine baseline for the position is included in the investigation trace.',
    whatWasPlayed: `${movedSide} played ${played?.[1] ?? '(unknown)'}.`,
  };
  emit({ type: 'final', answer: fallback });
  return normalizeFinal(fallback, trace);
}
