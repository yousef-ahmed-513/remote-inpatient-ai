// Red-flag symptom triage — deterministic, no AI. A patient who ticks or describes a red-flag
// symptom is shown the emergency number immediately (the response does not wait for any model),
// and the care team gets a CRITICAL alert with an emergency-transfer suggestion.
// Keyword lists cover English and Arabic; ticked boxes are the primary signal, text is the backup.
// Demo rules only — not a validated clinical triage tool.
import { RED_FLAG_ORDER, type RedFlag } from "./types";

const PATTERNS: Record<RedFlag, RegExp[]> = {
  CHEST_PAIN: [/chest\s+(pain|tight\w*|pressure|heav\w*|discomfort)/, /crushing/, /(ألم|الم|وجع|ضيق|ثقل)\s+(في\s+)?(ال)?صدر/],
  SEVERE_BREATHLESS: [/can'?t\s+(breathe|catch\s+my\s+breath|finish\s+a\s+sentence)/, /cannot\s+breathe/, /struggling\s+to\s+breathe/, /gasping/, /(very|severe(ly)?|extremely)\s+(short\s+of\s+breath|breathless)/, /(لا\s+أستطيع|ما\s+اقدر|ما\s+أقدر|مش\s+قادر)\s+(أتنفس|اتنفس)/, /(ضيق|صعوبة)\s+(في\s+)?(ال)?(نفس|تنفس)\s+شديد/, /اختناق/],
  BLUE_LIPS: [/(blue|grey|gray)\s+(lips|face)/, /lips\s+(are\s+|look\s+)?(blue|grey|gray)/, /cyano/, /ازرقاق/, /شفا(ه|يف)\s+(زرقاء|زرق)/],
  CONFUSION: [/confus/, /disorient/, /very\s+drowsy/, /hard\s+to\s+wake/, /unresponsive/, /not\s+making\s+sense/, /تشوش/, /ارتباك/, /هذيان/, /(فقدان|فاقد)\s+(ال)?وعي/, /لا\s+يستجيب/],
  FAINT: [/faint(ed)?/, /passed\s+out/, /collaps/, /blacked\s+out/, /syncope/, /إغماء|اغماء|أغمي|اغمي/, /انهار|سقط\s+فجأة/],
  STROKE: [/face\s+(is\s+)?droop/, /slurred\s+speech/, /arm\s+(is\s+)?weak/, /one\s+side\s+of\s+(my|the|his|her)\s+(body|face)/, /\bstroke\b/, /(ميلان|ميل)\s+(في\s+)?(ال)?(وجه|فم)/, /ثقل\s+(في\s+)?(ال)?لسان/, /تلعثم/, /جلطة\s+(دماغية|بالمخ)/],
  BLEEDING: [/heavy\s+bleed/, /bleeding\s+(a\s+lot|heavily|won'?t\s+stop)/, /(vomit\w*|cough\w*)\s+(up\s+)?blood/, /نزيف/, /(قيء|استفراغ|ترجيع)\s+دم/, /(سعال|كحة)\s+(مع\s+)?دم/],
  SEIZURE: [/seizure/, /convuls/, /having\s+a\s+fit/, /تشنج/, /نوبة\s+صرع/],
};
const NEGATION = /\b(no|not|denies|denied|without|never|none)\b[^.,;]{0,20}$|(بدون|لا\s+يوجد|ما\s+في|ليس|مافي|لا\s+أعاني\s+من)[^.,؛،]{0,20}$/;

/** Red flags found in free text. A match preceded closely by a negation ("no chest pain") is ignored. */
export function detectRedFlags(text: string): RedFlag[] {
  const t = text.toLowerCase();
  const out: RedFlag[] = [];
  for (const flag of RED_FLAG_ORDER) {
    for (const re of PATTERNS[flag]) {
      const g = new RegExp(re.source, "g");
      let m: RegExpExecArray | null;
      let hit = false;
      while ((m = g.exec(t))) {
        if (!NEGATION.test(t.slice(Math.max(0, m.index - 30), m.index))) {
          hit = true;
          break;
        }
        if (m[0].length === 0) g.lastIndex++;
      }
      if (hit) {
        out.push(flag);
        break;
      }
    }
  }
  return out;
}
