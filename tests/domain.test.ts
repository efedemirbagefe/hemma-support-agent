import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { AfterToolCallContext, BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import { wrongItemPlaybook } from "../examples/scenarios/wrong-item";
import {
  DEMO_LINES,
  DEMO_STEPS,
  applyStatus,
  demoSteps,
  formatReport,
  lintTurn,
  mergeToolEvent,
  phaseFromResult,
  runDemo,
  summarizeLatency,
  weekdayMismatches,
  type DemoStep,
  type ToolSeen,
  type TurnRecord,
} from "../src/agent/demo-script";
import { buildStateBlock, buildSystemPrompt } from "../src/agent/prompt";
import { hasDash, sanitizeSpoken } from "../src/agent/speech";
import { confirmationAsk, resolveAction, summarize } from "../src/domain/actions";
import { MONTH_NAMES, WEEKDAY_NAMES, addDays, daysBetween, humanDate, isoDate, monthName, today, weekdayName } from "../src/domain/clock";
import { findCustomer, findOrder } from "../src/domain/data";
import { AFFIRMATIVE_PHRASES, NEGATION_PHRASES, applyResolutionBlockReason, isAffirmative, makeAfterToolCall, makeBeforeToolCall } from "../src/domain/guards";
import { isLang, parseLang } from "../src/domain/lang";
import { damagedPlaybook } from "../src/domain/policies/damaged";
import { getPlaybook, isScenario, playbooks, playbooksForAction, scenarios } from "../src/domain/policies/index";
import { compensationFor } from "../src/domain/policies/late";
import { deliverySlots } from "../src/domain/policies/reschedule";
import { Session, actionKey, stableStringify, type SessionSnapshot } from "../src/domain/session";
import { ESCALATION_NEXT_STEP, ESCALATION_NEXT_STEP_TR, createTools } from "../src/domain/tools";
import type { Customer, Playbook, ResolutionOption } from "../src/domain/types";

type Json = Record<string, any>;

function harness(session = new Session()) {
  const tools = createTools(session);
  let n = 0;
  async function call(name: string, args: Record<string, unknown>): Promise<Json> {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, `tool ${name} exists`);
    const r = await tool.execute(`tc-${++n}`, args as never);
    const c = r.content[0];
    assert.equal(c.type, "text");
    return JSON.parse((c as { text: string }).text) as Json;
  }
  return { session, tools, call };
}

function beforeCtx(name: string, args: unknown, id = "g1"): BeforeToolCallContext {
  return {
    assistantMessage: {} as BeforeToolCallContext["assistantMessage"],
    toolCall: { type: "toolCall", id, name, arguments: args as Record<string, any> },
    args,
    context: { systemPrompt: "", messages: [] },
  };
}

const FRIDAY = { date: "2026-09-04", window: "13-18" };
const RESCHEDULE_1042 = { orderId: "HM-1042", type: "reschedule", params: FRIDAY };

afterEach(() => {
  delete process.env.NOW;
  delete process.env.FAIL_TOOL;
});

describe("clock", () => {
  test("today defaults to 2026-09-03, a Thursday", () => {
    assert.equal(isoDate(today()), "2026-09-03");
    assert.equal(weekdayName(today()), "Thursday");
  });
  test("NOW overrides today on every call", () => {
    process.env.NOW = "2026-09-08";
    assert.equal(isoDate(today()), "2026-09-08");
    assert.equal(weekdayName(today()), "Tuesday");
    process.env.NOW = "2026-09-10T15:30:00Z";
    assert.equal(isoDate(today()), "2026-09-10");
  });
  test("addDays and daysBetween are whole UTC days", () => {
    assert.equal(isoDate(addDays("2026-08-30", 4)), "2026-09-03");
    assert.equal(daysBetween("2026-08-30", "2026-09-03"), 4);
    assert.equal(daysBetween("2026-09-03", "2026-08-30"), -4);
  });
});

describe("mock data", () => {
  test("customers are found by ref (any case) and by phone (any format)", () => {
    const s = new Session();
    assert.equal(findCustomer(s.store, { customerRef: "hm-2201" })?.name, "Anna Weber");
    assert.equal(findCustomer(s.store, { phone: "+49 30 1234567" })?.name, "Anna Weber");
    assert.equal(findCustomer(s.store, { phone: "0049-30-1234567" })?.name, "Anna Weber");
    assert.equal(findCustomer(s.store, { phone: "030 1234567" })?.name, "Anna Weber");
    assert.equal(findCustomer(s.store, { phone: "+46705551212" })?.name, "Jonas Berg");
    assert.equal(findCustomer(s.store, { phone: "12345" }), undefined);
    assert.equal(findCustomer(s.store, {}), undefined);
  });
  test("each session gets its own copy of the store", () => {
    const a = new Session();
    const b = new Session();
    findOrder(a.store, "HM-1042")!.promisedDeliveryDate = "2099-01-01";
    assert.equal(findOrder(b.store, "HM-1042")!.promisedDeliveryDate, "2026-09-08");
  });
});

describe("delivery slots", () => {
  test("next 7 days, Sunday skipped, two windows, 2026-09-05 present", () => {
    const slots = deliverySlots(today());
    assert.equal(slots.length, 12);
    assert.equal(slots[0].date, "2026-09-04");
    assert.equal(slots[slots.length - 1].date, "2026-09-10");
    assert.ok(slots.every((s) => s.weekday !== "Sunday"));
    assert.ok(!slots.some((s) => s.date === "2026-09-06"), "Sunday 2026-09-06 must be skipped");
    assert.ok(slots.some((s) => s.date === "2026-09-05"), "2026-09-05 must be present");
    const friday = slots.filter((s) => s.date === "2026-09-04");
    assert.deepEqual(
      friday.map((s) => s.window),
      ["09-13", "13-18"],
    );
    assert.equal(friday[0].weekday, "Friday");
  });
});

describe("session keys", () => {
  test("stableStringify sorts keys and drops undefined", () => {
    assert.equal(stableStringify({ b: 1, a: { d: 2, c: [1, 2] }, u: undefined }), '{"a":{"c":[1,2],"d":2},"b":1}');
  });
  test("actionKey is independent of param key order", () => {
    const k1 = actionKey("reschedule", "HM-1042", { date: "2026-09-05", window: "13-18" });
    const k2 = actionKey("reschedule", "HM-1042", { window: "13-18", date: "2026-09-05" });
    assert.equal(k1, k2);
    assert.equal(k1, 'reschedule:HM-1042:{"date":"2026-09-05","window":"13-18"}');
  });
});

describe("isAffirmative (pure)", () => {
  test("accepts the listed affirmatives in any case and with punctuation", () => {
    for (const u of [
      "yes",
      "Yes.",
      "YES!",
      "yeah, go ahead",
      "yep",
      "confirm",
      "Confirmed",
      "go ahead",
      "do it",
      "please do",
      "That's right",
      "that’s right",
      "correct",
      "Evet",
      "tamam.",
      "Onaylıyorum",
      "sure, yes, the Friday one",
    ]) {
      assert.equal(isAffirmative(u), true, `expected affirmative: ${u}`);
    }
  });
  test("rejects negations, unrelated text and substrings", () => {
    for (const u of [
      "",
      "no",
      "No thanks",
      "don't do it",
      "yes, but not the friday one",
      "not yet",
      "no, yes was wrong",
      "hayır",
      "Hayir, olmaz",
      "maybe",
      "which slots do you have?",
      "yesterday",
      "correction, the other one",
      "do not confirm",
    ]) {
      assert.equal(isAffirmative(u), false, `expected NOT affirmative: ${u}`);
    }
    assert.equal(isAffirmative(undefined), false);
    assert.equal(isAffirmative(null), false);
  });
  test("questions, cannot/can't, wait/hold on, and Turkish değil/yok/istemem are never a yes", () => {
    for (const u of [
      "Is that correct?",
      "Yes?",
      "Wait, is that right?",
      "Which one did you say, Friday? Correct?",
      "confirm what exactly?",
      "I cannot confirm that yet",
      "I can't confirm yet",
      "I can’t confirm yet",
      "hold on, yes was for the other order",
      "hang on, yes, the other one",
      "wait",
      "let me think... do it? no wait",
      "hmm, correct me if I'm wrong",
      "I'd rather you didn't, yes I said that",
      "please don't",
      "tamam değil",
      "tamam degil",
      "yok tamam istemem",
      "bekle, evet ama",
    ]) {
      assert.equal(isAffirmative(u), false, `expected NOT affirmative: ${u}`);
    }
    // A yes with a full stop, or with more words after it, still counts.
    assert.equal(isAffirmative("Yes."), true);
    assert.equal(isAffirmative("Yes, Friday afternoon, 1 to 6."), true);
    assert.equal(isAffirmative("Ok. And yes, go ahead with the Friday delivery."), true);
  });
});

describe("playbooks (pure)", () => {
  const vip: Customer = { id: "x", ref: "HM-0000", name: "V", phone: "+1", tier: "vip" };
  const std: Customer = { ...vip, tier: "standard" };
  test("registry has three scenarios and rejects unknown ones", () => {
    assert.deepEqual(
      playbooks.map((p) => p.scenario),
      ["reschedule", "damaged", "late"],
    );
    assert.throws(() => getPlaybook("refund" as never));
    for (const p of playbooks) {
      assert.ok(p.description.length > 20);
      assert.ok(p.toolOrder.includes("apply_resolution"));
    }
  });
  test("late: VIP eligible at 2 days, standard at 4, amount 15 + 10 per extra day, > 50 escalates", () => {
    assert.equal(compensationFor(2, "vip"), 15);
    assert.equal(compensationFor(1, "vip"), undefined);
    assert.equal(compensationFor(2, "standard"), undefined);
    assert.equal(compensationFor(4, "standard"), 15);
    assert.equal(compensationFor(5, "standard"), 25);
    assert.equal(compensationFor(9, "standard"), 65);
    const s = new Session();
    const order = findOrder(s.store, "HM-1010")!;
    const late = getPlaybook("late");
    const vip2 = late.options(order, vip, { today: today(), delayDays: 2 });
    assert.equal(vip2.length, 1);
    assert.equal(vip2[0].amountEur, 15);
    assert.equal(vip2[0].requiresEscalation, false);
    assert.deepEqual(late.options(order, std, { today: today(), delayDays: 2 }), []);
    assert.match(late.note!(order, std, { today: today(), delayDays: 2 }) ?? "", /4 days/);
    const big = late.options(order, std, { today: today(), delayDays: 9 });
    assert.equal(big[0].amountEur, 65);
    assert.equal(big[0].requiresEscalation, true);
    assert.match(big[0].escalationReason ?? "", /50/);
  });
  test("damaged: replacement when stock, refund otherwise, > 200 escalates", () => {
    const s = new Session();
    const damaged = getPlaybook("damaged");
    const ctx = { today: today(), delayDays: 0 };
    const lamp = damaged.options(findOrder(s.store, "HM-0977")!, vip, ctx);
    assert.equal(lamp.length, 1);
    assert.equal(lamp[0].type, "replacement");
    assert.equal(lamp[0].requiresEscalation, true);
    assert.match(lamp[0].escalationReason ?? "", /200/);
    const vase = damaged.options(findOrder(s.store, "HM-1031")!, std, ctx);
    assert.equal(vase[0].type, "refund");
    assert.equal(vase[0].amountEur, 45);
    assert.equal(vase[0].requiresEscalation, false);
    const cover = damaged.options(findOrder(s.store, "HM-1042")!, vip, ctx);
    assert.equal(cover[0].type, "replacement");
    assert.equal(cover[0].requiresEscalation, false);
  });
  test("reschedule: only processing orders get slot options", () => {
    const s = new Session();
    const reschedule = getPlaybook("reschedule");
    const ctx = { today: today(), delayDays: 0 };
    const opts = reschedule.options(findOrder(s.store, "HM-1042")!, vip, ctx);
    assert.equal(opts.length, 12);
    assert.ok(opts.some((o: ResolutionOption) => o.params.date === "2026-09-05" && o.params.window === "13-18"));
    assert.deepEqual(reschedule.options(findOrder(s.store, "HM-1010")!, std, ctx), []);
    assert.match(reschedule.note!(findOrder(s.store, "HM-1010")!, std, ctx) ?? "", /shipped/);
  });
});

