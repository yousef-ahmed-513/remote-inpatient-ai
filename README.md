# Remote Inpatient AI

**"Hospital-Level Care, From the Comfort of Home."**

A working hackathon MVP of an AI-assisted virtual hospital ward: patients are at home, their (simulated) monitoring devices stream vitals, and clinicians watch, get rule-based alerts, communicate, document and hand over — all in one place.

> **Demo only.** Every patient, reading, clinician and event is **synthetic**. This is not a medical device and has no clinical validation or certification. The platform supports clinicians; it does not replace them. AI output summarises recorded data and never diagnoses, prescribes, decides eligibility for hospital-at-home care, or makes emergency decisions.

---

## Try it in one click

- **Windows:** unzip, then double-click `start-demo.bat`. It installs Node.js (via winget) if needed, installs the app on first run, and opens http://localhost:3210.
- **macOS / Linux:** `bash start-demo.sh` (needs Node.js 20+).
- Pick a role on the sign-in page — no passwords; all data is synthetic.

## Quick start

Requires Node.js 20+ (built and tested on Node 25, macOS).

```bash
npm install
npm run dev
```

Open **http://localhost:3210**. That is all: the SQLite database is created on start and the synthetic dataset is seeded automatically on first request. No API keys are needed.

| Command | What it does |
|---|---|
| `npm run dev` | Creates/updates the database, starts the app on port 3210 |
| `npm run build` / `npm start` | Production build / run |
| `npm run db:reset` | Wipe the database and re-seed the demo data |
| `npm run test:e2e` | 189-check end-to-end test (needs `npm run dev` running; resets demo data) |
| `npm run typecheck` | TypeScript check |

**macOS + iCloud Desktop note:** this folder ends in `.nosync` on purpose. On a Mac whose Desktop syncs to iCloud, iCloud turned freshly installed `node_modules` files into empty placeholders and broke the tooling; `.nosync` folders are skipped by iCloud. You can rename the folder freely once it lives outside an iCloud-synced location.

## Demo accounts (no passwords — all synthetic)

| Role | Account | Lands on |
|---|---|---|
| Nurse | Emily Carter, RN · Omar Aziz, RN | Virtual ward |
| Doctor | Dr. Sara Rahman · Dr. James Whitfield | Virtual ward |
| Patient | Samuel Okoro (respiratory) · Priya Nair (home-hub glucose meter + BP cuff) · Amelia Hart (stable) | My care |
| Caregiver | Grace Okoro (for Samuel) | Care overview |
| Administrator | Morgan Lee | Operations |

## 5-minute demo script

1. **Sign in as Nurse (Emily Carter).** The virtual ward shows six virtual beds. Simulator is paused; Amelia is *Stable on latest readings*, Daniel is *Awaiting clinician assessment*.
2. Press **Start simulation** (use **×2** or **×5** to go faster). Within ~30 s at ×1:
   - **Priya Nair**'s scheduled meter/cuff measurement does not arrive → *No recent data* + *Scheduled measurement not received* alert (not "stable").
   - **Samuel Okoro**'s SpO₂ declines → trend alert → review alert → simulated breathlessness report → **Critical demo alert**.
   - **Thomas Berg**'s device disconnects → *Device disconnected*, values greyed as "last received — not current", ECG shows **NO SIGNAL**. No readings are invented.
   - **Layla Haddad** gets a *Simulated irregular rhythm flag*; her ECG trace turns amber and a strip is auto-saved.
