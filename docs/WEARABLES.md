# Smartwatch & phone health data — design and integration plan

Goal: let a patient on the virtual ward share data that their **own** smartwatch and phone already
collect (Apple Watch / iPhone, Android phones, Wear OS, Galaxy Watch, Fitbit, Garmin …) so the care
team sees it next to the programme's monitoring devices, under the same alert rules and the same
safety principles.

> Consumer wearables are **not** medical devices. Their values are always labelled with their
> source, never presented as clinical-grade, and never used to diagnose. A watch "AFib" classification
> becomes a review flag for a clinician, not a finding.

---

## 1. The constraint that shapes everything

A website cannot read a phone's health store:

| Store | Who can read it |
|---|---|
| **Apple Health (HealthKit)** — iPhone + Apple Watch, plus anything that writes to Health (Withings, Oura, glucose meters, BP cuffs…) | Only a native iOS app the user has granted permission to. No web or cloud API. |
| **Health Connect** — Android; Wear OS, Samsung Health, Fitbit, Garmin, Withings and others can write into it | Only an installed Android app with Health Connect permissions. No web or cloud API. |
| Vendor clouds (Fitbit Web API, Garmin Health API, Withings, Oura …) | Server-to-server with OAuth; some need partner approval. |

So the phone (or a vendor cloud) has to **push** data to us. The platform provides one push target
that every route can use:

```
 Apple Watch ─┐                                   ┌──────────────────────────────────────────┐
 iPhone ──────┼─▶ Apple Health ─▶ exporter app ───┤                                          │
              │   (Health Auto Export, or our     │  POST /api/ingest/wearable               │
              │    own iOS companion — phase 2)   │  Authorization: Bearer ria_wk_…          │
 Wear OS ─────┐                                   │                                          │
 Galaxy Watch ┼─▶ Health Connect ─▶ Android ──────┤  1. token → patient's link (hash lookup) │
 Fitbit/Garmin┘                     companion app │  2. parse  (HAE JSON | normalized JSON)  │
                                    (phase 2)     │  3. validate · convert units · de-dup    │
 Vendor clouds ─▶ server-side pull (phase 3) ─────┤  4. store Reading(source=WEARABLE_SYNC)  │
                                                  │  5. same limit rules → alerts            │
                                                  │  6. audit log / patient timeline         │
                                                  └──────────────────────────────────────────┘
                                                     ward card · bedside view · patient app ·
                                                     AI summary facts · sync-overdue alert
```

## 2. What is built now (and tested)

| Piece | Where | Status |
|---|---|---|
| Per-device links with one-time tokens (create, list, revoke) | `POST /api/patients/:id/wearable-link`, `…/wearable-revoke`; *Smartwatch & phone* panel in **My care** (patient) and **Devices & limits** (clinicians) | Working |
| Ingest endpoint (token-authenticated, no user session) | `src/app/api/ingest/wearable/route.ts` | Working |
| **Health Auto Export** (iOS) JSON parser — metrics, ECG, heart-rate notifications | `src/lib/wearables.ts` → `parseHealthAutoExport` | Working against the documented format; **not yet run with a real iPhone** |
| Normalized JSON format for our own companion apps / any service | `normalizedSchema` in `src/lib/wearables.ts` | Working |
| Validation, unit conversion, de-duplication, alerting, audit | `ingestWearableBatch` | Working |
| Sync-overdue alert (watch went quiet) | `checkWearableSync`, run from the simulator's housekeeping pass | Working |
| Activity context: steps (24 h), sleep, resting HR, HRV | `activitySummary` in `src/lib/views.ts`; `ActivityStrip` | Working |
| Demo sync (synthetic HAE payload through the real path, labelled SIMULATED) | `…/wearable-demo`, *Send demo sync* button | Working |
| iOS companion app (HealthKit background delivery) | — | Planned (phase 2) |
| Android companion app (Health Connect) | outline in §8 | Planned (phase 2) |
| Vendor cloud pulls (Fitbit, Garmin, Withings, Oura) | `ExternalAPIAdapter` contract in `src/lib/devices.ts` | Planned (phase 3) |

