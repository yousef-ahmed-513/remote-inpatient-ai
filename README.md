# Remote Inpatient AI

**"Hospital-Level Care, From the Comfort of Home."**

A working hackathon MVP of an AI-assisted virtual hospital ward: patients are at home, their (simulated) monitoring devices stream vitals, and clinicians watch, get rule-based alerts, communicate, document and hand over — all in one place.

> **Demo only.** Every patient, reading, clinician and event is **synthetic**. This is not a medical device and has no clinical validation or certification. The platform supports clinicians; it does not replace them. AI output summarises recorded data and never diagnoses, prescribes, decides eligibility for hospital-at-home care, or makes emergency decisions.

---

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
| `npm run test:e2e` | 77-check end-to-end test (needs `npm run dev` running; resets demo data) |
| `npm run typecheck` | TypeScript check |

**macOS + iCloud Desktop note:** this folder ends in `.nosync` on purpose. On a Mac whose Desktop syncs to iCloud, iCloud turned freshly installed `node_modules` files into empty placeholders and broke the tooling; `.nosync` folders are skipped by iCloud. You can rename the folder freely once it lives outside an iCloud-synced location.

## Demo accounts (no passwords — all synthetic)

| Role | Account | Lands on |
|---|---|---|
| Nurse | Emily Carter, RN · Omar Aziz, RN | Virtual ward |
| Doctor | Dr. Sara Rahman · Dr. James Whitfield | Virtual ward |
| Patient | Samuel Okoro (respiratory) · Priya Nair (manual check-ins) · Amelia Hart (stable) | My care |
| Caregiver | Grace Okoro (for Samuel) | Care overview |
| Administrator | Morgan Lee | Operations |

## 5-minute demo script

1. **Sign in as Nurse (Emily Carter).** The virtual ward shows six virtual beds. Simulator is paused; Amelia is *Stable on latest readings*, Daniel is *Awaiting clinician assessment*.
2. Press **Start simulation** (use **×2** or **×5** to go faster). Within ~30 s at ×1:
   - **Priya Nair** misses her scheduled check-in → *No recent data* + overdue alert (not "stable").
   - **Samuel Okoro**'s SpO₂ declines → trend alert → review alert → simulated breathlessness report → **Critical demo alert**.
   - **Thomas Berg**'s device disconnects → *Device disconnected*, values greyed as "last received — not current", ECG shows **NO SIGNAL**. No readings are invented.
   - **Layla Haddad** gets a *Simulated irregular rhythm flag*; her ECG trace turns amber and a strip is auto-saved.
3. Open **Samuel Okoro → bedside view**: live tiles, synthetic ECG, trend charts with his doctor-configured limits. **Acknowledge** the critical alert, then **Escalate to doctor**.
4. **Switch role → Doctor (Dr. Sara Rahman).** Open Samuel, press **Generate** on *AI-assisted summary*, review the timeline, then **Resolve…** the SpO₂ alert with a note. The scripted scenario then moves to its recovery phase and SpO₂ climbs back.
5. *Devices & limits* tab → edit a monitoring limit (doctor only) and watch it drive alerting.
6. **Shift handover** → *Generate handover report*.
7. **Switch role → Patient (Priya Nair).** Send a glucose + blood-pressure check-in; the overdue alert clears itself on the ward. Try messaging, a symptom report, a consultation request.
8. **Caregiver (Grace Okoro):** restricted overview, record a spot check, tick off a task.
9. **Administrator (Morgan Lee):** capacity, monitoring status, alert response time computed from the records you just created, staffing, programme default limits, access log.
10. **Reset demo** (in the simulator bar) restores the starting state at any time. The *Scenarios* menu re-triggers any scenario on demand.

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
| Bluetooth device adapter | **Scaffold only.** Capability detection + pairing scaffold; never tested against physical hardware; returns no readings |

### P2 — not built (roadmap)

Physical wearables, digital stethoscope, connected BP cuff, real ECG device, CGM, wound-image comparison, ambulance dispatch, EHR/FHIR, ML risk models, multi-hospital management.

