// (d): pending for order 1 when the second topic also produces a proposal (non-escalation path).
import { Session } from "../src/domain/session";
import { createTools } from "../src/domain/tools";

const session = new Session();
const tools = createTools(session);
const call = async (name: string, args: any) => JSON.parse((await tools.find((t) => t.name === name)!.execute("x", args, undefined as any, () => {})).content[0].text as string);

await call("find_customer", { customerRef: "NV-2305" });
await call("get_order", { orderId: "NV-1010" });
const late = await call("check_resolution_options", { orderId: "NV-1010", issue: "late" });
const p1 = await call("apply_resolution", { orderId: "NV-1010", type: "compensation", params: { amountEur: 15 }, customerConfirmed: false });
console.log("proposal 1:", p1.status, "pending:", session.pending?.key);

session.setLastUserUtterance("Wait, before that: the vase set from NV-1031 arrived broken.");
await call("get_order", { orderId: "NV-1031" });
await call("check_resolution_options", { orderId: "NV-1031", issue: "damaged" });
const p2 = await call("apply_resolution", { orderId: "NV-1031", type: "refund", params: { sku: "VASE-CER-SET" }, customerConfirmed: false });
console.log("proposal 2:", p2.status, "pending now:", session.pending?.key);

session.setLastUserUtterance("Yes, do the refund.");
const r2 = await call("apply_resolution", { orderId: "NV-1031", type: "refund", params: { sku: "VASE-CER-SET" }, customerConfirmed: true });
console.log("apply refund:", r2.status);

session.setLastUserUtterance("And yes, go ahead with the 15 euro compensation too.");
const r1 = await call("apply_resolution", { orderId: "NV-1010", type: "compensation", params: { amountEur: 15 }, customerConfirmed: true });
console.log("apply compensation after returning to topic 1:", r1.status, "(expected APPLIED if pending was kept)");
console.log("ledger:", [...session.applied.keys()]);
