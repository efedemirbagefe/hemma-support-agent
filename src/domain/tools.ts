import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static, type TLiteral, type TObject, type TString, type TUnion } from "@sinclair/typebox";
import { applyPending, confirmationAsk, dateFields, delayDaysFor, optionsFor, propose, resolveAction } from "./actions";
import { humanDate, isoDate, today } from "./clock";
import { customerForOrder, findCustomer, findOrder, ordersForCustomer } from "./data";
import { confirmationVerdict, type ConfirmationVerdict } from "./guards";
import { DEFAULT_LANG, type Lang } from "./lang";
import { isScenario, playbooks, scenariosOf, type Scenario } from "./policies/index";
import { deliverySlots, rescheduleBlockedReason } from "./policies/reschedule";
import { actionKey, type Session } from "./session";
import type { Case, DeliverySlot, Order, Playbook } from "./types";

export const TOOL_NAMES = [
  "find_customer",
  "get_order",
  "check_resolution_options",
  "get_delivery_slots",
  "apply_resolution",
  "escalate_case",
] as const;

/** What the customer is told after escalate_case: who follows up and when. Data, not prompt. */
export const ESCALATION_NEXT_STEP = "A colleague reviews the case and calls the customer back within one business day.";
export const ESCALATION_NEXT_STEP_TR = "Bir meslektaşımız kaydı inceler ve bir iş günü içinde müşteriyi geri arar.";

export function escalationNextStep(lang: Lang = DEFAULT_LANG): string {
  return lang === "tr" ? ESCALATION_NEXT_STEP_TR : ESCALATION_NEXT_STEP;
}

const FindCustomerParams = Type.Object({
  phone: Type.Optional(Type.String({ description: "Customer phone number in any format" })),
  customerRef: Type.Optional(Type.String({ description: "Customer reference such as HM-2201" })),
});
const GetOrderParams = Type.Object({
  orderId: Type.String({ description: "Order id such as HM-1042" }),
});

export type CheckOptionsSchema = TObject<{ orderId: TString; issue: TUnion<TLiteral<string>[]> }>;

/** The `issue` union is built from the registry, so a new playbook is accepted without a schema edit. */
export function checkOptionsParams(registry: readonly Playbook[]): CheckOptionsSchema {
  const names = scenariosOf(registry);
  return Type.Object({
    orderId: Type.String(),
    issue: Type.Union(
      names.map((s) => Type.Literal(s)),
      { description: `The issue to resolve, one of: ${names.join(", ")}` },
    ),
  });
}
/** Schema for the live registry (typing and docs); createTools builds one per session. */
export const CheckOptionsParams = checkOptionsParams(playbooks);

const SlotsParams = Type.Object({
  orderId: Type.String(),
});
const ApplyParams = Type.Object({
  orderId: Type.String(),
  type: Type.Union([Type.Literal("reschedule"), Type.Literal("replacement"), Type.Literal("refund"), Type.Literal("compensation")]),
  params: Type.Record(Type.String(), Type.Any(), {
    description: "Exactly the params of the chosen option: reschedule {date, window}; replacement/refund {sku}; compensation {amountEur}",
  }),
  customerConfirmed: Type.Boolean({ description: "true only if the customer explicitly said yes to this exact proposal in this call" }),
});
const EscalateParams = Type.Object({
  orderId: Type.String(),
  reason: Type.String({ description: "Short reason, e.g. 'damaged item over EUR 200'" }),
  details: Type.Optional(Type.Record(Type.String(), Type.Any())),
});

export type FindCustomerArgs = Static<typeof FindCustomerParams>;
export type GetOrderArgs = Static<typeof GetOrderParams>;
export type CheckOptionsArgs = { orderId: string; issue: Scenario };
export type SlotsArgs = Static<typeof SlotsParams>;
export type ApplyArgs = Static<typeof ApplyParams>;
export type EscalateArgs = Static<typeof EscalateParams>;

export type ApplyStatus = "APPLIED" | "NEEDS_CONFIRMATION" | "ALREADY_APPLIED" | "ESCALATION_REQUIRED" | "INVALID";

function result<T>(payload: T) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], details: payload };
}

function hasSimulateFailure(params: unknown): boolean {
  if (!params || typeof params !== "object") return false;
  const p = params as Record<string, unknown>;
  if (p.simulateFailure === true) return true;
  const inner = p.params;
  return !!inner && typeof inner === "object" && (inner as Record<string, unknown>).simulateFailure === true;
}

/** Throws when a failure is requested via params.simulateFailure or FAIL_TOOL=<name>. */
export function maybeFail(tool: string, params: unknown): void {
  if (process.env.FAIL_TOOL === tool || hasSimulateFailure(params)) {
    throw new Error(`Simulated failure in ${tool}`);
  }
}

