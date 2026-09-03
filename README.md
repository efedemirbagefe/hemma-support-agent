# Hemma support agent

A voice support agent for a fictional EU home-goods store. Browser microphone in, Deepgram for speech to text (nova-3 for English, nova-2 for Turkish), Claude through the Pi agent harness with six tools, ElevenLabs flash v2.5 for speech out with Deepgram Aura and the browser's own speech synthesis as fallbacks. English and Turkish, switched from the header. The store's rules (reschedule, damaged item, late delivery) are code, and a deterministic guard makes sure nothing is applied without an explicit yes and nothing is applied twice.

## Setup

Node 22 or newer.

```
npm install
cp .env.example .env
# put the keys into .env (see below)
npm start
open http://localhost:3000
```

Keys in `.env`:

| Variable | Where it comes from | Without it |
|---|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com, API keys | no agent answers; a text turn shows a "Model error" toast |
| `DEEPGRAM_API_KEY` | console.deepgram.com, API keys | mic button disabled (no speech to text), text input still works; no Aura fallback for speech out |
| `ELEVENLABS_API_KEY` | elevenlabs.io, profile, API keys | speech out falls to Deepgram Aura (English only), then the browser's own speech synthesis |

Speech out tries three tiers in order: ElevenLabs, then Deepgram Aura for English, then the browser's own speech synthesis. The last tier needs no vendor key, so the assistant is still heard with neither TTS key set; only `DEEPGRAM_API_KEY` decides whether the mic button works for speech in.

Other variables, all optional:

- `MODEL_ID`: `.env.example` and `render.yaml` set `claude-haiku-4-5` (measured about 1.0 s per call against 1.8 s for Sonnet 4.6, see DECISIONS.md). The code default without it is `claude-sonnet-4-6`. An id pi-ai does not know falls back to `claude-haiku-4-5` at construction.
- `ELEVENLABS_VOICE_ID` (or `VOICE_ID`): `.env.example` ships `EXAVITQu4vr4xnSDxMaL` (Sarah, a premade voice that works on a free workspace), which is also the code default. The library voice Rachel `21m00Tcm4TlvDq8ikWAM` returned 402 on a free workspace when checked.
- `PORT`: 3000.
- `NOW=YYYY-MM-DD`: moves the demo clock. All mock data assumes 2026-09-03.
- `FAIL_TOOL=<tool name>`: that tool throws on every call. For a one-shot failure use the chaos query below.
- `ALLOWED_ORIGINS`: comma separated browser origins allowed on `/ws` when the page is served from another host. By default the Origin host must equal the request Host; non-browser clients without Origin are accepted.
- `DEEPGRAM_WS_URL`, `DEEPGRAM_SPEAK_WS_URL`, `ELEVENLABS_WS_URL`: test hooks that point the vendor sockets at a mock server. Honoured for a loopback host only, or any host with `ALLOW_VENDOR_URL_OVERRIDE=1`, because the API key travels to that host.

## Language

English and Turkish, `?lang=en` or `?lang=tr` on the page URL, or the EN / TR buttons in the header. Order of preference: the URL query wins, then the last choice saved in the browser (`localStorage`), then the browser's own language, English unless it starts with `tr`. Switching mid-call sends `{type:"lang"}` over the WebSocket; the prompt, the tool labels, the dates and the confirmation wording all follow at once. Money, order ids and product names stay the same in both languages.

The assistant speaks first: a fixed greeting per language plays as soon as the call starts, before the customer says a word.

## npm scripts

