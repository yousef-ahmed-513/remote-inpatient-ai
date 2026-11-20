// Synthetic demo dataset. Every person, reading and event here is invented.
import { randomBytes } from "node:crypto";
import { prisma } from "./db";
import { generate, UNITS } from "./simulator";
import { DEFAULT_LIMITS, type LatestMap, type ThresholdVital, type VitalType } from "./types";

const MIN = 60_000;
const HOUR = 60 * MIN;

type PatientSeed = {
  id: string;
  mrn: string;
  name: string;
  nameAr: string;
  age: number;
  sex: string;
  condition: string;
  pathway: string;
  room: string;
  ward: "A" | "B";
  doctorId: string;
  nurseId: string;
  admittedHoursAgo: number;
  scenario: string;
  address: string; // synthetic
  accessNotes: string;
  carePlan: string[];
  devices: { type: string; name: string; streaming?: boolean; adapter?: string }[];
  meds: { name: string; dose: string; schedule: string }[];
};

const PATIENTS: PatientSeed[] = [
  {
    id: "pt-hart", mrn: "SYN-0001", name: "Amelia Hart", nameAr: "أميليا هارت", age: 54, sex: "F",
    condition: "Post-operative recovery — total knee replacement", pathway: "Surgical early-discharge pathway",
    room: "VR-101", ward: "A", doctorId: "u-dr-rahman", nurseId: "u-rn-carter", admittedHoursAgo: 70, scenario: "STABLE", address: "14 Orchard Row, Riverside (synthetic address)", accessNotes: "Ground-floor flat, blue door. Key safe code held by the virtual ward.",
    carePlan: ["Continuous vitals via wearable patch", "Twice-daily nurse video check-in", "Physiotherapy exercises 3× daily", "Wound photo review every morning", "Planned virtual discharge review on day 5"],
    devices: [{ type: "WEARABLE_PATCH", name: "CardioPatch S1" }, { type: "PULSE_OXIMETER", name: "OxiRing Pulse Oximeter" }, { type: "BP_MONITOR", name: "CuffLink BP Monitor" }],
    meds: [{ name: "Paracetamol", dose: "1 g", schedule: "Every 6 hours" }, { name: "Enoxaparin", dose: "40 mg SC", schedule: "Once daily (evening)" }],
  },
  {
    id: "pt-okoro", mrn: "SYN-0002", name: "Samuel Okoro", nameAr: "صامويل أوكورو", age: 67, sex: "M",
    condition: "COPD exacerbation — respiratory monitoring", pathway: "Respiratory hospital-at-home",
    room: "VR-102", ward: "A", doctorId: "u-dr-rahman", nurseId: "u-rn-carter", admittedHoursAgo: 46, scenario: "RESP", address: "7 Hillcrest Avenue, Northgate (synthetic address)", accessNotes: "First floor, lift available. Home oxygen concentrator in living room. Caregiver Grace on site evenings.",
    carePlan: ["Continuous SpO₂ and respiratory-rate monitoring", "Report any increase in breathlessness straight away", "Nurse call every 4 hours while awake", "Home oxygen as prescribed by the care team", "Caregiver (Grace) helps him use the oximeter for the evening spot check (uploads automatically)"],
    devices: [{ type: "WEARABLE_PATCH", name: "CardioPatch S1" }, { type: "PULSE_OXIMETER", name: "OxiRing Pulse Oximeter" }, { type: "BP_MONITOR", name: "CuffLink BP Monitor" }],
    meds: [{ name: "Salbutamol inhaler", dose: "2 puffs", schedule: "Every 4–6 hours as needed" }, { name: "Prednisolone", dose: "30 mg", schedule: "Once daily (morning)" }, { name: "Doxycycline", dose: "100 mg", schedule: "Once daily" }],
  },
  {
    id: "pt-haddad", mrn: "SYN-0003", name: "Layla Haddad", nameAr: "ليلى حداد", age: 61, sex: "F",
    condition: "Heart failure — cardiac monitoring", pathway: "Cardiac hospital-at-home",
    room: "VR-103", ward: "A", doctorId: "u-dr-whitfield", nurseId: "u-rn-aziz", admittedHoursAgo: 94, scenario: "CARDIAC", address: "22 Marina Court, Harbour District (synthetic address)", accessNotes: "Third floor, lift to Level 3. Parking bay in front of building C.",
    carePlan: ["Continuous single-lead ECG patch (simulated)", "Daily weight before breakfast", "Fluid intake diary", "Cardiology review every 48 hours", "Report palpitations, dizziness or ankle swelling"],
    devices: [{ type: "WEARABLE_PATCH", name: "CardioPatch ECG S1" }, { type: "PULSE_OXIMETER", name: "OxiRing Pulse Oximeter" }, { type: "BP_MONITOR", name: "CuffLink BP Monitor" }, { type: "SCALE", name: "BalanceOne Smart Scale", streaming: false }],
    meds: [{ name: "Furosemide", dose: "40 mg", schedule: "Once daily (morning)" }, { name: "Bisoprolol", dose: "2.5 mg", schedule: "Once daily" }, { name: "Ramipril", dose: "5 mg", schedule: "Once daily" }],
  },
  {
    id: "pt-berg", mrn: "SYN-0004", name: "Thomas Berg", nameAr: "توماس بيرغ", age: 72, sex: "M",
    condition: "Lower-limb cellulitis — IV antibiotics at home", pathway: "Outpatient parenteral antibiotic therapy",
    room: "VR-104", ward: "A", doctorId: "u-dr-whitfield", nurseId: "u-rn-carter", admittedHoursAgo: 52, scenario: "DISCONNECT", address: "3 Mill Lane, Westfield (synthetic address)", accessNotes: "Detached house, side gate. Patient has limited mobility — will need carry chair.",
    carePlan: ["Continuous temperature and heart-rate monitoring", "Daily visiting-nurse IV antibiotic dose", "Leg elevation and skin marking review", "Escalate if temperature or redness increases"],
    devices: [{ type: "WEARABLE_PATCH", name: "CardioPatch S1" }, { type: "THERMOMETER", name: "ThermoDot Skin Sensor" }],
    meds: [{ name: "Ceftriaxone", dose: "2 g IV", schedule: "Once daily (visiting nurse)" }, { name: "Paracetamol", dose: "1 g", schedule: "Every 6 hours as needed" }],
  },
  {
    id: "pt-nair", mrn: "SYN-0005", name: "Priya Nair", nameAr: "بريا ناير", age: 45, sex: "F",
    condition: "Type 2 diabetes — glucose stabilisation", pathway: "Metabolic step-down pathway",
    room: "VR-201", ward: "B", doctorId: "u-dr-rahman", nurseId: "u-rn-aziz", admittedHoursAgo: 30, scenario: "MISSED_CHECKIN", address: "41 Palm Gardens, Eastside (synthetic address)", accessNotes: "Villa 41, gate intercom. Lives with partner.",
    carePlan: ["Glucose and blood pressure every 4 hours — meter and cuff upload automatically via the home hub", "Insulin titration reviewed daily by the care team", "Dietitian call on day 2", "Report symptoms of low blood sugar immediately"],
    // Spot-check devices paired to a cellular home hub: readings upload automatically when used.
    devices: [{ type: "GLUCOMETER", name: "GlucoCheck BLE Glucose Meter", streaming: false, adapter: "GATEWAY" }, { type: "BP_MONITOR", name: "CuffLink BLE BP Cuff", streaming: false, adapter: "GATEWAY" }],
    meds: [{ name: "Insulin glargine", dose: "18 units", schedule: "Once daily (night)" }, { name: "Metformin", dose: "1 g", schedule: "Twice daily with food" }],
  },
  {
    id: "pt-reyes", mrn: "SYN-0006", name: "Daniel Reyes", nameAr: "دانيال رييس", age: 58, sex: "M",
    condition: "Community-acquired pneumonia — admitted today", pathway: "Respiratory hospital-at-home",
    room: "VR-202", ward: "B", doctorId: "u-dr-whitfield", nurseId: "u-rn-aziz", admittedHoursAgo: 0.7, scenario: "AWAITING", address: "9 Station Road, Central (synthetic address)", accessNotes: "Apartment 5B, buzzer 5B. Spouse at home.",
    carePlan: ["Draft plan — pending admission assessment by the doctor", "Continuous SpO₂, heart rate and temperature monitoring"],
    devices: [{ type: "WEARABLE_PATCH", name: "CardioPatch S1" }, { type: "PULSE_OXIMETER", name: "OxiRing Pulse Oximeter" }, { type: "THERMOMETER", name: "ThermoDot Skin Sensor" }],
    meds: [{ name: "Amoxicillin", dose: "500 mg", schedule: "Three times daily" }],
  },
];

