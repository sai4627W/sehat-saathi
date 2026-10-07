// ---------------------------------------------------------------------------
// room.js - the two seats: the doctor's desk and the patient's chat.
//
// Everything a signed-in session does lives here: joining a room by code, the
// long-lived channel, translating each message for whoever is reading it, the
// doctor's case form and copilot, and the patient's urgent panel.
//
// The rule the whole file is built around:
//   a message carries BOTH languages. The patient's side renders `native`,
//   the doctor's side renders `text`. Neither side ever has to translate what
//   it is about to read, which is what keeps a reply instant on a slow link.
// ---------------------------------------------------------------------------

import { CONFIG } from './config.js';
import * as speech from './speech.js';
import { translateText } from './translate.js';
import * as relay from './relay.js';
import { toPlainEnglish } from './prescription.js';
import {
  urgentTriage,
  urgentAsk,
  copilotAsk,
  checkRedFlags,
  draftPrescription,
} from './assist.js';

const $ = (id) => document.getElementById(id);
const SESSION_KEY = 'ss-room';
const CASE_KEY = 'ss-case';

const el = {
  loginForm: $('loginForm'),
  loginTitleText: $('loginTitleText'),
  loginTag: $('loginTag'),
  loginGoLabel: $('loginGoLabel'),
  loginLang: $('loginLang'),
  roleCards: [...document.querySelectorAll('.role-card')],
  roleBack: $('roleBack'),
  patName: $('patName'),
  patAge: $('patAge'),
  patRoom: $('patRoom'),
  docName: $('docName'),
  docReg: $('docReg'),
  docRoom: $('docRoom'),
  newRoomBtn: $('newRoomBtn'),
  copyRoomBtn: $('copyRoomBtn'),

  roleChip: $('roleChip'),
  roleChipText: $('roleChipText'),
  logoutBtn: $('logoutBtn'),
  roleTab: $('roleTab'),
  roleTabLabel: $('roleTabLabel'),

  deskTitle: $('deskTitle'),
  deskRoom: $('deskRoom'),
  deskPeer: $('deskPeer'),
  deskPeerState: $('deskPeerState'),
  deskCopy: $('deskCopy'),
  deskLeave: $('deskLeave'),
  docPeerLang: $('docPeerLang'),
  docThread: $('docThread'),
  docTyping: $('docTyping'),
  docMsg: $('docMsg'),
  docMsgInterim: $('docMsgInterim'),
  docMic: $('docMic'),
  docTranscribe: $('docTranscribe'),
  docSend: $('docSend'),

  caseForm: $('caseForm'),
  fComplaint: $('fComplaint'),
  complaintAuto: $('complaintAuto'),
  fHistory: $('fHistory'),
  fExam: $('fExam'),
  vBp: $('vBp'),
  vPulse: $('vPulse'),
  vTemp: $('vTemp'),
  vSpo2: $('vSpo2'),
  vResp: $('vResp'),
  vWeight: $('vWeight'),
  flagsBtn: $('flagsBtn'),
  flagsOut: $('flagsOut'),
  fDx: $('fDx'),
  fAllergy: $('fAllergy'),
  fPlan: $('fPlan'),
  saveNoteBtn: $('saveNoteBtn'),
  sendAdviceBtn: $('sendAdviceBtn'),
  draftRxBtn: $('draftRxBtn'),
  liveConsultBtn: $('liveConsultBtn'),
  toRxFromForm: $('toRxFromForm'),

  aiThread: $('aiThread'),
  aiChips: $('aiChips'),
  aiInput: $('aiInput'),
  aiSend: $('aiSend'),

  patPeerName: $('patPeerName'),
  patRoomTag: $('patRoomTag'),
  patLangTag: $('patLangTag'),
  patPeerState: $('patPeerState'),
  patSpeakToggle: $('patSpeakToggle'),
  patThread: $('patThread'),
  patTyping: $('patTyping'),
  patMsg: $('patMsg'),
  patMsgInterim: $('patMsgInterim'),
  patTranscribe: $('patTranscribe'),
  patSend: $('patSend'),
  patMic: $('patMic'),
  urgentBtn: $('urgentBtn'),

  urgScrim: $('urgScrim'),
  urgentSheet: $('urgentSheet'),
  urgSub: $('urgSub'),
  urgClose: $('urgClose'),
  urgThread: $('urgThread'),
  urgTyping: $('urgTyping'),
  urgEscalate: $('urgEscalate'),
  urgInput: $('urgInput'),
  urgInterim: $('urgInterim'),
  urgMic: $('urgMic'),
  urgSend: $('urgSend'),

  rxSend: $('rxSend'),
  rxSendHint: $('rxSendHint'),
  rxInput: $('rxInput'),
};

/** The signed-in seat for this tab. sessionStorage, so two tabs can differ. */
const sess = {
  role: null,
  name: '',
  age: '',
  reg: '',
  room: '',
  lang: 'hi-IN',
  peer: null,
  speakAloud: true,
};

let D = null; // dependencies handed over by app.js
let pendingRoom = '';
let seen = new Set();
let lastSeq = 0;
let aiBusy = false;
let aiHist = [];
let urgFirst = true;
let lastTriage = null;
let lastPatientText = '';
let typingPing = 0;
let saveTimer = null;

// --- boot helpers ----------------------------------------------------------

function langName(code) {
  return (CONFIG.languages.find((l) => l.code === code) || CONFIG.languages[0]).nameEn;
}

