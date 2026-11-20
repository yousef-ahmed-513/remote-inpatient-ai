// Emergency transfer: ambulance dispatch + direct admission to a receiving hospital unit (server only).
// Design notes, integration contract and safety rules: docs/EMERGENCY-TRANSFER.md
//
//   clinician confirms ─▶ requestTransfer()
//        ├─ suggestTransfer()      rule-based: priority + receiving pathway from alerts, vitals, symptoms
//        ├─ buildHandover()        ISBAR snapshot (frozen at request time) for the crew and the unit
//        ├─ AmbulanceAdapter       dispatch request → incident reference, vehicle, ETA
//        └─ HospitalAdapter        pre-arrival alert to the receiving unit → accept (bed) | decline
//   housekeeping ─▶ advanceTransfers()   moves simulated stages forward, unit decision, prep items
//
// Safety rules:
//   • A human clinician confirms every dispatch; the system only suggests priority and pathway.
//   • Direct admission (no emergency department) happens only after the receiving unit ACCEPTS.
//     A decline — or no answer before the crew leaves the house — sends the patient to the ED,
//     pre-alerted. The ambulance never drives to a unit that has not accepted.
//   • The handover is a snapshot with times and sources; nothing is presented as current if it isn't.
//   • Patients and caregivers are always shown the emergency number: the app never replaces calling it.
//   • Everything here is SIMULATED until real adapters are connected (see the adapter contracts).
import type { Transfer } from "@prisma/client";
import { prisma } from "./db";
import { loadLimits, raiseAlert, loadAlertContext } from "./alerts";
import { audit, HttpError, type SessionUser } from "./auth";
import {
  formatVital,
  RED_FLAG_ORDER,
  RED_FLAGS,
  SOURCE_LABEL,
  TRANSFER_OPEN,
  TRANSFER_PATHWAYS,
  TRANSFER_STAGES,
  TRANSFER_STATUS,
  VITALS,
  type LatestMap,
  type RedFlag,
  type TransferPathway,
  type TransferPriority,
  type TransferStatus,
  type VitalType,
} from "./types";

const MIN = 60_000;
export const EMERGENCY_NUMBER = process.env.EMERGENCY_NUMBER?.trim() || "9999";
export const AMBULANCE_SERVICE = process.env.AMBULANCE_SERVICE_NAME?.trim() || "Ambulance service (simulated)";
export const RECEIVING_HOSPITAL = process.env.RECEIVING_HOSPITAL_NAME?.trim() || "City General Hospital (simulated)";
/** Demo clock for the simulated adapters: 0.1 = stages run 10× faster than a real call-out. */
export const TIME_SCALE = (() => {
  const n = Number(process.env.TRANSFER_TIME_SCALE);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.1;
})();

// ------------------------------------------------------------------ adapter contracts
/** What a real ambulance-service (CAD) integration must provide. */
export interface AmbulanceAdapter {
  readonly name: string;
  readonly simulated: boolean;
  /** Create an incident. Returns the service's reference, assigned vehicle and ETA to the patient. */
  requestDispatch(req: { transferId: string; priority: TransferPriority; pickupAddress: string; accessNotes: string; handover: Handover; destination: string }): Promise<{ incidentRef: string; vehicle: string; etaMinutes: number }>;
  /** Tell the crew the destination changed (e.g. unit declined → ED). */
  updateDestination(incidentRef: string, destination: string): Promise<void>;
  cancel(incidentRef: string, reason: string): Promise<void>;
}

/** What a real receiving-hospital integration (bed management / ADT / FHIR) must provide. */
export interface HospitalAdapter {
  readonly name: string;
  readonly simulated: boolean;
  /** Pre-arrival alert to a unit. The unit answers later (accept with a bed, or decline). */
  preAlert(req: { transferId: string; unit: string; priority: TransferPriority; handover: Handover; checklist: ChecklistItem[] }): Promise<void>;
  /** The unit's answer. The simulated hospital decides from its bed table. */
  decide(req: { transferId: string; unit: string }): Promise<{ accepted: true; bed: string } | { accepted: false; reason: string }>;
  cancel(transferId: string, reason: string): Promise<void>;
}

// ------------------------------------------------------------------ simulated adapters
const rand = (seed: string) => {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)) >>> 0) / 4294967296;
};

export const simulatedAmbulance: AmbulanceAdapter = {
  name: AMBULANCE_SERVICE,
  simulated: true,
  async requestDispatch(req) {
    const r = rand(req.transferId);
    const travel = Math.round((req.priority === "EMERGENCY" ? 6 : 10) + r() * 6);
    return { incidentRef: `AMB-${new Date().getFullYear()}-${String(Math.floor(r() * 90000) + 10000)}`, vehicle: `${req.priority === "EMERGENCY" ? "Paramedic unit" : "Ambulance"} ${["A12", "B07", "C21", "D03", "E15"][Math.floor(r() * 5)]}`, etaMinutes: travel };
  },
  async updateDestination() {},
  async cancel() {},
};

