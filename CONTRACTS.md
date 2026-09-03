# Contracts (internal, read before writing any file)

Brand: **Hemma**, fictional EU home-goods store. Currency EUR. "Today" for all mock data and slot logic is **2026-09-03 (Thursday)**, taken from `src/domain/clock.ts` (`today()` returns a Date, overridable via `NOW` env for tests).

Stack: TypeScript ESM, Node 22+, `tsx`. Agent harness: `@earendil-works/pi-agent-core` 0.84 + `@earendil-works/pi-ai` 0.84 (Anthropic provider). Model: code default `claude-sonnet-4-6` (`DEFAULT_MODEL_ID`), registry fallback `claude-haiku-4-5` (`FALLBACK_MODEL_ID`, used only when pi-ai does not know the requested id, never on a failed request). `MODEL_ID` env overrides the requested id. Measured decision (scratch/latency-models.md, 2026-09-03: Haiku about 1.0 s per call, Sonnet 4.6 about 1.8 s, a tool turn is two calls): the voice path runs Haiku, so `.env.example` and `render.yaml` both set `MODEL_ID=claude-haiku-4-5`. Schemas: `@sinclair/typebox`. WebSockets: `ws`. No other runtime deps. Do NOT edit `package.json`; if you need a dep, say so in your result.

Verified Pi API (from installed types, do not guess):
```ts
import { Agent, type AgentTool, type AgentEvent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
const models = createModels(); models.setProvider(anthropicProvider());
const model = models.getModel("anthropic", "claude-sonnet-4-6")!;
const agent = new Agent({ initialState: { systemPrompt, model, tools }, streamFn: models.streamSimple.bind(models),
  getApiKey: () => process.env.ANTHROPIC_API_KEY,
  beforeToolCall: async ({ toolCall, args, context }) => ({ block: true, reason: "..." }) /* or undefined */,
  afterToolCall: async ({ toolCall, result, isError, context }) => undefined,
  prepareNextTurnWithContext: (ctx) => ({ context: { ...ctx.context, systemPrompt } }), /* refresh the prompt between model rounds inside one run */
  toolExecution: "sequential" });
agent.subscribe((e: AgentEvent) => { /* message_update (assistantMessageEvent.type === "text_delta", .delta; "text_end" closes a text block), tool_execution_start {toolCallId, toolName, args}, tool_execution_end {toolCallId, toolName, result, isError}, turn_end, agent_end */ });
await agent.prompt("user text"); agent.abort(); await agent.waitForIdle(); agent.state.systemPrompt = "..."; agent.state.messages; agent.state.errorMessage; agent.state.isStreaming; agent.state.tools = [...] /* setter exists; the voice layer wraps the tools through it */;
// AgentTool shape:
const tool: AgentTool = { name, label, description, parameters: Type.Object({...}), execute: async (toolCallId, params, signal, onUpdate) => ({ content: [{ type: "text", text }], details: {...} }) };
```
`beforeToolCall` context has `toolCall` (with `.name`, `.id`, `.arguments`) and `args`; returning `{ block: true, reason }` makes the model see the reason as the tool result instead of executing. A blocked call takes the harness's immediate path: `afterToolCall` does not run for it and `tool_execution_end` arrives with `isError: true` and the reason as the result text. Check `node_modules/@earendil-works/pi-agent-core/dist/types.d.ts` for exact field names before relying on them.

## Layout (each agent owns only its listed paths)

