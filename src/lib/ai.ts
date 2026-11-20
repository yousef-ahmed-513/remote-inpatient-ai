// AI-assisted summaries with a deterministic fallback.
//
// 1. Facts are always assembled by code from stored records (no model involved).
// 2. If a provider is configured (Amazon Bedrock preferred, OpenAI second) the model is
//    asked to re-word those facts — it is never given tools and never asked to decide care.
// 3. Any provider error, timeout or malformed reply falls back to the deterministic
//    summary, so the demo never depends on a paid AI service.
import { prisma } from "./db";
import { loadLimits, classify, ruleValues } from "./alerts";
import { computeStatus } from "./status";
import { getSim } from "./simulator";
import { STATE_META, VITALS, formatVital, type LatestMap, type SummaryDoc, type VitalType } from "./types";

export const AI_DISCLAIMER =
  "AI-assisted summary of recorded synthetic data, for clinician review only. It does not diagnose, prescribe, assess eligibility for hospital-at-home care or make emergency decisions.";

const hhmm = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const ago = (d: Date, now: Date) => {
  const m = Math.round((now.getTime() - d.getTime()) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} h ${m % 60} min ago` : `${Math.floor(h / 24)} d ago`;
};

type Facts = {
  patient: string;
  generatedAt: string;
  status: string;
  statusReason: string;
  vitals: string[];
  outsideLimits: string[];
  trends: string[];
  symptoms: string[];
  alerts: string[];
  dataGaps: string[];
  careTeamActivity: string[];
  openTasks: string[];
};

/** Mean of first third vs last third of a window → plain-language direction. */
function describeTrend(type: VitalType, values: { value: number; takenAt: Date }[]): string | null {
  if (values.length < 6) return null;
  const k = Math.max(2, Math.floor(values.length / 3));
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const first = mean(values.slice(0, k).map((v) => v.value));
  const last = mean(values.slice(-k).map((v) => v.value));
  const delta = last - first;
  const eps: Partial<Record<VitalType, number>> = { HR: 8, SPO2: 2, RR: 3, TEMP: 0.4, BP: 10, GLUCOSE: 25 };
  if (Math.abs(delta) < (eps[type] ?? 5)) return null;
  const mins = Math.max(1, Math.round((values[values.length - 1].takenAt.getTime() - values[0].takenAt.getTime()) / 60_000));
  const d = VITALS[type].decimals;
  return `${VITALS[type].short} ${delta < 0 ? "fell" : "rose"} from about ${first.toFixed(d)} to ${last.toFixed(d)} ${VITALS[type].unit} over the last ${mins} min`;
}

export async function gatherFacts(patientId: string, now = new Date()): Promise<Facts> {
  const since = new Date(now.getTime() - 20 * 60_000);
  const [p, sim, limits, recent, alerts, symptoms, notes, tasks] = await Promise.all([
    prisma.patient.findUniqueOrThrow({ where: { id: patientId }, include: { devices: true } }),
    getSim(),
    loadLimits(),
    prisma.reading.findMany({ where: { patientId, takenAt: { gte: since } }, orderBy: { takenAt: "asc" } }),
    prisma.alert.findMany({ where: { patientId, OR: [{ status: { not: "RESOLVED" } }, { createdAt: { gte: new Date(now.getTime() - 12 * 3600_000) } }] }, orderBy: { createdAt: "desc" }, take: 12 }),
    prisma.symptom.findMany({ where: { patientId }, orderBy: { createdAt: "desc" }, take: 5 }),
    prisma.note.findMany({ where: { patientId }, orderBy: { createdAt: "desc" }, take: 3 }),
    prisma.task.findMany({ where: { patientId, status: "OPEN" }, orderBy: { dueAt: "asc" }, take: 6 }),
  ]);
  const active = alerts.filter((a) => a.status !== "RESOLVED");
  const st = computeStatus(
    { ...p, activeAlerts: active, unreviewedSymptoms: symptoms.filter((s) => !s.reviewedAt).length },
    sim,
    now,
  );
  const latest: LatestMap = JSON.parse(p.latestJson || "{}");
  const lim = limits.forPatient(patientId);

  const vitals: string[] = [];
  const outside: string[] = [];
  for (const type of Object.keys(VITALS) as VitalType[]) {
    const l = latest[type];
    if (!l) continue;
    const at = new Date(l.t);
    vitals.push(`${VITALS[type].label}: ${formatVital(type, l.v, l.v2)} ${VITALS[type].unit} (${ago(at, now)}, ${l.src === "SIMULATED_DEVICE" ? "simulated device" : l.src.replace("_", "-").toLowerCase()})`);
    for (const rv of ruleValues({ type, value: l.v, value2: l.v2 })) {
      const b = classify(rv.value, lim[rv.vital]);
      if (b) outside.push(`${VITALS[type].label} ${formatVital(type, l.v, l.v2)} ${VITALS[type].unit} is ${b.direction === "low" ? "below" : "above"} the configured ${b.severity === "CRITICAL" ? "critical" : "review"} limit (${b.limit})`);
    }
  }
  const trends: string[] = [];
  for (const type of ["SPO2", "HR", "RR", "TEMP"] as VitalType[]) {
    const t = describeTrend(type, recent.filter((r) => r.type === type));
    if (t) trends.push(t);
  }

  const gaps: string[] = [];
  const streaming = p.devices.filter((d) => d.streaming);
  const down = streaming.filter((d) => d.status !== "CONNECTED");
  if (down.length) gaps.push(`${down.map((d) => d.name).join(", ")} ${down.length > 1 ? "are" : "is"} disconnected${p.lastReadingAt ? `; last reading received ${ago(p.lastReadingAt, now)}` : ""}. Values shown are historical and do not describe the patient's current condition.`);
  if (p.nextCheckInDueAt && p.nextCheckInDueAt < now) gaps.push(`Scheduled check-in was due at ${hhmm(p.nextCheckInDueAt)} and has not been received. Absence of data is not evidence that the patient is well.`);
  if (st.state === "NO_RECENT_DATA" && !gaps.length) gaps.push(st.reason);
  if (p.awaitingAssessment) gaps.push("Admission assessment by the doctor has not been recorded yet.");

  return {
    patient: `${p.name}, ${p.age} (${p.mrn}, synthetic) — ${p.condition}`,
    generatedAt: hhmm(now),
    status: STATE_META[st.state].label,
    statusReason: st.reason,
    vitals,
    outsideLimits: outside,
    trends,
    symptoms: symptoms.map((s) => `"${s.text}" — ${s.reportedBy}, ${ago(s.createdAt, now)}${s.reviewedAt ? " (reviewed)" : " (not yet reviewed)"}`),
    alerts: alerts.map((a) => `${a.severity === "CRITICAL" ? "Critical" : "Review"} · ${a.title} — raised ${hhmm(a.createdAt)}, ${a.status.toLowerCase()}${a.resolutionNote ? ` ("${a.resolutionNote}")` : ""}`),
    dataGaps: gaps,
    careTeamActivity: notes.map((n) => `${n.authorName} (${n.kind.toLowerCase()}, ${ago(n.createdAt, now)}): ${n.body}`),
    openTasks: tasks.map((t) => `${t.title} — ${t.assigneeRole.toLowerCase()}${t.dueAt ? `, due ${hhmm(t.dueAt)}` : ""}`),
  };
}

