/**
 * Drop-in playbook "wrong_item": the customer received a different item than ordered.
 * Options: a replacement of the ordered item when replacement stock exists, otherwise a
 * refund; an order total above EUR 200 must be escalated to a human, never applied; the
 * customer must confirm before anything is applied.
 *
 * Pure data plus functions, no LLM. Lives outside src/ so the live registry does not serve
 * it; examples/scenarios/README.md has the three commands that put it live.
 */
import type { Playbook, ResolutionOption } from "../../src/domain/types";

/** Orders above this total cannot be resolved automatically. */
export const WRONG_ITEM_ESCALATION_LIMIT_EUR = 200;

export const wrongItemPlaybook: Playbook<"wrong_item"> = {
  scenario: "wrong_item",
  description:
    "Wrong item delivered: send the item that was ordered when replacement stock exists, otherwise refund it; an order total above EUR 200 must be escalated to a human, never applied; the customer must confirm before it is applied.",
  actionTypes: ["replacement", "refund"],
  toolOrder: ["find_customer", "get_order", "check_resolution_options", "apply_resolution"],
  options(order) {
    const requiresEscalation = order.totalEur > WRONG_ITEM_ESCALATION_LIMIT_EUR;
    const escalation = requiresEscalation
      ? {
          escalationReason: `Order total EUR ${order.totalEur} is above the EUR ${WRONG_ITEM_ESCALATION_LIMIT_EUR} limit for automatic resolution; a human agent has to approve it.`,
        }
      : {};
    return order.items.map((item): ResolutionOption => {
      if (item.replacementStock > 0) {
        return {
          type: "replacement",
          label: `Send the ordered ${item.name} (${item.replacementStock} in stock) and collect the wrong item`,
          params: { sku: item.sku },
          requiresEscalation,
          ...escalation,
        };
      }
      const amountEur = Math.round(item.qty * item.unitPriceEur * 100) / 100;
      return {
        type: "refund",
        label: `Refund EUR ${amountEur} for ${item.name} (no stock to send the right one) and collect the wrong item`,
        params: { sku: item.sku },
        amountEur,
        requiresEscalation,
        ...escalation,
      };
    });
  },
  note(order) {
    if (order.status !== "delivered") {
      return `Order ${order.id} is ${order.status.replace(/_/g, " ")}, not delivered yet; a wrong item can only be reported after delivery.`;
    }
    return undefined;
  },
};