/** Simulated bed table of the receiving hospital. A unit declines once its beds are taken by open transfers. */
const UNIT_BEDS: Record<string, string[]> = {
  "Coronary Care Unit (CCU)": ["CCU Bed 3", "CCU Bed 5"],
  "Respiratory High Dependency Unit": ["RHDU Bed 2"],
  "Acute Medical Unit — sepsis bay": ["AMU Sepsis Bay 1", "AMU Sepsis Bay 2"],
  "Surgical Assessment Unit": ["SAU Bay 4", "SAU Bay 6"],
  "Acute Medical Unit": ["AMU Bed 11", "AMU Bed 14", "AMU Bed 17"],
};

export const simulatedHospital: HospitalAdapter = {
  name: RECEIVING_HOSPITAL,
  simulated: true,
  async preAlert() {},
  async decide({ transferId, unit }) {
    const beds = UNIT_BEDS[unit];
    if (!beds) return { accepted: false, reason: "Unit not part of the direct-admission agreement" };
    const taken = await prisma.transfer.findMany({ where: { id: { not: transferId }, destination: unit, unitStatus: "ACCEPTED", status: { in: TRANSFER_OPEN } }, select: { bed: true } });
    const free = beds.filter((b) => !taken.some((t) => t.bed === b));
    return free.length ? { accepted: true, bed: free[0] } : { accepted: false, reason: `No ${unit} bed available` };
  },
  async cancel() {},
};

const ambulance: AmbulanceAdapter = simulatedAmbulance;
const hospital: HospitalAdapter = simulatedHospital;

// ------------------------------------------------------------------ suggestion engine
export type Suggestion = { priority: TransferPriority; pathway: TransferPathway; reasons: string[]; alternatives: TransferPathway[] };

const has = (text: string, words: RegExp) => words.test(text.toLowerCase());

