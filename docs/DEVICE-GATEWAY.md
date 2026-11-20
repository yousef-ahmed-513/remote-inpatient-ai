# Automatic device uploads — no patient data entry

In a hospital-at-home programme the patient is an **inpatient**: they should not be typing numbers.
Readings travel from the medical devices to the care team on their own. The patient only *uses* the
device (wears the patch, puts the cuff on, uses the glucose meter); everything after that is automatic.

## 1. Architecture

```
  At home                                             This app
 ┌──────────────────────────────────────────┐
 │ ECG/vitals patch · pulse-oximeter ring   │  continuous
 │ BP cuff · glucose meter · thermometer ·  │  "on use" (spot-check)
 │ smart scale                              │
 │        │ Bluetooth LE, standard profiles │
 │        ▼ (paired by the nurse, not the   │
 │   cellular HOME HUB   patient)           │
 └────────┬─────────────────────────────────┘
          │ HTTPS · Authorization: Bearer ria_hub_…  (one token per hub, revocable)
          ▼
   POST /api/ingest/device ── FHIR Observation(s) with LOINC codes, device.identifier = serial
          │
          ├─ serial → the device paired with THIS hub's patient (unknown serial → rejected)
          ├─ validate time / plausibility · convert units (mmol/L, °F, lb, UCUM codes)
          ├─ de-duplicate (hubs retry)                     ├─ store: source DEVICE_HUB, quality MEDICAL_DEVICE
          ├─ same per-patient limit rules + weight trend   ├─ scheduled measurement satisfied automatically
          └─ audit (HUB_UPLOAD)                            └─ device "last upload" updated
```

A cellular hub (its own SIM, no Wi-Fi setup, no app on the patient's phone) is the standard pattern in
remote-monitoring programmes because it removes every step the patient could get wrong.

Bluetooth LE standard profiles the hub reads: Blood Pressure (0x1810), Glucose (0x1808), Pulse Oximeter
(0x1822), Health Thermometer (0x1809), Weight Scale (0x181D), Heart Rate (0x180D). Devices outside these
profiles need the vendor's SDK on the hub, or the vendor's cloud API (§5).

## 2. Workflow

| When | Who | What |
|---|---|---|
| Admission | Nurse | *Devices & limits* → **Register home hub** → token is shown once → entered into the hub's installer app. All of the patient's medical devices are paired with the hub by serial number. |
| Every day | Patient | Uses the devices. Nothing to type, nothing to send. *My monitoring devices* shows each device and its last upload. |
| Scheduled time | System | A device reading that arrives in the window counts as the scheduled measurement. If none arrives, *Scheduled measurement not received* is raised and the patient shows *No recent data* — never "stable". |
| Device fault | Nurse / doctor | **Allow manual entry** with a reason (audited). Only then can the patient or caregiver type a reading, labelled patient- or caregiver-reported. Switched off again the same way. |
| Discharge / lost hub | Nurse | **Revoke hub** — its token stops working immediately; devices are unpaired. |

Nurses can always enter a reading (e.g. on a home visit); it is labelled *clinician-entered*.

## 3. Upload contract

`POST /api/ingest/device` · `Authorization: Bearer <hub token>` · JSON (`application/json` or
`application/fhir+json`) · ≤ 5 MB / 5 000 observations · `GET` with the same header = connection test.

**FHIR R4** — a `Bundle` (any type) of `Observation`s, or a single `Observation`:

```json
{
  "resourceType": "Observation",
  "status": "final",
  "code": { "coding": [{ "system": "http://loinc.org", "code": "85354-9" }] },
  "effectiveDateTime": "2026-11-20T16:02:00Z",
  "device": { "identifier": { "value": "BPC-0005-2" } },
  "component": [
    { "code": { "coding": [{ "system": "http://loinc.org", "code": "8480-6" }] }, "valueQuantity": { "value": 128, "code": "mm[Hg]" } },
    { "code": { "coding": [{ "system": "http://loinc.org", "code": "8462-4" }] }, "valueQuantity": { "value": 80, "code": "mm[Hg]" } }
  ]
}
```

| LOINC | Measurement | Units accepted |
|---|---|---|
| 8867-4 | Heart rate | /min |
| 59408-5, 2708-6 | SpO₂ | % (or fraction) |
| 85354-9 (+ 8480-6 / 8462-4 components) | Blood pressure | mm[Hg] |
| 8310-5 | Body temperature | Cel, [degF] |
| 9279-1 | Respiratory rate | /min |
| 2339-0 / 15074-8 | Blood glucose | mg/dL / mmol/L (converted) |
| 29463-7 | Body weight | kg, [lb_av], g |

Other codes are listed in `ignoredCodes` and not stored. Observations with status other than
final / amended / corrected / preliminary are refused.

**Simple JSON** (for hubs without FHIR): `{ "readings": [{ "serial": "GLC-0005-1", "type": "GLUCOSE", "value": 7.4, "unit": "mmol/L", "takenAt": "2026-11-20T16:02:00Z" }] }`.

**Response:** `{ accepted, duplicates, rejected: { reason: count }, ignoredCodes, byType, alertsRaised, scheduledMeasurementMet }`.
A bad observation never fails the whole upload.

## 4. In the demo

- *Priya Nair*'s glucose meter and BP cuff are paired with a pre-provisioned hub. Nobody knows its token
  (only a hash is stored), so **Send demo upload** builds a FHIR bundle and runs it through the same
  parser and ingest code. Demo uploads are labelled *Home hub demo upload (synthetic)*.
- The other patients' continuous devices are simulated. Registering a hub for them pairs their devices,
  and real FHIR uploads are then accepted alongside the simulator.
- `npm run test:e2e` sections 6 and 13 cover it (provisioning, FHIR parsing, serial matching, units, de-dup, alerts, scheduled measurement, manual-entry lock and fallback, revoke).
- **Not yet tested with a physical hub.**

## 5. Production path

1. Choose a hub that can POST FHIR (or the simple JSON) — or put a small adapter in front of the
   vendor's hub cloud that converts to this contract.
2. Per-hub identity: today a bearer token; in production mutual TLS / X.509 per hub (e.g. AWS IoT Core
   → rule → this ingest logic in Lambda, as the AWS plan suggests).
3. Devices that only talk to their own vendor cloud: a server-side pull with the vendor's API, mapped to
   the same `ingestGatewayBatch`.
4. Clinical sign-off of the device list, the scheduled-measurement windows and the limits.
