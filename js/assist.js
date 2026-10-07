// ---------------------------------------------------------------------------
// assist.js - the two AI assistants.
//
// Two very different jobs share one model:
//   * the URGENT panel, on the patient's side. Short answers, the patient's own
//     language, immediate practical steps, and an honest "call 108 now" when the
//     situation needs it. Speed matters more than completeness here, so every
//     call asks for a tight token budget.
//   * the COPILOT, on the doctor's side. It reads the case that has been typed
//     into the form and answers a clinical question in English, the way a
//     second pair of eyes would - differentials, red flags, a draft note.
//
// Neither one is a doctor and neither one pretends to be: the wording in every
// prompt is written so the app never presents AI text as a diagnosis.
// ---------------------------------------------------------------------------

import { CONFIG } from './config.js';
import { callModel } from './ai.js';

/** Name the language instead of handing the model a bare "hi-IN". */
function langLabel(code) {
  if (!code || code.startsWith('en')) return 'English';
  const known = CONFIG.languages.find((l) => l.code === code);
  return known ? known.nameEn : code;
}

// --- urgent, patient side --------------------------------------------------

const URGENT_SYSTEM = (langLabel) => `You are the urgent-help assistant inside "Sehat Saathi", a health app used by patients in rural India who may have low literacy and a weak connection.

You are not a doctor and you never claim to be.

Rules:
- Answer in ${langLabel} only. If the user writes in another language, still answer in ${langLabel}.
- Be immediate and practical. The first sentence is what to do right now, not an introduction.
- Say plainly when this is an emergency and the person should call an ambulance (108 or 112) or the nearest health worker. Never suggest waiting to see how it goes when red flags are present.
- Never invent a diagnosis, never give prescription drug names or doses, never tell someone to stop medicine a doctor gave them.
- Home care advice (ORS, rest, cool cloth, position, watching breathing) is welcome and should be concrete.
- Short. Roughly 60-90 words. Sentence fragments are fine.`;

const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    level: { type: 'string', enum: ['emergency', 'urgent', 'routine'] },
    headline: { type: 'string' },
    now: { type: 'array', items: { type: 'string' } },
    seek: { type: 'string' },
    avoid: { type: 'string' },
  },
};

/**
 * Structured first-pass assessment. Returns the parsed record; callers render
 * the level chip and the do-now list straight away, which is what makes the
 * panel feel instant even while the free-form follow-up is still coming.
 */
export async function urgentTriage({ symptoms, lang, age }) {
  const out = await callModel({
    system:
      `${URGENT_SYSTEM(langLabel(lang))}

Return a JSON object with these exact keys:
- "level": "emergency" (needs an ambulance now), "urgent" (same day, health worker or clinic), or "routine" (can wait and self-care).
- "headline": one short sentence in ${langLabel(lang)} saying what this most likely is or what the main worry is, phrased so it does not pretend to be a confirmed diagnosis.
- "now": 2 to 4 concrete things to do in the next few minutes, in ${langLabel(lang)}.
- "seek": one sentence in ${langLabel(lang)} on when to get professional help.
- "avoid": one sentence in ${langLabel(lang)} on what not to do. If nothing applies, write "-".`,
    prompt: `Patient age: ${age || 'not given'}.\nWhat is happening:\n${String(symptoms || '').trim()}`,
    temperature: 0.2,
    schema: TRIAGE_SCHEMA,
    maxTokens: 700,
  });

  try {
    const parsed = JSON.parse(out);
    parsed.level = ['emergency', 'urgent', 'routine'].includes(parsed.level) ? parsed.level : 'urgent';
    parsed.now = Array.isArray(parsed.now) ? parsed.now.filter(Boolean).slice(0, 5) : [];
    return parsed;
  } catch {
    return {
      level: 'urgent',
      headline: out.slice(0, 160),
      now: [],
      seek: '',
      avoid: '',
    };
  }
}

/** Free-form follow-up inside the urgent session. */
export async function urgentAsk({ question, lang, age }) {
  return callModel({
    system: URGENT_SYSTEM(langLabel(lang)),
    prompt: `Patient age: ${age || 'not given'}.\n\n${String(question || '').trim()}`,
    temperature: 0.3,
    maxTokens: 550,
  });
}

