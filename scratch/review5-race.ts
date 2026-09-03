// sendUserText sets lastUserUtterance BEFORE waiting for the running turn to finish.
import { createSupportAgent } from "../src/agent/createAgent";
import { Session } from "../src/domain/session";
import { scripted, recorder } from "./fake-helper";
const APPLY_FRIDAY = { name: "apply_resolution", args: { orderId: "NV-1042", type: "reschedule", params: { date: "2026-09-04", window: "13-18" }, customerConfirmed: true } };
const session = new Session();
const script = scripted([
  { tools: [APPLY_FRIDAY, APPLY_FRIDAY] }, // turn 1: proposes (blocked) then retries within the same assistant message
  { text: "ok" },
  { text: "ok" },
]);
const rec = recorder();
let fired = false;
let second: Promise<void> | undefined;
const sa = createSupportAgent({
  session,
  streamFn: script.streamFn,
  onEvent: (e) => {
    rec.onEvent(e);
    // The customer's next utterance arrives (via a second sendUserText call) while turn 1 is still running.
    if (!fired && e.type === "tool_execution_end" && e.toolName === "apply_resolution") {
      fired = true;
      second = sa.sendUserText("yes, that is correct");
    }
  },
});
await sa.sendUserText("Hi, what delivery options do I have for NV-1042?");
await second;
console.log("tool ends turn 1:", rec.ends.map((e) => `${e.name}:${e.isError ? "ERR " : ""}${e.text.slice(0, 30)}`));
console.log("ledger:", session.applied.size, "errorMessage:", sa.agent.state.errorMessage);