`npm run test:e2e` section **9** covers the path end to end (30 checks: permissions, 401s, both
formats, unit conversion, rejection rules, de-dup, alerts, AI-summary labelling, demo, revoke).

## 3. Try it

**Without a phone:** sign in as *Amelia Hart* → **My smartwatch & phone** → *Link a smartwatch or
phone* → *Create link* → *Done* → pick a demo scenario → **Send demo sync**. Then switch to a nurse or
doctor: the ward card shows the watch and last sync, the bedside view shows the steps / sleep / HRV
strip, and the AFib or low-SpO₂ scenario raises review alerts.

**With curl** (token from the link dialog):

```bash
curl -X POST http://localhost:3210/api/ingest/wearable \
  -H "Authorization: Bearer ria_wk_…" -H "content-type: application/json" \
  -d '{"samples":[{"type":"HR","value":72,"takenAt":"2026-11-20T14:30:00Z"},
                  {"type":"SPO2","value":0.97,"takenAt":"2026-11-20T14:30:00Z"}]}'
```

`GET /api/ingest/wearable` with the same header is a connection test.

**With an iPhone + Apple Watch (phase 1, no code):**

1. The server must be reachable from the phone — `localhost` is not. Use the computer's LAN address on
   the same Wi-Fi (`http://192.168.x.x:3210`) for a quick test, or a deployed **HTTPS** URL.
2. Install **Health Auto Export – JSON+CSV** (third-party; automations need its premium tier).
3. *Automations → New → REST API*: URL `https://<host>/api/ingest/wearable`, header
   `Authorization: Bearer <token>`, format **JSON**, data type **Health Metrics** (enable *Summarize
   data* so sleep arrives as one record per night). Optional extra automations for **ECG** and
   **Heart Rate Notifications**.
4. Set an interval (e.g. 15 min) and tap *Manual export* once — the link shows "last sync just now".

Note: **Reset demo** wipes all links (it re-seeds the database), so create the link again afterwards.

## 4. Data mapping

| Health Auto Export metric | Normalized `type` | Stored as | Unit handling | Alert rules |
|---|---|---|---|---|
| `heart_rate` (`Avg`, else `qty`) | `HR` | HR | bpm | ✓ HR limits |
| `blood_oxygen_saturation` | `SPO2` | SpO₂ | fraction (0.97) → % | ✓ |
| `respiratory_rate` | `RR` | RR | breaths/min | ✓ |
| `body_temperature` | `TEMP` | Temp | °F → °C | ✓ |
| `blood_pressure` (`systolic`/`diastolic`) | `BP` (`value2` = diastolic) | BP | mmHg | ✓ both |
| `blood_glucose` | `GLUCOSE` | Glucose | mmol/L → mg/dL | ✓ |
| `weight_body_mass` | `WEIGHT` | Weight | lb / g → kg | — |
| `step_count` | `STEPS` | activity | count; summed over 24 h | — (context) |
| `sleep_analysis` (summarized `totalSleep`) | `SLEEP` | activity | hours | — |
| `resting_heart_rate` | `RESTING_HR` | activity | bpm | — |
| `heart_rate_variability` | `HRV` | activity | ms | — |
| `ecg[]` — `classification`, `averageHeartRate` | event `ECG` | audit + alert | — | "Atrial Fibrillation" → rhythm flag |
| `heartRateNotifications[]` | `IRREGULAR_RHYTHM` / `HIGH_HR` / `LOW_HR` | audit (+ alert) | the HR samples inside are stored as HR | irregular → rhythm flag; high/low → via HR limits |

Anything else (e.g. `active_energy`) is reported back in `ignoredMetrics` and not stored. Apple's
*wrist temperature* is a relative deviation, not body temperature, so it is deliberately not mapped to
Temp. ECG voltage arrays are not stored (data minimisation) — only the device's classification.

## 5. API contract

