// Voice commands (server side). Speech-to-text and text-to-speech run in the browser; this module
// turns a transcript (English or Arabic) into an answer and, for anything that changes data, a list
// of calls to the EXISTING permission-checked endpoints. Design notes: docs/VOICE.md
//
// Rules:
//   • Deterministic matching — no language model decides what gets written.
//   • Anything that writes data needs a spoken / tapped "yes" first, EXCEPT emergencies: red-flag
//     symptoms and "urgent help" are sent at once and the emergency number is spoken immediately.
//   • Clinicians cannot dispatch an ambulance by voice; the command opens the transfer form.
//   • Every write goes through the normal API route, so permissions and audit are unchanged.
import { prisma } from "./db";
import { HttpError, type SessionUser } from "./auth";
import { patientScope } from "./permissions";
import { detectRedFlags } from "./triage";
import { EMERGENCY_NUMBER } from "./transfers";
import { patientView, wardView } from "./views";
import { RED_FLAGS, VITALS, formatVital, type LatestMap, type VitalType } from "./types";

export type Lang = "en" | "ar";
export type VoiceCall = { method?: "POST" | "PATCH"; path: string; body: unknown; label: string };
export type VoiceResult = {
  lang: Lang;
  intent: string;
  reply: string;
  /** Writes, through existing endpoints. */
  calls?: VoiceCall[];
  /** true → ask "yes / no" before running `calls`; false → run immediately (emergencies only). */
  confirm?: boolean;
  /** What to say after the calls succeed. "summary" = read the returned AI summary. */
  doneReply?: string;
  after?: "summary";
  navigate?: string;
  emergency?: { number: string };
};

// ------------------------------------------------------------------ text helpers
const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
/** Lower-case, Arabic letter variants unified, diacritics removed, Arabic digits → ASCII. */
export function normalize(text: string) {
  return text
    .toLowerCase()
    .replace(/[ً-ْـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)))
    .replace(/٫/g, ".")
    .replace(/[،؛؟]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
export const detectLang = (text: string): Lang => (/[؀-ۿ]/.test(text) ? "ar" : "en");
const t = (lang: Lang, en: string, ar: string) => (lang === "ar" ? ar : en);
const numbers = (s: string) => [...s.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));

function lev(a: string, b: string) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
/** Does any word in `text` match `name` (exact, or one edit away for words of 4+ letters)? */
function mentions(text: string, name: string) {
  const words = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return normalize(name)
    .split(/\s+/)
    .filter((n) => n.length >= 3)
    .some((n) => words.some((w) => w === n || (n.length >= 4 && w.length >= 4 && lev(w, n) <= 1)));
}

function ago(iso: string | Date | null | undefined, lang: Lang) {
  if (!iso) return t(lang, "never", "لم تُسجَّل");
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return t(lang, "just now", "قبل لحظات");
  const m = Math.round(s / 60);
  if (m < 60) return t(lang, `${m} minute${m > 1 ? "s" : ""} ago`, `قبل ${m} ${m === 1 ? "دقيقة" : m === 2 ? "دقيقتين" : m <= 10 ? "دقائق" : "دقيقة"}`);
  const h = Math.round(m / 60);
  return t(lang, `${h} hour${h > 1 ? "s" : ""} ago`, `قبل ${h} ${h === 1 ? "ساعة" : h === 2 ? "ساعتين" : h <= 10 ? "ساعات" : "ساعة"}`);
}

