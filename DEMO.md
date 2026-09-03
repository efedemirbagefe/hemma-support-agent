# Demo run sheet

One scripted call with Anna Weber, then chaos toggles, a scenario added live, the discussion. Numbers are from the 2026-09-03 demo:check run and voice smoke (`scratch/demo-check-int.log`, `scratch/voice-smoke-int.log`).

## 30 minutes before

- `.env`: `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`, `MODEL_ID=claude-haiku-4-5`, `ELEVENLABS_VOICE_ID=EXAVITQu4vr4xnSDxMaL`. Rachel returns 402 on a free workspace, and every turn would silently run on Aura.
- `npm run typecheck` clean, `npm test` green: 120 tests, 118 pass, 2 skipped (the live-model tests, `LIVE=1`).
- `npm start`. The log must say `voice ON (deepgram nova-3, elevenlabs flash v2.5)`, `tts: elevenlabs flash v2.5 primary, deepgram aura-2-thalia-en fallback` and `model override: claude-haiku-4-5`.
- `npm run demo:check`. Expect `result: PASS (0 failed, 0 warned, 1 skipped)`; the integration run took 24 s. A FAIL gets fixed first. Optional on macOS: `npx tsx scratch/voice-smoke.ts 3000`, expect `clearAudio: 1`.
- The clock is pinned to 2026-09-03 in `src/domain/clock.ts`, today's real date. No `NOW` override.
- Open `http://localhost:3000`, press Start a call, allow the mic: greeting in about a second, mic goes live. Say "test", see interim text, Stop. Headphones on, or the agent hears itself.
- Editor tabs: `policies/damaged.ts`, `guards.ts`, `tests/domain.test.ts`, `examples/scenarios/README.md`. Reload right before the call: every connection is a fresh Session with an empty ledger.

## Screen layout

Browser left, two thirds. First screen: one button, Start a call, tappable sample phrases, a demo customer card, EN / TR in the header. Start a call opens the conversation: status word (Listening, Thinking, Speaking), transcript, mic. Tool calls, latency table and session state sit behind "Under the hood", closed by default; open it before the call starts so the audience sees them live. Terminal right: server log on stderr, one JSON latency line per turn on stdout. Editor behind.

## The call

Anna Weber, VIP, ref HM-2201, phone +49 30 1234567. HM-1042: linen sofa cover, EUR 89, processing, promised Tuesday 8 September. HM-0977: arc floor lamp, EUR 240, delivered Friday 28 August. Slots for HM-1042: Friday 4 to Thursday 10 September without Sunday 6, windows 09-13 and 13-18.

Wording varies; tool order, state panel and ledger do not. Text latency is demo:check (no STT leg, totals include synthesis), voice latency is the smoke. demo:check numbers the last steps as proposal 6, yes 7, retry 8. If the model asks one extra clarifying question, just answer it: the guard still holds, nothing applies without a yes.

### 1. Most recent order

Say: "Hi, this is Anna Weber, my customer number is HM-2201. What's happening with my most recent order?"
Tools: `find_customer {customerRef: "HM-2201"}`, single-digit ms. `get_order` is optional: the order list carries status, items and the labelled date; the run answered from it.
State: Customer Anna Weber (vip), Pending none, Applied 0, Cases 0.
Latency: text 2320 first token, 2808 first audio, 3417 total. Voice: STT final 1022, first token 2527, first audio 2692.
Drift: STT writes "HM 2201" or "envy 2201" and the agent asks again: give the phone number, digits slowly.

### 2. Interrupt

After the agent's first sentence about the sofa cover, talk over it. Say: "Sorry to interrupt. Actually, something else first. A lamp from an earlier order arrived damaged, the base is dented."
Screen: audio stops, the server log says `cancel t1-xxxx (barge-in)`, the agent line is struck through and marked (interrupted), its latency row is marked cut, your line is the next user turn.
Latency: in the smoke, `clear_audio` reached the client 490 ms after the interrupting audio started; Deepgram's `SpeechStarted` is about 450 of that.
Drift: the agent keeps talking: let it finish, repeat the line, say so later. No transcript after the cut: after 1.8 s the server re-answers the previous question (`resumedFrom` in the JSON line); wait, repeat the line.

### 3. The damaged lamp

