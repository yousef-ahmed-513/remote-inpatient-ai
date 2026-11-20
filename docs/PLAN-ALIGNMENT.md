# Alignment with the "Virtual Hospital at Home" AWS plan

The plan describes a Python/Lambda/DynamoDB rebuild. This repo already delivers most of its
*product* goals on a different stack, so the plan was used as a checklist rather than a rewrite.

## Plan test scenarios → where they are covered

| Plan scenario | Expected behaviour | In this repo |
|---|---|---|
| HF-01 stable patient | No unjustified alert | *Amelia Hart* (STABLE scenario); e2e section 1 |
| HF-02 weight gain + worsening breathlessness | Review alert | **New:** weight-trend rule (≥ 2 kg / 72 h, mentions breathlessness) — `checkWeightTrend`, e2e section 11 |
| HF-03 new severe chest pain | Emergency instructions without waiting for AI | **New:** red-flag triage — instructions returned by the symptom API itself, critical alert, transfer suggestion — e2e section 10 |
| COPD-01 stable | Routine follow-up | Baseline phase of *Samuel Okoro* |
| COPD-02 worsening symptoms + RR | Alert to doctor | RESP scenario (SpO₂ trend, RR limits, symptom) — e2e section 3 |
| COPD-03 confusion / severe breathlessness | Direct to emergency care | **New:** red flags *confusion*, *severe breathlessness*, *blue lips* + emergency transfer |
| DATA-01 transmission stops | Data-loss alert, never "stable" | DISCONNECT scenario, NO_RECENT_DATA / DEVICE_DISCONNECTED states, wearable *sync overdue* |
| DATA-02 duplicate or late reading | No duplicate alert, show reading age | Alert de-duplication; wearable de-dup + alert window; every tile shows "measured X ago" and source |

## Adopted from the plan in this round

- Red-flag symptom handling that never waits for AI (HF-03, COPD-03) — English and Arabic.
- Heart-failure weight rule (HF-02).
- "Disable simulation APIs where real data exists" → `DEMO_MODE=false`.
- Per-patient targets set by the doctor — already present (per-patient limits), unchanged.

## Deliberately not adopted (and why)

| Plan item | Decision |
|---|---|
| Rewrite backend in Python 3.12 on Lambda + DynamoDB; static-export frontend | Not now — it would replace a working, tested system for no user-visible gain. The AWS mapping in the README keeps the path open. |
| Cognito, API Gateway, EventBridge/SQS, CloudFront, Terraform | Next candidate: a Terraform deployment of the *current* app (e.g. container on App Runner/ECS + RDS/Aurora, Cognito in front of the existing permission matrix). |
| Arabic + English UI | Next candidate — the red-flag detector already understands Arabic text; the UI strings are not translated yet. |
| Playwright UI tests | Next candidate — screenshots are produced in review, but not yet as a test suite. |
| Care-plan versioning table | Small follow-up: store each care-plan edit with author and time. |