function fmtTime(ts) {
  try {
    return new Date(ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function saveSession() {
  try {
    sessionStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        role: sess.role, name: sess.name, age: sess.age,
        reg: sess.reg, room: sess.room, lang: D.state.lang,
      })
    );
  } catch { /* private mode */ }
}

function loadSession() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
  } catch {
    return null;
  }
}

/** Run something that talks to the network: banner in, banner out, one lock. */
async function run(label, fn) {
  if (D.state.busy) return null;
  D.setBusy({ busy: true });
  syncSessionControls();
  if (label) D.banner(label, 'info');
  try {
    const out = await fn();
    D.banner(null);
    return out;
  } catch (err) {
    D.banner(err.message || 'Something went wrong.', 'error');
    return null;
  } finally {
    D.setBusy({ busy: false });
    syncSessionControls();
  }
}

// --- controls --------------------------------------------------------------

/** One place that knows which of this session's buttons may be pressed. */
export function syncSessionControls() {
  if (!D) return;
  const st = D.state;
  const locked = st.listening || st.speaking || st.busy || st.transcribing;
  // Being heard back (speech synthesis) must never disable the room: the
  // urgent button, the form and the composers stay live while a reply plays.
  const blocked = st.listening || st.busy || st.transcribing;
  const owner = st.listeningOn || st.transcribingOn;
  const dead = !speech.capabilities.canRecord || !speech.capabilities.secureEnough;
  const micLock = (who) => (locked && owner !== who) || dead;
  const canRec = speech.capabilities.canRecord && speech.capabilities.secureEnough;

  el.patMic.disabled = micLock('patient');
  el.docMic.disabled = micLock('doctor');
  el.urgMic.disabled = micLock('urgent');
  el.patTranscribe.hidden = !canRec;
  el.docTranscribe.hidden = !canRec;
  el.patTranscribe.disabled = locked;
  el.docTranscribe.disabled = locked;

  el.patSend.disabled = blocked || !el.patMsg.value.trim();
  el.docSend.disabled = blocked || !el.docMsg.value.trim();
  el.urgSend.disabled = blocked || !el.urgInput.value.trim();
  el.aiSend.disabled = blocked || aiBusy || !el.aiInput.value.trim();

  el.urgentBtn.disabled = blocked;
  el.sendAdviceBtn.disabled = blocked || !el.fPlan.value.trim();
  el.flagsBtn.disabled = blocked;
  el.draftRxBtn.disabled = blocked;

  syncRxSend();
}

/** Language changed: every patient-facing label follows the new language. */
export function syncLangUI() {
  if (!D) return;
  const st = D.state;
  el.patLangTag.textContent = st.langName;
  el.patMsg.placeholder = `Write in ${st.langName}, or tap the mic below`;
  el.patThread.lang = st.lang;
  el.patThread.dir = st.dir;
  el.urgSub.textContent = `Answers in ${st.langName} · not a diagnosis`;
  el.urgInput.placeholder = `What is happening? In ${st.langName}`;
  el.urgInput.lang = st.lang;
  el.urgInput.dir = st.dir;
  el.urgThread.lang = st.lang;
  el.urgThread.dir = st.dir;
  if (sess.peer?.lang) el.docPeerLang.textContent = langName(sess.peer.lang);
  syncSessionControls();
}

/** Which seat this tab is in, reflected in the chrome around the screens. */
export function updateRoleChrome() {
  const role = sess.role;
  document.body.dataset.role = role || '';
  el.roleChip.hidden = !role;
  el.roleChipText.textContent = role === 'doctor' ? 'Doctor' : role === 'patient' ? 'Patient' : '';
  el.logoutBtn.hidden = !role;
  el.roleTab.dataset.screen = role || 'login';
  el.roleTabLabel.textContent = role === 'doctor' ? 'Desk' : role === 'patient' ? 'Chat' : 'Start';
}

/** The "Send to patient" button only exists on the Rx screen, and only once
 *  there is a built prescription to send. app.js builds the prescription after
 *  show() has already run, so it announces that with an `rxchange` event and
 *  this recomputes — otherwise the button would stay hidden until the doctor
 *  left the screen and came back. */
let currentScreen = 'login';

function syncRxSend() {
  if (!D) return;
  const canSend = sess.role === 'doctor' && currentScreen === 'rx' && Boolean(D.state.prescription);
  el.rxSend.hidden = !canSend;
  el.rxSendHint.hidden = !canSend;
}

export function onShow(screen) {
  currentScreen = screen;
  syncRxSend();
}

// --- channel ---------------------------------------------------------------

function startChannel() {
  relay.stopPolling();
  seen = new Set();
  lastSeq = 0;
  relay.pollRoom({
    room: sess.room,
    role: sess.role,
    after: 0,
    onBatch: (msgs) => msgs.forEach(recv),
    onStatus: applyStatus,
    onError: () => paintPresence('reconnecting…', 'is-busy'),
  });
}

function paintPresence(text, extra = '') {
  for (const p of [el.deskPeerState, el.patPeerState]) {
    p.className = `pill${extra ? ' ' + extra : ''}`;
    p.querySelector('span').textContent = text;
  }
}