/** Rule-based suggestion. It never dispatches anything — a clinician confirms or changes it. */
export async function suggestTransfer(patientId: string): Promise<Suggestion> {
  const [p, alerts, symptoms, limits] = await Promise.all([
    prisma.patient.findUniqueOrThrow({ where: { id: patientId } }),
    prisma.alert.findMany({ where: { patientId, status: { not: "RESOLVED" } } }),
    prisma.symptom.findMany({ where: { patientId, createdAt: { gte: new Date(Date.now() - 12 * 60 * MIN) } }, orderBy: { createdAt: "desc" } }),
    loadLimits(),
  ]);
  const lim = limits.forPatient(patientId);
  const latest: LatestMap = JSON.parse(p.latestJson || "{}");
  const v = (t: VitalType) => latest[t]?.v;
  const symText = symptoms.map((s) => s.text).join(" · ");
  const matches: { pathway: TransferPathway; reason: string; redFlag?: boolean; rank?: number }[] = [];
  const alertOn = (vital: string, kind?: string) => alerts.filter((a) => a.vital === vital && (!kind || a.kind === kind));

  // Red-flag symptoms reported in the last 12 h outrank everything else
  for (const sym of symptoms) for (const f of sym.redFlags.split(",").filter(Boolean) as RedFlag[]) {
    if (RED_FLAGS[f] && !matches.some((m) => m.reason.includes(RED_FLAGS[f].label)))
      matches.push({ pathway: RED_FLAGS[f].pathway, reason: `red-flag symptom — ${RED_FLAGS[f].label} ("${sym.text}")`, redFlag: true, rank: RED_FLAG_ORDER.indexOf(f) });
  }

  // Cardiac
  const rhythm = alerts.filter((a) => a.kind === "RHYTHM_FLAG");
  const hrCrit = alertOn("HR").some((a) => a.severity === "CRITICAL");
  const chest = has(symText, /chest (pain|tight)|palpitation|faint|syncope/);
  if (rhythm.length || hrCrit || chest || has(p.condition, /heart|cardiac/) && alertOn("HR").length)
    matches.push({ pathway: "CARDIAC", reason: [rhythm.length && `rhythm flag: ${rhythm[0].title}`, hrCrit && "heart rate at critical limit", chest && `patient reported "${symptoms.find((s) => /chest|palpit|faint|syncope/i.test(s.text))?.text}"`].filter(Boolean).join("; ") || "cardiac programme with heart-rate alert" });

  // Respiratory
  const spo2 = alertOn("SPO2");
  const rr = alertOn("RR");
  if (spo2.length || rr.length || has(symText, /breath|short of breath|wheez/))
    matches.push({ pathway: "RESPIRATORY", reason: [spo2.length && `SpO₂ ${spo2[0].severity === "CRITICAL" ? "critical" : "low"}${v("SPO2") != null ? ` (latest ${v("SPO2")} %)` : ""}`, rr.length && `respiratory rate alert${v("RR") != null ? ` (latest ${v("RR")}/min)` : ""}`, has(symText, /breath|wheez/) && "patient reports breathlessness"].filter(Boolean).join("; ") });

  // Suspected sepsis — simple screen on the latest values (≥ 2 of temperature, HR, RR outside range)
  const temp = v("TEMP"), hr = v("HR"), rrv = v("RR");
  const sepsisSigns = [temp != null && (temp >= 38 || temp <= 36) && `temperature ${temp} °C`, hr != null && hr > 90 && `heart rate ${Math.round(hr)}`, rrv != null && rrv > 20 && `respiratory rate ${Math.round(rrv)}`].filter(Boolean) as string[];
  if (sepsisSigns.length >= 2 && (has(p.condition, /cellulitis|infect|pneumonia|antibiotic/) || (temp != null && temp >= 38)))
    matches.push({ pathway: "SEPSIS", reason: `sepsis screen positive on latest values: ${sepsisSigns.join(", ")}` });

  // Metabolic
  const glu = alertOn("GLUCOSE").filter((a) => a.severity === "CRITICAL");
  if (glu.length || has(symText, /hypo|sweaty|confus/) && has(p.condition, /diabet/))
    matches.push({ pathway: "METABOLIC", reason: glu.length ? `glucose at critical limit${v("GLUCOSE") != null ? ` (latest ${v("GLUCOSE")} mg/dL)` : ""}` : "possible hypoglycaemia symptoms in a diabetes programme" });

  // Surgical
  const bpLow = alertOn("BP_SYS").some((a) => /below/i.test(a.title)) || (v("BP") != null && lim.BP_SYS.critLow != null && v("BP")! <= lim.BP_SYS.critLow);
  if (has(p.condition, /post-operative|surgery|replacement/) && (bpLow || has(symText, /wound|bleed|swollen calf|calf pain/)))
    matches.push({ pathway: "SURGICAL", reason: bpLow ? "post-operative patient with low blood pressure" : "post-operative wound / bleeding concern reported" });

  const order: TransferPathway[] = ["CARDIAC", "RESPIRATORY", "SEPSIS", "METABOLIC", "SURGICAL"];
  matches.sort((a, b) => (a.redFlag && b.redFlag ? a.rank! - b.rank! : a.redFlag === b.redFlag ? order.indexOf(a.pathway) - order.indexOf(b.pathway) : a.redFlag ? -1 : 1));
  const pathway = matches[0]?.pathway ?? "GENERAL_MEDICAL";
  const critical = alerts.some((a) => a.severity === "CRITICAL") || matches.some((m) => m.redFlag);
  return {
    priority: critical ? "EMERGENCY" : "URGENT",
    pathway,
    reasons: [
      ...(matches.length ? matches.map((m) => `${TRANSFER_PATHWAYS[m.pathway].label}: ${m.reason}`) : ["No specific pathway rule matched — general medical admission suggested"]),
      critical ? `Emergency priority: ${[matches.some((m) => m.redFlag) && "red-flag symptom reported", alerts.some((a) => a.severity === "CRITICAL") && `${alerts.filter((a) => a.severity === "CRITICAL").length} critical alert(s) open`].filter(Boolean).join(" and ")}` : "Urgent priority: no critical alert or red-flag symptom",
    ],
    alternatives: [...new Set([...matches.slice(1).map((m) => m.pathway), "GENERAL_MEDICAL" as TransferPathway, "EMERGENCY_DEPT" as TransferPathway])].filter((x) => x !== pathway),
  };
}

// ------------------------------------------------------------------ handover (ISBAR)
export type Handover = {
  generatedAt: string;
  identify: { name: string; mrn: string; age: number; sex: string; address: string; accessNotes: string; virtualWard: string; responsibleDoctor: string | null; nurse: string | null };
  situation: { reason: string; priority: TransferPriority; activeAlerts: { severity: string; title: string; at: string }[] };
  background: { condition: string; programme: string; admittedAt: string; carePlan: string[]; medications: { name: string; dose: string; schedule: string; lastTakenAt: string | null }[]; allergies: string };
  assessment: { vitals: { vital: string; value: string; unit: string; at: string; source: string }[]; symptoms: { text: string; severity: string; at: string }[]; devices: string };
  recommendation: { pathway: string; destination: string; hospital: string; requests: string[] };
  disclaimer: string;
};