describe("8-step demo scenario through the tools", () => {
  test("identify, reschedule with confirmation, topic switch to damaged lamp, escalate, return, idempotent retry", async () => {
    const { session, call } = harness();

    // 1. identify the customer by phone
    const found = await call("find_customer", { phone: "+49 30 1234567" });
    assert.equal(found.found, true);
    assert.equal(found.customer.name, "Anna Weber");
    assert.equal(found.customer.tier, "vip");
    assert.deepEqual(
      found.orders.map((o: Json) => o.id).sort(),
      ["HM-0977", "HM-1042"],
    );
    assert.equal(session.customer?.ref, "HM-2201");

    // 2. open the sofa cover order
    const order = await call("get_order", { orderId: "HM-1042" });
    assert.equal(order.order.status, "processing");
    assert.equal(order.order.delayDays, 0);
    assert.equal(order.order.customerTier, "vip");
    assert.equal(session.activeOrderId, "HM-1042");

    // 3. slots
    const slots = await call("get_delivery_slots", { orderId: "HM-1042" });
    assert.equal(slots.slots.length, 12);
    assert.ok(slots.slots.some((s: Json) => s.date === "2026-09-05" && s.window === "13-18"));

    // 4. propose Friday afternoon: no side effect yet
    const proposal = await call("apply_resolution", { ...RESCHEDULE_1042, customerConfirmed: false });
    assert.equal(proposal.status, "NEEDS_CONFIRMATION");
    assert.match(proposal.summary, /Friday 4 September 2026/);
    assert.equal(session.pending?.orderId, "HM-1042");
    assert.equal(session.applied.size, 0);
    assert.equal(findOrder(session.store, "HM-1042")!.promisedDeliveryDate, "2026-09-08");

    // 5. customer says yes: applied exactly once
    session.setLastUserUtterance("Yes, please go ahead.");
    const applied = await call("apply_resolution", { ...RESCHEDULE_1042, customerConfirmed: true });
    assert.equal(applied.status, "APPLIED");
    assert.match(applied.receipt, /^RCP-1042-001$/);
    assert.equal(session.applied.size, 1);
    assert.equal(session.pending, undefined);
    const updated = findOrder(session.store, "HM-1042")!;
    assert.equal(updated.promisedDeliveryDate, "2026-09-04");
    assert.equal(updated.deliveryWindow, "13-18");

    // 6. topic switch: the lamp arrived damaged
    session.setLastUserUtterance("Also, the floor lamp from my other order arrived damaged.");
    const lamp = await call("get_order", { orderId: "HM-0977" });
    assert.equal(lamp.order.totalEur, 240);
    const options = await call("check_resolution_options", { orderId: "HM-0977", issue: "damaged" });
    assert.equal(options.escalationRequired, true);
    assert.equal(options.options[0].requiresEscalation, true);
    const refused = await call("apply_resolution", { orderId: "HM-0977", type: "replacement", params: { sku: "LAMP-ARC-BRS" }, customerConfirmed: true });
    assert.equal(refused.status, "ESCALATION_REQUIRED");
    assert.equal(session.applied.size, 1);

    // 7. escalate, idempotent on order + reason
    const created = await call("escalate_case", { orderId: "HM-0977", reason: "Damaged item over EUR 200", details: { item: "Arc floor lamp, brass" } });
    assert.equal(created.status, "CREATED");
    assert.match(created.caseId, /^CASE-0977-01$/);
    const again = await call("escalate_case", { orderId: "HM-0977", reason: "damaged item over eur 200" });
    assert.equal(again.status, "ALREADY_OPEN");
    assert.equal(again.caseId, created.caseId);
    assert.equal(session.cases.length, 1);

    // 8. the model retries the reschedule: no double apply, ledger unchanged
    session.setLastUserUtterance("yes");
    const repeat = await call("apply_resolution", { ...RESCHEDULE_1042, customerConfirmed: true });
    assert.equal(repeat.status, "ALREADY_APPLIED");
    assert.equal(repeat.receipt, applied.receipt);
    assert.equal(session.applied.size, 1);
  });
});

describe("apply_resolution two-phase", () => {
  test("apply without pending returns NEEDS_CONFIRMATION even when the model claims confirmation", async () => {
    const { session, call } = harness();
    session.setLastUserUtterance("yes");
    const r = await call("apply_resolution", { ...RESCHEDULE_1042, customerConfirmed: true });
    assert.equal(r.status, "NEEDS_CONFIRMATION");
    assert.equal(session.applied.size, 0);
    assert.ok(session.pending);
  });
  test("pending but customer did not say yes: still NEEDS_CONFIRMATION", async () => {
    const { session, call } = harness();
    await call("apply_resolution", { ...RESCHEDULE_1042, customerConfirmed: false });
    session.setLastUserUtterance("hmm, what other slots are there?");
    const r = await call("apply_resolution", { ...RESCHEDULE_1042, customerConfirmed: true });
    assert.equal(r.status, "NEEDS_CONFIRMATION");
    assert.equal(session.applied.size, 0);
  });
  test("pending and yes but customerConfirmed false: NEEDS_CONFIRMATION", async () => {
    const { session, call } = harness();
    await call("apply_resolution", { ...RESCHEDULE_1042, customerConfirmed: false });
    session.setLastUserUtterance("yes");
    const r = await call("apply_resolution", { ...RESCHEDULE_1042, customerConfirmed: false });
    assert.equal(r.status, "NEEDS_CONFIRMATION");
    assert.equal(session.applied.size, 0);
  });
  test("apply after yes is applied once; repeat is ALREADY_APPLIED with the same receipt", async () => {
    const { session, call } = harness();
    await call("apply_resolution", { ...RESCHEDULE_1042, customerConfirmed: false });
    session.setLastUserUtterance("yes");
    const first = await call("apply_resolution", { ...RESCHEDULE_1042, customerConfirmed: true });
    assert.equal(first.status, "APPLIED");
    const second = await call("apply_resolution", { ...RESCHEDULE_1042, customerConfirmed: true });
    assert.equal(second.status, "ALREADY_APPLIED");
    assert.equal(second.receipt, first.receipt);
    // same action with the params in a different key order is the same key
    const third = await call("apply_resolution", { orderId: "HM-1042", type: "reschedule", params: { window: "13-18", date: "2026-09-04" }, customerConfirmed: true });
    assert.equal(third.status, "ALREADY_APPLIED");
    assert.equal(session.applied.size, 1);
  });
  test("a slot that was never offered is INVALID and never stored as pending", async () => {
    const { session, call } = harness();
    session.setLastUserUtterance("yes");
    const r = await call("apply_resolution", { orderId: "HM-1042", type: "reschedule", params: { date: "2026-09-06", window: "13-18" }, customerConfirmed: true });
    assert.equal(r.status, "INVALID");
    assert.match(r.reason, /not an offered option/);
    assert.equal(session.pending, undefined);
  });
});

describe("damaged order over EUR 200", () => {
  test("requiresEscalation and apply is blocked by the tool and by the guard", async () => {
    const { session, call } = harness();
    const options = await call("check_resolution_options", { orderId: "HM-0977", issue: "damaged" });
    assert.equal(options.escalationRequired, true);
    assert.equal(options.options[0].type, "replacement");
    session.setLastUserUtterance("yes");
    const args = { orderId: "HM-0977", type: "replacement", params: { sku: "LAMP-ARC-BRS" }, customerConfirmed: true };
    const viaTool = await call("apply_resolution", args);
    assert.equal(viaTool.status, "ESCALATION_REQUIRED");
    const guard = makeBeforeToolCall(session);
    const blocked = await guard(beforeCtx("apply_resolution", args));
    assert.equal(blocked?.block, true);
    assert.match(blocked?.reason ?? "", /^ESCALATION_REQUIRED/);
    assert.equal(session.applied.size, 0);
    assert.equal(session.pending, undefined);
  });
  test("damaged vase (stock 0, EUR 45) goes the refund path without escalation", async () => {
    const { session, call } = harness();
    const options = await call("check_resolution_options", { orderId: "HM-1031", issue: "damaged" });
    assert.equal(options.escalationRequired, false);
    assert.equal(options.options[0].type, "refund");
    assert.equal(options.options[0].amountEur, 45);
    await call("apply_resolution", { orderId: "HM-1031", type: "refund", params: { sku: "VASE-CER-SET" }, customerConfirmed: false });
    session.setLastUserUtterance("yes");
    const r = await call("apply_resolution", { orderId: "HM-1031", type: "refund", params: { sku: "VASE-CER-SET" }, customerConfirmed: true });
    assert.equal(r.status, "APPLIED");
    assert.match(r.summary, /EUR 45/);
  });
});

describe("late delivery", () => {
  test("standard 4 days late (HM-1010 today) is eligible for EUR 15", async () => {
    const { call } = harness();
    const r = await call("check_resolution_options", { orderId: "HM-1010", issue: "late" });
    assert.equal(r.delayDays, 4);
    assert.equal(r.options[0].type, "compensation");
    assert.equal(r.options[0].amountEur, 15);
    assert.equal(r.escalationRequired, false);
  });
  test("standard 2 days late is not eligible, VIP 2 days late is", async () => {
    process.env.NOW = "2026-09-01";
    const { call } = harness();
    const std = await call("check_resolution_options", { orderId: "HM-1010", issue: "late" });
    assert.equal(std.delayDays, 2);
    assert.deepEqual(std.options, []);
    assert.match(std.note, /4 days/);
    process.env.NOW = "2026-09-10";
    const vip = await call("check_resolution_options", { orderId: "HM-1042", issue: "late" });
    assert.equal(vip.delayDays, 2);
    assert.equal(vip.options[0].amountEur, 15);
  });
  test("compensation above EUR 50 requires escalation", async () => {
    process.env.NOW = "2026-09-08";
    const { session, call } = harness();
    const r = await call("check_resolution_options", { orderId: "HM-1010", issue: "late" });
    assert.equal(r.delayDays, 9);
    assert.equal(r.options[0].amountEur, 65);
    assert.equal(r.escalationRequired, true);
    session.setLastUserUtterance("yes");
    const apply = await call("apply_resolution", { orderId: "HM-1010", type: "compensation", params: { amountEur: 65 }, customerConfirmed: true });
    assert.equal(apply.status, "ESCALATION_REQUIRED");
    const wrongAmount = await call("apply_resolution", { orderId: "HM-1010", type: "compensation", params: { amountEur: 20 }, customerConfirmed: true });
    assert.equal(wrongAmount.status, "INVALID");
  });
  test("compensation amount passed as a string still matches the offered option", async () => {
    const { session, call } = harness();
    await call("apply_resolution", { orderId: "HM-1010", type: "compensation", params: { amountEur: "15" }, customerConfirmed: false });
    session.setLastUserUtterance("evet");
    const r = await call("apply_resolution", { orderId: "HM-1010", type: "compensation", params: { amountEur: 15 }, customerConfirmed: true });
    assert.equal(r.status, "APPLIED");
  });
});