| Script | What it does |
|---|---|
| `npm start` | runs the server once (`tsx src/server.ts`) |
| `npm run dev` | same, restarts on source changes |
| `npm test` | `tsx --test tests/*.test.ts`. As of 2026-09-03: 120 tests, 118 pass, 2 skipped |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run demo:check` | replays the 8-step demo call over `/ws` against a running server and grades it |

The two skipped tests are `tests/live.test.ts`, which need `LIVE=1` and an Anthropic key. Everything else runs without keys and without network: the voice tests use mock Deepgram, Aura and ElevenLabs sockets on localhost.

### demo:check

```
npm run demo:check                      # ws://127.0.0.1:3000/ws
npm run demo:check -- --port 3141
npm run demo:check -- --url https://hemma.example.com     # becomes wss://hemma.example.com/ws
npm run demo:check -- --url wss://host/ws --timeout 120000 --json --quiet
npm run demo:check -- --lang tr                            # connects with ?lang=tr, Turkish demo lines
```

`--port N` picks the local port (default 3000; a bare number works too). `--url` takes `ws://`, `wss://`, `http://` or `https://`; http becomes ws and `/ws` is added when the path is empty. `--timeout` is per turn in ms (default 90000). `--json` prints the full report as JSON after the table, `--quiet` hides the per-turn transcript. Exit code 0 on PASS, 1 on any FAIL. `--lang tr` connects with `?lang=tr` and sends the Turkish demo lines (`DEMO_LINES.tr` in `src/agent/demo-script.ts`); the same tool order and guard outcomes are expected, and the weekday and next-step text checks accept either language.

The steps are the brief's order: 1 most recent order, 2 barge-in (voice only, reported SKIP), 3 damaged lamp HM-0977, 4 escalation (EUR 240 is over the 200 limit), 5 back to HM-1042 and Friday, 6 the Friday morning proposal (NEEDS_CONFIRMATION), 7 "Yes, go ahead." (APPLIED once), 8 a retry that must hit ALREADY_APPLIED with the same receipt. Where the brief allows it, one clarifying turn per step is tolerated and reported WARN, never PASS. Every turn is linted: a weekday that contradicts the calendar, a dash in spoken text, an error event, or the filler in a text turn. The script reads `/healthz` for the model id and prints a first token / total p50 and p95 over the text turns. The steps and evaluators live in `src/agent/demo-script.ts`; `tests/live.test.ts` runs the same script in-process against the real model.

### Other scripts

- `npx tsx scripts/chat.ts`: terminal chat, same agent, tools and guard, tool calls printed inline. `/state`, `/reset`, `exit`. `NOW=2026-09-08 npx tsx scripts/chat.ts` or `MODEL_ID=claude-haiku-4-5 npx tsx scripts/chat.ts` work.
- `npx tsx scripts/smoke.ts [modelId]`: connectivity check, one tool call plus an answer, prints first-token and total ms. If this fails the model is unreachable.
- `npx tsx scratch/voice-smoke.ts <port>`: macOS only (uses `say`), streams synthesized speech into `/ws` like a microphone and then a barge-in; expects STT final, agent text, audio, `clear_audio`.
- `npx tsx scratch/chaos-smoke.ts <port> [fail]`: one text turn over `/ws?fail=tts`, expects `ttsEngine: "deepgram"` and audio bytes.

## Chaos query

Add `?fail=tool,tts,stt` (any subset, comma separated) to the page URL and reload; the page forwards it to the `/ws` handshake. The `ready` message echoes what is active and the page shows a red badge. The toggles are read only from that URL, never from env, so ordinary traffic runs with chaos off. `Reset session` re-arms them.

- `tool`: the first `check_resolution_options` of the session throws `Simulated failure in check_resolution_options`; the second works. The tool row shows the error, a toast shows the same text, the model reads `Tool check_resolution_options failed: ...` and the turn continues (the prompt asks it to apologise and offer to escalate).
- `tts`: every ElevenLabs stream fails without opening a socket, so the turn moves down the fallback chain: the Aura retry on English, or straight to the browser's own speech synthesis on Turkish, since Aura has no Turkish voice. On English the latency row says `ttsEngine: "deepgram"`; either way, speech still happens. Two failures in one turn also rest ElevenLabs for 60 s, as a real outage would.
- `stt`: the Deepgram socket is closed once right after the first final and reopens on the next audio frame after 500 ms.

## Text-only mode

The server starts with any subset of the keys. The first message on the WebSocket, `{type:"ready", sessionId, voice:{stt, tts, ttsEngines}, chaos}`, tells the page what is on; with `stt` false the mic button is disabled and the text box is the input. Agent, tools, guard, ledger, state panel and latency rows behave the same in both modes, only the audio legs are missing. There is no barge-in in text mode: a new message cancels the running answer instead. The filler sentence is never used on a text turn. With no `ANTHROPIC_API_KEY` at all a text turn produces `{type:"error", message:"Model error: Provider is not configured: anthropic"}` followed by `state` and `latency`; the server does not crash.