```
src/domain/clock.ts            today(), addDays, daysBetween, isoDate, humanDate ("Friday 4 September 2026"), weekdayName, isSunday; NOW env
src/domain/types.ts            all domain types below
src/domain/data.ts             mock customers, orders (seeded, deterministic); createStore() deep copy per session; findCustomer/findOrder helpers
src/domain/session.ts          Session class: state, proposals, applied ledger, cases, tool log; stableStringify, actionKey, SessionSnapshot
src/domain/actions.ts          pure action logic shared by tools and guards: delayDaysFor, optionsFor, resolveAction, propose, applyPending, summarize, dateFields
src/domain/policies/index.ts   playbook registry: playbooks, scenarios, getPlaybook, isScenario, scenariosOf, playbooksForAction, assertRegistry
src/domain/policies/reschedule.ts | damaged.ts | late.ts
src/domain/tools.ts            createTools(session): AgentTool[]  (the six tools), maybeFail, TOOL_NAMES, ESCALATION_NEXT_STEP
src/domain/guards.ts           makeBeforeToolCall(session), makeAfterToolCall(session), confirmationVerdict, isAffirmative
src/agent/prompt.ts            buildSystemPrompt(session): string  (base + live state block)
src/agent/speech.ts            hasDash, sanitizeSpoken (spoken-text hygiene in code)
src/agent/createAgent.ts       createSupportAgent(opts)  (see interface below)
src/agent/demo-script.ts       the 8-step demo as data + pure evaluators (runDemo, formatReport, DEMO_STEPS)
src/voice/tts.ts               engine-neutral TTS contract (TtsEngine, TtsStream, lostChunks, FailingTtsStream for chaos)
src/voice/elevenlabs.ts        ElevenLabs stream-input WS (primary TTS)
src/voice/deepgram-tts.ts      Deepgram Aura /v1/speak WS (fallback TTS)
src/voice/deepgram.ts          Deepgram live STT WS
src/voice/chunker.ts           SentenceChunker
src/voice/latency.ts           TurnLatency, LatencyReport, logLatencyLine
src/voice/chaos.ts             ?fail= toggles: parseChaos, ChaosState, instrumentTools
src/voice/vendor-url.ts        loopback-only vendor socket URL overrides for tests
src/voice/session-voice.ts     VoiceSession: one WS connection = Session + SupportAgent + STT + per-turn TTS
src/voice/README-voice.md      turn lifecycle, where each timestamp is taken
src/server.ts                  http server serving public/, /healthz, /ws upgrade with origin check
public/*                       browser client (index.html, app.js, worklet.js)
tests/*.test.ts                node:test via tsx (domain, agent-fake, voice, live)
scripts/chat.ts                terminal text chat against the real model
scripts/demo-check.ts          replays the 8-step demo over /ws in text mode against a running server (npm run demo:check -- --port N)
scripts/smoke.ts               one tool call + answer against the real model, prints first token / total ms
scratch/                       measured vendor facts (vendor-checks.md, latency-models.md), smokes (voice-smoke.ts, chaos-smoke.ts), logs
examples/scenarios/            drop-in example of adding a playbook
```

## Domain types (src/domain/types.ts)

```ts
export type Tier = "standard" | "vip";
export type OrderStatus = "processing" | "shipped" | "out_for_delivery" | "delivered";
export type DeliveryWindow = "09-13" | "13-18";
export interface Item { sku: string; name: string; qty: number; unitPriceEur: number; replacementStock: number }
export interface Order { id: string; customerId: string; status: OrderStatus; placedAt: string; promisedDeliveryDate: string; deliveryWindow?: DeliveryWindow /* set once a reschedule is applied */; deliveredAt?: string; items: Item[]; totalEur: number }
export interface Customer { id: string; ref: string; name: string; phone: string; tier: Tier }
export type ActionType = "reschedule" | "replacement" | "refund" | "compensation";
export interface PendingAction { key: string; type: ActionType; orderId: string; params: Record<string, unknown>; summary: string; proposedAt: number; proposedTurn: number /* Session.utteranceSeq when proposed */ }
export interface AppliedRecord { key: string; type: ActionType; orderId: string; params: Record<string, unknown>; appliedAt: number; receipt: string; summary?: string }
export interface Case { id: string; orderId: string; reason: string; details: Record<string, unknown>; createdAt: number }
export interface ResolutionOption { type: ActionType; label: string; params: Record<string, unknown>; requiresEscalation: boolean; escalationReason?: string; amountEur?: number }
export interface ToolLogEntry { t: number; tool: string; args: unknown; ok: boolean; ms: number; blocked?: string }
export interface DeliverySlot { date: string; weekday: string; window: DeliveryWindow; label: string /* humanDate, e.g. "Friday 4 September 2026" */ }
export interface PlaybookContext { today: Date; delayDays: number }
export interface Playbook<S extends string = string> { scenario: S; description: string; actionTypes: readonly ActionType[]; toolOrder: string[]; options(order, customer, ctx: PlaybookContext): ResolutionOption[]; note?(order, customer, ctx): string | undefined }
export interface DataStore { customers: Customer[]; orders: Order[] }
export type { Scenario } from "./policies/index";   // derived from the registry, type-only
```
Receipts look like `RCP-1042-001`; case ids like `CASE-0977-01`.