export function deterministicSummary(f: Facts): SummaryDoc {
  const flagged: string[] = [];
  if (f.dataGaps.length) flagged.push("Data is missing or stale — confirm the patient's condition directly before relying on the values shown.");
  if (f.outsideLimits.length) flagged.push(`${f.outsideLimits.length} latest reading${f.outsideLimits.length > 1 ? "s are" : " is"} outside the configured limits.`);
  if (f.trends.length) flagged.push("A change in trend was detected over the last 20 minutes (see Trends).");
  if (f.symptoms.some((s) => s.includes("not yet reviewed"))) flagged.push("A patient-reported symptom has not been reviewed yet.");
  const openAlerts = f.alerts.filter((a) => !a.includes(", resolved"));
  if (openAlerts.length) flagged.push(`${openAlerts.length} alert${openAlerts.length > 1 ? "s" : ""} still open or awaiting resolution.`);

  let headline: string;
  if (f.dataGaps.length && !f.outsideLimits.length) headline = `${f.status}. ${f.statusReason}. No conclusion about current condition can be drawn from the data on record.`;
  else if (flagged.length) headline = `${f.status}. ${flagged.length} item${flagged.length > 1 ? "s" : ""} flagged for clinician review.`;
  else headline = `${f.status}. Latest readings are inside the configured limits and no alerts are open.`;

  const sections = [
    { title: "Flagged for clinician review", items: flagged },
    { title: "Latest readings", items: f.vitals },
    { title: "Outside configured limits", items: f.outsideLimits },
    { title: "Trends (last 20 min)", items: f.trends },
    { title: "Patient-reported symptoms", items: f.symptoms },
    { title: "Alerts", items: f.alerts },
    { title: "Data gaps", items: f.dataGaps },
    { title: "Recent care-team activity", items: f.careTeamActivity },
    { title: "Open tasks", items: f.openTasks },
  ].filter((s) => s.items.length > 0);
  return { headline, sections, disclaimer: AI_DISCLAIMER };
}

// ---------------------------------------------------------------- providers

const SYSTEM_PROMPT = `You write concise clinical handover-style summaries for licensed clinicians on a hospital-at-home virtual ward.
You are given FACTS as JSON. All data is synthetic demo data.
Rules:
- Use ONLY the facts provided. Never invent values, history, causes or findings.
- Do NOT diagnose, name a suspected condition, recommend or change medication, give treatment advice, judge eligibility for home care, or advise on emergency action. Describe what the records show and what is flagged for clinician review.
- If data is missing, stale or a device is disconnected, say clearly that the patient's current condition is unknown. Never describe missing data as normal or stable.
- Reply with JSON only: {"headline": string, "sections": [{"title": string, "items": string[]}]}. Max 6 sections, short plain-English items, keep numbers and units exactly as given.`;