`POST /api/ingest/wearable` — `Authorization: Bearer <token>` (or `X-Device-Token`), JSON body ≤ 5 MB,
≤ 20 000 samples per request.

**Format A — Health Auto Export:** `{ "data": { "metrics": [...], "ecg": [...], "heartRateNotifications": [...] } }`,
dates `yyyy-MM-dd HH:mm:ss Z`.

**Format B — normalized** (for our companion apps and any other integrator):

```jsonc
{
  "device":  { "name": "Pixel Watch 2", "model": "…", "os": "Wear OS 4" },          // optional
  "samples": [
    { "type": "HR",   "value": 74,  "takenAt": "2026-11-20T14:30:00Z", "source": "Pixel Watch" },
    { "type": "BP",   "value": 128, "value2": 82, "takenAt": 1763649000 },          // epoch s or ms OK
    { "type": "TEMP", "value": 99.1, "unit": "degF", "takenAt": "…" },               // unit optional
    { "type": "STEPS", "value": 640, "takenAt": "…" }
  ],
  "events": [
    { "kind": "ECG", "classification": "Atrial Fibrillation", "heartRate": 118, "takenAt": "…" }
  ]
}
```

`type` ∈ `HR SPO2 BP TEMP RR GLUCOSE WEIGHT STEPS SLEEP RESTING_HR HRV`;
`kind` ∈ `ECG IRREGULAR_RHYTHM HIGH_HR LOW_HR`.

**Response 200**

```json
{ "ok": true, "format": "normalized", "received": 4, "accepted": 3, "duplicates": 0,
  "rejected": { "timestamp in the future": 1 }, "ignoredMetrics": [],
  "byType": { "HR": 1, "BP": 1, "STEPS": 1 }, "alertsRaised": 0, "eventsRecorded": 1 }
```

Errors: `401` missing/unknown/revoked token · `400` not JSON / unrecognised shape / schema error ·
`413` too large. A rejected *sample* never fails the whole batch — it is counted in `rejected`.

## 6. Data rules (safety)

- **Labelled everywhere.** `source = WEARABLE_SYNC` ("Smartwatch / phone sync"), quality
  `CONSUMER_WEARABLE`; demo data is `WEARABLE_DEMO` and carries the SIMULATED badge. Alert messages
  name the device and the time of measurement; AI-summary facts add "consumer device — not clinically
  validated".
- **Validation.** Plausibility ranges per type; timestamps more than 5 min in the future or older than
  30 days are rejected; BP needs both values.
- **De-duplication.** Exporters resend overlapping windows: `(device, type, takenAt)` is unique in
  practice — repeats are skipped and counted.
- **Latest values only move forward.** Back-filled data is stored for trends but never replaces a
  newer reading on the tiles.
- **Late data does not alarm as if it were current.** Only vitals measured within
  `WEARABLE_ALERT_WINDOW_MIN` (default 60) run the limit rules — once per vital per sync, on the worst
  recent breach. Rhythm classifications can alert for 24 h.
