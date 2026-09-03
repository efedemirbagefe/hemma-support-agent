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

## Two languages

English and Turkish, the reviewer's own market. `Lang = "en" | "tr"` (`src/domain/lang.ts`) sits on the domain Session; every customer-facing string follows it. STT: nova-3 for English, nova-2 with `language=tr` for Turkish, because nova-3 does not list Turkish. TTS: one ElevenLabs voice, Sarah, covers both, `language_code=tr` added to the socket URL for Turkish. The prompt, the date and weekday labels, the tool result wording, and the confirmation ask and affirmative words are separate strings per language; order ids, money and product names stay the same in either. Cost: two prompt variants and two affirmative and negation word lists to keep in sync by hand, and weaker recognition of an English name spoken inside a Turkish sentence (see Measured).

## Haiku on the voice path

Measured 2026-09-03 with `scripts/smoke.ts`: Haiku 4.5 about 1.0 s per model call, Sonnet 4.5 about 1.3 s, Sonnet 4.6 about 1.8 s. A tool turn is two calls, so `.env.example` and `render.yaml` set `MODEL_ID=claude-haiku-4-5`. Without `MODEL_ID` the code default is `claude-sonnet-4-6`. Cost: Haiku follows the protocol less reliably; the guard turns that into a wording problem, not a safety one.

## Deepgram and ElevenLabs, Aura as fallback

Not speech to speech: the guard reads transcript text before every tool call, and a speech-to-speech model's yes is audio I cannot inspect. Deepgram nova-3 gives `SpeechStarted` for barge-in. ElevenLabs flash v2.5 over stream-input takes sentences as they arrive; the socket opens at t0 so its connect time hides behind the first token. Deepgram Aura (`aura-2-thalia-en`, same key as STT) is the fallback: two streams per engine per turn, the replacement re-sends only the sentences the dead stream's audio cannot have covered, an engine that failed twice rests 60 s, with every engine gone the turn continues as text. Why a second vendor: the ElevenLabs workspace is free tier (10,000 characters, library voices return 402), a real risk on demo day. Cost: three sockets per call, latency is the sum of the legs.

## Three voice tiers

ElevenLabs first, Deepgram Aura second for English, the browser's own speech synthesis last. Aura has no Turkish voice (its TTS languages are de, en, es, fr, it, ja, nl), and the free ElevenLabs workspace hit its 10,000 character limit during testing, so a Turkish turn, or an English one after the quota is gone, needs a third tier or it goes silent. The browser tier is the right last resort: it needs no vendor key and no server-side change, the page just speaks its own text; `?fail=tts` still produces audio through it. Cost: it sounds plainer than either vendor voice and depends on which voices the operating system has installed, so the same reply can sound different on two machines.

## Chaos toggles

`?fail=tool,tts,stt` on the `/ws` URL only, never env. `tool` makes the first `check_resolution_options` throw through the domain's own `maybeFail` hook, `tts` fails every ElevenLabs stream before it opens, so retry and Aura fallback run for real, `stt` closes the Deepgram socket once. Reset re-arms them.

## Browser, not telephony

`getUserMedia` into an AudioWorklet, 16 kHz Int16 over a WebSocket, playback through a ring buffer that `clear_audio` empties at once. A SIP leg would replace `public/`, nothing behind `/ws`. Cost: no caller id; without headphones the agent hears itself.

## The assistant speaks first

`{type:"greet"}` speaks a fixed line per language with no model call (`GREETINGS` in `session-voice.ts`). It runs as a normal turn, a turn id, one text delta, TTS through the usual chunker, a `latency` event with `source:"greet"`, and is written into the agent's history as its first assistant message, so the model does not greet the customer again on its own first turn. Idempotent: honoured once per session, before the first turn only; a later `greet` is ignored, a `reset` allows one again. Why: a silent page after pressing "Start a call" reads as broken, not as waiting its turn.

## Sentence chunking, filler on voice only

Cut on `.?!` plus whitespace, or after the last comma once the buffer passes 120 characters; `text_end` or a tool start flushes. The filler ("One moment, let me check that.") is armed at tool start and not cleared at tool end, because the silence is the model round trip after the tool; it fires at 700 ms unless text has started. Voice turns only, a typed customer is reading; the first demo:check run caught it on text turns.

## Measured, 2026-09-03

Tests: 120 total, 118 pass, 2 skipped (need live keys). Typecheck clean.

Model choice re-measured on the full eight-step demo: claude-haiku-4-5 passes in both languages, first token p50 in the 662 to 2251 ms range. claude-sonnet-4-5 was slower (first token p50 4179 ms English, 2775 ms Turkish) and failed the scenario in 3 of 4 runs. Haiku stays.

A next-step line was added to the delivery-slot and resolution-option tool results, because Haiku follows an instruction inside a tool result more reliably than the same sentence in the system prompt. English then passed 3 runs out of 3 with no warnings, where before it warned about one extra clarifying question.

demo:check against the live deployment: English, 7 text turns, first token p50 2251 ms, p95 3398 ms, total p50 3207 ms, p95 5233 ms. Turkish, 8 text turns, first token p50 664 ms, p95 1034 ms, total p50 2988 ms, p95 7753 ms.

In every run of every configuration the guard held: nothing was applied twice, damage above EUR 200 always escalated, no action applied without an explicit yes.

Voice smoke, English, synthesized speech streamed as a mic, with a barge-in: speech end to first token 882 ms, first audio 1399 ms, turn total 1719 ms. The barge-in produced `clear_audio` 476 ms after the second utterance started. 8.7 s of audio returned.

Turkish speech recognition: Deepgram nova-2 with `language=tr` on a synthesized Turkish clip returned "En son siparişim ne durumda?" at 0.91 confidence. An English name spoken by a Turkish synthetic voice came back as "Nana Eber" instead of "Anna Weber", and a customer number read aloud came back as words.

Chaos `?fail=tts` verified live: the turn moves down the fallback chain (see Three voice tiers) and speech still happens.

## Known limitations

State is in memory per connection: a reload is a new session with an empty ledger, so a new tab can apply the same reschedule again. The affirmative detector is a word list, English plus a few Turkish words; "sure" is refused. No authentication: anyone with the page can look up any customer. One ElevenLabs voice for both languages; free-tier ElevenLabs cannot use library voices. A dropped Deepgram socket reopens on the next mic frame (500 / 1500 / 4000 ms backoff), then voice input is off for a minute. An ElevenLabs outage costs two failed streams before the 60 s rest, then the customer hears Aura, or the browser's own speech synthesis on Turkish. No automated test touches real audio or a real vendor; the only real-audio check is the synthesized-speech smoke. The model can still ask one clarifying question in Turkish instead of acting, the same failure the tool-result hint fixed for English; demo:check tolerates one such turn per step as WARN. Turkish speech recognition struggles with an English name or a spoken digit inside a Turkish sentence: "Anna Weber" came back as "Nana Eber", a customer number came back as words. The browser's speech-synthesis tier sounds plainer than either vendor voice and its quality varies by machine, since it depends on which voices the operating system has installed.

## One more day

The ledger as a table with the key as a unique constraint in a transaction, so a reconnect cannot re-apply. An identity step before order details. Prompt caching for the static prompt, `find_customer` prefetched from caller id. Recorded real calls replayed through the real Deepgram socket as a regression test, plus a judge-graded transcript set, guard checks staying deterministic. Runtime failover on model errors.
