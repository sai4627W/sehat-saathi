// ---------------------------------------------------------------------------
// CONFIG - edit this file only. Never commit a real key.
// ---------------------------------------------------------------------------

// Option A (safest): leave GROQ_KEY empty and set apiBase to your proxy.
// Option B (quick prototype, NOT safe): paste your key here. It will be visible
// in browser devtools to anyone using the site. Fine for a demo on localhost,
// not fine for a public link.
export const GROQ_KEY = '';

export const CONFIG = {
  // If your server.js proxy is running (npm start), use "/api".
  // If you have no server, set this to "" and put your key above.
  apiBase: '/api',

  // Only used in the no-proxy mode above. The server picks the model itself
  // from GROQ_CHAT_MODEL when the proxy is in use.
  model: 'openai/gpt-oss-120b',

  // Languages offered in the picker. `stt` is what the browser listens with,
  // `tts` is what it speaks with. `en` means English.
  languages: [
    { code: 'hi-IN', name: 'हिंदी',      nameEn: 'Hindi',     stt: true,  tts: true },
    { code: 'bn-IN', name: 'বাংলা',       nameEn: 'Bengali',   stt: true,  tts: false },
    { code: 'ta-IN', name: 'தமிழ்',       nameEn: 'Tamil',     stt: true,  tts: false },
    { code: 'te-IN', name: 'తెలుగు',       nameEn: 'Telugu',    stt: true,  tts: false },
    { code: 'mr-IN', name: 'मराठी',       nameEn: 'Marathi',   stt: true,  tts: false },
    { code: 'gu-IN', name: 'ગુજરાતী',     nameEn: 'Gujarati',  stt: true,  tts: false },
    { code: 'kn-IN', name: 'ಕನ್ನಡ',      nameEn: 'Kannada',   stt: true,  tts: false },
    { code: 'ml-IN', name: 'മലയാളം',     nameEn: 'Malayalam', stt: true,  tts: false },
    { code: 'pa-IN', name: 'ਪੰਜਾਬੀ',     nameEn: 'Punjabi',   stt: true,  tts: false },
    { code: 'or-IN', name: 'ଓଡ଼ିଆ',       nameEn: 'Odia',      stt: true,  tts: false },
    { code: 'ur-IN', name: 'اردو',        nameEn: 'Urdu',      stt: true,  tts: false },
    { code: 'ne-NP', name: 'नेपाली',       nameEn: 'Nepali',    stt: true,  tts: false },
    { code: 'en-IN', name: 'English',      nameEn: 'English',   stt: true,  tts: true },
  ],
};
