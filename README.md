# Sehat Saathi

**sehat saathi · health companion**

A voice bridge for rural doctor–patient consultations.

A patient speaks their own regional language. The doctor reads and replies in English. The prescription comes back in the patient's language, laid out large enough to read on a phone screen.

Built for the case where there is no English speaker in the room, one phone, and a patient who has never read a prescription before.

---

## Why

The language barrier in a rural clinic is not about vocabulary. It is about time and trust.

- A patient describes a symptom in farming or household terms. The doctor needs the **medical meaning**, in English, quickly.
- The doctor's reply usually contains instructions: dose, duration, warning signs. Said in English, none of it lands.
- A written prescription in a language the patient cannot read is worthless. A prescription **read aloud** in their own language is not.

Sehat Saathi handles all three: speak → translate → reply → translate back → spoken aloud.

---

## Features

- **13 languages** — Hindi, Bengali, Tamil, Telugu, Marathi, Gujarati, Kannada, Malayalam, Punjabi, Odia, Urdu, Nepali, English.
- **Voice in, voice out** — Web Speech API for both recognition and synthesis. No speech API cost, and it works on slow connections.
- **Meaning, not words** — the translation prompt is told to resolve everyday descriptions ("I can't keep water down", "my head is spinning") into their medical meaning.
- **Structured prescriptions** — free-text note becomes a parsed record: complaint, medicines with dose/frequency/timing/duration, tests, advice, danger signs, follow-up.
- **Danger signs get their own call.** Mixed into a batch they come out flat. They are rewritten one per line as an urgent instruction to go to a hospital *right now*.
- **Read aloud** — a plain-language summary plus every medicine name and warning sign, spoken in the patient's language.
- **Print / save as PDF** — patient's copy in their language, doctor's record in English, side by side.
- **Works without a microphone** — the entire flow works by typing. Say so on the setup screen instead of failing silently.
- **No build step, no dependencies** — vanilla ES modules and one 200-line Node file using only the standard library.

---

## Quick start