async function buildHandover(patientId: string, input: { priority: TransferPriority; pathway: TransferPathway; reason: string; accessNotes: string; destination: string; checklist: ChecklistItem[] }): Promise<Handover> {
  const p = await prisma.patient.findUniqueOrThrow({ where: { id: patientId }, include: { devices: true, ward: true, medications: { include: { logs: { orderBy: { takenAt: "desc" }, take: 1 } } } } });
  const [alerts, symptoms, users] = await Promise.all([
    prisma.alert.findMany({ where: { patientId, status: { not: "RESOLVED" } }, orderBy: { createdAt: "desc" } }),
    prisma.symptom.findMany({ where: { patientId }, orderBy: { createdAt: "desc" }, take: 5 }),
    prisma.user.findMany({ where: { id: { in: [p.doctorId ?? "", p.nurseId ?? ""] } } }),
  ]);
  const latest: LatestMap = JSON.parse(p.latestJson || "{}");
  const streaming = p.devices.filter((d) => d.streaming);
  return {
    generatedAt: new Date().toISOString(),
    identify: { name: p.name, mrn: p.mrn, age: p.age, sex: p.sex, address: p.address, accessNotes: input.accessNotes, virtualWard: `${p.ward.name} · ${p.room}`, responsibleDoctor: users.find((u) => u.id === p.doctorId)?.name ?? null, nurse: users.find((u) => u.id === p.nurseId)?.name ?? null },
    situation: { reason: input.reason, priority: input.priority, activeAlerts: alerts.map((a) => ({ severity: a.severity, title: a.title, at: a.createdAt.toISOString() })) },
    background: {
      condition: p.condition,
      programme: p.pathway,
      admittedAt: p.admittedAt.toISOString(),
      carePlan: JSON.parse(p.carePlan || "[]"),
      medications: p.medications.map((m) => ({ name: m.name, dose: m.dose, schedule: m.schedule, lastTakenAt: m.logs[0]?.takenAt.toISOString() ?? null })),
      allergies: "Not recorded in this demo record — confirm with the patient",
    },
    assessment: {
      vitals: (Object.keys(VITALS) as VitalType[]).filter((t) => latest[t]).map((t) => ({ vital: VITALS[t].label, value: formatVital(t, latest[t]!.v, latest[t]!.v2), unit: VITALS[t].unit, at: latest[t]!.t, source: SOURCE_LABEL[latest[t]!.src] ?? latest[t]!.src })),
      symptoms: symptoms.map((s) => ({ text: s.text, severity: s.severity, at: s.createdAt.toISOString() })),
      devices: streaming.length ? `${streaming.filter((d) => d.status === "CONNECTED").length}/${streaming.length} monitoring devices transmitting` : "Spot-check devices only (manual readings)",
    },
    recommendation: { pathway: TRANSFER_PATHWAYS[input.pathway].label, destination: input.destination, hospital: RECEIVING_HOSPITAL, requests: input.checklist.filter((c) => c.owner === "RECEIVING_UNIT").map((c) => c.label) },
    disclaimer: "Synthetic demo record. Values carry their source and time; confirm on arrival.",
  };
}

// ------------------------------------------------------------------ preparation checklists
export type ChecklistItem = { id: string; label: string; owner: "VIRTUAL_WARD" | "RECEIVING_UNIT"; done: boolean; doneAt: string | null; doneBy: string | null };

const UNIT_PREP: Record<TransferPathway, string[]> = {
  CARDIAC: ["CCU bed reserved", "Cardiology team alerted to incoming patient", "Cardiac monitor and 12-lead ECG ready on arrival", "Blood tests to be requested on arrival per local chest-pain protocol", "Resuscitation equipment checked"],
  RESPIRATORY: ["High-dependency bed reserved", "Respiratory team alerted", "Oxygen / non-invasive ventilation set up at the bedside", "Blood gas and chest X-ray to be requested on arrival", "Infection-control precautions confirmed"],
  SEPSIS: ["Sepsis bay reserved", "Medical team alerted — sepsis screen positive", "Cultures, lactate and IV access kit ready on arrival", "Antimicrobials to be prescribed by the receiving clinician per local protocol"],
  SURGICAL: ["Surgical assessment bay reserved", "Surgical team alerted (operating team informed)", "Wound review and bloods (incl. group & save) ready on arrival", "Theatre availability checked if needed"],
  METABOLIC: ["Acute medical bed reserved", "Medical team alerted", "Bedside glucose and ketone testing ready on arrival", "Hypo / hyperglycaemia protocol at the bedside"],
  GENERAL_MEDICAL: ["Acute medical bed reserved", "Medical team alerted", "Observations and admission bloods ready on arrival"],
  EMERGENCY_DEPT: ["Emergency department pre-alerted with the handover", "Majors / resus space prepared by the department"],
};
const WARD_PREP = ["Handover sent to the ambulance crew and receiving unit", "Patient (and family) told what is happening", "Medication list and devices ready to travel", "Next of kin informed"];

