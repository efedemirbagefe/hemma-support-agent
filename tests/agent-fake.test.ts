/**
 * Drives createSupportAgent with a scripted fake streamFn (no network) and
 * proves that the deterministic guards, not the prompt, protect the ledger.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentEvent, StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type TextContent, type ToolCall } from "@earendil-works/pi-ai";
import { createSupportAgent, type SupportAgent } from "../src/agent/createAgent";
import { Session } from "../src/domain/session";

const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

interface ScriptedToolCall {
  name: string;
  args: Record<string, unknown>;
}

interface Step {
  tools?: ScriptedToolCall[];
  text?: string;
  /** Emit toolcall_start, then wait for the abort signal and end the stream as aborted. */
  hangUntilAbort?: boolean;
}

function message(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "fake",
    usage: USAGE,
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

function scripted(steps: Step[]) {
  const calls: Context[] = [];
  let callId = 0;
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

  const streamFn: StreamFn = (_model, context, options) => {
    const stream = createAssistantMessageEventStream();
    calls.push(context);
    const signal = options?.signal;
    const abort = () => stream.push({ type: "error", reason: "aborted", error: message([], "aborted", "aborted by user") });

    void (async () => {
      if (signal?.aborted) return abort();
      const step = steps.shift();
      if (!step) return stream.push({ type: "error", reason: "error", error: message([], "error", "script exhausted") });

      const content: AssistantMessage["content"] = [];
      const partial = () => message([...content], "pending");
      stream.push({ type: "start", partial: partial() });
      await tick();

      if (step.text !== undefined) {
        const block: TextContent = { type: "text", text: "" };
        content.push(block);
        const idx = content.length - 1;
        stream.push({ type: "text_start", contentIndex: idx, partial: partial() });
        await tick();
        if (signal?.aborted) return abort();
        block.text = step.text;
        stream.push({ type: "text_delta", contentIndex: idx, delta: step.text, partial: partial() });
        stream.push({ type: "text_end", contentIndex: idx, content: step.text, partial: partial() });
        await tick();
      }

      for (const call of step.tools ?? []) {
        stream.push({ type: "toolcall_start", contentIndex: content.length, partial: partial() });
        if (step.hangUntilAbort) {
          await new Promise<void>((resolve) => {
            if (!signal || signal.aborted) return resolve();
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return abort();
        }
        await tick();
        if (signal?.aborted) return abort();
        const toolCall: ToolCall = { type: "toolCall", id: `call-${++callId}`, name: call.name, arguments: call.args };
        content.push(toolCall);
        stream.push({ type: "toolcall_end", contentIndex: content.length - 1, toolCall, partial: partial() });
        await tick();
      }

      const reason = (step.tools?.length ?? 0) > 0 ? "toolUse" : "stop";
      stream.push({ type: "done", reason, message: message([...content], reason) });
    })();

    return stream;
  };

  return { streamFn, calls, remaining: () => steps.length };
}

interface ToolEnd {
  name: string;
  text: string;
  isError: boolean;
}

function recorder() {
  const ends: ToolEnd[] = [];
  const starts: string[] = [];
  const deltas: string[] = [];
  const onEvent = (e: AgentEvent) => {
    if (e.type === "tool_execution_start") starts.push(e.toolName);
    if (e.type === "tool_execution_end") ends.push({ name: e.toolName, text: e.result.content[0].text, isError: e.isError });
    if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") deltas.push(e.assistantMessageEvent.delta);
  };
  return { ends, starts, deltas, onEvent, reset: () => { ends.length = 0; starts.length = 0; deltas.length = 0; } };
}

const APPLY_FRIDAY: ScriptedToolCall = {
  name: "apply_resolution",
  args: { orderId: "HM-1042", type: "reschedule", params: { date: "2026-09-04", window: "13-18" }, customerConfirmed: true },
};

test("guard blocks a premature apply_resolution, allows it after yes, blocks the repeat", async () => {
  const session = new Session();
  const script = scripted([
    {
      tools: [
        { name: "find_customer", args: { customerRef: "HM-2201" } },
        { name: "get_order", args: { orderId: "HM-1042" } },
        { name: "get_delivery_slots", args: { orderId: "HM-1042" } },
      ],
    },
    { tools: [APPLY_FRIDAY] }, // premature: the model claims customerConfirmed before asking
    { text: "I can move it to Friday afternoon, 1 to 6. Shall I go ahead?" },
    { tools: [APPLY_FRIDAY] }, // turn 2, after "yes"
    { text: "Done, Friday afternoon it is." },
    { tools: [APPLY_FRIDAY] }, // turn 3, the model retries
    { text: "That is already booked for Friday afternoon." },
  ]);
  const rec = recorder();
  const sa = createSupportAgent({ session, streamFn: script.streamFn, onEvent: rec.onEvent });

  await sa.sendUserText("Hi, Anna Weber, HM-2201. Can you move my sofa cover delivery to Friday afternoon?");
  assert.equal(sa.agent.state.errorMessage, undefined);
  assert.deepEqual(rec.starts, ["find_customer", "get_order", "get_delivery_slots", "apply_resolution"]);
  const premature = rec.ends.find((e) => e.name === "apply_resolution");
  assert.ok(premature);
  assert.equal(premature.isError, true);
  assert.match(premature.text, /^NEEDS_CONFIRMATION/);
  assert.equal(session.applied.size, 0, "nothing applied without a yes");
  assert.equal(session.pending?.orderId, "HM-1042");
  assert.equal(session.customer?.ref, "HM-2201");
  assert.equal(rec.deltas.join(""), "I can move it to Friday afternoon, 1 to 6. Shall I go ahead?");
  assert.ok(session.toolLog.some((l) => l.tool === "apply_resolution" && l.blocked?.startsWith("NEEDS_CONFIRMATION")));
  assert.equal(session.toolLog.filter((l) => l.ok).length, 3, "the three lookups are logged ok by afterToolCall");
  // The blocked reason reached the model as an error tool result in the next request.
  const afterBlock = script.calls[2];
  const lastToolResult = [...afterBlock.messages].reverse().find((m) => m.role === "toolResult");
  assert.ok(lastToolResult && lastToolResult.role === "toolResult");
  assert.equal(lastToolResult.isError, true);
  assert.match((lastToolResult.content[0] as TextContent).text, /NEEDS_CONFIRMATION/);
  // The live state block was refreshed inside the run once the customer was known.
  assert.match(script.calls[1].systemPrompt ?? "", /Anna Weber/);
  assert.match(script.calls[2].systemPrompt ?? "", /Pending action \(waiting for an explicit yes\): Move the delivery of order HM-1042/);

  rec.reset();
  await sa.sendUserText("yes");
  const applied = rec.ends.find((e) => e.name === "apply_resolution");
  assert.ok(applied);
  assert.equal(applied.isError, false);
  assert.match(applied.text, /"status":"APPLIED"/);
  assert.equal(session.applied.size, 1);
  assert.equal(session.pending, undefined);
  assert.equal(session.store.orders.find((o) => o.id === "HM-1042")?.promisedDeliveryDate, "2026-09-04");

  rec.reset();
  await sa.sendUserText("yes, do it again");
  const again = rec.ends.find((e) => e.name === "apply_resolution");
  assert.ok(again);
  assert.equal(again.isError, true);
  assert.match(again.text, /^ALREADY_APPLIED/);
  assert.equal(session.applied.size, 1, "ledger unchanged");
  assert.equal(script.remaining(), 0);
  assert.equal(sa.isBusy(), false);
});

test("abort while the model is streaming leaves the ledger untouched and keeps the proposal", async () => {
  const session = new Session();
  const script = scripted([
    { tools: [APPLY_FRIDAY] }, // premature: creates the pending proposal
    { text: "Shall I move it to Friday afternoon?" },
    { tools: [APPLY_FRIDAY], hangUntilAbort: true }, // turn 2: customer barges in mid-stream
    { tools: [APPLY_FRIDAY] }, // turn 3
    { text: "Done." },
  ]);
  const rec = recorder();
  let armed = false;
  let sa: SupportAgent;
  sa = createSupportAgent({
    session,
    streamFn: script.streamFn,
    onEvent: (e) => {
      rec.onEvent(e);
      if (armed && e.type === "message_update" && e.assistantMessageEvent.type === "toolcall_start") sa.abort();
    },
  });

  await sa.sendUserText("Move HM-1042 to Friday afternoon please.");
  assert.ok(session.pending);
  assert.equal(session.applied.size, 0);

  armed = true;
  rec.reset();
  await sa.sendUserText("yes");
  armed = false;
  assert.equal(session.applied.size, 0, "aborted turn must not apply");
  assert.ok(session.pending, "proposal survives the abort");
  assert.equal(sa.agent.state.errorMessage, "aborted by user");
  assert.deepEqual(rec.starts, [], "no tool ran in the aborted turn");
  assert.equal(sa.isBusy(), false);

  rec.reset();
  await sa.sendUserText("yes");
  assert.equal(session.applied.size, 1);
  assert.equal(session.pending, undefined);
  assert.match(rec.ends.find((e) => e.name === "apply_resolution")?.text ?? "", /"status":"APPLIED"/);
});

test("abort at tool_execution_start prevents the tool from executing", async () => {
  const session = new Session();
  const script = scripted([
    { tools: [APPLY_FRIDAY] },
    { text: "Shall I?" },
    { tools: [APPLY_FRIDAY] },
    { text: "Done." },
  ]);
  const rec = recorder();
  let armed = false;
  let sa: SupportAgent;
  sa = createSupportAgent({
    session,
    streamFn: script.streamFn,
    onEvent: (e) => {
      rec.onEvent(e);
      if (armed && e.type === "tool_execution_start" && e.toolName === "apply_resolution") sa.abort();
    },
  });
  await sa.sendUserText("Friday afternoon for HM-1042 please.");
  assert.ok(session.pending);

  armed = true;
  rec.reset();
  await sa.sendUserText("yes");
  armed = false;
  const end = rec.ends.find((e) => e.name === "apply_resolution");
  assert.ok(end);
  assert.equal(end.isError, true);
  assert.match(end.text, /aborted/i);
  assert.equal(session.applied.size, 0);
  assert.ok(session.pending);
  assert.ok(!session.toolLog.some((l) => l.tool === "apply_resolution" && l.ok));
});

const APPLY_SATURDAY: ScriptedToolCall = {
  name: "apply_resolution",
  args: { orderId: "HM-1042", type: "reschedule", params: { date: "2026-09-05", window: "09-13" }, customerConfirmed: true },
};

test("a yes to an unrelated question, followed by propose+apply in the same turn, stays unapplied", async () => {
  const session = new Session();
  const script = scripted([
    { text: "Am I speaking with Anna Weber, customer HM-2201?" },
    // turn 2: the customer's "yes" answers the identity question; the model looks her up,
    // registers the Friday proposal and immediately re-issues it.
    { tools: [{ name: "find_customer", args: { customerRef: "HM-2201" } }, APPLY_FRIDAY] },
    { tools: [APPLY_FRIDAY] },
    { text: "Friday afternoon, 1 to 6. Shall I go ahead?" },
    // turn 3: a real yes to the proposal
    { tools: [APPLY_FRIDAY] },
    { text: "Done." },
  ]);
  const rec = recorder();
  const sa = createSupportAgent({ session, streamFn: script.streamFn, onEvent: rec.onEvent });

  await sa.sendUserText("Hello, I have a question about my sofa cover.");
  rec.reset();
  await sa.sendUserText("yes");
  const applies = rec.ends.filter((e) => e.name === "apply_resolution");
  assert.equal(applies.length, 2);
  assert.ok(applies.every((e) => e.isError && /^NEEDS_CONFIRMATION/.test(e.text)), "both applies in the yes-turn are blocked");
  assert.match(applies[1].text, /current turn/);
  assert.equal(session.applied.size, 0, "nothing applied on a yes the proposal did not exist for");
  assert.equal(session.store.orders.find((o) => o.id === "HM-1042")?.promisedDeliveryDate, "2026-09-08");
  assert.equal(session.pending?.orderId, "HM-1042", "the proposal is registered for the next turn");
  assert.equal(rec.deltas.join(""), "Friday afternoon, 1 to 6. Shall I go ahead?");

  rec.reset();
  await sa.sendUserText("yes");
  assert.match(rec.ends.find((e) => e.name === "apply_resolution")?.text ?? "", /"status":"APPLIED"/);
  assert.equal(session.applied.size, 1);
  assert.equal(script.remaining(), 0);
});

test("one yes cannot apply two different actions in one turn", async () => {
  const session = new Session();
  const script = scripted([
    { tools: [APPLY_FRIDAY] },
    { text: "Friday afternoon, shall I go ahead?" },
    // turn 2: the yes applies Friday; the model then proposes Saturday and re-issues it at once
    { tools: [APPLY_FRIDAY, APPLY_SATURDAY] },
    { tools: [APPLY_SATURDAY] },
    { text: "Saturday morning, 9 to 1. Shall I go ahead with that instead?" },
  ]);
  const rec = recorder();
  const sa = createSupportAgent({ session, streamFn: script.streamFn, onEvent: rec.onEvent });
  await sa.sendUserText("Friday afternoon for HM-1042 please");
  rec.reset();
  await sa.sendUserText("yes");
  const applies = rec.ends.filter((e) => e.name === "apply_resolution");
  assert.equal(applies.length, 3);
  assert.match(applies[0].text, /"status":"APPLIED"/);
  assert.equal(applies[1].isError, true);
  assert.equal(applies[2].isError, true);
  assert.deepEqual([...session.applied.keys()], ['reschedule:HM-1042:{"date":"2026-09-04","window":"13-18"}']);
  assert.equal(session.store.orders.find((o) => o.id === "HM-1042")?.promisedDeliveryDate, "2026-09-04");
  assert.equal(session.pending?.params.date, "2026-09-05", "Saturday waits for its own yes");
  assert.equal(script.remaining(), 0);
});

test("an utterance arriving while a turn is running cannot confirm that turn's proposal", async () => {
  const session = new Session();
  const script = scripted([
    { tools: [APPLY_FRIDAY, APPLY_FRIDAY] }, // turn 1: proposes (blocked), then retries in the same message
    { text: "Friday afternoon, shall I go ahead?" },
    { tools: [APPLY_FRIDAY] }, // turn 2: runs only after turn 1 is over
    { text: "Done." },
  ]);
  const rec = recorder();
  let fired = false;
  let second: Promise<void> | undefined;
  let ledgerAtTurn1End = -1;
  let utteranceAtTurn1End = "";
  let sa: SupportAgent;
  sa = createSupportAgent({
    session,
    streamFn: script.streamFn,
    onEvent: (e) => {
      rec.onEvent(e);
      // The customer's next utterance arrives while turn 1 is still executing tools.
      if (!fired && e.type === "tool_execution_end" && e.toolName === "apply_resolution") {
        fired = true;
        second = sa.sendUserText("yes, that is correct");
      }
      if (ledgerAtTurn1End < 0 && e.type === "agent_end") {
        ledgerAtTurn1End = session.applied.size;
        utteranceAtTurn1End = session.lastUserUtterance;
      }
    },
  });
  await sa.sendUserText("Hi, what delivery options do I have for HM-1042?");
  assert.ok(second, "the second utterance was sent mid-turn");
  await second;
  const turn1Applies = rec.ends.filter((e) => e.name === "apply_resolution");
  assert.ok(turn1Applies.length >= 2);
  assert.ok(turn1Applies[0].isError && turn1Applies[1].isError, "both applies of turn 1 are blocked");
  assert.equal(ledgerAtTurn1End, 0, "the running turn could not apply");
  assert.equal(utteranceAtTurn1End, "Hi, what delivery options do I have for HM-1042?", "the running turn never saw the later utterance");
  assert.equal(session.lastUserUtterance, "yes, that is correct");
  assert.equal(session.utteranceSeq, 2);
  assert.equal(session.applied.size, 1, "the queued yes applies through the normal path once its own turn runs");
  assert.equal(script.remaining(), 0);
  assert.equal(sa.isBusy(), false);
});

test("text deltas reach subscribers with dashes turned into commas; the agent's own history keeps the original", async () => {
  const session = new Session();
  const original = "Friday — the 4th of September, 9–13. Shall I go ahead?";
  const script = scripted([{ text: original }]);
  const rec = recorder();
  const sa = createSupportAgent({ session, streamFn: script.streamFn, onEvent: rec.onEvent });
  await sa.sendUserText("hi");
  assert.equal(rec.deltas.join(""), "Friday, the 4th of September, 9 to 13. Shall I go ahead?");
  const last = sa.agent.state.messages[sa.agent.state.messages.length - 1];
  assert.equal(last.role, "assistant");
  assert.equal(((last as AssistantMessage).content[0] as TextContent).text, original, "history is not rewritten");
  assert.equal(script.remaining(), 0);
});