`GET /healthz` returns `{ ok, uptimeSec, sessions, features: { model, modelId, stt, tts, ttsEngines } }`: the three booleans say which keys the server saw, `modelId` is the requested model id, `ttsEngines` lists the TTS engines with a key in preference order.

## Adding a support scenario

A scenario is a playbook: data plus pure functions, no model involved. It says which tool order the model should follow and which resolution options exist for an order; the model only sees options a playbook returned, and `apply_resolution` refuses params that match none of them. The registry in `src/domain/policies/index.ts` is the single source: the `Scenario` type, the `issue` union of `check_resolution_options`, the option lookup on apply and the playbook lines in the system prompt derive from it. Adding a scenario is one file in `src/domain/policies/` plus one entry in the registry.

`examples/scenarios/wrong-item.ts` is a complete drop-in playbook, and `examples/scenarios/README.md` has the three commands that put it live, what a playbook must provide, and the limits (the four action types are fixed in `src/domain/types.ts` and applied in `src/domain/actions.ts`; two playbooks offering the same action are both consulted and the stricter one wins). Tests for a new rule go in `tests/domain.test.ts` next to the existing playbook tests; two of them pin the live registry to the three shipped scenarios and need their lists extended.

## Layout

```
src/domain/lang.ts             Lang ("en" | "tr"), LANGS, DEFAULT_LANG, isLang, parseLang
src/domain/clock.ts            today() pinned to 2026-09-03, NOW override, humanDate labels
src/domain/types.ts            domain types, Playbook interface
src/domain/data.ts             two customers, four orders, per-session deep copy
src/domain/session.ts          Session: proposals, ledger, cases, tool log, utterance counter; idempotency key
src/domain/actions.ts          option matching, propose, apply, summaries (shared by tools and guard)
src/domain/policies/           reschedule.ts, damaged.ts, late.ts, index.ts (the registry)
src/domain/tools.ts            the six tools: find_customer, get_order, check_resolution_options,
                               get_delivery_slots, apply_resolution, escalate_case
src/domain/guards.ts           beforeToolCall (confirmation, escalation, ledger), afterToolCall (tool log)
src/agent/prompt.ts            persona, rules, live state block, playbook lines
src/agent/speech.ts            spoken-text hygiene (dashes become commas or "to")
src/agent/createAgent.ts       Pi Agent factory, serialised sendUserText, abort
src/agent/demo-script.ts       the 8-step demo as data plus evaluators (demo:check, live test)
src/voice/tts.ts               engine-neutral TTS contract, lost-chunk estimate, chaos stand-in
src/voice/elevenlabs.ts        ElevenLabs stream-input socket (primary TTS)
src/voice/deepgram-tts.ts      Deepgram Aura speak socket (fallback TTS)
src/voice/deepgram.ts          Deepgram live STT socket, speech end estimate on the audio clock
src/voice/chunker.ts           sentence chunker for streaming text into TTS
src/voice/latency.ts           per-turn timestamps and the stdout JSON line
src/voice/chaos.ts             ?fail= toggles and the tool wrapper
src/voice/vendor-url.ts        loopback-only vendor socket overrides for tests
src/voice/session-voice.ts     one connection: turn lifecycle, barge-in, filler, resume, TTS fallback
src/voice/README-voice.md      the turn lifecycle step by step
src/server.ts                  http + ws server, /healthz, static files, origin check
public/                        index.html, app.js, worklet.js (mic capture and playback)
tests/domain.test.ts           rules, tools, guard, ledger, demo evaluators, no model
tests/agent-fake.test.ts       agent loop with a scripted stream, guard and abort
tests/voice.test.ts            VoiceSession against mock vendor sockets: barge-in, resume, TTS retry and fallback, chaos
tests/live.test.ts             real model, LIVE=1
scripts/chat.ts                terminal chat
scripts/smoke.ts               model connectivity check
scripts/demo-check.ts          the 8-step call over /ws, graded
examples/scenarios/            drop-in playbook example and how to register it
scratch/                       measured vendor facts, smokes, logs of the integration runs
render.yaml                    Render deployment (health check on /healthz, Haiku and Sarah set)
APPROACH.md DECISIONS.md DEMO.md CONTRACTS.md TIMELOG.md
```
