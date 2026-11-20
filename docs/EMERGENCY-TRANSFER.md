# Emergency transfer — ambulance + direct admission

Goal: when a virtual-ward patient deteriorates, get them to the right hospital team **fast**, with the
receiving unit already prepared, and — when the unit agrees — **straight to the unit instead of
through the emergency department (ED)**.

> Everything outside this app (ambulance service, hospital) is **simulated** in the demo. The adapter
> contracts below are what a real integration has to implement.

## 1. The flow

```
 Red-flag symptom ─┐   Critical alert ─┐   Urgent-help button ─┐
 (patient/caregiver)│  (rules engine)   │  (patient/caregiver)  │
                    └───────────────────┴──────────┬────────────┘
                                                   ▼
                     Nurse / doctor opens "Emergency transfer" (bedside)
                     ├─ rules suggest PRIORITY + RECEIVING PATHWAY (+ reasons)
                     └─ clinician confirms / changes, writes the reason  ◀── a human always decides
                                                   │
               ┌───────────────────────────────────┼───────────────────────────────────┐
               ▼                                   ▼                                   ▼
   AmbulanceAdapter.requestDispatch     HospitalAdapter.preAlert(unit)       ISBAR handover snapshot
   incident ref · vehicle · ETA         ISBAR + preparation checklist        (vitals with time + source,
               │                                   │                          meds, alerts, address)
               ▼                                   ▼
   REQUESTED → DISPATCHED → ON_SCENE      unit decides BEFORE the crew leaves:
        → TRANSPORTING → ARRIVED          ├─ ACCEPT  → bed reserved → crew drives to the unit (no ED)
        → HANDED_OVER                     └─ DECLINE → destination = ED, pre-alerted (safety fallback)
               │
   live tracker for clinicians · status card + instructions for patient & caregiver · ward banner
```

## 2. What is built (and tested)

| Piece | Where |
|---|---|
| Rule-based suggestion: priority + pathway with reasons (red flags › rhythm/HR › SpO₂/RR › sepsis screen › glucose › post-op) | `suggestTransfer` in `src/lib/transfers.ts` |
| Request dialog (suggested choices marked, pickup address, access notes, reason) | `TransferRequestDialog` in `src/components/TransferWidgets.tsx` |
| ISBAR handover frozen at request time | `buildHandover` |
| Simulated ambulance (incident, vehicle, ETA) and hospital (bed table, accept/decline) | `simulatedAmbulance`, `simulatedHospital` |
| Stage progression, unit decision, ED fallback, preparation items | `advanceTransfers` (runs in the simulator housekeeping pass) |
| Clinician tracker: stepper, ETA, destination + bed, readiness, timeline, handover, stand-down | `TransferPanel` |
| Patient / caregiver status card with plain-language instructions and a call button | `PatientTransferCard` |
| "I need urgent help" button (patient + caregiver) → CRITICAL alert, emergency number shown | `UrgentHelpButton`, `urgentHelp` |
| Red-flag symptom triage (8 flags, tick boxes + English/Arabic keyword detection with negation) → emergency instructions **immediately, no AI** + CRITICAL alert | `src/lib/triage.ts`, `SymptomForm` |
| Ward banner + card badge for open transfers | `WardClient` |

API (all under `/api/patients/:id/`): `transfer-suggest`, `transfer-request`, `transfer-prep`,
`transfer-cancel`, `transfer-advance` (demo clock only), `urgent-help`. Permissions: nurses and doctors
request and manage; patients and caregivers can only press *urgent help* and see the status;
admins have no access. `npm run test:e2e` section **10** checks all of it, including the CCU-full →
ED fallback.

## 3. Safety rules (why it behaves the way it does)

1. **A clinician confirms every dispatch.** The rules engine only suggests. Patients cannot dispatch an
   ambulance from the app — for a life-threatening problem they must call the emergency number, which
   is shown on every patient and caregiver screen, in the red-flag panel and in the urgent-help dialog.