function applyStatus({ peers, meta, typing } = {}) {
  const other = sess.role === 'doctor' ? 'patient' : 'doctor';
  const online = Boolean(peers?.[other]);
  const peer = meta?.[other] || null;
  sess.peer = peer;

  paintPresence(online ? 'in the room' : peer ? 'away' : 'waiting', online ? 'is-live' : '');

  // Adopt the other side's language the moment it is known: the doctor's
  // picker should already say what the patient speaks.
  if (peer?.lang && peer.lang !== D.state.lang &&
      CONFIG.languages.some((l) => l.code === peer.lang)) {
    D.selectLang(peer.lang);
  }

  if (sess.role === 'doctor') {
    el.deskPeer.textContent = peer
      ? `${peer.name || 'Patient'}${peer.age ? `, ${peer.age}` : ''}`
      : 'patient not joined yet';
    el.docPeerLang.hidden = !peer;
    if (peer?.lang) el.docPeerLang.textContent = langName(peer.lang);
  } else {
    el.patPeerName.textContent = peer?.name || 'My doctor';
  }

  const typingNode = sess.role === 'doctor' ? el.docTyping : el.patTyping;
  typingNode.hidden = !typing;
}

function recv(msg) {
  if (!sess.role || seen.has(msg.id)) return;
  seen.add(msg.id);
  lastSeq = Math.max(lastSeq, msg.id);

  const kind = msg.kind || 'msg';
  const mine = msg.from === sess.role;
  const shown = (sess.role === 'doctor'
    ? (msg.text || msg.native)
    : (msg.native || msg.text)) || '';

  const thread = sess.role === 'doctor' ? el.docThread : el.patThread;
  renderMessage(thread, {
    mine,
    kind,
    text: shown,
    at: msg.at,
    who: mine ? (sess.role === 'doctor' ? 'You' : 'You') : (msg.from === 'doctor' ? 'Doctor' : 'Patient'),
    lang: sess.role === 'doctor' ? 'en' : D.state.lang,
    dir: sess.role === 'doctor' ? 'ltr' : D.state.dir,
    meta: msg.meta,
  });

  // The transcript log keeps both languages, the way the legacy flow did.
  if (kind !== 'rx') {
    if (msg.native && msg.text && msg.from === 'patient') {
      D.logTurn('patient', msg.native);
      D.logTurn('doctor-view', msg.text);
    } else if (msg.from === 'doctor') {
      D.logTurn('doctor', msg.text || msg.native);
    }
  }

  // The doctor's complaint fills itself in from the first thing the patient says.
  if (sess.role === 'doctor' && msg.from === 'patient' && kind !== 'rx') {
    if (!el.fComplaint.value.trim() && msg.text) {
      el.fComplaint.value = msg.text;
      el.complaintAuto.textContent = 'Auto-filled from the patient. Edit it if the wording is off.';
      el.complaintAuto.hidden = false;
      queueCaseSave();
    }
  }

  // Read the doctor's reply aloud on the patient's phone, if that is switched on.
  if (sess.role === 'patient' && msg.from === 'doctor' && kind === 'msg') {
    queueSpeak(shown);
  }
}

const KIND_CHIPS = { transcript: ['voice', 'is-voice'], sos: ['urgent', 'is-urgent'], advice: ['advice', ''] };

function renderMessage(thread, { mine, kind, text, at, who, lang, dir, meta }) {
  const empty = thread.querySelector('.thread-empty');
  if (empty) empty.remove();

  const row = document.createElement('div');
  row.lang = lang;
  row.dir = dir;

  if (kind === 'rx' && !mine) {
    row.className = 'msg msg-note is-rx';
    const head = document.createElement('b');
    head.textContent = 'Prescription from the doctor';
    const small = document.createElement('small');
    small.textContent = text;
    const ico = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ico.setAttribute('class', 'ico');
    ico.setAttribute('viewBox', '0 0 24 24');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-clipboard');
    ico.appendChild(use);
    row.append(ico, head, small);
  } else if (kind === 'sos' && !mine) {
    row.className = 'msg msg-note';
    const labels = {
      emergency: 'Emergency — the patient needs attention now',
      urgent: 'Urgent — the patient needs attention today',
      routine: 'The patient asked for help — not an emergency',
    };
    const strong = document.createElement('b');
    strong.textContent = (meta?.level && labels[meta.level]) || 'Urgent — the patient needs attention';
    const body = document.createElement('span');
    body.textContent = text;
    row.append(strong, body);
  } else {
    row.className = `msg ${mine ? 'msg-me' : 'msg-theirs'}`;
    const body = document.createElement('div');
    body.className = 'msg-text';
    body.textContent = text;
    row.appendChild(body);
  }

  const metaRow = document.createElement('div');
  metaRow.className = 'msg-meta';
  const whoSpan = document.createElement('span');
  whoSpan.textContent = who;
  metaRow.appendChild(whoSpan);

  const chip = KIND_CHIPS[kind];
  if (chip) {
    const tag = document.createElement('span');
    tag.className = `msg-kind ${chip[1]}`;
    tag.textContent = chip[0];
    metaRow.appendChild(tag);
  }
  const time = document.createElement('span');
  time.textContent = fmtTime(at);
  metaRow.appendChild(time);
  row.appendChild(metaRow);

  thread.appendChild(row);
  thread.scrollTop = thread.scrollHeight;
  return row;
}

// --- speaking (one speaker at a time, queued) ------------------------------

let speakQueue = [];
let speakingNow = false;

function queueSpeak(text) {
  if (!text || !sess.speakAloud) return;
  speakQueue.push(text);
  pumpSpeak();
}

async function pumpSpeak() {
  if (speakingNow || !D) return;
  const next = speakQueue.shift();
  if (next === undefined) return;
  speakingNow = true;
  try {
    const st = D.state;
    if (!st.listening && !st.transcribing && !st.speaking && speech.canSpeakLang(st.lang)) {
      D.setBusy({ speaking: true });
      syncSessionControls();
      await speech.speak(next, st.lang);
      D.setBusy({ speaking: false });
      syncSessionControls();
    }
  } catch { /* the browser refused; the text is on screen anyway */ }
  finally {
    speakingNow = false;
    pumpSpeak();
  }
}

