// ---------------------------------------------------------------------------
// app.js - screens, turn-taking, and the consultation flow.
//
// One rule drives a lot of this: never let the microphone and the speaker run
// at the same time, or the phone hears the patient's own translated voice and
// feeds it back into the transcript as a new complaint.
// ---------------------------------------------------------------------------

import { CONFIG } from './config.js';
import * as speech from './speech.js';
import { translateText } from './translate.js';
import { parsePrescription, localizePrescription, toPlainEnglish } from './prescription.js';
import {
  initRoom,
  bootSession,
  syncSessionControls,
  syncLangUI,
  updateRoleChrome,
  onShow,
} from './room.js';

const $ = (id) => document.getElementById(id);

const el = {
  banner: $('banner'),
  screenLogin: $('screen-login'),
  screenSetup: $('screen-setup'),
  screenConsult: $('screen-consult'),
  screenDoctor: $('screen-doctor'),
  screenPatient: $('screen-patient'),
  screenRx: $('screen-rx'),

  langSelect: $('langSelect'),
  loginLang: $('loginLang'),
  langHint: $('langHint'),
  langTagTop: $('langTagTop'),
  flowLang: $('flowLang'),
  flowLang2: $('flowLang2'),
  capList: $('capList'),
  startBtn: $('startBtn'),
  demoBtn: $('demoBtn'),
  langBtn: $('langBtn'),
  langBtnLabel: $('langBtnLabel'),
  themeBtn: $('themeBtn'),
  netBadge: $('netBadge'),
  backToSetup: $('backToSetup'),

  patientLangTag: $('patientLangTag'),
  rxLangTag: $('rxLangTag'),
  patientCard: $('patientCard'),
  doctorCard: $('doctorCard'),
  bridge: document.querySelector('.bridge'),
  bridgeLabel: $('bridgeLabel'),
  patientState: $('patientState'),
  doctorState: $('doctorState'),
  railFill: $('railFill'),
  railFill2: $('railFill2'),
  stepLabel: $('stepLabel'),
  patientInput: $('patientInput'),
  patientReply: $('patientReply'),
  interim: $('interim'),
  patientMic: $('patientMic'),
  patientTranscribe: $('patientTranscribe'),
  toDoctorBtn: $('toDoctorBtn'),
  replayBtn: $('replayBtn'),

  doctorRead: $('doctorRead'),
  copyReadBtn: $('copyReadBtn'),
  doctorInput: $('doctorInput'),
  doctorMic: $('doctorMic'),
  doctorTranscribe: $('doctorTranscribe'),
  doctorInterim: $('doctorInterim'),
  relayBtn: $('relayBtn'),
  toRxBtn: $('toRxBtn'),

  transcript: $('transcript'),
  logCount: $('logCount'),
  logCard: $('logCard'),
  tabTurns: $('tabTurns'),
  tabbar: $('tabbar'),
  segbar: $('segbar'),
  stage: document.querySelector('.stage'),
  sheet: $('sheet'),
  sheetScrim: $('sheetScrim'),
  sheetClose: $('sheetClose'),
  sheetPrint: $('sheetPrint'),
  sheetCopy: $('sheetCopy'),
  rxShare: $('rxShare'),

  backToConsult: $('backToConsult'),
  rxInput: $('rxInput'),
  rxMake: $('rxMake'),
  rxResult: $('rxResult'),
  rxSummary: $('rxSummary'),
  rxMeds: $('rxMeds'),
  rxExtras: $('rxExtras'),
  rxSpeak: $('rxSpeak'),
  rxPrint: $('rxPrint'),
};

const state = {
  lang: 'hi-IN',
  langName: 'Hindi',
  dir: 'ltr',
  listening: false,
  // Which mic is listening ('patient' | 'doctor'). Needed because the mic that
  // is listening is the one control that must stay tappable - see setBusy.
  listeningOn: null,
  // Record-then-upload is a second, deliberate path to the same textarea, so it
  // needs the same "which side owns the floor" bookkeeping as live listening.
  transcribing: false,
  transcribingOn: null,
  speaking: false,
  busy: false,
  turns: [],
  prescription: null,
};

// --- small helpers ---------------------------------------------------------

/** Every screen the shell knows about, in one map so show() stays a loop. */
const SCREENS = {
  login: el.screenLogin,
  setup: el.screenSetup,
  consult: el.screenConsult,
  doctor: el.screenDoctor,
  patient: el.screenPatient,
  rx: el.screenRx,
};

function show(screen) {
  for (const [name, node] of Object.entries(SCREENS)) node.hidden = name !== screen;
  // The login screen has no tabs: until a seat is chosen there is nothing for
  // them to point at.
  el.tabbar.hidden = screen === 'login';
  for (const tab of el.tabbar.querySelectorAll('.tab[data-screen]')) {
    tab.classList.toggle('is-on', tab.dataset.screen === screen);
  }
  onShow(screen);
  markUnread();
  window.scrollTo({ top: 0 });
}

// --- bottom tab bar -------------------------------------------------------

/** Social-app unread pip on the Consult tab. */
function markUnread() {
  const pip = el.tabbar.querySelector('.tab-dot');
  if (pip) pip.classList.toggle('is-on', el.screenConsult.hidden && state.turns.length > 0);
}

