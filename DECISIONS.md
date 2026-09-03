# Decisions

What I chose, why, what it costs. Then measurements, limits, one more day.

## Pi as the harness

One Pi `Agent` per connection: six `AgentTool`s, `toolExecution: "sequential"`, two hooks. `beforeToolCall` is the guard; `{ block: true, reason }` makes the model read the reason as the tool result. `afterToolCall` writes the tool log. `prepareNextTurnWithContext` rebuilds the state block between model rounds. An utterance is recorded only once the previous turn is idle, so a running turn never sees a later yes. `abort()` is what barge-in calls.

## Playbooks and derived scenario types

A playbook is data plus pure functions: `options(order, customer, ctx)` returns what the store allows. The registry in `src/domain/policies/index.ts` is the single source: the `Scenario` type, the `issue` union of `check_resolution_options` and the prompt's playbook lines derive from it. Adding a scenario is one file plus one entry (`examples/scenarios/`). Cost: a rule change is a code change and a test.

## Two-phase apply and the affirmative check

The first call registers a proposal and returns `NEEDS_CONFIRMATION` with the sentence to read out. The second applies only when `confirmationVerdict` passes: the proposal exists, was the one last put to the customer, came from an earlier utterance, nothing else was applied on this utterance, and `session.lastUserUtterance` is affirmative: no trailing question mark, a whole-word hit from the short list in `guards.ts` (yes, go ahead, confirm, evet, tamam and a few more), no negation anywhere (no, not, don't, wait, wrong, hayır). Guard and tool share the function; the model's `customerConfirmed: true` is never trusted. Cost: "sure", "okay" or a misheard yes cost one extra question, never a wrong apply.

## Ledger

Key `${type}:${orderId}:${stableStringify(params)}`. A known key returns `ALREADY_APPLIED` with the original receipt, in guard and tool, checked before the confirmation check, so a repeat never re-asks for a yes. Apply is synchronous in memory: an aborted turn cannot half-write. A topic switch parks the earlier proposal; a parked one is proposed again before a yes counts. Cost: morning and afternoon are two keys, so a change of mind leaves a parked proposal.

## Date labels from tools

Every tool result with a date carries `humanDate` ("Friday 4 September 2026"); the prompt says to speak dates as labelled, never work out a weekday; demo:check fails a run on a weekday that contradicts the calendar. Why: in the first live run the model said "Monday the 8th of September" for a Tuesday.

## Haiku on the voice path

Measured 2026-09-03 with `scripts/smoke.ts`: Haiku 4.5 about 1.0 s per model call, Sonnet 4.5 about 1.3 s, Sonnet 4.6 about 1.8 s. A tool turn is two calls, so `.env.example` and `render.yaml` set `MODEL_ID=claude-haiku-4-5`. Without `MODEL_ID` the code default is `claude-sonnet-4-6`. Cost: Haiku follows the protocol less reliably; the guard turns that into a wording problem, not a safety one.

## Deepgram and ElevenLabs, Aura as fallback

Not speech to speech: the guard reads transcript text before every tool call, and a speech-to-speech model's yes is audio I cannot inspect. Deepgram nova-3 gives `SpeechStarted` for barge-in. ElevenLabs flash v2.5 over stream-input takes sentences as they arrive; the socket opens at t0 so its connect time hides behind the first token. Deepgram Aura (`aura-2-thalia-en`, same key as STT) is the fallback: two streams per engine per turn, the replacement re-sends only the sentences the dead stream's audio cannot have covered, an engine that failed twice rests 60 s, with every engine gone the turn continues as text. Why a second vendor: the ElevenLabs workspace is free tier (10,000 characters, library voices return 402), a real risk on demo day. Cost: three sockets per call, latency is the sum of the legs.

## Chaos toggles

`?fail=tool,tts,stt` on the `/ws` URL only, never env. `tool` makes the first `check_resolution_options` throw through the domain's own `maybeFail` hook, `tts` fails every ElevenLabs stream before it opens, so retry and Aura fallback run for real, `stt` closes the Deepgram socket once. Reset re-arms them.

## Browser, not telephony

`getUserMedia` into an AudioWorklet, 16 kHz Int16 over a WebSocket, playback through a ring buffer that `clear_audio` empties at once. A SIP leg would replace `public/`, nothing behind `/ws`. Cost: no caller id; without headphones the agent hears itself.

## Sentence chunking, filler on voice only

Cut on `.?!` plus whitespace, or after the last comma once the buffer passes 120 characters; `text_end` or a tool start flushes. The filler ("One moment, let me check that.") is armed at tool start and not cleared at tool end, because the silence is the model round trip after the tool; it fires at 700 ms unless text has started. Voice turns only, a typed customer is reading; the first demo:check run caught it on text turns.

## Measured, 2026-09-03

Model, `scripts/smoke.ts`, first token of the final answer / total, two runs:

| model | run 1 | run 2 |
|---|---|---|
| claude-haiku-4-5 | 1976 / 2104 ms | 2310 / 2371 ms |
| claude-sonnet-4-5 | 2363 / 2601 ms | 2772 / 2963 ms |
| claude-sonnet-4-6 | 4093 / 4231 ms | 3145 / 3482 ms |

Vendors: Deepgram live socket open 0.7 s, `SpeechStarted` about 0.45 s after audio starts; ElevenLabs first audio 1.0 s after socket open; Aura first frame 250 ms after a `Speak`.

demo:check, Haiku, text mode with synthesis, six turns: first token p50 2320 ms, p95 2901; total p50 3549, p95 6312; tool time 2 to 15 ms per turn. PASS, one skip.

Voice smoke: turn 1 STT final 1022 ms, first token 2527, first audio 2692, cut by the barge-in; `clear_audio` reached the client 490 ms after the interrupting audio started. Turn 2: STT final 804, first token 1114, first audio 1747, total 1960.

Chaos `fail=tts`: first token 2284, first audio 2858 on Aura, 15.4 s of audio, `ttsEngine: "deepgram"`, no error toast.


## Known limitations

State is in memory per connection: a reload is a new session with an empty ledger, so a new tab can apply the same reschedule again. The affirmative detector is a word list, English plus a few Turkish words; "sure" is refused. No authentication: anyone with the page can look up any customer. One voice, one language; free-tier ElevenLabs cannot use library voices. A dropped Deepgram socket reopens on the next mic frame (500 / 1500 / 4000 ms backoff), then voice input is off for a minute. An ElevenLabs outage costs two failed streams before the 60 s rest, then the customer hears Aura. No automated test touches real audio or a real vendor; the only real-audio check is the synthesized-speech smoke. The model can still ask a clarifying question instead of acting (the voice smoke's second turn asked which lamp); demo:check tolerates one such turn per step as WARN.

## One more day

The ledger as a table with the key as a unique constraint in a transaction, so a reconnect cannot re-apply. An identity step before order details. Prompt caching for the static prompt, `find_customer` prefetched from caller id. Recorded real calls replayed through the real Deepgram socket as a regression test, plus a judge-graded transcript set, guard checks staying deterministic. Runtime failover on model errors.
