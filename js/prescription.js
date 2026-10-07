// ---------------------------------------------------------------------------
// prescription.js - turn a doctor's free-text prescription into a clean,
// patient-understandable record in the patient's own language.
//
// Two model calls:
//   1. parsePrescription  -> structured JSON in English (doctor's view)
//   2. localizePrescription -> that record in the patient's language
//
// SAFETY RULES encoded in the prompts below:
//   - never invent a drug, a dose or a duration that the doctor did not write
//   - never translate or "clean up" a drug name or a number
//   - always surface a check-back line so the doctor can confirm
// ---------------------------------------------------------------------------

import { callModel } from './ai.js';

const MEDICINE_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Drug name exactly as the doctor wrote it.' },
    dose: { type: 'string', description: 'Strength exactly as written, e.g. "500 mg". If absent, "not specified".' },
    frequency: { type: 'string', description: 'How often, e.g. "twice a day". If absent, "not specified".' },
    duration: { type: 'string', description: 'How long, e.g. "5 days". If absent, "not specified".' },
    timing: { type: 'string', description: 'Relation to food, e.g. "after food". If absent, "not specified".' },
    notes: { type: 'string', description: 'Any extra instruction. Empty string if none.' },
  },
  required: ['name', 'dose', 'frequency', 'duration', 'timing', 'notes'],
};

const PRESCRIPTION_SCHEMA = {
  type: 'object',
  properties: {
    complaint: { type: 'string', description: 'The presenting problem, in plain English.' },
    medicines: { type: 'array', items: MEDICINE_SCHEMA },
    tests: { type: 'array', items: { type: 'string' }, description: 'Tests the doctor advised. Empty if none.' },
    advice: { type: 'array', items: { type: 'string' }, description: 'Diet, rest and lifestyle advice.' },
    warningSigns: { type: 'array', items: { type: 'string' }, description: 'Danger signs that mean return urgently.' },
    followUp: { type: 'string', description: 'When to come back. Empty string if not stated.' },
    spokenSummary: {
      type: 'string',
      description:
        'One short paragraph, under 60 words, written in very simple everyday English for the patient to hear aloud. No medical jargon. Mention each medicine by name with how many times a day and for how many days. Mention anything the patient must not do.',
    },
  },
  required: ['complaint', 'medicines', 'tests', 'advice', 'warningSigns', 'followUp', 'spokenSummary'],
};

const PARSE_SYSTEM = `You are a medical assistant helping a doctor record a prescription.

Absolute rules:
- Extract ONLY what the doctor actually wrote. Never guess, never add a drug, never infer a dose or duration that is missing. If something is not stated, write "not specified".
- Copy drug names, strengths, numbers and units exactly as written. Do not reformat, convert or round them.
- Do not add medical advice of your own.
- If the doctor's text is empty or is not a prescription at all, return empty arrays and empty strings.
- spokenSummary must be simple everyday English a village patient can follow when heard aloud. Say how many times a day and for how many days for each medicine.`;

export async function parsePrescription(doctorText) {
  const text = (doctorText || '').trim();
  if (!text) throw new Error('Write or dictate the prescription first.');

  const raw = await callModel({
    system: PARSE_SYSTEM,
    prompt:
      'Extract this prescription into the required structure.\n\n' +
      `Doctor's text:\n${text}`,
    temperature: 0,
    schema: PRESCRIPTION_SCHEMA,
  });

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Could not read the prescription. Rephrase it and try again.');
  }
  return { ...parsed, rawText: text };
}

const LOCALIZE_SYSTEM = `You are making a doctor's prescription understandable for a rural patient who speaks a regional Indian language.

Absolute rules:
- Keep every drug name in English letters, unchanged. Do not translate brand or generic names, do not convert them to the target script, do not substitute a different drug. The patient will show this name to a pharmacist.
- Keep units of STRENGTH and MEASURE unchanged, in Latin letters: mg, g, mcg, ml, IU, drops. Example: "500 mg" stays "500 mg".
- Translate TIME and COUNT words into the target language. "day", "days", "week", "weeks", "month", "morning", "night", "before food", "after food", "once", "twice", "times" must all be written in the target language. "3 days" becomes "3 दिन" in Hindi. NEVER leave an English time word in the output.
- Translate the timing, duration, notes, advice, warning signs and follow-up into natural, warm, everyday language for that region.
- Use the target language's own script.
- warningSigns must be written as a clear, urgent instruction: what to watch for, and to go to a doctor or hospital right away. Never a flat or passive statement.
- spokenSummary must be rewritten as a short, calm, simple paragraph in the target language, under 60 words, with the drug names and strengths still in Latin letters. It must be safe and clear to read aloud on a phone speaker.
- Write each line as a clean phrase. Do not add a full stop at the end of short labels.`;