function checklistFor(pathway: TransferPathway, requestedBy: string, now: Date): ChecklistItem[] {
  return [
    ...WARD_PREP.map((label, i) => ({ id: `w${i}`, label, owner: "VIRTUAL_WARD" as const, done: i === 0, doneAt: i === 0 ? now.toISOString() : null, doneBy: i === 0 ? requestedBy : null })),
    ...UNIT_PREP[pathway].map((label, i) => ({ id: `u${i}`, label, owner: "RECEIVING_UNIT" as const, done: false, doneAt: null, doneBy: null })),
  ];
}

// ------------------------------------------------------------------ request
type Schedule = Partial<Record<TransferStatus | "UNIT_DECISION", string>> & { scale: number; travelMin: number; transportMin: number };
type TimelineItem = { t: string; text: string; kind: "STATUS" | "UNIT" | "PREP" | "NOTE" };

export async function requestTransfer(
  user: SessionUser,
  patientId: string,
  input: { priority: TransferPriority; pathway: TransferPathway; reason: string; accessNotes?: string },
  now = new Date(),
) {
  const open = await prisma.transfer.findFirst({ where: { patientId, status: { in: TRANSFER_OPEN } } });
  if (open) throw new HttpError(409, "An emergency transfer is already in progress for this patient");
  const p = await prisma.patient.findUniqueOrThrow({ where: { id: patientId } });
  if (!p.address) throw new HttpError(422, "No pickup address on record for this patient");
  const suggestion = await suggestTransfer(patientId);
  const meta = TRANSFER_PATHWAYS[input.pathway];
  const accessNotes = (input.accessNotes ?? p.accessNotes).trim();
  const checklist = checklistFor(input.pathway, user.name, now);
  const handover = await buildHandover(patientId, { ...input, accessNotes, destination: meta.unit, checklist });

  const t = await prisma.transfer.create({
    data: {
      patientId, status: "REQUESTED", priority: input.priority, pathway: input.pathway, suggestedPathway: suggestion.pathway, reason: input.reason,
      hospital: RECEIVING_HOSPITAL, destination: meta.unit, unitStatus: meta.direct ? "PENDING" : "ACCEPTED", directAdmission: meta.direct,
      pickupAddress: p.address, accessNotes, handoverJson: JSON.stringify(handover), checklistJson: JSON.stringify(checklist), scheduleJson: "{}",
      requestedById: user.id, requestedByName: user.name, createdAt: now,
    },
  });

  const dispatch = await ambulance.requestDispatch({ transferId: t.id, priority: input.priority, pickupAddress: p.address, accessNotes, handover, destination: meta.unit });
  if (meta.direct) await hospital.preAlert({ transferId: t.id, unit: meta.unit, priority: input.priority, handover, checklist });
  const s = TIME_SCALE;
  const at = (m: number) => new Date(now.getTime() + m * MIN * s).toISOString();
  const onScene = 1 + dispatch.etaMinutes;
  const transportMin = input.priority === "EMERGENCY" ? 12 : 16;
  const leaves = onScene + (input.priority === "EMERGENCY" ? 8 : 12);
  const schedule: Schedule = { scale: s, travelMin: dispatch.etaMinutes, transportMin, DISPATCHED: at(1), UNIT_DECISION: at(3), ON_SCENE: at(onScene), TRANSPORTING: at(leaves), ARRIVED: at(leaves + transportMin), HANDED_OVER: at(leaves + transportMin + (meta.direct ? 4 : 10)) };
  const timeline: TimelineItem[] = [
    { t: now.toISOString(), kind: "STATUS", text: `${input.priority === "EMERGENCY" ? "Emergency" : "Urgent"} ambulance requested by ${user.name} — ${input.reason}` },
    { t: now.toISOString(), kind: "NOTE", text: `${AMBULANCE_SERVICE}: incident ${dispatch.incidentRef} created, ${dispatch.vehicle} assigned, ETA ${dispatch.etaMinutes} min` },
    { t: now.toISOString(), kind: "UNIT", text: meta.direct ? `Pre-arrival alert sent to ${meta.unit}, ${RECEIVING_HOSPITAL} — awaiting acceptance for direct admission` : `${meta.unit} pre-alerted with the handover` },
  ];
  await prisma.transfer.update({ where: { id: t.id }, data: { incidentRef: dispatch.incidentRef, vehicle: dispatch.vehicle, scheduleJson: JSON.stringify(schedule), timelineJson: JSON.stringify(timeline) } });
  await audit(user, "TRANSFER_REQUESTED", { patientId, detail: `${input.priority} transfer → ${meta.unit} (${RECEIVING_HOSPITAL}); incident ${dispatch.incidentRef}; suggested pathway ${TRANSFER_PATHWAYS[suggestion.pathway].label}${suggestion.pathway !== input.pathway ? ` (clinician chose ${meta.label})` : ""}` });
  await prisma.message.create({ data: { patientId, senderId: user.id, senderName: user.name, senderRole: user.role, body: `An ambulance has been requested for you and is on its way (ETA about ${dispatch.etaMinutes} min). Please unlock the door and keep your phone and medicines nearby. If you get worse before it arrives, call ${EMERGENCY_NUMBER}.`, createdAt: now } });
  return prisma.transfer.findUniqueOrThrow({ where: { id: t.id } });
}

