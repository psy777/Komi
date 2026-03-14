/**
 * Client-side proxy for Gemini API calls.
 * Sends requests to our server-side /api/gemini/generate endpoint
 * so the API key never reaches the browser.
 */
export async function geminiGenerate(
  model: string,
  contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>,
  config?: Record<string, unknown>,
): Promise<string> {
  const res = await fetch('/api/gemini/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, contents, config }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Gemini proxy request failed');
  }

  const data = await res.json();
  return data.text || '';
}