// ------------------------------------------------------------------ vitals vocabulary
const VITAL_WORDS: Record<VitalType, RegExp> = {
  BP: /blood pressure|\bbp\b|ضغط/,
  HR: /heart ?rate|pulse|heart ?beat|نبض|دقات/,
  SPO2: /oxygen|saturation|spo2|\bsats?\b|اكسجين|تشبع/,
  TEMP: /temperature|\btemp\b|fever|حراره|حرارت/,
  RR: /breathing rate|respiratory rate|breaths per minute|معدل التنفس|سرعه التنفس/,
  GLUCOSE: /sugar|glucose|سكر/,
  WEIGHT: /weight|\bweigh\b|وزن/,
};
const VITAL_AR: Record<VitalType, { name: string; unit: string }> = {
  HR: { name: "نبض القلب", unit: "نبضة في الدقيقة" },
  SPO2: { name: "نسبة الأكسجين", unit: "بالمئة" },
  BP: { name: "ضغط الدم", unit: "ملم زئبق" },
  TEMP: { name: "الحرارة", unit: "درجة مئوية" },
  RR: { name: "معدل التنفس", unit: "نفَس في الدقيقة" },
  GLUCOSE: { name: "السكر", unit: "ملغ لكل ديسيلتر" },
  WEIGHT: { name: "الوزن", unit: "كيلوغرام" },
};
const UNIT_EN: Record<VitalType, string> = { HR: "beats per minute", SPO2: "percent", BP: "", TEMP: "degrees", RR: "breaths per minute", GLUCOSE: "milligrams per decilitre", WEIGHT: "kilograms" };
const SOURCE_AR: Record<string, string> = { SIMULATED_DEVICE: "جهاز محاكاة", PATIENT_REPORTED: "سجّلها المريض", CAREGIVER_REPORTED: "سجّلها المرافق", CLINICIAN_ENTERED: "سجّلها الفريق الطبي", WEARABLE_SYNC: "الساعة الذكية", WEARABLE_DEMO: "مزامنة تجريبية" };
const SOURCE_EN: Record<string, string> = { SIMULATED_DEVICE: "simulated device", PATIENT_REPORTED: "patient-reported", CAREGIVER_REPORTED: "caregiver-reported", CLINICIAN_ENTERED: "entered by the care team", WEARABLE_SYNC: "smartwatch", WEARABLE_DEMO: "demo smartwatch sync" };

function sayVital(type: VitalType, l: NonNullable<LatestMap[VitalType]>, lang: Lang, withSource = true) {
  const value = type === "BP" ? (lang === "ar" ? `${Math.round(l.v)} على ${Math.round(l.v2 ?? 0)}` : `${Math.round(l.v)} over ${Math.round(l.v2 ?? 0)}`) : formatVital(type, l.v, l.v2);
  const src = withSource ? (lang === "ar" ? `، ${SOURCE_AR[l.src] ?? l.src}` : `, ${SOURCE_EN[l.src] ?? l.src}`) : "";
  return lang === "ar" ? `${VITAL_AR[type].name} ${value} ${VITAL_AR[type].unit}، ${ago(l.t, lang)}${src}` : `${VITALS[type].label} ${value}${UNIT_EN[type] ? ` ${UNIT_EN[type]}` : " millimetres of mercury"}, ${ago(l.t, lang)}${src}`;
}

// ------------------------------------------------------------------ shared intents
const YES_HELP = /what can (i|you) (say|do)|voice commands|list (of )?commands|ماذا (يمكنني ان )?اقول|ماذا تستطيع|الاوامر|ما الاوامر/;
const URGENT = /urgent help|help me|i need help|emergency|call (an |the )?ambulance|need an ambulance|ساعدني|ساعدوني|النجده|نجده|طوارئ|حاله طارئه|اسعاف|احتاج مساعده/;
const AMBULANCE_STATUS = /where is the ambulance|when will (the )?ambulance|ambulance status|how long|اين الاسعاف|متي يصل|متي توصل|وين الاسعاف|حاله الاسعاف/;

function commandsHelp(lang: Lang, clinician: boolean) {
  if (clinician)
    return t(
      lang,
      'Try: "read the alerts", "who needs attention", "how is Samuel Okoro", "summarise Samuel", "acknowledge alerts for Samuel", "open Layla Haddad", or "ambulance for Samuel" to open the transfer form.',
      "جرّب: «اقرأ التنبيهات»، «من يحتاج متابعة»، «كيف حال صامويل»، «لخّص حالة صامويل»، «أقرّ تنبيهات صامويل»، «افتح ليلى حداد»، أو «إسعاف لصامويل» لفتح نموذج النقل.",
    );
  return t(
    lang,
    'Try: "what are my readings", "I took my paracetamol", "when is my next check-in", "I feel more breathless", "read my messages", "tell my nurse I slept badly", "I want a video call", or "urgent help".',
    "جرّب: «ما قراءاتي»، «أخذت دواء الباراسيتامول»، «متى موعد القياس القادم»، «أشعر بضيق في التنفس»، «اقرأ رسائلي»، «قل للممرضة إنني لم أنم جيدًا»، «أريد مكالمة فيديو»، أو «مساعدة عاجلة».",
  );
}

