import { randomUUID } from "node:crypto";
import { createStore } from "./data";
import { DEFAULT_LANG, type Lang } from "./lang";
import { assertRegistry, playbooks as livePlaybooks } from "./policies/index";
import type { ActionType, AppliedRecord, Case, Customer, DataStore, PendingAction, Playbook, ToolLogEntry } from "./types";

/** JSON with object keys sorted recursively; undefined values are dropped. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const s = JSON.stringify(value);
    return s === undefined ? "null" : s;
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** Idempotency key: `${type}:${orderId}:${stableStringify(params)}`. */
export function actionKey(type: ActionType, orderId: string, params: Record<string, unknown>): string {
  return `${type}:${orderId}:${stableStringify(params)}`;
}

export interface SessionSnapshot {
  id: string;
  /** Language the session is served in: tool labels, spoken summaries, the prompt. */
  lang: Lang;
  customer?: Customer;
  activeOrderId?: string;
  /** The proposal last put to the customer (the only one a yes can apply). */
  pending?: PendingAction;
  /** Every open proposal, including parked ones from earlier topics. */
  proposals: PendingAction[];
  applied: AppliedRecord[];
  cases: Case[];
  toolLog: ToolLogEntry[];
  lastUserUtterance: string;
  utteranceSeq: number;
}

export interface SessionOptions {
  id?: string;
  /** Language for labels, summaries and the prompt; "en" by default. */
  lang?: Lang;
  store?: DataStore;
  /** Playbook registry for this session; defaults to the live one. Tests use a scratch registry. */
  playbooks?: readonly Playbook[];
}

export class Session {
  readonly id: string;
  /**
   * Language the session is served in. Read by the tools (date labels, spoken summaries), the
   * guards (the confirmation ask) and the prompt; switched by the voice layer on a `lang` message.
   */
  lang: Lang;
  /** Per-session copy of the mock data, mutated by applied actions. */
  store: DataStore;
  /** The playbooks this session serves: the tools, the guard and the prompt all read this one. */
  readonly playbooks: readonly Playbook[];
  customer?: Customer;
  activeOrderId?: string;
  /**
   * Open proposals keyed by action key. A topic switch parks the earlier proposal here
   * instead of overwriting it. Only the proposal at `lastProposedKey` can be applied by a yes;
   * a parked one has to be proposed (asked) again first.
   */
  readonly proposals = new Map<string, PendingAction>();
  /** Key of the proposal last put to the customer, if any. */
  lastProposedKey?: string;
  /** The ledger. Applying is synchronous and in memory, so it cannot be half done. */
  readonly applied = new Map<string, AppliedRecord>();
  readonly cases: Case[] = [];
  readonly toolLog: ToolLogEntry[] = [];
  lastUserUtterance = "";
  /**
   * Counts customer utterances (bumped by setLastUserUtterance). Proposals are stamped with
   * the value at proposal time, so a yes can only apply a proposal made in an earlier utterance.
   */
  utteranceSeq = 0;
  /** utteranceSeq at the time of the last apply: at most one action is applied per utterance. */
  lastAppliedSeq?: number;
  /** toolCallId -> performance.now() at guard entry, used to measure tool ms. */
  readonly toolStarts = new Map<string, number>();

  constructor(opts: SessionOptions = {}) {
    this.id = opts.id ?? randomUUID();
    this.lang = opts.lang ?? DEFAULT_LANG;
    this.store = opts.store ?? createStore();
    this.playbooks = opts.playbooks ?? livePlaybooks;
    assertRegistry(this.playbooks);
  }

  /** The proposal last put to the customer. Parked proposals live in `proposals`. */
  get pending(): PendingAction | undefined {
    return this.lastProposedKey === undefined ? undefined : this.proposals.get(this.lastProposedKey);
  }

  setLastUserUtterance(text: string): void {
    this.lastUserUtterance = text ?? "";
    this.utteranceSeq += 1;
  }

  /** Registers a proposal (or re-asks one) and makes it the current one. */
  setProposal(pending: PendingAction): void {
    this.proposals.set(pending.key, pending);
    this.lastProposedKey = pending.key;
  }

  /**
   * Removes a proposal. When it was the current one, nothing else becomes current:
   * a parked proposal must be asked again before a yes can apply it.
   */
  clearProposal(key: string): void {
    this.proposals.delete(key);
    if (this.lastProposedKey === key) this.lastProposedKey = undefined;
  }

  /** Open proposals other than the current one. */
  parkedProposals(): PendingAction[] {
    return [...this.proposals.values()].filter((p) => p.key !== this.lastProposedKey);
  }

  snapshot(): SessionSnapshot {
    return {
      id: this.id,
      lang: this.lang,
      customer: this.customer,
      activeOrderId: this.activeOrderId,
      pending: this.pending,
      proposals: [...this.proposals.values()],
      applied: [...this.applied.values()],
      cases: [...this.cases],
      toolLog: [...this.toolLog],
      lastUserUtterance: this.lastUserUtterance,
      utteranceSeq: this.utteranceSeq,
    };
  }

  /** Back to a fresh session: new data copy, empty ledger, no customer. The registry and the language stay. */
  reset(): void {
    this.store = createStore();
    this.customer = undefined;
    this.activeOrderId = undefined;
    this.proposals.clear();
    this.lastProposedKey = undefined;
    this.applied.clear();
    this.cases.length = 0;
    this.toolLog.length = 0;
    this.toolStarts.clear();
    this.lastUserUtterance = "";
    this.utteranceSeq = 0;
    this.lastAppliedSeq = undefined;
  }
}
