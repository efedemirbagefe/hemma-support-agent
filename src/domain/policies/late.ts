import { humanDate } from "../clock";
import type { Playbook, Tier } from "../types";

export const LATE_THRESHOLD_DAYS: Record<Tier, number> = { vip: 2, standard: 4 };
export const COMPENSATION_AUTO_LIMIT_EUR = 50;

export function lateThreshold(tier: Tier): number {
  return LATE_THRESHOLD_DAYS[tier];
}

/** EUR 15 at the threshold, plus EUR 10 per extra day; undefined when not eligible. */
export function compensationFor(delayDays: number, tier: Tier): number | undefined {
  const threshold = lateThreshold(tier);
  if (delayDays < threshold) return undefined;
  return Math.round(15 + 10 * (delayDays - threshold));
}

/** Spoken delay sentence with the dates labelled, never a bare ISO date. */
export function delayText(promisedDeliveryDate: string, delayDays: number, asOf: Date | string): string {
  const days = delayDays === 1 ? "1 day" : `${delayDays} days`;
  return `promised for ${humanDate(promisedDeliveryDate)}, ${days} late as of ${humanDate(asOf)}`;
}

export const latePlaybook: Playbook<"late"> = {
  scenario: "late",
  description:
    "Late delivery: compensation once the delay reaches 2 days for VIP or 4 days for standard customers (EUR 15, plus EUR 10 per extra day); above EUR 50 it must be escalated to a human; the customer must confirm before it is applied.",
  actionTypes: ["compensation"],
  toolOrder: ["find_customer", "get_order", "check_resolution_options", "apply_resolution"],
  options(order, customer, ctx) {
    const amountEur = compensationFor(ctx.delayDays, customer.tier);
    if (amountEur === undefined) return [];
    const requiresEscalation = amountEur > COMPENSATION_AUTO_LIMIT_EUR;
    return [
      {
        type: "compensation",
        label: `EUR ${amountEur} compensation for order ${order.id}, ${delayText(order.promisedDeliveryDate, ctx.delayDays, ctx.today)}`,
        params: { amountEur },
        amountEur,
        requiresEscalation,
        ...(requiresEscalation
          ? {
              escalationReason: `Compensation EUR ${amountEur} is above the EUR ${COMPENSATION_AUTO_LIMIT_EUR} limit for automatic resolution; a human agent has to approve it.`,
            }
          : {}),
      },
    ];
  },
  note(order, customer, ctx) {
    const threshold = lateThreshold(customer.tier);
    if (ctx.delayDays < threshold) {
      return `Order ${order.id} was ${delayText(order.promisedDeliveryDate, ctx.delayDays, ctx.today)}; ${customer.tier} customers become eligible for compensation at ${threshold} days.`;
    }
    return undefined;
  },
};
