// End-to-end API test of the demo storyline + backend permission model.
// Run against a running server:  npm run dev   (other terminal)   npm run test:e2e
// NOTE: resets the demo data at the start and at the end.
const BASE = process.env.BASE_URL ?? "http://localhost:3210";

type Json = Record<string, any>;
class Session {
  cookie = "";
  constructor(public label: string) {}
  async call(method: string, path: string, body?: unknown): Promise<{ status: number; data: Json }> {
    const res = await fetch(BASE + path, {
      method,
      headers: { "content-type": "application/json", ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0];
    return { status: res.status, data: (await res.json().catch(() => ({}))) as Json };
  }
  get = (p: string) => this.call("GET", p);
  post = (p: string, b?: unknown) => this.call("POST", p, b ?? {});
  patch = (p: string, b?: unknown) => this.call("PATCH", p, b ?? {});
  async login(userId: string) {
    const r = await this.post("/api/auth", { userId });
    if (r.status !== 200) throw new Error(`login ${userId} failed: ${r.status}`);
    return this;
  }
}

let passed = 0;
let failed = 0;
function check(name: string, cond: unknown, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} ${extra}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 45_000): Promise<T | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(350);
  }
  console.log(`  … timed out waiting for: ${what}`);
  return null;
}

async function main() {
  const anon = new Session("anon");
  const nurse = await new Session("nurse").login("u-rn-carter");
  const doctor = await new Session("doctor").login("u-dr-rahman");
  const admin = await new Session("admin").login("u-admin");
  const samuel = await new Session("patient").login("u-pt-okoro");
  const priya = await new Session("patient2").login("u-pt-nair");
  const grace = await new Session("caregiver").login("u-cg-okoro");
  const P = (ward: Json, id: string) => ward.patients.find((p: Json) => p.id === id);

  console.log("\n1. Reset + starting state");
  check("reset demo", (await nurse.post("/api/sim", { action: "reset" })).status === 200);
  let ward = (await nurse.get("/api/ward")).data;
  check("six synthetic patients on the ward", ward.patients?.length === 6);
  check("Amelia starts stable", P(ward, "pt-hart").state === "STABLE", P(ward, "pt-hart").state);
  check("Daniel is awaiting clinician assessment", P(ward, "pt-reyes").state === "AWAITING_ASSESSMENT", P(ward, "pt-reyes").state);
  check("no active alerts at start", ward.alerts.length === 0, `(${ward.alerts.length})`);
  check("simulator starts paused", ward.sim.running === false);

  console.log("\n2. Backend permissions");
  check("signed-out request → 401", (await anon.get("/api/ward")).status === 401);
  check("signed-out patient write → 401", (await anon.post("/api/patients/pt-hart/notes", { kind: "NOTE", body: "x y z" })).status === 401);
  check("patient cannot open the ward → 403", (await samuel.get("/api/ward")).status === 403);
  check("patient can read own record", (await samuel.get("/api/patients/pt-okoro")).status === 200);
  check("patient cannot read another patient → 403", (await samuel.get("/api/patients/pt-hart")).status === 403);
  check("patient cannot write to another patient → 403", (await samuel.post("/api/patients/pt-hart/messages", { body: "hello" })).status === 403);
  const own = (await samuel.get("/api/patients/pt-okoro")).data;
  check("patient view has no clinician notes / AI summaries / alert internals", own.notes === undefined && own.summaries === undefined && own.alerts === undefined);
  const cg = (await grace.get("/api/patients/pt-okoro")).data;
  check("caregiver gets restricted overview (no history, symptoms, notes)", cg.scope === "caregiver" && cg.series === undefined && cg.symptoms === undefined && cg.notes === undefined);
  check("caregiver sees only caregiver tasks", cg.tasks.length > 0 && cg.tasks.every((t: Json) => t.assigneeRole === "CAREGIVER"));
  check("caregiver cannot read another patient → 403", (await grace.get("/api/patients/pt-nair")).status === 403);
  check("admin cannot open a clinical record → 403", (await admin.get("/api/patients/pt-okoro")).status === 403);
  check("nurse cannot change monitoring limits → 403", (await nurse.post("/api/patients/pt-okoro/thresholds", { vital: "HR", warnHigh: 100 })).status === 403);
  check("nurse cannot record a doctor's assessment → 403", (await nurse.post("/api/patients/pt-reyes/notes", { kind: "ASSESSMENT", body: "assessment text" })).status === 403);
  check("doctor cannot use admin API → 403", (await doctor.get("/api/admin")).status === 403);
  check("patient cannot write clinical notes → 403", (await samuel.post("/api/patients/pt-okoro/notes", { kind: "NOTE", body: "abc def" })).status === 403);
  check("patient cannot generate AI summary → 403", (await samuel.post("/api/patients/pt-okoro/summary")).status === 403);
  check("patient cannot type readings — devices upload automatically → 403", (await samuel.post("/api/patients/pt-okoro/readings", { readings: [{ type: "SPO2", value: 95 }] })).status === 403);
  check("invalid reading rejected → 400", (await nurse.post("/api/patients/pt-okoro/readings", { readings: [{ type: "SPO2", value: 140 }] })).status === 400);

  console.log("\n3. Live simulation → respiratory deterioration (×5 speed)");
  await nurse.post("/api/sim", { action: "speed", speed: 5 });
  check("start simulation", (await nurse.post("/api/sim", { action: "start" })).status === 200);
  const crit = await until("Samuel critical", async () => {
    ward = (await nurse.get("/api/ward")).data;
    return P(ward, "pt-okoro").state === "CRITICAL" ? ward : null;
  });
  check("Samuel reaches 'Critical demo alert' from declining SpO₂", !!crit);
  const kinds = new Set(ward.alerts.filter((a: Json) => a.patientId === "pt-okoro").map((a: Json) => a.kind));
  check("threshold + trend + symptom alerts were raised", kinds.has("THRESHOLD") && kinds.has("TREND") && kinds.has("SYMPTOM"), [...kinds].join(","));
  const rec = (await nurse.get("/api/patients/pt-okoro?window=15")).data;
  check("simulated breathlessness symptom recorded", rec.symptoms.some((s: Json) => /short of breath/i.test(s.text)));
  check("readings are stored with source SIMULATED_DEVICE", rec.series.SPO2.at(-1).src === "SIMULATED_DEVICE");
  check("SpO₂ history shows the decline", rec.series.SPO2.at(-1).v < 90 && rec.series.SPO2[0].v >= 94, `${rec.series.SPO2[0].v} → ${rec.series.SPO2.at(-1).v}`);

  console.log("\n4. Other scenarios");
  const disc = await until("Thomas disconnected", async () => {
    ward = (await nurse.get("/api/ward")).data;
    return P(ward, "pt-berg").state === "DEVICE_DISCONNECTED";
  });
  check("Thomas shows 'Device disconnected' (not stable)", !!disc);
  check("connectivity alert raised", ward.alerts.some((a: Json) => a.patientId === "pt-berg" && a.kind === "CONNECTIVITY"));
  const before = P(ward, "pt-berg").lastReadingAt;
  await sleep(2500);
  ward = (await nurse.get("/api/ward")).data;
  check("no readings are fabricated while disconnected", P(ward, "pt-berg").lastReadingAt === before);
  const rhythm = await until("cardiac flag", async () => {
    ward = (await nurse.get("/api/ward")).data;
    return ward.alerts.some((a: Json) => a.patientId === "pt-haddad" && a.kind === "RHYTHM_FLAG");
  });
  check("simulated irregular-rhythm flag raised for Layla", !!rhythm);
  const layla = (await doctor.get("/api/patients/pt-haddad")).data;
  check("irregular ECG strip stored and labelled", layla.ecg.strips.some((s: Json) => s.irregular) && layla.ecg.irregular === true);
  await nurse.post("/api/sim", { action: "trigger", scenario: "MISSED_CHECKIN" });
  ward = (await nurse.get("/api/ward")).data;
  check("Priya shows 'No recent data' after a missed check-in", P(ward, "pt-nair").state === "NO_RECENT_DATA", P(ward, "pt-nair").state);
  check("overdue check-in alert raised", ward.alerts.some((a: Json) => a.patientId === "pt-nair" && a.kind === "CHECKIN_OVERDUE"));
  check("Amelia is still stable", P(ward, "pt-hart").state === "STABLE", P(ward, "pt-hart").state);

  console.log("\n5. Alert workflow: acknowledge → escalate → AI summary → resolve");
  const critAlert = ward.alerts.find((a: Json) => a.patientId === "pt-okoro" && a.severity === "CRITICAL");
  check("patient cannot acknowledge alerts → 403", (await samuel.patch(`/api/alerts/${critAlert.id}`, { action: "acknowledge" })).status === 403);
  check("nurse acknowledges", (await nurse.patch(`/api/alerts/${critAlert.id}`, { action: "acknowledge" })).status === 200);
  check("double acknowledge → 409", (await nurse.patch(`/api/alerts/${critAlert.id}`, { action: "acknowledge" })).status === 409);
  check("doctor cannot escalate (nurse action) → 403", (await doctor.patch(`/api/alerts/${critAlert.id}`, { action: "escalate" })).status === 403);
  check("nurse escalates to doctor", (await nurse.patch(`/api/alerts/${critAlert.id}`, { action: "escalate", note: "SpO2 falling, patient breathless" })).status === 200);
  const sum = await doctor.post("/api/patients/pt-okoro/summary");
  const text = JSON.stringify(sum.data.doc ?? {});
  check("AI-assisted summary generated", sum.status === 200 && sum.data.doc?.headline?.length > 10, sum.data.engine);
  check("summary cites SpO₂ and the breathlessness report", /Oxygen saturation|SpO/.test(text) && /short of breath/i.test(text));
  check("summary carries the non-diagnostic disclaimer", /does not diagnose/.test(sum.data.doc?.disclaimer ?? ""));
  console.log(`    engine: ${sum.data.engine}`);
  check("resolve without a note → 400", (await doctor.patch(`/api/alerts/${critAlert.id}`, { action: "resolve" })).status === 400);
  check("doctor resolves with a note", (await doctor.patch(`/api/alerts/${critAlert.id}`, { action: "resolve", note: "Called patient; reviewed inhaler technique and oxygen per care plan." })).status === 200);
  const recov = await until("scripted recovery", async () => {
    const r = (await doctor.get("/api/patients/pt-okoro?window=5")).data;
    return r.latest.SPO2.v >= 94 ? r : null;
  });
  check("scripted recovery phase follows resolution (SpO₂ back ≥ 94%)", !!recov);
  const tl = (await doctor.get("/api/patients/pt-okoro")).data;
  const actions = tl.timeline.map((t: Json) => t.action);
  check("timeline keeps acknowledge / escalate / resolve history", ["ALERT_ACKNOWLEDGED", "ALERT_ESCALATED", "ALERT_RESOLVED", "AI_SUMMARY_GENERATED"].every((a) => actions.includes(a)));
  check("resolved alert stores who/when/note", tl.alerts.some((a: Json) => a.id === critAlert.id && a.status === "RESOLVED" && a.resolvedBy && a.resolutionNote));

  console.log("\n6. Patient + caregiver actions");
  check("Priya cannot type her readings (automatic devices) → 403", (await priya.post("/api/patients/pt-nair/readings", { readings: [{ type: "GLUCOSE", value: 268 }] })).status === 403);
  const sub = await nurse.post("/api/patients/pt-nair/hub-demo", { scenario: "HIGH" });
  check("home hub uploads Priya's meter + cuff readings (FHIR) with no patient input", sub.status === 200 && sub.data.format === "fhir" && sub.data.byType?.GLUCOSE === 1 && sub.data.byType?.BP === 1, JSON.stringify(sub.data));
  check("mmol/L from the meter stored as mg/dL", (await doctor.get("/api/patients/pt-nair")).data.latest.GLUCOSE?.v === 268);
  check("the upload counts as the scheduled measurement", sub.data.scheduledMeasurementMet === true);
  check("high glucose raised a rule-based alert", sub.data.alertsRaised >= 1);
  await sleep(1200);
  ward = (await nurse.get("/api/ward")).data;
  check("overdue check-in alert auto-cleared once data arrived", !ward.alerts.some((a: Json) => a.patientId === "pt-nair" && a.kind === "CHECKIN_OVERDUE"));
  check("Priya no longer 'No recent data'", P(ward, "pt-nair").state !== "NO_RECENT_DATA", P(ward, "pt-nair").state);
  check("patient reports a symptom", (await samuel.post("/api/patients/pt-okoro/symptoms", { text: "Chest feels tight after climbing stairs", severity: "MODERATE" })).status === 200);
  check("patient sends a secure message", (await samuel.post("/api/patients/pt-okoro/messages", { body: "Is my evening call still on?" })).status === 200);
  check("patient requests a consultation", (await samuel.post("/api/patients/pt-okoro/consult", { reason: "Breathing worse today" })).status === 200);
  check("caregiver cannot type readings by default → 403", (await grace.post("/api/patients/pt-okoro/readings", { readings: [{ type: "SPO2", value: 95 }] })).status === 403);
  check("patient cannot switch manual entry on → 403", (await samuel.post("/api/patients/pt-okoro/manual-entry", { enabled: true, reason: "test" })).status === 403);
  check("enabling the fallback needs a reason → 400", (await doctor.post("/api/patients/pt-okoro/manual-entry", { enabled: true, reason: "" })).status === 400);
  check("doctor enables manual-entry fallback (faulty oximeter)", (await doctor.post("/api/patients/pt-okoro/manual-entry", { enabled: true, reason: "Oximeter not pairing — temporary backup" })).status === 200);
  check("caregiver records a backup spot check", (await grace.post("/api/patients/pt-okoro/readings", { readings: [{ type: "SPO2", value: 95 }], comment: "Evening spot check" })).status === 200);
  const gt = (await grace.get("/api/patients/pt-okoro")).data.tasks.find((t: Json) => t.status === "OPEN");
  check("caregiver completes their task", (await grace.patch(`/api/tasks/${gt.id}`)).status === 200);
  const nurseTask = (await nurse.get("/api/patients/pt-okoro")).data.tasks.find((t: Json) => t.assigneeRole === "NURSE" && t.status === "OPEN");
  check("caregiver cannot complete a nurse task → 403", (await grace.patch(`/api/tasks/${nurseTask.id}`)).status === 403);
  check("patient reconnects devices via the simulated adapter", (await samuel.post("/api/patients/pt-okoro/device", { status: "CONNECTED" })).status === 200);

  console.log("\n7. Clinician actions");
  check("doctor records admission assessment", (await doctor.post("/api/patients/pt-reyes/notes", { kind: "ASSESSMENT", body: "Admission assessment complete. Plan confirmed." })).status === 200);
  ward = (await nurse.get("/api/ward")).data;
  check("Daniel no longer awaiting assessment", P(ward, "pt-reyes").state !== "AWAITING_ASSESSMENT", P(ward, "pt-reyes").state);
  check("doctor configures a per-patient limit", (await doctor.post("/api/patients/pt-hart/thresholds", { vital: "HR", critLow: 40, warnLow: 50, warnHigh: 60, critHigh: 130 })).status === 200);
  const hrAlert = await until("configured limit alert", async () => {
    ward = (await nurse.get("/api/ward")).data;
    return ward.alerts.find((a: Json) => a.patientId === "pt-hart" && a.vital === "HR");
  }, 15_000);
  check("the clinician-configured limit drives alerting", !!hrAlert);
  check("badly ordered limits rejected → 400", (await doctor.post("/api/patients/pt-hart/thresholds", { vital: "HR", warnLow: 90, warnHigh: 60 })).status === 400);
  check("nurse records a check-in note", (await nurse.post("/api/patients/pt-hart/notes", { kind: "CHECKIN", body: "Video check-in complete." })).status === 200);
  check("nurse reconnects Thomas's device", (await nurse.post("/api/patients/pt-berg/device", { status: "CONNECTED" })).status === 200);
  const back = await until("Thomas transmitting", async () => {
    ward = (await nurse.get("/api/ward")).data;
    return P(ward, "pt-berg").state !== "DEVICE_DISCONNECTED" && !ward.alerts.some((a: Json) => a.patientId === "pt-berg" && a.kind === "CONNECTIVITY");
  }, 15_000);
  check("connectivity alert clears when data resumes", !!back);
  const ho = await nurse.post("/api/handover");
  check("shift handover report generated", ho.status === 200 && ho.data.doc.sections.length === 6);

  console.log("\n8. Stale data + admin analytics");
  await nurse.post("/api/sim", { action: "pause" });
  ward = (await nurse.get("/api/ward")).data;
  check("pause stops the stream", ward.sim.running === false);
  const adm = (await admin.get("/api/admin")).data;
  check("admin KPIs computed", adm.kpis.admitted === 6 && adm.kpis.capacity === 14);
  check("average alert response time computed from records", typeof adm.kpis.avgAckSeconds === "number" && adm.kpis.ackSample >= 4, `${adm.kpis.avgAckSeconds} from ${adm.kpis.ackSample}`);
  check("access log records clinician actions", adm.logs.some((l: Json) => l.action === "ALERT_RESOLVED") && adm.logs.some((l: Json) => l.action === "RECORD_VIEWED"));
  check("admin adds a clinician", (await admin.post("/api/admin", { action: "addClinician", name: "Dr. Test Demo", role: "DOCTOR", title: "Locum" })).status === 200);
  check("admin configures a programme default", (await admin.post("/api/admin", { action: "setDefault", vital: "RR", critLow: 8, warnLow: 10, warnHigh: 24, critHigh: 30 })).status === 200);
  check("admin payload has no clinical notes or readings", adm.notes === undefined && adm.series === undefined);

  console.log("\n9. Smartwatch & phone sync (wearable ingest)");
  const amelia = await new Session("patient3").login("u-pt-hart");
  check("caregiver cannot link a wearable → 403", (await grace.post("/api/patients/pt-okoro/wearable-link", { platform: "APPLE_HEALTH" })).status === 403);
  check("admin cannot link a wearable → 403", (await admin.post("/api/patients/pt-hart/wearable-link", { platform: "APPLE_HEALTH" })).status === 403);
  check("patient cannot link a wearable to someone else → 403", (await samuel.post("/api/patients/pt-hart/wearable-link", { platform: "APPLE_HEALTH" })).status === 403);
  const link = await amelia.post("/api/patients/pt-hart/wearable-link", { platform: "APPLE_HEALTH", label: "Amelia's Apple Watch" });
  check("patient links an Apple Watch and receives a one-time token", link.status === 200 && /^ria_wk_/.test(link.data.token ?? ""));
  const token: string = link.data.token;
  const wid: string = link.data.deviceId;
  const ingest = async (body: unknown, tok: string = token, method = "POST") => {
    const r = await fetch(BASE + "/api/ingest/wearable", { method, headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: method === "GET" ? undefined : JSON.stringify(body) });
    return { status: r.status, data: (await r.json().catch(() => ({}))) as Json };
  };
  check("ingest without a token → 401", (await ingest({ samples: [] }, "")).status === 401);
  check("ingest with an unknown token → 401", (await ingest({ samples: [] }, "ria_wk_" + "x".repeat(32))).status === 401);
  check("connection test (GET) identifies the link", (await ingest(null, token, "GET")).data.device === "Amelia's Apple Watch");
  check("unrecognised payload → 400", (await ingest({ hello: 1 })).status === 400);
  const hae = (d: Date) => d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " +0000");
  const ago = (m: number) => new Date(Date.now() - m * 60_000);
  const payload = {
    data: {
      metrics: [
        { name: "heart_rate", units: "count/min", data: [{ date: hae(ago(6)), Min: 70, Avg: 74, Max: 80 }, { date: hae(ago(3)), Min: 72, Avg: 76, Max: 82 }] },
        { name: "blood_oxygen_saturation", units: "%", data: [{ date: hae(ago(4)), qty: 0.87 }] },
        { name: "body_temperature", units: "degF", data: [{ date: hae(ago(10)), qty: 98.6 }] },
        { name: "weight_body_mass", units: "lb", data: [{ date: hae(ago(600)), qty: 154 }] },
        { name: "blood_glucose", units: "mmol<180.15588000005408>/L", data: [{ date: hae(ago(30)), qty: 6.1 }] },
        { name: "step_count", units: "count", data: [{ date: hae(ago(120)), qty: 812 }, { date: hae(ago(60)), qty: 430 }] },
        { name: "active_energy", units: "kcal", data: [{ date: hae(ago(60)), qty: 200 }] },
        { name: "heart_rate", units: "count/min", data: [{ date: hae(new Date(Date.now() + 3600_000)), Avg: 70 }, { date: hae(ago(60 * 24 * 40)), Avg: 70 }, { date: hae(ago(2)), Avg: 400 }] },
      ],
      ecg: [{ start: hae(ago(5)), end: hae(ago(4.5)), classification: "Atrial Fibrillation", averageHeartRate: 112, source: "Apple Watch" }],
    },
  };
  const r1 = await ingest(payload);
  check("Health Auto Export payload accepted", r1.status === 200 && r1.data.format === "health-auto-export", JSON.stringify(r1.data));
  check("valid samples stored", r1.data.accepted === 8, `${r1.data.accepted}`);
  check("future / >30-day-old / implausible samples rejected", r1.data.rejected?.["timestamp in the future"] === 1 && r1.data.rejected?.["older than 30 days"] === 1 && r1.data.rejected?.["implausible value"] === 1, JSON.stringify(r1.data.rejected));
  check("unused metrics reported back, not stored", r1.data.ignoredMetrics?.includes("active_energy"));
  check("recent low SpO₂ + watch AFib classification raised alerts", r1.data.alertsRaised >= 2, `${r1.data.alertsRaised}`);
  const r2 = await ingest(payload);
  check("re-sent batch is de-duplicated", r2.status === 200 && r2.data.accepted === 0 && r2.data.duplicates === 8, JSON.stringify(r2.data));
  const am = (await doctor.get("/api/patients/pt-hart?window=60")).data;
  const wpt = (type: string) => (am.series?.[type] ?? []).filter((p: Json) => p.src === "WEARABLE_SYNC").map((p: Json) => p.v);
  check("units converted: °F→°C, fraction→%, mmol/L→mg/dL, lb→kg", wpt("TEMP").includes(37) && wpt("SPO2").includes(87) && wpt("GLUCOSE").includes(110) && am.latest.WEIGHT?.v === 69.9, `${wpt("TEMP")} ${wpt("SPO2")} ${wpt("GLUCOSE")} ${am.latest.WEIGHT?.v}`);
  check("readings labelled WEARABLE_SYNC", wpt("HR").length === 2);
  check("steps summed into the activity summary", am.activity?.STEPS?.v === 1242, JSON.stringify(am.activity));
  const spoAlert = am.alerts.find((a: Json) => a.vital === "SPO2" && a.status !== "RESOLVED");
  check("SpO₂ alert names the watch and when it was measured", spoAlert?.severity === "CRITICAL" && /Apple Watch.*measured/i.test(spoAlert?.message ?? ""), spoAlert?.message);
  check("watch AFib classification → rhythm flag (not a diagnosis)", am.alerts.some((a: Json) => a.kind === "RHYTHM_FLAG" && a.vital === "WATCH_RHYTHM" && /not a diagnosis/.test(a.message)));
  const dev = am.devices.find((d: Json) => d.id === wid);
  check("link shows sync count; token / hash never sent to the browser", dev?.syncCount === 8 && !("tokenHash" in dev) && !JSON.stringify(am).includes(token));
  check("sync + watch ECG event written to the timeline", am.timeline.some((t: Json) => t.action === "WEARABLE_SYNC") && am.timeline.some((t: Json) => t.action === "WEARABLE_EVENT"));
  const r3 = await ingest({ samples: [{ type: "RR", value: 16, takenAt: new Date().toISOString() }, { type: "BP", value: 128, value2: 82, takenAt: Date.now() }, { type: "BP", value: 128, takenAt: Date.now() }] });
  check("normalized companion-app format accepted (BP without diastolic refused)", r3.status === 200 && r3.data.format === "normalized" && r3.data.accepted === 2, JSON.stringify(r3.data));
  const sumH = await doctor.post("/api/patients/pt-hart/summary");
  check("AI summary marks smartwatch values as consumer-grade", /not clinically validated/.test(JSON.stringify(sumH.data.doc ?? {})));
  ward = (await nurse.get("/api/ward")).data;
  check("ward card lists the linked watch", P(ward, "pt-hart").wearableLinks?.some((w: Json) => w.name === "Amelia's Apple Watch" && w.lastSyncAt));
  check("caregiver cannot send a demo sync → 403", (await grace.post("/api/patients/pt-okoro/wearable-demo", { deviceId: wid })).status === 403);
  const demo = await amelia.post("/api/patients/pt-hart/wearable-demo", { deviceId: wid, scenario: "AFIB" });
  check("demo sync runs through the real ingest path", demo.status === 200 && demo.data.accepted > 20 && demo.data.eventsRecorded === 1, JSON.stringify(demo.data));
  const am2 = (await amelia.get("/api/patients/pt-hart?window=60")).data;
  check("demo data is labelled synthetic (WEARABLE_DEMO)", (am2.series?.HR ?? []).some((p: Json) => p.src === "WEARABLE_DEMO") && am2.activity?.SLEEP?.src === "WEARABLE_DEMO");
  check("patient revokes the link", (await amelia.post("/api/patients/pt-hart/wearable-revoke", { deviceId: wid })).status === 200);
  check("revoked token → 401", (await ingest({ samples: [] })).status === 401);
  check("revoking twice → 409", (await amelia.post("/api/patients/pt-hart/wearable-revoke", { deviceId: wid })).status === 409);

  console.log("\n10. Red-flag symptoms, urgent help and emergency transfer");
  const rfAr = await samuel.post("/api/patients/pt-okoro/symptoms", { text: "عندي ألم في الصدر وضيق تنفس شديد", severity: "MODERATE" });
  check("Arabic red-flag text → emergency instructions returned at once (no AI)", rfAr.status === 200 && rfAr.data.redFlags?.some((f: Json) => f.flag === "CHEST_PAIN") && rfAr.data.emergencyNumber, JSON.stringify(rfAr.data));
  const neg = await samuel.post("/api/patients/pt-okoro/symptoms", { text: "No chest pain today, just tired", severity: "MILD" });
  check("negated mention (\"no chest pain\") is not a red flag", neg.status === 200 && neg.data.redFlags.length === 0);
  const tick = await grace.post("/api/patients/pt-okoro/symptoms", { text: "He seems very sleepy this evening", severity: "MILD", redFlags: ["CONFUSION"] });
  check("caregiver ticks a red-flag box → flagged and upgraded to severe", tick.status === 200 && tick.data.redFlags.some((f: Json) => f.flag === "CONFUSION"));
  ward = (await nurse.get("/api/ward")).data;
  check("red flag raises a CRITICAL alert for the team", ward.alerts.some((a: Json) => a.patientId === "pt-okoro" && a.kind === "RED_FLAG" && a.severity === "CRITICAL"));
  const sug = await doctor.post("/api/patients/pt-okoro/transfer-suggest", {});
  check("suggestion: emergency priority, cardiac pathway from the chest-pain red flag", sug.data.priority === "EMERGENCY" && sug.data.pathway === "CARDIAC", JSON.stringify(sug.data.reasons));
  check("suggestion carries the pickup address and access notes", /Hillcrest/.test(sug.data.pickupAddress) && sug.data.accessNotes.length > 0);
  const trBody = { priority: "EMERGENCY", pathway: "CARDIAC", reason: "New central chest pain with breathlessness, SpO2 falling" };
  check("patient cannot request an ambulance through the app → 403", (await samuel.post("/api/patients/pt-okoro/transfer-request", trBody)).status === 403);
  check("caregiver cannot request → 403", (await grace.post("/api/patients/pt-okoro/transfer-request", trBody)).status === 403);
  check("admin cannot request → 403", (await admin.post("/api/patients/pt-okoro/transfer-request", trBody)).status === 403);
  check("a reason is required → 400", (await nurse.post("/api/patients/pt-okoro/transfer-request", { ...trBody, reason: "x" })).status === 400);
  const tr = await nurse.post("/api/patients/pt-okoro/transfer-request", trBody);
  check("nurse requests an emergency ambulance → incident reference", tr.status === 200 && /^AMB-/.test(tr.data.incidentRef ?? ""), JSON.stringify(tr.data));
  check("second request while one is open → 409", (await doctor.post("/api/patients/pt-okoro/transfer-request", trBody)).status === 409);
  let tv = (await doctor.get("/api/patients/pt-okoro?window=15")).data.transfer;
  check("clinician sees the ISBAR handover: address, vitals with time + source, medicines", /Hillcrest/.test(tv?.handover?.identify?.address) && tv.handover.assessment.vitals.length > 0 && tv.handover.assessment.vitals.every((x: Json) => x.at && x.source) && tv.handover.background.medications.length > 0);
  check("unit pre-alerted, awaiting acceptance; handover-sent item ticked", tv.unitStatus === "PENDING" && tv.checklist.find((c: Json) => c.id === "w0")?.done === true);
  const ptv = (await samuel.get("/api/patients/pt-okoro")).data.transfer;
  check("patient sees status, ETA and instructions — not the clinical handover", ptv && ptv.instructions?.length > 0 && ptv.handover === undefined && ptv.emergencyNumber && ptv.etaAt);
  const cgv = (await grace.get("/api/patients/pt-okoro")).data.transfer;
  check("caregiver sees the transfer too, without the handover", cgv && cgv.handover === undefined && cgv.instructions?.length > 0);
  ward = (await nurse.get("/api/ward")).data;
  check("ward card shows the open transfer", P(ward, "pt-okoro").transfer?.open === true && P(ward, "pt-okoro").transfer.incidentRef === tr.data.incidentRef);
  check("virtual-ward prep item ticked by nurse", (await nurse.post("/api/patients/pt-okoro/transfer-prep", { itemId: "w1", done: true })).status === 200);
  check("receiving-unit items cannot be ticked by the virtual ward → 403", (await nurse.post("/api/patients/pt-okoro/transfer-prep", { itemId: "u0", done: true })).status === 403);
  const STAGES = ["REQUESTED", "DISPATCHED", "ON_SCENE", "TRANSPORTING", "ARRIVED", "HANDED_OVER"];
  const advanceTo = async (pid: string, target: string) => {
    for (let i = 0; i < 7; i++) {
      const t = (await doctor.get(`/api/patients/${pid}?window=15`)).data.transfer;
      if (STAGES.indexOf(t.status) >= STAGES.indexOf(target)) return t;
      await doctor.post(`/api/patients/${pid}/transfer-advance`, {});
    }
    return (await doctor.get(`/api/patients/${pid}?window=15`)).data.transfer;
  };
  tv = await advanceTo("pt-okoro", "ON_SCENE");
  check("CCU accepts before the crew leaves → bed reserved, direct admission (no ED)", tv.unitStatus === "ACCEPTED" && tv.directAdmission === true && /^CCU Bed/.test(tv.bed ?? ""), `${tv.unitStatus} ${tv.bed}`);
  const t2 = await doctor.post("/api/patients/pt-haddad/transfer-request", { ...trBody, reason: "Fast irregular rhythm with dizziness" });
  check("second patient to CCU requested", t2.status === 200);
  const haddad = await advanceTo("pt-haddad", "ON_SCENE");
  check("CCU takes the second patient into its last bed", haddad.unitStatus === "ACCEPTED" && haddad.bed !== tv.bed, `${haddad.unitStatus} ${haddad.bed}`);
  await doctor.post("/api/patients/pt-hart/transfer-request", { ...trBody, reason: "Palpitations and chest tightness after physiotherapy" });
  const hart = await advanceTo("pt-hart", "ON_SCENE");
  check("CCU full → declined; safety fallback to the pre-alerted ED", hart.unitStatus === "DECLINED" && hart.directAdmission === false && /Emergency Department/.test(hart.destination), `${hart.unitStatus} ${hart.destination}`);
  const hartAlerts = (await doctor.get("/api/patients/pt-hart?window=15")).data.alerts;
  check("the decline raises an alert for the team", hartAlerts.some((a: Json) => a.kind === "TRANSFER" && a.status !== "RESOLVED"));
  check("standing down needs a reason → 400", (await doctor.post("/api/patients/pt-hart/transfer-cancel", { reason: "" })).status === 400);
  check("doctor stands the ambulance down", (await doctor.post("/api/patients/pt-hart/transfer-cancel", { reason: "Reassessed on video — symptoms settled" })).status === 200);
  check("cancelled transfer shows to the patient as cancelled", (await amelia.get("/api/patients/pt-hart")).data.transfer?.status === "CANCELLED");
  const done = await advanceTo("pt-haddad", "HANDED_OVER");
  check("transfer runs to handover; all unit preparation complete", done.status === "HANDED_OVER" && done.unitReady.done === done.unitReady.total && !!done.closedAt);
  tv = await advanceTo("pt-okoro", "ARRIVED");
  check("cannot stand down after arrival → 409", (await doctor.post("/api/patients/pt-okoro/transfer-cancel", { reason: "test" })).status === 409);
  const otl = (await doctor.get("/api/patients/pt-okoro?window=15")).data.timeline;
  check("transfer actions are in the audit timeline", otl.some((t: Json) => t.action === "TRANSFER_REQUESTED") && otl.some((t: Json) => t.action === "TRANSFER_UNIT_ACCEPTED"));
  const uh = await priya.post("/api/patients/pt-nair/urgent-help", {});
  check("patient presses urgent help → critical alert + emergency number", uh.status === 200 && uh.data.alerted === true && !!uh.data.emergencyNumber);
  check("pressing again does not duplicate the alert", (await priya.post("/api/patients/pt-nair/urgent-help", {})).data.alerted === false);
  check("clinicians do not use the patient urgent-help button → 403", (await nurse.post("/api/patients/pt-nair/urgent-help", {})).status === 403);

  console.log("\n11. Heart-failure weight trend");
  await nurse.post("/api/patients/pt-haddad/symptoms", { text: "More breathless lying flat, ankles swollen", severity: "MODERATE" });
  const w = await nurse.post("/api/patients/pt-haddad/readings", { readings: [{ type: "WEIGHT", value: 80.5 }] });
  const hAl = (await doctor.get("/api/patients/pt-haddad?window=15")).data.alerts;
  const wa = hAl.find((a: Json) => a.kind === "TREND" && a.vital === "WEIGHT");
  check("weight +2.6 kg in < 72 h with breathlessness → review alert", w.status === 200 && wa?.severity === "WARNING" && /2\.6 kg/.test(wa.title) && /breathlessness/.test(wa.title), wa?.title);

  console.log("\n12. Voice commands (transcript → intent; speech runs in the browser)");
  const say = (s: Session, text: string, extra: Json = {}) => s.post("/api/voice", { text, ...extra });
  check("voice endpoint requires sign-in → 401", (await anon.post("/api/voice", { text: "hello" })).status === 401);
  check("admin gets no voice commands", (await say(admin, "read the alerts")).data.intent === "UNSUPPORTED");
  let vr = await say(samuel, "what are my readings");
  check("patient: 'what are my readings' → spoken vitals with time and source", vr.data.intent === "READINGS" && /Oxygen saturation/.test(vr.data.reply) && /ago|just now/.test(vr.data.reply), vr.data.reply);
  vr = await say(samuel, "كم ضغطي");
  check("Arabic question → Arabic reply", vr.data.lang === "ar" && vr.data.intent === "READINGS" && /ضغط الدم/.test(vr.data.reply), vr.data.reply);
  vr = await say(samuel, "my blood pressure is 128 over 82");
  const bpCall = vr.data.calls?.[0];
  check("recording a reading needs confirmation first", vr.data.intent === "RECORD_READING" && vr.data.confirm === true && bpCall?.body?.readings?.[0]?.value === 128 && bpCall.body.readings[0].value2 === 82);
  check("after 'yes' the reading goes through the normal endpoint", (await samuel.post(bpCall.path, bpCall.body)).status === 200 && (await samuel.get("/api/patients/pt-okoro")).data.latest.BP.v === 128);
  vr = await say(samuel, "ضغطي ١٣٠ على ٨٥");
  check("Arabic-Indic digits understood (١٣٠ على ٨٥ → 130/85)", vr.data.calls?.[0]?.body?.readings?.[0]?.value === 130 && vr.data.calls[0].body.readings[0].value2 === 85);
  vr = await say(priya, "my sugar is 7.2");
  check("devices automatic → voice explains instead of recording numbers", vr.data.intent === "AUTO_DEVICES" && !vr.data.calls);
  await doctor.post("/api/patients/pt-nair/manual-entry", { enabled: true, reason: "Meter battery flat" });
  vr = await say(priya, "my sugar is 7.2");
  check("glucose in mmol/L converted to mg/dL before confirming", vr.data.calls?.[0]?.body?.readings?.[0]?.value === 130 && /millimoles/.test(vr.data.reply), vr.data.reply);
  vr = await say(samuel, "I have crushing chest pain");
  check("spoken red flag → sent at once (no confirmation), emergency number returned", vr.data.intent === "RED_FLAG" && vr.data.confirm === false && vr.data.emergency?.number && vr.data.calls?.[0]?.body?.redFlags?.includes("CHEST_PAIN"));
  vr = await say(grace, "ساعدوني");
  check("Arabic 'help us' from caregiver → urgent help sent at once", vr.data.intent === "URGENT_HELP" && vr.data.confirm === false && vr.data.calls?.[0]?.path.endsWith("/urgent-help"));
  vr = await say(samuel, "I feel slightly dizzy");
  check("ordinary symptom → confirm first, severity mild", vr.data.intent === "SYMPTOM" && vr.data.confirm === true && vr.data.calls?.[0]?.body?.severity === "MILD");
  vr = await say(priya, "I took my metformin");
  check("'I took my metformin' → medication log for the right medicine", vr.data.intent === "MED_TAKEN" && vr.data.confirm === true && /Metformin/.test(vr.data.reply));
  vr = await say(priya, "tell my nurse I slept badly last night");
  check("'tell my nurse …' → message drafted for confirmation", vr.data.intent === "SEND_MESSAGE" && /slept badly/.test(vr.data.calls?.[0]?.body?.body ?? ""));
  vr = await say(grace, "read my messages");
  check("caregiver can hear the latest care-team message", vr.data.intent === "READ_MESSAGES");
  vr = await say(doctor, "how is Samuel Okoro");
  check("clinician: patient status by name", vr.data.intent === "PATIENT_STATUS" && /Samuel Okoro/.test(vr.data.reply), vr.data.reply);
  vr = await say(doctor, "كيف حال سامويل");
  check("clinician: Arabic name with a spelling variant still matches", vr.data.intent === "PATIENT_STATUS" && vr.data.lang === "ar", JSON.stringify(vr.data));
  check("clinician: 'read the alerts'", (await say(doctor, "read the alerts")).data.intent === "ALERTS");
  check("clinician: 'who needs attention'", (await say(nurse, "who needs attention")).data.intent === "WARD");
  vr = await say(doctor, "ambulance for Layla Haddad");
  check("voice never dispatches an ambulance — it opens the transfer form", vr.data.intent === "TRANSFER_FORM" && /\?transfer=1$/.test(vr.data.navigate ?? "") && !vr.data.calls);
  vr = await say(doctor, "acknowledge alerts for Samuel");
  check("'acknowledge alerts for Samuel' → PATCH calls awaiting confirmation", vr.data.intent === "ACK" && vr.data.confirm === true && vr.data.calls?.every((c: Json) => c.method === "PATCH"));
  if (vr.data.calls?.length) check("confirmed acknowledgement goes through the alerts endpoint", (await doctor.patch(vr.data.calls[0].path, vr.data.calls[0].body)).status === 200);
  vr = await say(doctor, "summarise this patient", { patientId: "pt-okoro" });
  check("on a bedside page 'this patient' uses the open record (AI summary)", vr.data.intent === "SUMMARY" && vr.data.calls?.[0]?.path === "/api/patients/pt-okoro/summary");
  check("voice commands are audited without storing the transcript", (await doctor.get("/api/patients/pt-okoro?window=15")).data.timeline.some((t: Json) => t.action === "VOICE_COMMAND" && !/crushing/.test(t.detail)));

  console.log("\n13. Home hub: automatic device uploads (FHIR)");
  await nurse.post("/api/sim", { action: "pause" }); // so hub values are the newest on the tiles
  check("patient cannot register a hub → 403", (await amelia.post("/api/patients/pt-hart/hub-register", {})).status === 403 && (await grace.post("/api/patients/pt-okoro/hub-register", {})).status === 403);
  const hubReg = await nurse.post("/api/patients/pt-reyes/hub-register", { name: "CareHub H2", serial: "HUB-TEST-1" });
  check("nurse registers a home hub; devices paired; token shown once", hubReg.status === 200 && /^ria_hub_/.test(hubReg.data.token ?? "") && hubReg.data.paired === 3, JSON.stringify(hubReg.data));
  check("second active hub → 409", (await nurse.post("/api/patients/pt-reyes/hub-register", {})).status === 409);
  const hubToken: string = hubReg.data.token;
  const hubPost = async (body: unknown, tok: string = hubToken, method = "POST") => {
    const r = await fetch(BASE + "/api/ingest/device", { method, headers: { "content-type": "application/fhir+json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: method === "GET" ? undefined : JSON.stringify(body) });
    return { status: r.status, data: (await r.json().catch(() => ({}))) as Json };
  };
  check("hub upload without token → 401", (await hubPost({ readings: [] }, "")).status === 401);
  check("wearable token is not a hub token → 401", (await hubPost({ readings: [] }, token)).status === 401);
  check("hub connection test (GET)", (await hubPost(null, hubToken, "GET")).data.serial === "HUB-TEST-1");
  check("unrecognised payload → 400", (await hubPost({ hello: 1 })).status === 400);
  const loinc = (code: string) => ({ coding: [{ system: "http://loinc.org", code }] });
  const obs = (serial: string, code: string, extra: Json, minAgo = 2) => ({ resource: { resourceType: "Observation", status: "final", code: loinc(code), effectiveDateTime: new Date(Date.now() - minAgo * 1000).toISOString(), device: { identifier: { value: serial } }, ...extra } });
  const bundle = {
    resourceType: "Bundle",
    type: "collection",
    entry: [
      obs("OXR-0006-2", "59408-5", { valueQuantity: { value: 87, unit: "%", code: "%" } }),
      obs("OXR-0006-2", "85354-9", { component: [{ code: loinc("8480-6"), valueQuantity: { value: 124, code: "mm[Hg]" } }, { code: loinc("8462-4"), valueQuantity: { value: 78, code: "mm[Hg]" } }] }),
      obs("TMD-0006-3", "8310-5", { valueQuantity: { value: 99.1, unit: "F", code: "[degF]" } }),
      obs("OXR-0006-2", "85354-9", { valueQuantity: { value: 120, code: "mm[Hg]" } }),
      obs("UNKNOWN-9", "8867-4", { valueQuantity: { value: 70, code: "/min" } }),
      obs("CPS-0006-1", "41950-7", { valueQuantity: { value: 3000, code: "/d" } }),
    ],
  };
  const h1 = await hubPost(bundle);
  check("FHIR bundle accepted: SpO₂, BP panel, temperature", h1.status === 200 && h1.data.accepted === 3, JSON.stringify(h1.data));
  check("BP without components unparseable; unpaired serial rejected; unknown LOINC ignored", h1.data.rejected?.["device not paired with this hub"] === 1 && h1.data.rejected?.["missing value, unit, code, serial or time"] === 1 && h1.data.ignoredCodes?.includes("41950-7"), JSON.stringify(h1.data));
  check("hub retry de-duplicated", (await hubPost(bundle)).data.duplicates === 3);
  const ah = (await doctor.get("/api/patients/pt-reyes?window=15")).data;
  check("readings labelled DEVICE_HUB; °F converted", ah.latest.SPO2?.src === "DEVICE_HUB" && ah.latest.SPO2.v === 87 && ah.latest.TEMP?.src === "DEVICE_HUB" && ah.latest.TEMP.v === 37.3, `${JSON.stringify(ah.latest.SPO2)} ${JSON.stringify(ah.latest.TEMP)}`);
  check("low SpO₂ from the hub raised a critical alert naming the device", ah.alerts.some((a: Json) => a.vital === "SPO2" && a.severity === "CRITICAL" && /OxiRing.*home hub/i.test(a.message)));
  check("simple JSON format also accepted", (await hubPost({ readings: [{ serial: "OXR-0006-2", type: "HR", value: 72, takenAt: new Date().toISOString() }] })).data.accepted === 1);
  check("hub token never sent to the browser", !JSON.stringify(ah).includes(hubToken));
  check("nurse revokes the hub", (await nurse.post("/api/patients/pt-reyes/hub-revoke", {})).status === 200);
  check("revoked hub token → 401", (await hubPost({ readings: [] })).status === 401);

  await nurse.post("/api/sim", { action: "reset" });
  console.log(`\n${failed === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failed} failed (demo data reset)\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
