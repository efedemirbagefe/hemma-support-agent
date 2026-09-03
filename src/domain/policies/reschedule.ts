import { addDays, humanDate, isSunday, isoDate, weekdayName } from "../clock";
import type { DeliverySlot, DeliveryWindow, Order, Playbook } from "../types";

export const DELIVERY_WINDOWS: DeliveryWindow[] = ["09-13", "13-18"];

export function windowLabel(window: DeliveryWindow | string): string {
  return window === "09-13" ? "morning 09-13" : "afternoon 13-18";
}

/** Next 7 days after `today`, skipping Sunday, two windows per day. */
export function deliverySlots(today: Date): DeliverySlot[] {
  const slots: DeliverySlot[] = [];
  for (let i = 1; i <= 7; i++) {
    const day = addDays(today, i);
    if (isSunday(day)) continue;
    for (const window of DELIVERY_WINDOWS) {
      slots.push({ date: isoDate(day), weekday: weekdayName(day), window, label: humanDate(day) });
    }
  }
  return slots;
}

export function canReschedule(order: Order): boolean {
  return order.status === "processing";
}

export function rescheduleBlockedReason(order: Order): string | undefined {
  if (canReschedule(order)) return undefined;
  const state = order.status === "delivered" ? "already delivered" : `already ${order.status.replace(/_/g, " ")}`;
  return `Order ${order.id} is ${state}, so its delivery can no longer be rescheduled.`;
}

export const reschedulePlaybook: Playbook<"reschedule"> = {
  scenario: "reschedule",
  description:
    "Reschedule delivery: only while the order is still processing; offer only the slots get_delivery_slots returns; the customer must confirm the exact slot before it is applied.",
  actionTypes: ["reschedule"],
  toolOrder: ["find_customer", "get_order", "get_delivery_slots", "apply_resolution"],
  options(order, _customer, ctx) {
    if (!canReschedule(order)) return [];
    return deliverySlots(ctx.today).map((slot) => ({
      type: "reschedule",
      label: `${slot.label}, ${windowLabel(slot.window)}`,
      params: { date: slot.date, window: slot.window },
      requiresEscalation: false,
    }));
  },
  note(order) {
    return rescheduleBlockedReason(order);
  },
};
