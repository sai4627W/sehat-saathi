// ---------------------------------------------------------------------------
// speech.js - speech in and speech out.
//
// Two recognition paths, because no single browser API is dependable:
//
//   1. Web Speech (SpeechRecognition) - live interim text as the patient speaks.
//      Free, but genuinely works only in Chrome/Edge on Android or desktop.
//      Brave, Firefox, Safari and open-source Chromium builds all fail.
//   2. MediaRecorder -> /api/transcribe (Whisper) - record here, transcribe on
//      the server. Works in every browser, but no live interim text.
//
// Path 1 wins when it actually works, because the patient sees their words
// appear and can stop before saying something they did not mean to. Path 2 is
// the fallback, and the only path Brave and open-source Chromium ever take.
//
// TTS stays on the device: Groq's synthesiser speaks only English and Arabic,
// and there is no free cloud voice for Hindi, Tamil or Telugu. Regional speech
// comes from the phone's own installed voices.
// ---------------------------------------------------------------------------

import { CONFIG } from './config.js';

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

// Brave ships Chromium's SpeechRecognition but will not send audio to Google,
// which is what backs it. Every session aborts with a `network` error, so the
// API looks present and then fails on tap. See brave/brave-browser#3725 - there
// is no Brave setting that turns it on. It cannot be fully detected up front,
// so the failure is remembered at runtime too (markListenBroken).
const isBrave = /Brave\//.test(navigator.userAgent || '');

// Open-source Chromium builds (Debian/Ubuntu `chromium`, Electron) ship without
// the Google Speech API key, and they spoof the Chrome user agent verbatim - the
// string "Chrome/145.0.0.0" is what a real Chrome sends too. So a UA check can
// never catch it, and the API only admits it by failing: the request to
// google.com/speech-api goes out with no usable key and comes back as `network`.
const NETWORK_HELP =
  'Live speech recognition is blocked in this browser. Falling back to the server, so the words ' +
  'appear once you stop speaking instead of as you go.';

const canRecord = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

export const capabilities = {
  // Path 2 needs no browser speech API at all, just MediaRecorder and a secure
  // origin, so listening works far more widely than it used to.
  canRecord,
  // Live interim, when this browser can genuinely do it.
  canListenLive: !!SR && !isBrave,
  canSpeak: 'speechSynthesis' in window,
  // recognition is useless on an insecure origin, but TTS still works.
  secureEnough: window.isSecureContext,
  brave: isBrave,
  // Set once live recognition has actually failed, because no browser can be
  // trusted to advertise support honestly. See markListenBroken below.
  cloudBlocked: false,
};

/** Remember that live recognition does not work here, so stop using path 1. */
function markListenBroken() {
  capabilities.canListenLive = false;
  capabilities.cloudBlocked = true;
}

let activeRecognition = null;

// The active fallback recorder handle. Must be tracked separately from
// activeRecognition: in the fallback path activeRecognition is deliberately
// null, so stopListening() would find nothing to stop and the patient could not
// stop their own recording.
let activeRecorder = null;

/** Silence longer than this ends a recording, so nobody has to hunt for stop. */
const MAX_RECORD_MS = 60_000;

/**
 * Path 2: record in the browser, transcribe on the server.
 * Returns a handle with .stop(), same shape as listen().
 */