3. Open **Samuel Okoro → bedside view**: live tiles, synthetic ECG, trend charts with his doctor-configured limits. **Acknowledge** the critical alert, then **Escalate to doctor**.
4. **Switch role → Doctor (Dr. Sara Rahman).** Open Samuel, press **Generate** on *AI-assisted summary*, review the timeline, then **Resolve…** the SpO₂ alert with a note. The scripted scenario then moves to its recovery phase and SpO₂ climbs back.
5. *Devices & limits* tab → edit a monitoring limit (doctor only) and watch it drive alerting.
6. **Shift handover** → *Generate handover report*.
7. **Automatic device upload (Priya Nair).** As a nurse open Priya → *Devices & limits* → **Send demo upload** (home hub, FHIR): glucose + BP arrive without anyone typing, the overdue alert clears itself. As Priya: *My monitoring devices* shows the devices and last upload — there is no form to fill in. Try messaging, a symptom report, a consultation request.
8. **Caregiver (Grace Okoro):** restricted overview, device status (readings upload automatically), tick off a task.
9. **Administrator (Morgan Lee):** capacity, monitoring status, alert response time computed from the records you just created, staffing, programme default limits, access log.
10. **Smartwatch & phone:** as *Amelia Hart*, open **My smartwatch & phone → Link a smartwatch or phone** (shows the one-time token, upload URL and iPhone setup steps), then **Send demo sync** with *watch ECG flags AFib*. As a clinician: the ward card lists the watch, the bedside view shows steps / sleep / resting HR / HRV, and a *Smartwatch ECG classified as atrial fibrillation* review flag appears.
11. **Emergency transfer:** as *Samuel Okoro*, tick **New or severe chest pain** in *How are you feeling?* → the *Call 9999* emergency panel appears instantly. As *Dr. Sara Rahman*, open Samuel → **Emergency transfer** (Emergency + Cardiac/CCU pre-selected with reasons) → **Request ambulance** → **Next stage (demo)** twice: the CCU accepts, a bed is reserved and the crew bypasses the emergency department. Samuel's and Grace's screens show the ETA and what to do. Full script: [`docs/EMERGENCY-TRANSFER.md`](docs/EMERGENCY-TRANSFER.md).
12. **Voice (English / Arabic):** tap the microphone (bottom-right) and say "what are my readings" or «كم ضغطي», "my blood pressure is 128 over 82" then "yes", or as a doctor "who needs attention" / «كيف حال صامويل». Details: [`docs/VOICE.md`](docs/VOICE.md).
13. **Reset demo** (in the simulator bar) restores the starting state at any time. The *Scenarios* menu re-triggers any scenario on demand.

## What is built

### P0 — all implemented and tested

| # | Requirement | Where |
|---|---|---|
| 1 | App launches | `npm run dev` |
| 2 | Modern login + demo-role selection | `/` |
| 3 | Doctor/nurse virtual ward dashboard | `/ward` — cards, 6 monitoring states, filters (all / needs attention / critical / missing readings / clinician / ward) |
| 4 | Patient dashboard | `/me` |
| 5 | Synthetic patient profiles | 6 patients, each a different scenario |
| 6 | Simulated continuous vitals | `src/lib/simulator.ts` — start, pause, step, speed ×1/×2/×5, scenario triggers, reset |
| 7 | ECG waveform (synthetic) | live sweep canvas + stored strips, always labelled SIMULATED |
| 8 | Near-real-time charts | 2 s polling; charts show configured limits and real gaps |
| 9 | Configurable alerts | programme defaults (admin) + per-patient limits (doctor); limit, trend, connectivity, missed check-in, device-flag and symptom alerts |
| 10 | AI-assisted patient summary with reliable fallback | deterministic summariser always available; Bedrock/OpenAI optional |
| 11 | Alert acknowledgment and resolution | acknowledge → escalate (nurse) → resolve with mandatory note |
| 12 | Persistent history | SQLite: readings, alerts, notes, tasks, messages, audit log / patient timeline |
| 13 | End-to-end demo scenario | script above; automated in `tests/e2e.ts` |
| 14 | README | this file |

### P1 — status