## Session (src/domain/session.ts)

`class Session { id; store: DataStore; playbooks: readonly Playbook[]; customer?: Customer; activeOrderId?: string; get pending(): PendingAction | undefined; proposals: Map<string, PendingAction>; lastProposedKey?: string; utteranceSeq: number; lastAppliedSeq?: number; applied: Map<string, AppliedRecord>; cases: Case[]; toolLog: ToolLogEntry[]; toolStarts: Map<string, number>; lastUserUtterance: string; setLastUserUtterance(t); setProposal(p); clearProposal(key); parkedProposals(); snapshot(): SessionSnapshot; reset() }`, constructed with `new Session({ id?, store?, playbooks? })` (defaults: random UUID, fresh `createStore()`, the live registry; `assertRegistry` runs in the constructor).
`SessionSnapshot` (exported from `src/domain/session.ts`, the only definition; the voice layer re-exports it) = `{ id, customer?, activeOrderId?, pending?, proposals: PendingAction[], applied: AppliedRecord[], cases: Case[], toolLog: ToolLogEntry[], lastUserUtterance, utteranceSeq }`. `reset()` gives the session a fresh data copy and empties everything; the registry stays.
Idempotency key format: `${type}:${orderId}:${stableStringify(params)}` (sorted keys, `actionKey()`). `applied` is the ledger. Applying is synchronous in memory (cannot be half done). `proposals` holds every open proposal keyed by action key (a topic switch parks the earlier one instead of overwriting it); `pending` is the one at `lastProposedKey`, i.e. the proposal last put to the customer. `setLastUserUtterance` bumps `utteranceSeq`; proposals are stamped with it (`proposedTurn`). `toolStarts` is the guard's per-call clock for `toolLog.ms`.

## Policies (src/domain/policies/*)

A Playbook is data + pure functions, no LLM (interface above). `actionTypes` says which `apply_resolution` types the playbook can offer, so `apply_resolution` finds the playbook through the type (`playbooksForAction`). `note` gives the tool result a one-line explanation when there are no options.
Rules encoded exactly from the brief:
- reschedule: only if `status === "processing"`; slots from `get_delivery_slots`; confirmation required.
- damaged: options from inventory; replacement if `replacementStock > 0` else refund; `order.totalEur > 200` → `requiresEscalation: true` (no apply allowed, escalate instead); confirmation required.
- late: eligible if `delayDays >= 2` for vip, `>= 4` for standard; amount = `15 + 10 * (delayDays - threshold)` EUR, rounded; if amount `> 50` → requiresEscalation; confirmation required.
`index.ts` exports `playbooks` (the registry, `as const`), `scenarios`, `Scenario` (derived type), `scenariosOf(registry)`, `isScenario(value, registry?)`, `getPlaybook(scenario, registry?)`, `playbooksForAction(type, registry?)`, `assertRegistry(registry)` (throws on empty registry, duplicate scenario, playbook without actionTypes). Adding a scenario = adding one file + one line in the registry; the `issue` union of `check_resolution_options`, the prompt's playbook list and the Scenario type follow. See `examples/scenarios/README.md`.

## Tools (src/domain/tools.ts): names and behaviour are fixed