/** Order line for find_customer: enough for the model to match "the lamp" to an order without asking. */
function orderSummary(order: Order, lang: Lang) {
  return {
    id: order.id,
    status: order.status,
    items: order.items.map((i) => i.name),
    totalEur: order.totalEur,
    placedAt: order.placedAt,
    promisedDeliveryDate: order.promisedDeliveryDate,
    promisedDeliveryDateLabel: humanDate(order.promisedDeliveryDate, lang),
    ...(order.deliveredAt ? { deliveredAt: order.deliveredAt, deliveredAtLabel: humanDate(order.deliveredAt, lang) } : {}),
  };
}

export function slotsForOrder(order: Order, lang: Lang = DEFAULT_LANG): { slots: DeliverySlot[]; error?: string } {
  const error = rescheduleBlockedReason(order, lang);
  if (error) return { slots: [], error };
  return { slots: deliverySlots(today(), lang) };
}

export function createTools(session: Session): AgentTool[] {
  const findCustomerTool: AgentTool<typeof FindCustomerParams> = {
    name: "find_customer",
    label: "Find customer",
    description: "Identify the customer by phone number or customer reference. Returns the customer and their orders. Call this first.",
    parameters: FindCustomerParams,
    execute: async (_id, params) => {
      maybeFail("find_customer", params);
      if (!params.phone && !params.customerRef) {
        return result({ found: false, message: "Ask the customer for their phone number or customer reference." });
      }
      const customer = findCustomer(session.store, params);
      if (!customer) {
        return result({ found: false, message: "No customer matches that phone or reference. Ask them to repeat it." });
      }
      session.customer = customer;
      const orders = ordersForCustomer(session.store, customer.id)
        .slice()
        .sort((a, b) => (a.placedAt < b.placedAt ? 1 : -1))
        .map((o) => orderSummary(o, session.lang));
      return result({
        found: true,
        customer: { id: customer.id, ref: customer.ref, name: customer.name, tier: customer.tier },
        orders,
        mostRecentOrderId: orders[0]?.id,
      });
    },
  };

  const getOrderTool: AgentTool<typeof GetOrderParams> = {
    name: "get_order",
    label: "Get order",
    description: "Full order details: items, status, delivery date (with its weekday label), customer tier and how many days late it is.",
    parameters: GetOrderParams,
    execute: async (_id, params) => {
      maybeFail("get_order", params);
      const order = findOrder(session.store, params.orderId);
      if (!order) return result({ found: false, message: `No order ${params.orderId}.` });
      session.activeOrderId = order.id;
      const customer = customerForOrder(session.store, order);
      const delayDays = delayDaysFor(order);
      const now = today();
      const lang = session.lang;
      return result({
        found: true,
        today: isoDate(now),
        todayLabel: humanDate(now, lang),
        order: {
          ...order,
          currency: "EUR",
          customerName: customer?.name,
          customerTier: customer?.tier,
          placedAtLabel: humanDate(order.placedAt, lang),
          promisedDeliveryDateLabel: humanDate(order.promisedDeliveryDate, lang),
          ...(order.deliveredAt ? { deliveredAtLabel: humanDate(order.deliveredAt, lang) } : {}),
          delayDays,
          isLate: delayDays > 0,
        },
      });
    },
  };

  const checkOptionsSchema = checkOptionsParams(session.playbooks);
  const checkOptionsTool: AgentTool<CheckOptionsSchema> = {
    name: "check_resolution_options",
    label: "Check resolution options",
    description: `Resolution options the policy allows for an order and issue (${scenariosOf(session.playbooks).join(", ")}). Offer only these. If escalationRequired is true, do not apply; escalate instead.`,
    parameters: checkOptionsSchema,
    execute: async (_id, params) => {
      maybeFail("check_resolution_options", params);
      if (!isScenario(params.issue, session.playbooks)) {
        return result({ found: false, message: `Unknown issue ${params.issue}. Known issues: ${scenariosOf(session.playbooks).join(", ")}.` });
      }
      const order = findOrder(session.store, params.orderId);
      if (!order) return result({ found: false, message: `No order ${params.orderId}.` });
      session.activeOrderId = order.id;
      const res = optionsFor(session, order, params.issue);
      const now = today();
      return result({
        found: true,
        orderId: order.id,
        issue: params.issue,
        delayDays: res.delayDays,
        promisedDeliveryDate: order.promisedDeliveryDate,
        promisedDeliveryDateLabel: humanDate(order.promisedDeliveryDate, session.lang),
        asOf: isoDate(now),
        asOfLabel: humanDate(now, session.lang),
        customerTier: res.customer.tier,
        options: res.options,
        escalationRequired: res.escalationRequired,
        ...(res.note ? { note: res.note } : {}),
      });
    },
  };

  const slotsTool: AgentTool<typeof SlotsParams> = {
    name: "get_delivery_slots",
    label: "Get delivery slots",
    description:
      "Available delivery slots for the next 7 days (no Sunday), windows 09-13 and 13-18, each with its weekday label. Only for orders still processing.",
    parameters: SlotsParams,
    execute: async (_id, params) => {
      maybeFail("get_delivery_slots", params);
      const order = findOrder(session.store, params.orderId);
      if (!order) return result({ found: false, message: `No order ${params.orderId}.`, slots: [] });
      session.activeOrderId = order.id;
      const { slots, error } = slotsForOrder(order, session.lang);
      if (error) return result({ found: true, orderId: order.id, error, slots: [] });
      return result({
        found: true,
        orderId: order.id,
        currentDeliveryDate: order.promisedDeliveryDate,
        currentDeliveryDateLabel: humanDate(order.promisedDeliveryDate, session.lang),
        slots,
      });
    },
  };

  const applyTool: AgentTool<typeof ApplyParams> = {
    name: "apply_resolution",
    label: "Apply resolution",
    description:
      "Two-phase. Call it BEFORE asking the customer, with customerConfirmed false: it registers the proposal and returns NEEDS_CONFIRMATION with the exact sentence to read out. After the customer says yes, call it again with the same params and customerConfirmed true. Idempotent: repeating an applied action returns ALREADY_APPLIED with the original receipt, so also call it when the customer asks whether an action went through or asks for it again; that answer is the proof to read back.",
    parameters: ApplyParams,
    execute: async (_id, params) => {
      maybeFail("apply_resolution", params);
      const resolved = resolveAction(session, params.orderId, params.type, params.params);
      if (!resolved.ok) {
        return result({ status: "INVALID" as ApplyStatus, reason: resolved.reason });
      }
      const { order, option, key, params: norm } = resolved;
      const dates = dateFields(option.type, norm, session.lang);
      if (option.requiresEscalation) {
        return result({
          status: "ESCALATION_REQUIRED" as ApplyStatus,
          reason: option.escalationReason ?? "This option needs a human agent.",
          next: "Call escalate_case and tell the customer a colleague will follow up.",
        });
      }
      const applied = session.applied.get(key);
      if (applied) {
        return result({
          status: "ALREADY_APPLIED" as ApplyStatus,
          receipt: applied.receipt,
          appliedAt: applied.appliedAt,
          summary: applied.summary,
          ...dates,
        });
      }
      const verdict: ConfirmationVerdict =
        params.customerConfirmed !== true ? { ok: false, why: "customerConfirmed was not true" } : confirmationVerdict(session, key);
      if (!verdict.ok) {
        const pending = propose(session, order, option, key, norm);
        return result({
          status: "NEEDS_CONFIRMATION" as ApplyStatus,
          summary: pending.summary,
          ask: confirmationAsk(pending.summary, session.lang),
          why: verdict.why,
          key,
          ...dates,
        });
      }
      const record = applyPending(session, session.proposals.get(key)!);
      return result({ status: "APPLIED" as ApplyStatus, receipt: record.receipt, summary: record.summary, appliedAt: record.appliedAt, ...dates });
    },
  };

  const escalateTool: AgentTool<typeof EscalateParams> = {
    name: "escalate_case",
    label: "Escalate case",
    description:
      "Open a case for a human agent when the policy requires escalation or a tool failed. One case per order: a second call for the same order returns the open case. Always tell the customer the case id and the next step.",
    parameters: EscalateParams,
    execute: async (_id, params) => {
      maybeFail("escalate_case", params);
      const order = findOrder(session.store, params.orderId);
      if (!order) {
        return result({ found: false, message: `No order ${params.orderId}. No case was opened; check the order id with find_customer or get_order first.` });
      }
      const orderId = order.id;
      const existing = session.cases.find((c) => c.orderId === orderId);
      if (existing) {
        return result({ status: "ALREADY_OPEN", caseId: existing.id, orderId: existing.orderId, reason: existing.reason, nextStep: escalationNextStep(session.lang) });
      }
      const created: Case = {
        id: `CASE-${orderId.replace(/^HM-/, "")}-${String(session.cases.length + 1).padStart(2, "0")}`,
        orderId,
        reason: params.reason.trim(),
        details: params.details ?? {},
        createdAt: Date.now(),
      };
      session.cases.push(created);
      return result({ status: "CREATED", caseId: created.id, orderId, reason: created.reason, nextStep: escalationNextStep(session.lang) });
    },
  };

  return [findCustomerTool, getOrderTool, checkOptionsTool, slotsTool, applyTool, escalateTool];
}

/** Convenience for tests and scripts: the idempotency key a tool call would use. */
export function keyForApply(args: Pick<ApplyArgs, "orderId" | "type" | "params">, session: Session): string | undefined {
  const resolved = resolveAction(session, args.orderId, args.type, args.params);
  return resolved.ok ? resolved.key : actionKey(args.type, args.orderId, args.params ?? {});
}