const USERS = [
  { id: "u-admin", name: "Morgan Lee", email: "admin@demo.remote-inpatient.ai", role: "ADMIN", title: "Programme administrator", patientId: null },
  { id: "u-dr-rahman", name: "Dr. Sara Rahman", email: "s.rahman@demo.remote-inpatient.ai", role: "DOCTOR", title: "Consultant physician", patientId: null },
  { id: "u-dr-whitfield", name: "Dr. James Whitfield", email: "j.whitfield@demo.remote-inpatient.ai", role: "DOCTOR", title: "Cardiology registrar", patientId: null },
  { id: "u-rn-carter", name: "Emily Carter, RN", email: "e.carter@demo.remote-inpatient.ai", role: "NURSE", title: "Virtual ward nurse", patientId: null },
  { id: "u-rn-aziz", name: "Omar Aziz, RN", email: "o.aziz@demo.remote-inpatient.ai", role: "NURSE", title: "Virtual ward nurse", patientId: null },
  { id: "u-pt-okoro", name: "Samuel Okoro", email: "samuel@demo.remote-inpatient.ai", role: "PATIENT", title: "Patient · respiratory scenario", patientId: "pt-okoro" },
  { id: "u-pt-nair", name: "Priya Nair", email: "priya@demo.remote-inpatient.ai", role: "PATIENT", title: "Patient · manual check-ins", patientId: "pt-nair" },
  { id: "u-pt-hart", name: "Amelia Hart", email: "amelia@demo.remote-inpatient.ai", role: "PATIENT", title: "Patient · stable recovery", patientId: "pt-hart" },
  { id: "u-cg-okoro", name: "Grace Okoro", email: "grace@demo.remote-inpatient.ai", role: "CAREGIVER", title: "Caregiver for Samuel Okoro", patientId: "pt-okoro" },
];

