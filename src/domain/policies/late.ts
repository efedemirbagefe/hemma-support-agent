import { humanDate } from "../clock";
import { DEFAULT_LANG, type Lang } from "../lang";
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

/** Spoken delay sentence with the dates labelled in `lang`, never a bare ISO date. */
export function delayText(promisedDeliveryDate: string, delayDays: number, asOf: Date | string, lang: Lang = DEFAULT_LANG): string {
  if (lang === "tr") {
    return `söz verilen teslimat ${humanDate(promisedDeliveryDate, "tr")}, ${humanDate(asOf, "tr")} itibarıyla ${delayDays} gün gecikmiş`;
  }
  const days = delayDays === 1 ? "1 day" : `${delayDays} days`;
  return `promised for ${humanDate(promisedDeliveryDate)}, ${days} late as of ${humanDate(asOf)}`;
}

function tierLabel(tier: Tier, lang: Lang): string {
  if (lang === "tr") return tier === "vip" ? "VIP" : "standart";
  return tier;
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
    const lang = ctx.lang ?? DEFAULT_LANG;
    const requiresEscalation = amountEur > COMPENSATION_AUTO_LIMIT_EUR;
    const delay = delayText(order.promisedDeliveryDate, ctx.delayDays, ctx.today, lang);
    const label = lang === "tr" ? `${order.id} numaralı sipariş için EUR ${amountEur} telafi, ${delay}` : `EUR ${amountEur} compensation for order ${order.id}, ${delay}`;
    const escalationReason =
      lang === "tr"
        ? `EUR ${amountEur} telafi, otomatik çözüm için EUR ${COMPENSATION_AUTO_LIMIT_EUR} sınırının üzerinde; bir insan görevlinin onayı gerekir.`
        : `Compensation EUR ${amountEur} is above the EUR ${COMPENSATION_AUTO_LIMIT_EUR} limit for automatic resolution; a human agent has to approve it.`;
    return [
      {
        type: "compensation",
        label,
        params: { amountEur },
        amountEur,
        requiresEscalation,
        ...(requiresEscalation ? { escalationReason } : {}),
      },
    ];
  },
  note(order, customer, ctx) {
    const threshold = lateThreshold(customer.tier);
    if (ctx.delayDays < threshold) {
      const lang = ctx.lang ?? DEFAULT_LANG;
      const delay = delayText(order.promisedDeliveryDate, ctx.delayDays, ctx.today, lang);
      if (lang === "tr") {
        return `${order.id} numaralı sipariş ${delay}; ${tierLabel(customer.tier, lang)} müşteriler ${threshold} günlük gecikmede telafiye hak kazanır.`;
      }
      return `Order ${order.id} was ${delay}; ${customer.tier} customers become eligible for compensation at ${threshold} days.`;
    }
    return undefined;
  },
};