// --- copilot, doctor side --------------------------------------------------

const COPILOT_SYSTEM = `You are the clinical copilot inside "Sehat Saathi", a translation-first consultation tool used by doctors seeing patients in rural India.

Rules:
- Answer in English, plainly, in under 150 words unless the question needs more.
- Work only from the case below. When something needed is missing, name it in one short line instead of inventing it.
- Differentials: the top 3 to 5, each with one line on what supports it and what would exclude it. No percentages.
- Red flags and safety-netting are always worth one line.
- Write in short bullet lines or tight sentences. No markdown headings, no bold, no repeated disclaimers, no preamble like "Certainly".
- You are a second pair of eyes for a qualified doctor, not a replacement, and you do not need to say so every time.`;

/**
 * One copilot turn. History is passed as text rather than as chat roles
 * because the proxy only speaks system + user - which is also what keeps the
 * request cache effective.
 */
export async function copilotAsk({ caseText, question, history = [] }) {
  const thread = history
    .slice(-6)
    .map((h) => `Doctor: ${h.q}\nCopilot: ${h.a}`)
    .join('\n\n');

  const prompt = [
    `CASE NOTES\n${caseText || '(the form is still empty)'}`,
    thread ? `\nEARLIER IN THIS SESSION\n${thread}` : '',
    `\nQUESTION\n${question}`,
  ]
    .filter(Boolean)
    .join('\n');

  return callModel({
    system: COPILOT_SYSTEM,
    prompt,
    temperature: 0.3,
    maxTokens: 900,
  });
}

// --- structured checks -----------------------------------------------------

const FLAGS_SCHEMA = {
  type: 'object',
  properties: {
    overall: { type: 'string', enum: ['red', 'amber', 'green'] },
    summary: { type: 'string' },
    flags: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          finding: { type: 'string' },
          action: { type: 'string' },
        },
      },
    },
  },
};

/**
 * Read the vitals and the complaint together. Returns `overall` as a colour
 * the UI paints, never as a number - a doctor should not have to interpret a
 * score the model invented.
 */
export async function checkRedFlags({ complaint, vitals }) {
  const out = await callModel({
    system: `${COPILOT_SYSTEM}

You are checking a short set of observations for danger signs. Return a JSON object:
- "overall": "red" (needs attention now), "amber" (needs review today), or "green" (no danger sign in what was provided).
- "summary": one plain sentence, under 25 words.
- "flags": zero or more objects with "finding" (what is off) and "action" (what to do about it). Only include findings actually supported by the values given.`,
    prompt: `Complaint:\n${complaint || '(none recorded)'}\n\nObservations:\n${vitals || '(none recorded)'}`,
    temperature: 0.1,
    schema: FLAGS_SCHEMA,
    maxTokens: 700,
  });

  try {
    const parsed = JSON.parse(out);
    parsed.overall = ['red', 'amber', 'green'].includes(parsed.overall) ? parsed.overall : 'amber';
    parsed.flags = Array.isArray(parsed.flags) ? parsed.flags.filter(Boolean).slice(0, 8) : [];
    return parsed;
  } catch {
    return { overall: 'amber', summary: out.slice(0, 200), flags: [] };
  }
}

/**
 * Turn the case into a plain-English prescription note. The note still goes
 * through the existing parse -> localise pipeline afterwards, so the doctor
 * reviews and edits it before the patient ever sees it.
 */
export async function draftPrescription({ complaint, diagnosis }) {
  return callModel({
    system: `${COPILOT_SYSTEM}

Draft a prescription note in plain English for this consultation, as a doctor would write it:
- One line per medicine: name, dose, how often, when to take, how many days.
- Then diet/home-care advice in one or two lines, then when to come back.
- Only medicine classes that are reasonable over-the-counter or primary-care choices for this complaint. If something needs to be examined first, say so in one line instead of prescribing.
- Maximum 8 lines. No headings, no numbering other than the medicine lines.`,
    prompt: `Complaint:\n${complaint || '(none recorded)'}\n\nAssessment / diagnosis:\n${diagnosis || '(not recorded)'}`,
    temperature: 0.3,
    maxTokens: 800,
  });
}
