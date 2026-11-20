"use client";
// Browser speech helpers: Web Speech API for speech-to-text (SpeechRecognition) and
// text-to-speech (speechSynthesis). No audio is sent to this app's server — only the transcript.
// Note: in Chrome / Edge the browser's own recognition service processes the audio in the cloud.

export type Lang = "en" | "ar";
export const LOCALE: Record<Lang, string> = { en: "en-GB", ar: "ar-SA" };

type Rec = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
type RecCtor = new () => Rec;

function recCtor(): RecCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecCtor; webkitSpeechRecognition?: RecCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}
export const sttSupported = () => recCtor() != null;
export const ttsSupported = () => typeof window !== "undefined" && "speechSynthesis" in window;

/** Starts one push-to-talk recognition. Returns a stop function. */
export function listen(lang: Lang, h: { onInterim?: (t: string) => void; onFinal: (t: string) => void; onError?: (msg: string) => void; onEnd?: () => void }) {
  const C = recCtor();
  if (!C) {
    h.onError?.("Speech recognition is not supported in this browser — type the command instead.");
    h.onEnd?.();
    return () => {};
  }
  const r = new C();
  r.lang = LOCALE[lang];
  r.interimResults = true;
  r.continuous = false;
  r.maxAlternatives = 1;
  let final = "";
  r.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) final += res[0].transcript;
      else interim += res[0].transcript;
    }
    if (interim) h.onInterim?.(interim);
  };
  r.onerror = (e) => {
    const map: Record<string, string> = {
      "not-allowed": "Microphone permission was refused. Allow the microphone for this site, or type the command.",
      "no-speech": "I didn't hear anything. Tap the microphone and try again.",
      network: "The browser's speech service could not be reached. Type the command instead.",
      "audio-capture": "No microphone was found.",
    };
    if (e.error !== "aborted") h.onError?.(map[e.error] ?? `Speech recognition error: ${e.error}`);
  };
  r.onend = () => {
    if (final.trim()) h.onFinal(final.trim());
    h.onEnd?.();
  };
  try {
    r.start();
  } catch {
    h.onError?.("Could not start the microphone.");
    h.onEnd?.();
  }
  return () => {
    try {
      r.stop();
    } catch {
      /* already stopped */
    }
  };
}

function voiceFor(lang: Lang): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  return voices.find((v) => v.lang === LOCALE[lang]) ?? voices.find((v) => v.lang.toLowerCase().startsWith(lang)) ?? null;
}
/** True when the device has a voice for this language (Arabic voices are missing on some systems). */
export const hasVoice = (lang: Lang) => ttsSupported() && voiceFor(lang) != null;

export function speak(text: string, lang: Lang, onEnd?: () => void) {
  if (!ttsSupported()) return onEnd?.();
  const s = window.speechSynthesis;
  s.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = LOCALE[lang];
  const v = voiceFor(lang);
  if (v) u.voice = v;
  u.rate = lang === "ar" ? 0.95 : 1;
  u.onend = () => onEnd?.();
  u.onerror = () => onEnd?.();
  s.speak(u);
}
export const stopSpeaking = () => ttsSupported() && window.speechSynthesis.cancel();
