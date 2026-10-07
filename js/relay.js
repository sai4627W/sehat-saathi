// ---------------------------------------------------------------------------
// relay.js - the room channel between the doctor's phone and the patient's.
//
// Both sides join the same short code and talk through server.js, which holds
// messages in memory and answers a long-poll. Nothing here stores patient text
// on its own: the server is the single source of truth, and a room vanishes
// two hours after the last person leaves it.
// ---------------------------------------------------------------------------

const ENDPOINT = '/api/relay';

// One loop at a time. Each call takes the current generation, so a stale loop
// that is mid-sleep when a new one starts notices and exits instead of running
// a second long-poll against the same room.
let running = false;
let generation = 0;
let aborter = null;

/** "k7x-4q2" and "K7X4Q2" are one room. Codes get read out over a phone. */
export function normaliseRoom(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 12);
}

/** Six characters from an alphabet without O/0/1/I, grouped as XXX-XXX. */
export function makeRoomCode() {
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(6);
  if (globalThis.crypto?.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `${out.slice(0, 3)}-${out.slice(3)}`;
}

export function displayRoom(code) {
  const clean = normaliseRoom(code);
  return clean.length > 3 ? `${clean.slice(0, 3)}-${clean.slice(3)}` : clean;
}

async function post(payload) {
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error('No connection to the server. Check the network.');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message || 'The room service is unavailable.');
  return json;
}

/** Say who we are: name, age and language travel with the join. */
export function joinRoom({ room, from, name, age, lang }) {
  return post({ room, from, kind: 'hello', name, age, lang });
}

/**
 * Send one message. The server assigns the id and returns the stored record,
 * so the sender renders exactly what everyone else will receive.
 */
export function sendRoom(msg) {
  return post(msg);
}

/** Fire-and-forget; failures are invisible on purpose (it is only a hint). */
export function pingTyping(room, from) {
  post({ room, from, kind: 'typing' }).catch(() => {});
}

export function stopPolling() {
  running = false;
  generation++;
  aborter?.abort();
  aborter = null;
}

/**
 * Hold one GET open until the server has something or gives up, then ask
 * again. `onBatch` receives only messages newer than the last id seen.
 *
 * Every response also carries presence and the other side's typing flag, so
 * a silent room still refreshes the header roughly every 25 seconds.
 */
export async function pollRoom({ room, role, after = 0, onBatch, onStatus, onError }) {
  const myGen = ++generation;
  running = true;
  let last = after;
  let seed = true;

  while (running && myGen === generation) {
    aborter = new AbortController();
    try {
      // The first request asks the server not to hold it open: it is only
      // here to learn who else is in the room before anything is said.
      const wait = seed ? '&wait=0' : '';
      seed = false;
      const res = await fetch(
        `${ENDPOINT}?room=${encodeURIComponent(room)}&role=${role}&after=${last}${wait}`,
        { signal: aborter.signal }
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error?.message || 'Lost the room connection.');

      if (json.seq > last) last = json.seq;
      if (json.msgs?.length) onBatch?.(json.msgs);
      onStatus?.({ peers: json.peers, meta: json.meta, typing: json.typing });
    } catch (err) {
      if (!running || myGen !== generation || err.name === 'AbortError') return;
      onError?.(err);
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
}
