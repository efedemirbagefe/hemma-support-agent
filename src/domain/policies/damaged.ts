import type { Playbook, ResolutionOption } from "../types";

/** Orders above this total cannot be resolved automatically. */
export const DAMAGED_ESCALATION_LIMIT_EUR = 200;

export const damagedPlaybook: Playbook<"damaged"> = {
  scenario: "damaged",
  description:
    "Damaged item: a replacement when replacement stock exists, otherwise a refund; an order total above EUR 200 must be escalated to a human, never applied; the customer must confirm before it is applied.",
  actionTypes: ["replacement", "refund"],
  toolOrder: ["find_customer", "get_order", "check_resolution_options", "apply_resolution"],
  options(order) {
    const requiresEscalation = order.totalEur > DAMAGED_ESCALATION_LIMIT_EUR;
    const escalation = requiresEscalation
      ? {
          escalationReason: `Order total EUR ${order.totalEur} is above the EUR ${DAMAGED_ESCALATION_LIMIT_EUR} limit for automatic resolution; a human agent has to approve it.`,
        }
      : {};
    return order.items.map((item): ResolutionOption => {
      if (item.replacementStock > 0) {
        return {
          type: "replacement",
          label: `Send a replacement ${item.name} (${item.replacementStock} in stock)`,
          params: { sku: item.sku },
          requiresEscalation,
          ...escalation,
        };
      }
      const amountEur = Math.round(item.qty * item.unitPriceEur * 100) / 100;
      return {
        type: "refund",
        label: `Refund EUR ${amountEur} for ${item.name} (no replacement stock)`,
        params: { sku: item.sku },
        amountEur,
        requiresEscalation,
        ...escalation,
      };
    });
  },
};