describe("shipped order", () => {
  test("no delivery slots and reschedule cannot be applied", async () => {
    const { session, call } = harness();
    const slots = await call("get_delivery_slots", { orderId: "HM-1010" });
    assert.deepEqual(slots.slots, []);
    assert.match(slots.error, /already shipped/);
    session.setLastUserUtterance("yes");
    const r = await call("apply_resolution", { orderId: "HM-1010", type: "reschedule", params: FRIDAY, customerConfirmed: true });
    assert.equal(r.status, "INVALID");
    assert.match(r.reason, /shipped/);
  });
});

describe("topic switch", () => {
  test("pending reschedule for HM-1042 survives work on HM-0977 and applies when the customer returns to it", async () => {
    const { session, call } = harness();
    await call("find_customer", { customerRef: "HM-2201" });
    await call("get_order", { orderId: "HM-1042" });
    await call("get_delivery_slots", { orderId: "HM-1042" });
    const proposal = await call("apply_resolution", { ...RESCHEDULE_1042, customerConfirmed: false });
    assert.equal(proposal.status, "NEEDS_CONFIRMATION");
    const pendingKey = session.pending!.key;

    session.setLastUserUtterance("Wait, first: the lamp from HM-0977 is damaged.");
    await call("get_order", { orderId: "HM-0977" });
    await call("check_resolution_options", { orderId: "HM-0977", issue: "damaged" });
    await call("escalate_case", { orderId: "HM-0977", reason: "damaged item over EUR 200" });
    assert.equal(session.activeOrderId, "HM-0977");
    assert.equal(session.pending?.key, pendingKey, "pending action for the other order must be kept");

    session.setLastUserUtterance("Ok. And yes, go ahead with the Friday delivery.");
    const r = await call("apply_resolution", { ...RESCHEDULE_1042, customerConfirmed: true });
    assert.equal(r.status, "APPLIED");
    assert.equal(session.applied.size, 1);
    assert.equal(session.pending, undefined);
  });
  test("a second topic that yields its own proposal parks the first one instead of overwriting it", async () => {
    const { session, call } = harness();
    const COMP = { orderId: "HM-1010", type: "compensation", params: { amountEur: 15 } };
    const REFUND = { orderId: "HM-1031", type: "refund", params: { sku: "VASE-CER-SET" } };
    await call("find_customer", { customerRef: "HM-2305" });
    await call("get_order", { orderId: "HM-1010" });
    await call("check_resolution_options", { orderId: "HM-1010", issue: "late" });
    const p1 = await call("apply_resolution", { ...COMP, customerConfirmed: false });
    assert.equal(p1.status, "NEEDS_CONFIRMATION");
    const compKey = session.pending!.key;

    // topic switch: the vase set is broken; the model proposes the refund
    session.setLastUserUtterance("Wait, before that: the vase set from HM-1031 arrived broken.");
    await call("get_order", { orderId: "HM-1031" });
    await call("check_resolution_options", { orderId: "HM-1031", issue: "damaged" });
    const p2 = await call("apply_resolution", { ...REFUND, customerConfirmed: false });
    assert.equal(p2.status, "NEEDS_CONFIRMATION");
    assert.equal(session.pending?.key, p2.key, "the refund is the proposal asked last");
    assert.ok(session.proposals.has(compKey), "the compensation proposal is parked, not lost");
    assert.equal(session.proposals.size, 2);
    assert.deepEqual(session.parkedProposals().map((p) => p.key), [compKey]);

    session.setLastUserUtterance("Yes, do the refund.");
    const r2 = await call("apply_resolution", { ...REFUND, customerConfirmed: true });
    assert.equal(r2.status, "APPLIED");
    assert.equal(session.applied.size, 1);
    assert.ok(session.proposals.has(compKey), "parked proposal survives the other apply");
    assert.equal(session.pending, undefined, "nothing is current until the model asks again");

    // The customer volunteers a yes for the parked topic: it is not the proposal asked last,
    // so it is re-asked, never applied on that yes.
    session.setLastUserUtterance("And yes, go ahead with the 15 euro compensation too.");
    const r1 = await call("apply_resolution", { ...COMP, customerConfirmed: true });
    assert.equal(r1.status, "NEEDS_CONFIRMATION");
    assert.match(r1.why, /asked about last|not been put/);
    assert.equal(session.lastProposedKey, compKey, "re-asking makes it current again");
    assert.equal(session.applied.size, 1);

    session.setLastUserUtterance("yes");
    const r1b = await call("apply_resolution", { ...COMP, customerConfirmed: true });
    assert.equal(r1b.status, "APPLIED");
    assert.equal(session.applied.size, 2);
    assert.equal(session.proposals.size, 0);
    assert.equal(session.pending, undefined);
  });
});

describe("confirmation is bound to the customer's turn", () => {
  test("a proposal registered in the same utterance as the yes is not applied (yes to an unrelated question)", async () => {
    const { session, call } = harness();
    // The agent asked "Am I speaking with Anna Weber?"; the customer says yes; in that same
    // turn the model registers the Friday proposal and immediately re-issues it.
    session.setLastUserUtterance("yes");
    const first = await call("apply_resolution", { ...RESCHEDULE_1042, customerConfirmed: true });
    assert.equal(first.status, "NEEDS_CONFIRMATION");
    const second = await call("apply_resolution", { ...RESCHEDULE_1042, customerConfirmed: true });
    assert.equal(second.status, "NEEDS_CONFIRMATION");
    assert.match(second.why, /current turn/);
    assert.equal(session.applied.size, 0);
    assert.equal(findOrder(session.store, "HM-1042")!.promisedDeliveryDate, "2026-09-08");
    assert.equal(session.pending?.proposedTurn, 1);
    // guard agrees with the tool
    const guard = applyResolutionBlockReason(session, { ...RESCHEDULE_1042, customerConfirmed: true } as never);
    assert.match(guard ?? "", /^NEEDS_CONFIRMATION: this proposal was registered during the current turn/);
    // the next utterance is a real answer to the proposal
    session.setLastUserUtterance("yes");
    const third = await call("apply_resolution", { ...RESCHEDULE_1042, customerConfirmed: true });
    assert.equal(third.status, "APPLIED");
    assert.equal(session.applied.size, 1);
  });
  test("one yes applies at most one action; a second proposal in the same turn waits for its own yes", async () => {
    const { session, call } = harness();
    const SATURDAY = { orderId: "HM-1042", type: "reschedule", params: { date: "2026-09-05", window: "09-13" } };
    await call("apply_resolution", { ...RESCHEDULE_1042, customerConfirmed: false });
    session.setLastUserUtterance("yes");
    const friday = await call("apply_resolution", { ...RESCHEDULE_1042, customerConfirmed: true });
    assert.equal(friday.status, "APPLIED");
    assert.equal(session.lastAppliedSeq, session.utteranceSeq);
    const satProposal = await call("apply_resolution", { ...SATURDAY, customerConfirmed: true });
    assert.equal(satProposal.status, "NEEDS_CONFIRMATION");
    const satAgain = await call("apply_resolution", { ...SATURDAY, customerConfirmed: true });
    assert.equal(satAgain.status, "NEEDS_CONFIRMATION");
    assert.equal(session.applied.size, 1);
    assert.deepEqual([...session.applied.keys()], ['reschedule:HM-1042:{"date":"2026-09-04","window":"13-18"}']);
    assert.equal(findOrder(session.store, "HM-1042")!.promisedDeliveryDate, "2026-09-04");
    assert.equal(session.pending?.params.date, "2026-09-05", "Saturday is registered and waiting for its own yes");
    session.setLastUserUtterance("yes");
    const sat = await call("apply_resolution", { ...SATURDAY, customerConfirmed: true });
    assert.equal(sat.status, "APPLIED");
    assert.equal(session.applied.size, 2);
  });
  test("re-proposing the current key keeps its turn stamp, so a re-propose right after the yes does not cost an extra round", async () => {
    const { session, call } = harness();
    await call("apply_resolution", { ...RESCHEDULE_1042, customerConfirmed: false });
    const stamp = session.pending!.proposedTurn;
    session.setLastUserUtterance("what other slots are there?");
    await call("apply_resolution", { ...RESCHEDULE_1042, customerConfirmed: false });
    assert.equal(session.pending!.proposedTurn, stamp);
    session.setLastUserUtterance("yes");
    await call("apply_resolution", { ...RESCHEDULE_1042, customerConfirmed: false });
    const r = await call("apply_resolution", { ...RESCHEDULE_1042, customerConfirmed: true });
    assert.equal(r.status, "APPLIED");
  });
  test("setLastUserUtterance bumps utteranceSeq and reset clears proposals and the sequence", () => {
    const s = new Session();
    assert.equal(s.utteranceSeq, 0);
    s.setLastUserUtterance("hi");
    s.setLastUserUtterance("yes");
    assert.equal(s.utteranceSeq, 2);
    s.setProposal({ key: "k", type: "refund", orderId: "HM-1031", params: {}, summary: "x", proposedAt: 0, proposedTurn: 2 });
    assert.equal(s.pending?.key, "k");
    assert.equal(s.snapshot().proposals.length, 1);
    s.reset();
    assert.equal(s.utteranceSeq, 0);
    assert.equal(s.pending, undefined);
    assert.equal(s.proposals.size, 0);
    assert.equal(s.lastAppliedSeq, undefined);
  });
});