// --- microphone, both seats ------------------------------------------------

/**
 * Same contract as app.js's micHandler, minus the consult pods: this seat has
 * no two-panel stage to give the floor to, only a label and a lock.
 */
function roleMic(target, input, interimNode, micBtn, idleLabel) {
  let deadline = null;
  const langFor = () => (target === 'doctor' ? 'en-IN' : D.state.lang);

  const reset = () => {
    clearTimeout(deadline);
    deadline = null;
    micBtn.classList.remove('listening');
    micBtn.querySelector('.mic-label').textContent = idleLabel;
    D.setBusy({ listening: false, listeningOn: null });
    syncSessionControls();
  };

  return () => {
    if (D.state.speaking) return;
    if (D.state.transcribing) return;
    if (D.state.listening) {
      speech.stopListening();
      clearTimeout(deadline);
      deadline = setTimeout(reset, 2500);
      return;
    }

    const keep = input.value;
    let failed = false;
    interimNode.textContent = '';
    D.setBusy({ listening: true, listeningOn: target });
    micBtn.classList.add('listening');
    micBtn.querySelector('.mic-label').textContent = 'Listening… tap to stop';
    syncSessionControls();
    D.banner('Listening…', 'info');

    speech.listen(langFor(), {
      onResult: ({ text, isFinal }) => {
        interimNode.textContent = text;
        if (isFinal) {
          input.value = text;
          interimNode.textContent = '';
          syncSessionControls();
        }
      },
      onEnd: ({ text, empty }) => {
        if (!input.value && text) input.value = text;
        if (!input.value.trim() && keep) input.value = keep;
        interimNode.textContent = '';
        reset();
        if (failed) return;
        if (empty) D.banner('No speech detected. Tap the mic and try again.', 'warn');
        else D.banner(null);
      },
      onError: ({ code, message, silent }) => {
        if (code === 'fallback') return;
        failed = true;
        if (!input.value.trim() && keep) input.value = keep;
        interimNode.textContent = '';
        reset();
        if (!silent) D.banner(message, 'error');
      },
    });
  };
}

function roleTranscribe(target, input, interimNode) {
  const btn = target === 'patient' ? el.patTranscribe : el.docTranscribe;
  let session = null;

  const paint = (mode) => {
    btn.classList.toggle('is-recording', mode === 'rec');
    btn.classList.toggle('is-busy', mode === 'busy');
    btn.querySelector('.mic-alt-label').textContent =
      mode === 'rec' ? 'Stop · sending' : mode === 'busy' ? 'Transcribing…' : 'Transcribe';
  };

  const release = () => {
    session = null;
    D.setBusy({ transcribing: false, transcribingOn: null });
    paint(null);
    syncSessionControls();
  };

  return () => {
    if (D.state.speaking) return;
    if (session) {
      paint('busy');
      interimNode.textContent = 'Sending the recording…';
      session.stop();
      return;
    }
    if (D.state.listening) return;

    const keep = input.value;
    let failed = false;
    interimNode.textContent = '';
    D.setBusy({ transcribing: true, transcribingOn: target });
    syncSessionControls();
    D.banner('Recording… tap again to send.', 'info');

    session = speech.recordAndTranscribe(target === 'doctor' ? 'en-IN' : D.state.lang, {
      onStart: () => paint('rec'),
      onResult: ({ text }) => { input.value = text; },
      onEnd: ({ text, empty }) => {
        release();
        interimNode.textContent = '';
        if (failed) return;
        if (!input.value.trim() && keep) input.value = keep;
        if (!input.value.trim() && text) input.value = text;
        if (empty) D.banner('No speech detected. Tap and try again.', 'warn');
        else D.banner(null);
      },
      onError: ({ message }) => {
        failed = true;
        if (!input.value.trim() && keep) input.value = keep;
        interimNode.textContent = '';
        release();
        D.banner(message, 'error');
      },
    });
  };
}

// --- sending ---------------------------------------------------------------

function pingTyping() {
  const now = Date.now();
  if (now - typingPing < 2000 || !sess.room) return;
  typingPing = now;
  relay.pingTyping(sess.room, sess.role);
}

/** Translate out of my seat's language and hand the message to the room. */
async function deliver({ kind, inputNode }) {
  const raw = inputNode.value.trim();
  if (!raw) return;

  const st = D.state;
  let text;
  let native;

  if (sess.role === 'doctor') {
    text = raw;
    native = await run(`Translating into ${st.langName}…`, () =>
      translateText(raw, 'en', st.lang)
    );
    if (native === null) return; // translation failed: the banner already said so
  } else {
    native = raw;
    text = await run('Translating to English for the doctor…', () =>
      translateText(raw, st.lang, 'en')
    );
    if (text === null) return;
  }

  const ok = await run('Sending…', () =>
    relay.sendRoom({ room: sess.room, from: sess.role, kind, text, native, lang: st.lang })
  );
  if (ok === null) return;

  inputNode.value = '';
  syncSessionControls();
}

// --- doctor: case form -----------------------------------------------------

const CASE_FIELDS = ['fComplaint', 'fHistory', 'fExam', 'vBp', 'vPulse', 'vTemp',
  'vSpo2', 'vResp', 'vWeight', 'fDx', 'fAllergy', 'fPlan'];

function queueCaseSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveCase, 700);
}

