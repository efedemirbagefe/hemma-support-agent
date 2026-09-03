import { addDays, humanDate, isSunday, isoDate, weekdayName } from "../clock";
import { DEFAULT_LANG, type Lang } from "../lang";
import type { DeliverySlot, DeliveryWindow, Order, Playbook } from "../types";

export const DELIVERY_WINDOWS: DeliveryWindow[] = ["09-13", "13-18"];

export function windowLabel(window: DeliveryWindow | string, lang: Lang = DEFAULT_LANG): string {
  if (lang === "tr") return window === "09-13" ? "sabah 09-13" : "öğleden sonra 13-18";
  return window === "09-13" ? "morning 09-13" : "afternoon 13-18";
}

/** Next 7 days after `today`, skipping Sunday, two windows per day; weekday and label in `lang`. */
export function deliverySlots(today: Date, lang: Lang = DEFAULT_LANG): DeliverySlot[] {
  const slots: DeliverySlot[] = [];
  for (let i = 1; i <= 7; i++) {
    const day = addDays(today, i);
    if (isSunday(day)) continue;
    for (const window of DELIVERY_WINDOWS) {
      slots.push({ date: isoDate(day), weekday: weekdayName(day, lang), window, label: humanDate(day, lang) });
    }
  }
  return slots;
}

export function canReschedule(order: Order): boolean {
  return order.status === "processing";
}

export function rescheduleBlockedReason(order: Order, lang: Lang = DEFAULT_LANG): string | undefined {
  if (canReschedule(order)) return undefined;
  if (lang === "tr") {
    const state =
      order.status === "delivered" ? "zaten teslim edildi" : order.status === "shipped" ? "zaten kargoya verildi" : "zaten dağıtımda";
    return `${order.id} numaralı sipariş ${state}, bu yüzden teslimatı artık değiştirilemez.`;
  }
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
    const lang = ctx.lang ?? DEFAULT_LANG;
    return deliverySlots(ctx.today, lang).map((slot) => ({
      type: "reschedule",
      label: `${slot.label}, ${windowLabel(slot.window, lang)}`,
      params: { date: slot.date, window: slot.window },
      requiresEscalation: false,
    }));
  },
  note(order, _customer, ctx) {
    return rescheduleBlockedReason(order, ctx.lang);
  },
};