Same utterance as step 2.
Tools: `get_order {orderId: "HM-0977"}`, then `check_resolution_options {orderId: "HM-0977", issue: "damaged"}` returning `escalationRequired: true`. The agent matches "lamp" to HM-0977 from the state block without asking.
State: Active order HM-0977. Pending still none.
Latency: text 1813 first token, 6312 total for the three-tool turn (23 s of speech), the longest.
Drift: the agent asks which lamp. "The brass floor lamp, from my earlier order." demo:check tolerates one such turn and reports WARN.

### 4. Escalation

Nothing to say; in the run steps 3 and 4 were one turn.
Tools: `escalate_case {orderId: "HM-0977", reason: ...}` returning `CREATED`, case `CASE-0977-01`. If the model tries `apply_resolution` first, the guard blocks it with `ESCALATION_REQUIRED` and it falls back to `escalate_case`.
Agent: EUR 240 is over the 200 limit, the case id, a colleague calls back within one business day.
State: Cases 1, Applied 0.
Drift: the agent asks whether to open a case. "Yes, please do."

### 5. Back to the sofa cover

Say: "Thanks. Now back to the sofa cover. Can you move the delivery to Friday?"
Tools: `get_delivery_slots {orderId: "HM-1042"}`. Twelve labelled slots; the agent offers Friday 4 September, 9 to 1 or 1 to 6.
State: Active order HM-1042.
Latency: text 2901 first token, 3731 total.
Drift: the agent asks which order. "The sofa cover, order HM-1042."

### 6. Friday morning

Say: "The morning slot on Friday, please."
Tools: `apply_resolution {orderId: "HM-1042", type: "reschedule", params: {date: "2026-09-04", window: "09-13"}, customerConfirmed: false}`, phase blocked, `NEEDS_CONFIRMATION`. The guard registers the proposal and hands the model the sentence to read.
State: Pending: Move the delivery of order HM-1042 to Friday 4 September 2026, in the morning, 9 to 1. Applied 0.
Latency: text 2025 first token, 2910 total.
Drift: no pending chip means nothing was registered; the yes in step 8 then costs one extra round, the ledger still ends at one entry. Pending shows the afternoon: "Friday morning, 9 to 1."

### 7. The confirmation question

The agent ends its turn with one question: "... in the morning, 9 to 1. Shall I go ahead?" Say nothing yet; point at Applied 0 and the pending chip.
Drift: a statement instead of a question. Ask "Is that Friday morning?"; a line ending in a question mark can never pass the guard.

### 8. Yes

Say exactly: "Yes, go ahead."
Tools: `apply_resolution {..., customerConfirmed: true}`, phase end, `APPLIED`, receipt `RCP-1042-001`.
Agent: done, Friday 4 September, 9 to 1, receipt read once.
State: Applied 1, a green receipt block `RCP-1042-001` (2026-09-04, 09-13), Pending none.
Latency: text 2807 first token, 3833 total.
Drift: another "shall I go ahead": if the pending chip says Friday 9 to 1, repeat "Yes, go ahead." Never "yes, no problem" or "yeah, why not": "no" and "not" are negations, the guard refuses.

### 8b. The retry

Say: "Sorry, did that go through? Book Friday morning again just to be safe."
Tools: `apply_resolution` with the same key, phase blocked, `ALREADY_APPLIED` with `RCP-1042-001`. The prompt makes the model call the tool instead of answering from memory; the guard checks the ledger before looking for a yes, so no second confirmation.
State: Applied still 1, same receipt id. Say out loud that the ledger did not change.
Latency: text 2596 first token, 3549 total.
Drift: no tool call. Correct but weaker; "Please book it again." brings the blocked row.

Six text turns: first token p50 2320 ms, p95 2901; total p50 3549, p95 6312.

## Demo in Turkish

Same script, same rules, different words. Switch to TR before Start a call: header button, or `?lang=tr` on the URL.

| # | Say |
|---|---|
| 1 | Merhaba, ben Anna Weber, müşteri numaram HM-2201. En son siparişim ne durumda? |
| 3 | Aslında önce başka bir şey var. Daha önceki bir siparişimden gelen lamba hasarlı geldi, tabanı ezilmiş. |
| 5 | Teşekkürler. Şimdi kanepe kılıfına dönelim. Teslimatı Cuma gününe alabilir misiniz? |
| 6 | Cuma sabah saati lütfen. |
| 7 | Evet, devam edin. |
| 8 | Pardon, işlem gerçekleşti mi? Garanti olsun diye Cuma sabahını tekrar ayarlayın. |

