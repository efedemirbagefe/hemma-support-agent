// (a)/(b): a "yes" that answers an unrelated question, and in the SAME turn the model
// proposes and then re-issues apply_resolution. Does the guard let it through?
import { createSupportAgent } from "../src/agent/createAgent";
import { Session } from "../src/domain/session";
import { scripted, recorder } from "./fake-helper";

const APPLY_FRIDAY = { name: "apply_resolution", args: { orderId: "NV-1042", type: "reschedule", params: { date: "2026-09-04", window: "13-18" }, customerConfirmed: true } };
const APPLY_SAT = { name: "apply_resolution", args: { orderId: "NV-1042", type: "reschedule", params: { date: "2026-09-05", window: "09-13" }, customerConfirmed: true } };

async function caseA() {
  const session = new Session();
  const script = scripted([
    { text: "Am I speaking with Anna Weber, customer NV-2201?" },
    // turn 2: customer says "yes" to the identity question. Model proposes and applies in one turn.
    { tools: [{ name: "find_customer", args: { customerRef: "NV-2201" } }, APPLY_FRIDAY] },
    { tools: [APPLY_FRIDAY] },
    { text: "Done." },
  ]);
  const rec = recorder();
  const sa = createSupportAgent({ session, streamFn: script.streamFn, onEvent: rec.onEvent });
  await sa.sendUserText("Hello, I have a question about my sofa cover.");
  await sa.sendUserText("yes");
  console.log("CASE A (yes to identity question, propose+apply in same turn):");
  console.log("  tool ends:", rec.ends.map((e) => `${e.name}:${e.isError ? "ERR " : ""}${e.text.slice(0, 40)}`));
  console.log("  ledger size:", session.applied.size, "pending:", session.pending?.key);
  console.log("  promisedDeliveryDate now:", session.store.orders.find((o) => o.id === "NV-1042")!.promisedDeliveryDate);
}

async function caseB() {
  // Customer confirmed Friday afternoon. Same turn: model applies Friday, then proposes+applies Saturday morning.
  const session = new Session();
  const script = scripted([
    { tools: [APPLY_FRIDAY] },
    { text: "Move it to Friday afternoon, shall I go ahead?" },
    { tools: [APPLY_FRIDAY, APPLY_SAT] },
    { tools: [APPLY_SAT] },
    { text: "Done twice." },
  ]);
  const rec = recorder();
  const sa = createSupportAgent({ session, streamFn: script.streamFn, onEvent: rec.onEvent });
  await sa.sendUserText("Friday afternoon for NV-1042 please");
  rec.reset();
  await sa.sendUserText("yes");
  console.log("CASE B (one yes, two different reschedules applied in the same turn):");
  console.log("  tool ends:", rec.ends.map((e) => `${e.name}:${e.isError ? "ERR " : ""}${e.text.slice(0, 40)}`));
  console.log("  ledger keys:", [...session.applied.keys()]);
  console.log("  promisedDeliveryDate now:", session.store.orders.find((o) => o.id === "NV-1042")!.promisedDeliveryDate);
}

await caseA();
await caseB();
