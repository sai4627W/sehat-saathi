// ---------------------------------------------------------------------------
// server.js - static file server + Groq proxy. No npm install required.
//
//   GROQ_API_KEY=your_key node server.js
//
// Why this exists: with a proxy the key stays on the server. Ship the static
// files without it and the key is readable by anyone who opens devtools.
// ---------------------------------------------------------------------------

const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');

// Groq's DNS (Cloudflare) answers with an IPv6 address first. On a machine with
// no working IPv6 route, Node's fetch then dies with ENETUNREACH before it ever
// tries the IPv4 address, and every call comes back as HTTP 502. Happy
// Eyeballs makes it fall back to IPv4 the way curl does. Default since Node 20;
// set explicitly so older builds behave the same.
if (typeof net.setDefaultAutoSelectFamily === 'function') {
  net.setDefaultAutoSelectFamily(true);
}

const PORT = process.env.PORT || 3000;

// Groq runs BOTH halves of the AI work: the language calls (translation,
// prescription parsing) and speech-to-text. One key, one vendor, one bill.
//
// It replaced Gemini because Gemini's free tier is a ~20 requests *per day*
// budget - a single consultation spends six of them, so a free Gemini key
// supported about three consultations a day and then failed until midnight.
// Groq's free tier is a standing per-minute quota instead (1,000 requests a day
// on the default model), which is the same order of magnitude a clinic needs
// without the cliff.
//
// Regional TTS still has to come from the device, because Groq's synthesiser
// speaks only English and Arabic.
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const CHAT_MODEL = process.env.GROQ_CHAT_MODEL || 'openai/gpt-oss-120b';
const STT_MODEL = process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo';
const GROQ_PAID = process.env.GROQ_PAID === '1';

const CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const ROOT = __dirname;

// --- rate limit ------------------------------------------------------------
// 30 calls per minute per IP. A consult is roughly 6 calls, so this allows a
// clinic to work normally while stopping someone from draining the quota.
// Deliberately not higher than Groq's own free-tier ceiling (30 req/min): a
// local 429 is instant and free, whereas an upstream one wastes the request.
const WINDOW_MS = 60_000;
const hits = new Map();

/** Per-IP sliding-window counter. Two limits share the same Map by prefix. */
function limiter(bucket, maxCalls) {
  return (ip) => {
    const now = Date.now();
    const key = `${bucket}:${ip}`;
    const entry = hits.get(key);
    if (!entry || now > entry.reset) {
      hits.set(key, { count: 1, reset: now + WINDOW_MS });
      return false;
    }
    entry.count += 1;
    return entry.count > maxCalls;
  };
}

const rateLimited = limiter('chat', 30);
const relayLimited = limiter('relay', 120);

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of hits) if (now > entry.reset) hits.delete(key);
}, WINDOW_MS).unref();

// --- helpers ---------------------------------------------------------------

function send(res, status, type, body, extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, 'application/json', JSON.stringify(obj));
}

function readBody(req, limitBytes = 200_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('Request too large.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('Invalid JSON body.'));
      }
    });
    req.on('error', reject);
  });
}