describe("guards", () => {
  test("premature apply is blocked with NEEDS_CONFIRMATION, stores the proposal and logs the block", async () => {
    const session = new Session();
    const before = makeBeforeToolCall(session);
    const args = { ...RESCHEDULE_1042, customerConfirmed: true };
    const r = await before(beforeCtx("apply_resolution", args));
    assert.equal(r?.block, true);
    assert.match(r?.reason ?? "", /^NEEDS_CONFIRMATION/);
    assert.match(r?.reason ?? "", /Friday 4 September 2026/);
    assert.equal(session.pending?.orderId, "HM-1042");
    assert.equal(session.applied.size, 0);
    assert.equal(session.toolLog.length, 1);
    assert.equal(session.toolLog[0].tool, "apply_resolution");
    assert.equal(session.toolLog[0].ok, false);
    assert.match(session.toolLog[0].blocked ?? "", /NEEDS_CONFIRMATION/);
  });
  test("allowed after an explicit yes, blocked as ALREADY_APPLIED once in the ledger", async () => {
    const { session, call } = harness();
    const before = makeBeforeToolCall(session);
    const args = { ...RESCHEDULE_1042, customerConfirmed: true };
    await before(beforeCtx("apply_resolution", args));
    session.setLastUserUtterance("no, not yet");
    assert.equal((await before(beforeCtx("apply_resolution", args)))?.block, true);
    session.setLastUserUtterance("yes");
    assert.equal(await before(beforeCtx("apply_resolution", args)), undefined);
    const applied = await call("apply_resolution", args);
    assert.equal(applied.status, "APPLIED");
    const blocked = await before(beforeCtx("apply_resolution", args));
    assert.equal(blocked?.block, true);
    assert.match(blocked?.reason ?? "", /^ALREADY_APPLIED/);
    assert.match(blocked?.reason ?? "", new RegExp(applied.receipt));
    assert.equal(applyResolutionBlockReason(session, args as never)?.startsWith("ALREADY_APPLIED"), true);
  });
  test("escalate_case is blocked as ALREADY_APPLIED when the case exists; other tools pass through", async () => {
    const { session, call } = harness();
    const before = makeBeforeToolCall(session);
    const args = { orderId: "HM-0977", reason: "Damaged item over EUR 200" };
    assert.equal(await before(beforeCtx("escalate_case", args)), undefined);
    const created = await call("escalate_case", args);
    const blocked = await before(beforeCtx("escalate_case", { ...args, reason: "damaged item over eur 200" }));
    assert.equal(blocked?.block, true);
    assert.match(blocked?.reason ?? "", new RegExp(`^ALREADY_APPLIED.*${created.caseId}`));
    // A reworded reason for the same order (a retry after an abort, or a rephrase) is the same case.
    const reworded = { orderId: "hm-0977", reason: "damaged floor lamp, order total above 200 EUR" };
    const blockedReworded = await before(beforeCtx("escalate_case", reworded));
    assert.equal(blockedReworded?.block, true);
    assert.match(blockedReworded?.reason ?? "", new RegExp(`^ALREADY_APPLIED.*${created.caseId}`));
    const viaTool = await call("escalate_case", reworded);
    assert.equal(viaTool.status, "ALREADY_OPEN");
    assert.equal(viaTool.caseId, created.caseId);
    assert.equal(session.cases.length, 1);
    // A different order still gets its own case.
    assert.equal(await before(beforeCtx("escalate_case", { orderId: "HM-1042", reason: "tool failure" })), undefined);
    assert.equal(await before(beforeCtx("get_order", { orderId: "HM-0977" })), undefined);
    assert.equal(await before(beforeCtx("find_customer", { customerRef: "HM-2201" })), undefined);
  });
  test("escalate_case for an unknown order opens no case: the tool answers found false and the guard blocks", async () => {
    const { session, call } = harness();
    const before = makeBeforeToolCall(session);
    const args = { orderId: "HM-9999", reason: "x" };
    const blocked = await before(beforeCtx("escalate_case", args));
    assert.equal(blocked?.block, true);
    assert.match(blocked?.reason ?? "", /^BLOCKED: No order HM-9999/);
    const r = await call("escalate_case", args);
    assert.equal(r.found, false);
    assert.equal(r.status, undefined);
    assert.equal(r.caseId, undefined);
    assert.match(r.message, /No order HM-9999/);
    assert.equal(session.cases.length, 0);
    assert.equal(session.toolLog.filter((e) => e.tool === "escalate_case" && e.blocked).length, 1);
    // A known id in any case still opens one case, under the canonical order id.
    assert.equal(await before(beforeCtx("escalate_case", { orderId: "hm-0977", reason: "damaged" })), undefined);
    const ok = await call("escalate_case", { orderId: "hm-0977", reason: "damaged" });
    assert.equal(ok.status, "CREATED");
    assert.equal(ok.orderId, "HM-0977");
    assert.equal(ok.caseId, "CASE-0977-01");
    assert.equal(session.cases.length, 1);
  });
  test("afterToolCall appends ok entries with measured ms", async () => {
    const session = new Session();
    const before = makeBeforeToolCall(session);
    const after = makeAfterToolCall(session);
    const ctx = beforeCtx("get_order", { orderId: "HM-1042" }, "call-7");
    await before(ctx);
    const afterCtx: AfterToolCallContext = { ...ctx, result: { content: [{ type: "text", text: "{}" }], details: {} }, isError: false };
    assert.equal(await after(afterCtx), undefined);
    assert.equal(session.toolLog.length, 1);
    assert.equal(session.toolLog[0].tool, "get_order");
    assert.equal(session.toolLog[0].ok, true);
    assert.equal(typeof session.toolLog[0].ms, "number");
    assert.ok(session.toolLog[0].ms >= 0);
    assert.equal(session.toolStarts.size, 0);
    const failed = await after({ ...afterCtx, isError: true });
    assert.equal(failed, undefined);
    assert.equal(session.toolLog[1].ok, false);
  });
});

describe("simulated failures", () => {
  test("params.simulateFailure makes the tool throw", async () => {
    const { call } = harness();
    await assert.rejects(
      call("apply_resolution", { ...RESCHEDULE_1042, params: { ...FRIDAY, simulateFailure: true }, customerConfirmed: false }),
      /Simulated failure in apply_resolution/,
    );
    await assert.rejects(call("get_order", { orderId: "HM-1042", simulateFailure: true }), /Simulated failure in get_order/);
  });
  test("FAIL_TOOL env makes that tool throw and leaves the others alone", async () => {
    process.env.FAIL_TOOL = "get_delivery_slots";
    const { call } = harness();
    await assert.rejects(call("get_delivery_slots", { orderId: "HM-1042" }), /Simulated failure/);
    const r = await call("get_order", { orderId: "HM-1042" });
    assert.equal(r.found, true);
  });
});

describe("date labels (one helper, every dated tool result)", () => {
  test("humanDate pins 2026-09-08 to Tuesday and 2026-09-04 to Friday", () => {
    assert.equal(humanDate("2026-09-08"), "Tuesday 8 September 2026");
    assert.equal(humanDate("2026-09-04"), "Friday 4 September 2026");
    assert.equal(humanDate(today()), "Thursday 3 September 2026");
    assert.equal(humanDate("2026-08-30"), "Sunday 30 August 2026");
    assert.equal(humanDate(new Date("2026-09-06T23:59:00Z")), "Sunday 6 September 2026");
    // A Date is read by its UTC parts, whatever the process zone: UTC-built Dates label their UTC day.
    assert.equal(humanDate(new Date(Date.UTC(2026, 8, 8, 12, 30))), "Tuesday 8 September 2026");
    assert.equal(isoDate(new Date(Date.UTC(2026, 8, 8, 23, 59))), "2026-09-08");
    assert.throws(() => humanDate("not a date"), /Invalid date/);
  });
  test("find_customer, get_order, get_delivery_slots, apply_resolution and the late playbook carry labels", async () => {
    const { session, call } = harness();
    const found = await call("find_customer", { customerRef: "HM-2201" });
    assert.equal(found.mostRecentOrderId, "HM-1042");
    assert.deepEqual(
      found.orders.map((o: Json) => o.id),
      ["HM-1042", "HM-0977"],
      "most recent first",
    );
    assert.deepEqual(found.orders[1].items, ["Arc floor lamp, brass"]);
    assert.equal(found.orders[0].promisedDeliveryDateLabel, "Tuesday 8 September 2026");
    assert.equal(found.orders[1].deliveredAtLabel, "Friday 28 August 2026");

    const order = await call("get_order", { orderId: "HM-1042" });
    assert.equal(order.todayLabel, "Thursday 3 September 2026");
    assert.equal(order.order.promisedDeliveryDateLabel, "Tuesday 8 September 2026");
    assert.equal(order.order.placedAtLabel, "Tuesday 1 September 2026");
    assert.equal(order.order.deliveredAtLabel, undefined);
    const lamp = await call("get_order", { orderId: "HM-0977" });
    assert.equal(lamp.order.deliveredAtLabel, "Friday 28 August 2026");

    const slots = await call("get_delivery_slots", { orderId: "HM-1042" });
    assert.equal(slots.currentDeliveryDateLabel, "Tuesday 8 September 2026");
    assert.equal(slots.slots[0].label, "Friday 4 September 2026");
    assert.ok(slots.slots.every((s: Json) => s.label === humanDate(s.date) && s.label.startsWith(s.weekday)));

    const morning = { orderId: "HM-1042", type: "reschedule", params: { date: "2026-09-04", window: "09-13" } };
    const proposal = await call("apply_resolution", { ...morning, customerConfirmed: false });
    assert.equal(proposal.status, "NEEDS_CONFIRMATION");
    assert.equal(proposal.date, "2026-09-04");
    assert.equal(proposal.dateLabel, "Friday 4 September 2026");
    assert.equal(proposal.summary, "Move the delivery of order HM-1042 to Friday 4 September 2026, in the morning, 9 to 1.");
    session.setLastUserUtterance("yes");
    const applied = await call("apply_resolution", { ...morning, customerConfirmed: true });
    assert.equal(applied.status, "APPLIED");
    assert.equal(applied.dateLabel, "Friday 4 September 2026");
    const again = await call("apply_resolution", { ...morning, customerConfirmed: true });
    assert.equal(again.status, "ALREADY_APPLIED");
    assert.equal(again.dateLabel, "Friday 4 September 2026");
    assert.equal(again.receipt, applied.receipt);

    const late = await call("check_resolution_options", { orderId: "HM-1010", issue: "late" });
    assert.equal(late.promisedDeliveryDateLabel, "Sunday 30 August 2026");
    assert.equal(late.asOfLabel, "Thursday 3 September 2026");
    assert.match(late.options[0].label, /promised for Sunday 30 August 2026, 4 days late as of Thursday 3 September 2026/);
    process.env.NOW = "2026-09-01";
    const early = await call("check_resolution_options", { orderId: "HM-1010", issue: "late" });
    assert.equal(early.asOfLabel, "Tuesday 1 September 2026");
    assert.match(early.note, /promised for Sunday 30 August 2026, 2 days late as of Tuesday 1 September 2026/);
    assert.doesNotMatch(early.note, /2026-08-30/, "no bare ISO date in the spoken note");
  });
  test("escalate_case returns the next step the customer is told", async () => {
    const { call } = harness();
    const created = await call("escalate_case", { orderId: "HM-0977", reason: "damaged item over EUR 200" });
    assert.equal(created.nextStep, ESCALATION_NEXT_STEP);
    assert.match(created.nextStep, /one business day/);
    const open = await call("escalate_case", { orderId: "HM-0977", reason: "again" });
    assert.equal(open.status, "ALREADY_OPEN");
    assert.equal(open.nextStep, ESCALATION_NEXT_STEP);
  });
});