| Feature | Status |
|---|---|
| Patient ↔ care-team messaging | Working (patient, caregiver, nurse, doctor share one thread per patient) |
| Caregiver dashboard | Working — restricted overview enforced by the API |
| Medication reminder tracking | Working — "taken" log with who/when. Tracking only; doses are never set by the app |
| Clinical tasks and follow-up | Working — create, assign by role, due times, completion, auto-task on escalation |
| Notifications | In-app toasts + alert badge for clinicians. No push/SMS/email |
| AI shift handover report | Working (`/handover`) |
| Hospital analytics | Working (`/admin`) — all figures computed from stored demo records |
| Audio/video consultation | **Partial.** Request → start → end workflow works and is audited. The room shows your **own** camera/mic preview only; there is no two-way media connection. Not exercised with a real camera during testing |
| Emergency transfer (ambulance + direct admission) | **Working with simulated ambulance service and hospital** — rule-based priority/pathway suggestion, clinician-confirmed dispatch, ISBAR handover, receiving-unit pre-alert and bed acceptance (ED bypass only after acceptance, ED fallback on decline), preparation checklist, live tracker, patient/caregiver status. Real integration contract + FHIR mapping: [`docs/EMERGENCY-TRANSFER.md`](docs/EMERGENCY-TRANSFER.md) |
| Automatic device uploads (no patient data entry) | **Working** — clinician-provisioned home hub, `POST /api/ingest/device` accepting HL7 FHIR Observations (LOINC) or simple JSON, matched by device serial, de-duplicated, same alert rules, satisfies scheduled measurements. Patient/caregiver typing is off unless a clinician enables a fallback. [`docs/DEVICE-GATEWAY.md`](docs/DEVICE-GATEWAY.md) |
| Voice commands + spoken replies (English / Arabic) | **Working** — push-to-talk via the browser's speech recognition, deterministic intents, spoken replies; writes need a spoken "yes", emergencies are sent at once, ambulances are never dispatched by voice. [`docs/VOICE.md`](docs/VOICE.md) |
| Red-flag symptoms + urgent help | **Working** — 8 red flags (tick boxes + English/Arabic text detection with negation) show emergency instructions instantly without AI and raise a critical alert; "I need urgent help" button for patient and caregiver |
| Heart-failure weight trend | **Working** — ≥ 2 kg in 72 h (demo setting), mentions breathlessness reported in the last 24 h |
| Smartwatch & phone health data | **Working** — per-device token links, `POST /api/ingest/wearable` accepting Health Auto Export (iOS / Apple Watch) JSON and a normalized format for Android / other apps, unit conversion, de-dup, the same alert rules, sync-overdue alerts, activity context. Tested with synthetic payloads; **not yet run with a real iPhone**. Design + plan: [`docs/WEARABLES.md`](docs/WEARABLES.md) |
| Bluetooth device adapter | **Scaffold only.** Capability detection + pairing scaffold; never tested against physical hardware; returns no readings |

### P2 — not built (roadmap)

Native iOS / Android companion apps for wearables and vendor-cloud pulls (Fitbit, Garmin, Withings — see `docs/WEARABLES.md`), medical-grade wearables, digital stethoscope, connected BP cuff, real ECG device, CGM, wound-image comparison, real ambulance-service (CAD) and hospital bed-management integration, EHR/FHIR, ML risk models, multi-hospital management.

## Safety behaviour worth showing judges

- **Missing or stale data is never shown as stable.** Disconnected devices and overdue check-ins get their own states; old values are greyed and labelled "last received — not current"; the simulator writes *no* readings for a disconnected device.
- **AI is boxed in.** Facts are assembled by code from stored records; a model (if configured) only re-words them under a strict prompt, and any failure falls back to the deterministic summary. Every summary carries a non-diagnostic disclaimer and names its engine.
- **Alerts are transparent rules**, each stating the reading and the limit crossed. Clinical alerts never clear themselves; only connectivity / check-in alerts auto-clear when data resumes, and that is logged as a system action.
- **Emergencies never wait for software.** Red-flag symptoms return the emergency number and instructions in the same response (no AI), every patient/caregiver screen shows the number, and an ambulance is dispatched only after a clinician confirms. The ambulance bypasses the ED only once the receiving unit has accepted; otherwise it goes to a pre-alerted ED.
- **Demo controls can be switched off.** `DEMO_MODE=false` disables the simulator, data reset, synthetic wearable syncs and the transfer demo clock in any environment that may hold real data.
- **Consumer wearables are labelled, not trusted blindly.** Smartwatch values carry their source everywhere, late-synced data is stored but cannot raise alerts as if it were current, a watch "AFib" classification is a review flag (never a diagnosis), and a watch that stops syncing raises its own alert.
- **Everything simulated says so**: `SIMULATED` badges on readings, devices and ECG; "SYNTHETIC" on patients.

## Roles and permissions (enforced on the server)

Every API route calls `requireUser(action)` / `requirePatientAccess(patientId, action)` (`src/lib/auth.ts`, `src/lib/permissions.ts`). Hiding a button is never the only control — the e2e test asserts the 401/403s.