function saveCase(silent = false) {
  try {
    const data = {};
    for (const key of CASE_FIELDS) data[key] = el[key] ? el[key].value : '';
    sessionStorage.setItem(CASE_KEY, JSON.stringify(data));
  } catch { /* private mode */ }
  if (!silent) D.banner('Note saved on this device.', 'info');
}

function loadCase() {
  let data = null;
  try {
    data = JSON.parse(sessionStorage.getItem(CASE_KEY) || 'null');
  } catch { /* ignore */ }
  if (!data) return;
  for (const key of CASE_FIELDS) {
    if (el[key] && typeof data[key] === 'string') el[key].value = data[key];
  }
  el.complaintAuto.textContent = 'Restored from your last session on this device.';
  el.complaintAuto.hidden = !el.fComplaint.value.trim();
}

function vitalText() {
  const rows = [
    ['BP', el.vBp], ['Pulse', el.vPulse], ['Temp', el.vTemp],
    ['SpO2', el.vSpo2], ['Resp', el.vResp], ['Weight', el.vWeight],
  ]
    .filter(([, node]) => node.value.trim())
    .map(([label, node]) => `${label}: ${node.value.trim()}`);
  return rows.join('\n');
}

function caseText() {
  const blocks = [
    ['Chief complaint', el.fComplaint.value],
    ['History', el.fHistory.value],
    ['Examination', el.fExam.value],
    ['Vitals', vitalText()],
    ['Assessment', el.fDx.value],
    ['Allergies / ongoing meds', el.fAllergy.value],
    ['Plan', el.fPlan.value],
  ].filter(([, v]) => v.trim());
  if (!blocks.length) return '';
  return blocks.map(([k, v]) => `${k}: ${v.trim()}`).join('\n');
}

function clearFlags() {
  el.flagsOut.innerHTML = '';
  el.flagsOut.hidden = true;
}

function renderFlags(result) {
  el.flagsOut.innerHTML = '';
  const names = { red: 'Needs attention now', amber: 'Review today', green: 'No danger sign found' };
  const head = document.createElement('p');
  head.className = `flag flag-${result.overall}`;
  const ico = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  ico.setAttribute('class', 'ico');
  ico.setAttribute('viewBox', '0 0 24 24');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', result.overall === 'green' ? '#i-check' : '#i-alert');
  ico.appendChild(use);
  const box = document.createElement('span');
  const label = document.createElement('b');
  label.textContent = names[result.overall];
  const summary = document.createElement('span');
  summary.textContent = result.summary;
  box.append(label, summary);
  head.append(ico, box);
  el.flagsOut.appendChild(head);

  if (result.flags.length) {
    const list = document.createElement('ul');
    list.className = 'flag-list';
    for (const f of result.flags) {
      const li = document.createElement('li');
      const body = document.createElement('span');
      const finding = document.createElement('b');
      finding.textContent = f.finding;
      const action = document.createElement('span');
      action.textContent = ` ${f.action}`;
      body.append(finding, action);
      li.appendChild(body);
      list.appendChild(li);
    }
    el.flagsOut.appendChild(list);
  }
  el.flagsOut.hidden = false;
}

// --- doctor: copilot -------------------------------------------------------

function addAi(kind, text) {
  const empty = el.aiThread.querySelector('.thread-empty');
  if (empty) empty.remove();
  const node = document.createElement('div');
  node.className = `ai-msg ${kind === 'me' ? 'ai-me' : 'ai-them'}`;
  node.textContent = text;
  el.aiThread.appendChild(node);
  el.aiThread.scrollTop = el.aiThread.scrollHeight;
  return node;
}

async function askCopilot(question) {
  const q = (question || '').trim();
  if (!q || aiBusy) return;
  addAi('me', q);

  aiBusy = true;
  syncSessionControls();
  const busyNode = addAi('them', '');
  busyNode.classList.add('is-busy');
  el.aiThread.scrollTop = el.aiThread.scrollHeight;

  const answer = await run('Asking the copilot…', () =>
    copilotAsk({ caseText: caseText(), question: q, history: aiHist })
  );

  busyNode.remove();
  aiBusy = false;
  syncSessionControls();
  if (!answer) return;
  aiHist.push({ q, a: answer });
  if (aiHist.length > 8) aiHist = aiHist.slice(-8);
  addAi('them', answer);
}

// --- urgent session --------------------------------------------------------

function openUrgent() {
  el.urgScrim.hidden = false;
  el.urgentSheet.hidden = false;
  el.urgSub.textContent = `Answers in ${D.state.langName} · not a diagnosis`;
  requestAnimationFrame(() => {
    el.urgScrim.classList.add('is-open');
    el.urgentSheet.classList.add('is-open');
  });
  setTimeout(() => el.urgInput.focus(), 60);
}

function closeUrgent() {
  el.urgScrim.classList.remove('is-open');
  el.urgentSheet.classList.remove('is-open');
  setTimeout(() => {
    el.urgScrim.hidden = true;
    el.urgentSheet.hidden = true;
  }, 300);
}

function addUrgMine(text) {
  const empty = el.urgThread.querySelector('.thread-empty');
  if (empty) empty.remove();
  const row = document.createElement('div');
  row.className = 'msg msg-me';
  row.lang = D.state.lang;
  row.dir = D.state.dir;
  const body = document.createElement('div');
  body.className = 'msg-text';
  body.textContent = text;
  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  const who = document.createElement('span');
  who.textContent = 'You';
  const time = document.createElement('span');
  time.textContent = fmtTime();
  meta.append(who, time);
  row.append(body, meta);
  el.urgThread.appendChild(row);
  el.urgThread.scrollTop = el.urgThread.scrollHeight;
}