- `find_customer({ phone?, customerRef? })` → customer + list of their orders (id, status, items, total, placed / promised dates with human labels, `deliveredAt` when delivered) sorted most recent first, plus `mostRecentOrderId`; sets `session.customer`. Phone matching is digit-only and tolerates a national number.
- `get_order({ orderId })` → full order incl. items, status, delivery date (+ label), customer name and tier, `delayDays` (computed vs today when not delivered by promised date), `isLate`, `today` / `todayLabel`; sets `session.activeOrderId`.
- `check_resolution_options({ orderId, issue: <registry scenario> })` → `ResolutionOption[]` from the playbook + `escalationRequired` flag, `delayDays`, `customerTier`, labelled dates, optional `note`; sets `session.activeOrderId`.
- `get_delivery_slots({ orderId })` → next 7 days excluding Sunday, each `{ date, weekday, window: "09-13" | "13-18", label }`, plus the current delivery date; `error` text (and `slots: []`) if the order is no longer processing.
- `apply_resolution({ orderId, type, params, customerConfirmed: boolean })` → two-phase: if no `session.pending` for this key, or `customerConfirmed !== true`, or the guard's affirmative check fails → returns `NEEDS_CONFIRMATION` with a spoken summary (`summary`, `ask`, `why`, `key`) and stores the proposal via `session.setProposal` (no side effect). If key already in ledger → `ALREADY_APPLIED` with receipt, no side effect. Otherwise apply, write ledger, clear pending, return `APPLIED` + receipt. Two more statuses exist: `INVALID` (the params match no option the playbook offers for this order; nothing is stored) and `ESCALATION_REQUIRED` (the matched option has `requiresEscalation`; nothing is stored). Check order in code: INVALID, ESCALATION_REQUIRED, ALREADY_APPLIED, NEEDS_CONFIRMATION, APPLIED. Result shape: `{ status, receipt?, summary?, ask?, why?, reason?, key?, appliedAt?, date?, dateLabel? }`. In practice the guard answers first (see below), so on the wire a premature or repeated apply shows as phase `blocked` with the same status tag.
- `escalate_case({ orderId, reason, details })` → creates a case (idempotent per `orderId` within the session: a second call for the same order returns the open case whatever the wording of the reason), returns `{ status: "CREATED" | "ALREADY_OPEN", caseId, orderId, reason, nextStep }` where `nextStep` = `ESCALATION_NEXT_STEP` ("A colleague reviews the case and calls the customer back within one business day."). Unknown order → `{ found: false, message }`, no case. No confirmation needed, but the model must tell the customer the case id and next step.
Tool results are short JSON strings in `content[0].text` plus `details` for the UI. Throw on genuine failure (the harness reports it); simulate a failure when `params` include `simulateFailure: true` (top level or inside `params.params`) or env `FAIL_TOOL=<name>` is set (`maybeFail`). The voice layer wraps every tool (`instrumentTools`) so a thrown error reaches the model as `Tool <name> failed: <message>`.

## Guards (src/domain/guards.ts): deterministic, not prompt

`beforeToolCall`: (1) `apply_resolution` blocked unless `confirmationVerdict(session, key)` is ok: a proposal with this key exists, it is the one last put to the customer (`lastProposedKey`), it was registered in an earlier utterance (`proposedTurn < utteranceSeq`), nothing else was applied on this utterance (`lastAppliedSeq < utteranceSeq`), AND `session.lastUserUtterance` matches an affirmative (`AFFIRMATIVE_PHRASES`: yes / yeah / yep / confirm / confirmed / go ahead / do it / please do / that's right / correct / evet / tamam / onaylıyorum; whole-word, case-insensitive; an utterance ending in "?" is never affirmative; any `NEGATION_PHRASES` entry in the same utterance such as no, not, don't, cancel, cannot, wait, hold on, wrong, hayır, değil, yok, bekle, dur → not affirmative). Block reason `NEEDS_CONFIRMATION: <why>. Ask them: "<summary> Shall I go ahead?" ...` and the proposal is registered as pending. The same verdict function is what the tool itself checks. (2) `apply_resolution` blocked when the option `requiresEscalation` per playbook (`ESCALATION_REQUIRED: ...`, escalate instead); params matching no option → `BLOCKED: <reason>`. (3) `apply_resolution` with a key already in the ledger → `ALREADY_APPLIED: ... (receipt X)`; `escalate_case` for an order that already has a case → `ALREADY_APPLIED: case <id> is already open ...`; `escalate_case` for an unknown order → `BLOCKED: No order ...` (a misheard id must not become a real-looking case id). Guard check order for apply: BLOCKED (invalid), ALREADY_APPLIED, ESCALATION_REQUIRED, NEEDS_CONFIRMATION. Every block appends `{ ok: false, ms: 0, blocked: reason }` to `session.toolLog`. `afterToolCall`: append to `session.toolLog` with ms and ok. The voice layer tells "blocked" from "ran and failed" by whether the toolLog grew with a non-blocked entry during the call.

