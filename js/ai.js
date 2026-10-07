// ---------------------------------------------------------------------------
// ai.js - the only file that talks to the language model.
//
// Transport has two modes:
//   1. CONFIG.apiBase set   -> POST to our proxy, key stays on the server.
//   2. CONFIG.apiBase empty -> POST straight to Groq with GROQ_KEY.
// Mode 2 exposes the key in browser network traffic. Use mode 1 in public use.
// ---------------------------------------------------------------------------

import { GROQ_KEY, CONFIG } from './config.js';

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

async function post(url, body, extraHeaders, attempt = 0) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
      body: JSON.stringify(body),
    });
  } catch {
    // Offline or DNS failure - the most common rural connectivity failure.
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
      return post(url, body, extraHeaders, attempt + 1);
    }
    throw new Error('No internet connection. Check the network and try again.');
  }

  // Only overload (5xx) is worth retrying. A 429 is a quota decision, so
  // retrying it immediately just burns more of the quota it is protecting.
  // The proxy has already turned Groq's error into one honest sentence, and
  // guessing "wait a minute" sends the patient back to the same failure.
  if (res.status === 429) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(
      detail?.error?.message || 'Groq is rate limiting requests right now. Wait a moment, then tap again.'
    );
  }

  if (res.status >= 500 && attempt < 2) {
    await new Promise((r) => setTimeout(r, 900 * (attempt + 1)));
    return post(url, body, extraHeaders, attempt + 1);
  }

  if (res.status === 400 || res.status === 401 || res.status === 403) {
    const detail = await res.json().catch(() => ({}));
    const msg = detail?.error?.message || `Groq rejected the request (HTTP ${res.status}).`;
    throw new Error(/API key/i.test(msg) ? 'Invalid or missing Groq API key.' : msg);
  }

  if (!res.ok) {
    throw new Error(`Groq error (HTTP ${res.status}).`);
  }

  return res.json();
}

/**
 * Both modes end in the same shape: one string of text. The proxy already
 * flattens Groq's envelope, so direct mode does it here instead.
 */
function extractText(json) {
  const message = json?.error?.message;
  if (message) throw new Error(message);

  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('The model returned an empty response.');
  }
  return content.trim();
}

/**
 * Every identical call would otherwise spend quota again. A clinic re-asks the
 * same handful of phrases constantly - "after food", "twice a day", "not
 * specified", the same follow-up line - so the repeat share of real traffic is
 * large. Caching costs nothing and needs no billing.
 *
 * Session-only on purpose: the README promises no patient data is stored, and
 * translations of patient text are patient data.
 */
const cache = new Map();
const CACHE_MAX = 300;

/** Cache key includes everything that changes the answer. */
function cacheKey({ system, prompt, temperature, schema }) {
  return JSON.stringify([system, prompt, temperature, schema ? 1 : 0]);
}

function remember(key, value) {
  if (cache.size >= CACHE_MAX) {
    // Drop the oldest entry; Map preserves insertion order.
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, value);
}

/** In-flight requests, so two taps cannot both spend quota on the same text. */
const inflight = new Map();

/**
 * One model call.
 * @param {number} [maxTokens] callers under time pressure ask for a short
 *   answer; the urgent panel uses this so a reply arrives while the patient
 *   is still looking at the screen.
 * @returns {Promise<string>} plain text, or a JSON string when schema is given.
 */
export async function callModel({ system, prompt, temperature = 0.3, schema, maxTokens }) {
  const useProxy = Boolean(CONFIG.apiBase);
  if (!useProxy && !GROQ_KEY) {
    throw new Error('No Groq key configured. Add one to js/config.js or start the proxy.');
  }

  const key = cacheKey({ system, prompt, temperature, schema });
  if (cache.has(key)) return cache.get(key);
  if (inflight.has(key)) return inflight.get(key);

  const run = (async () => {
    // Proxy mode sends our neutral payload; the server builds the Groq request.
    if (useProxy) {
      const json = await post(
        `${CONFIG.apiBase}/chat`,
        { system, prompt, temperature, schema, maxTokens },
        undefined
      );
      const text = json?.text;
      if (typeof text !== 'string' || !text.trim()) {
        throw new Error('The server returned an empty response.');
      }
      remember(key, text.trim());
      return text.trim();
    }

    const body = {
      model: CONFIG.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
      temperature,
      top_p: 0.9,
      max_tokens: maxTokens || 2048,
    };

    if (schema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: 'record', strict: true, schema },
      };
    }

    const json = await post(GROQ_ENDPOINT, body, { Authorization: `Bearer ${GROQ_KEY}` });
    const text = extractText(json);
    remember(key, text);
    return text;
  })();

  inflight.set(key, run);
  try {
    return await run;
  } finally {
    inflight.delete(key);
  }
}

/** Exposed for tests and for the reset button, if one is ever added. */
export function clearCache() {
  cache.clear();
}