// ------------------------------------------------------------------ entry point
export async function interpretVoice(user: SessionUser, transcript: string, opts: { patientId?: string | null; lang?: Lang } = {}): Promise<VoiceResult> {
  const raw = transcript.trim().slice(0, 500);
  if (!raw) throw new HttpError(400, "Empty voice command");
  const lang: Lang = /[\u0600-\u06FF]/.test(raw) ? "ar" : /\p{L}/u.test(raw) ? "en" : (opts.lang ?? "en");
  const text = normalize(raw);
  const clinician = user.role === "DOCTOR" || user.role === "NURSE";
  if (user.role === "ADMIN") return { lang, intent: "UNSUPPORTED", reply: t(lang, "Voice commands are available to the care team, patients and caregivers.", "الأوامر الصوتية متاحة لفريق الرعاية والمرضى والمرافقين.") };
  if (YES_HELP.test(text)) return { lang, intent: "HELP", reply: commandsHelp(lang, clinician) };
  return clinician ? clinicianIntent(user, raw, text, lang, opts.patientId ?? null) : patientIntent(user, raw, text, lang);
}

// ------------------------------------------------------------------ patients & caregivers
async function patientIntent(user: SessionUser, raw: string, text: string, lang: Lang): Promise<VoiceResult> {
  const pid = user.patientId;
  if (!pid || !patientScope(user, pid)) throw new HttpError(403, "No linked patient record");
  const base = `/api/patients/${pid}`;
  const v = (await patientView(user, pid, patientScope(user, pid)!, 15)) as unknown as PatientV;
  const call = (n: string) => t(lang, `If this is life-threatening, call ${n} now.`, `إذا كانت الحالة تهدد الحياة اتصل الآن بالرقم ${n}.`);

  // 1. Emergencies first — sent immediately, number spoken immediately.
  const flags = detectRedFlags(text);
  if (flags.length) {
    return {
      lang,
      intent: "RED_FLAG",
      reply: t(lang, `This could be an emergency. Call ${EMERGENCY_NUMBER} now. I am alerting your care team.`, `قد تكون هذه حالة طارئة. اتصل الآن بالرقم ${EMERGENCY_NUMBER}. أنا أنبّه فريق الرعاية الآن.`),
      calls: [{ path: `${base}/symptoms`, body: { text: raw, severity: "SEVERE", redFlags: flags }, label: RED_FLAGS[flags[0]].label }],
      confirm: false,
      doneReply: t(lang, `Your care team has been alerted. ${RED_FLAGS[flags[0]].advice} Call ${EMERGENCY_NUMBER} if you have not already.`, `تم تنبيه فريق الرعاية. لا تنتظر اتصالهم، واتصل بالرقم ${EMERGENCY_NUMBER} إن لم تفعل بعد.`),
      emergency: { number: EMERGENCY_NUMBER },
    };
  }
  if (v.transfer?.open && AMBULANCE_STATUS.test(text)) {
    const eta = v.transfer.etaAt ? Math.max(0, Math.round((new Date(v.transfer.etaAt).getTime() - Date.now()) / 1000)) : null;
    const etaTxt = eta == null ? "" : eta >= 60 ? t(lang, ` in about ${Math.round(eta / 60)} minutes`, ` خلال حوالي ${Math.round(eta / 60)} دقيقة`) : t(lang, " in less than a minute", " خلال أقل من دقيقة");
    return { lang, intent: "TRANSFER_STATUS", reply: t(lang, `${v.transfer.statusLabel}${etaTxt}. Destination: ${v.transfer.destination}. ${call(EMERGENCY_NUMBER)}`, `حالة الإسعاف: ${v.transfer.statusLabel}${etaTxt}. الوجهة: ${v.transfer.destination}. ${call(EMERGENCY_NUMBER)}`) };
  }
  if (URGENT.test(text)) {
    return {
      lang,
      intent: "URGENT_HELP",
      reply: t(lang, `Alerting your care team now. ${call(EMERGENCY_NUMBER)}`, `أنبّه فريق الرعاية الآن. ${call(EMERGENCY_NUMBER)}`),
      calls: [{ path: `${base}/urgent-help`, body: {}, label: "Urgent help" }],
      confirm: false,
      doneReply: t(lang, `Your care team has been alerted and will contact you. Keep your phone close. ${call(EMERGENCY_NUMBER)}`, `تم تنبيه فريق الرعاية وسيتواصلون معك. أبقِ هاتفك قريبًا. ${call(EMERGENCY_NUMBER)}`),
      emergency: { number: EMERGENCY_NUMBER },
    };
  }
  if (/^(help|مساعده)$/.test(text))
    return { lang, intent: "CLARIFY", reply: t(lang, `Do you need urgent help? Say "urgent help" to alert your care team. ${call(EMERGENCY_NUMBER)} Say "what can I say" for the list of commands.`, `هل تحتاج مساعدة عاجلة؟ قل «مساعدة عاجلة» لتنبيه فريق الرعاية. ${call(EMERGENCY_NUMBER)} وقل «ما الأوامر» لسماع قائمة الأوامر.`) };

  // 2. Recording a reading: vital word + number(s)
  const nums = numbers(text);
  const vital = (Object.keys(VITAL_WORDS) as VitalType[]).find((k) => VITAL_WORDS[k].test(text));
  if (vital && nums.length && !/\?|what|how much|كم|ما هو|ما هي/.test(text)) {
    if (!v.patient.manualEntry)
      return {
        lang,
        intent: "AUTO_DEVICES",
        reply: t(lang, "Your devices send your readings to the care team automatically, so you don't need to tell me the numbers. If a device isn't working, say \"tell my nurse the device isn't working\".", "أجهزتك ترسل قراءاتك إلى فريق الرعاية تلقائيًا، فلا حاجة لأن تخبرني بالأرقام. إذا كان أحد الأجهزة لا يعمل قل: «قل للممرضة إن الجهاز لا يعمل»."),
      };
    let value = nums[0];
    let value2: number | undefined;
    let note = "";
    if (vital === "BP") {
      if (nums.length < 2) return { lang, intent: "CLARIFY", reply: t(lang, 'Please say both numbers, for example "my blood pressure is 128 over 82".', "من فضلك قل الرقمين، مثلًا: «ضغطي 128 على 82».") };
      value2 = nums[1];
    }
    if (vital === "GLUCOSE" && value < 35) {
      note = t(lang, ` (${value} millimoles per litre)`, ` (${value} ملي مول لكل لتر)`);
      value = Math.round(value * 18.016);
    }
    if (vital === "TEMP" && value > 45) {
      note = t(lang, ` (${value} Fahrenheit)`, ` (${value} فهرنهايت)`);
      value = Math.round(((value - 32) * 5) / 9 * 10) / 10;
    }
    const spoken = sayVital(vital, { v: value, v2: value2 ?? null, t: new Date().toISOString(), src: "" }, lang, false).replace(/[،,]\s*(just now|قبل لحظات)$/, "");
    return {
      lang,
      intent: "RECORD_READING",
      reply: t(lang, `I'll send ${spoken}${note} to your care team. Say yes to confirm or no to cancel.`, `سأرسل ${spoken}${note} إلى فريق الرعاية. قل «نعم» للتأكيد أو «لا» للإلغاء.`),
      calls: [{ path: `${base}/readings`, body: { readings: [{ type: vital, value, ...(value2 != null ? { value2 } : {}) }], comment: `Voice entry: "${raw}"` }, label: VITALS[vital].label }],
      confirm: true,
      doneReply: t(lang, "Sent. Your care team can see it now.", "تم الإرسال. يستطيع فريق الرعاية رؤيتها الآن."),
    };
  }

  // 3. Asking for readings
  const latest = v.latest ?? {};
  if (vital || /reading|vitals|numbers|قراءات|قياسات|قراءاتي|قياساتي/.test(text)) {
    const types = vital ? [vital] : (Object.keys(VITALS) as VitalType[]).filter((k) => latest[k]);
    const parts = types.filter((k) => latest[k]).map((k) => sayVital(k, latest[k]!, lang));
    if (!parts.length) return { lang, intent: "READINGS", reply: t(lang, "There is no reading of that on record yet.", "لا توجد قراءة مسجلة لذلك حتى الآن.") };
    const stale = v.connectivity === "DISCONNECTED" ? t(lang, " Your device is not sending data, so these may not be current.", " جهازك لا يرسل بيانات حاليًا، لذلك قد لا تكون هذه القيم حالية.") : "";
    return { lang, intent: "READINGS", reply: parts.join(lang === "ar" ? ". " : ". ") + "." + stale };
  }

  // 4. Medicines
  if (/took|taken|have had my|اخذت|تناولت|شربت/.test(text) && v.medications?.length) {
    const meds = v.medications;
    const named = meds.filter((m) => mentions(text, m.name));
    const pick = named.length === 1 ? named[0] : meds.length === 1 && /medicine|medication|pill|tablet|دواء|الدواء|دوائي|حبه|علاج/.test(text) ? meds[0] : null;
    if (!pick) return { lang, intent: "CLARIFY", reply: t(lang, `Which medicine? ${meds.map((m) => m.name).join(", ")}.`, `أي دواء؟ ${meds.map((m) => m.name).join("، ")}.`) };
    return {
      lang,
      intent: "MED_TAKEN",
      reply: t(lang, `Record ${pick.name} ${pick.dose} as taken now? Say yes or no.`, `هل أسجّل ${pick.name} ${pick.dose} كمأخوذ الآن؟ قل «نعم» أو «لا».`),
      calls: [{ path: `${base}/medlog`, body: { medicationId: pick.id }, label: pick.name }],
      confirm: true,
      doneReply: t(lang, "Recorded.", "تم التسجيل."),
    };
  }

  // 5. Check-in time
  if (/check ?in|next (reading|measurement)|موعد|القياس القادم/.test(text)) {
    const p = v.patient;
    if (!p.nextCheckInDueAt) return { lang, intent: "CHECKIN", reply: t(lang, "You have no scheduled check-in right now.", "ليس لديك موعد قياس مجدول حاليًا.") };
    const due = new Date(p.nextCheckInDueAt);
    const time = due.toLocaleTimeString(lang === "ar" ? "ar" : "en-GB", { hour: "2-digit", minute: "2-digit" });
    return { lang, intent: "CHECKIN", reply: p.checkInOverdue ? t(lang, `Your scheduled measurement was due at ${time}. Please use your device now — the reading is sent automatically.`, `كان موعد القياس الساعة ${time} وقد تأخر. استخدم جهازك الآن، وستُرسل القراءة تلقائيًا.`) : t(lang, `Your next scheduled measurement is at ${time}.`, `موعد القياس القادم الساعة ${time}.`) };
  }

  // 6. Messages
  const sendEn = raw.match(/(?:send|tell)(?:\s+a)?\s+(?:message\s+)?(?:to\s+)?(?:my\s+|the\s+)?(?:nurse|doctor|care team|team)?\s*(?:saying|that|:)?\s+(.{3,})/i);
  const sendAr = normalize(raw).match(/(?:^|\s)(?:ارسل|ابعث|بلغ|قل|قولي|اخبر)\s+(?:رساله\s+)?(?:لل?(?:ممرضه|ممرض|طبيب|طبيبه|دكتور|دكتوره|فريق)\s+)?(?:ان|بان|انني|اني)?\s*(.{3,})/);
  if ((/send|tell/.test(text) && sendEn) || sendAr) {
    const msg = (sendEn?.[1] ?? sendAr?.[1] ?? "").trim();
    return {
      lang,
      intent: "SEND_MESSAGE",
      reply: t(lang, `Send this message to your care team: "${msg}"? Say yes or no.`, `هل أرسل هذه الرسالة إلى فريق الرعاية: «${msg}»؟ قل «نعم» أو «لا».`),
      calls: [{ path: `${base}/messages`, body: { body: `${msg} (voice message)` }, label: "Message" }],
      confirm: true,
      doneReply: t(lang, "Message sent.", "تم إرسال الرسالة."),
    };
  }
  if (/message|رسال/.test(text)) {
    const last = [...(v.messages ?? [])].reverse().find((m) => m.senderId !== user.id);
    return { lang, intent: "READ_MESSAGES", reply: last ? t(lang, `Last message from ${last.senderName}, ${ago(last.createdAt, lang)}: ${last.body}`, `آخر رسالة من ${last.senderName}، ${ago(last.createdAt, lang)}: ${last.body}`) : t(lang, "You have no messages from the care team.", "لا توجد رسائل من فريق الرعاية.") };
  }

  // 7. Video consultation
  if (/video|consultation|call me|speak (to|with)|talk to|مكالمه|فيديو|استشاره|اتصلوا بي|اتصل بي|كلموني/.test(text)) {
    return {
      lang,
      intent: "CONSULT",
      reply: t(lang, "Ask your care team for a video call? Say yes or no.", "هل أطلب مكالمة فيديو مع فريق الرعاية؟ قل «نعم» أو «لا».") ,
      calls: [{ path: `${base}/consult`, body: { status: "REQUESTED", reason: `Voice request: "${raw}"` }, label: "Video call request" }],
      confirm: true,
      doneReply: t(lang, "Requested. The care team will start the call from their side.", "تم الطلب. سيبدأ فريق الرعاية المكالمة من جهتهم."),
    };
  }

  // 8. How am I doing
  if (/how am i|my status|how is (he|she)|حالتي|كيف حالتي|كيف حاله|كيف وضعي/.test(text)) {
    const msg: Record<string, [string, string]> = {
      STABLE: ["Your latest readings are inside the limits your care team set.", "قراءاتك الأخيرة ضمن الحدود التي حددها فريق الرعاية."],
      NEEDS_REVIEW: ["Your care team is reviewing your readings and will contact you if anything is needed.", "فريق الرعاية يراجع قراءاتك وسيتواصل معك إذا لزم الأمر."],
      CRITICAL: [`Your care team has an urgent alert about your readings and will contact you. ${call(EMERGENCY_NUMBER)}`, `لدى فريق الرعاية تنبيه عاجل بخصوص قراءاتك وسيتواصلون معك. ${call(EMERGENCY_NUMBER)}`],
      NO_RECENT_DATA: ["Your care team is not receiving current readings. Please check your device or send your readings.", "فريق الرعاية لا يستقبل قراءات حالية. تحقق من جهازك أو أرسل قراءاتك."],
      DEVICE_DISCONNECTED: ["Your device is not sending data. Please check it is switched on and charged.", "جهازك لا يرسل بيانات. تأكد أنه يعمل ومشحون."],
      AWAITING_ASSESSMENT: ["Your doctor will complete your admission assessment soon.", "سيكمل طبيبك تقييم الدخول قريبًا."],
    };
    const [en, ar] = msg[v.state] ?? msg.NEEDS_REVIEW;
    return { lang, intent: "STATUS", reply: t(lang, en, ar) };
  }

  // 9. Anything describing how they feel → symptom report (confirmed)
  if (/i feel|i have|i am|i'm|feeling|hurts|pain|dizzy|nause|cough|tired|swollen|اشعر|احس|عندي|اعاني|الم|وجع|دوخه|سعال|كحه|تعب|ضيق|انتفاخ|غثيان/.test(text)) {
    const severity = /severe|very bad|really bad|شديد|قوي|كثير/.test(text) ? "SEVERE" : /mild|slight|a little|خفيف|بسيط|قليل/.test(text) ? "MILD" : "MODERATE";
    return {
      lang,
      intent: "SYMPTOM",
      reply: t(lang, `Tell your care team: "${raw}" (${severity.toLowerCase()})? Say yes or no.`, `هل أبلّغ فريق الرعاية: «${raw}»؟ قل «نعم» أو «لا».`),
      calls: [{ path: `${base}/symptoms`, body: { text: raw, severity }, label: "Symptom" }],
      confirm: true,
      doneReply: t(lang, `Your care team has received this and will review it. ${call(EMERGENCY_NUMBER)}`, `وصل البلاغ لفريق الرعاية وسيراجعونه. ${call(EMERGENCY_NUMBER)}`),
    };
  }

  return { lang, intent: "UNKNOWN", reply: t(lang, `Sorry, I didn't understand. Say "what can I say" to hear the commands.`, "عذرًا، لم أفهم. قل «ما الأوامر» لسماع الأوامر المتاحة.") };
}