## Agent factory (src/agent/createAgent.ts)

```ts
export const DEFAULT_MODEL_ID = "claude-sonnet-4-6"; export const FALLBACK_MODEL_ID = "claude-haiku-4-5";
export interface SupportAgentOptions { session: Session; modelId?: string; streamFn?: StreamFn; model?: Model<any>; onEvent?: (e: AgentEvent) => void }
export interface SupportAgent { agent: Agent; sendUserText(text: string): Promise<void>; abort(): void; isBusy(): boolean }
export function createSupportAgent(opts: SupportAgentOptions): SupportAgent
export function stubModel(id?: string): Model<any>   // for injected streamFns in tests
export function spokenEvent(e: AgentEvent): AgentEvent // text_delta passed through sanitizeSpoken
```
`sendUserText` is serialised (internal promise queue): it waits until the agent is idle, only then sets `session.lastUserUtterance` (which bumps `utteranceSeq`), refreshes `agent.state.systemPrompt = buildSystemPrompt(session)`, then `agent.prompt(text)`. `prepareNextTurnWithContext` rebuilds the prompt between model rounds inside one run (after tool calls), so the live state block is current. A running turn therefore never sees an utterance that arrived while it was executing tools. It does not abort a running turn; callers that want barge-in call `abort()` first (the voice server does). Every event handed to `onEvent` goes through `spokenEvent`: dashes in text deltas become commas or "to" (`src/agent/speech.ts`), the agent's own history is untouched. If `opts.streamFn`/`opts.model` are given, use them (tests inject a fake); else create models + Anthropic provider and read `ANTHROPIC_API_KEY` from env (`dotenv/config`) through `getApiKey`; a missing key does not throw at construction, the first turn ends with `agent.state.errorMessage` set.

## Prompt (src/agent/prompt.ts)

Short. Persona: Hemma support, spoken style, one question at a time, max two sentences per turn unless listing options; no dashes; dates spoken exactly as the tool labels give them (never work out a weekday); windows spoken as "9 to 1" / "1 to 6". Rules paragraph: identify first, every fact from a tool; match a described item to the known orders yourself and act; only offer options that tools return; propose through `apply_resolution` with `customerConfirmed: false` and read out its sentence; never apply without an explicit yes; after APPLIED read the receipt once; on "did it go through" / "do it again" always call `apply_resolution` again and read the ALREADY_APPLIED receipt; if an option requires escalation, `escalate_case` and give the case id and next step; if a tool fails, apologise and offer to escalate; a topic switch keeps the open proposal, one action per customer message, a parked proposal has to be proposed again. Then a live state block (`buildStateBlock`): customer, orders known (most recent first, with labelled dates and window), active order, pending action, other open proposals, applied actions (with receipts), open cases. Then one line per playbook: description + tool order.

## Voice pipeline (src/voice/*, src/server.ts)