Steps 2 and 4: interrupt in your own words, and "Evet, lütfen." if asked before the case opens. Full set: `DEMO_LINES.tr` in `src/agent/demo-script.ts`.

Tool order, state, escalation and the guard match the English walkthrough: "Cuma" for Friday, receipt and case ids unchanged.

Turkish speech never touches Aura, it has no Turkish voice: ElevenLabs or, failing that, the browser's own speech synthesis (DECISIONS.md). `?fail=tts` on Turkish skips straight past Aura.

## Chaos

Reset, add `?fail=tts` to the page URL, reload. The badge reads `chaos: tts`. Say the step 1 line. Audio still plays, in a different voice (Aura's Thalia, not Sarah); the latency row's TTS column says `deepgram`; the server log shows two ElevenLabs failures, `tts engine elevenlabs down for 60 s`, then `tts fallback ... deepgram stream aura1`. No error toast, the fallback worked. Run of 2026-09-03: first token 2284, first audio 2858, 15.4 s of audio, `ttsEngine: "deepgram"`. Later turns start on Aura; Reset lifts the rest.

`?fail=tool`: the first `check_resolution_options` of the session throws. Do step 1, then the lamp line. The tool row turns red (`failed: check_resolution_options`), a toast says `Tool check_resolution_options failed: Simulated failure in check_resolution_options`, the agent apologises and offers to escalate. "Please try again." and the second call works. Pinned by `tests/voice.test.ts`, run live in `scratch/server-chaos.log`; the apology wording was not captured there, so read it off the screen.

`?fail=stt` drops the Deepgram socket once after the first final and reconnects after 500 ms. Flags combine: `?fail=tool,tts`.

## Adding a scenario live

`examples/scenarios/wrong-item.ts` is a complete playbook outside the registry. The three commands in `examples/scenarios/README.md`: `sed` copies it into `src/domain/policies/` with the import path fixed, `perl` adds the import and the entry at the two marker comments in `policies/index.ts`, `npm start`. Reload, then Jonas Berg (HM-2305): "The vase set from my earlier order is not what I ordered." The prompt now lists `wrong_item`, `check_resolution_options` accepts it, the option is a EUR 45 refund (stock 0). Two tests in `tests/domain.test.ts` pin the registry to three scenarios and go red until their lists get `wrong_item`; say so.

## Discussion

1. Rules are code. `damaged.ts`: `order.totalEur > 200` is a comparison. `guards.ts`: `isAffirmative` reads the transcript, not the model's claim; `customerConfirmed: true` is never trusted. Comment out the `isAffirmative` line, `npm test`, the premature-apply tests go red.
2. Exactly once. Key `${type}:${orderId}:${stableStringify(params)}`; the ledger check runs before the confirmation check in guard and tool; apply is synchronous in memory, so an aborted turn cannot half-write (`tests/agent-fake.test.ts`). In production the key becomes a unique constraint in a transaction.
3. Latency. Haiku measured about 1.0 s per call against 1.8 s for Sonnet 4.6, and a tool turn is two calls, so Haiku is the voice default. Sentences stream into a TTS socket opened at t0; the filler fires at 700 ms on voice turns. Next: prompt caching for the static prompt, `find_customer` from caller id before the first word.

Likely questions.
- STT hears yes as no: one extra question, never a wrong apply.
- Why not trust the model's confirmed flag: it can be argued into it, the function cannot.
- "Sure" or "okay": not on the list, the agent asks again. Small list on purpose.
- 100 concurrent calls: nothing in the domain; three sockets per call in one Node process. Workers, not a redesign.
- Evaluation beyond the demo: `tests/domain.test.ts` for rules, the fake-stream test for the loop, `LIVE=1` for the model, demo:check by URL against any deployment, then recorded calls graded against the same steps.

## Fallback

1. STT silent: Stop, Start mic. Still silent: type the same lines. Only the audio legs are missing; in text mode a new message cancels the running answer instead of a barge-in.
2. Text but no audio: keep going, the words are on screen.
3. Confused about the proposal: read the pending chip aloud and confirm exactly that.
4. Error toast or no answer: reload. Server gone: `npm start`, reload. Browser gone: `npx tsx scripts/chat.ts`, same agent and guard in the terminal.
5. Model gone (`npx tsx scripts/smoke.ts` fails): `npm test` on screen and `tests/domain.test.ts`, the same call without a model.

Say what broke. "Deepgram dropped the socket" beats pretending.