// ------------------------------------------------------------------ clinicians
async function clinicianIntent(user: SessionUser, raw: string, text: string, lang: Lang, pagePatientId: string | null): Promise<VoiceResult> {
  const patients = await prisma.patient.findMany({ select: { id: true, name: true, nameAr: true }, orderBy: { room: "asc" } });
  const named = patients.filter((p) => mentions(text, p.name) || (p.nameAr && mentions(text, p.nameAr)));
  const thisPatient = /this patient|the patient|هذا المريض|المريض الحالي|هذه المريضه/.test(text);
  const target = named.length === 1 ? named[0] : !named.length && (thisPatient || pagePatientId) ? patients.find((p) => p.id === pagePatientId) ?? null : null;
  if (named.length > 1) return { lang, intent: "CLARIFY", reply: t(lang, `Which patient: ${named.map((p) => p.name).join(" or ")}?`, `أي مريض: ${named.map((p) => p.nameAr || p.name).join(" أم ")}؟`) };

  const wantsAlerts = /alert|تنبيه|تنبيهات|انذار/.test(text);
  const wantsWard = /who needs|attention|ward|everyone|all patients|من يحتاج|المرضى|الجناح|جميع/.test(text);

  if (target && (named.length || !wantsWard)) {
    const nm = lang === "ar" ? target.nameAr || target.name : target.name;
    const base = `/api/patients/${target.id}`;
    if (/summar|ملخص|لخص|تلخيص/.test(text))
      return { lang, intent: "SUMMARY", reply: t(lang, `Generating the AI-assisted summary for ${nm}.`, `أُعدّ الملخص المساعد بالذكاء الاصطناعي لـ${nm}.`), calls: [{ path: `${base}/summary`, body: {}, label: "AI summary" }], confirm: false, after: "summary" };
    if (/ambulance|transfer|اسعاف|نقل/.test(text)) {
      const v = (await patientView(user, target.id, "clinical", 15)) as unknown as PatientV;
      if (v.transfer?.open) return { lang, intent: "TRANSFER_STATUS", reply: t(lang, `${nm}: ${v.transfer.statusLabel}, going to ${v.transfer.destination}${v.transfer.bed ? `, ${v.transfer.bed}` : ""}.`, `${nm}: ${v.transfer.statusLabel}، الوجهة ${v.transfer.destination}.`), navigate: `/patients/${target.id}` };
      return { lang, intent: "TRANSFER_FORM", reply: t(lang, `Opening the emergency transfer form for ${nm}. Check the suggestion and confirm on screen — an ambulance is never requested by voice alone.`, `أفتح نموذج النقل الإسعافي لـ${nm}. راجع الاقتراح وأكّد على الشاشة؛ لا يُطلب الإسعاف بالصوت وحده.`), navigate: `/patients/${target.id}?transfer=1` };
    }
    if (/acknowledge|(^|\s)اقر(\s|$)|اقرار|استلام|تم الاطلاع/.test(text)) {
      const open = await prisma.alert.findMany({ where: { patientId: target.id, status: "OPEN" }, orderBy: { createdAt: "desc" } });
      if (!open.length) return { lang, intent: "ACK", reply: t(lang, `${nm} has no unacknowledged alerts.`, `لا توجد تنبيهات غير مُقرّ بها لـ${nm}.`) };
      return {
        lang,
        intent: "ACK",
        reply: t(lang, `Acknowledge ${open.length} alert${open.length > 1 ? "s" : ""} for ${nm}: ${open.map((a) => a.title).join("; ")}? Say yes or no.`, `هل أُقرّ ${open.length} تنبيه لـ${nm}: ${open.map((a) => a.title).join("؛ ")}؟ قل «نعم» أو «لا».`),
        calls: open.map((a) => ({ method: "PATCH" as const, path: `/api/alerts/${a.id}`, body: { action: "acknowledge", note: "Acknowledged by voice command" }, label: a.title })),
        confirm: true,
        doneReply: t(lang, "Acknowledged.", "تم الإقرار."),
      };
    }
    if (/^(open|show|go to)\b|افتح|اعرض|اذهب/.test(text) && named.length) return { lang, intent: "OPEN", reply: t(lang, `Opening ${nm}.`, `أفتح ملف ${nm}.`), navigate: `/patients/${target.id}` };
    if (named.length || /status|how is|vitals|readings|حاله|كيف|قراءات|وضع/.test(text)) return { lang, intent: "PATIENT_STATUS", reply: await clinicianPatientStatus(user, target.id, nm, lang) };
  }

  if (wantsAlerts) {
    const w = (await wardView(user)) as unknown as WardV;
    const crit = w.alerts.filter((a) => a.severity === "CRITICAL");
    if (!w.alerts.length) return { lang, intent: "ALERTS", reply: t(lang, "There are no active alerts.", "لا توجد تنبيهات نشطة.") };
    const top = [...crit, ...w.alerts.filter((a) => a.severity !== "CRITICAL")].slice(0, 4).map((a) => `${lang === "ar" ? patients.find((p) => p.id === a.patientId)?.nameAr || a.patient?.name : a.patient?.name}: ${a.title}`);
    return { lang, intent: "ALERTS", reply: t(lang, `${w.alerts.length} active alerts, ${crit.length} critical. ${top.join(". ")}.`, `يوجد ${w.alerts.length} تنبيه نشط، منها ${crit.length} حرجة. ${top.join(". ")}.`) };
  }
  if (wantsWard) {
    const w = (await wardView(user)) as unknown as WardV;
    const label: Record<string, [string, string]> = { CRITICAL: ["critical alert", "تنبيه حرج"], DEVICE_DISCONNECTED: ["device disconnected", "الجهاز منفصل"], NO_RECENT_DATA: ["no recent data", "لا توجد بيانات حديثة"], NEEDS_REVIEW: ["needs review", "يحتاج مراجعة"], AWAITING_ASSESSMENT: ["awaiting assessment", "بانتظار التقييم"] };
    const need = w.patients.filter((p) => p.state !== "STABLE");
    if (!need.length) return { lang, intent: "WARD", reply: t(lang, "All patients are stable on their latest readings.", "جميع المرضى مستقرون حسب آخر القراءات.") };
    const lines = need.map((p) => `${lang === "ar" ? patients.find((x) => x.id === p.id)?.nameAr || p.name : p.name}: ${(label[p.state] ?? [p.state, p.state])[lang === "ar" ? 1 : 0]}${p.transfer?.open ? t(lang, ", ambulance transfer in progress", "، نقل إسعافي جارٍ") : ""}`);
    return { lang, intent: "WARD", reply: t(lang, `${need.length} of ${w.patients.length} patients need attention. ${lines.join(". ")}.`, `${need.length} من ${w.patients.length} مرضى يحتاجون متابعة. ${lines.join(". ")}.`) };
  }
  return { lang, intent: "UNKNOWN", reply: t(lang, 'Sorry, I didn\'t catch that. Say "what can I say" for the commands.', "عذرًا، لم أفهم. قل «ما الأوامر» لسماع الأوامر المتاحة.") };
}