describe("playbook registry drives the scenario union and the tools", () => {
  function issueLiterals(session: Session): string[] {
    const tool = createTools(session).find((t) => t.name === "check_resolution_options")!;
    const schema = tool.parameters as unknown as { properties: { issue: { anyOf: Array<{ const: string }> } } };
    return schema.properties.issue.anyOf.map((l) => l.const);
  }
  test("scenarios, the issue schema and the action lookup derive from the live registry; the example is not live", async () => {
    assert.deepEqual(scenarios, ["reschedule", "damaged", "late"]);
    assert.deepEqual(issueLiterals(new Session()), ["reschedule", "damaged", "late"]);
    assert.equal(isScenario("wrong_item"), false);
    assert.equal(isScenario("damaged"), true);
    assert.throws(() => getPlaybook("wrong_item"), /Unknown scenario: wrong_item. Known: reschedule, damaged, late/);
    assert.deepEqual(playbooksForAction("replacement").map((p) => p.scenario), ["damaged"]);
    assert.deepEqual(playbooksForAction("reschedule").map((p) => p.scenario), ["reschedule"]);
    assert.deepEqual(playbooksForAction("compensation").map((p) => p.scenario), ["late"]);
    const { call } = harness();
    const r = await call("check_resolution_options", { orderId: "HM-1031", issue: "wrong_item" });
    assert.equal(r.found, false);
    assert.match(r.message, /Known issues: reschedule, damaged, late/);
    assert.doesNotMatch(buildSystemPrompt(new Session()), /wrong_item/);
  });
  test("the example wrong_item playbook is served from a scratch registry with no other edit", async () => {
    const registry = [...playbooks, wrongItemPlaybook];
    const session = new Session({ playbooks: registry });
    const { call } = harness(session);
    assert.deepEqual(issueLiterals(session), ["reschedule", "damaged", "late", "wrong_item"]);
    assert.equal(isScenario("wrong_item", registry), true);
    assert.deepEqual(playbooksForAction("refund", registry).map((p) => p.scenario), ["damaged", "wrong_item"]);

    const vase = await call("check_resolution_options", { orderId: "HM-1031", issue: "wrong_item" });
    assert.equal(vase.found, true);
    assert.equal(vase.issue, "wrong_item");
    assert.equal(vase.options.length, 1);
    assert.equal(vase.options[0].type, "refund");
    assert.equal(vase.options[0].amountEur, 45);
    assert.match(vase.options[0].label, /collect the wrong item/);
    assert.equal(vase.escalationRequired, false);
    assert.equal(session.activeOrderId, "HM-1031");

    const lamp = await call("check_resolution_options", { orderId: "HM-0977", issue: "wrong_item" });
    assert.equal(lamp.options[0].type, "replacement");
    assert.equal(lamp.options[0].requiresEscalation, true);
    assert.equal(lamp.escalationRequired, true);
    assert.match(lamp.options[0].escalationReason, /200/);

    const cover = await call("check_resolution_options", { orderId: "HM-1042", issue: "wrong_item" });
    assert.match(cover.note, /not delivered yet/);

    // The playbook's refund is applied through the normal two-phase path.
    const refund = { orderId: "HM-1031", type: "refund", params: { sku: "VASE-CER-SET" } };
    const p = await call("apply_resolution", { ...refund, customerConfirmed: false });
    assert.equal(p.status, "NEEDS_CONFIRMATION");
    session.setLastUserUtterance("yes");
    const a = await call("apply_resolution", { ...refund, customerConfirmed: true });
    assert.equal(a.status, "APPLIED");
    assert.equal(session.applied.size, 1);

    // The model sees it in its prompt, the live registry is untouched.
    assert.match(buildSystemPrompt(session), /^wrong_item: Wrong item delivered/m);
    assert.deepEqual(scenarios, ["reschedule", "damaged", "late"]);
    assert.equal(playbooks.length, 3);
    assert.deepEqual(issueLiterals(new Session()), ["reschedule", "damaged", "late"]);
  });
  test("two playbooks offering the same option: the one that requires escalation decides, whatever the registry order", async () => {
    // A wrong_item variant that escalates above EUR 40, so the EUR 45 vase refund is fine for damaged but not for it.
    const strictWrongItem: Playbook<"wrong_item_strict"> = {
      ...wrongItemPlaybook,
      scenario: "wrong_item_strict",
      description: "Wrong item delivered, strict: an order total above EUR 40 must be escalated to a human.",
      options(order, customer, ctx) {
        const requiresEscalation = order.totalEur > 40;
        return wrongItemPlaybook.options(order, customer, ctx).map((o) => ({
          ...o,
          requiresEscalation,
          ...(requiresEscalation ? { escalationReason: `Order total EUR ${order.totalEur} is above the EUR 40 limit for wrong items.` } : {}),
        }));
      },
    };
    const refund = { orderId: "HM-1031", type: "refund" as const, params: { sku: "VASE-CER-SET" } };
    for (const registry of [
      [damagedPlaybook, strictWrongItem],
      [strictWrongItem, damagedPlaybook],
    ]) {
      const session = new Session({ playbooks: registry });
      const { call } = harness(session);
      const lenient = await call("check_resolution_options", { orderId: "HM-1031", issue: "damaged" });
      assert.equal(lenient.escalationRequired, false);
      const strict = await call("check_resolution_options", { orderId: "HM-1031", issue: "wrong_item_strict" });
      assert.equal(strict.escalationRequired, true);
      assert.equal(strict.options[0].type, "refund");

      // The tool: the escalating playbook's answer, nothing stored, before and after a yes.
      const proposal = await call("apply_resolution", { ...refund, customerConfirmed: false });
      assert.equal(proposal.status, "ESCALATION_REQUIRED");
      assert.match(proposal.reason, /EUR 40/);
      assert.equal(session.pending, undefined);
      session.setLastUserUtterance("yes");
      const applied = await call("apply_resolution", { ...refund, customerConfirmed: true });
      assert.equal(applied.status, "ESCALATION_REQUIRED");
      assert.equal(session.applied.size, 0);

      // The guard agrees with the tool.
      const why = applyResolutionBlockReason(session, { ...refund, customerConfirmed: true });
      assert.match(why ?? "", /^ESCALATION_REQUIRED: .*EUR 40/);
      const blocked = await makeBeforeToolCall(session)(beforeCtx("apply_resolution", { ...refund, customerConfirmed: true }));
      assert.equal(blocked?.block, true);
      assert.equal(session.applied.size, 0);
      assert.equal(session.pending, undefined);

      // The resolution names the deciding playbook and every playbook that offered the option.
      const resolved = resolveAction(session, refund.orderId, refund.type, refund.params);
      assert.equal(resolved.ok, true);
      if (resolved.ok) {
        assert.equal(resolved.option.requiresEscalation, true);
        assert.equal(resolved.scenario, "wrong_item_strict");
        assert.deepEqual(resolved.scenarios, registry.map((p) => p.scenario));
      }
    }

    // Control: the same two playbooks without the stricter limit apply the refund once (registry [damaged, wrong_item]).
    const session = new Session({ playbooks: [damagedPlaybook, wrongItemPlaybook] });
    const { call } = harness(session);
    assert.equal((await call("apply_resolution", { ...refund, customerConfirmed: false })).status, "NEEDS_CONFIRMATION");
    session.setLastUserUtterance("yes");
    assert.equal((await call("apply_resolution", { ...refund, customerConfirmed: true })).status, "APPLIED");
    assert.equal(session.applied.size, 1);
    const resolved = resolveAction(session, refund.orderId, refund.type, refund.params);
    assert.ok(resolved.ok && resolved.scenario === "damaged" && resolved.scenarios.join(",") === "damaged,wrong_item");
  });
  test("a registry with a duplicate scenario is rejected at session creation", () => {
    assert.throws(() => new Session({ playbooks: [...playbooks, damagedPlaybook] }), /Duplicate scenario in playbook registry: damaged/);
  });
  test("an empty registry is rejected at session creation", () => {
    assert.throws(() => new Session({ playbooks: [] }), /Playbook registry is empty/);
  });
});

describe("spoken text hygiene (code, not prompt)", () => {
  test("sanitizeSpoken replaces every dash with a comma and digit ranges with 'to'", () => {
    assert.equal(sanitizeSpoken("Friday — the 4th of September"), "Friday, the 4th of September");
    assert.equal(sanitizeSpoken("Friday—morning"), "Friday, morning");
    assert.equal(sanitizeSpoken("between 9–13"), "between 9 to 13");
    assert.equal(sanitizeSpoken("wait - yes"), "wait, yes");
    assert.equal(sanitizeSpoken("one -- two"), "one, two");
    assert.equal(sanitizeSpoken("end —"), "end, ");
    assert.equal(sanitizeSpoken(""), "");
  });
  test("hyphens in codes, windows, compounds and negative numbers are untouched", () => {
    for (const s of ["HM-1042", "09-13 or 13-18", "well-known", "it is -5 degrees", "RCP-1042-001", "find_customer -> get_order"]) {
      assert.equal(sanitizeSpoken(s), s);
      assert.equal(hasDash(s), false, s);
    }
    assert.equal(hasDash("a — b"), true);
    assert.equal(hasDash("a – b"), true);
    assert.equal(hasDash("a - b"), true);
    assert.equal(hasDash("a -- b"), true);
  });
});

describe("system prompt", () => {
  test("today carries its weekday label and the rules cover weekdays, dashes, matching, receipts and next steps", () => {
    const p = buildSystemPrompt(new Session());
    assert.match(p, /Today is Thursday 3 September 2026\./);
    assert.match(p, /Never work out a weekday yourself/);
    assert.match(p, /No dashes of any kind/);
    assert.match(p, /match it to the orders in the live state yourself/);
    assert.match(p, /Ask which order only when two known orders genuinely fit/);
    assert.match(p, /read the receipt once/);
    assert.match(p, /always call apply_resolution with the same params before answering/);
    assert.match(p, /Never say it is done from memory/);
    assert.match(p, /who follows up and when/);
    assert.match(p, /at most two short sentences before it/);
    assert.equal(hasDash(p), false, "the prompt itself contains no dash");
    assert.ok(p.length < 5000, `prompt is ${p.length} chars`);
    for (const pb of playbooks) assert.match(p, new RegExp(`^${pb.scenario}: `, "m"));
  });
  test("the state block lists item names and labelled dates, most recent order first", async () => {
    const { session, call } = harness();
    assert.match(buildStateBlock(session), /Orders known \(most recent first\): none/);
    await call("find_customer", { customerRef: "HM-2201" });
    const block = buildStateBlock(session);
    assert.match(block, /HM-1042 \(Linen sofa cover, grey\) processing, promised Tuesday 8 September 2026, EUR 89; HM-0977 \(Arc floor lamp, brass\) delivered Friday 28 August 2026, EUR 240/);
    assert.doesNotMatch(block, /2026-09-08/, "no bare ISO dates for the model to compute a weekday from");
    await call("apply_resolution", { orderId: "HM-1042", type: "reschedule", params: { date: "2026-09-04", window: "09-13" }, customerConfirmed: false });
    session.setLastUserUtterance("yes");
    await call("apply_resolution", { orderId: "HM-1042", type: "reschedule", params: { date: "2026-09-04", window: "09-13" }, customerConfirmed: true });
    assert.match(buildStateBlock(session), /HM-1042 \(Linen sofa cover, grey\) processing, promised Friday 4 September 2026 09-13, EUR 89/);
    assert.match(buildStateBlock(session), /Applied actions: Move the delivery of order HM-1042 to Friday 4 September 2026, in the morning, 9 to 1\. \(receipt RCP-1042-001\)/);
  });
});