Server: `node` http server serving `public/` + `ws` at `/ws`. Per connection: a `Session`, a `SupportAgent`, a Deepgram live STT socket (opened on the first mic frame), and per turn a TTS stream. `/ws` upgrades are accepted only when the browser `Origin` host equals the request `Host` or is listed in `ALLOWED_ORIGINS` (comma separated); requests without `Origin` (tests, curl) are accepted. WS messages are capped at 1 MiB, text turns at 2000 chars.
- Client → server: binary frames = Int16 PCM mono 16 kHz; JSON `{type:"text", text}` (text fallback), `{type:"played", turnId, t}` (first audio played), `{type:"reset"}` (fresh session, re-arms chaos, lifts TTS engine rests).
- Server → client JSON: `{type:"ready", sessionId, voice:{stt, tts, ttsEngines: ("elevenlabs"|"deepgram")[]}, chaos: ("tool"|"tts"|"stt")[]}` (first message on connect, followed by a `state`; the client disables the mic button when `stt` is false and shows a red badge when `chaos` is non-empty), `{type:"stt", text, final}`, `{type:"agent_text", turnId, delta}`, `{type:"tool", turnId, name, phase:"start"|"end"|"blocked", ms?, args?, detail?, error?}` (`args` only on start; `detail` = first 400 chars of the tool result text or the guard's block reason; `error: true` = the tool ran and failed, as opposed to blocked; a failed tool also produces one `error` toast `Tool <name> failed: ...`), `{type:"state", session: SessionSnapshot}` (exactly `Session.snapshot()`, `toolLog` trimmed to the last 30 entries; sent on connect, after every tool end, at turn end and after reset), `{type:"clear_audio"}` (barge-in, new turn while audio still plays, reset), `{type:"latency", turnId, source:"voice"|"text", sttFinalMs, firstTokenMs, firstAudioMs, playedMs, toolMs, totalMs, cancelled, ttsEngine:"elevenlabs"|"deepgram"|"none", ttsEngines: ("elevenlabs"|"deepgram")[]}` (unmeasured values are `null`; `ttsEngine` is the engine that produced the turn's first audio frame, `ttsEngines` every engine that delivered audio this turn in order of first frame, two entries after a mid-turn fallback), `{type:"error", message}`; binary frames = PCM 16 kHz Int16 audio to play.
- Deepgram STT: `wss://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&endpointing=300&utterance_end_ms=1000&vad_events=true&smart_format=true`, header `Authorization: Token <key>`. Up to 2 s of audio is buffered while the socket connects. Send KeepAlive JSON every 8 s. Final user turn = transcript with `speech_final: true` (or `UtteranceEnd` after finals). `SpeechStarted` while the agent is speaking or generating → barge-in: `supportAgent.abort()`, cancel the current TTS stream, send `clear_audio`. A barge-in that produces no transcript within 1800 ms (`RESUME_AFTER_BARGE_IN_MS`, interims not flowing) re-sends the interrupted user text as a new turn (`resumedFrom` in the stdout line), at most 2 times per question. A dropped Deepgram socket is reopened on the next audio frame with backoff 500 / 1500 / 4000 ms, then a 60 s cooldown with one `error` toast.
- TTS engines, per turn, preference order ElevenLabs then Deepgram Aura (`src/voice/tts.ts` is the shared contract). One turn may open at most 2 streams per engine (`MAX_TTS_STREAMS_PER_ENGINE`): the first and one replacement; an engine that used both rests for 60 s (`TTS_ENGINE_COOLDOWN_MS`, per connection, lifted by reset) so later turns start on the next engine. Sentences the dead stream cannot have delivered (`lostChunks`, based on audio bytes received vs 40 ms/char ElevenLabs, 60 ms/char Aura) are re-sent on the replacement; with every engine used up the turn continues as text with one `error` toast. A stream that closes before any text was sent (inactivity) is idle, not a failure. The TTS socket is opened at t0 so its connect time hides behind the first token.
  - ElevenLabs: `wss://api.elevenlabs.io/v1/text-to-speech/<VOICE_ID>/stream-input?model_id=eleven_flash_v2_5&output_format=pcm_16000&inactivity_timeout=180`, header `xi-api-key`; first message `{ text: " ", voice_settings, generation_config: { chunk_length_schedule: [50, 90, 120, 150] }, xi_api_key }`, then `{ text: chunk }` per sentence, `{ text: "" }` to flush; incoming `{ audio: base64 }` → decode → forward as binary; `isFinal` (or a clean close after the flush) ends the stream. Voice from `VOICE_ID` env (`ELEVENLABS_VOICE_ID`, as shipped in `.env.example`, is accepted as an alias); code default `DEFAULT_VOICE_ID = "EXAVITQu4vr4xnSDxMaL"` (Sarah, a premade voice present in every workspace). Measured 2026-09-03 (scratch/vendor-checks.md): the library voice Rachel `21m00Tcm4TlvDq8ikWAM` returns 402 paid_plan_required on a free workspace, so it is not the default any more; `.env.example` and `render.yaml` set Sarah explicitly as well.
  - Deepgram Aura (fallback, same `DEEPGRAM_API_KEY` as STT): `wss://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=linear16&sample_rate=16000`, header `Authorization: Token <key>`; first server message `{type:"Metadata"}`; `{type:"Speak", text}` per sentence, one `{type:"Flush"}` at turn end, `{type:"Flushed"}` back; audio = binary raw PCM frames (about 1280 bytes); `{type:"Close"}` to end; `{type:"Error", description}` is the API error shape.