export async function isSeeded() {
  return (await prisma.user.count()) > 0;
}

const seedLock = globalThis as unknown as { __riaSeeding?: Promise<void> };
/** Seeds on first use so `npm run dev` works with an empty database. */
export async function ensureSeeded() {
  if (await isSeeded()) return;
  seedLock.__riaSeeding ??= seedDatabase().finally(() => (seedLock.__riaSeeding = undefined));
  await seedLock.__riaSeeding;
}

export async function seedDatabase(now = new Date()) {
  const t0 = now.getTime();
  // The access log is wiped below, so forget which record views were already logged.
  (globalThis as unknown as { __riaViews?: Map<string, number> }).__riaViews?.clear();
  // Wipe (children first).
  await prisma.auditLog.deleteMany();
  await prisma.transfer.deleteMany();
  await prisma.aiSummary.deleteMany();
  await prisma.consult.deleteMany();
  await prisma.medicationLog.deleteMany();
  await prisma.medication.deleteMany();
  await prisma.message.deleteMany();
  await prisma.task.deleteMany();
  await prisma.note.deleteMany();
  await prisma.symptom.deleteMany();
  await prisma.alert.deleteMany();
  await prisma.threshold.deleteMany();
  await prisma.ecgStrip.deleteMany();
  await prisma.reading.deleteMany();
  await prisma.device.deleteMany();
  await prisma.patient.deleteMany();
  await prisma.ward.deleteMany();
  await prisma.user.deleteMany();
  await prisma.simState.deleteMany();

  await prisma.ward.createMany({
    data: [
      { id: "ward-a", name: "Virtual Ward A — Acute medical", capacity: 8 },
      { id: "ward-b", name: "Virtual Ward B — Step-down", capacity: 6 },
    ],
  });
  await prisma.user.createMany({ data: USERS });

  // Programme-default monitoring limits + one per-patient override (clinician-configured).
  await prisma.threshold.createMany({
    data: (Object.keys(DEFAULT_LIMITS) as ThresholdVital[]).map((vital) => ({ patientId: null, vital, ...DEFAULT_LIMITS[vital], updatedBy: "Programme default" })),
  });

  const readings: { patientId: string; deviceId: string | null; type: string; value: number; value2?: number | null; unit: string; source: string; takenAt: Date }[] = [];

  for (const p of PATIENTS) {
    const admittedAt = new Date(t0 - p.admittedHoursAgo * HOUR);
    const latest: LatestMap = {};
    const add = (type: VitalType, value: number, at: Date, deviceId: string | null, source: string, value2?: number) => {
      readings.push({ patientId: p.id, deviceId, type, value, value2: value2 ?? null, unit: UNITS[type], source, takenAt: at });
      latest[type] = { v: value, v2: value2 ?? null, t: at.toISOString(), src: source };
    };

    await prisma.patient.create({
      data: {
        id: p.id, mrn: p.mrn, name: p.name, nameAr: p.nameAr, age: p.age, sex: p.sex, condition: p.condition, pathway: p.pathway, room: p.room,
        wardId: p.ward === "A" ? "ward-a" : "ward-b", doctorId: p.doctorId, nurseId: p.nurseId, admittedAt,
        carePlan: JSON.stringify(p.carePlan), scenario: p.scenario, awaitingAssessment: p.scenario === "AWAITING", address: p.address, accessNotes: p.accessNotes,
        lastContactAt: new Date(t0 - (p.scenario === "MISSED_CHECKIN" ? 4 * HOUR : p.scenario === "AWAITING" ? 35 * MIN : 95 * MIN)),
        // Priya's next check-in falls due 30 s after seeding, so the overdue event can be watched live.
        nextCheckInDueAt: p.scenario === "MISSED_CHECKIN" ? new Date(t0 + 30_000) : null,
      },
    });

    const deviceIds: Record<string, string> = {};
    const gateway = p.devices.some((d) => d.adapter === "GATEWAY");
    const hubId = gateway ? `${p.id}-hub` : null;
    if (hubId) {
      // Pre-provisioned by the virtual-ward nurse at admission. Its token is not known to anyone in the
      // demo (only a hash exists); "Send demo upload" exercises the same ingest path server-side.
      await prisma.device.create({
        data: { id: hubId, patientId: p.id, name: "CareHub H2 cellular home hub", deviceType: "HOME_HUB", adapter: "GATEWAY", streaming: false, status: "CONNECTED", battery: 100, serial: `HUB-${p.mrn.slice(-4)}`, tokenHash: randomBytes(32).toString("hex"), tokenHint: "demo", lastSeenAt: new Date(t0 - 4 * HOUR) },
      });
    }
    const PREFIX: Record<string, string> = { WEARABLE_PATCH: "CPS", PULSE_OXIMETER: "OXR", BP_MONITOR: "BPC", THERMOMETER: "TMD", GLUCOMETER: "GLC", SCALE: "SCL" };
    for (const [i, d] of p.devices.entries()) {
      const id = `${p.id}-dev${i + 1}`;
      deviceIds[d.type] = id;
      await prisma.device.create({
        data: {
          id, patientId: p.id, name: d.name, deviceType: d.type, adapter: d.adapter ?? "SIMULATED", streaming: d.streaming ?? true,
          battery: 62 + ((i * 13 + p.age) % 35), status: "CONNECTED", lastSeenAt: d.streaming === false ? new Date(t0 - 4 * HOUR) : now,
          serial: `${PREFIX[d.type] ?? "DEV"}-${p.mrn.slice(-4)}-${i + 1}`, hubId: d.adapter === "GATEWAY" ? hubId : null,
        },
      });
    }
    const dev = (...types: string[]) => types.map((t) => deviceIds[t]).find(Boolean) ?? null;

    const streaming = p.devices.some((d) => d.streaming !== false);
    if (streaming) {
      // History: one reading set every 5 min for up to 6 h (never before admission).
      const span = Math.min(6 * HOUR, p.admittedHoursAgo * HOUR);
      const steps = Math.floor(span / (5 * MIN));
      for (let i = steps; i >= 0; i--) {
        const at = new Date(t0 - i * 5 * MIN);
        const v = generate(p.scenario, "baseline", 0).vals;
        add("HR", v.hr, at, dev("WEARABLE_PATCH"), "SIMULATED_DEVICE");
        add("SPO2", v.spo2, at, dev("PULSE_OXIMETER", "WEARABLE_PATCH"), "SIMULATED_DEVICE");
        add("RR", v.rr, at, dev("WEARABLE_PATCH"), "SIMULATED_DEVICE");
        if (i % 6 === 0) {
          if (deviceIds.BP_MONITOR) add("BP", v.sys, at, deviceIds.BP_MONITOR, "SIMULATED_DEVICE", v.dia);
          add("TEMP", v.temp, at, dev("THERMOMETER", "WEARABLE_PATCH"), "SIMULATED_DEVICE");
        }
        if (i % 36 === 18 && p.scenario === "STABLE") add("GLUCOSE", v.glucose, at, null, "CLINICIAN_ENTERED");
      }
    } else {
      // Spot-check patient: three scheduled measurements uploaded by the home hub, the latest 4 h ago.
      for (const hoursAgo of [12, 8, 4]) {
        const at = new Date(t0 - hoursAgo * HOUR);
        const v = generate(p.scenario, "baseline", 0).vals;
        add("GLUCOSE", v.glucose, at, deviceIds.GLUCOMETER ?? null, "DEVICE_HUB");
        add("BP", v.sys, at, deviceIds.BP_MONITOR ?? null, "DEVICE_HUB", v.dia);
        add("HR", v.hr, at, deviceIds.BP_MONITOR ?? null, "DEVICE_HUB");
      }
    }
    if (deviceIds.SCALE) {
      [78.4, 78.1, 77.9].forEach((kg, i) => add("WEIGHT", kg, new Date(t0 - (2 - i) * 24 * HOUR - 3 * HOUR), deviceIds.SCALE, "SIMULATED_DEVICE"));
    }
    const lastAt = Object.values(latest).reduce<string | null>((m, x) => (!m || (x && x.t > m) ? (x?.t ?? m) : m), null);
    await prisma.patient.update({ where: { id: p.id }, data: { latestJson: JSON.stringify(latest), lastReadingAt: lastAt ? new Date(lastAt) : null } });

    await prisma.medication.createMany({ data: p.meds.map((m) => ({ patientId: p.id, ...m })) });

    if (deviceIds.WEARABLE_PATCH) {
      await prisma.ecgStrip.create({
        data: { patientId: p.id, deviceId: deviceIds.WEARABLE_PATCH, takenAt: new Date(t0 - 50 * MIN), heartRate: latest.HR?.v ?? 74, irregular: false, seed: 1000 + p.age, label: "Scheduled 10 s strip" },
      });
    }
  }
  // Insert history in chunks (SQLite variable limit).
  for (let i = 0; i < readings.length; i += 400) await prisma.reading.createMany({ data: readings.slice(i, i + 400) });

  await prisma.threshold.create({
    data: { patientId: "pt-okoro", vital: "SPO2", critLow: 90, warnLow: 93, warnHigh: null, critHigh: null, updatedBy: "Dr. Sara Rahman" },
  });

  // Earlier (resolved) alerts so response-time analytics have real records to compute from.
  const past = [
    { patientId: "pt-hart", vital: "TEMP", title: "Temperature 38.2 °C — above review limit", ago: 26 * HOUR, ack: 3 * MIN, res: 24 * MIN, ackBy: "u-rn-carter", resBy: "u-dr-rahman", note: "Reviewed by video. Repeat temperature 37.4 °C after 30 minutes. Continue plan." },
    { patientId: "pt-haddad", vital: "HR", title: "Heart rate 114 bpm — above review limit", ago: 9 * HOUR, ack: 5 * MIN, res: 31 * MIN, ackBy: "u-rn-aziz", resBy: "u-dr-whitfield", note: "Patient had just climbed stairs. Settled to 82 bpm at rest. No action needed." },
    { patientId: "pt-berg", vital: "BP_SYS", title: "Systolic BP 92 mmHg — below review limit", ago: 14 * HOUR, ack: 2 * MIN, res: 18 * MIN, ackBy: "u-rn-carter", resBy: "u-rn-carter", note: "Repeat reading 108/70 seated. Cuff had been positioned incorrectly." },
  ];
  for (const a of past) {
    const createdAt = new Date(t0 - a.ago);
    await prisma.alert.create({
      data: {
        patientId: a.patientId, kind: "THRESHOLD", vital: a.vital, severity: "WARNING", title: a.title,
        message: "Rule-based demo alert — reading crossed the configured review limit.", status: "RESOLVED", createdAt,
        acknowledgedAt: new Date(createdAt.getTime() + a.ack), acknowledgedById: a.ackBy,
        resolvedAt: new Date(createdAt.getTime() + a.res), resolvedById: a.resBy, resolutionNote: a.note,
      },
    });
  }

  const U = Object.fromEntries(USERS.map((u) => [u.id, u]));
  const note = (patientId: string, authorId: string, kind: string, body: string, ago: number) => ({
    patientId, authorId, authorName: U[authorId].name, authorRole: U[authorId].role, kind, body, createdAt: new Date(t0 - ago),
  });
  await prisma.note.createMany({
    data: [
      note("pt-hart", "u-dr-rahman", "ASSESSMENT", "Day 3 post total knee replacement. Pain controlled, mobilising with frame. Suitable to continue on the early-discharge pathway.", 20 * HOUR),
      note("pt-hart", "u-rn-carter", "CHECKIN", "Morning video check-in. Wound dry, no redness on photo. Completed physiotherapy set.", 95 * MIN),
      note("pt-okoro", "u-dr-rahman", "ASSESSMENT", "COPD exacerbation day 2. Breathing easier than on admission. Per-patient SpO₂ review limit set to 93%, critical limit 90%.", 22 * HOUR),
      note("pt-okoro", "u-rn-carter", "CHECKIN", "Phone check-in. Speaking in full sentences. Using inhaler as directed. Grace present.", 95 * MIN),
      note("pt-haddad", "u-dr-whitfield", "ASSESSMENT", "Heart failure, day 4. Weight trending down 0.5 kg over 48 h. Continue ECG patch monitoring (simulated device).", 18 * HOUR),
      note("pt-berg", "u-rn-carter", "OBSERVATION", "Visiting nurse gave IV dose. Skin marking unchanged. Patient reports patch adhesive is peeling.", 5 * HOUR),
      note("pt-nair", "u-rn-aziz", "CHECKIN", "Hub-uploaded glucose reviewed with patient. Next scheduled measurement in 4 hours' time.", 4 * HOUR),
      note("pt-reyes", "u-rn-aziz", "OBSERVATION", "Devices fitted and transmitting. Awaiting admission assessment by Dr. Whitfield.", 35 * MIN),
    ],
  });

  const task = (patientId: string, title: string, assigneeRole: string, dueIn: number, by = "u-rn-carter") => ({
    patientId, title, assigneeRole, dueAt: new Date(t0 + dueIn), createdById: by, createdByName: U[by].name, createdAt: new Date(t0 - 3 * HOUR),
  });
  await prisma.task.createMany({
    data: [
      task("pt-hart", "Afternoon video check-in and wound photo review", "NURSE", 2 * HOUR),
      task("pt-hart", "Complete physiotherapy exercise set", "PATIENT", 3 * HOUR),
      task("pt-okoro", "4-hourly respiratory check-in call", "NURSE", 1 * HOUR),
      task("pt-okoro", "Help Samuel put on the oximeter for the evening spot check", "CAREGIVER", 5 * HOUR),
      task("pt-okoro", "Record how your breathing feels this evening", "PATIENT", 5 * HOUR),
      task("pt-haddad", "Review daily weight and fluid diary", "NURSE", 90 * MIN, "u-rn-aziz"),
      task("pt-haddad", "48-hour cardiology review", "DOCTOR", 6 * HOUR, "u-rn-aziz"),
      task("pt-berg", "Confirm visiting-nurse IV dose for tomorrow", "NURSE", 4 * HOUR),
      task("pt-nair", "Use your glucose meter and BP cuff (readings upload automatically)", "PATIENT", 30_000, "u-rn-aziz"),
      task("pt-nair", "Daily insulin titration review", "DOCTOR", 5 * HOUR, "u-rn-aziz"),
      task("pt-reyes", "Complete admission assessment", "DOCTOR", 20 * MIN, "u-rn-aziz"),
    ],
  });

  const msg = (patientId: string, senderId: string, body: string, ago: number) => ({
    patientId, senderId, senderName: U[senderId].name, senderRole: U[senderId].role, body, createdAt: new Date(t0 - ago),
  });
  await prisma.message.createMany({
    data: [
      msg("pt-okoro", "u-rn-carter", "Good morning Samuel — how was your night? Any change in your breathing?", 3 * HOUR),
      msg("pt-okoro", "u-pt-okoro", "Slept alright, thank you. A bit of a cough when I woke but it settled.", 170 * MIN),
      msg("pt-okoro", "u-cg-okoro", "Grace here — I'll be with him this evening for the spot check.", 160 * MIN),
      msg("pt-nair", "u-rn-aziz", "Hi Priya, your next glucose and blood-pressure measurement is due soon — just use your meter and cuff, the readings reach us automatically.", 20 * MIN),
      msg("pt-hart", "u-rn-carter", "Lovely to see you walking this morning, Amelia. Wound looks good on the photo.", 90 * MIN),
    ],
  });

  await prisma.simState.create({ data: { id: 1, running: false, tick: 0, speed: 1, pausedAt: now, seededAt: now } });
  await prisma.auditLog.create({ data: { userName: "System", userRole: "SYSTEM", action: "DEMO_SEEDED", detail: "Synthetic demo dataset loaded (6 patients)" } });
}