| Capability | Admin | Doctor | Nurse | Patient | Caregiver |
|---|:-:|:-:|:-:|:-:|:-:|
| Virtual ward, alert queue, handover | – | ✓ | ✓ | – | – |
| Clinical record (notes, ECG, AI summary, timeline) | – | ✓ | ✓ | – | – |
| Own / linked patient overview | – | ✓ | ✓ | own only | linked patient, restricted fields |
| Acknowledge / resolve alerts | – | ✓ | ✓ | – | – |
| Escalate alert to doctor | – | – | ✓ | – | – |
| Configure per-patient monitoring limits | – | ✓ | – | – | – |
| Record admission assessment | – | ✓ | – | – | – |
| Record check-in note | – | – | ✓ | – | – |
| Report symptoms | – | – | ✓ | ✓ | ✓ |
| Type readings by hand | – | – | ✓ | only if a clinician enables the fallback | only if a clinician enables the fallback |
| Register home hub / allow manual-entry fallback | – | ✓ | ✓ | – | – |
| Messages | – | ✓ | ✓ | ✓ | ✓ |
| Request consultation | – | – | – | ✓ | ✓ |
| Request / manage an emergency transfer | – | ✓ | ✓ | – | – |
| "I need urgent help" button | – | – | – | ✓ | ✓ |
| Operations, staffing, defaults, access log | ✓ | – | – | – | – |
| Simulator controls (demo) | ✓ | ✓ | ✓ | – | – |

Administrators get operational data only — the API refuses them the clinical record. Clinicians can open any patient on the programme; "Assigned to me" is a ward filter.

## Simulator scenarios

| Patient | Scenario | Auto-starts (after *Start*) |
|---|---|---|
| Amelia Hart · VR-101 | Stable recovery | — |
| Samuel Okoro · VR-102 | Respiratory deterioration: SpO₂ 96→88 %, HR and RR rise, breathlessness report; scripted recovery after the SpO₂ alert is resolved | tick 5 |
| Layla Haddad · VR-103 | Cardiac: variable pulse + ECG with a **simulated** irregularity | tick 10 |
| Thomas Berg · VR-104 | Device disconnects, stops transmitting | tick 8 |
| Priya Nair · VR-201 | Spot-check devices via home hub; scheduled measurement not received | 30 s after seed/reset |
| Daniel Reyes · VR-202 | Newly admitted, awaiting doctor's assessment | — |

A tick is 3 s at ×1. The engine is lazy (no background timer): each data request advances it, so it survives hot reload and would work on serverless. The "recovery after resolution" step is a storyboard device, not a model of treatment effect.

## AI configuration (optional)

Without any key the built-in deterministic summariser is used — this is the only path exercised in testing.

```bash
# .env  (never commit — see .env.example)
AI_PROVIDER=auto                      # auto | bedrock | openai | deterministic
AWS_BEARER_TOKEN_BEDROCK=...          # Amazon Bedrock API key (preferred)
AWS_REGION=us-east-1
BEDROCK_MODEL_ID=...                  # a model/inference-profile ID enabled in your account
OPENAI_API_KEY=...                    # fallback
```

**Not verified:** the Bedrock (Converse API over HTTPS) and OpenAI code paths were written but never run against live services — no credentials were available. They fail safe to the deterministic summary.

## Device integration layer

`src/lib/devices.ts` defines the `DeviceAdapter` interface with three adapters:

- `SimulatedDeviceAdapter` — operational; drives this demo.
- `BluetoothDeviceAdapter` — Web Bluetooth capability detection and pairing scaffold (standard GATT services). Untested on hardware.
- `ExternalAPIAdapter` — documented contract for vendor clouds (Fitbit, Garmin, Withings…). Not connected.
- **Smartwatch & phone sync** (`src/lib/wearables.ts`, `src/app/api/ingest/wearable`) — a browser cannot read Apple Health or Health Connect, so the phone pushes data to the ingest endpoint with a per-device token: today via the iOS app *Health Auto Export*, later via our own companion apps. Full design, data mapping, API contract and roadmap: [`docs/WEARABLES.md`](docs/WEARABLES.md).

## Architecture

- **Frontend:** Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4, Recharts, Lucide icons, hand-rolled shadcn-style primitives (`src/components/ui.tsx`), canvas/SVG ECG renderer. Light and dark mode.
- **Backend:** Next.js route handlers → TypeScript service layer (`src/lib`) → Prisma → SQLite. Zod validation on every write.
- **Auth:** demo role selection with an HMAC-signed, HTTP-only session cookie. Set `SESSION_SECRET` outside local demos.

