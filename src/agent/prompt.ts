import { humanDate, today } from "../domain/clock";
import { ordersForCustomer } from "../domain/data";
import type { Session } from "../domain/session";
import type { Order } from "../domain/types";

const PERSONA =
  "You are the phone support agent for Hemma, an EU home-goods store. Prices are in EUR. You are speaking, not writing: warm, plain, short. Never read out JSON, internal keys or tool names.";

const STYLE = [
  "One question at a time, and at most two short sentences before it; listing options is the only exception.",
  "No dashes of any kind, use a comma or a full stop instead.",
  "Dates: say the day exactly as the tool label gives it, for example Tuesday 8 September. Never work out a weekday yourself. Say a delivery window as 9 to 1 or 1 to 6, never 09-13.",
];

const RULES = [
  "Identify the customer first (phone number or customer reference). Every fact comes from a tool; never invent order details.",
  "When the customer describes an item or a problem, match it to the orders in the live state yourself and act: get_order, then check_resolution_options for a damaged or late order. Ask which order only when two known orders genuinely fit.",
  "Offer only the resolutions and delivery slots a tool returned, with the exact params it gave.",
  "To propose an action, call apply_resolution with customerConfirmed false; it answers NEEDS_CONFIRMATION with the sentence to read out. Read it and ask for a yes. After the yes, call it again with the same params and customerConfirmed true.",
  "After APPLIED, say it is done and read the receipt once. When the customer asks whether it went through, or asks to book or do it again, always call apply_resolution with the same params before answering, even though the live state already lists it: the ALREADY_APPLIED answer with its receipt is what you read back. Never say it is done from memory.",
  "If an option requires escalation or a tool answers ESCALATION_REQUIRED, do not apply it; call escalate_case, then give the case id and the next step it returns: who follows up and when.",
  "If a tool fails, apologise and offer to escalate.",
  "A topic switch keeps the open proposal; come back to it when the customer does. A yes applies only the proposal you asked about last, one action per customer message. A parked proposal has to be proposed again before a yes counts.",
];

function orderLine(o: Order): string {
  const items = o.items.map((i) => i.name).join(", ");
  const when =
    o.status === "delivered" && o.deliveredAt
      ? `delivered ${humanDate(o.deliveredAt)}`
      : `${o.status.replace(/_/g, " ")}, promised ${humanDate(o.promisedDeliveryDate)}${o.deliveryWindow ? ` ${o.deliveryWindow}` : ""}`;
  return `${o.id} (${items}) ${when}, EUR ${o.totalEur}`;
}

export function buildStateBlock(session: Session): string {
  const c = session.customer;
  const lines: string[] = [];
  lines.push(`Customer: ${c ? `${c.name} (ref ${c.ref}, ${c.tier}, phone ${c.phone})` : "not identified yet"}`);
  const orders = c
    ? ordersForCustomer(session.store, c.id)
        .slice()
        .sort((a, b) => (a.placedAt < b.placedAt ? 1 : -1))
    : [];
  lines.push(`Orders known (most recent first): ${orders.length ? orders.map(orderLine).join("; ") : "none"}`);
  lines.push(`Active order: ${session.activeOrderId ?? "none"}`);
  lines.push(`Pending action (waiting for an explicit yes): ${session.pending ? session.pending.summary : "none"}`);
  const parked = session.parkedProposals();
  if (parked.length) {
    lines.push(`Other open proposals (not confirmed; propose again before applying): ${parked.map((p) => p.summary).join("; ")}`);
  }
  const applied = [...session.applied.values()];
  lines.push(`Applied actions: ${applied.length ? applied.map((a) => `${a.summary ?? a.type} (receipt ${a.receipt})`).join("; ") : "none"}`);
  lines.push(`Open cases: ${session.cases.length ? session.cases.map((k) => `${k.id} for ${k.orderId}: ${k.reason}`).join("; ") : "none"}`);
  return lines.join("\n");
}

export function buildSystemPrompt(session: Session): string {
  return [
    `${PERSONA} Today is ${humanDate(today())}.`,
    "",
    `Style: ${STYLE.join(" ")}`,
    "",
    `Rules: ${RULES.join(" ")}`,
    "",
    "Live state:",
    buildStateBlock(session),
    "",
    "Playbooks:",
    ...session.playbooks.map((p) => `${p.scenario}: ${p.description} Tool order: ${p.toolOrder.join(" -> ")}.`),
  ].join("\n");
}