export async function localizePrescription(parsed, langCode) {
  if (langCode.startsWith('en')) {
    return { ...parsed, medicines: parsed.medicines, localized: true };
  }

  // Collect every string that is safe to translate, keyed by path, so a single
  // call can fill the whole record and we can map answers back reliably.
  const slots = [];
  const push = (key, value) => {
    if (value && value !== 'not specified') slots.push({ key, value });
  };

  push('spokenSummary', parsed.spokenSummary);
  push('complaint', parsed.complaint);
  push('followUp', parsed.followUp);
  (parsed.advice || []).forEach((a, i) => push(`advice.${i}`, a));
  (parsed.tests || []).forEach((t, i) => push(`tests.${i}`, t));
  (parsed.medicines || []).forEach((m, i) => {
    push(`medicines.${i}.timing`, m.timing);
    push(`medicines.${i}.duration`, m.duration);
    push(`medicines.${i}.notes`, m.notes);
  });

  const localised = {};
  if (slots.length) {
    const lines = slots.map((s, i) => `${i + 1}. ${s.value}`).join('\n');

    const out = await callModel({
      system: `${LOCALIZE_SYSTEM}

You are translating a numbered list. Reply with the same number of lines in the same order, formatted as "1. translation". Do not renumber, merge, split or drop any line.`,
      prompt: `Translate each numbered line into ${langCode}.\n\n${lines}`,
      temperature: 0.2,
    });

    const translated = parseNumbered(out);
    if (translated.length !== slots.length) {
      throw new Error('Could not translate the prescription. Check your internet connection.');
    }

    // Short label fields read badly with a trailing full stop or danda.
    const trimStop = (s) => (s ? s.replace(/[.\u0964]+$/, '').trim() : s);
    const get = (key) => trimStop(translated[slots.findIndex((s) => s.key === key)]);

    const setList = (src, prefix) =>
      (src || []).map((item, i) => get(`${prefix}.${i}`) ?? item);

    localised.complaint = get('complaint') ?? parsed.complaint;
    localised.followUp = get('followUp') ?? parsed.followUp;
    localised.spokenSummary = get('spokenSummary') ?? parsed.spokenSummary;
    localised.advice = setList(parsed.advice, 'advice');
    localised.tests = setList(parsed.tests, 'tests');
    localised.medicines = (parsed.medicines || []).map((m, i) => ({
      ...m, // name / dose / frequency stay untouched, always English
      timing: get(`medicines.${i}.timing`) ?? m.timing,
      duration: get(`medicines.${i}.duration`) ?? m.duration,
      notes: get(`medicines.${i}.notes`) ?? m.notes,
    }));
  }

  // Danger signs get their own call. Mixed into a batch they come out as flat
  // conditionals, which is the one thing a danger sign must never be.
  let warningSigns = parsed.warningSigns || [];
  if (warningSigns.length) {
    const lines = warningSigns.map((w, i) => `${i + 1}. ${w}`).join('\n');
    const out = await callModel({
      system: `You are writing the danger signs of a prescription for a rural patient, in ${langCode}.

Each input line is one medical danger sign. Rewrite EACH one as a single short, urgent sentence in ${langCode} that:
- begins with the condition, e.g. "अगर" in Hindi / "If" in English;
- ends by telling the patient to go to a doctor or hospital RIGHT NOW;
- never reads as a passive observation, a suggestion or a neutral note;
- keeps drug names, numbers and units of strength (mg, ml, IU) exactly as given, but translates time words such as day, week, month into ${langCode};
- is short enough to read aloud on a phone speaker.

Reply with the same number of lines in the same order, formatted as "1. sentence". Do not renumber, merge, split or add lines.`,
      prompt: lines,
      temperature: 0.3,
    });

    const parsedWarnings = parseNumbered(out);
    warningSigns =
      parsedWarnings.length === warningSigns.length
        ? parsedWarnings.map((w) => w.replace(/[.\u0964]+$/, '').trim())
        : warningSigns;
  }

  return {
    ...parsed,
    localized: true,
    ...localised,
    warningSigns,
    medicines: localised.medicines || parsed.medicines,
  };
}

function parseNumbered(text) {
  return text
    .split('\n')
    .map((line) => line.match(/^\s*(\d+)[.)]\s*(.+)$/))
    .filter(Boolean)
    .map((m) => ({ n: Number(m[1]), text: m[2].trim() }))
    .sort((a, b) => a.n - b.n)
    .map((x) => x.text);
}

/** Doctor's English view of the final record, for the printable copy. */
export function toPlainEnglish(parsed) {
  const out = [];
  if (parsed.complaint) out.push(`Complaint: ${parsed.complaint}`);
  if (parsed.medicines?.length) {
    out.push('', 'Medicines:');
    parsed.medicines.forEach((m, i) => {
      const parts = [
        `${i + 1}. ${m.name}`,
        m.dose !== 'not specified' ? m.dose : null,
        m.frequency !== 'not specified' ? m.frequency : null,
        m.timing !== 'not specified' ? m.timing : null,
        m.duration !== 'not specified' ? m.duration : null,
        m.notes || null,
      ].filter(Boolean);
      out.push(parts.join(' - '));
    });
  }
  if (parsed.tests?.length) out.push('', 'Tests advised:', ...parsed.tests.map((t) => `- ${t}`));
  if (parsed.advice?.length) out.push('', 'Advice:', ...parsed.advice.map((a) => `- ${a}`));
  if (parsed.warningSigns?.length) {
    out.push('', 'Return immediately if:', ...parsed.warningSigns.map((w) => `- ${w}`));
  }
  if (parsed.followUp) out.push('', `Follow-up: ${parsed.followUp}`);
  return out.join('\n');
}