describe("demo script evaluators", () => {
  function snap(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
    return {
      id: "s",
      lang: "en",
      customer: { id: "CUST-001", ref: "HM-2201", name: "Anna Weber", phone: "+49 30 1234567", tier: "vip" },
      proposals: [],
      applied: [],
      cases: [],
      toolLog: [],
      lastUserUtterance: "",
      utteranceSeq: 1,
      ...over,
    };
  }
  const APPLIED_1042 = { key: "k", type: "reschedule" as const, orderId: "HM-1042", params: { date: "2026-09-04", window: "09-13" }, appliedAt: 1, receipt: "RCP-1042-001" };
  const CASE_0977 = { id: "CASE-0977-01", orderId: "HM-0977", reason: "damaged", details: {}, createdAt: 1 };
  const PENDING_FRI = { key: "k", type: "reschedule" as const, orderId: "HM-1042", params: { date: "2026-09-04", window: "09-13" }, summary: "Move it", proposedAt: 1, proposedTurn: 1 };
  function turn(step: number, over: Partial<TurnRecord> = {}): TurnRecord {
    return { step, user: "u", extra: false, text: "", tools: [], state: snap(), firstTokenMs: 500, totalMs: 1500, errors: [], ...over };
  }
  const t = (name: string, over: Partial<ToolSeen> = {}): ToolSeen => ({ name, phase: "end", ...over });
  const step = (n: number): DemoStep => DEMO_STEPS.find((s) => s.n === n)!;

  test("weekdayMismatches catches the wrong weekday the model computed, in both date orders", () => {
    assert.deepEqual(weekdayMismatches("It arrives Monday the 8th of September."), ['"Monday the 8th of September" is a Tuesday']);
    assert.deepEqual(weekdayMismatches("Tuesday 8 September 2026 and Friday 4 September"), []);
    assert.deepEqual(weekdayMismatches("Friday, September 4th at 9"), []);
    assert.deepEqual(weekdayMismatches("Thursday, September 4"), ['"Thursday, September 4" is a Friday']);
    assert.deepEqual(weekdayMismatches("Wednesday 4 September 2024"), []);
    assert.deepEqual(weekdayMismatches("Friday is fine, 4 September works"), [], "a weekday without a date is not checked");
  });
  test("applyStatus reads the guard prefix when blocked and the JSON status when executed", () => {
    assert.equal(applyStatus(t("apply_resolution", { phase: "blocked", detail: "ALREADY_APPLIED: this was already done (receipt RCP-1042-001)" })), "ALREADY_APPLIED");
    assert.equal(applyStatus(t("apply_resolution", { detail: '{"status":"APPLIED","receipt":"RCP-1042-001"}' })), "APPLIED");
    assert.equal(applyStatus(t("apply_resolution", { phase: "start" })), undefined);
    assert.equal(applyStatus(t("get_order")), undefined);
    assert.equal(phaseFromResult("NEEDS_CONFIRMATION: ask them", true), "blocked");
    assert.equal(phaseFromResult("Simulated failure", true), "end");
    assert.equal(phaseFromResult('{"status":"APPLIED"}', false), "end");
  });
  test("mergeToolEvent joins a start with its end by name", () => {
    const tools: ToolSeen[] = [];
    mergeToolEvent(tools, { name: "get_order", phase: "start", args: { orderId: "HM-0977" } });
    mergeToolEvent(tools, { name: "apply_resolution", phase: "start", args: { orderId: "HM-1042" } });
    mergeToolEvent(tools, { name: "apply_resolution", phase: "blocked", detail: "NEEDS_CONFIRMATION: x" });
    mergeToolEvent(tools, { name: "get_order", phase: "end", detail: "{}", ms: 3 });
    assert.equal(tools.length, 2);
    assert.equal(tools[0].phase, "end");
    assert.equal(tools[0].ms, 3);
    assert.equal(tools[1].phase, "blocked");
    assert.deepEqual(tools[1].args, { orderId: "HM-1042" });
  });
  test("step 8 fails when the retry never reaches ALREADY_APPLIED and passes when it does with the ledger unchanged", () => {
    const noCall = step(8).evaluate([turn(8, { text: "Yes it went through.", state: snap({ applied: [APPLIED_1042] }) })], []);
    assert.equal(noCall.verdict, "FAIL");
    assert.match(noCall.notes[0], /ALREADY_APPLIED path not exercised/);
    const good = step(8).evaluate(
      [
        turn(8, {
          text: "Already booked, receipt RCP-1042-001.",
          tools: [t("apply_resolution", { phase: "blocked", args: { orderId: "HM-1042" }, detail: "ALREADY_APPLIED: done (receipt RCP-1042-001)" })],
          state: snap({ applied: [APPLIED_1042] }),
        }),
      ],
      [],
    );
    assert.equal(good.verdict, "PASS");
    const grew = step(8).evaluate([turn(8, { tools: [t("apply_resolution", { detail: '{"status":"APPLIED"}' })], state: snap({ applied: [APPLIED_1042, { ...APPLIED_1042, key: "k2" }] }) })], []);
    assert.equal(grew.verdict, "FAIL");
    assert.match(grew.notes[0], /ledger has 2/);
  });
  test("step 4 fails on any apply_resolution and warns when the policy was not consulted", () => {
    const chain = [
      t("get_order", { args: { orderId: "HM-0977" } }),
      t("check_resolution_options", { args: { orderId: "HM-0977", issue: "damaged" } }),
      t("escalate_case", { args: { orderId: "HM-0977" }, detail: '{"status":"CREATED","caseId":"CASE-0977-01"}' }),
    ];
    const good = step(4).evaluate([turn(3, { text: "A colleague will call you back within one business day, case CASE-0977-01.", tools: chain, state: snap({ cases: [CASE_0977] }) })], []);
    assert.equal(good.verdict, "PASS", good.notes.join("; "));
    const applied = step(4).evaluate([turn(3, { tools: [...chain, t("apply_resolution", { phase: "blocked", detail: "ESCALATION_REQUIRED: x" })], state: snap({ cases: [CASE_0977] }) })], []);
    assert.equal(applied.verdict, "FAIL");
    const unchecked = step(4).evaluate([turn(3, { text: "Case CASE-0977-01, a colleague calls you.", tools: [chain[0], chain[2]], state: snap({ cases: [CASE_0977] }) })], []);
    assert.equal(unchecked.verdict, "WARN");
    assert.match(unchecked.notes.join(" "), /without check_resolution_options/);
    const asked = step(4).evaluate([turn(3, { text: "Shall I open a case?", tools: [chain[0], chain[1]], state: snap() })], []);
    assert.equal(asked.verdict, "FAIL");
    assert.equal(asked.extra, "Yes, please do.");
  });
  test("step 7 needs exactly one APPLIED with the receipt read back once", () => {
    const applied = t("apply_resolution", { args: { orderId: "HM-1042" }, detail: '{"status":"APPLIED","receipt":"RCP-1042-001"}' });
    const good = step(7).evaluate([turn(7, { text: "Done, receipt RCP-1042-001.", tools: [applied], state: snap({ applied: [APPLIED_1042] }) })], []);
    assert.equal(good.verdict, "PASS");
    const silent = step(7).evaluate([turn(7, { text: "Done.", tools: [applied], state: snap({ applied: [APPLIED_1042] }) })], []);
    assert.equal(silent.verdict, "WARN");
    assert.match(silent.notes[0], /not read back/);
    const twice = step(7).evaluate([turn(7, { text: "RCP-1042-001, that is RCP-1042-001.", tools: [applied], state: snap({ applied: [APPLIED_1042] }) })], []);
    assert.equal(twice.verdict, "WARN");
    const reasked = step(7).evaluate([turn(7, { text: "Shall I?", tools: [t("apply_resolution", { phase: "blocked", detail: "NEEDS_CONFIRMATION: x" })], state: snap({ pending: PENDING_FRI }) })], []);
    assert.equal(reasked.verdict, "FAIL");
    assert.equal(reasked.extra, "Yes, go ahead.");
  });
  test("lintTurn flags a wrong weekday, a dash and an error as failures, the filler as a warning", () => {
    const notes = lintTurn(turn(1, { text: "One moment, let me check that. Monday the 8th of September — fine.", errors: ["Model error: x"] }), { textMode: true });
    assert.equal(notes.filter((n) => n.startsWith("FAIL:")).length, 3);
    assert.ok(notes.some((n) => /filler spoken in a text turn/.test(n)));
    assert.deepEqual(lintTurn(turn(1, { text: "Tuesday 8 September, between 9 and 1." }), { textMode: true }), []);
  });
  test("summarizeLatency uses nearest-rank percentiles", () => {
    const turns = [100, 200, 300, 400, 1000].map((v, i) => turn(i + 1, { firstTokenMs: v, totalMs: v * 2 }));
    const s = summarizeLatency(turns);
    assert.equal(s.samples, 5);
    assert.equal(s.firstTokenMs.p50, 300);
    assert.equal(s.firstTokenMs.p95, 1000);
    assert.equal(s.totalMs.p50, 600);
    assert.deepEqual(summarizeLatency([]).firstTokenMs, { p50: null, p95: null });
  });

  /** A scripted server: answers are consumed in order; each entry is what one turn produced. */
  function scriptedRunner(script: Array<Partial<TurnRecord>>) {
    const lines: string[] = [];
    return {
      lines,
      runner: {
        textMode: true,
        sendTurn: async (text: string, stepN: number, extra: boolean): Promise<TurnRecord> => {
          lines.push(text);
          const next = script.shift();
          if (!next) throw new Error(`script exhausted at "${text}"`);
          return { ...turn(stepN), user: text, extra, ...next };
        },
      },
    };
  }
  const HAPPY: Array<Partial<TurnRecord>> = [
    { text: "Hi Anna. Your sofa cover, HM-1042, is being prepared for Tuesday 8 September.", tools: [t("find_customer"), t("get_order", { args: { orderId: "HM-1042" } })] },
    { text: "Which order do you mean?" },
    {
      text: "I am sorry about the lamp. Because it is over 200 euros a colleague has to approve it; case CASE-0977-01, they call you back within one business day.",
      tools: [
        t("get_order", { args: { orderId: "HM-0977" } }),
        t("check_resolution_options", { args: { orderId: "HM-0977", issue: "damaged" } }),
        t("escalate_case", { args: { orderId: "HM-0977" }, detail: '{"status":"CREATED","caseId":"CASE-0977-01"}' }),
      ],
      state: snap({ cases: [CASE_0977] }),
    },
    { text: "Friday 4 September has a morning and an afternoon slot. Which one?", tools: [t("get_order", { args: { orderId: "HM-1042" } }), t("get_delivery_slots", { args: { orderId: "HM-1042" } })], state: snap({ cases: [CASE_0977] }) },
    {
      text: "Move the delivery of order HM-1042 to Friday 4 September 2026, in the morning, 9 to 1. Shall I go ahead?",
      tools: [t("apply_resolution", { phase: "blocked", args: { orderId: "HM-1042" }, detail: "NEEDS_CONFIRMATION: no proposal yet" })],
      state: snap({ cases: [CASE_0977], pending: PENDING_FRI, proposals: [PENDING_FRI] }),
    },
    { text: "Done, receipt RCP-1042-001.", tools: [t("apply_resolution", { args: { orderId: "HM-1042" }, detail: '{"status":"APPLIED","receipt":"RCP-1042-001"}' })], state: snap({ cases: [CASE_0977], applied: [APPLIED_1042] }) },
    {
      text: "It is already booked, receipt RCP-1042-001, nothing more to do.",
      tools: [t("apply_resolution", { phase: "blocked", args: { orderId: "HM-1042" }, detail: "ALREADY_APPLIED: done (receipt RCP-1042-001)" })],
      state: snap({ cases: [CASE_0977], applied: [APPLIED_1042] }),
    },
  ];
  test("runDemo: the tolerated clarifying turn is a WARN, the voice-only step a SKIP, everything else PASS", async () => {
    const { runner, lines } = scriptedRunner(HAPPY.map((s) => ({ ...s })));
    const report = await runDemo(runner);
    assert.deepEqual(
      report.steps.map((s) => `${s.n}:${s.verdict}`),
      ["1:PASS", "2:SKIP", "3:WARN", "4:PASS", "5:PASS", "6:PASS", "7:PASS", "8:PASS"],
      report.steps.map((s) => `${s.n} ${s.verdict} ${s.notes.join("; ")}`).join("\n"),
    );
    assert.equal(report.ok, true);
    assert.equal(report.warnings, 1);
    assert.equal(lines[1], DEMO_STEPS[2].say);
    assert.equal(lines[2], "The brass floor lamp, from my earlier order.");
    assert.match(report.steps[2].notes.join(" "), /needed one extra turn/);
    assert.equal(report.turns.length, 7);
    assert.equal(report.latency.samples, 7);
    const text = formatReport(report);
    assert.match(text, /^step verdict {2}firstTokenMs {2}totalMs {2}tools seen$/m);
    assert.match(text, /result: PASS \(0 failed, 1 warned, 1 skipped\)/);
    assert.match(text, /apply_resolution\(HM-1042\)\[BLOCKED ALREADY_APPLIED\]/);
    assert.match(text, /final state: applied 1 \(RCP-1042-001 reschedule HM-1042/);
  });
  test("runDemo: a wrong weekday in step 1 and a silent retry in step 8 fail the run", async () => {
    const script = HAPPY.map((s) => ({ ...s }));
    script[0] = { ...script[0], text: "Your sofa cover comes Monday the 8th of September." };
    script[6] = { text: "Yes, it went through, receipt RCP-1042-001.", state: snap({ cases: [CASE_0977], applied: [APPLIED_1042] }) };
    const { runner } = scriptedRunner(script);
    const report = await runDemo(runner);
    assert.equal(report.ok, false);
    assert.equal(report.failures, 2);
    assert.equal(report.steps[0].verdict, "FAIL");
    assert.match(report.steps[0].notes.join(" "), /"Monday the 8th of September" is a Tuesday/);
    assert.equal(report.steps[7].verdict, "FAIL");
    assert.match(report.steps[7].notes.join(" "), /not exercised/);
    assert.match(formatReport(report), /result: FAIL \(2 failed/);
  });
});

// ---------------------------------------------------------------- language: Turkish

describe("language", () => {
  test("parseLang accepts en and tr in any case or locale form, rejects the rest", () => {
    assert.equal(parseLang("tr"), "tr");
    assert.equal(parseLang(" TR "), "tr");
    assert.equal(parseLang("tr-TR"), "tr");
    assert.equal(parseLang("en_US"), "en");
    assert.equal(parseLang("de"), undefined);
    assert.equal(parseLang(""), undefined);
    assert.equal(parseLang(null), undefined);
    assert.equal(parseLang(7), undefined);
    assert.equal(isLang("tr"), true);
    assert.equal(isLang("turkish"), false);
  });
  test("humanDate, weekdayName and monthName take the language: Turkish names, same word order", () => {
    assert.equal(humanDate("2026-09-04", "tr"), "Cuma 4 Eylül 2026");
    assert.equal(humanDate("2026-09-08", "tr"), "Salı 8 Eylül 2026");
    assert.equal(humanDate(today(), "tr"), "Perşembe 3 Eylül 2026");
    assert.equal(humanDate("2026-08-30", "tr"), "Pazar 30 Ağustos 2026");
    assert.equal(humanDate("2026-09-04", "en"), "Friday 4 September 2026");
    assert.equal(humanDate("2026-09-04"), "Friday 4 September 2026", "English stays the default");
    assert.equal(weekdayName(today(), "tr"), "Perşembe");
    assert.equal(weekdayName(today()), "Thursday");
    assert.equal(monthName("2026-09-04", "tr"), "Eylül");
    assert.equal(monthName("2026-09-04"), "September");
    assert.equal(new Set(WEEKDAY_NAMES.tr).size, 7);
    assert.equal(new Set(MONTH_NAMES.tr).size, 12);
    assert.deepEqual([...WEEKDAY_NAMES.tr], ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"]);
  });
  test("delivery slots carry Turkish weekday and label in a Turkish session", () => {
    const slots = deliverySlots(today(), "tr");
    assert.equal(slots.length, 12);
    assert.equal(slots[0].date, "2026-09-04");
    assert.equal(slots[0].weekday, "Cuma");
    assert.equal(slots[0].label, "Cuma 4 Eylül 2026");
    assert.ok(!slots.some((s) => s.weekday === "Pazar"), "Sunday is still skipped");
    assert.equal(deliverySlots(today())[0].label, "Friday 4 September 2026");
  });
  test("Session carries lang: default en, option tr, kept by reset, in the snapshot", () => {
    assert.equal(new Session().lang, "en");
    assert.equal(new Session().snapshot().lang, "en");
    const s = new Session({ lang: "tr" });
    assert.equal(s.lang, "tr");
    assert.equal(s.snapshot().lang, "tr");
    s.reset();
    assert.equal(s.lang, "tr", "reset keeps the language");
  });
  test("Turkish affirmatives and negations from the brief are in the guard lists", () => {
    for (const a of ["olur", "evet lütfen", "onayla", "kabul"]) assert.ok((AFFIRMATIVE_PHRASES as readonly string[]).includes(a), a);
    for (const n of ["hayır", "istemiyorum", "olmaz", "iptal", "dur", "bekle"]) assert.ok((NEGATION_PHRASES as readonly string[]).includes(n), n);
    for (const u of ["Olur.", "olur, devam edin", "Evet lütfen", "Onayla", "kabul ediyorum", "Kabul.", "Tamam, olur", "Evet, devam edin."]) {
      assert.equal(isAffirmative(u), true, `expected affirmative: ${u}`);
    }
    for (const u of [
      "hayır",
      "Hayır, istemiyorum",
      "olmaz",
      "iptal",
      "İptal edin lütfen",
      "evet ama iptal",
      "dur",
      "Dur, bekle",
      "bekle",
      "olur mu?",
      "Onaylıyor musunuz?",
      "Pardon, işlem gerçekleşti mi? Garanti olsun diye Cuma sabahını tekrar ayarlayın.",
      "ne olur ne olmaz",
    ]) {
      assert.equal(isAffirmative(u), false, `expected NOT affirmative: ${u}`);
    }
  });
  test("tool results carry Turkish labels and Turkish product names in a Turkish session; money and ids stay", async () => {
    const { session, call } = harness(new Session({ lang: "tr" }));
    const found = await call("find_customer", { customerRef: "HM-2201" });
    assert.equal(found.orders[0].promisedDeliveryDateLabel, "Salı 8 Eylül 2026");
    assert.equal(found.orders[1].deliveredAtLabel, "Cuma 28 Ağustos 2026");
    assert.deepEqual(found.orders[1].items, ["Pirinç yay ayaklı lambader"], "a Turkish caller says lamba, so the Turkish name is what the model matches against");
    assert.equal(found.orders[0].totalEur, 89);

    const order = await call("get_order", { orderId: "HM-1042" });
    assert.equal(order.todayLabel, "Perşembe 3 Eylül 2026");
    assert.equal(order.order.promisedDeliveryDateLabel, "Salı 8 Eylül 2026");
    assert.equal(order.order.placedAtLabel, "Salı 1 Eylül 2026");
    assert.equal(order.order.currency, "EUR");

    const slots = await call("get_delivery_slots", { orderId: "HM-1042" });
    assert.equal(slots.currentDeliveryDateLabel, "Salı 8 Eylül 2026");
    assert.equal(slots.slots[0].label, "Cuma 4 Eylül 2026");
    assert.equal(slots.slots[0].weekday, "Cuma");
    const shipped = await call("get_delivery_slots", { orderId: "HM-1010" });
    assert.match(shipped.error, /HM-1010 numaralı sipariş zaten kargoya verildi/);

    const options = await call("check_resolution_options", { orderId: "HM-1042", issue: "reschedule" });
    assert.equal(options.asOfLabel, "Perşembe 3 Eylül 2026");
    assert.equal(options.options[0].label, "Cuma 4 Eylül 2026, sabah 09-13");
    assert.deepEqual(options.options[0].params, { date: "2026-09-04", window: "09-13" }, "params are language neutral");

    const morning = { orderId: "HM-1042", type: "reschedule", params: { date: "2026-09-04", window: "09-13" } };
    const proposal = await call("apply_resolution", { ...morning, customerConfirmed: false });
    assert.equal(proposal.status, "NEEDS_CONFIRMATION");
    assert.equal(proposal.summary, "HM-1042 numaralı siparişin teslimatını Cuma 4 Eylül 2026 tarihine, sabah 9 ile 1 arasına alalım.");
    assert.equal(proposal.ask, `${proposal.summary} Onaylıyor musunuz?`);
    assert.equal(proposal.dateLabel, "Cuma 4 Eylül 2026");
    assert.equal(hasDash(proposal.ask), false);
    // The guard's block reason carries the same Turkish sentence.
    const reason = applyResolutionBlockReason(session, { ...morning, customerConfirmed: true } as never);
    assert.match(reason ?? "", /^NEEDS_CONFIRMATION: .*Ask them: "HM-1042 numaralı siparişin teslimatını Cuma 4 Eylül 2026 tarihine, sabah 9 ile 1 arasına alalım\. Onaylıyor musunuz\?"/);
    session.setLastUserUtterance("Evet, devam edin.");
    const applied = await call("apply_resolution", { ...morning, customerConfirmed: true });
    assert.equal(applied.status, "APPLIED");
    assert.equal(applied.dateLabel, "Cuma 4 Eylül 2026");
    assert.match(applied.receipt, /^RCP-1042-001$/, "receipt format is language neutral");
    session.setLastUserUtterance("Garanti olsun diye tekrar ayarlayın.");
    const again = await call("apply_resolution", { ...morning, customerConfirmed: true });
    assert.equal(again.status, "ALREADY_APPLIED");
    assert.equal(again.dateLabel, "Cuma 4 Eylül 2026");

    const damaged = await call("check_resolution_options", { orderId: "HM-0977", issue: "damaged" });
    assert.equal(damaged.options[0].label, "Arc floor lamp, brass için yenisini gönder (stokta 3)");
    assert.match(damaged.options[0].escalationReason, /EUR 240, otomatik çözüm için EUR 200 sınırının üzerinde/);
    const late = await call("check_resolution_options", { orderId: "HM-1010", issue: "late" });
    assert.equal(late.promisedDeliveryDateLabel, "Pazar 30 Ağustos 2026");
    assert.match(late.options[0].label, /^HM-1010 numaralı sipariş için EUR 15 telafi, söz verilen teslimat Pazar 30 Ağustos 2026, Perşembe 3 Eylül 2026 itibarıyla 4 gün gecikmiş$/);
    assert.doesNotMatch(late.options[0].label, /2026-08-30/);
    process.env.NOW = "2026-09-01";
    const early = await call("check_resolution_options", { orderId: "HM-1010", issue: "late" });
    assert.match(early.note, /standart müşteriler 4 günlük gecikmede/);
    delete process.env.NOW;

    const escalated = await call("escalate_case", { orderId: "HM-0977", reason: "Damaged item over EUR 200" });
    assert.equal(escalated.nextStep, ESCALATION_NEXT_STEP_TR);
    assert.match(escalated.caseId, /^CASE-0977-01$/);
    assert.equal((await call("escalate_case", { orderId: "HM-0977", reason: "again" })).nextStep, ESCALATION_NEXT_STEP_TR);
    // Same calls in an English session are unchanged.
    const en = harness();
    const enSlots = await en.call("get_delivery_slots", { orderId: "HM-1042" });
    assert.equal(enSlots.slots[0].label, "Friday 4 September 2026");
    assert.equal((await en.call("escalate_case", { orderId: "HM-0977", reason: "x" })).nextStep, ESCALATION_NEXT_STEP);
  });
  test("summaries per type in Turkish: refund, replacement and compensation keep EUR amounts and ids", () => {
    const s = new Session();
    const vase = findOrder(s.store, "HM-1031")!;
    const cover = findOrder(s.store, "HM-1042")!;
    const table = findOrder(s.store, "HM-1010")!;
    assert.equal(
      summarize({ type: "refund", label: "", params: { sku: "VASE-CER-SET" }, requiresEscalation: false, amountEur: 45 }, vase, "tr"),
      "HM-1031 numaralı siparişteki Ceramic vase set için EUR 45 iade edelim.",
    );
    assert.equal(
      summarize({ type: "replacement", label: "", params: { sku: "SOFA-LIN-GRY" }, requiresEscalation: false }, cover, "tr"),
      "HM-1042 numaralı sipariş için Linen sofa cover, grey ürününü ücretsiz olarak yeniden gönderelim.",
    );
    assert.equal(
      summarize({ type: "compensation", label: "", params: { amountEur: 15 }, requiresEscalation: false, amountEur: 15 }, table, "tr"),
      "HM-1010 numaralı siparişin geç teslimatı için EUR 15 tutarında telafi tanımlayalım.",
    );
    assert.equal(
      summarize({ type: "reschedule", label: "", params: { date: "2026-09-04", window: "13-18" }, requiresEscalation: false }, cover, "tr"),
      "HM-1042 numaralı siparişin teslimatını Cuma 4 Eylül 2026 tarihine, öğleden sonra 1 ile 6 arasına alalım.",
    );
    assert.equal(summarize({ type: "refund", label: "", params: { sku: "VASE-CER-SET" }, requiresEscalation: false, amountEur: 45 }, vase), "Refund EUR 45 for Ceramic vase set on order HM-1031.");
    assert.equal(confirmationAsk("X.", "tr"), "X. Onaylıyor musunuz?");
    assert.equal(confirmationAsk("X."), "X. Shall I go ahead?");
  });
  test("the Turkish prompt: persona and rules in Turkish, formal siz, no dashes, tools and status tags kept", async () => {
    const { session, call } = harness(new Session({ lang: "tr" }));
    const p = buildSystemPrompt(session);
    assert.match(p, /^Hemma'nın telefon destek görevlisisiniz\./);
    assert.match(p, /Bugün Perşembe 3 Eylül 2026\./);
    assert.match(p, /müşteriye her zaman siz diye hitap edin/);
    assert.match(p, /^Üslup: /m);
    assert.match(p, /^Kurallar: /m);
    assert.match(p, /Haftanın gününü asla kendiniz hesaplamayın/);
    assert.match(p, /Hiçbir tire kullanmayın/);
    assert.match(p, /apply_resolution .*customerConfirmed false/);
    assert.match(p, /ALREADY_APPLIED/);
    assert.match(p, /escalate_case/);
    assert.match(p, /^Canlı durum:$/m);
    assert.match(p, /^Müşteri: henüz tanınmadı$/m);
    assert.match(p, /^Playbook'lar/m);
    for (const pb of playbooks) assert.match(p, new RegExp(`^${pb.scenario}: `, "m"));
    assert.equal(hasDash(p), false, "no dash anywhere in the Turkish prompt");
    assert.doesNotMatch(p, /Today is|Rules:|Style:|Live state:/, "no English scaffolding left");
    assert.ok(p.length < 6000, `prompt is ${p.length} chars`);
    await call("find_customer", { customerRef: "HM-2201" });
    const block = buildStateBlock(session);
    assert.match(block, /^Müşteri: Anna Weber \(müşteri no HM-2201, VIP, telefon \+49 30 1234567\)$/m);
    assert.match(block, /Bilinen siparişler \(en yeni önce\): HM-1042 \(Keten kanepe kılıfı, gri\) hazırlanıyor, söz verilen teslimat Salı 8 Eylül 2026, EUR 89; HM-0977 \(Pirinç yay ayaklı lambader\) teslim edildi Cuma 28 Ağustos 2026, EUR 240/);
    assert.doesNotMatch(block, /2026-09-08/, "no bare ISO dates");
    await call("apply_resolution", { orderId: "HM-1042", type: "reschedule", params: { date: "2026-09-04", window: "09-13" }, customerConfirmed: false });
    assert.match(buildStateBlock(session), /Bekleyen işlem \(açık bir evet bekliyor\): HM-1042 numaralı siparişin teslimatını Cuma 4 Eylül 2026 tarihine, sabah 9 ile 1 arasına alalım\./);
    session.setLastUserUtterance("evet");
    await call("apply_resolution", { orderId: "HM-1042", type: "reschedule", params: { date: "2026-09-04", window: "09-13" }, customerConfirmed: true });
    assert.match(buildStateBlock(session), /Uygulanan işlemler: HM-1042 numaralı siparişin teslimatını .* \(fiş RCP-1042-001\)/);
    assert.match(buildStateBlock(session), /hazırlanıyor, söz verilen teslimat Cuma 4 Eylül 2026 09-13, EUR 89/);
    await call("escalate_case", { orderId: "HM-0977", reason: "damaged" });
    assert.match(buildStateBlock(session), /Açık kayıtlar: CASE-0977-01, HM-0977 için: damaged/);
    // Switching the session language re-renders the prompt in English on the next build.
    session.lang = "en";
    assert.match(buildSystemPrompt(session), /Today is Thursday 3 September 2026\./);
  });
  test("demo script: Turkish lines, bilingual hints, Turkish weekday lint", async () => {
    const tr = demoSteps("tr");
    assert.deepEqual(
      tr.filter((s) => s.say).map((s) => s.say),
      [DEMO_LINES.tr.step1, DEMO_LINES.tr.step3, DEMO_LINES.tr.step5, DEMO_LINES.tr.step6, DEMO_LINES.tr.step7, DEMO_LINES.tr.step8],
    );
    assert.equal(DEMO_STEPS[0].say, DEMO_LINES.en.step1);
    assert.equal(isAffirmative(DEMO_LINES.tr.step7), true, "step 7 must be a yes for the guard");
    assert.equal(isAffirmative(DEMO_LINES.tr.step8), false, "step 8 must not be a yes");
    assert.equal(isAffirmative(DEMO_LINES.en.step7), true);
    assert.equal(isAffirmative(DEMO_LINES.en.step8), false);
    for (const line of Object.values(DEMO_LINES.tr)) assert.equal(hasDash(line), false, line);
    assert.deepEqual(weekdayMismatches("Teslimatı Cuma 4 Eylül 2026 sabahına aldım."), []);
    assert.deepEqual(weekdayMismatches("4 Eylül Cuma günü, 8 Eylül 2026 Salı"), []);
    assert.deepEqual(weekdayMismatches("Cumartesi 4 Eylül olur mu?"), ['"Cumartesi 4 Eylül" is a Cuma']);
    assert.deepEqual(weekdayMismatches("Siparişiniz 8 Eylül Pazartesi geliyor."), ['"8 Eylül Pazartesi" is a Salı']);
    assert.deepEqual(weekdayMismatches("Çarşamba 9 Eylül"), []);
    assert.deepEqual(weekdayMismatches("Perşembe 4 Eylül"), ['"Perşembe 4 Eylül" is a Cuma']);
    const fillerNotes = lintTurn({ step: 1, user: "u", extra: false, text: "Bir saniye, hemen bakıyorum. Tamam.", tools: [], firstTokenMs: 1, totalMs: 2, errors: [] }, { textMode: true });
    assert.ok(fillerNotes.some((n) => /filler spoken in a text turn/.test(n)));
    // A Turkish run of the scripted happy path passes the same evaluators.
    const lines: string[] = [];
    const script: Array<Partial<TurnRecord>> = [
      { text: "Merhaba Anna. Kanepe kılıfınız, HM-1042, Salı 8 Eylül için hazırlanıyor.", tools: [{ name: "find_customer", phase: "end" }, { name: "get_order", phase: "end", args: { orderId: "HM-1042" } }] },
      {
        text: "Lamba için üzgünüm. 200 euronun üzerinde olduğu için bir meslektaşımın onayı gerekiyor; kayıt numaranız CASE-0977-01, bir iş günü içinde sizi arayacaklar.",
        tools: [
          { name: "get_order", phase: "end", args: { orderId: "HM-0977" } },
          { name: "check_resolution_options", phase: "end", args: { orderId: "HM-0977", issue: "damaged" } },
          { name: "escalate_case", phase: "end", args: { orderId: "HM-0977" }, detail: '{"status":"CREATED","caseId":"CASE-0977-01"}' },
        ],
        state: { id: "s", lang: "tr", proposals: [], applied: [], cases: [{ id: "CASE-0977-01", orderId: "HM-0977", reason: "damaged", details: {}, createdAt: 1 }], toolLog: [], lastUserUtterance: "", utteranceSeq: 2 },
      },
      { text: "Cuma 4 Eylül için sabah ve öğleden sonra saatleri var. Hangisini istersiniz?", tools: [{ name: "get_delivery_slots", phase: "end", args: { orderId: "HM-1042" } }] },
      {
        text: "HM-1042 numaralı siparişin teslimatını Cuma 4 Eylül 2026 tarihine, sabah 9 ile 1 arasına alalım. Onaylıyor musunuz?",
        tools: [{ name: "apply_resolution", phase: "blocked", args: { orderId: "HM-1042" }, detail: "NEEDS_CONFIRMATION: x" }],
        state: {
          id: "s",
          lang: "tr",
          proposals: [],
          applied: [],
          cases: [],
          toolLog: [],
          lastUserUtterance: "",
          utteranceSeq: 4,
          pending: { key: "k", type: "reschedule", orderId: "HM-1042", params: { date: "2026-09-04", window: "09-13" }, summary: "x", proposedAt: 1, proposedTurn: 1 },
        },
      },
      {
        text: "Tamamdır, fiş numaranız RCP-1042-001.",
        tools: [{ name: "apply_resolution", phase: "end", args: { orderId: "HM-1042" }, detail: '{"status":"APPLIED","receipt":"RCP-1042-001"}' }],
        state: { id: "s", lang: "tr", proposals: [], applied: [{ key: "k", type: "reschedule", orderId: "HM-1042", params: { date: "2026-09-04", window: "09-13" }, appliedAt: 1, receipt: "RCP-1042-001" }], cases: [], toolLog: [], lastUserUtterance: "", utteranceSeq: 5 },
      },
      {
        text: "İşlem zaten yapıldı, fiş numarası RCP-1042-001.",
        tools: [{ name: "apply_resolution", phase: "blocked", args: { orderId: "HM-1042" }, detail: "ALREADY_APPLIED: done (receipt RCP-1042-001)" }],
        state: { id: "s", lang: "tr", proposals: [], applied: [{ key: "k", type: "reschedule", orderId: "HM-1042", params: { date: "2026-09-04", window: "09-13" }, appliedAt: 1, receipt: "RCP-1042-001" }], cases: [], toolLog: [], lastUserUtterance: "", utteranceSeq: 6 },
      },
    ];
    const base = { id: "s", lang: "tr" as const, customer: { id: "CUST-001", ref: "HM-2201", name: "Anna Weber", phone: "+49 30 1234567", tier: "vip" as const }, proposals: [], applied: [], cases: [], toolLog: [], lastUserUtterance: "", utteranceSeq: 1 };
    const report = await runDemo({
      lang: "tr",
      textMode: true,
      sendTurn: async (text, step, extra) => {
        lines.push(text);
        const next = script.shift();
        if (!next) throw new Error(`script exhausted at "${text}"`);
        const state = next.state ? { ...base, ...next.state } : base;
        return { step, user: text, extra, text: "", tools: [], firstTokenMs: 400, totalMs: 900, errors: [], ...next, state };
      },
    });
    assert.deepEqual(lines, [DEMO_LINES.tr.step1, DEMO_LINES.tr.step3, DEMO_LINES.tr.step5, DEMO_LINES.tr.step6, DEMO_LINES.tr.step7, DEMO_LINES.tr.step8]);
    assert.deepEqual(
      report.steps.map((s) => `${s.n}:${s.verdict}`),
      ["1:PASS", "2:SKIP", "3:PASS", "4:PASS", "5:PASS", "6:PASS", "7:PASS", "8:PASS"],
      report.steps.map((s) => `${s.n} ${s.verdict} ${s.notes.join("; ")}`).join("\n"),
    );
  });
});