function addUrgTheirs(text, label = 'Urgent helper') {
  const row = document.createElement('div');
  row.className = 'msg msg-theirs';
  row.lang = D.state.lang;
  row.dir = D.state.dir;
  const body = document.createElement('div');
  body.className = 'msg-text';
  body.textContent = text;
  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  const who = document.createElement('span');
  who.textContent = label;
  const tag = document.createElement('span');
  tag.className = 'msg-kind is-urgent';
  tag.textContent = 'AI';
  const time = document.createElement('span');
  time.textContent = fmtTime();
  meta.append(who, tag, time);
  row.append(body, meta);
  el.urgThread.appendChild(row);
  el.urgThread.scrollTop = el.urgThread.scrollHeight;
}

function addTriageCard(t) {
  const row = document.createElement('div');
  row.className = 'msg msg-theirs msg-triage';
  row.lang = D.state.lang;
  row.dir = D.state.dir;

  const level = document.createElement('span');
  level.className = `triage-level is-${t.level}`;
  level.textContent = {
    emergency: 'Call for help now',
    urgent: 'See a health worker today',
    routine: 'Can be managed at home',
  }[t.level];

  const head = document.createElement('b');
  head.className = 'triage-head';
  head.textContent = t.headline;

  row.append(level, head);

  if (t.now.length) {
    const ul = document.createElement('ul');
    ul.className = 'triage-now';
    for (const item of t.now) {
      const li = document.createElement('li');
      li.textContent = item;
      ul.appendChild(li);
    }
    row.appendChild(ul);
  }
  for (const note of [t.seek, t.avoid].filter((v) => v && v !== '-')) {
    const p = document.createElement('p');
    p.className = 'triage-note';
    p.textContent = note;
    row.appendChild(p);
  }

  el.urgThread.appendChild(row);
  el.urgThread.scrollTop = el.urgThread.scrollHeight;
}

async function urgentCall(fn) {
  D.setBusy({ busy: true });
  syncSessionControls();
  el.urgTyping.hidden = false;
  el.urgThread.scrollTop = el.urgThread.scrollHeight;
  try {
    return await fn();
  } catch (err) {
    addUrgTheirs(err.message || 'Could not reach the helper. Try again.', 'Urgent helper');
    return null;
  } finally {
    el.urgTyping.hidden = true;
    D.setBusy({ busy: false });
    syncSessionControls();
  }
}

async function urgentSubmit() {
  const text = el.urgInput.value.trim();
  if (!text || D.state.busy) return;

  el.urgInput.value = '';
  syncSessionControls();
  addUrgMine(text);
  lastPatientText = text;

  if (urgFirst) {
    urgFirst = false;
    const t = await urgentCall(() =>
      urgentTriage({ symptoms: text, lang: D.state.lang, age: sess.age })
    );
    if (t) {
      lastTriage = t;
      addTriageCard(t);
      queueSpeak([t.headline, ...t.now].filter(Boolean).join('. '));
      el.urgEscalate.hidden = !sess.room;
    }
    return;
  }

  const reply = await urgentCall(() =>
    urgentAsk({ question: text, lang: D.state.lang, age: sess.age })
  );
  if (reply) {
    addUrgTheirs(reply);
    queueSpeak(reply);
  }
}

async function escalateToDoctor() {
  if (!sess.room || !lastPatientText) return;
  const st = D.state;
  const text = await run('Sending to your doctor…', () =>
    translateText(lastPatientText, st.lang, 'en')
  );
  if (text === null) return;
  const ok = await run('Sending to your doctor…', () =>
    relay.sendRoom({
      room: sess.room,
      from: 'patient',
      kind: 'sos',
      text,
      native: lastPatientText,
      lang: st.lang,
      meta: lastTriage
        ? { level: lastTriage.level, headline: lastTriage.headline }
        : null,
    })
  );
  if (ok === null) return;
  el.urgEscalate.hidden = true;
  D.banner('Sent to your doctor.', 'info');
}

// --- login -----------------------------------------------------------------

function pickRole(role) {
  sess.role = role;
  document.body.classList.add('is-picked');
  for (const card of el.roleCards) {
    const on = card.dataset.role === role;
    card.classList.toggle('is-on', on);
    card.setAttribute('aria-selected', String(on));
  }
  for (const node of el.loginForm.querySelectorAll('[data-when]')) {
    node.hidden = node.dataset.when !== role;
  }
  el.loginForm.hidden = false;
  el.loginTitleText.textContent = role === 'doctor' ? 'Open your room' : 'Join the room';
  el.loginTag.hidden = false;
  el.loginTag.className = `tag ${role === 'doctor' ? 'tag-doctor' : 'tag-patient'}`;
  el.loginTag.textContent = role;
  el.loginGoLabel.textContent = role === 'doctor' ? 'Open the room' : 'Join the room';

  if (role === 'doctor') {
    if (!pendingRoom) pendingRoom = relay.makeRoomCode();
    el.docRoom.textContent = relay.displayRoom(pendingRoom);
    setTimeout(() => el.docName.focus(), 40);
  } else {
    setTimeout(() => (el.patRoom.value ? el.patName.focus() : el.patRoom.focus()), 40);
  }
  syncSessionControls();
}

function resetRolePicker() {
  sess.role = null;
  document.body.classList.remove('is-picked');
  for (const card of el.roleCards) {
    card.classList.remove('is-on');
    card.setAttribute('aria-selected', 'false');
  }
  el.loginForm.hidden = true;
}

