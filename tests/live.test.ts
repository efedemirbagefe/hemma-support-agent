/**
 * Real model. Runs only with LIVE=1 and ANTHROPIC_API_KEY set.
 *   LIVE=1 npx tsx --test tests/live.test.ts
 *   LIVE=1 MODEL_ID=claude-haiku-4-5 npx tsx --test tests/live.test.ts
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createSupportAgent } from "../src/agent/createAgent";
import { formatReport, mergeToolEvent, phaseFromResult, runDemo, type TurnRecord } from "../src/agent/demo-script";
import { Session } from "../src/domain/session";

const enabled = process.env.LIVE === "1" && !!process.env.ANTHROPIC_API_KEY;
const skip = enabled ? false : "set LIVE=1 and ANTHROPIC_API_KEY to run";

test("live: the real model reschedules HM-1042 only after an explicit yes", { skip, timeout: 240_000 }, async () => {
  const session = new Session();
  const toolsCalled: string[] = [];
  let transcript = "";
  const sa = createSupportAgent({
    session,
    modelId: process.env.MODEL_ID,
    onEvent: (e) => {
      if (e.type === "tool_execution_start") toolsCalled.push(e.toolName);
      if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") transcript += e.assistantMessageEvent.delta;
    },
  });

  await sa.sendUserText(
    "Hi, this is Anna Weber, customer reference HM-2201. I need to move the delivery of my sofa cover, order HM-1042, to Friday the 4th of September, the afternoon slot.",
  );
  assert.equal(sa.agent.state.errorMessage, undefined, `turn 1 error: ${sa.agent.state.errorMessage}`);
  assert.ok(toolsCalled.includes("find_customer") || toolsCalled.includes("get_order"), `tools called: ${toolsCalled.join(", ")}`);
  assert.equal(session.applied.size, 0, "nothing may be applied before the customer says yes");
  transcript += "\n---\n";

  await sa.sendUserText("Yes, please go ahead.");
  assert.equal(sa.agent.state.errorMessage, undefined, `turn 2 error: ${sa.agent.state.errorMessage}`);
  if (session.applied.size === 0) {
    transcript += "\n---\n";
    await sa.sendUserText("Yes, Friday the 4th in the afternoon, 13 to 18. Confirmed.");
  }
  console.log(`live transcript:\n${transcript}\ntools: ${toolsCalled.join(", ")}`);
  assert.equal(session.applied.size, 1, `ledger: ${JSON.stringify([...session.applied.values()])}`);
  const record = [...session.applied.values()][0];
  assert.equal(record.type, "reschedule");
  assert.equal(record.orderId, "HM-1042");
  assert.equal(session.pending, undefined);
});

test("live: the 8-step demo in the brief's order, in-process, no failed step", { skip, timeout: 600_000 }, async () => {
  const session = new Session();
  let current: TurnRecord | undefined;
  let startedAt = 0;
  const sa = createSupportAgent({
    session,
    modelId: process.env.MODEL_ID,
    onEvent: (e) => {
      if (!current) return;
      if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") {
        if (current.firstTokenMs === null) current.firstTokenMs = Date.now() - startedAt;
        current.text += e.assistantMessageEvent.delta;
      } else if (e.type === "tool_execution_start") {
        mergeToolEvent(current.tools, { name: e.toolName, phase: "start", args: e.args });
      } else if (e.type === "tool_execution_end") {
        const content = e.result.content as Array<{ type: string; text?: string }>;
        const text = content
          .filter((c) => c.type === "text" && typeof c.text === "string")
          .map((c) => c.text as string)
          .join("\n");
        const phase = phaseFromResult(text, e.isError);
        mergeToolEvent(current.tools, { name: e.toolName, phase, detail: text.slice(0, 400), error: e.isError && phase === "end" });
      }
    },
  });

  const report = await runDemo({
    textMode: true,
    log: (line) => console.log(line),
    sendTurn: async (text, step, extra) => {
      const rec: TurnRecord = { step, user: text, extra, text: "", tools: [], firstTokenMs: null, totalMs: null, errors: [] };
      current = rec;
      startedAt = Date.now();
      try {
        await sa.sendUserText(text);
      } catch (err) {
        rec.errors.push(err instanceof Error ? err.message : String(err));
      }
      rec.totalMs = Date.now() - startedAt;
      if (sa.agent.state.errorMessage) rec.errors.push(`Model error: ${sa.agent.state.errorMessage}`);
      rec.state = session.snapshot();
      current = undefined;
      return rec;
    },
  });
  console.log(formatReport(report));
  assert.equal(report.failures, 0, report.steps.filter((s) => s.verdict === "FAIL").map((s) => `step ${s.n}: ${s.notes.join("; ")}`).join("\n"));
  assert.equal(session.applied.size, 1);
  assert.equal(session.cases.length, 1);
});