## Safety behaviour worth showing judges

- **Missing or stale data is never shown as stable.** Disconnected devices and overdue check-ins get their own states; old values are greyed and labelled "last received — not current"; the simulator writes *no* readings for a disconnected device.
- **AI is boxed in.** Facts are assembled by code from stored records; a model (if configured) only re-words them under a strict prompt, and any failure falls back to the deterministic summary. Every summary carries a non-diagnostic disclaimer and names its engine.
- **Alerts are transparent rules**, each stating the reading and the limit crossed. Clinical alerts never clear themselves; only connectivity / check-in alerts auto-clear when data resumes, and that is logged as a system action.
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
| Submit readings / symptoms | – | – | ✓ | ✓ | ✓ |
| Messages | – | ✓ | ✓ | ✓ | ✓ |
| Request consultation | – | – | – | ✓ | ✓ |
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
| Priya Nair · VR-201 | Manual check-ins; scheduled check-in missed | 30 s after seed/reset |
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
- `ExternalAPIAdapter` — documented contract for vendor clouds / an authorised companion app. A browser cannot read Apple HealthKit, Health Connect or Wear OS data directly; no such integration is claimed.

## Architecture

- **Frontend:** Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4, Recharts, Lucide icons, hand-rolled shadcn-style primitives (`src/components/ui.tsx`), canvas/SVG ECG renderer. Light and dark mode.
- **Backend:** Next.js route handlers → TypeScript service layer (`src/lib`) → Prisma → SQLite. Zod validation on every write.
- **Auth:** demo role selection with an HMAC-signed, HTTP-only session cookie. Set `SESSION_SECRET` outside local demos.

```
src/app/            pages: / (login), /ward, /patients/[id], /alerts, /handover, /admin, /me, /caregiver
src/app/api/        auth, ward, patients/[id], patients/[id]/[action], alerts, tasks, sim, handover, admin
src/lib/            simulator, alerts + rules, status, ai, seed, views (role-scoped read models), auth, permissions, devices, ecg
src/components/     AppShell, SimControls, EcgMonitor, VitalChart, AlertList, SummaryView, CareWidgets, ui
prisma/             schema.prisma, seed.ts
tests/e2e.ts        end-to-end scenario + permission test
```

### Target AWS architecture (design only — nothing is deployed)

| Concern | Now (local MVP) | Planned on AWS |
|---|---|---|
| API | Next.js route handlers | API Gateway + Lambda |
| Data | SQLite via Prisma | DynamoDB (readings as time-series items), S3 for ECG strips/exports |
| Identity | Demo cookie session | Cognito user pools + groups mapped to the same permission matrix |
| AI | Deterministic / optional Bedrock | Bedrock |
| Notifications | In-app toasts | SNS (SMS/push/email) |
| Device ingestion | Simulator | IoT/companion-app ingestion → Lambda → rules |
| Observability | Console + audit table | CloudWatch |

No AWS resources were created and no credentials were read or used.

## Testing

`npm run test:e2e` drives the real API through the whole storyline and the permission model — **77 checks, all passing** at hand-over: seeding, 401/403 enforcement per role, deterioration → alerts, disconnect without fabricated data, missed check-in, acknowledge/escalate/resolve, AI summary content and disclaimer, patient/caregiver actions, per-patient limits driving alerts, handover report, admin analytics.

Also verified by hand in the browser: every page for every role, live ward and bedside updates, alert resolve dialog, AI summary and handover generation, dark mode, phone width (no horizontal scroll). `npm run build` succeeds.

## Assumptions and known limitations

- Monitoring limits are **demo values**, not clinical guidance.
- Demo sign-in has no passwords; do not expose this build to the internet.
- Polling (2–4 s) rather than WebSockets; fine for a demo, not for scale.
- The trend wording in summaries compares the start and end of the last 20 minutes, so a dip-and-recover can read as a simple change.
- Blood glucose is stored in mg/dL (mmol/L shown alongside on tiles).
- Video consultation and Bluetooth are partial, as described above.
- No automated UI tests; the e2e suite covers the API.
