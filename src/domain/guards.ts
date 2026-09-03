/**
 * Deterministic guards around tool calls. These are code, not prompt: the model
 * cannot talk its way past them.
 */
import type { AfterToolCallContext, AfterToolCallResult, BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import { propose, resolveAction } from "./actions";
import { findOrder } from "./data";
import type { Session } from "./session";
import type { ActionType } from "./types";

/** Small, explicit list. Matched as whole words/phrases, case-insensitive. */
export const AFFIRMATIVE_PHRASES = [
  "yes",
  "yeah",
  "yep",
  "confirm",
  "confirmed",
  "go ahead",
  "do it",
  "please do",
  "that's right",
  "correct",
  "evet",
  "tamam",
  "onaylıyorum",
] as const;

/** Any of these in the same utterance makes it non-affirmative. */
export const NEGATION_PHRASES = [
  "no",
  "nope",
  "not",
  "don't",
  "dont",
  "do not",
  "never",
  "cancel",
  "cannot",
  "can't",
  "cant",
  "won't",
  "wont",
  "wouldn't",
  "shouldn't",
  "didn't",
  "wait",
  "hold on",
  "hang on",
  "wrong",
  "correct me",
  "hayır",
  "hayir",
  "olmaz",
  "istemiyorum",
  "istemem",
  "değil",
  "degil",
  "yok",
  "bekle",
  "dur",
] as const;

function normalizeUtterance(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .split(/[^\p{L}\p{N}']+/u)
    .filter(Boolean)
    .join(" ");
}

function containsPhrase(haystack: string, phrase: string): boolean {
  return ` ${haystack} `.includes(` ${phrase} `);
}

/** A question is never a confirmation, whatever words it contains. */
function isQuestion(utterance: string): boolean {
  return /\?\s*$/.test(utterance.trim());
}

/** Pure. True only when the utterance is not a question, contains an affirmative phrase and no negation. */
export function isAffirmative(utterance: string | undefined | null): boolean {
  if (!utterance) return false;
  if (isQuestion(utterance)) return false;
  const text = normalizeUtterance(utterance);
  if (!text) return false;
  if (NEGATION_PHRASES.some((n) => containsPhrase(text, n))) return false;
  return AFFIRMATIVE_PHRASES.some((a) => containsPhrase(text, a));
}

export interface ApplyResolutionArgs {
  orderId: string;
  type: ActionType;
  params?: Record<string, unknown>;
  customerConfirmed?: boolean;
}

export interface EscalateCaseArgs {
  orderId: string;
  reason: string;
  details?: Record<string, unknown>;
}

export function normalizeReason(reason: string): string {
  return reason.trim().toLowerCase().replace(/\s+/g, " ");
}

export type ConfirmationVerdict = { ok: true } | { ok: false; why: string };

/**
 * Pure. Whether a yes from the customer may apply the action with this key right now.
 * All five conditions are about the session, none about what the model claims:
 * 1. a proposal for this exact key exists;
 * 2. it is the proposal last put to the customer (parked ones must be asked again);
 * 3. it was registered in an earlier utterance than the current one, so the customer has heard it;
 * 4. nothing else has been applied on the current utterance (one yes, one action);
 * 5. the current utterance is an explicit yes.
 */
export function confirmationVerdict(session: Session, key: string): ConfirmationVerdict {
  const proposal = session.proposals.get(key);
  if (!proposal) return { ok: false, why: "no proposal for this exact action has been put to the customer yet" };
  if (session.lastProposedKey !== key) {
    return { ok: false, why: "this is not the proposal you asked about last, so the customer's answer cannot refer to it; ask about it again" };
  }
  if (proposal.proposedTurn >= session.utteranceSeq) {
    return { ok: false, why: "this proposal was registered during the current turn, so the customer has not heard it yet; read it out and wait for their answer" };
  }
  if (session.lastAppliedSeq !== undefined && session.lastAppliedSeq >= session.utteranceSeq) {
    return { ok: false, why: "another action was already applied on this customer message; ask about this one and wait for a fresh yes" };
  }
  if (!isAffirmative(session.lastUserUtterance)) return { ok: false, why: "the last customer message is not an explicit yes" };
  return { ok: true };
}

function block(session: Session, toolName: string, args: unknown, reason: string): BeforeToolCallResult {
  session.toolLog.push({ t: Date.now(), tool: toolName, args, ok: false, ms: 0, blocked: reason });
  return { block: true, reason };
}

/** Pure decision for apply_resolution: undefined = allowed, string = block reason. */
export function applyResolutionBlockReason(session: Session, args: ApplyResolutionArgs): string | undefined {
  const resolved = resolveAction(session, args.orderId, args.type, args.params);
  if (!resolved.ok) return `BLOCKED: ${resolved.reason}`;
  const applied = session.applied.get(resolved.key);
  if (applied) {
    return `ALREADY_APPLIED: this was already done (receipt ${applied.receipt}): ${applied.summary ?? resolved.option.label}. Tell the customer it is already done and do not retry.`;
  }
  if (resolved.option.requiresEscalation) {
    return `ESCALATION_REQUIRED: ${resolved.option.escalationReason ?? "this option needs a human agent"}. Do not apply it. Call escalate_case with the order id and reason, then tell the customer a colleague will follow up.`;
  }
  const verdict = confirmationVerdict(session, resolved.key);
  if (!verdict.ok) {
    const pending = propose(session, resolved.order, resolved.option, resolved.key, resolved.params);
    return `NEEDS_CONFIRMATION: ${verdict.why}. Ask them: "${pending.summary} Shall I go ahead?" and call apply_resolution again only after they say yes.`;
  }
  return undefined;
}

/**
 * Pure decision for escalate_case: undefined = allowed, string = block reason.
 * The order must exist (a misheard id must not become a real-looking case id) and there is
 * one case per order per session.
 */
export function escalateCaseBlockReason(session: Session, args: EscalateCaseArgs): string | undefined {
  const order = findOrder(session.store, args.orderId ?? "");
  if (!order) {
    return `BLOCKED: No order ${args.orderId ?? ""}. No case was opened; check the order id with find_customer or get_order first.`;
  }
  const orderId = order.id;
  const existing = session.cases.find((c) => c.orderId.toUpperCase() === orderId);
  if (existing) {
    return `ALREADY_APPLIED: case ${existing.id} is already open for order ${existing.orderId} (${existing.reason}). Tell the customer the case number and do not open another one.`;
  }
  return undefined;
}

export function makeBeforeToolCall(session: Session) {
  return async (ctx: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
    session.toolStarts.set(ctx.toolCall.id, performance.now());
    const name = ctx.toolCall.name;
    let reason: string | undefined;
    if (name === "apply_resolution") {
      reason = applyResolutionBlockReason(session, ctx.args as ApplyResolutionArgs);
    } else if (name === "escalate_case") {
      reason = escalateCaseBlockReason(session, ctx.args as EscalateCaseArgs);
    }
    if (reason !== undefined) {
      session.toolStarts.delete(ctx.toolCall.id);
      return block(session, name, ctx.args, reason);
    }
    return undefined;
  };
}

export function makeAfterToolCall(session: Session) {
  return async (ctx: AfterToolCallContext): Promise<AfterToolCallResult | undefined> => {
    const started = session.toolStarts.get(ctx.toolCall.id);
    session.toolStarts.delete(ctx.toolCall.id);
    const ms = started === undefined ? 0 : Math.round(performance.now() - started);
    session.toolLog.push({ t: Date.now(), tool: ctx.toolCall.name, args: ctx.args, ok: !ctx.isError, ms });
    return undefined;
  };
}