// ------------------------------------------------------------------ progression (simulated adapters)
const due = (iso: string | undefined, now: Date) => !!iso && new Date(iso).getTime() <= now.getTime();

function completePrep(list: ChecklistItem[], n: number, now: Date, by: string) {
  let done = 0;
  for (const c of list) if (c.owner === "RECEIVING_UNIT" && !c.done && done < n) {
    c.done = true;
    c.doneAt = now.toISOString();
    c.doneBy = by;
    done++;
  }
  return done;
}

/** Moves every open transfer forward according to its schedule. Called from housekeeping. */
export async function advanceTransfers(now: Date) {
  const open = await prisma.transfer.findMany({ where: { status: { in: TRANSFER_OPEN } } });
  for (const t of open) await advanceOne(t, now);
}

async function advanceOne(t: Transfer, now: Date) {
  const schedule: Schedule = JSON.parse(t.scheduleJson || "{}");
  const timeline: TimelineItem[] = JSON.parse(t.timelineJson || "[]");
  const list: ChecklistItem[] = JSON.parse(t.checklistJson || "[]");
  let { status, unitStatus, destination, directAdmission, bed } = t;
  let changed = false;
  const log = (kind: TimelineItem["kind"], text: string, at = now) => timeline.push({ t: at.toISOString(), kind, text });
  const unitBy = `${destination} (simulated)`;

  // receiving unit decision — must happen before the crew leaves the house
  const decisionDue = due(schedule.UNIT_DECISION, now) || due(schedule.TRANSPORTING, now);
  if (unitStatus === "PENDING" && decisionDue) {
    const d = await hospital.decide({ transferId: t.id, unit: destination });
    if (d.accepted) {
      unitStatus = "ACCEPTED";
      bed = d.bed;
      completePrep(list, 2, now, unitBy);
      log("UNIT", `${destination} ACCEPTED direct admission — ${d.bed} reserved. The crew will bypass the emergency department.`);
      await audit(null, "TRANSFER_UNIT_ACCEPTED", { patientId: t.patientId, detail: `${destination}: ${d.bed}` });
    } else {
      const ed = TRANSFER_PATHWAYS.EMERGENCY_DEPT.unit;
      log("UNIT", `${destination} DECLINED (${d.reason}). Safety fallback: destination changed to ${ed}, pre-alerted with the full handover; ${TRANSFER_PATHWAYS[t.pathway as TransferPathway].label} team informed.`);
      await audit(null, "TRANSFER_UNIT_DECLINED", { patientId: t.patientId, detail: `${destination}: ${d.reason} → ${ed}` });
      unitStatus = "DECLINED";
      directAdmission = false;
      destination = ed;
      list.splice(0, list.length, ...list.filter((c) => c.owner === "VIRTUAL_WARD"), ...UNIT_PREP.EMERGENCY_DEPT.map((label, i) => ({ id: `e${i}`, label, owner: "RECEIVING_UNIT" as const, done: i === 0, doneAt: i === 0 ? now.toISOString() : null, doneBy: i === 0 ? "Emergency department (simulated)" : null })));
      if (t.incidentRef) await ambulance.updateDestination(t.incidentRef, ed);
      const ctx = await loadAlertContext(prisma, now);
      await raiseAlert(prisma, t.patientId, { kind: "TRANSFER", vital: null, severity: "WARNING", title: "Direct admission declined — patient redirected to the ED", message: `${t.destination} could not accept (${d.reason}). The ambulance now goes to the ${ed}, which has the handover. Consider calling the specialty team.` }, ctx.active, ctx.recentlyResolved, now);
    }
    changed = true;
  }

  // ambulance stages
  const idx = TRANSFER_STAGES.indexOf(status as TransferStatus);
  for (const next of TRANSFER_STAGES.slice(idx + 1)) {
    if (!due(schedule[next], now)) break;
    status = next;
    changed = true;
    const at = new Date(schedule[next]!);
    if (next === "DISPATCHED") log("STATUS", `${t.vehicle ?? "Ambulance"} mobilised — en route to ${t.pickupAddress}`, at);
    if (next === "ON_SCENE") log("STATUS", "Crew with the patient — handover reviewed on scene", at);
    if (next === "TRANSPORTING") log("STATUS", `Leaving scene → ${destination}${directAdmission ? " (direct admission, no ED)" : ""}`, at);
    if (next === "ARRIVED") log("STATUS", `Arrived at ${RECEIVING_HOSPITAL} — ${destination}${bed ? `, ${bed}` : ""}`, at);
    if (next === "HANDED_OVER") log("STATUS", `Handed over to the ${destination} team`, at);
    if (unitStatus !== "PENDING" && (next === "ON_SCENE" || next === "TRANSPORTING")) completePrep(list, 2, at, directAdmission ? unitBy : "Emergency department (simulated)");
    if (next === "ARRIVED") {
      const n = completePrep(list, 99, at, directAdmission ? unitBy : "Emergency department (simulated)");
      if (n) log("PREP", `${destination} ready: all preparation items complete`, at);
    }
  }
  if (!changed) return;
  await prisma.transfer.update({
    where: { id: t.id },
    data: { status, unitStatus, destination, directAdmission, bed, timelineJson: JSON.stringify(timeline), checklistJson: JSON.stringify(list), closedAt: status === "HANDED_OVER" ? now : null },
  });
  if (status !== t.status) await audit(null, "TRANSFER_STATUS", { patientId: t.patientId, detail: `${t.incidentRef ?? ""} ${TRANSFER_STATUS[status as TransferStatus].label}` });
}