- Sentence chunker: emit on `.?!` (optionally followed by a closing quote/bracket) followed by whitespace, or when buffer > 120 chars at the last ", ". A period after a list marker ("1. "), a single letter or a common abbreviation is not a sentence end. `text_end` and `tool_execution_start` flush the buffer so the sentence before a tool call is spoken at once.
- Filler, voice turns only: armed when a tool starts, nothing has been spoken this turn and TTS is configured; fires 700 ms later unless something was spoken, the answer already started streaming, or the turn ended (it is not cleared at tool end, the silence is the model round trip after the tool). Synthesizes "One moment, let me check that." once and shows it as `agent_text`. A text turn never gets it.
- Latency per turn: `t0` = STT final timestamp (text receipt for text turns); `sttFinalMs` = estimated ms from end of speech to the final (0 for text); `firstTokenMs`, `firstAudioMs` (first TTS bytes sent), `playedMs` (client report), `toolMs` total, `totalMs` (agent idle and TTS drained or cancelled), `cancelled`, `ttsEngine`, `ttsEngines`. Sent to the client as the `latency` event at turn end, and written as one JSON line to stdout (`logLatencyLine`) with `sessionId`, `audioMs`, `chars`, optional `resumedFrom` and `at`; the stdout line waits up to 2000 ms for the client's `played` report. Human logs go to stderr so stdout stays machine-readable.
- Chaos toggles (`src/voice/chaos.ts`): only from the `/ws` upgrade URL, `?fail=tool,tts,stt` (comma list, any subset, unknown values dropped), never from env. `tool`: the first `check_resolution_options` of the session throws through `maybeFail` (`simulateFailure: true` added to its params), the second works. `tts`: every ElevenLabs stream of the session fails on the next tick without opening a socket (`FailingTtsStream`), so the turn goes retry → Aura fallback and the latency line says `ttsEngine: "deepgram"`. `stt`: the Deepgram socket is closed once right after the first final and reconnects on the next audio frame. `reset` re-arms them.
- Vendor URL overrides for tests: `DEEPGRAM_WS_URL`, `DEEPGRAM_SPEAK_WS_URL`, `ELEVENLABS_WS_URL` point the sockets at a mock server; honoured only for a loopback host, or any host with `ALLOW_VENDOR_URL_OVERRIDE=1` (the API key travels to that host); anything else is ignored with a log line. Every override in force is listed at startup.
- Text-only mode must work with no Deepgram/ElevenLabs keys (voice features disabled, JSON text still flows; binary frames get one error toast). With no `ANTHROPIC_API_KEY` either, a text turn produces `{type:"error", message:"Model error: ..."}` followed by `state` and `latency`; the server never crashes. `GET /healthz` → `{ ok, uptimeSec, sessions, features:{ model: boolean, modelId: string, stt: boolean, tts: boolean, ttsEngines: string[] } }` (`model` = has ANTHROPIC_API_KEY, `modelId` = requested id from `MODEL_ID` or `DEFAULT_MODEL_ID`, `tts` = at least one engine has a key, `ttsEngines` in preference order). SIGINT/SIGTERM close every session and exit.

