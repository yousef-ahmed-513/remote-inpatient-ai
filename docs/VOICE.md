# Voice commands and spoken replies (English + Arabic)

A microphone button sits at the bottom-right of every patient, caregiver and clinician screen.
Tap it, speak, and the assistant answers out loud. Typing works too (and is the fallback when a
browser has no speech recognition).

```
 browser mic ──SpeechRecognition (en-GB / ar-SA)──▶ transcript
                                                       │  POST /api/voice  { text, lang, patientId? }
                                                       ▼
                                   src/lib/voice.ts  — deterministic intent rules (no LLM)
                                   reply text  +  (for writes) calls to EXISTING endpoints
                                                       │
            read-only → spoken at once      write → "say yes to confirm"      emergency → sent at once
                                                       │
                          browser runs the calls (same permission checks + audit as the buttons)
                                                       ▼
                                 speechSynthesis speaks the result (Arabic or English voice)
```

## What you can say

| Who | Examples (English) | Examples (Arabic) | What happens |
|---|---|---|---|
| Patient / caregiver | "what are my readings", "what's my oxygen" | «ما قراءاتي»، «كم ضغطي» | Values read out with time and source |
| | "my blood pressure is 128 over 82", "my sugar is 7.2" | «ضغطي ١٣٠ على ٨٥»، «السكر 140» | Confirm → `/readings` (mmol/L and °F converted, said back) |
| | "I took my metformin" | «أخذت دوائي» | Confirm → `/medlog` |
| | "I feel slightly dizzy" | «أشعر بدوخة خفيفة» | Confirm → `/symptoms` |
| | "I have chest pain", "I can't breathe" | «عندي ألم في الصدر» | **Red flag: sent immediately**, emergency number spoken + call button |
| | "urgent help", "I need an ambulance" | «ساعدوني»، «إسعاف» | **Urgent help sent immediately**, emergency number spoken |
| | "where is the ambulance" | «أين الإسعاف» | Transfer status + ETA |
| | "when is my next check-in", "read my messages", "tell my nurse I slept badly", "I want a video call", "how am I doing" | «متى موعد القياس»، «اقرأ رسائلي»، «قل للممرضة …»، «أريد مكالمة فيديو»، «كيف حالتي» | Read-only answers, or confirm → message / consult request |
| Nurse / doctor | "read the alerts", "who needs attention" | «اقرأ التنبيهات»، «من يحتاج متابعة» | Ward summary read out |
| | "how is Samuel Okoro" | «كيف حال صامويل» | State, latest vitals, open alerts, transfer |
| | "summarise Samuel" / "summarise this patient" (on a bedside page) | «لخّص حالة صامويل» | AI-assisted summary generated and read |
| | "acknowledge alerts for Samuel" | «أقرّ تنبيهات صامويل» | Confirm → `PATCH /api/alerts/:id` |
| | "ambulance for Layla Haddad" | «إسعاف لليلى حداد» | **Opens the transfer form** — never dispatches by voice |
| | Toggle *Announce new critical alerts* | | New critical alerts are spoken as they arrive |

"What can I say" / «ما الأوامر» lists the commands. Patient names match in English or Arabic, and a
one-letter spelling difference (e.g. سامويل / صامويل) still matches.

## Safety rules

1. **Deterministic.** Intents come from fixed patterns, not a language model; the same sentence always
   does the same thing.
2. **Confirm before writing.** Readings, medicines, symptoms, messages, consult requests and alert
   acknowledgements need a spoken "yes" / «نعم» (or a tap). "No" / «لا» cancels, and the value is read
   back first so a misheard number is caught.
3. **Emergencies don't wait.** Red-flag words and "urgent help" are sent without confirmation and the
   emergency number is spoken and shown as a call button — a false alarm is safer than a missed one.
4. **No ambulance by voice.** Clinicians get the transfer form opened; dispatch still needs the on-screen
   confirmation.
5. **Same permissions, same audit.** Every write uses the normal endpoint. Each command is audited as
   *VOICE_COMMAND* with its intent — the transcript itself is not stored.

## Browser support and privacy

- Speech recognition: Chrome, Edge and Safari (Web Speech API). Firefox has none → type instead.
- Spoken replies: all modern browsers. **Arabic voices depend on the device**; when none is installed the
  panel says so and shows the reply as text.
- In Chrome/Edge the browser's own speech service processes the audio in the cloud. That is fine for
  this synthetic demo, **not for real patient data**. Production options: an approved cloud service
  (e.g. AWS Transcribe + Polly, both with Arabic) behind this app's API, or on-device recognition.

## Files

`src/lib/voice.ts` (intents) · `src/app/api/voice/route.ts` · `src/lib/speech.ts` (browser STT/TTS)
· `src/components/VoiceAssistant.tsx` (panel) · e2e section **12** (23 checks).