/** Demo control: jump to the next stage now (the rest of the schedule shifts with it). */
export async function skipStage(user: SessionUser, patientId: string, now = new Date()) {
  const t = await prisma.transfer.findFirst({ where: { patientId, status: { in: TRANSFER_OPEN } } });
  if (!t) throw new HttpError(404, "No transfer in progress");
  const schedule: Schedule = JSON.parse(t.scheduleJson);
  const idx = TRANSFER_STAGES.indexOf(t.status as TransferStatus);
  const next = TRANSFER_STAGES[idx + 1];
  const shift = new Date(schedule[next]!).getTime() - now.getTime();
  if (shift > 0) for (const k of [...TRANSFER_STAGES, "UNIT_DECISION"] as const) if (schedule[k]) schedule[k] = new Date(new Date(schedule[k]!).getTime() - shift).toISOString();
  await prisma.transfer.update({ where: { id: t.id }, data: { scheduleJson: JSON.stringify(schedule) } });
  await audit(user, "TRANSFER_DEMO_SKIP", { patientId, detail: `Demo clock advanced to "${TRANSFER_STATUS[next].label}"` });
  await advanceOne((await prisma.transfer.findUniqueOrThrow({ where: { id: t.id } })), now);
}

export async function cancelTransfer(user: SessionUser, patientId: string, reason: string, now = new Date()) {
  const t = await prisma.transfer.findFirst({ where: { patientId, status: { in: TRANSFER_OPEN } } });
  if (!t) throw new HttpError(404, "No transfer in progress");
  if (t.status === "ARRIVED") throw new HttpError(409, "The patient has already arrived at hospital");
  if (t.incidentRef) await ambulance.cancel(t.incidentRef, reason);
  await hospital.cancel(t.id, reason);
  const timeline: TimelineItem[] = JSON.parse(t.timelineJson || "[]");
  timeline.push({ t: now.toISOString(), kind: "STATUS", text: `Cancelled by ${user.name}: ${reason}. Ambulance stood down; reserved bed released.` });
  await prisma.transfer.update({ where: { id: t.id }, data: { status: "CANCELLED", cancelReason: reason, closedAt: now, timelineJson: JSON.stringify(timeline), bed: null } });
  await audit(user, "TRANSFER_CANCELLED", { patientId, detail: `${t.incidentRef ?? ""} — ${reason}` });
}

export async function tickChecklist(user: SessionUser, patientId: string, itemId: string, done: boolean, now = new Date()) {
  const t = await prisma.transfer.findFirst({ where: { patientId, status: { in: TRANSFER_OPEN } } });
  if (!t) throw new HttpError(404, "No transfer in progress");
  const list: ChecklistItem[] = JSON.parse(t.checklistJson);
  const item = list.find((c) => c.id === itemId);
  if (!item) throw new HttpError(404, "Checklist item not found");
  if (item.owner !== "VIRTUAL_WARD") throw new HttpError(403, "Receiving-unit items are confirmed by the hospital, not the virtual ward");
  Object.assign(item, done ? { done: true, doneAt: now.toISOString(), doneBy: user.name } : { done: false, doneAt: null, doneBy: null });
  await prisma.transfer.update({ where: { id: t.id }, data: { checklistJson: JSON.stringify(list) } });
  await audit(user, "TRANSFER_PREP", { patientId, detail: `${done ? "Done" : "Re-opened"}: ${item.label}` });
}