2. **No ED bypass without acceptance.** The ambulance is sent to a unit only after that unit accepts
   (with a bed). A decline sends the patient to the ED, which receives the full handover, and the team
   gets an alert. The decision is forced before the crew leaves the house; a real integration must
   treat *no answer by then* as a decline.
3. **Red flags never wait for AI.** The symptom endpoint returns the emergency instructions in the same
   response, from deterministic rules. The AI summary is never in this path.
4. **The handover is a snapshot.** Every value carries its time and source; allergies are marked "not
   recorded" rather than guessed.
5. **Preparation items are owned.** The virtual ward ticks its own items; receiving-unit items can only
   be confirmed by the hospital side (simulated here) — the API refuses the virtual ward ticking them.
6. **Stand-down needs a reason**, and is refused once the patient has arrived.
7. **Demo controls are off in real environments** (`DEMO_MODE=false` disables the simulator, demo
   syncs and the transfer demo clock).

## 4. Real integration — what has to be agreed and built

### Ambulance service (`AmbulanceAdapter`)

| Method | Real-world counterpart |
|---|---|
| `requestDispatch` | Create an incident in the service's computer-aided dispatch (CAD) system: location, callback number, priority, clinical summary. Returns incident ID, assigned unit, ETA. |
| status updates | CAD status feed (webhook / message queue) → replace the simulated schedule with real timestamps; vehicle GPS for a live map. |
| `updateDestination` | Destination change pushed to the crew's tablet. |
| `cancel` | Stand-down message to dispatch. |

There is no universal public API for this. It needs a **data-sharing agreement** with the national
ambulance service (in Oman, for example, the Civil Defence and Ambulance Authority), and usually a
direct line as a fallback. Until then, the realistic first step is a **clinician phone call with the
handover on screen** — the app already gives the reason, address, access notes and ISBAR in one place.

### Receiving hospital (`HospitalAdapter`)

| Step | HL7 FHIR R4 | HL7 v2 alternative |
|---|---|---|
| Pre-alert / request | `ServiceRequest` (transfer) + `Encounter` (status `planned`) | ADT^A14 pending admit / ADT^A05 pre-admit |
| Handover | `Composition` (ISBAR sections) + `Observation` + `MedicationStatement` in a `Bundle` | ORU / document attachment |
| Preparation items | `Task` per item, owner = unit | — |
| Accept + bed | `Encounter.location` → `Location` (bed), `Task.status=accepted` | ADT^A14 with bed |
| Arrival / handover | `Encounter.status` `arrived` → `in-progress` | ADT^A01 admit |

The direct-admission pathways must be **agreed clinical protocols** with the hospital (which
presentations may bypass the ED, who accepts, how fast). The demo's pathways and preparation lists are
examples only.

## 5. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `EMERGENCY_NUMBER` | `9999` | Shown to patients and caregivers (Oman; change per country, e.g. 999 / 911 / 112) |
| `AMBULANCE_SERVICE_NAME` | `Ambulance service (simulated)` | Label |
| `RECEIVING_HOSPITAL_NAME` | `City General Hospital (simulated)` | Label |
| `TRANSFER_TIME_SCALE` | `0.1` | Demo clock: 0.1 = stages run 10× faster than a real call-out (1 = real time) |
| `DEMO_MODE` | `true` | `false` disables every demo-only control |

## 6. Demo script (2 minutes)

1. As **Samuel Okoro** (patient): tick *New or severe chest pain* → **Send — this is urgent**. The red
   emergency panel with *Call 9999* appears instantly.
2. As **Dr. Sara Rahman**: the ward shows a critical *Red-flag symptom* alert → open Samuel →
   **Emergency transfer**. Emergency priority and the Cardiac / CCU pathway are pre-selected with the
   reasons. Add a reason → **Request ambulance**.
3. Press **Next stage (demo)** twice: the CCU accepts, *CCU Bed 3* is reserved, the badge says *Direct
   admission — bypasses the emergency department*, preparation items tick themselves off.
4. Switch to Samuel or Grace (caregiver): the status card shows the ETA, where he is going and what to
   do now.
5. Optional: request CCU transfers for two more patients — the third is declined and automatically
   redirected to the pre-alerted ED.