export function recordAndTranscribe(lang, { onResult, onEnd, onError, onStart } = {}) {
  if (!canRecord) {
    onError?.({
      code: 'unsupported',
      message: 'This browser cannot record audio. Use Chrome or Edge, or type instead.',
    });
    return { stop() {} };
  }
  if (!capabilities.secureEnough) {
    onError?.({ code: 'insecure', message: 'The microphone needs an https connection. Type instead.' });
    return { stop() {} };
  }

  let stream = null;
  let recorder = null;
  let chunks = [];
  let stopped = false;
  let hardStop = null;

  const cleanup = () => {
    if (hardStop) clearTimeout(hardStop);
    hardStop = null;
    // Stopping every track clears the mic indicator. Leaving it on makes the
    // phone look like it is still recording, which on a clinic phone matters.
    stream?.getTracks().forEach((t) => {
      try { t.stop(); } catch { /* already stopped */ }
    });
    stream = null;
    recorder = null;
  };

  const finish = async () => {
    if (stopped) return;
    stopped = true;
    activeRecorder = null;
    cleanup();

    const blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' });
    chunks = [];
    if (!blob.size) {
      onEnd?.({ text: '', empty: true });
      return;
    }

    try {
      const res = await fetch(`${CONFIG.apiBase}/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': blob.type || 'audio/webm', 'X-Lang': lang || '' },
        body: blob,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error?.message || 'Speech recognition failed.');

      const text = String(json.text || '').trim();
      if (text) onResult?.({ text, isFinal: true });
      onEnd?.({ text, empty: Boolean(json.empty) });
    } catch (err) {
      onError?.({ code: 'transcribe', message: err.message });
      onEnd?.({ text: '' });
    }
  };

  navigator.mediaDevices
    .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    .then((s) => {
      if (stopped) {
        s.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = s;

      // Prefer a format Whisper accepts and that stays small: Safari records
      // mp4, everyone else webm/opus. Whisper downsamples to 16k mono anyway.
      const pick = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((t) =>
        window.MediaRecorder.isTypeSupported?.(t)
      );
      recorder = pick ? new MediaRecorder(s, { mimeType: pick }) : new MediaRecorder(s);
      recorder.ondataavailable = (e) => {
        if (e.data?.size) chunks.push(e.data);
      };
      recorder.onstop = finish;
      recorder.start();
      onStart?.();

      // A patient who wanders off must not hold the mic open indefinitely.
      hardStop = setTimeout(() => {
        try {
          if (recorder && recorder.state !== 'inactive') recorder.stop();
        } catch { /* already stopped */ }
      }, MAX_RECORD_MS);
    })
    .catch((err) => {
      cleanup();
      const denied = /NotAllowedError|Permission denied/i.test(String(err?.name || err));
      onError?.({
        code: denied ? 'not-allowed' : 'audio-capture',
        message: denied ? 'Microphone permission was denied.' : 'No microphone found on this device.',
      });
      onEnd?.({ text: '' });
    });

  const handle = {
    stop() {
      if (stopped) return;
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      else finish();
    },
  };
  // Registered so stopListening() can end this recording. Cleared in finish().
  activeRecorder = handle;
  return handle;
}

/**
 * Start listening. Returns a handle with .stop().
 * onResult({ text, isFinal }) fires on every interim update and once final.
 * onError({ code, message }) fires on failure.
 *
 * Uses live Web Speech when it works, otherwise records and transcribes on the
 * server, so callers do not need to know which one is running.
 */
export function listen(lang, { onResult, onEnd, onError, onStart } = {}) {
  if (!SR || isBrave || !capabilities.canListenLive) {
    return recordAndTranscribe(lang, { onResult, onEnd, onError, onStart });
  }

  const rec = new SR();
  rec.lang = lang;
  // A patient describing symptoms pauses constantly. With continuous=false
  // Chrome ends the session after a few seconds of silence and the rest of the
  // complaint is lost - the single most damaging failure this app can have.
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  let finalText = '';
  let lastInterim = '';
  let fellBack = false;

  rec.onstart = () => onStart?.();

  rec.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const chunk = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalText += chunk;
      else interim += chunk;
    }
    if (interim) lastInterim = interim;
    onResult?.({ text: (finalText + interim).trim(), isFinal: finalText.trim().length > 0 });
  };

  rec.onerror = (event) => {
    // Live recognition being unreachable is recoverable: record and transcribe
    // on the server instead. Brave and open-source Chromium fail this way on
    // every single attempt, so falling back is the normal path there, not an
    // exceptional one.
    if (event.error === 'network' && !fellBack) {
      fellBack = true;
      markListenBroken();
      try { rec.abort(); } catch { /* already stopping */ }
      onError?.({ code: 'fallback', message: NETWORK_HELP, silent: true });
      activeRecognition = null;
      return recordAndTranscribe(lang, { onResult, onEnd, onError, onStart });
    }

    const friendly = {
      'not-allowed': 'Microphone permission was denied.',
      'service-not-allowed': 'Microphone permission was denied.',
      'no-speech': 'No speech detected. Tap the mic and try again.',
      'audio-capture': 'No microphone found on this device.',
      network: NETWORK_HELP,
      'lang-not-supported': 'Speech recognition is not available for this language on this device.',
      aborted: null, // user stopped it, not an error worth showing
    }[event.error];

    if (friendly === null) return;
    onError?.({ code: event.error, message: friendly || `Speech error: ${event.error}` });
  };

  rec.onend = () => {
    activeRecognition = null;
    if (fellBack) return; // the fallback recorder owns the end of this session
    // With continuous=true Chrome can still end early. Interim results are real
    // speech the patient said, so use them rather than silently returning
    // nothing and losing the complaint.
    const text = (finalText || lastInterim).trim();
    onEnd?.({ text, empty: !text });
  };

  try {
    rec.start();
    activeRecognition = rec;
  } catch (err) {
    // start() throws if called while already running.
    onError?.({ code: 'busy', message: 'Already listening.' });
    return { stop() {} };
  }

  return {
    stop() {
      try { rec.stop(); } catch { /* already stopped */ }
    },
  };
}

/**
 * Stop whichever recognition path is running. Must handle both, because the
 * live path and the fallback recorder are never active at the same time but
 * callers cannot know which one they started.
 */
export function stopListening() {
  if (activeRecorder) {
    activeRecorder.stop();
    activeRecorder = null;
    return;
  }
  activeRecognition?.stop();
  activeRecognition = null;
}

// --- Text to speech -------------------------------------------------------

let cachedVoices = null;

/** voices load async in Chrome; cache once they arrive. */
function voices() {
  if (cachedVoices && cachedVoices.length) return cachedVoices;
  const list = window.speechSynthesis?.getVoices?.() || [];
  if (list.length) cachedVoices = list;
  return list;
}

if ('speechSynthesis' in window) {
  window.speechSynthesis.onvoiceschanged = () => {
    cachedVoices = window.speechSynthesis.getVoices();
  };
}

/** Best available voice for a BCP-47 tag like "hi-IN". Null if none. */
export function voiceFor(lang) {
  const all = voices();
  if (!all.length) return null;
  const base = lang.split('-')[0].toLowerCase();
  const tag = lang.toLowerCase();

  return (
    all.find((v) => v.lang?.toLowerCase().replace('_', '-') === tag) ||
    all.find((v) => (v.lang?.toLowerCase().split('-')[0] === base)) ||
    all.find((v) => (v.name || '').toLowerCase().includes(base)) ||
    all.find((v) => (v.voiceURI || '').toLowerCase().includes(base)) ||
    null
  );
}

/** True if this device can actually SPEAK a language, not just recognise it. */
export function canSpeakLang(lang) {
  const all = voices();
  if (!all.length) return false;
  const base = lang.split('-')[0].toLowerCase();
  const tag = lang.toLowerCase();
  return all.some((v) => {
    const vl = (v.lang || '').toLowerCase().replace('_', '-');
    return vl === tag || vl.split('-')[0] === base || (v.name || '').toLowerCase().includes(base);
  });
}

export function stopSpeaking() {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}

/**
 * Chrome silently truncates or stalls on long utterances, so split into
 * sentence-sized pieces and queue them.
 *
 * No lookbehind here on purpose: `(?<=...)` is a SyntaxError on Safari < 16.4
 * and older Android WebViews, and because this is a top-level regex in an ES
 * module, a parse failure would take down the entire app, not just speech.
 */
function chunk(text, max = 180) {
  const parts = text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/[.!?।؟,;:]\s+/)
    .flatMap((sentence) => {
      if (sentence.length <= max) return [sentence];
      const words = sentence.split(' ');
      const out = [];
      let buf = '';
      for (const w of words) {
        if ((buf + ' ' + w).trim().length > max) {
          if (buf) out.push(buf.trim());
          buf = w;
        } else {
          buf = (buf + ' ' + w).trim();
        }
      }
      if (buf) out.push(buf.trim());
      return out;
    })
    .filter(Boolean);
  return parts.length ? parts : [text];
}

/**
 * Speak text aloud in `lang`.
 * Slower than default on purpose: patients are often older, in a noisy room,
 * and using a phone speaker held at arm's length.
 */
export function speak(text, lang, { rate = 0.92, pitch = 1, onStart, onEnd } = {}) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) {
      onEnd?.();
      return resolve(false);
    }
    stopSpeaking();

    const voice = voiceFor(lang);
    if (!voice) {
      onEnd?.();
      return resolve(false);
    }

    const pieces = chunk(text);
    let index = 0;
    let settled = false;
    let watchdog = null;

    // Chrome's TTS is well known for never firing onend on a long utterance or
    // after a cancel(). Without this the promise never settles, `speaking` stays
    // true, and setBusy disables every control - a dead UI needing a reload,
    // mid-consultation.
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      onEnd?.();
      resolve(ok);
    };

    const next = () => {
      if (index >= pieces.length) return finish(true);

      const utter = new SpeechSynthesisUtterance(pieces[index]);
      utter.voice = voice;
      utter.lang = voice.lang || lang;
      utter.rate = rate;
      utter.pitch = pitch;
      utter.onend = () => {
        index += 1;
        next();
      };
      utter.onerror = () => finish(false);

      if (index === 0) onStart?.();
      window.speechSynthesis.speak(utter);

      // Generous per-piece budget: roughly 14 characters a second at the
      // deliberately slow rate, doubled for slow devices.
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        window.speechSynthesis.cancel();
        finish(false);
      }, Math.max(8_000, (pieces[index].length / (rate * 7)) * 1000 * 2));
    };

    next();
  });
}