// ------------------------------------------------------------------ patient / caregiver urgent help
export async function urgentHelp(user: SessionUser, patientId: string, now = new Date()) {
  const ctx = await loadAlertContext(prisma, now);
  const who = user.role === "CAREGIVER" ? `Caregiver ${user.name}` : user.name;
  const a = await raiseAlert(
    prisma,
    patientId,
    { kind: "URGENT_HELP", vital: null, severity: "CRITICAL", title: "Urgent help requested from the app", message: `${who} pressed "I need urgent help" at ${now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}. Call the patient now; request an ambulance transfer if needed. (They were also shown the emergency number ${EMERGENCY_NUMBER}.)` },
    ctx.active,
    [],
    now,
  );
  if (a) await prisma.message.create({ data: { patientId, senderId: user.id, senderName: user.name, senderRole: user.role, body: "🆘 I need urgent help.", createdAt: now } });
  await audit(user, "URGENT_HELP", { patientId, detail: a ? "Critical alert raised for the care team" : "Already raised — existing urgent-help alert still open" });
  return { ok: true, alerted: !!a, emergencyNumber: EMERGENCY_NUMBER };
}

// ------------------------------------------------------------------ read models
const parse = <T,>(s: string, d: T): T => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return d;
  }
};

function patientInstructions(t: Transfer): string[] {
  const s = t.status as TransferStatus;
  const call = `If you feel worse before help arrives, call ${EMERGENCY_NUMBER} straight away.`;
  if (s === "REQUESTED" || s === "DISPATCHED") return ["Unlock the front door and switch on an outside light if it is dark.", "Keep your phone, medicines and any devices next to you.", "Do not eat or drink unless the care team says you can.", call];
  if (s === "ON_SCENE") return ["The ambulance crew is with you and already has your details from the care team."];
  if (s === "TRANSPORTING") return [t.directAdmission ? `You are going straight to the ${t.destination} — you will not wait in the emergency department.` : `You are going to the ${t.destination}. They already have your details.`];
  if (s === "CANCELLED") return ["The care team has cancelled the transfer. They will tell you what happens next.", call];
  return [`You are with the hospital team at the ${t.destination}.`];
}

/** Role-scoped DTO. Patients and caregivers get status, ETA and instructions — not the clinical handover. */
export function transferDto(t: Transfer | null, scope: "clinical" | "patient" | "caregiver", now: Date) {
  if (!t) return null;
  const schedule = parse<Schedule>(t.scheduleJson, { scale: TIME_SCALE, travelMin: 0, transportMin: 0 });
  const status = t.status as TransferStatus;
  const etaAt = status === "REQUESTED" || status === "DISPATCHED" ? schedule.ON_SCENE ?? null : status === "ON_SCENE" || status === "TRANSPORTING" ? schedule.ARRIVED ?? null : null;
  const common = {
    id: t.id,
    status,
    statusLabel: TRANSFER_STATUS[status].label,
    open: TRANSFER_OPEN.includes(status),
    priority: t.priority,
    destination: t.destination,
    hospital: t.hospital,
    directAdmission: t.directAdmission,
    unitStatus: t.unitStatus,
    vehicle: t.vehicle,
    etaAt,
    etaKind: status === "REQUESTED" || status === "DISPATCHED" ? "AT_PATIENT" : etaAt ? "AT_HOSPITAL" : null,
    timeScale: schedule.scale ?? TIME_SCALE,
    simulated: true,
    createdAt: t.createdAt,
    closedAt: t.closedAt,
    emergencyNumber: EMERGENCY_NUMBER,
    ambulanceService: AMBULANCE_SERVICE,
  };
  if (scope !== "clinical") return { ...common, statusLabel: TRANSFER_STATUS[status].patientLabel, instructions: patientInstructions(t) };
  const list = parse<ChecklistItem[]>(t.checklistJson, []);
  return {
    ...common,
    pathway: t.pathway,
    suggestedPathway: t.suggestedPathway,
    reason: t.reason,
    bed: t.bed,
    incidentRef: t.incidentRef,
    pickupAddress: t.pickupAddress,
    accessNotes: t.accessNotes,
    requestedByName: t.requestedByName,
    cancelReason: t.cancelReason,
    stageTimes: Object.fromEntries(TRANSFER_STAGES.map((k) => [k, schedule[k] ?? null])),
    checklist: list,
    unitReady: { done: list.filter((c) => c.owner === "RECEIVING_UNIT" && c.done).length, total: list.filter((c) => c.owner === "RECEIVING_UNIT").length },
    handover: parse<Handover | null>(t.handoverJson, null),
    timeline: parse<TimelineItem[]>(t.timelineJson, []),
    now,
  };
}

/** The transfer to show for a patient: an open one, or one closed in the last 6 hours. */
export async function currentTransfer(patientId: string, now: Date) {
  return prisma.transfer.findFirst({
    where: { patientId, OR: [{ status: { in: TRANSFER_OPEN } }, { closedAt: { gte: new Date(now.getTime() - 6 * 60 * MIN) } }] },
    orderBy: { createdAt: "desc" },
  });
}