## Browser client (public/)

`index.html` + `app.js` + `worklet.js`. Buttons: Start mic / Stop, Reset. Text input fallback. Panels: transcript (user / agent), tool calls, session state, latency table per turn (with the TTS engine per turn and a p50 / p95 summary row). Mic: `getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}})` → AudioWorklet downsample to 16 kHz Int16 → WS binary. Playback: AudioWorklet ring buffer at 16 kHz; on `clear_audio` drop buffered audio immediately; report `played` with timestamp when the first chunk of a turn starts playing. Reads `ready.voice` (mic button off when `stt` is false, TTS engine shown) and `ready.chaos` (red badge). `?fail=...` on the page URL is forwarded to the `/ws` URL. Minimal styling, no framework.

## Tests (tests/), scripts and smokes

`npx tsc --noEmit` must be clean and `npx tsx --test tests/*.test.ts` green (2026-09-03 integration round 1: 100 tests, 98 pass, 0 fail, 2 skipped, the skipped ones being the live-model tests).
`tests/domain.test.ts` (no LLM): the 8-step demo scenario driven by calling tools directly in the order the model would, plus: apply without pending → NEEDS_CONFIRMATION; apply after "yes" → APPLIED once; repeat same apply → ALREADY_APPLIED and ledger size unchanged; damaged order > 200 → requiresEscalation and apply blocked; late VIP 2 days → eligible, standard 2 days → not; compensation > 50 → escalation; shipped order → no slots; topic switch keeps pending for the other order; the demo-script evaluators on synthetic turns.
`tests/agent-fake.test.ts`: `createSupportAgent` with a scripted fake `streamFn` that returns tool calls then text, proving the guard blocks a premature `apply_resolution` and that abort mid-turn leaves the ledger untouched.
`tests/voice.test.ts`: `VoiceSession` against mock Deepgram / ElevenLabs / Aura servers on loopback (through the vendor URL overrides) and an injected fake agent: message shapes, barge-in, resume, TTS retry / fallback / cooldown, chaos flags, filler, latency report, origin rules.
`tests/live.test.ts`: real model, skipped unless `ANTHROPIC_API_KEY` set and `LIVE=1`.
`scripts/demo-check.ts` (`npm run demo:check -- --port N`): the 8 steps over `/ws` in text mode against a running server, PASS / WARN / FAIL per step plus a latency summary; step 2 (barge-in) is voice only and reported SKIP. `scratch/voice-smoke.ts <port>`: macOS `say` audio streamed like a mic, expects stt final → agent text → audio → latency, then a barge-in with `clear_audio`. `scratch/chaos-smoke.ts <port> [fail]`: one text turn over `/ws?fail=tts`, expects `ttsEngine: "deepgram"` and audio bytes.

## Mock data (src/domain/data.ts)

Customer A (VIP): Anna Weber, ref `HM-2201`, phone `+49 30 1234567`. Orders: `HM-1042` processing, placed 2026-09-01, promised 2026-09-08 (Tue), 1× "Linen sofa cover, grey" EUR 89, stock 12. `HM-0977` delivered 2026-08-28, "Arc floor lamp, brass" EUR 240, stock 3 (damaged → escalation because > 200). 
Customer B (standard): Jonas Berg, ref `HM-2305`, phone `+46 70 5551212`. Orders: `HM-1010` shipped, promised 2026-08-30 (late 4 days as of today) EUR 120 "Oak side table" stock 0; `HM-1031` delivered, "Ceramic vase set" EUR 45, stock 0 (damaged → refund path, no escalation).
Slots: for processing orders, dates today+1 … today+7 skipping Sunday, windows 09-13 and 13-18. Friday 2026-09-04 must be present (2026-09-05 is a Saturday, 2026-09-06 the skipped Sunday).
