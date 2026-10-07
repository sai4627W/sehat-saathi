// ---------------------------------------------------------------------------
// translate.js - patient language <-> English, via the language model.
// ---------------------------------------------------------------------------

import { CONFIG } from './config.js';
import { callModel } from './ai.js';

const SYSTEM = `You are a medical translator working between a rural Indian patient and a doctor.

Rules:
- Translate meaning, not words. The patient may describe things in farming or household terms rather than medical terms. Work out the medical meaning and translate that accurately.
- Keep the speaker's intent, tone and level of politeness.
- Keep numbers, dosages, durations, ages and units exactly as given. Never convert or round them.
- Keep placeholder words like "doctor", "medicine", "tablet" natural for the target language.
- Use the target language's own script. Never transliterate into English letters.
- Output only the translation. No preamble, no notes, no quotation marks around it.
- If the source text is already in the target language, return it unchanged.`;

/**
 * Name the language instead of only quoting a BCP-47 tag. "hi-IN" alone is
 * ambiguous to the model for regional tags (ne-NP is Nepali, not Indian Nepali;
 * ur-IN is Urdu written in Perso-Arabic script), and a wrong guess shows up as
 * confidently wrong translation rather than an error. The code is still passed
 * along as a disambiguator.
 */
function langLabel(code) {
  if (code.startsWith('en')) return 'English';
  const known = CONFIG.languages.find((l) => l.code === code);
  return known ? `${known.nameEn} (BCP-47 "${code}")` : `the language with BCP-47 code "${code}"`;
}

/** Translate one string. */
export async function translateText(text, fromCode, toCode) {
  if (!text?.trim()) return '';
  if (fromCode === toCode) return text.trim();

  const out = await callModel({
    system: SYSTEM,
    prompt:
      `Translate from ${langLabel(fromCode)} to ${langLabel(toCode)}.\n\n` +
      `Text:\n${text.trim()}`,
    temperature: 0.2,
  });

  return out.replace(/^["']|["']$/g, '').trim();
}

/**
 * Translate an array of lines, preserving order and count so the UI can map
 * results back by index. One API call for the whole array.
 */
export async function translateLines(lines, fromCode, toCode) {
  const items = lines.map((l) => (l ?? '').trim()).filter(Boolean);
  if (!items.length) return [];
  if (fromCode === toCode) return items;

  const numbered = items.map((t, i) => `${i + 1}. ${t}`).join('\n');

  const out = await callModel({
    system: `${SYSTEM}

You are translating a numbered list. Reply with the same number of lines in the same order, formatted as "1. translation". Do not renumber, merge, split or drop any line. Do not add any line that is not in the input.`,
    prompt: `Translate each numbered line from ${langLabel(fromCode)} to ${langLabel(toCode)}.\n\n${numbered}`,
    temperature: 0.2,
  });

  const parsed = parseNumbered(out);
  // If the model dropped or mangled lines, fall back to one-by-one so the UI
  // never silently loses a dose or a warning.
  if (parsed.length !== items.length) {
    return Promise.all(items.map((t) => translateText(t, fromCode, toCode)));
  }
  return parsed;
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
