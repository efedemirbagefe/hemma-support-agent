import type { Lang } from "./lang";

export type Tier = "standard" | "vip";
export type OrderStatus = "processing" | "shipped" | "out_for_delivery" | "delivered";
export type DeliveryWindow = "09-13" | "13-18";

export interface Item {
  sku: string;
  name: string;
  /**
   * Turkish product name. The catalogue is English, but a Turkish caller says "lamba", not
   * "Arc floor lamp", and the model has to match the description to a known order without
   * asking. Measured: without this, the Turkish run asked which order and then skipped the
   * case. Used by the prompt's state block and by get_order.
   */
  nameTr?: string;
  qty: number;
  unitPriceEur: number;
  replacementStock: number;
}

export interface Order {
  id: string;
  customerId: string;
  status: OrderStatus;
  placedAt: string;
  promisedDeliveryDate: string;
  /** Set once a reschedule has been applied. */
  deliveryWindow?: DeliveryWindow;
  deliveredAt?: string;
  items: Item[];
  totalEur: number;
}

export interface Customer {
  id: string;
  ref: string;
  name: string;
  phone: string;
  tier: Tier;
}

export type ActionType = "reschedule" | "replacement" | "refund" | "compensation";

export interface PendingAction {
  key: string;
  type: ActionType;
  orderId: string;
  params: Record<string, unknown>;
  summary: string;
  proposedAt: number;
  /** Session.utteranceSeq when the proposal was put to the customer. A yes only counts from a later utterance. */
  proposedTurn: number;
}

export interface AppliedRecord {
  key: string;
  type: ActionType;
  orderId: string;
  params: Record<string, unknown>;
  appliedAt: number;
  receipt: string;
  /** Spoken summary of what was applied, for the prompt state block and UI. */
  summary?: string;
}

export interface Case {
  id: string;
  orderId: string;
  reason: string;
  details: Record<string, unknown>;
  createdAt: number;
}

export interface ResolutionOption {
  type: ActionType;
  label: string;
  params: Record<string, unknown>;
  requiresEscalation: boolean;
  escalationReason?: string;
  amountEur?: number;
}

export interface ToolLogEntry {
  t: number;
  tool: string;
  args: unknown;
  ok: boolean;
  ms: number;
  blocked?: string;
}

/**
 * The scenario union is derived from the playbook registry (src/domain/policies/index.ts),
 * so adding a scenario is one playbook file plus one registry entry. Type-only re-export,
 * no runtime cycle.
 */
export type { Scenario } from "./policies/index";
export type { Lang } from "./lang";

export interface DeliverySlot {
  date: string;
  weekday: string;
  window: DeliveryWindow;
  /** Spoken label from clock.humanDate, e.g. "Friday 4 September 2026". */
  label: string;
}

export interface PlaybookContext {
  today: Date;
  delayDays: number;
  /** Session language for labels and notes; English when omitted. */
  lang?: Lang;
}

/** A playbook is data plus pure functions. No LLM involved. */
export interface Playbook<S extends string = string> {
  scenario: S;
  /** One line, shown to the model in the prompt. */
  description: string;
  /** Action types this playbook can offer; apply_resolution finds the playbook through them. */
  actionTypes: readonly ActionType[];
  /** Tool order the model is expected to follow, e.g. ["find_customer","get_order","get_delivery_slots","apply_resolution"]. */
  toolOrder: string[];
  options(order: Order, customer: Customer, ctx: PlaybookContext): ResolutionOption[];
  /** Optional one-line explanation when there are no options (or a caveat), for the tool result. */
  note?(order: Order, customer: Customer, ctx: PlaybookContext): string | undefined;
}

export interface DataStore {
  customers: Customer[];
  orders: Order[];
}
