// Pluggable LLM provider for commentary generation.
//
// The client always sends Gemini-shaped requests ({model, contents, config})
// to /api/gemini/generate. This module dispatches to the configured backend
// so the same client works against Google Gemini OR a local OpenAI-compatible
// server (LM Studio, llama.cpp, vLLM, Ollama's /v1, etc.).
//
// Configure via env (.env.local):
//   LLM_PROVIDER     = gemini | lmstudio        (default: gemini)
//   LM_STUDIO_URL    = http://localhost:1234/v1 (OpenAI-compatible base URL)
//   LM_STUDIO_MODEL  = qwen3-32b                (model id as LM Studio reports it)

import { GoogleGenAI } from '@google/genai';

function provider() {
  return (process.env.LLM_PROVIDER || 'gemini').toLowerCase();
}

// --- Gemini ---------------------------------------------------------------

let _ai = null;
function getAI() {
  if (!_ai) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY is not set in server environment.');
    _ai = new GoogleGenAI({ apiKey: key });
  }
  return _ai;
}

async function generateGemini({ model, contents, config }) {
  const ai = getAI();
  const response = await ai.models.generateContent({ model, contents, config });
  return response.text || '';
}

// --- OpenAI-compatible (LM Studio) ----------------------------------------

// Gemini contents [{ role, parts: [{ text }] }] -> OpenAI chat messages.
function toOpenAIMessages(contents) {
  return (contents || []).map((c) => {
    const text = (c.parts || []).map((p) => p.text ?? '').join('');
    const role =
      c.role === 'model' ? 'assistant' : c.role === 'system' ? 'system' : 'user';
    return { role, content: text };
  });
}

// Reasoning models (e.g. Qwen3) spend tokens on hidden reasoning before any
// visible content. The caller's token cap is tuned for non-reasoning Gemini,
// so we add headroom or the answer gets starved before it starts.
const REASONING_HEADROOM = Number(process.env.LM_STUDIO_REASONING_HEADROOM || 4096);

// The first request after LM Studio idle-unloads the model triggers a cold
// load that can take tens of seconds (or, on a big model, well over a minute).
// During that window LM Studio may also briefly refuse/reset connections.
// Give each request a generous timeout and retry transient failures so a cold
// load doesn't surface as a bare "fetch failed". Warm requests are unaffected.
const REQUEST_TIMEOUT_MS = Number(process.env.LM_STUDIO_TIMEOUT_MS || 600000); // 10 min
const MAX_ATTEMPTS = Number(process.env.LM_STUDIO_MAX_RETRIES || 3);

// Connection-level failures (vs. a genuine 4xx) — worth retrying during a load.
function isTransient(err) {
  const code = err?.cause?.code || err?.code || '';
  return (
    err?.name === 'AbortError' ||
    /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE)$/.test(code) ||
    /^UND_ERR_(CONNECT_TIMEOUT|HEADERS_TIMEOUT|SOCKET)$/.test(code) ||
    /fetch failed/i.test(err?.message || '')
  );
}

// Parse an OpenAI-compatible SSE stream, forwarding each delta to onToken and
// returning the full accumulated content. Reasoning models emit the hidden
// chain-of-thought under `reasoning_content` before the answer under `content`.
async function consumeOpenAIStream(res, onToken) {
  let content = '';
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let json;
      try { json = JSON.parse(payload); } catch { continue; }
      const delta = json.choices?.[0]?.delta || {};
      if (delta.reasoning_content) onToken({ reasoning: delta.reasoning_content });
      if (delta.content) {
        content += delta.content;
        onToken({ content: delta.content });
      }
    }
  }
  return content;
}

// Core OpenAI-compatible chat call, working directly on OpenAI-shaped messages
// ([{role, content}]). Shared by the Gemini-shaped generateOpenAI() wrapper and
// the agent-facing llmChat(). Handles cold-load retries and SSE streaming, and
// strips inline <think> reasoning from the returned content.
async function chatOpenAI({ messages, config, signal, onToken }) {
  const base = (process.env.LM_STUDIO_URL || 'http://localhost:1234/v1').replace(/\/$/, '');
  const url = `${base}/chat/completions`;
  const stream = typeof onToken === 'function';
  const body = JSON.stringify({
    model: process.env.LM_STUDIO_MODEL || 'local-model',
    messages,
    temperature: config?.temperature ?? 0.3,
    max_tokens: (config?.maxOutputTokens ?? 1024) + REASONING_HEADROOM,
    stream,
  });

  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // The caller's signal (client disconnect) is already aborted? Stop now.
    if (signal?.aborted) throw new Error('LM Studio request cancelled by caller');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    // Abort the LM Studio fetch if either our timeout fires or the caller cancels.
    const onCallerAbort = () => controller.abort();
    signal?.addEventListener('abort', onCallerAbort, { once: true });
    // Once any token has been forwarded we cannot safely retry (the caller has
    // already seen partial output), so a mid-stream failure is surfaced as-is.
    let emitted = false;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        // 5xx can be transient (model still loading); 4xx is a real error.
        if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
          lastErr = new Error(`LM Studio ${res.status}: ${detail.slice(0, 200)}`);
          await new Promise((r) => setTimeout(r, 2000 * attempt));
          continue;
        }
        throw new Error(`LM Studio error ${res.status}: ${detail.slice(0, 200)}`);
      }
      if (stream) {
        const content = await consumeOpenAIStream(res, (t) => {
          emitted = true;
          onToken(t);
        });
        return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      }
      const data = await res.json();
      let content = data.choices?.[0]?.message?.content || '';
      // Defensively strip inline <think> blocks if a build inlines reasoning.
      content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      return content;
    } catch (err) {
      lastErr = err;
      // Caller cancelled (client disconnected): don't retry — that would just
      // spawn a fresh generation for a request nobody is waiting on.
      if (signal?.aborted) throw new Error('LM Studio request cancelled by caller');
      if (!emitted && isTransient(err) && attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        continue;
      }
      const reason =
        err?.name === 'AbortError'
          ? `no response within ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s (model may be cold-loading)`
          : err?.cause?.code || err?.message || String(err);
      throw new Error(`LM Studio request to ${url} failed: ${reason}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onCallerAbort);
    }
  }
  throw lastErr || new Error('LM Studio request failed');
}

// Gemini-shaped wrapper: translate {contents} -> OpenAI messages, then delegate.
function generateOpenAI({ config, contents, signal, onToken }) {
  return chatOpenAI({ messages: toOpenAIMessages(contents), config, signal, onToken });
}

/**
 * Agent-facing chat entry point. Accepts OpenAI-shaped messages directly
 * ([{role:'system'|'user'|'assistant'|'tool', content}]) and returns the
 * assistant's text content. Used by the local Go-review agent loop, which
 * needs multi-turn message arrays the Gemini {contents} shape can't express.
 * Always routes to the OpenAI-compatible backend (the agent is local-only).
 */
export function llmChat({ messages, config, signal, onToken }) {
  return chatOpenAI({ messages, config, signal, onToken });
}

// --- Dispatch -------------------------------------------------------------

export async function llmGenerate({ model, contents, config, signal, onToken }) {
  switch (provider()) {
    case 'lmstudio':
    case 'openai':
      return generateOpenAI({ config, contents, signal, onToken });
    default:
      return generateGemini({ model, contents, config });
  }
}

export function llmInfo() {
  const p = provider();
  return {
    provider: p,
    model: p === 'gemini' ? 'gemini' : process.env.LM_STUDIO_MODEL || 'local-model',
    endpoint: p === 'gemini' ? null : process.env.LM_STUDIO_URL || 'http://localhost:1234/v1',
  };
}