el.tabbar.addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  if (tab.dataset.screen) {
    show(tab.dataset.screen);
  } else if (tab.dataset.action === 'transcript') {
    if (el.screenConsult.hidden) show('consult');
    el.logCard.open = !el.logCard.open;
    if (el.logCard.open) el.logCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  markUnread();
  // A spring on the icon, so a tap feels like it landed on something solid.
  const ico = tab.querySelector('.tab-ico');
  ico?.animate?.(
    [{ transform: 'scale(.82)' }, { transform: 'scale(1.08)' }, { transform: 'scale(1)' }],
    { duration: 320, easing: 'cubic-bezier(.34,1.56,.48,1)' }
  );
});

// --- section switcher -----------------------------------------------------

/**
 * On a narrow screen the two sections are stacked, and each one is taller than
 * the viewport. This lets the user jump straight to one instead of scrolling
 * past the other.
 */
function setView(view) {
  el.stage.dataset.view = view;
  for (const seg of el.segbar.querySelectorAll('.seg')) {
    const on = seg.dataset.view === view;
    seg.classList.toggle('is-on', on);
    seg.setAttribute('aria-selected', String(on));
  }
  // The thumb slides under the active segment.
  const active = el.segbar.querySelector('.seg.is-on');
  if (active) {
    el.segbar.style.setProperty('--thumb-x', `${active.offsetLeft}px`);
    el.segbar.style.setProperty('--thumb-w', `${active.offsetWidth}px`);
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

el.segbar.addEventListener('click', (e) => {
  const seg = e.target.closest('.seg');
  if (seg) setView(seg.dataset.view);
});

// --- action sheet ---------------------------------------------------------

function openSheet() {
  if (!state.prescription) {
    banner('Build the prescription first, then choose what to do with it.', 'warn');
    return;
  }
  el.sheet.hidden = false;
  el.sheetScrim.hidden = false;
  // Both the scrim and the sheet need a visible frame before the class lands,
  // or the transition is skipped and the sheet appears without its backdrop.
  requestAnimationFrame(() => {
    el.sheet.classList.add('is-open');
    el.sheetScrim.classList.add('is-open');
  });
  el.sheetClose.focus();
}

function closeSheet() {
  el.sheet.classList.remove('is-open');
  el.sheetScrim.classList.remove('is-open');
  setTimeout(() => {
    el.sheet.hidden = true;
    el.sheetScrim.hidden = true;
  }, 280);
}

el.rxShare.addEventListener('click', openSheet);
el.sheetClose.addEventListener('click', closeSheet);
el.sheetScrim.addEventListener('click', closeSheet);
el.sheetPrint.addEventListener('click', () => {
  closeSheet();
  el.rxPrint.click();
});
el.sheetCopy.addEventListener('click', async () => {
  closeSheet();
  const rx = state.prescription;
  if (!rx) return;
  const text = [
    rx.spokenSummary,
    ...(rx.medicines || []).map(
      (m, i) => `${i + 1}. ${m.name} - ${[m.dose, m.frequency, m.timing, m.duration].filter((v) => v && v !== 'not specified').join(', ')}`
    ),
    ...(rx.warningSigns || []).map((w) => `! ${w}`),
    rx.followUp ? `Come back: ${rx.followUp}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  try {
    await navigator.clipboard.writeText(text);
    banner('Prescription copied as plain text.', 'info');
  } catch {
    banner('This browser blocked the clipboard. Use Print instead.', 'warn');
  }
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el.sheet.hidden) closeSheet();
});

/** `step` is 1..3 and drives the progress rail under the step bar. */
function setStep(text, step) {
  el.stepLabel.textContent = text;
  if (step) {
    const pct = `${Math.round((step / 3) * 100)}%`;
    el.railFill.style.width = pct;
    el.railFill2.style.width = pct;
  }
}

/**
 * Give the floor to one of the two sections: it lifts and glows, and its status
 * pill says why. `who` is 'patient' or 'doctor'.
 *
 *   'floor' - the user is working here (lifted, pill neutral)
 *   'live'  - the microphone or the speaker is running
 *   'busy'  - waiting on the model
 *   'idle'  - nothing happening here
 */
function setPod(who, mode = 'idle', text = null) {
  const pod = who === 'doctor' ? el.doctorCard : el.patientCard;
  const pill = who === 'doctor' ? el.doctorState : el.patientState;
  const other = who === 'doctor' ? el.patientCard : el.doctorCard;
  const otherPill = who === 'doctor' ? el.patientState : el.doctorState;

  pod.classList.toggle('is-active', mode !== 'idle');
  other.classList.remove('is-active');

  // Skeleton loaders: while the model is thinking, the panel shows moving bars
  // instead of a stale value, which reads as "working" rather than "broken".
  pod.classList.toggle('is-busy', mode === 'busy');

  pill.className = `pill${mode === 'live' ? ' is-live' : mode === 'busy' ? ' is-busy' : ''}`;
  pill.querySelector('span').textContent =
    text || (mode === 'busy' ? 'Working' : mode === 'live' ? 'Live' : 'Ready');

  // Whoever does not hold the floor goes back to a neutral, truthful pill -
  // otherwise a finished translate leaves "Translating" frozen on screen.
  otherPill.className = 'pill';
  otherPill.querySelector('span').textContent = who === 'doctor' ? 'Ready' : 'Waiting';
}

function setBridge(mode = 'idle', text = 'live') {
  if (!el.bridge) return;
  el.bridge.classList.toggle('is-working', mode === 'working');
  el.bridge.classList.toggle('is-fresh', mode === 'fresh');
  if (el.bridgeLabel) el.bridgeLabel.textContent = text;
}

/**
 * Drop real text into a bubble, clearing its placeholder. Kept in one place so
 * no medical text ever travels through innerHTML.
 */
function fillBubble(node, text) {
  if (!text) return;
  node.textContent = text;
  node.removeAttribute('data-empty');
  node.classList.remove('fresh');
  void node.offsetWidth; // restart the animation
  node.classList.add('fresh');
}

function setInterim(text, doctor = false) {
  const node = doctor ? el.doctorInterim : el.interim;
  node.textContent = text;
}

let bannerTimer = null;
function banner(msg, kind = 'warn') {
  clearTimeout(bannerTimer);
  if (!msg) {
    el.banner.hidden = true;
    return;
  }
  el.banner.textContent = msg;
  el.banner.className = `banner banner-${kind}`;
  el.banner.hidden = false;
  if (kind === 'error') {
    bannerTimer = setTimeout(() => { el.banner.hidden = true; }, 9000);
  }
}

/** Screen is unusable while we listen or speak - lock it to avoid echo. */
function setBusy(flags) {
  Object.assign(state, flags);
  const locked = state.listening || state.speaking || state.busy || state.transcribing;
  // A mic that cannot record should not look tappable. Recognition now works
  // through MediaRecorder in any browser, so this only trips on an insecure
  // origin or a browser with no recording support at all.
  const micDead = !speech.capabilities.canRecord || !speech.capabilities.secureEnough;
  for (const [node, who] of [
    [el.patientMic, 'patient'],
    [el.doctorMic, 'doctor'],
    [el.patientTranscribe, 'patient'],
    [el.doctorTranscribe, 'doctor'],
  ]) {
    // The mic that is currently listening stays enabled. It is the only way the
    // patient can stop - "Listening... tap to stop" - and the lock exists to stop
    // the *other* controls being touched mid-turn, not to trap this one. Live
    // recognition runs with continuous=true, so nothing else ends the session:
    // disable it here and the patient is stuck on "Listening..." with a full mic
    // permission, a working transcript and no way out but reloading. The same
    // applies to the recorder, whose second tap is its only way to send.
    const owner = state.listeningOn || state.transcribingOn;
    node.disabled = (locked && owner !== who) || micDead;
  }
  el.toDoctorBtn.disabled = locked || !el.patientInput.value.trim();
  el.relayBtn.disabled = locked || !el.doctorInput.value.trim();
  el.rxMake.disabled = locked || !el.rxInput.value.trim();
  el.rxSpeak.disabled = locked;
  // The signed-in seats keep their own set of buttons in step with the same
  // lock, so one mic and one speaker is still all that can run at once.
  syncSessionControls();
}

function langMeta(code = state.lang) {
  return CONFIG.languages.find((l) => l.code === code) || CONFIG.languages[0];
}

function applyLangToDom() {
  const meta = langMeta();
  state.langName = meta.nameEn;
  state.dir = ['ur-IN'].includes(meta.code) ? 'rtl' : 'ltr';

  el.patientLangTag.textContent = meta.nameEn;
  el.rxLangTag.textContent = meta.nameEn;
  el.langTagTop.textContent = meta.nameEn;
  el.langBtnLabel.textContent = meta.nameEn;
  // The visible label is hidden on narrow screens, so the name has to survive
  // in the accessible name too or the button is an unlabelled icon.
  el.langBtn.setAttribute('aria-label', `Patient language: ${meta.nameEn}. Change it`);
  el.flowLang.textContent = `in ${meta.nameEn}`;
  el.flowLang2.textContent = `in ${meta.nameEn}`;

  for (const node of [el.patientInput, el.patientReply, el.transcript, el.patientCard]) {
    node.lang = meta.code;
    node.dir = state.dir;
  }
  el.patientInput.placeholder = `Describe the problem in ${meta.nameEn}`;
}

// --- transcript ------------------------------------------------------------

function logTurn(who, text) {
  state.turns.push({ who, text });
  if (state.turns.length === 1) el.transcript.innerHTML = '';
  const row = document.createElement('article');
  row.className = `turn turn-${who}`;
  // A doctor turn is always English, however the patient's language is set.
  const inEnglish = who === 'doctor' || who === 'doctor-view';
  row.lang = inEnglish ? 'en' : state.lang;
  row.dir = inEnglish ? 'ltr' : state.dir;

  const label = { patient: state.langName, doctor: 'Doctor', 'doctor-view': 'Doctor reads' }[who];
  const who2 = { patient: 'i-user', doctor: 'i-stetho', 'doctor-view': 'i-wave' }[who];

  // Built as an article with a header and a body, the way a social feed item is,
  // so the transcript reads as a conversation rather than a log dump.
  row.innerHTML = `
    <span class="turn-avatar" aria-hidden="true"><svg class="ico" viewBox="0 0 24 24"><use href="#${who2}"/></svg></span>
    <div class="turn-body">
      <span class="turn-who"></span>
      <p class="turn-text"></p>
    </div>`;
  row.querySelector('.turn-who').textContent = label;
  row.querySelector('.turn-text').textContent = text;
  el.transcript.appendChild(row);
  row.scrollIntoView({ block: 'nearest' });

  const n = state.turns.length;
  el.logCount.textContent = n === 1 ? '1 turn' : `${n} turns`;
  el.tabTurns.hidden = false;
  el.tabTurns.textContent = n > 9 ? '9+' : String(n);
  markUnread();
  // A consultation that is being used should not have its log buried.
  el.logCard.open = true;
}

// --- setup screen ----------------------------------------------------------

/**
 * The picker is a grid of language tiles rather than a <select>, because a
 * rural user often recognises their language by its script, not by its English
 * name. Radio semantics are kept so keyboard and screen readers still work.
 */
/**
 * Both language grids on the page: the setup picker and the one on the login
 * card. They are the same control rendered in two places, so they always move
 * together.
 */
function langGrids() {
  return [el.langSelect, el.loginLang].filter(Boolean);
}

function langTiles() {
  return langGrids().flatMap((grid) => [...grid.querySelectorAll('.lang')]);
}

function buildLanguagePicker() {
  const html = CONFIG.languages
    .map(
      (l) =>
        `<button type="button" class="lang" role="radio" data-code="${l.code}" aria-checked="false" tabindex="-1">
           <span class="lang-script">${l.name}</span>
           <span class="lang-en">${l.nameEn}</span>
         </button>`
    )
    .join('');
  for (const grid of langGrids()) grid.innerHTML = html;
  selectLang(state.lang);
}

function selectLang(code) {
  state.lang = code;
  for (const tile of langTiles()) {
    const on = tile.dataset.code === code;
    tile.classList.toggle('is-on', on);
    tile.setAttribute('aria-checked', String(on));
    tile.tabIndex = on ? 0 : -1;
  }
  applyLangToDom();
  describeCapabilities();
  // The signed-in screens carry patient-facing labels of their own.
  syncLangUI();
}

/** Move the selection with the arrow keys, the way a radio group behaves. */
function moveLangSelection(from, delta) {
  const codes = CONFIG.languages.map((l) => l.code);
  const i = codes.indexOf(from);
  const next = codes[(i + delta + codes.length) % codes.length];
  selectLang(next);
  // Focus stays in whichever grid the user was driving, not always the first.
  const grid = document.activeElement?.closest?.('.lang-grid') || el.langSelect;
  grid.querySelector(`.lang[data-code="${next}"]`)?.focus();
}

function describeCapabilities() {
  const meta = langMeta();
  const rows = [];
  const canRecord =
    speech.capabilities.canRecord && speech.capabilities.secureEnough;

  // Record-and-upload only appears when it could actually work. A button that
  // always fails is worse than no button.
  el.patientTranscribe.hidden = !canRecord;
  el.doctorTranscribe.hidden = !canRecord;

  if (!speech.capabilities.canRecord) {
    rows.push(['bad', 'This browser cannot record audio. Open the site in Chrome or Edge to speak.']);
    rows.push(['bad', 'You can still type everything by hand.']);
  } else if (!speech.capabilities.secureEnough) {
    rows.push(['bad', 'The microphone only works over HTTPS. Serve this page over https to speak.']);
    rows.push(['bad', 'You can still type everything by hand.']);
  } else if (speech.capabilities.canListenLive) {
    rows.push(['ok', 'Microphone ready. Words appear as they are spoken.']);
    rows.push(['info', 'On a slow connection use Transcribe instead: it records in one go and sends a single clip.']);
  } else {
    // Recording still works, just without live text. Say so plainly rather than
    // implying the mic is broken - it is not.
    rows.push(['ok', 'Microphone ready.']);
    rows.push(['info', 'This browser shows the words only after you stop speaking. Chrome and Edge show them live.']);
  }

  if (speech.capabilities.canSpeak) {
    if (speech.canSpeakLang(meta.code)) {
      rows.push(['ok', `${meta.nameEn} voice installed - replies can be read aloud.`]);
    } else {
      // No browser TTS voice found. Still allow "text only" mode - translations work.
      const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      const warnText = isMobile
        ? `No ${meta.nameEn} voice installed on this phone, so replies cannot be spoken. ` +
          `Text will still be shown.`
        : `No ${meta.nameEn} TTS voice detected in browser. Read-aloud may not work, but all translations, chat, and transcription work fine.`;
      rows.push(['warn', warnText]);
    }
  } else {
    rows.push(['warn', 'This browser cannot speak. Replies will be shown as text only.']);
  }

  rows.push(['info', 'Speech recognition needs internet. Translation and text work either way.']);

  el.capList.innerHTML = rows
    .map(([kind, msg]) => `<div class="cap cap-${kind}"></div>`)
    .join('');
  [...el.capList.children].forEach((node, i) => {
    node.textContent = rows[i][1];
  });

  el.langHint.textContent = `Patient speaks ${meta.name}. The doctor reads and replies in English.`;
  // The label lives in a child span so the arrow icon is not destroyed by it.
  el.startBtn.querySelector('.btn-label').textContent =
    speech.capabilities.canRecord && speech.capabilities.secureEnough
      ? `Start consultation in ${meta.nameEn}`
      : 'Start (typing only)';
}

function beginConsultation() {
  applyLangToDom();
  describeCapabilities();
  setStep(`Step 1 of 3 · Patient speaks in ${state.langName}`, 1);
  show('consult');
  el.patientInput.focus();
}

// --- shared translate-with-feedback ---------------------------------------

/**
 * Wrap a slow network call so the UI says what it is doing and shows which of
 * the two sections is holding the floor. Without this a six second translate
 * looks exactly like a broken button.
 */
async function guarded(workingLabel, fn, { on = 'patient', label = null } = {}) {
  if (state.busy) return null;
  setBusy({ busy: true });
  el.patientMic.classList.toggle('working', on === 'patient');
  el.doctorMic.classList.toggle('working', on === 'doctor');
  setPod(on, 'busy', label || 'Thinking');
  setBridge('working', 'translating');
  banner(workingLabel, 'info');
  try {
    const result = await fn();
    banner(null);
    return result;
  } catch (err) {
    banner(err.message || 'Something went wrong.', 'error');
    return null;
  } finally {
    el.patientMic.classList.remove('working');
    el.doctorMic.classList.remove('working');
    setBridge('idle', 'live');
    setBusy({ busy: false });
    // Clear the "working" state here, not in each caller: one caller forgetting
    // it leaves the panel stuck mid-thinking with no way to tell it is alive.
    setPod(on, 'idle');
  }
}

// --- listening -------------------------------------------------------------

/** Mic button caption when idle. */
function micIdleLabel(target) {
  return target === 'patient' ? 'Tap to speak' : 'Dictate';
}

/**
 * The patient speaks their language; the doctor dictates in English. Listening
 * in the patient's language for the doctor used to send an English sentence to
 * a Hindi recogniser, which is why the mic produced nonsense for the doctor.
 */
function listenLangFor(target) {
  return target === 'doctor' ? 'en-IN' : state.lang;
}

function micHandler(target, input, interimNode, micBtn) {
  // Live recognition runs with continuous=true, so the session only ends when
  // the patient asks it to - and Chrome does not always honour that promptly.
  // `onEnd` still gets first refusal; this only unlocks the screen if the real
  // end-of-session callback never arrives, so a stalled session cannot leave the
  // UI frozen on "Listening..." mid-consultation. Same reasoning as the
  // speechSynthesis watchdog in speech.js.
  let stopDeadline = null;

  const reset = () => {
    clearTimeout(stopDeadline);
    stopDeadline = null;
    micBtn.classList.remove('listening');
    micBtn.querySelector('.mic-label').textContent = micIdleLabel(target);
    setBusy({ listening: false, listeningOn: null });
    // Hand the floor back only if this consultation is not mid-translate.
    if (!state.busy) {
      setPod(target, 'idle');
      setBridge('idle', 'live');
    }
  };

  return () => {
    if (state.speaking) return; // never record the speaker
    // A clip is already open on this microphone. Two recorders at once would
    // leave the first one unreachable - speech.js tracks one active handle - so
    // the clip has to be sent or abandoned before live listening starts.
    if (state.transcribing) return;
    if (state.listening) {
      speech.stopListening();
      clearTimeout(stopDeadline);
      stopDeadline = setTimeout(reset, 2500);
      return;
    }

    // Only clear what was typed if the mic is about to replace it. Wiping a
    // half-written reply on every tap loses the doctor's work.
    const keep = input.value;
    let failed = false;

    interimNode.textContent = '';
    setBusy({ listening: true, listeningOn: target });
    micBtn.classList.add('listening');
    micBtn.querySelector('.mic-label').textContent = 'Listening... tap to stop';
    setPod(target, 'live', target === 'patient' ? 'Listening' : 'Dictating');
    setBridge('live', 'mic open');

    speech.listen(listenLangFor(target), {
      onStart: () => banner('Listening...', 'info'),
      onResult: ({ text, isFinal }) => {
        interimNode.textContent = text;
        if (isFinal) {
          input.value = text;
          interimNode.textContent = '';
        }
      },
      onEnd: ({ text, empty }) => {
        if (!input.value && text) input.value = text;
        // Put back what the doctor had typed if the mic produced nothing, rather
        // than leaving the box empty after they tapped it.
        if (!input.value.trim() && keep) input.value = keep;
        interimNode.textContent = '';
        reset();
        // A failure already reported its own message; do not wipe it here.
        if (failed) return;
        if (empty) banner('No speech detected. Tap the mic and try again.', 'warn');
        else banner(null);
      },
      onError: ({ code, message, silent }) => {
        // Falling back from live recognition to the server recorder is a handover
        // inside one listening session, not the end of it. Resetting here would
        // unlock the UI and un-highlight the mic while a recording is starting,
        // so the patient would tap again and open a second recorder on the same
        // microphone. Keep the locked state and let onEnd clean up.
        if (code === 'fallback') return;

        failed = true;
        if (!input.value.trim() && keep) input.value = keep;
        interimNode.textContent = '';
        reset();
        if (!silent) banner(message, 'error');
      },
    });
  };
}

// --- record and transcribe --------------------------------------------------

/**
 * The explicit alternative to live speech: record a clip, upload it once, and
 * get the words back.
 *
 * Worth having as its own control rather than only as a silent fallback,
 * because it is the more robust path on a bad connection: one request instead
 * of an open stream, and nothing depends on the browser noticing that the user
 * has stopped talking. Live recognition with continuous=true is exactly what
 * Chrome is slowest to end.
 */
function transcribeHandler(target, input, interimNode) {
  const btn = target === 'patient' ? el.patientTranscribe : el.doctorTranscribe;
  let session = null;
  const idleLabel = 'Transcribe';
  const stopLabel = 'Stop · sending';
  const busyLabel = 'Transcribing…';

  const paint = (mode) => {
    btn.classList.toggle('is-recording', mode === 'rec');
    btn.classList.toggle('is-busy', mode === 'busy');
    btn.querySelector('.mic-alt-label').textContent =
      mode === 'rec' ? stopLabel : mode === 'busy' ? busyLabel : idleLabel;
    btn.setAttribute(
      'aria-label',
      mode === 'rec'
        ? 'Stop recording and send the audio'
        : mode === 'busy'
        ? 'Sending the audio for transcription'
        : target === 'patient'
        ? "Record the patient's words and send them for transcription"
        : "Record the doctor's reply and send it for transcription"
    );
  };

  const release = () => {
    session = null;
    setBusy({ transcribing: false, transcribingOn: null });
    paint(null);
    if (!state.busy && !state.listening) {
      setPod(target, 'idle');
      setBridge('idle', 'live');
    }
  };

  return () => {
    if (state.speaking) return; // never record the speaker
    if (session) {
      // Second tap closes the clip; the upload happens in onEnd.
      paint('busy');
      interimNode.textContent = 'Sending the recording…';
      session.stop();
      return;
    }
    if (state.listening) return; // one microphone at a time

    const keep = input.value;
    let failed = false;

    interimNode.textContent = '';
    setBusy({ transcribing: true, transcribingOn: target });
    setPod(target, 'live', 'Recording');
    setBridge('live', 'recording');
    banner('Recording… tap again to send.', 'info');

    session = speech.recordAndTranscribe(listenLangFor(target), {
      onStart: () => paint('rec'),
      onResult: ({ text }) => {
        input.value = text;
      },
      onEnd: ({ text, empty }) => {
        release();
        interimNode.textContent = '';
        if (failed) return;
        if (!input.value.trim() && keep) input.value = keep;
        if (empty) banner('No speech detected. Tap and try again.', 'warn');
        else banner(null);
        // Keep what the recogniser heard if it beat the final callback.
        if (!input.value.trim() && text) input.value = text;
      },
      onError: ({ message }) => {
        failed = true;
        if (!input.value.trim() && keep) input.value = keep;
        interimNode.textContent = '';
        release();
        banner(message, 'error');
      },
    });
  };
}

// --- speaking --------------------------------------------------------------

async function speakToPatient(text) {
  if (!text.trim()) return;
  if (state.speaking) {
    speech.stopSpeaking();
    setBusy({ speaking: false });
    setPod('patient', 'idle');
    setBridge('idle', 'live');
    return;
  }
  // The microphone being open would put the speaker's own voice straight back
  // into the room, which is how a patient hears their own words read back at
  // them. Finish the recording first.
  if (state.listening || state.transcribing) return;
  if (!speech.canSpeakLang(state.lang)) {
    banner(`This phone has no ${state.langName} voice. The reply is shown in text below.`, 'warn');
    return;
  }
  setBusy({ speaking: true });
  setPod('patient', 'live', 'Speaking');
  setBridge('live', 'speaking');
  banner('Patient is listening...', 'info');
  await speech.speak(text, state.lang);
  setBusy({ speaking: false });
  setPod('patient', 'idle');
  setBridge('idle', 'live');
  banner(null);
}

// --- consultation flow -----------------------------------------------------

el.toDoctorBtn.addEventListener('click', async () => {
  const native = el.patientInput.value.trim();
  if (!native) return;

  const english = await guarded(
    'Translating to English for the doctor...',
    () => translateText(native, state.lang, 'en'),
    { on: 'patient', label: 'Translating' }
  );
  if (!english) return;

  logTurn('patient', native);
  logTurn('doctor-view', english);

  fillBubble(el.doctorRead, english);
  el.copyReadBtn.hidden = false;
  el.replayBtn.disabled = false;
  setStep('Step 2 of 3 · Doctor reads and replies', 2);
  setBridge('fresh', 'delivered');
  setPod('doctor', 'live', 'Has the complaint');
  if (window.matchMedia('(max-width: 999px)').matches) {
    el.doctorCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});

el.replayBtn.addEventListener('click', () => {
  speakToPatient(el.patientInput.value);
});

el.copyReadBtn.addEventListener('click', async () => {
  const text = el.doctorRead.textContent.trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    banner('Copied the English translation to the clipboard.', 'info');
  } catch {
    banner('This browser blocked the clipboard. Select the text and copy it manually.', 'warn');
  }
});

el.relayBtn.addEventListener('click', async () => {
  const english = el.doctorInput.value.trim();
  if (!english) return;

  const native = await guarded(
    `Translating the reply into ${state.langName}...`,
    () => translateText(english, 'en', state.lang),
    { on: 'doctor', label: 'Translating' }
  );
  if (!native) return;

  logTurn('doctor', english);
  fillBubble(el.patientReply, native);
  await speakToPatient(native);
});

// --- prescription flow -----------------------------------------------------

el.toRxBtn.addEventListener('click', () => {
  if (el.doctorInput.value.trim() && !el.rxInput.value.trim()) {
    el.rxInput.value = el.doctorInput.value.trim();
  }
  setStep('Step 3 of 3 · Prescription', 3);
  show('rx');
  el.rxInput.focus();
});

el.rxMake.addEventListener('click', async () => {
  const note = el.rxInput.value.trim();
  if (!note) return;

  const rxSkeleton = document.querySelector('.skeleton-rx');
  rxSkeleton.classList.add('is-on');

  const parsed = await guarded('Reading the prescription...', () => parsePrescription(note), {
    on: 'doctor',
    label: 'Reading',
  });
  if (!parsed) {
    rxSkeleton.classList.remove('is-on');
    return;
  }

  const localised = await guarded(
    `Writing the prescription in ${state.langName}...`,
    () => localizePrescription(parsed, state.lang),
    { on: 'patient', label: 'Writing' }
  );
  rxSkeleton.classList.remove('is-on');
  if (!localised) return;

  state.prescription = localised;
  renderPrescription(localised);
  el.rxResult.hidden = false;
  // The session module owns the "Send to patient" button and cannot see this
  // assignment, so tell it the prescription now exists.
  document.dispatchEvent(new Event('rxchange'));
  el.rxResult.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

function renderPrescription(rx) {
  el.rxSummary.textContent = rx.spokenSummary || '';

  el.rxMeds.innerHTML = (rx.medicines || [])
    .map(
      (m, i) =>
        `<div class="med">
        <div class="med-n">${i + 1}</div>
        <div class="med-b">
          <div class="med-name" lang="en"></div>
          <dl class="med-kv">${m.dose && m.dose !== 'not specified'
            ? `<div class="kv"><dt>Dose</dt><dd></dd></div>` : ''}${
              m.frequency && m.frequency !== 'not specified'
              ? `<div class="kv"><dt>How often</dt><dd></dd></div>` : ''}${
              m.timing && m.timing !== 'not specified'
              ? `<div class="kv"><dt>When</dt><dd></dd></div>` : ''}${
              m.duration && m.duration !== 'not specified'
              ? `<div class="kv"><dt>For how long</dt><dd></dd></div>` : ''}${
              m.notes ? `<div class="kv"><dt>Note</dt><dd></dd></div>` : ''}</dl>
        </div>
      </div>`
    )
    .join('');

  // Populate with textContent - never innerHTML for medical text.
  const medNodes = [...el.rxMeds.querySelectorAll('.med')];
  medNodes.forEach((node, i) => {
    const m = rx.medicines[i];
    node.querySelector('.med-name').textContent = m.name;
    const values = [m.dose, m.frequency, m.timing, m.duration, m.notes].filter(
      (v) => v && v !== 'not specified'
    );
    [...node.querySelectorAll('.kv')].forEach((kv, j) => {
      kv.querySelector('dd').textContent = values[j];
    });
  });

  const blocks = [
    rx.advice?.length && ['Advice', rx.advice, ''],
    rx.tests?.length && ['Tests advised', rx.tests, ''],
    rx.warningSigns?.length && ['Go to hospital immediately if', rx.warningSigns, 'extra-danger'],
    rx.followUp && ['Come back', [rx.followUp], ''],
  ].filter(Boolean);

  el.rxExtras.innerHTML = blocks
    .map(
      ([title, items, cls]) =>
        `<div class="extra ${cls}"><h3></h3><ul>${items
          .map(() => '<li></li>')
          .join('')}</ul></div>`
    )
    .join('');
  [...el.rxExtras.querySelectorAll('.extra')].forEach((node, i) => {
    node.querySelector('h3').textContent = blocks[i][0];
    [...node.querySelectorAll('li')].forEach((li, j) => {
      li.textContent = blocks[i][1][j];
    });
  });

  el.rxResult.lang = state.lang;
  el.rxResult.dir = state.dir;
}

el.rxSpeak.addEventListener('click', () => {
  if (!state.prescription) return;
  if (state.speaking) {
    speech.stopSpeaking();
    setBusy({ speaking: false });
    return;
  }
  if (!speech.canSpeakLang(state.lang)) {
    banner(`This phone has no ${state.langName} voice. Show the patient the text below.`, 'warn');
    return;
  }
  const summary = state.prescription.spokenSummary || '';
  const meds = (state.prescription.medicines || [])
    .map((m, i) =>
      [
        `${i + 1}.`,
        m.name,
        m.frequency !== 'not specified' ? m.frequency : '',
        m.duration !== 'not specified' ? m.duration : '',
      ]
        .filter(Boolean)
        .join(' ')
    )
    .join('. ');
  const warnings = (state.prescription.warningSigns || []).join('. ');

  speakToPatient([summary, meds, warnings].filter(Boolean).join(' '));
});

el.rxPrint.addEventListener('click', () => {
  const rx = state.prescription;
  if (!rx) return;
  const patient = [rx.spokenSummary, ...(rx.medicines || []).map(
    (m, i) =>
      `${i + 1}. ${m.name} ${m.dose} - ${m.frequency}, ${m.timing}, ${m.duration}`
  )]
    .filter(Boolean)
    .join('\n');

  const win = window.open('', '_blank');
  if (!win) {
    banner('Your browser blocked the print window. Allow popups for this page.', 'warn');
    return;
  }
  win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Prescription</title>
<style>
  body{font:15px/1.6 system-ui,sans-serif;max-width:42em;margin:2em auto;padding:0 1em;color:#111}
  h1{font-size:20px;margin:0 0 .2em}
  .meta{color:#555;font-size:13px;margin-bottom:1.5em}
  .med{border-left:3px solid #0f766e;padding:.4em 0 .4em .8em;margin:.9em 0}
  .med b{display:block}
  pre{white-space:pre-wrap;font:inherit;background:#f6f8f8;padding:.8em;border-radius:6px}
  .warn{background:#fff4f4;border:1px solid #f0c0c0;padding:.7em;border-radius:6px}
</style></head><body>
<h1>Prescription</h1>
<div class="meta">Patient language: ${state.langName} &middot; generated ${new Date().toLocaleString()}</div>
<h2>For the patient</h2>
<pre>${escapeHtml(patient)}</pre>
<h2>Doctor's record (English)</h2>
<pre>${escapeHtml(toPlainEnglish(rx))}</pre>
<div class="warn"><b>AI-translated. Verify against the doctor's original note before use.</b></div>
</body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 300);
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// --- theme -----------------------------------------------------------------

const THEME_KEY = 'ss-theme';

function applyTheme(mode) {
  document.documentElement.dataset.theme = mode;
  el.themeBtn.setAttribute(
    'aria-label',
    mode === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'
  );
  el.themeBtn.title = mode === 'dark' ? 'Light theme' : 'Dark theme';
}

el.themeBtn.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode */ }
  applyTheme(next);
});

// --- wiring ----------------------------------------------------------------

// The picker is a radio group of tiles now, not a <select>.
// The pickers are radio groups of tiles, in two places on the page. One
// document-level listener keeps them from drifting apart.
document.addEventListener('click', (e) => {
  const tile = e.target.closest?.('.lang');
  if (tile) selectLang(tile.dataset.code);
});
document.addEventListener('keydown', (e) => {
  if (!e.target.closest?.('.lang-grid') || !e.target.closest?.('.lang')) return;
  const codes = CONFIG.languages.map((l) => l.code);
  const i = codes.indexOf(state.lang);
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
  const jump = { Home: 0, End: codes.length - 1 }[e.key];
  if (step === undefined && jump === undefined) return;
  e.preventDefault();
  // Home/End jump to the ends, as a radio group is expected to.
  moveLangSelection(state.lang, jump !== undefined ? jump - i : step);
});

el.langBtn.addEventListener('click', () => show('setup'));
el.startBtn.addEventListener('click', beginConsultation);
el.demoBtn.addEventListener('click', beginConsultation);
el.backToSetup.addEventListener('click', () => show('setup'));
el.backToConsult.addEventListener('click', () => show('consult'));

el.patientMic.addEventListener('click', micHandler('patient', el.patientInput, el.interim, el.patientMic));
el.doctorMic.addEventListener('click', micHandler('doctor', el.doctorInput, el.doctorInterim, el.doctorMic));
el.patientTranscribe.addEventListener('click', transcribeHandler('patient', el.patientInput, el.interim));
el.doctorTranscribe.addEventListener('click', transcribeHandler('doctor', el.doctorInput, el.doctorInterim));

el.patientInput.addEventListener('input', () => setBusy({}));
el.doctorInput.addEventListener('input', () => setBusy({}));
el.rxInput.addEventListener('input', () => setBusy({}));

// Typing in either box takes the floor from whoever has it, so the glow always
// points at the section the user is actually working in. Only done while
// nothing else is running, or this would fight the mic and the translate.
function takeFloor(who) {
  return () => {
    if (state.speaking || state.listening || state.busy) return;
    setPod(who, 'floor');
  };
}
function dropFloor(who) {
  return () => {
    if (state.speaking || state.listening || state.busy) return;
    setPod(who, 'idle');
  };
}
el.patientInput.addEventListener('focus', takeFloor('patient'));
el.patientInput.addEventListener('blur', dropFloor('patient'));
el.doctorInput.addEventListener('focus', takeFloor('doctor'));
el.doctorInput.addEventListener('blur', dropFloor('doctor'));
el.rxInput.addEventListener('focus', takeFloor('doctor'));

// Stop the speaker the moment the patient grabs the phone. `closest` matters
// here: the mic button and the reply bubble both have child elements, and a
// plain `===` comparison would miss every tap that landed on one of them.
window.addEventListener('pointerdown', (e) => {
  if (!state.speaking) return;
  const grabbed = e.target.closest?.('#patientMic, #patientInput, #patientReply');
  if (grabbed) {
    speech.stopSpeaking();
    setBusy({ speaking: false });
    setPod('patient', 'idle');
    setBridge('idle', 'live');
  }
});

function updateNetBadge() {
  const online = navigator.onLine;
  el.netBadge.querySelector('span').textContent = online ? 'online' : 'offline';
  el.netBadge.className = `badge ${online ? 'badge-ok' : 'badge-bad'}`;
  if (!online) banner('You are offline. Typing still works, speaking and translation do not.', 'warn');
}
window.addEventListener('online', updateNetBadge);
window.addEventListener('offline', updateNetBadge);

// --- boot ------------------------------------------------------------------

applyTheme(document.documentElement.dataset.theme || 'light');

// The signed-in seats are wired first: show() asks them whether the Rx screen
// may send, and the language pickers ask them to relabel their own screens.
initRoom({ state, setBusy, banner, logTurn, show, selectLang });
updateRoleChrome();

buildLanguagePicker();
updateNetBadge();
setBusy({});
setStep('Step 1 of 3 · Patient speaks', 1);
setPod('patient', 'floor');
setBridge('idle', 'live');
setView('both');

// A tab that was already in a room picks it up where it left off; a fresh tab
// lands on the two doors.
const seat = bootSession();
show(seat || 'login');

// The section switcher only exists below the two-column breakpoint, so its
// thumb is only measured once the layout has settled, and above that breakpoint
// the choice is meaningless because both panels are shown anyway.
const WIDE = window.matchMedia('(min-width: 1000px)');
function syncView() {
  setView(WIDE.matches ? 'both' : el.stage.dataset.view || 'both');
}
WIDE.addEventListener('change', syncView);
window.addEventListener('resize', syncView);

// Voices load asynchronously; refresh the capability list once they land.
setTimeout(describeCapabilities, 600);

// --- ambient field ---------------------------------------------------------

// The background is CSS-only: soft colour washes that drift with transform
// and opacity on the compositor. There is no pointer parallax to drive from
// here — that was the part that re-rasterised the screen on every mouse move
// and made the page feel laggy. The only thing left for JS is pausing the
// field while the tab is hidden, so an unattended clinic phone does not spin
// a GPU all afternoon.
document.addEventListener('visibilitychange', () => {
  document.documentElement.toggleAttribute('data-idle', document.hidden);
});