export function aiProvider(): "bedrock" | "openai" | "deterministic" {
  const pref = (process.env.AI_PROVIDER ?? "auto").toLowerCase();
  const bedrock = !!(process.env.AWS_BEARER_TOKEN_BEDROCK && process.env.BEDROCK_MODEL_ID);
  const openai = !!process.env.OPENAI_API_KEY;
  if (pref === "deterministic") return "deterministic";
  if (pref === "bedrock") return bedrock ? "bedrock" : "deterministic";
  if (pref === "openai") return openai ? "openai" : "deterministic";
  return bedrock ? "bedrock" : openai ? "openai" : "deterministic";
}

async function callBedrock(user: string): Promise<{ text: string; engine: string }> {
  const model = process.env.BEDROCK_MODEL_ID!;
  const region = process.env.AWS_REGION || "us-east-1";
  const res = await fetch(`https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/converse`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.AWS_BEARER_TOKEN_BEDROCK}` },
    body: JSON.stringify({
      system: [{ text: SYSTEM_PROMPT }],
      messages: [{ role: "user", content: [{ text: user }] }],
      inferenceConfig: { maxTokens: 900 },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Bedrock HTTP ${res.status}`);
  const data = await res.json();
  const text = (data?.output?.message?.content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
  return { text, engine: `bedrock:${model}` };
}

async function callOpenAI(user: string): Promise<{ text: string; engine: string }> {
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`);
  const data = await res.json();
  return { text: data?.choices?.[0]?.message?.content ?? "", engine: `openai:${model}` };
}

function parseDoc(text: string): SummaryDoc | null {
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    const raw = JSON.parse(text.slice(start, end + 1));
    if (typeof raw.headline !== "string" || !Array.isArray(raw.sections)) return null;
    const sections = raw.sections
      .filter((s: { title?: unknown; items?: unknown }) => typeof s?.title === "string" && Array.isArray(s?.items))
      .map((s: { title: string; items: unknown[] }) => ({ title: s.title.slice(0, 80), items: s.items.filter((i) => typeof i === "string").map((i) => (i as string).slice(0, 400)) }))
      .filter((s: { items: string[] }) => s.items.length > 0)
      .slice(0, 8);
    if (!sections.length) return null;
    return { headline: raw.headline.slice(0, 400), sections, disclaimer: AI_DISCLAIMER };
  } catch {
    return null;
  }
}

/** Runs the configured provider over `facts`; falls back to `fallback` on any problem. */
async function summarise(facts: unknown, fallback: SummaryDoc): Promise<{ doc: SummaryDoc; engine: string; fallbackReason?: string }> {
  const provider = aiProvider();
  if (provider === "deterministic") return { doc: fallback, engine: "deterministic" };
  try {
    const user = `FACTS:\n${JSON.stringify(facts, null, 1)}`;
    const { text, engine } = provider === "bedrock" ? await callBedrock(user) : await callOpenAI(user);
    const doc = parseDoc(text);
    if (!doc) throw new Error("Model reply was not valid summary JSON");
    return { doc, engine };
  } catch (e) {
    console.warn("[ai] provider failed, using deterministic summary:", (e as Error).message);
    return { doc: fallback, engine: "deterministic", fallbackReason: `${provider} unavailable` };
  }
}

export async function generatePatientSummary(patientId: string, createdBy: string) {
  const facts = await gatherFacts(patientId);
  const out = await summarise(facts, deterministicSummary(facts));
  const row = await prisma.aiSummary.create({ data: { patientId, kind: "PATIENT", engine: out.engine, content: JSON.stringify(out.doc), createdBy } });
  return { id: row.id, createdAt: row.createdAt, engine: out.engine, fallbackReason: out.fallbackReason, createdBy, doc: out.doc };
}

export async function generateHandover(createdBy: string) {
  const patients = await prisma.patient.findMany({ orderBy: { room: "asc" } });
  const all = await Promise.all(patients.map((p) => gatherFacts(p.id)));
  const needsAttention = all.filter((f) => f.status !== STATE_META.STABLE.label);
  const fallback: SummaryDoc = {
    headline: `Shift handover at ${all[0]?.generatedAt ?? ""}: ${patients.length} patients on the virtual ward, ${needsAttention.length} needing attention.`,
    sections: all.map((f) => ({
      title: `${f.patient.split(" — ")[0]} · ${f.status}`,
      items: [
        f.statusReason,
        ...f.dataGaps,
        ...f.outsideLimits,
        ...f.trends,
        ...f.symptoms.filter((s) => s.includes("not yet reviewed")).map((s) => `Symptom: ${s}`),
        ...f.alerts.filter((a) => !a.includes(", resolved")).map((a) => `Alert: ${a}`),
        ...f.openTasks.slice(0, 3).map((t) => `Task: ${t}`),
      ],
    })),
    disclaimer: AI_DISCLAIMER,
  };
  const out = await summarise({ handover: true, patients: all }, fallback);
  const row = await prisma.aiSummary.create({ data: { kind: "HANDOVER", engine: out.engine, content: JSON.stringify(out.doc), createdBy } });
  return { id: row.id, createdAt: row.createdAt, engine: out.engine, fallbackReason: out.fallbackReason, createdBy, doc: out.doc };
}
