"use client";
// Voice assistant: push-to-talk → transcript → /api/voice → spoken reply. Writes need a spoken or
// tapped "yes" (except emergencies, which are sent at once). Server rules: src/lib/voice.ts
import clsx from "clsx";
import { Keyboard, Loader2, Mic, MicOff, Phone, Send, Volume2, VolumeX, X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { hasVoice, listen, speak, stopSpeaking, sttSupported, ttsSupported, type Lang } from "@/lib/speech";
import type { Role } from "@/lib/types";
import { Button } from "./ui";

type VoiceCall = { method?: "POST" | "PATCH"; path: string; body: unknown; label: string };
type VoiceResult = { lang: Lang; intent: string; reply: string; calls?: VoiceCall[]; confirm?: boolean; doneReply?: string; after?: "summary"; navigate?: string; emergency?: { number: string } };
type Turn = { who: "you" | "assistant"; text: string; lang: Lang };

const YES = /^\s*(yes|yeah|yep|yup|confirm|ok(ay)?|sure|do it|send( it)?|نعم|ايوه|ايوا|إيوه|اي|أي|اكيد|أكيد|تمام|موافق|اكد|أكد|ارسل|أرسل)\b/i;
const NO = /^\s*(no|nope|cancel|stop|don'?t|لا|كلا|الغاء|إلغاء|الغ|ألغ|توقف)/i;

const store = {
  get(k: string, d: string) {
    try {
      return localStorage.getItem(`ria.voice.${k}`) ?? d;
    } catch {
      return d;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(`ria.voice.${k}`, v);
    } catch {
      /* storage blocked — setting lasts for this page only */
    }
  },
};

const T = {
  en: { title: "Voice assistant", hint: 'Tap the microphone and speak. Say "what can I say" for commands.', listening: "Listening…", thinking: "Working…", yes: "Yes", no: "No", type: "Type a command", confirm: "Confirm?", cancelled: "Cancelled. Nothing was sent.", failed: "That didn't work:", speak: "Speak replies", announce: "Announce new critical alerts", privacy: "Speech is converted to text by your browser's speech service. Demo use only — real patient data needs an approved speech service.", noVoice: "This device has no voice for this language — replies are shown as text." },
  ar: { title: "المساعد الصوتي", hint: "اضغط على الميكروفون وتحدث. قل «ما الأوامر» لسماع الأوامر.", listening: "أستمع…", thinking: "جارٍ التنفيذ…", yes: "نعم", no: "لا", type: "اكتب أمرًا", confirm: "تأكيد؟", cancelled: "تم الإلغاء. لم يُرسل شيء.", failed: "تعذّر التنفيذ:", speak: "الرد بالصوت", announce: "إعلان التنبيهات الحرجة الجديدة صوتيًا", privacy: "يحوّل متصفحك الكلام إلى نص عبر خدمة الكلام الخاصة به. للعرض التجريبي فقط — البيانات الحقيقية تحتاج خدمة كلام معتمدة.", noVoice: "لا يوجد صوت عربي على هذا الجهاز — سيظهر الرد نصًّا." },
};

export function VoiceAssistant({ role }: { role: Role }) {
  const router = useRouter();
  const path = usePathname();
  const clinician = role === "DOCTOR" || role === "NURSE";
  const [open, setOpen] = useState(false);
  const [lang, setLangState] = useState<Lang>("en");
  const [speakOn, setSpeakOn] = useState(true);
  const [announce, setAnnounce] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [busy, setBusy] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, setPendingState] = useState<VoiceResult | null>(null);
  // Refs so callbacks fired by the speech engine (captured in an earlier render) see current values.
  const pendingRef = useRef<VoiceResult | null>(null);
  const setPending = (v: VoiceResult | null) => ((pendingRef.current = v), setPendingState(v));
  const langRef = useRef<Lang>("en");
  const [emergency, setEmergency] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef<() => void>(() => {});
  const viaVoice = useRef(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const nav = typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("ar") ? "ar" : "en";
    setLangState(store.get("lang", nav) === "ar" ? "ar" : "en");
    setSpeakOn(store.get("speak", "1") === "1");
    setAnnounce(store.get("announce", "0") === "1");
  }, []);
  useEffect(() => {
    // newer browsers return a Promise from scrollTo — must not leak out of the effect
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [turns, pending]);

  const setLang = (l: Lang) => ((langRef.current = l), setLangState(l), store.set("lang", l));
  langRef.current = lang;
  const tx = T[lang];
  const patientId = path?.match(/^\/patients\/([^/?#]+)/)?.[1] ?? null;

  const say = useCallback(
    (text: string, l: Lang, then?: () => void) => {
      setTurns((x) => [...x.slice(-11), { who: "assistant", text, lang: l }]);
      if (speakOn && ttsSupported()) speak(text, l, then);
      else then?.();
    },
    [speakOn],
  );

  const startListening = useCallback(
    (l: Lang = lang) => {
      if (!sttSupported()) {
        setError(T[l].hint);
        return;
      }
      stopSpeaking();
      setError(null);
      setInterim("");
      setListening(true);
      viaVoice.current = true;
      stopRef.current = listen(l, {
        onInterim: setInterim,
        onFinal: (text) => void handle(text),
        onError: setError,
        onEnd: () => (setListening(false), setInterim("")),
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lang],
  );

  async function run(r: VoiceResult) {
    setBusy(true);
    try {
      let last: unknown = null;
      for (const c of r.calls ?? []) last = await api(c.path, { method: c.method ?? "POST", body: c.body });
      if (r.after === "summary") {
        const doc = (last as { doc?: { headline: string; sections: { title: string; items: string[] }[] } })?.doc;
        const text = doc ? [doc.headline, ...doc.sections.slice(0, 4).map((s) => `${s.title}: ${s.items.slice(0, 2).join("; ")}`)].join(". ") : "Summary created.";
        say(text, "en");
      } else if (r.doneReply) say(r.doneReply, r.lang);
    } catch (e) {
      say(`${T[r.lang].failed} ${e instanceof Error ? e.message : String(e)}`, r.lang);
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  async function handle(text: string) {
    const t = text.trim();
    if (!t) return;
    const lang = langRef.current;
    const pending = pendingRef.current;
    setTurns((x) => [...x.slice(-11), { who: "you", text: t, lang }]);
    if (pending) {
      if (YES.test(t)) return run(pending);
      if (NO.test(t)) {
        setPending(null);
        return say(T[pending.lang].cancelled, pending.lang);
      }
      setPending(null); // anything else is a new command
    }
    setBusy(true);
    try {
      const r = await api<VoiceResult>("/api/voice", { body: { text: t, lang, patientId } });
      if (r.emergency) setEmergency(r.emergency.number);
      if (r.calls?.length && r.confirm === false) {
        say(r.reply, r.lang);
        await run(r);
      } else if (r.calls?.length) {
        setPending(r);
        say(r.reply, r.lang, () => {
          if (viaVoice.current && sttSupported()) startListening(r.lang);
        });
      } else {
        say(r.reply, r.lang);
      }
      if (r.navigate) router.push(r.navigate);
    } catch (e) {
      say(`${T[lang].failed} ${e instanceof Error ? e.message : String(e)}`, lang);
    } finally {
      setBusy(false);
    }
  }

  // Spoken announcements of new critical alerts (raised by AppShell's alert poller).
  useEffect(() => {
    if (!clinician || !announce) return;
    const onAlerts = (e: Event) => {
      const list = (e as CustomEvent<{ title: string; patient: string; severity: string }[]>).detail.filter((a) => a.severity === "CRITICAL");
      if (list.length && ttsSupported() && !listening) speak(list.map((a) => `Critical alert. ${a.patient}. ${a.title}.`).join(" "), "en");
    };
    window.addEventListener("ria:new-alerts", onAlerts);
    return () => window.removeEventListener("ria:new-alerts", onAlerts);
  }, [clinician, announce, listening]);

  if (role === "ADMIN") return null;
  const rtl = lang === "ar";

  return (
    <>
      {!open && (
        <button type="button" onClick={() => setOpen(true)} aria-label="Open voice assistant" className="fixed bottom-4 right-4 z-50 flex size-14 items-center justify-center rounded-full bg-primary text-white shadow-2xl hover:brightness-110 dark:text-[#06131f]">
          <Mic className="size-6" />
        </button>
      )}
      {open && (
        <section aria-label={tx.title} dir={rtl ? "rtl" : "ltr"} className="fixed bottom-4 right-4 z-50 flex max-h-[min(80vh,640px)] w-[min(94vw,400px)] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl">
          <header className="flex items-center gap-2 border-b border-line px-4 py-3">
            <Mic className="size-4 text-primary" aria-hidden />
            <h2 className="flex-1 text-sm font-semibold text-ink">{tx.title}</h2>
            <div className="flex overflow-hidden rounded-lg border border-line text-xs font-semibold" role="group" aria-label="Language">
              {(["en", "ar"] as Lang[]).map((l) => (
                <button key={l} type="button" aria-pressed={lang === l} onClick={() => setLang(l)} className={clsx("px-2 py-1", lang === l ? "bg-primary text-white dark:text-[#06131f]" : "text-muted hover:bg-surface-2")}>
                  {l === "en" ? "EN" : "عربي"}
                </button>
              ))}
            </div>
            <button type="button" onClick={() => (stopRef.current(), stopSpeaking(), setOpen(false))} aria-label="Close voice assistant" className="rounded-lg p-1 text-muted hover:bg-surface-2">
              <X className="size-4" />
            </button>
          </header>

          <div ref={logRef} className="min-h-28 flex-1 space-y-2 overflow-y-auto px-4 py-3" aria-live="polite">
            {turns.length === 0 && <p className="text-[13px] leading-relaxed text-muted">{tx.hint}</p>}
            {turns.map((m, i) => (
              <p key={i} dir={m.lang === "ar" ? "rtl" : "ltr"} className={clsx("max-w-[90%] rounded-xl px-3 py-2 text-[13px] leading-relaxed", m.who === "you" ? "ms-auto bg-primary-soft text-ink" : "bg-surface-2 text-ink")}>
                {m.text}
              </p>
            ))}
            {listening && <p className="text-[13px] italic text-muted">{interim || tx.listening}</p>}
            {busy && (
              <p className="flex items-center gap-1.5 text-xs text-muted">
                <Loader2 className="size-3.5 animate-spin" /> {tx.thinking}
              </p>
            )}
          </div>

          {emergency && (
            <div className="mx-4 mb-2 flex items-center gap-2 rounded-xl border-2 border-crit bg-crit-soft px-3 py-2">
              <a href={`tel:${emergency}`} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-crit px-3 text-sm font-semibold text-white dark:text-[#06131f]">
                <Phone className="size-4" /> {lang === "ar" ? `اتصل ${emergency}` : `Call ${emergency}`}
              </a>
              <button type="button" onClick={() => setEmergency(null)} className="ms-auto text-xs text-muted" aria-label="Hide">
                <X className="size-3.5" />
              </button>
            </div>
          )}

          {pending && (
            <div className="mx-4 mb-2 rounded-xl border border-warn/40 bg-warn-soft px-3 py-2">
              <p className="text-xs font-semibold text-warn">{T[pending.lang].confirm}</p>
              <div className="mt-1.5 flex gap-2">
                <Button size="sm" variant="primary" disabled={busy} onClick={() => (setTurns((x) => [...x, { who: "you", text: T[pending.lang].yes, lang: pending.lang }]), void run(pending))}>
                  {T[pending.lang].yes}
                </Button>
                <Button size="sm" disabled={busy} onClick={() => (setPending(null), say(T[pending.lang].cancelled, pending.lang))}>
                  {T[pending.lang].no}
                </Button>
              </div>
            </div>
          )}

          <div className="space-y-2 border-t border-line px-4 py-3">
            {error && <p className="text-xs text-crit">{error}</p>}
            {speakOn && lang === "ar" && ttsSupported() && !hasVoice("ar") && <p className="text-[11px] text-muted">{tx.noVoice}</p>}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => (listening ? stopRef.current() : startListening())}
                disabled={busy}
                aria-label={listening ? "Stop listening" : "Start listening"}
                className={clsx("flex size-12 shrink-0 items-center justify-center rounded-full text-white dark:text-[#06131f]", listening ? "animate-pulse bg-crit" : "bg-primary hover:brightness-110", busy && "opacity-60")}
              >
                {listening ? <MicOff className="size-5" /> : <Mic className="size-5" />}
              </button>
              <form
                className="flex min-w-0 flex-1 items-center gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  viaVoice.current = false;
                  const v = typed;
                  setTyped("");
                  void handle(v);
                }}
              >
                <Keyboard className="size-4 shrink-0 text-muted" aria-hidden />
                <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={tx.type} aria-label={tx.type} dir="auto" className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2.5 text-sm text-ink outline-none focus:border-primary" />
                <Button size="sm" type="submit" disabled={!typed.trim() || busy} aria-label="Send">
                  <Send className="size-3.5" />
                </Button>
              </form>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
              <label className="inline-flex cursor-pointer items-center gap-1.5">
                <input type="checkbox" checked={speakOn} onChange={(e) => (setSpeakOn(e.target.checked), store.set("speak", e.target.checked ? "1" : "0"), !e.target.checked && stopSpeaking())} />
                {speakOn ? <Volume2 className="size-3.5" /> : <VolumeX className="size-3.5" />} {tx.speak}
              </label>
              {clinician && (
                <label className="inline-flex cursor-pointer items-center gap-1.5">
                  <input type="checkbox" checked={announce} onChange={(e) => (setAnnounce(e.target.checked), store.set("announce", e.target.checked ? "1" : "0"))} />
                  {tx.announce}
                </label>
              )}
            </div>
            <p className="text-[10px] leading-snug text-muted">{tx.privacy}</p>
          </div>
        </section>
      )}
    </>
  );
}