```
src/app/            pages: / (login), /ward, /patients/[id], /alerts, /handover, /admin, /me, /caregiver
src/app/api/        auth, ward, patients/[id], patients/[id]/[action], alerts, tasks, sim, handover, admin, ingest/wearable
src/lib/            simulator, alerts + rules, status, ai, seed, views (role-scoped read models), auth, permissions, devices, ecg, wearables, gateway, transfers, triage, voice, speech
src/components/     AppShell, SimControls, EcgMonitor, VitalChart, AlertList, SummaryView, CareWidgets, ui
prisma/             schema.prisma, seed.ts
tests/e2e.ts        end-to-end scenario + permission test
docs/WEARABLES.md   smartwatch & phone integration: design, API contract, roadmap
docs/EMERGENCY-TRANSFER.md  ambulance + direct admission: flow, safety rules, integration contract (FHIR)
docs/DEVICE-GATEWAY.md      automatic device uploads: home hub, FHIR/LOINC contract, provisioning, safety
docs/VOICE.md               voice commands and spoken replies: commands, safety rules, browser support
docs/PLAN-ALIGNMENT.md      what was taken from the AWS "Virtual Hospital at Home" plan, and what was not
```

### Target AWS architecture (design only — nothing is deployed)

| Concern | Now (local MVP) | Planned on AWS |
|---|---|---|
| API | Next.js route handlers | API Gateway + Lambda |
| Data | SQLite via Prisma | DynamoDB (readings as time-series items), S3 for ECG strips/exports |
| Identity | Demo cookie session | Cognito user pools + groups mapped to the same permission matrix |
| AI | Deterministic / optional Bedrock | Bedrock |
| Notifications | In-app toasts | SNS (SMS/push/email) |
| Device ingestion | Simulator + `/api/ingest/device` (home hub, FHIR) + `/api/ingest/wearable` (token-authenticated) | IoT/companion-app ingestion → Lambda → rules |
| Emergency transfer | Simulated ambulance + hospital adapters | Ambulance-service CAD integration + hospital FHIR / ADT (see `docs/EMERGENCY-TRANSFER.md`) |
| Observability | Console + audit table | CloudWatch |

No AWS resources were created and no credentials were read or used.

## Testing

`npm run test:e2e` drives the real API through the whole storyline and the permission model — **189 checks, all passing** at hand-over: seeding, 401/403 enforcement per role, deterioration → alerts, disconnect without fabricated data, missed check-in, acknowledge/escalate/resolve, AI summary content and disclaimer, patient/caregiver actions, per-patient limits driving alerts, handover report, admin analytics, smartwatch / phone ingest (tokens, both payload formats, unit conversion, rejection rules, de-dup, alerts, revoke), red-flag triage in English and Arabic, urgent help, emergency transfer (permissions, handover, unit acceptance, full-unit → ED fallback, stand-down rules) the heart-failure weight rule, voice commands in English and Arabic (intents, confirmation, emergency bypass, no voice dispatch, audit without transcripts), and automatic home-hub uploads (FHIR parsing, serial matching, units, de-dup, alerts, manual-entry lock and fallback, revoke).

Also verified by hand in the browser: every page for every role, live ward and bedside updates, alert resolve dialog, AI summary and handover generation, dark mode, phone width (no horizontal scroll). `npm run build` succeeds.

## Assumptions and known limitations

- Monitoring limits are **demo values**, not clinical guidance.
- Demo sign-in has no passwords; do not expose this build to the internet.
- Polling (2–4 s) rather than WebSockets; fine for a demo, not for scale.
- The trend wording in summaries compares the start and end of the last 20 minutes, so a dip-and-recover can read as a simple change.
- Blood glucose is stored in mg/dL (mmol/L shown alongside on tiles).
- Video consultation and Bluetooth are partial, as described above.
- No automated UI tests; the e2e suite covers the API.
- Voice: speech recognition needs Chrome, Edge or Safari; Arabic spoken replies need an Arabic voice on the device; browser speech services process audio in the cloud, so real deployments need an approved speech service. Arabic medicine names are not matched yet (say "my medicine" when there is only one, or use English names).