async function enterRoom(e) {
  e.preventDefault();
  const role = sess.role;
  if (!role) return;

  if (role === 'doctor') {
    const name = el.docName.value.trim();
    if (!name) {
      D.banner('Enter your name to open the room.', 'warn');
      el.docName.focus();
      return;
    }
    sess.name = name;
    sess.reg = el.docReg.value.trim();
    sess.room = relay.normaliseRoom(pendingRoom);
  } else {
    const name = el.patName.value.trim();
    const code = relay.normaliseRoom(el.patRoom.value);
    if (!name) {
      D.banner('Enter your name so the doctor knows who this is.', 'warn');
      el.patName.focus();
      return;
    }
    if (code.length < 4) {
      D.banner('The room code is at least four characters.', 'warn');
      el.patRoom.focus();
      return;
    }
    sess.name = name;
    sess.age = el.patAge.value.trim();
    sess.room = code;
  }

  sess.lang = D.state.lang;
  const joined = await run(role === 'doctor' ? 'Opening the room…' : 'Joining the room…', () =>
    relay.joinRoom({
      room: sess.room,
      from: role,
      name: sess.name,
      age: sess.age,
      lang: sess.lang,
    })
  );
  if (joined === null) return;

  saveSession();
  updateRoleChrome();
  applySessionScreen();
  applyStatus(joined);
  startChannel();
  D.show(role);
  D.banner(`Room ${relay.displayRoom(sess.room)} is open. Share the code with the other side.`, 'info');
}

function applySessionScreen() {
  const st = D.state;
  if (sess.role === 'doctor') {
    el.deskTitle.textContent = sess.name ? `${sess.name}'s desk` : 'Consultation desk';
    el.deskRoom.textContent = relay.displayRoom(sess.room);
    el.deskPeer.textContent = 'patient not joined yet';
    loadCase();
    syncSessionControls();
  } else {
    el.patRoomTag.textContent = relay.displayRoom(sess.room);
    el.patLangTag.textContent = st.langName;
    el.patThread.lang = st.lang;
    el.patThread.dir = st.dir;
    syncSessionControls();
  }
}

export function endSession() {
  relay.stopPolling();
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch { /* private mode */ }
  sess.role = null;
  sess.peer = null;
  sess.room = '';
  aiHist = [];
  urgFirst = true;
  lastTriage = null;
  lastPatientText = '';
  seen = new Set();
  lastSeq = 0;
  speakQueue = [];
  for (const thread of [el.docThread, el.patThread]) {
    thread.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'thread-empty';
    const p = document.createElement('p');
    p.textContent = thread === el.docThread
      ? "The patient's messages arrive here, already in English. Reply below — it goes back in their language."
      : "Say what is happening in your own language. The doctor will read it in English and reply.";
    empty.appendChild(p);
    thread.appendChild(empty);
  }
  el.docMsg.value = '';
  el.patMsg.value = '';
  clearFlags();
  resetRolePicker();
  updateRoleChrome();
  paintPresence('waiting');
  D.show('login');
  D.banner('You left the room.', 'info');
}

/** Restore this tab's seat, if it had one. Returns the role, or null. */
export function bootSession() {
  const saved = loadSession();
  if (!saved?.room || !saved.role) return null;
  Object.assign(sess, {
    role: saved.role,
    name: saved.name || '',
    age: saved.age || '',
    reg: saved.reg || '',
    room: saved.room,
    lang: saved.lang || sess.lang,
  });
  if (CONFIG.languages.some((l) => l.code === sess.lang)) D.selectLang(sess.lang);
  updateRoleChrome();
  applySessionScreen();
  // Say hello again: a restored tab may have outlived the room's copy of who
  // it is (the room itself only lives two hours, the tab may not).
  relay
    .joinRoom({
      room: sess.room,
      from: sess.role,
      name: sess.name,
      age: sess.age,
      lang: sess.lang,
    })
    .then(applyStatus)
    .catch(() => {});
  startChannel();
  return sess.role;
}

// --- wiring ----------------------------------------------------------------