Requires **Node 20.6 or newer** (Node 22 recommended) and a [Groq API key](https://console.groq.com/keys).

Put the key in a `.env` file next to `server.js` — `npm start` loads it automatically, and `.env` is already gitignored:

```bash
echo 'GROQ_API_KEY=your_key_here' > .env
npm start
```

Or pass it inline for a one-off:

```bash
GROQ_API_KEY=your_key_here npm start
```

Then open <http://localhost:3000>.

That is the whole setup. There is nothing to install.

```bash
PORT=8080 GROQ_CHAT_MODEL=openai/gpt-oss-120b GROQ_API_KEY=your_key npm start
```

| Variable            | Default                | Purpose                                          |
| ------------------- | ---------------------- | ------------------------------------------------ |
| `GROQ_API_KEY`      | _none_                 | Required. Translation, prescriptions, and speech recognition all use this one key |
| `PORT`              | `3000`                 | Port to listen on                                |
| `GROQ_CHAT_MODEL`   | `openai/gpt-oss-120b`  | Language model used by the proxy                 |
| `GROQ_STT_MODEL`    | `whisper-large-v3-turbo` | Speech-to-text model                           |
| `GROQ_PAID`         | `0`                    | Set to `1` on a paid plan to raise the upload cap to 100 MB |

If you start without a key the server still runs and says so loudly on stdout — you can use the interface to explore, but nothing will translate.

---

## How the key is handled

There are two ways to wire this up, and the difference matters.

**1. Proxy (recommended, and the default)**

`server.js` holds the key in an environment variable and exposes a single `/api/chat` endpoint. The key is never sent to the browser. Anything else — the static site, the model name, temperature — is client-controlled, which is fine.

```bash
GROQ_API_KEY=your_key npm start
```

**2. Browser-direct (localhost prototyping only)**

Set `GROQ_KEY` in `js/config.js` and clear `CONFIG.apiBase`. The browser then calls Groq directly.

**This publishes your key.** Anyone who opens devtools on a deployed copy can read it and spend your quota. Do not use this on a link you send anyone.

`js/config.js` is the only file you should edit, and it is gitignored-adjacent by convention — never commit a real key.

---

## Browser support

With a `GROQ_API_KEY` set, **speech recognition works in every browser.** Text to speech is limited to the voices the phone has installed, as always.

| Feature                  | Chrome / Edge | Brave | Debian `chromium` | Safari | Firefox |
| ------------------------ | ------------- | ----- | ----------------- | ------ | ------- |
| Speech recognition (mic) | Yes, live     | Yes   | Yes               | Yes    | Yes     |
| Text to speech           | Yes           | Yes   | Yes               | Yes    | Yes     |
| Text-only mode           | Yes           | Yes   | Yes               | Yes    | Yes     |

### How recognition works

There are two paths, because no single browser API is dependable:

1. **Live (Web Speech `SpeechRecognition`).** Words appear as they are spoken. Free and no round trip, but it is a Google service that only Chrome and Edge pay for. Brave, Firefox, Safari and open-source Chromium builds either lack it or fail with `Error occurred in recognition: network`.
2. **Server transcription (`MediaRecorder` → `/api/transcribe` → Whisper).** Record in the browser, transcribe on our server. Works in every browser, but the words appear only once the patient stops speaking.

Path 1 is preferred when it works, because the patient sees their words and can stop before saying something they did not mean to. When path 1 fails with `network` — which on Brave and open-source Chromium is *every single time* — `js/speech.js` falls back to path 2 automatically and remembers the failure so it stops trying.

**If recognition is not live, the setup screen says so** rather than implying the microphone is broken. It isn't; the words just arrive a moment later.

The browser traps that motivated this, and they are worth knowing:

- **Debian/Ubuntu `chromium`** is open source and ships without the Google Speech API key, so live recognition fails. It is indistinguishable from real Chrome by user agent — the `chromium` binary sends the identical `Chrome/145.0.0.0 Safari/537.36` string — so no UA check can catch it, and it only admits it by failing at runtime.
- **Brave** is Chromium, so `webkitSpeechRecognition` exists and every capability check passes, the permission prompt appears, and the button animates as if listening — then it fails, because Chrome streams raw mic audio to `https://www.google.com/speech-api/full-duplex/v1` with a paid Google key that Brave declined to buy ([brave/brave-browser#3725](https://github.com/brave/brave-browser/issues/3725)). **This is not a Shields setting**; turning Shields off does not help.

You can supply your own Cloud Speech key to Chromium via `GOOGLE_API_KEY` / `GOOGLE_DEFAULT_CLIENT_ID` / `GOOGLE_DEFAULT_CLIENT_SECRET`, but it overrides Chrome's built-in key, is easy to get wrong, and is billed per use — not worth it, when path 2 costs $0.04/hour.

Two requirements that remain:

- **HTTPS is required for the microphone.** `localhost` is exempt. Serving this over plain HTTP on a LAN IP means the mic does nothing.
- **A regional voice must be installed** or replies cannot be spoken aloud. On Android: *Settings → Accessibility → Text-to-speech → install the language voice*. This cannot be fixed by an API key — Groq's synthesiser speaks only English and Arabic, and no free cloud TTS exists for Hindi, Tamil, Telugu or the rest, so regional speech comes from the phone itself. The setup screen detects a missing voice and tells the patient how to fix it.

Every action has a typed equivalent, and the setup screen reports what this specific device can actually do before the consultation starts.

---

## Project layout

```
index.html          Three screens: setup, consultation, prescription
styles.css          Single stylesheet, mobile-first
.env.example        Copy to .env and fill in
server.js           Static server + Groq chat proxy + Whisper transcription proxy
js/
  config.js         Keys, model, language list, proxy base path
  app.js            Screens, turn-taking, the consultation flow
  speech.js         Recognition (live Web Speech, or record-and-transcribe) + synthesis
  ai.js             The only file that talks to the language model. Caches repeat calls.
  translate.js      Patient language ↔ English
  prescription.js   Prescription parsing and localization
```

Data flow:

```
                     ┌─ live: Web Speech (Chrome/Edge) ─┐
patient (regional) ──┤                                 ├─▶ transcript ─▶ translate ─▶ doctor (English)
                     └─ fallback: record ─▶ /api/      ┘                                              │
                                   transcribe (Whisper)                                             │
                                                                                    patient (regional)
                                                              ◀──synthesis (device)── translate ◀──────┘
```

The one key stays on the server as `GROQ_API_KEY`. It covers translation, prescription parsing and transcription, and is never sent to the browser.

A prescription takes the long way round: free-text English → structured JSON → localized record.

---

## Design decisions worth knowing about

**The microphone and the speaker are never live at the same time.** Otherwise the phone hears the patient's own translated voice through the air and feeds it back into the transcript as a new complaint. The UI locks while either is running, and tapping the mic stops playback instantly.

**Numbers are never touched.** Doses, durations, strengths and units are copied character-for-character by the prompt, on both the translation and the prescription paths. A rounded dose is an incident.

**Drug names stay in Latin letters.** When a prescription is localized, names and strengths are held back from translation on purpose — the patient shows that name to a pharmacist. Time words ("3 days", "after food") *are* translated, so the result is unambiguous.

**Missing information is stated, not filled in.** If the doctor did not write a duration, the field reads `not specified`. The model is told to extract only what exists.

**Batch translations are verified by line count.** Numbered lists are sent as one call for cost, then parsed. If the count comes back wrong, it falls back to one call per line. Losing a dose to a formatting quirk is not acceptable.

**Medical text is rendered with `textContent`, never `innerHTML`.** Model output is untrusted input.

---

## Safety

> AI translation can be wrong. A doctor must read the English before the patient follows it.
> In an emergency, call the nearest health worker or ambulance — do not wait for this page.

This is a communication aid, not a diagnostic tool, and not a source of medical advice.

- The doctor reads the English. The patient never receives advice the doctor has not seen.
- Drug names, strengths and numbers are preserved verbatim by design.
- Unstated information is marked `not specified` rather than inferred.
- Danger signs are surfaced prominently and never translated into a passive statement.
- The printed copy carries a verification notice.

---

## Privacy and rate limits

- **No patient data is stored.** Nothing is written to disk. The transcript lives in the page and disappears on reload.
- **Every translation is a request to Groq.** Patient descriptions reach the Groq API as text. Check your data-processing terms before using this with real patient information, and get consent.
- **The proxy rate-limits 30 requests per minute per IP** and caps prompts at 20,000 characters and bodies at 200 KB. A consultation is roughly six calls, so a clinic works normally while a single client cannot drain the quota. The limit is per-process and in memory, so it resets on restart.

### Why Groq, and not Gemini

This was the original reason for the rewrite, and the numbers are the whole argument.

Gemini's free tier is a **daily budget**, not a rate limit: roughly **20 requests per day** on `gemini-2.5-flash` (`generate_content_free_tier_requests`). One consultation spends about six of them, so a free key supported roughly **three consultations a day** — and then every language failed at once until midnight, which reads to a user like "translation is broken for Kannada" when it is in fact broken for everything. No amount of prompt work fixes a budget that runs out at 9am.

Groq's free tier is a **standing per-minute quota** with no card and no expiry:

| | Daily limit | Per minute | Resets |
| --- | --- | --- | --- |
| Gemini `gemini-2.5-flash` | ~20/day | — | next midnight |
| Groq `openai/gpt-oss-120b` | 1,000/day | 30/min | every minute |

1,000 requests a day is roughly **160 consultations**, and because the ceiling is per-minute it degrades gracefully — a busy minute returns a retry in seconds, not a dead afternoon. Paid, `openai/gpt-oss-120b` is a few tenths of a cent per consultation.

The proxy deliberately mirrors that ceiling: its own limit is 30/min per IP, so a client gets an instant, free, local 429 instead of one that has already spent an upstream request. `server.js` also distinguishes a per-minute rejection from a spent daily budget and passes Groq's own retry time through to the UI.

If you ever want to go back, `/api/chat` is the only surface the browser uses and it returns a plain `{ text }`, so swapping the upstream model is a change to one `fetch` call in `server.js`.

---

## Deployment

The server is a single file with no dependencies, so any Node host works:

1. Set `GROQ_API_KEY` as an environment variable.
2. Set `PORT` if the host assigns one.
3. Serve over HTTPS. The microphone requires it, and this is a phone app in practice.

Static hosts (Netlify, Pages, GitHub Pages) will serve the front end, but they cannot run `server.js` — you would be forced into the browser-direct key mode described above, which means publishing your key. Use a host that can run Node.

---

## Limitations

- Speech recognition needs an internet connection and is unreliable on very poor networks. Typing always works.
- Recognition quality for regional Indian languages varies by device and is noticeably worse on low-end Android hardware.
- Romanized input (`"mujhe bukhar hai"`) is translated as written. It will do reasonably, but native script is better.
- Nothing is persisted, so a page refresh mid-consultation loses the transcript. This is deliberate.
- Prescription structure comes from a language model. It will occasionally misparse an unusual note — which is exactly why the doctor's English record is printed alongside the patient's copy.

---

## Licence

MIT.