- **Silence is not "stable".** A link that has synced before but not for `WEARABLE_SYNC_STALE_MIN`
  (default 360) raises *Wearable sync* (`SYNC_OVERDUE`); it clears itself on the next sync or if the
  link is revoked, and is raised once per silence (a clinician's resolution sticks).
- **Passive data is not a check-in.** A sync does not satisfy a scheduled patient check-in — the care
  team decides what a check-in needs.
- A wearable never changes the *Device disconnected* state of the programme's own monitoring devices.

## 7. Security & privacy

- Tokens: 192 random bits, prefix `ria_wk_`, shown **once**, stored only as SHA-256 (`Device.tokenHash`),
  never sent to the browser again (the UI shows the last 4 characters). One token per device; a patient
  can hold up to 5 active links.
- Revocation is immediate (hash cleared, status `REVOKED`); readings already received are kept for the
  record.
- Who can link / revoke / demo: the patient (own record), nurses and doctors (`device:manage`).
  Caregivers and administrators cannot.
- Every link, revoke, sync and watch event is written to the audit log and the patient timeline.
- **Production must-haves (not in this MVP):** HTTPS only; rate limiting per token and per IP;
  request signing or token rotation; a consent record and data-sharing notice before linking; data
  retention policy for consumer data; regional hosting/compliance review (e.g. HIPAA / GDPR / local
  health-data law).

## 8. Phase 2 — companion apps (outline, not built)

**iOS (Swift):** request HealthKit read access for the mapped types; `HKObserverQuery` +
`enableBackgroundDelivery(for:frequency: .immediate)` per type; on wake, `HKAnchoredObjectQuery` from the
stored anchor → map to the normalized format → POST with the device token kept in the Keychain → save
the new anchor only after a 200. ECG via `HKElectrocardiogram` (classification + average HR);
irregular rhythm via the `irregularHeartRhythmEvent` category type.

**Android (Kotlin, Health Connect):**

```kotlin
// Periodic WorkManager job (e.g. every 15 min). Uses a Health Connect changes token so each run
// only reads what is new. Needs the read permissions below + the background-read permission.
suspend fun syncOnce(hc: HealthConnectClient, api: IngestApi, store: TokenStore) {
    val token = store.changesToken ?: hc.getChangesToken(
        ChangesTokenRequest(setOf(HeartRateRecord::class, OxygenSaturationRecord::class,
            RespiratoryRateRecord::class, BloodPressureRecord::class, BodyTemperatureRecord::class,
            BloodGlucoseRecord::class, WeightRecord::class, StepsRecord::class)))
    var next = token
    val samples = mutableListOf<Sample>()
    do {
        val res = hc.getChanges(next)
        res.changes.filterIsInstance<UpsertionChange>().forEach { c ->
            when (val r = c.record) {
                is HeartRateRecord -> r.samples.forEach { samples += Sample("HR", it.beatsPerMinute.toDouble(), it.time) }
                is OxygenSaturationRecord -> samples += Sample("SPO2", r.percentage.value, r.time)
                is RespiratoryRateRecord -> samples += Sample("RR", r.rate, r.time)
                is BloodPressureRecord -> samples += Sample("BP", r.systolic.inMillimetersOfMercury, r.time,
                                                             value2 = r.diastolic.inMillimetersOfMercury)
                is BodyTemperatureRecord -> samples += Sample("TEMP", r.temperature.inCelsius, r.time)
                is BloodGlucoseRecord -> samples += Sample("GLUCOSE", r.level.inMilligramsPerDeciliter, r.time)
                is WeightRecord -> samples += Sample("WEIGHT", r.weight.inKilograms, r.time)
                is StepsRecord -> samples += Sample("STEPS", r.count.toDouble(), r.endTime)
            }
        }
        next = res.nextChangesToken
    } while (res.hasMore)
    if (samples.isEmpty() || api.post(samples).isSuccessful) store.changesToken = next   // retry next run on failure
}
```

Both apps: pairing by scanning a QR code that carries the upload URL + token (the link dialog already
shows both); offline queue with retry; batch ≤ 5 000 samples.

## 9. Phase 3 — vendor clouds

For patients whose data never reaches the phone store, a server job pulls from vendor APIs with the
patient's OAuth consent (Fitbit Web API, Garmin Health API, Withings, Oura …), maps to the normalized
format and calls `ingestWearableBatch` directly. This is what `ExternalAPIAdapter` in
`src/lib/devices.ts` describes. Some of these programmes require a partner agreement.

## 10. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `WEARABLE_ALERT_WINDOW_MIN` | `60` | Only vitals measured this recently can raise limit alerts |
| `WEARABLE_SYNC_STALE_MIN` | `360` | Minutes without a sync before *Wearable sync* alert |

Schema additions (`prisma db push` applies them): `Device.platform`, `tokenHash` (indexed),
`tokenHint`, `syncCount`, `createdAt`; index `Reading(deviceId, takenAt)`. If an older local
`dev.db` refuses the push, run `npm run db:reset`.