async function clinicianPatientStatus(user: SessionUser, id: string, nm: string, lang: Lang) {
  const v = (await patientView(user, id, "clinical", 15)) as unknown as PatientV;
  const latest = v.latest ?? {};
  const vit = (["SPO2", "HR", "BP", "RR", "TEMP", "GLUCOSE"] as VitalType[]).filter((k) => latest[k]).map((k) => sayVital(k, latest[k]!, lang, false));
  const open = (v.alerts ?? []).filter((a) => a.status !== "RESOLVED");
  const al = open.length ? t(lang, ` ${open.length} open alert${open.length > 1 ? "s" : ""}: ${open.slice(0, 3).map((a) => a.title).join("; ")}.`, ` ${open.length} تنبيه مفتوح: ${open.slice(0, 3).map((a) => a.title).join("؛ ")}.`) : t(lang, " No open alerts.", " لا توجد تنبيهات مفتوحة.");
  const tr = v.transfer?.open ? t(lang, ` Ambulance: ${v.transfer.statusLabel}, to ${v.transfer.destination}.`, ` الإسعاف: ${v.transfer.statusLabel}، إلى ${v.transfer.destination}.`) : "";
  const STATE_AR: Record<string, string> = { STABLE: "مستقر حسب آخر القراءات", NEEDS_REVIEW: "يحتاج مراجعة", CRITICAL: "تنبيه حرج مفتوح", NO_RECENT_DATA: "لا توجد بيانات حديثة", DEVICE_DISCONNECTED: "الجهاز منفصل", AWAITING_ASSESSMENT: "بانتظار تقييم الطبيب" };
  return `${nm}: ${lang === "ar" ? STATE_AR[v.state] ?? v.state : v.stateReason}. ${vit.join(lang === "ar" ? "، " : "; ")}.${al}${tr}`;
}

// minimal shapes of the view models used here
type PatientV = {
  state: string;
  stateReason: string;
  connectivity: string;
  latest: LatestMap;
  patient: { nextCheckInDueAt: string | null; checkInOverdue: boolean; manualEntry?: boolean };
  medications: { id: string; name: string; dose: string }[];
  messages: { senderId: string | null; senderName: string; body: string; createdAt: string }[];
  alerts?: { status: string; title: string }[];
  transfer: { open: boolean; statusLabel: string; destination: string; etaAt: string | null; bed?: string | null } | null;
};
type WardV = {
  patients: { id: string; name: string; state: string; transfer?: { open: boolean } | null }[];
  alerts: { severity: string; title: string; patientId: string; patient?: { name: string } | null }[];
};
