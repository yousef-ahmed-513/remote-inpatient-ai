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
  check("invalid reading rejected → 400", (await samuel.post("/api/patients/pt-okoro/readings", { readings: [{ type: "SPO2", value: 140 }] })).status === 400);

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
  const sub = await priya.post("/api/patients/pt-nair/readings", { readings: [{ type: "GLUCOSE", value: 268 }, { type: "BP", value: 132, value2: 84 }] });
  check("Priya submits a check-in", sub.status === 200);
  check("high glucose raised a rule-based alert", sub.data.alertsRaised >= 1);
  await sleep(1200);
  ward = (await nurse.get("/api/ward")).data;
  check("overdue check-in alert auto-cleared once data arrived", !ward.alerts.some((a: Json) => a.patientId === "pt-nair" && a.kind === "CHECKIN_OVERDUE"));
  check("Priya no longer 'No recent data'", P(ward, "pt-nair").state !== "NO_RECENT_DATA", P(ward, "pt-nair").state);
  check("patient reports a symptom", (await samuel.post("/api/patients/pt-okoro/symptoms", { text: "Chest feels tight after climbing stairs", severity: "MODERATE" })).status === 200);
  check("patient sends a secure message", (await samuel.post("/api/patients/pt-okoro/messages", { body: "Is my evening call still on?" })).status === 200);
  check("patient requests a consultation", (await samuel.post("/api/patients/pt-okoro/consult", { reason: "Breathing worse today" })).status === 200);
  check("caregiver records a spot check", (await grace.post("/api/patients/pt-okoro/readings", { readings: [{ type: "SPO2", value: 95 }], comment: "Evening spot check" })).status === 200);
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

  await nurse.post("/api/sim", { action: "reset" });
  console.log(`\n${failed === 0 ? "ALL PASSED" : "FAILURES"} — ${passed} passed, ${failed} failed (demo data reset)\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