/** Raw bytes, for audio. Same ceiling rule as readBody. */
function readRaw(req, limitBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        const err = new Error('Recording too long. Speak for under a minute and try again.');
        err.tooBig = true;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Build a multipart/form-data body around a Buffer. Groq's audio endpoint is
 * OpenAI-compatible and only accepts multipart, so the browser cannot post
 * straight to it - the key has to stay on this side.
 */
function multipart(fields, file) {
  const boundary = `----sehat${Buffer.from(String(Date.now()) + Math.random()).toString('hex')}`;
  const head = [];
  for (const [name, value] of Object.entries(fields)) {
    head.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8'
      )
    );
  }
  const fileHead = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\n` +
      `Content-Type: ${file.contentType}\r\n\r\n`,
    'utf8'
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    body: Buffer.concat([...head, fileHead, file.data, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/** BCP-47 ("hi-IN") to the ISO-639-1 two-letter code Whisper expects. */
function iso6391(tag) {
  return String(tag || '').split('-')[0].toLowerCase();
}

const AUDIO_TYPES = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
};

// Groq's free tier caps uploads at 25 MB. Whisper's minimum billable length is
// 10 seconds, so a cap here is about protecting the budget, not the user.
const MAX_AUDIO_FREE = 25 * 1024 * 1024;
const MAX_AUDIO_DEV = 100 * 1024 * 1024;

// --- transcription ---------------------------------------------------------

async function handleTranscribe(req, res) {
  if (!GROQ_KEY) {
    return sendJson(res, 503, {
      error: {
        message:
          'Server-side speech recognition is not set up. Add GROQ_API_KEY to .env, or use Chrome.',
      },
    });
  }

  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim();
  const ext = AUDIO_TYPES[contentType];
  if (!ext) {
    return sendJson(res, 415, {
      error: { message: `This browser recorded ${contentType || 'an unsupported format'}.` },
    });
  }

  const overLimit = GROQ_PAID ? MAX_AUDIO_DEV : MAX_AUDIO_FREE;
  let audio;
  try {
    audio = await readRaw(req, overLimit);
  } catch (err) {
    return sendJson(res, err.tooBig ? 413 : 400, { error: { message: err.message } });
  }

  if (!audio.length) {
    return sendJson(res, 400, { error: { message: 'No audio was recorded.' } });
  }

  const language = iso6391(req.headers['x-lang'] || '');

  // Whisper hallucinates text on silence or noise, so this header from the
  // browser matters: it is the difference between "no speech detected" and a
  // confident, entirely invented sentence going into a medical record.
  const noSpeech = Number(req.headers['x-speech-prob'] || '0');

  const form = multipart(
    {
      model: STT_MODEL,
      response_format: 'verbose_json',
      temperature: '0',
      ...(language && language !== 'en' ? { language } : {}),
      ...(noSpeech > 0.6 ? { prompt: 'The audio contains no speech. Transcribe nothing.' } : {}),
    },
    { filename: `recording.${ext}`, contentType, data: audio }
  );

  try {
    const upstream = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': form.contentType },
      body: form.body,
      signal: AbortSignal.timeout(30_000),
    });

    const raw = await upstream.text();

    if (!upstream.ok) {
      let message = `Speech recognition failed (HTTP ${upstream.status}).`;
      try {
        message = JSON.parse(raw)?.error?.message || message;
      } catch { /* keep default */ }

      if (upstream.status === 429) {
        return sendJson(res, 429, {
          error: { message: 'Speech recognition is busy or out of daily audio allowance. Try again shortly.' },
          quotaExhausted: /rate_limit|quota|limit/i.test(message),
        });
      }
      if (upstream.status === 401 || upstream.status === 403) {
        return sendJson(res, upstream.status, { error: { message: 'GROQ_API_KEY was rejected.' } });
      }
      return sendJson(res, upstream.status, { error: { message } });
    }

    const json = JSON.parse(raw);
    const text = String(json?.text || '').trim();

    // Treat "silence" as no-speech rather than passing invented words on.
    const avgLogprob = json?.segments?.length
      ? json.segments.reduce((s, x) => s + (x.avg_logprob ?? 0), 0) / json.segments.length
      : null;
    const silent = noSpeech > 0.6 || (text.length < 2 && avgSpeech(json) < 0.6);

    return sendJson(res, 200, {
      text: silent ? '' : text,
      empty: silent,
      duration: json?.duration ?? null,
      language: json?.language ?? language ?? null,
    });
  } catch (err) {
    const offline = err.name === 'TimeoutError';
    return sendJson(res, 502, {
      error: {
        message: offline
          ? 'Speech recognition took too long. Speak for less time and try again.'
          : 'Could not reach the speech service. Check the server internet connection.',
      },
    });
  }
}

function avgSpeech(json) {
  const segs = json?.segments;
  if (!segs?.length) return 0;
  return segs.reduce((s, x) => s + (x.no_speech_prob ?? 1), 0) / segs.length;
}

// --- chat proxy ------------------------------------------------------------

/**
 * Groq's structured-output mode is OpenAI *strict* JSON Schema, which is
 * fussier than the schema dialect the callers are written in: every object must
 * set `additionalProperties: false` and list every one of its properties in
 * `required`, or Groq rejects the whole request. Fill both in here rather than
 * making each caller write them out by hand.
 */
function strictSchema(node) {
  if (Array.isArray(node)) return node.map(strictSchema);
  if (!node || typeof node !== 'object') return node;

  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = strictSchema(v);

  if (out.type === 'object' || out.properties) {
    out.additionalProperties = false;
    if (out.properties) out.required = Object.keys(out.properties);
  }
  return out;
}

/**
 * The free tier is per-minute, and unlike Gemini's daily budget it recovers on
 * its own within seconds. Groq states the real wait in the error body, so pass
 * that on instead of a vague "try later" that makes a patient re-tap into the
 * same wall.
 */
function chatQuotaMessage(message, retryText) {
  if (/per day|daily/i.test(message)) {
    return 'Groq\'s daily free request limit is used up. It resets in about 24 hours.';
  }
  if (retryText) {
    const secs = Math.ceil(Number(retryText) || 0);
    const wait = secs >= 90 ? `about ${Math.round(secs / 60)} minutes` : `${secs} second${secs === 1 ? '' : 's'}`;
    return `Groq is busy right now. Try again in ${wait}.`;
  }
  return 'Groq is busy right now. Wait a moment, then tap again.';
}

async function handleChat(req, res) {
  if (!GROQ_KEY) {
    return sendJson(res, 500, {
      error: { message: 'Server has no GROQ_API_KEY set. Restart with GROQ_API_KEY=...' },
    });
  }

  const ip = req.socket.remoteAddress || 'unknown';
  if (rateLimited(ip)) {
    return sendJson(res, 429, {
      error: { message: 'Too many requests. Wait a minute and try again.' },
    });
  }

  let payload;
  try {
    payload = await readBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: { message: err.message } });
  }

  const { system, prompt, temperature, schema, maxTokens } = payload;
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return sendJson(res, 400, { error: { message: 'Missing prompt.' } });
  }
  if (prompt.length > 20_000) {
    return sendJson(res, 400, { error: { message: 'Prompt too long.' } });
  }

  const base = {
    model: CHAT_MODEL,
    messages: [
      { role: 'system', content: String(system || '').slice(0, 8000) },
      { role: 'user', content: prompt },
    ],
    temperature: typeof temperature === 'number' ? temperature : 0.3,
    top_p: 0.9,
  };

  if (schema) {
    base.response_format = {
      type: 'json_schema',
      json_schema: { name: 'record', strict: true, schema: strictSchema(schema) },
    };
  }

  // Callers under time pressure (the urgent panel) ask for a short answer.
  // Capped well below the model's ceiling so one bad prompt cannot swallow
  // the whole response budget.
  let budget = Number.isFinite(maxTokens)
    ? Math.min(Math.max(Math.round(maxTokens), 128), 8000)
    : 2048;

  // Two attempts, not one: a reasoning model can spend the whole budget on
  // its chain of thought and hand back nothing, which is worth one retry with
  // more room rather than a failed tap for the user.
  for (let attempt = 0; attempt < 2; attempt++) {
    const body = { ...base, max_tokens: budget };

    let upstream;
    let text;
    try {
      upstream = await fetch(CHAT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${GROQ_KEY}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(45_000),
      });
      text = await upstream.text();
    } catch (err) {
      const timedOut = err.name === 'TimeoutError';
      if (attempt === 0 && !timedOut) continue; // dropped connection, try once more
      return sendJson(res, 502, {
        error: {
          message: timedOut
            ? `${CHAT_MODEL} took too long to answer. Try again.`
            : 'Could not reach Groq. Check the server internet connection.',
        },
      });
    }

    if (!upstream.ok) {
      let message = `Groq error (HTTP ${upstream.status}).`;
      try {
        message = JSON.parse(text)?.error?.message || message;
      } catch { /* keep default */ }

      if (upstream.status === 429) {
        const raw = message.match(/try again in\s+([\d.]+)/i)?.[1] || null;
        return sendJson(res, 429, {
          error: { message: chatQuotaMessage(message, raw) },
          quotaExhausted: /per day|daily/i.test(message),
          retryAfter: raw,
        });
      }

      if (upstream.status === 401 || upstream.status === 403) {
        return sendJson(res, upstream.status, {
          error: { message: 'GROQ_API_KEY was rejected.' },
        });
      }

      // Groq answers with the odd 400 or a gateway blip even for a request it
      // accepted a second earlier. One more go before the user sees an error.
      const transient = [400, 500, 502, 503, 504].includes(upstream.status);
      if (attempt === 0 && transient) continue;

      return sendJson(res, upstream.status, { error: { message } });
    }

    // Collapse Groq's envelope to one string here so the browser never has to
    // know which vendor is upstream. Reasoning models put their chain of
    // thought in a separate field, so `content` is already the clean answer.
    let choice = null;
    try {
      choice = JSON.parse(text)?.choices?.[0];
    } catch { /* treat as an empty answer below */ }
    const answer = choice?.message?.content;

    if (typeof answer === 'string' && answer.trim()) {
      return sendJson(res, 200, { text: answer.trim() });
    }

    if (attempt === 0 && choice?.finish_reason === 'length') {
      budget = Math.min(8000, Math.max(budget * 3, 1500));
      continue;
    }

    return sendJson(res, 502, {
      error: {
        message:
          choice?.finish_reason === 'length'
            ? 'The answer was too long and got cut off. Shorten the input and try again.'
            : `${CHAT_MODEL} returned an empty response.`,
      },
    });
  }
}

// --- room relay ------------------------------------------------------------
//
// The doctor and the patient are usually on two different phones, so messages
// are relayed through the server rather than being local-only. Rooms live in
// memory and nothing is written to disk: a room disappears two hours after the
// last activity, which is all a single consultation needs and keeps patient
// text out of any store.
//
// Delivery is long-polling. WebSockets would be nicer, but they need a second
// dependency and break on the captive-portal Wi-Fi a clinic often has, whereas
// one held-open GET survives a proxy bouncing the connection every 30s.

const ROOM_TTL = 2 * 60 * 60 * 1000; // idle room -> dropped
const ROOM_MAX_MSGS = 300; // one consultation never gets near this
const WAIT_MS = 25_000; // long-poll hold, under most proxy idle limits
const PRESENCE_MS = 70_000; // a poll is 25s, so two missed polls = away
const rooms = new Map();

const RELAY_KINDS = new Set(['msg', 'transcript', 'rx', 'sos', 'advice']);

/** "k7x-4q2" and "K7X4Q2" are the same room. Letters only, no look-alikes. */
function roomCode(raw) {
  const code = String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 12);
  return code.length >= 4 ? code : null;
}

function getRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    room = {
      seq: 0,
      msgs: [],
      waiters: new Set(),
      seen: { doctor: 0, patient: 0 },
      typing: { doctor: 0, patient: 0 },
      meta: { doctor: null, patient: null },
      active: Date.now(),
    };
    rooms.set(code, room);
  }
  room.active = Date.now();
  return room;
}

function wake(room) {
  for (const resolve of [...room.waiters]) resolve();
}

function peersOnline(room, now = Date.now()) {
  return {
    doctor: now - room.seen.doctor < PRESENCE_MS,
    patient: now - room.seen.patient < PRESENCE_MS,
  };
}

async function handleRelayPost(req, res) {
  const ip = req.socket.remoteAddress || 'unknown';
  if (relayLimited(ip)) {
    return sendJson(res, 429, { error: { message: 'Slow down for a moment.' } });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: { message: err.message } });
  }

  const code = roomCode(body.room);
  const from = body.from === 'doctor' || body.from === 'patient' ? body.from : null;
  if (!code || !from) {
    return sendJson(res, 400, { error: { message: 'A room code and a sender are required.' } });
  }
  const room = getRoom(code);

  // Joining. Carries who the other side is, so the peer's name and language
  // are known before the first message rather than after it.
  if (body.kind === 'hello') {
    room.meta[from] = {
      name: String(body.name || '').slice(0, 80),
      age: String(body.age || '').slice(0, 8),
      lang: String(body.lang || '').slice(0, 16),
      at: Date.now(),
    };
    wake(room);
    return sendJson(res, 200, { ok: true, seq: room.seq, peers: peersOnline(room), meta: room.meta });
  }

  // "typing" is a hint, not content: broadcast to whoever is waiting right now
  // and never stored, so it cannot end up in the transcript.
  if (body.kind === 'typing') {
    room.typing[from] = Date.now();
    wake(room);
    return sendJson(res, 200, { ok: true });
  }

  const kind = RELAY_KINDS.has(body.kind) ? body.kind : 'msg';
  const text = String(body.text || '').slice(0, 6000);
  if (!text.trim()) {
    return sendJson(res, 400, { error: { message: 'Empty message.' } });
  }

  const msg = {
    id: ++room.seq,
    from,
    kind,
    text,
    native: String(body.native || '').slice(0, 6000),
    lang: String(body.lang || '').slice(0, 16),
    at: Date.now(),
    meta: body.meta && typeof body.meta === 'object' ? body.meta : null,
  };
  room.msgs.push(msg);
  if (room.msgs.length > ROOM_MAX_MSGS) room.msgs.splice(0, room.msgs.length - ROOM_MAX_MSGS);
  wake(room);

  return sendJson(res, 200, { ok: true, msg, peers: peersOnline(room), meta: room.meta });
}

async function handleRelayGet(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const code = roomCode(url.searchParams.get('room'));
  const role = url.searchParams.get('role');
  const after = Math.max(0, Number(url.searchParams.get('after')) || 0);
  // `wait=0` is the seed request: it only wants the current presence, never a
  // held-open response, so a side that has just joined learns who is here.
  const seed = url.searchParams.get('wait') === '0';

  if (!code || (role !== 'doctor' && role !== 'patient')) {
    return sendJson(res, 400, { error: { message: 'A room code and a role are required.' } });
  }

  // A GET never creates a room: opening the wrong code should show an empty
  // channel, not leave a trail of empty rooms in memory.
  const room = rooms.get(code);
  if (!room) {
    return sendJson(res, 200, { seq: 0, msgs: [], peers: { doctor: false, patient: false }, meta: {} });
  }

  const was = room.seen[role];
  room.seen[role] = Date.now();
  room.active = Date.now();

  // Somebody who was offline has just polled. Wake the other side so its held
  // GET answers with this presence instead of waiting out the whole timeout —
  // otherwise the "in the room" pill is up to 25 seconds late.
  if (Date.now() - was >= PRESENCE_MS) wake(room);

  const fresh = () => {
    const now = Date.now();
    const other = role === 'doctor' ? 'patient' : 'doctor';
    return {
      seq: room.seq,
      msgs: room.msgs.filter((m) => m.id > after),
      peers: peersOnline(room, now),
      typing: now - room.typing[other] < 3000,
      meta: room.meta,
    };
  };

  if (seed || room.seq > after) return sendJson(res, 200, fresh());

  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      room.waiters.delete(waiter);
      resolve();
    };
    const waiter = finish;
    const timer = setTimeout(finish, WAIT_MS);
    room.waiters.add(waiter);
    // The phone locking, a tab closing or a proxy timing the socket out all
    // arrive here. Without this a room would accumulate one dead waiter per
    // disconnect and wake() would grow without bound.
    req.on('close', finish);
  });

  if (res.writableEnded) return;
  return sendJson(res, 200, fresh());
}

// Idle rooms are dropped so a day of consultations does not accumulate.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.waiters.size === 0 && now - room.active > ROOM_TTL) rooms.delete(code);
  }
}, 5 * 60_000).unref();

// --- static files ----------------------------------------------------------

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';

  const filePath = path.join(ROOT, rel);
  // Never serve anything outside this folder.
  if (filePath !== ROOT + rel && !filePath.startsWith(ROOT + path.sep)) {
    return send(res, 403, 'text/plain', 'Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, 'text/plain', 'Not found');
    const ext = path.extname(filePath).toLowerCase();
    send(res, 200, MIME[ext] || 'application/octet-stream', data);
  });
}

// --- server ----------------------------------------------------------------

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/chat') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: { message: 'POST only.' } });
    return handleChat(req, res);
  }

  if (url.pathname === '/api/transcribe') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: { message: 'POST only.' } });
    return handleTranscribe(req, res);
  }

  if (url.pathname === '/api/relay') {
    if (req.method === 'POST') return handleRelayPost(req, res);
    if (req.method === 'GET') return handleRelayGet(req, res);
    return sendJson(res, 405, { error: { message: 'GET or POST.' } });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'text/plain', 'Method not allowed');
  }

  return serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Sehat Saathi on http://localhost:${PORT}`);
  if (GROQ_KEY) {
    console.log(`Language model: ${CHAT_MODEL} (translation, prescriptions)`);
    console.log(`Speech recognition: ${STT_MODEL} (any browser)`);
  } else {
    console.log('WARNING: no GROQ_API_KEY. Translation and prescription parsing will fail.');
    console.log('Put it in a .env file next to server.js:   GROQ_API_KEY=your_key');
    console.log('Or pass it inline:                          GROQ_API_KEY=your_key npm start');
  }
});