export function initRoom(deps) {
  D = deps;

  for (const card of el.roleCards) {
    card.addEventListener('click', () => pickRole(card.dataset.role));
  }
  el.roleBack.addEventListener('click', resetRolePicker);
  el.loginForm.addEventListener('submit', enterRoom);

  el.newRoomBtn.addEventListener('click', () => {
    pendingRoom = relay.makeRoomCode();
    el.docRoom.textContent = relay.displayRoom(pendingRoom);
  });
  el.copyRoomBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(relay.displayRoom(el.docRoom.textContent));
      D.banner('Room code copied. Send it to the patient.', 'info');
    } catch {
      D.banner('This browser blocked the clipboard. Read the code out instead.', 'warn');
    }
  });
  el.deskCopy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(relay.displayRoom(sess.room));
      D.banner('Room code copied.', 'info');
    } catch {
      D.banner('Clipboard blocked. The code is shown at the top of the desk.', 'warn');
    }
  });

  el.logoutBtn.addEventListener('click', endSession);
  el.deskLeave.addEventListener('click', endSession);

  // patient chat
  el.patMic.addEventListener('click', roleMic('patient', el.patMsg, el.patMsgInterim, el.patMic, 'Tap to speak'));
  el.patTranscribe.addEventListener('click', roleTranscribe('patient', el.patMsg, el.patMsgInterim));
  el.patSend.addEventListener('click', () =>
    deliver({ kind: 'msg', inputNode: el.patMsg })
  );
  el.patMsg.addEventListener('input', () => {
    syncSessionControls();
    pingTyping();
  });
  el.patMsg.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      el.patSend.click();
    }
  });
  el.patSpeakToggle.addEventListener('click', () => {
    sess.speakAloud = !sess.speakAloud;
    el.patSpeakToggle.setAttribute('aria-pressed', String(sess.speakAloud));
    el.patSpeakToggle.classList.toggle('is-off', !sess.speakAloud);
    if (!sess.speakAloud) {
      speakQueue = [];
      if (D.state.speaking) {
        speech.stopSpeaking();
        D.setBusy({ speaking: false });
        syncSessionControls();
      }
    }
    D.banner(sess.speakAloud ? 'Replies will be read aloud.' : 'Replies will be shown as text only.', 'info');
  });

  // doctor channel
  el.docMic.addEventListener('click', roleMic('doctor', el.docMsg, el.docMsgInterim, el.docMic, 'Dictate'));
  el.docTranscribe.addEventListener('click', roleTranscribe('doctor', el.docMsg, el.docMsgInterim));
  el.docSend.addEventListener('click', () =>
    deliver({ kind: 'msg', inputNode: el.docMsg })
  );
  el.docMsg.addEventListener('input', () => {
    syncSessionControls();
    pingTyping();
  });
  el.docMsg.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      el.docSend.click();
    }
  });

  // case form
  for (const key of CASE_FIELDS) {
    el[key]?.addEventListener('input', () => {
      queueCaseSave();
      syncSessionControls();
    });
  }
  el.saveNoteBtn.addEventListener('click', () => saveCase(false));

  el.sendAdviceBtn.addEventListener('click', async () => {
    const advice = el.fPlan.value.trim();
    if (!advice) {
      D.banner('Write the advice for the patient first.', 'warn');
      el.fPlan.focus();
      return;
    }
    const st = D.state;
    const native = await run(`Translating the advice into ${st.langName}…`, () =>
      translateText(advice, 'en', st.lang)
    );
    if (native === null) return;
    const ok = await run('Sending the advice…', () =>
      relay.sendRoom({ room: sess.room, from: 'doctor', kind: 'advice', text: advice, native, lang: st.lang })
    );
    if (ok === null) return;
    D.banner('Advice sent to the patient.', 'info');
  });

  el.flagsBtn.addEventListener('click', async () => {
    const complaint = el.fComplaint.value.trim();
    const vitals = vitalText();
    if (!complaint && !vitals) {
      D.banner('Add the complaint or some vitals first.', 'warn');
      return;
    }
    const result = await run('Checking danger signs…', () =>
      checkRedFlags({ complaint, vitals })
    );
    if (result) renderFlags(result);
  });

  el.draftRxBtn.addEventListener('click', async () => {
    const note = await run('Drafting a prescription note…', () =>
      draftPrescription({ complaint: caseText(), diagnosis: el.fDx.value.trim() })
    );
    if (!note) return;
    el.rxInput.value = note;
    D.show('rx');
    D.banner('Draft ready — edit it, then build and send.', 'info');
    el.rxInput.focus();
  });

  el.toRxFromForm.addEventListener('click', () => {
    if (!el.rxInput.value.trim()) {
      const draft = [el.fDx.value.trim(), el.fPlan.value.trim()].filter(Boolean).join('\n');
      if (draft) el.rxInput.value = draft;
    }
    D.show('rx');
    el.rxInput.focus();
  });

  el.liveConsultBtn.addEventListener('click', () => D.show('consult'));

  // copilot
  el.aiChips.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-q]');
    if (btn) askCopilot(btn.dataset.q);
  });
  el.aiSend.addEventListener('click', () => {
    const q = el.aiInput.value;
    el.aiInput.value = '';
    syncSessionControls();
    askCopilot(q);
  });
  el.aiInput.addEventListener('input', syncSessionControls);
  el.aiInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      el.aiSend.click();
    }
  });

  // urgent session
  el.urgentBtn.addEventListener('click', openUrgent);
  el.urgClose.addEventListener('click', closeUrgent);
  el.urgScrim.addEventListener('click', closeUrgent);
  el.urgSend.addEventListener('click', urgentSubmit);
  el.urgEscalate.addEventListener('click', escalateToDoctor);
  el.urgInput.addEventListener('input', syncSessionControls);
  el.urgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      urgentSubmit();
    }
  });
  el.urgMic.addEventListener('click', roleMic('urgent', el.urgInput, el.urgInterim, el.urgMic, 'Speak'));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.urgentSheet.hidden) closeUrgent();
  });

  // Rx screen
  document.addEventListener('rxchange', syncRxSend);
  el.rxSend.addEventListener('click', async () => {
    const rx = D.state.prescription;
    if (!rx || !sess.room) return;
    const english = toPlainEnglish(rx);
    const native = [
      rx.spokenSummary,
      ...(rx.medicines || []).map(
        (m, i) =>
          `${i + 1}. ${m.name} - ${[m.dose, m.frequency, m.timing, m.duration]
            .filter((v) => v && v !== 'not specified')
            .join(', ')}`
      ),
      ...(rx.warningSigns || []).map((w) => `! ${w}`),
      rx.followUp ? `Come back: ${rx.followUp}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const ok = await run('Sending the prescription…', () =>
      relay.sendRoom({ room: sess.room, from: 'doctor', kind: 'rx', text: english, native, lang: D.state.lang })
    );
    if (ok === null) return;
    D.banner('Prescription sent to the patient.', 'info');
  });
}
