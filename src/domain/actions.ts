/**
 * Shared, deterministic action logic used by both the tools and the guards:
 * option resolution against the playbooks, pending proposals, and applying
 * an action to the in-memory store plus the ledger.
 */
import { daysBetween, humanDate, today } from "./clock";
import { customerForOrder, findOrder } from "./data";
import { DEFAULT_LANG, type Lang } from "./lang";
import { getPlaybook, playbooksForAction } from "./policies/index";
import { actionKey, stableStringify, type Session } from "./session";
import type { ActionType, AppliedRecord, Customer, Order, PendingAction, ResolutionOption } from "./types";

/** Days past the promised date: measured at delivery when delivered, otherwise against today. Never negative. */
export function delayDaysFor(order: Order, now: Date = today()): number {
  const reference = order.status === "delivered" && order.deliveredAt ? order.deliveredAt : now;
  return Math.max(0, daysBetween(order.promisedDeliveryDate, reference));
}

function asString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return String(v).trim();
}

function asNumber(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Keeps only the params that matter for the action type, so keys are stable and idempotent. */
export function normalizeParams(type: ActionType, params: Record<string, unknown> | undefined): Record<string, unknown> {
  const p = params ?? {};
  switch (type) {
    case "reschedule":
      return { date: asString(p.date), window: asString(p.window) };
    case "replacement":
    case "refund":
      return { sku: asString(p.sku)?.toUpperCase() };
    case "compensation":
      return { amountEur: asNumber(p.amountEur) };
  }
}

export interface OptionsResult {
  order: Order;
  customer: Customer;
  scenario: string;
  delayDays: number;
  options: ResolutionOption[];
  escalationRequired: boolean;
  note?: string;
}

/** Options the named playbook of this session offers for the order. Throws on an unknown scenario. */
export function optionsFor(session: Session, order: Order, scenario: string): OptionsResult {
  const customer = customerForOrder(session.store, order);
  if (!customer) throw new Error(`Data integrity: order ${order.id} has no customer`);
  const playbook = getPlaybook(scenario, session.playbooks);
  const ctx = { today: today(), delayDays: delayDaysFor(order), lang: session.lang };
  const options = playbook.options(order, customer, ctx);
  const note = playbook.note?.(order, customer, ctx);
  return {
    order,
    customer,
    scenario: playbook.scenario,
    delayDays: ctx.delayDays,
    options,
    escalationRequired: options.length > 0 && options.every((o) => o.requiresEscalation),
    ...(note ? { note } : {}),
  };
}

export type ResolvedAction =
  | {
      ok: true;
      order: Order;
      customer: Customer;
      option: ResolutionOption;
      key: string;
      params: Record<string, unknown>;
      /**
       * The playbook whose option is returned: the first one that requires escalation when
       * any does, otherwise the first match in registry order.
       */
      scenario: string;
      /** Every playbook that offers this exact option for the order, in registry order. */
      scenarios: string[];
    }
  | { ok: false; reason: string; order?: Order };

/**
 * Matches a requested action against what the playbooks actually offer for this order.
 * Every playbook that declares the action type is consulted, whatever the registry order.
 * When more than one offers an option with these exact (normalised) params, the strictest
 * one decides: if any of them requires escalation, the returned option requires escalation
 * (with that playbook's reason), so a lenient playbook earlier in the registry cannot bypass
 * a stricter one added later. The idempotency key is per action, not per playbook, so the
 * same replacement reached through two playbooks is one action.
 */
export function resolveAction(
  session: Session,
  orderId: string,
  type: ActionType,
  params: Record<string, unknown> | undefined,
): ResolvedAction {
  const order = findOrder(session.store, orderId);
  if (!order) return { ok: false, reason: `Unknown order ${orderId}. Look the order up with get_order first.` };
  const candidates = playbooksForAction(type, session.playbooks);
  if (candidates.length === 0) {
    return { ok: false, order, reason: `No playbook offers ${type} actions. Offer only options a tool returned.` };
  }
  const norm = normalizeParams(type, params);
  const key = actionKey(type, order.id, norm);
  const wanted = stableStringify(norm);
  const sameType: ResolutionOption[] = [];
  const notes: string[] = [];
  const matches: { option: ResolutionOption; customer: Customer; scenario: string }[] = [];
  for (const playbook of candidates) {
    const result = optionsFor(session, order, playbook.scenario);
    const option = result.options.find((o) => o.type === type && stableStringify(normalizeParams(type, o.params)) === wanted);
    if (option) {
      matches.push({ option, customer: result.customer, scenario: playbook.scenario });
      continue;
    }
    for (const o of result.options) {
      if (o.type === type && !sameType.some((s) => s.label === o.label)) sameType.push(o);
    }
    if (result.note && !notes.includes(result.note)) notes.push(result.note);
  }
  if (matches.length > 0) {
    const decisive = matches.find((m) => m.option.requiresEscalation) ?? matches[0];
    return {
      ok: true,
      order,
      customer: decisive.customer,
      option: decisive.option,
      key,
      params: norm,
      scenario: decisive.scenario,
      scenarios: matches.map((m) => m.scenario),
    };
  }
  const hint =
    sameType.length > 0
      ? `Available ${type} options: ${sameType.map((o) => `${o.label} -> params ${JSON.stringify(o.params)}`).join("; ")}.`
      : `No ${type} option is available for order ${order.id}.`;
  const note = notes.length ? ` ${notes.join(" ")}` : "";
  return {
    ok: false,
    order,
    reason: `${type} with params ${JSON.stringify(norm)} is not an offered option for order ${order.id}.${note} ${hint} Offer only options a tool returned.`,
  };
}

function itemName(order: Order, sku: unknown): string {
  const item = order.items.find((i) => i.sku.toUpperCase() === String(sku ?? "").toUpperCase());
  return item ? item.name : "the item";
}

/** Date fields for results that carry a delivery date (reschedule): ISO plus the spoken label in `lang`. */
export function dateFields(type: ActionType, params: Record<string, unknown>, lang: Lang = DEFAULT_LANG): { date: string; dateLabel: string } | Record<string, never> {
  if (type !== "reschedule") return {};
  const date = asString(params.date);
  if (!date) return {};
  try {
    return { date, dateLabel: humanDate(date, lang) };
  } catch {
    return {};
  }
}

/**
 * Spoken one-liner the agent reads to the customer before applying, in the session language.
 * Dates carry their weekday label; amounts stay "EUR 89", ids stay "HM-1042", product names
 * stay as the data has them.
 */
export function summarize(option: ResolutionOption, order: Order, lang: Lang = DEFAULT_LANG): string {
  const p = option.params;
  if (lang === "tr") {
    switch (option.type) {
      case "reschedule": {
        const date = String(p.date);
        const window = p.window === "09-13" ? "sabah 9 ile 1 arasına" : "öğleden sonra 1 ile 6 arasına";
        return `${order.id} numaralı siparişin teslimatını ${humanDate(date, "tr")} tarihine, ${window} alalım.`;
      }
      case "replacement":
        return `${order.id} numaralı sipariş için ${itemName(order, p.sku)} ürününü ücretsiz olarak yeniden gönderelim.`;
      case "refund":
        return `${order.id} numaralı siparişteki ${itemName(order, p.sku)} için EUR ${option.amountEur ?? order.totalEur} iade edelim.`;
      case "compensation":
        return `${order.id} numaralı siparişin geç teslimatı için EUR ${option.amountEur ?? p.amountEur} tutarında telafi tanımlayalım.`;
    }
  }
  switch (option.type) {
    case "reschedule": {
      const date = String(p.date);
      const window = p.window === "09-13" ? "in the morning, 9 to 1" : "in the afternoon, 1 to 6";
      return `Move the delivery of order ${order.id} to ${humanDate(date)}, ${window}.`;
    }
    case "replacement":
      return `Send a free replacement ${itemName(order, p.sku)} for order ${order.id}.`;
    case "refund":
      return `Refund EUR ${option.amountEur ?? order.totalEur} for ${itemName(order, p.sku)} on order ${order.id}.`;
    case "compensation":
      return `Credit EUR ${option.amountEur ?? p.amountEur} as compensation for the late delivery of order ${order.id}.`;
  }
}

/** The question the agent asks after reading a proposal, in the session language. */
export function confirmationAsk(summary: string, lang: Lang = DEFAULT_LANG): string {
  return lang === "tr" ? `${summary} Onaylıyor musunuz?` : `${summary} Shall I go ahead?`;
}

/**
 * Registers the proposal and makes it the current one. No side effect on the store.
 * Re-proposing the key that is already current keeps its original turn stamp (the customer
 * has already heard it); a new or parked key is stamped with the current utterance, so a yes
 * in this same utterance cannot apply it.
 */
export function propose(session: Session, order: Order, option: ResolutionOption, key: string, params: Record<string, unknown>): PendingAction {
  const current = session.pending;
  const keepStamp = current !== undefined && current.key === key;
  const pending: PendingAction = {
    key,
    type: option.type,
    orderId: order.id,
    params,
    summary: summarize(option, order, session.lang),
    proposedAt: keepStamp ? current.proposedAt : Date.now(),
    proposedTurn: keepStamp ? current.proposedTurn : session.utteranceSeq,
  };
  session.setProposal(pending);
  return pending;
}

function receiptFor(session: Session, orderId: string): string {
  const n = session.applied.size + 1;
  return `RCP-${orderId.replace(/^HM-/i, "")}-${String(n).padStart(3, "0")}`;
}

/** Applies synchronously in memory and writes the ledger. Clears the pending action if it was this one. */
export function applyPending(session: Session, pending: PendingAction): AppliedRecord {
  const existing = session.applied.get(pending.key);
  if (existing) return existing;
  const order = findOrder(session.store, pending.orderId);
  if (!order) throw new Error(`Unknown order ${pending.orderId}`);
  switch (pending.type) {
    case "reschedule": {
      order.promisedDeliveryDate = String(pending.params.date);
      order.deliveryWindow = pending.params.window as Order["deliveryWindow"];
      break;
    }
    case "replacement": {
      const item = order.items.find((i) => i.sku.toUpperCase() === String(pending.params.sku).toUpperCase());
      if (item) item.replacementStock = Math.max(0, item.replacementStock - item.qty);
      break;
    }
    case "refund":
    case "compensation":
      break;
  }
  const record: AppliedRecord = {
    key: pending.key,
    type: pending.type,
    orderId: order.id,
    params: pending.params,
    appliedAt: Date.now(),
    receipt: receiptFor(session, order.id),
    summary: pending.summary,
  };
  session.applied.set(pending.key, record);
  session.lastAppliedSeq = session.utteranceSeq;
  session.clearProposal(pending.key);
  return record;
}
