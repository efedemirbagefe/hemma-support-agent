import type { Customer, DataStore, Order } from "./types";

/**
 * Seeded, deterministic mock data for Hemma. "Today" is 2026-09-03.
 * Every Session gets its own deep copy via createStore(), so applied actions
 * never leak between sessions or tests.
 */
const CUSTOMERS: Customer[] = [
  { id: "CUST-001", ref: "HM-2201", name: "Anna Weber", phone: "+49 30 1234567", tier: "vip" },
  { id: "CUST-002", ref: "HM-2305", name: "Jonas Berg", phone: "+46 70 5551212", tier: "standard" },
];

const ORDERS: Order[] = [
  {
    id: "HM-1042",
    customerId: "CUST-001",
    status: "processing",
    placedAt: "2026-09-01",
    promisedDeliveryDate: "2026-09-08",
    items: [{ sku: "SOFA-LIN-GRY", name: "Linen sofa cover, grey", nameTr: "Keten kanepe kılıfı, gri", qty: 1, unitPriceEur: 89, replacementStock: 12 }],
    totalEur: 89,
  },
  {
    id: "HM-0977",
    customerId: "CUST-001",
    status: "delivered",
    placedAt: "2026-08-21",
    promisedDeliveryDate: "2026-08-28",
    deliveredAt: "2026-08-28",
    items: [{ sku: "LAMP-ARC-BRS", name: "Arc floor lamp, brass", nameTr: "Pirinç yay ayaklı lambader", qty: 1, unitPriceEur: 240, replacementStock: 3 }],
    totalEur: 240,
  },
  {
    id: "HM-1010",
    customerId: "CUST-002",
    status: "shipped",
    placedAt: "2026-08-24",
    promisedDeliveryDate: "2026-08-30",
    items: [{ sku: "TBL-OAK-SIDE", name: "Oak side table", nameTr: "Meşe yan sehpa", qty: 1, unitPriceEur: 120, replacementStock: 0 }],
    totalEur: 120,
  },
  {
    id: "HM-1031",
    customerId: "CUST-002",
    status: "delivered",
    placedAt: "2026-08-18",
    promisedDeliveryDate: "2026-08-25",
    deliveredAt: "2026-08-25",
    items: [{ sku: "VASE-CER-SET", name: "Ceramic vase set", nameTr: "Seramik vazo seti", qty: 1, unitPriceEur: 45, replacementStock: 0 }],
    totalEur: 45,
  },
];

export function createStore(): DataStore {
  return structuredClone({ customers: CUSTOMERS, orders: ORDERS });
}

/** Keeps digits only (a leading "00" becomes "+" so "0049..." and "+49..." compare equal). */
export function normalizePhone(phone: string): string {
  const compact = phone.replace(/[^\d+]/g, "");
  const withPlus = compact.startsWith("00") ? `+${compact.slice(2)}` : compact;
  return withPlus.replace(/\+/g, "");
}

export function findCustomer(store: DataStore, query: { phone?: string; customerRef?: string }): Customer | undefined {
  const ref = query.customerRef?.trim().toUpperCase();
  if (ref) {
    const byRef = store.customers.find((c) => c.ref.toUpperCase() === ref);
    if (byRef) return byRef;
  }
  const phone = query.phone ? normalizePhone(query.phone) : "";
  // A national number ("030 1234567") matches the stored international one ("+49 30 1234567").
  const candidates = [phone, phone.replace(/^0+/, "")].filter((p) => p.length >= 6);
  if (candidates.length === 0) return undefined;
  return store.customers.find((c) => {
    const known = normalizePhone(c.phone);
    return candidates.some((p) => known === p || known.endsWith(p) || p.endsWith(known));
  });
}

export function findOrder(store: DataStore, orderId: string): Order | undefined {
  const id = orderId.trim().toUpperCase();
  return store.orders.find((o) => o.id.toUpperCase() === id);
}

export function ordersForCustomer(store: DataStore, customerId: string): Order[] {
  return store.orders.filter((o) => o.customerId === customerId);
}

export function customerForOrder(store: DataStore, order: Order): Customer | undefined {
  return store.customers.find((c) => c.id === order.customerId);
}
