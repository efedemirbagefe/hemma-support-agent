/**
 * The 8-step demo as data plus pure evaluators, so the same script can be checked three ways:
 * scripts/demo-check.ts runs it over the WebSocket against a running server (text mode),
 * tests/live.test.ts runs it in-process against the real model, and tests/domain.test.ts
 * checks the evaluators with synthetic turns. Step order follows the brief:
 *   1 most recent order, 2 barge-in (voice only), 3 damaged lamp from the earlier order,
 *   4 escalation decided, 5 back to the sofa cover and Friday, 6 slots and the Friday morning
 *   choice, 7 confirmation and APPLIED, 8 a retry that must hit ALREADY_APPLIED.
 */
import { today, weekdayName } from "../domain/clock";
import type { SessionSnapshot } from "../domain/session";
import { hasDash } from "./speech";

export type ToolPhase = "start" | "end" | "blocked";

/** One tool call as the client sees it: the start args merged with the end/blocked detail. */
export interface ToolSeen {
  name: string;
  phase: ToolPhase;
  args?: unknown;
  /** First 400 chars of the result JSON (phase end) or the guard's block reason (phase blocked). */
  detail?: string;
  error?: boolean;
  ms?: number;
}

export interface TurnRecord {
  step: number;
  user: string;
  /** True for the one tolerated clarifying turn of a step. */
  extra: boolean;
  text: string;
  tools: ToolSeen[];
  state?: SessionSnapshot;
  firstTokenMs: number | null;
  totalMs: number | null;
  errors: string[];
}

export type Verdict = "PASS" | "WARN" | "FAIL" | "SKIP";

export interface StepResult {
  verdict: Verdict;
  notes: string[];
  /** A line to send as the one tolerated extra turn, when the first turn was inconclusive. */
  extra?: string;
}

export interface DemoStep {
  n: number;
  title: string;
  say?: string;
  /** Set for steps that cannot run in text mode; the step is reported as SKIP with this note. */
  voiceOnly?: string;
  /** First step whose turns this evaluation covers (defaults to n). Step 4 reads the turns since step 3. */
  since?: number;
  evaluate(turns: TurnRecord[], all: TurnRecord[]): StepResult;
}

export interface StepReport {
  n: number;
  title: string;
  say?: string;
  verdict: Verdict;
  notes: string[];
  tools: string[];
  firstTokenMs: number | null;
  totalMs: number | null;
}

export interface LatencySummary {
  samples: number;
  firstTokenMs: { p50: number | null; p95: number | null };
  totalMs: { p50: number | null; p95: number | null };
}

export interface DemoReport {
  steps: StepReport[];
  turns: TurnRecord[];
  latency: LatencySummary;
  failures: number;
  warnings: number;
  ok: boolean;
}

export const ANNA = { name: "Anna Weber", ref: "HM-2201", phone: "+49 30 1234567" } as const;
export const RECENT_ORDER = "HM-1042";
export const LAMP_ORDER = "HM-0977";
export const FRIDAY_MORNING = { date: "2026-09-04", window: "09-13" } as const;
const FILLER_HINT = /one moment, let me check/i;

// ---------------------------------------------------------------- tool helpers

export function mergeToolEvent(tools: ToolSeen[], ev: { name: string; phase: ToolPhase; args?: unknown; detail?: string; error?: boolean; ms?: number }): void {
  if (ev.phase === "start") {
    tools.push({ name: ev.name, phase: "start", args: ev.args });
    return;
  }
  const open = [...tools].reverse().find((t) => t.name === ev.name && t.phase === "start");
  if (open) {
    open.phase = ev.phase;
    open.detail = ev.detail;
    open.error = ev.error;
    open.ms = ev.ms;
    return;
  }
  tools.push({ name: ev.name, phase: ev.phase, detail: ev.detail, error: ev.error, ms: ev.ms });
}

/** Phase of a finished in-process tool call: a guard block reads as an error whose text starts with the reason tag. */
export function phaseFromResult(text: string, isError: boolean): ToolPhase {
  return isError && /^(NEEDS_CONFIRMATION|ALREADY_APPLIED|ESCALATION_REQUIRED|BLOCKED):/.test(text) ? "blocked" : "end";
}

function calls(turns: TurnRecord[], name: string): ToolSeen[] {
  return turns.flatMap((t) => t.tools).filter((t) => t.name === name);
}

function argOrderId(t: ToolSeen): string | undefined {
  const a = t.args as { orderId?: unknown } | undefined;
  return typeof a?.orderId === "string" ? a.orderId.trim().toUpperCase() : undefined;
}

function argIssue(t: ToolSeen): string | undefined {
  const a = t.args as { issue?: unknown } | undefined;
  return typeof a?.issue === "string" ? a.issue : undefined;
}

/** Status tag of an apply_resolution call: the guard's prefix when blocked, the JSON status when it ran. */
export function applyStatus(t: ToolSeen): string | undefined {
  if (t.name !== "apply_resolution") return undefined;
  const d = t.detail ?? "";
  if (t.phase === "blocked") return /^([A-Z_]+):/.exec(d)?.[1];
  if (t.phase === "end") return /"status":"([A-Z_]+)"/.exec(d)?.[1];
  return undefined;
}

export function receiptIn(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  return /"receipt":"([^"]+)"/.exec(detail)?.[1] ?? /receipt (RCP-[\w-]+)/.exec(detail)?.[1];
}

function lastState(turns: TurnRecord[]): SessionSnapshot | undefined {
  return [...turns].reverse().find((t) => t.state)?.state;
}

function lastText(turns: TurnRecord[]): string {
  return turns[turns.length - 1]?.text ?? "";
}

function countOf(text: string, needle: string): number {
  if (!needle) return 0;
  return text.split(needle).length - 1;
}

function ok(t: ToolSeen): boolean {
  return t.phase === "end" && !t.error;
}

// ---------------------------------------------------------------- text lints

const WEEKDAY_RE = "(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)";
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_RE = "(January|February|March|April|May|June|July|August|September|October|November|December)";
const DAY_RE = "(\\d{1,2})(?:st|nd|rd|th)?";
const YEAR_RE = "(?:,?\\s+(\\d{4}))?";
const DAY_FIRST = new RegExp(`\\b${WEEKDAY_RE},?\\s+(?:the\\s+)?${DAY_RE}\\s+(?:of\\s+)?${MONTH_RE}${YEAR_RE}`, "gi");
const MONTH_FIRST = new RegExp(`\\b${WEEKDAY_RE},?\\s+${MONTH_RE}\\s+(?:the\\s+)?${DAY_RE}${YEAR_RE}`, "gi");

/**
 * Every "weekday + date" the agent says, checked against the calendar. Returns one line per
 * mismatch, e.g. `"Monday the 8th of September" is a Tuesday`. Year defaults to today's year.
 */
export function weekdayMismatches(text: string, defaultYear = today().getUTCFullYear()): string[] {
  const out: string[] = [];
  const check = (whole: string, claimed: string, day: number, month: string, year?: string) => {
    const monthIdx = MONTHS.indexOf(month.toLowerCase());
    if (monthIdx < 0 || day < 1 || day > 31) return;
    const date = new Date(Date.UTC(year ? Number(year) : defaultYear, monthIdx, day));
    if (date.getUTCDate() !== day) return; // e.g. 31 September
    const actual = weekdayName(date);
    if (actual.toLowerCase() !== claimed.toLowerCase()) out.push(`"${whole}" is a ${actual}`);
  };
  for (const m of text.matchAll(DAY_FIRST)) check(m[0], m[1], Number(m[2]), m[3], m[4]);
  for (const m of text.matchAll(MONTH_FIRST)) check(m[0], m[1], Number(m[3]), m[2], m[4]);
  return out;
}

/** Lints that apply to every turn whatever the step. FAIL notes are prefixed "FAIL:", the rest are warnings. */
export function lintTurn(turn: TurnRecord, opts: { textMode: boolean }): string[] {
  const notes: string[] = [];
  for (const e of turn.errors) notes.push(`FAIL: error event: ${e}`);
  for (const m of weekdayMismatches(turn.text)) notes.push(`FAIL: wrong weekday: ${m}`);
  if (hasDash(turn.text)) notes.push("FAIL: dash in spoken text");
  if (opts.textMode && FILLER_HINT.test(turn.text)) notes.push("filler spoken in a text turn (voice layer: filler should be voice-only)");
  return notes;
}

// ---------------------------------------------------------------- steps

function fail(...notes: string[]): StepResult {
  return { verdict: "FAIL", notes };
}

function done(notes: string[], verdict: Verdict = "PASS"): StepResult {
  return { verdict, notes };
}

export const DEMO_STEPS: DemoStep[] = [
  {
    n: 1,
    title: "Most recent order",
    say: `Hi, this is ${ANNA.name}, my customer number is ${ANNA.ref}. What's happening with my most recent order?`,
    evaluate(turns) {
      const notes: string[] = [];
      const found = calls(turns, "find_customer").some(ok);
      if (!found) {
        if (turns.length === 1 && !turns[0].extra) {
          return { verdict: "FAIL", notes: ["find_customer not called"], extra: `My phone number is ${ANNA.phone}.` };
        }
        return fail("find_customer never ran");
      }
      const state = lastState(turns);
      if (state?.customer?.ref !== ANNA.ref) return fail(`customer in state is ${state?.customer?.ref ?? "none"}, expected ${ANNA.ref}`);
      if (calls(turns, "apply_resolution").length || calls(turns, "escalate_case").length) return fail("an action tool ran in the identification turn");
      let verdict: Verdict = "PASS";
      if (!calls(turns, "get_order").some((c) => ok(c) && argOrderId(c) === RECENT_ORDER)) {
        notes.push(`get_order ${RECENT_ORDER} not called; answered from find_customer's order list, which carries status, items and the labelled date`);
      }
      const text = turns.map((t) => t.text).join(" ");
      if (!/sofa cover|HM-1042|1042/i.test(text)) {
        verdict = "WARN";
        notes.push("answer does not name the most recent order (sofa cover, HM-1042)");
      }
      return done(notes, verdict);
    },
  },
  {
    n: 2,
    title: "Barge-in while the agent reads the slots",
    voiceOnly: "voice only: barge-in needs live audio (Deepgram SpeechStarted); covered by scratch/voice-smoke.ts, not reproducible in text mode",
    evaluate() {
      return { verdict: "SKIP", notes: [] };
    },
  },
  {
    n: 3,
    title: "Damaged lamp from the earlier order",
    say: "Actually, something else first. A lamp from an earlier order arrived damaged, the base is dented.",
    evaluate(turns) {
      if (calls(turns, "apply_resolution").length) return fail("apply_resolution was called for the lamp; the EUR 240 order must go straight to escalation");
      const lamp = calls(turns, "get_order").some((c) => ok(c) && argOrderId(c) === LAMP_ORDER);
      if (!lamp) {
        const asked = /\?\s*$/.test(lastText(turns).trim());
        if (turns.length === 1 && !turns[0].extra && asked) {
          return { verdict: "FAIL", notes: [`asked which order instead of matching the lamp to ${LAMP_ORDER} from the known orders`], extra: "The brass floor lamp, from my earlier order." };
        }
        return fail(`get_order ${LAMP_ORDER} not called`);
      }
      return done([]);
    },
  },
  {
    n: 4,
    title: "Escalation decided (EUR 240 > 200)",
    since: 3,
    evaluate(turns) {
      const notes: string[] = [];
      if (calls(turns, "apply_resolution").length) return fail("apply_resolution was called on the escalation path");
      const state = lastState(turns);
      const cases = (state?.cases ?? []).filter((c) => c.orderId.toUpperCase() === LAMP_ORDER);
      const escalated = calls(turns, "escalate_case").filter((c) => argOrderId(c) === LAMP_ORDER && c.phase !== "start");
      if (cases.length !== 1) {
        const own = turns.filter((t) => t.step === 4);
        if (escalated.length === 0 && own.length === 0) {
          return { verdict: "FAIL", notes: ["no case opened for the lamp"], extra: "Yes, please do." };
        }
        return fail(`expected exactly one case for ${LAMP_ORDER}, state has ${cases.length}`);
      }
      if ((state?.applied.length ?? 0) !== 0) return fail("something was applied on the escalation path");
      let verdict: Verdict = "PASS";
      const all = turns.flatMap((t) => t.tools);
      const iOrder = all.findIndex((c) => c.name === "get_order" && argOrderId(c) === LAMP_ORDER);
      const iCheck = all.findIndex((c) => c.name === "check_resolution_options" && argOrderId(c) === LAMP_ORDER && argIssue(c) === "damaged");
      const iEsc = all.findIndex((c) => c.name === "escalate_case" && argOrderId(c) === LAMP_ORDER);
      if (iCheck < 0) {
        verdict = "WARN";
        notes.push("escalated without check_resolution_options (policy not consulted)");
      } else if (!(iOrder < iCheck && iCheck < iEsc)) {
        verdict = "WARN";
        notes.push("tool order was not get_order -> check_resolution_options -> escalate_case");
      }
      const text = turns.map((t) => t.text).join(" ");
      if (!text.includes(cases[0].id)) {
        verdict = "WARN";
        notes.push(`case id ${cases[0].id} not read out`);
      }
      if (!/colleague|business day|call(s|ed)? you back|get back to you/i.test(text)) {
        verdict = "WARN";
        notes.push("next step after the escalation (who follows up, when) not stated");
      }
      return done(notes, verdict);
    },
  },
  {
    n: 5,
    title: "Back to the sofa cover: move delivery to Friday",
    say: "Thanks. Now back to the sofa cover. Can you move the delivery to Friday?",
    evaluate(turns) {
      const notes: string[] = [];
      const slots = calls(turns, "get_delivery_slots").some((c) => ok(c) && argOrderId(c) === RECENT_ORDER);
      if (!slots) {
        const asked = /\?\s*$/.test(lastText(turns).trim());
        if (turns.length === 1 && !turns[0].extra && asked) {
          return { verdict: "FAIL", notes: ["get_delivery_slots not called"], extra: `The sofa cover, order ${RECENT_ORDER}.` };
        }
        return fail(`get_delivery_slots ${RECENT_ORDER} not called`);
      }
      const state = lastState(turns);
      if ((state?.applied.length ?? 0) !== 0) return fail("a reschedule was applied without a yes");
      let verdict: Verdict = "PASS";
      if (calls(turns, "apply_resolution").some((c) => applyStatus(c) === "NEEDS_CONFIRMATION")) notes.push("proposed a Friday slot right away (NEEDS_CONFIRMATION registered)");
      if (!/friday/i.test(turns.map((t) => t.text).join(" "))) {
        verdict = "WARN";
        notes.push("Friday not mentioned in the answer");
      }
      return done(notes, verdict);
    },
  },
  {
    n: 6,
    title: "Friday morning chosen, proposal registered",
    say: "The morning slot on Friday, please.",
    evaluate(turns, all) {
      const notes: string[] = [];
      const state = lastState(turns);
      if ((state?.applied.length ?? 0) !== 0) return fail("applied before the customer said yes");
      const pending = state?.pending;
      const right = pending && pending.orderId === RECENT_ORDER && pending.params.date === FRIDAY_MORNING.date && pending.params.window === FRIDAY_MORNING.window;
      if (!right) {
        if (turns.length === 1 && !turns[0].extra) {
          return {
            verdict: "FAIL",
            notes: [pending ? `pending is ${pending.orderId} ${JSON.stringify(pending.params)}, expected Friday 09-13` : "no pending proposal"],
            extra: "Friday morning, 9 to 1.",
          };
        }
        return fail(pending ? `pending is ${pending.orderId} ${JSON.stringify(pending.params)}, expected ${RECENT_ORDER} Friday 09-13` : "no pending proposal registered");
      }
      let verdict: Verdict = "PASS";
      const here = calls(turns, "apply_resolution").some((c) => applyStatus(c) === "NEEDS_CONFIRMATION");
      if (!here) {
        const earlier = calls(all.filter((t) => t.step === 5), "apply_resolution").some((c) => applyStatus(c) === "NEEDS_CONFIRMATION");
        verdict = "WARN";
        notes.push(earlier ? "NEEDS_CONFIRMATION was registered in step 5, this turn re-asked in words" : "no NEEDS_CONFIRMATION seen in this step");
      }
      if (!/\?\s*$/.test(lastText(turns).trim())) {
        verdict = "WARN";
        notes.push("did not end on a question asking for the yes");
      }
      return done(notes, verdict);
    },
  },
  {
    n: 7,
    title: "Yes: applied once with a receipt",
    say: "Yes, go ahead.",
    evaluate(turns) {
      const notes: string[] = [];
      const state = lastState(turns);
      const applied = state?.applied ?? [];
      if (applied.length === 0) {
        const reasked = calls(turns, "apply_resolution").some((c) => applyStatus(c) === "NEEDS_CONFIRMATION");
        if (turns.length === 1 && !turns[0].extra && reasked) {
          return { verdict: "FAIL", notes: ["asked for confirmation again instead of applying"], extra: "Yes, go ahead." };
        }
        return fail("nothing applied after the yes");
      }
      if (applied.length !== 1) return fail(`ledger has ${applied.length} entries, expected 1`);
      const a = applied[0];
      if (a.orderId !== RECENT_ORDER || a.type !== "reschedule" || a.params.date !== FRIDAY_MORNING.date || a.params.window !== FRIDAY_MORNING.window) {
        return fail(`applied ${a.type} ${a.orderId} ${JSON.stringify(a.params)}, expected reschedule ${RECENT_ORDER} Friday 09-13`);
      }
      if (!/^RCP-/.test(a.receipt)) return fail(`receipt ${a.receipt} does not look like a receipt`);
      if (!calls(turns, "apply_resolution").some((c) => applyStatus(c) === "APPLIED")) return fail("APPLIED not seen on the tool stream although the ledger grew");
      let verdict: Verdict = "PASS";
      const text = turns.map((t) => t.text).join(" ");
      const n = countOf(text, a.receipt);
      if (n === 0) {
        verdict = "WARN";
        notes.push(`receipt ${a.receipt} not read back`);
      } else if (n > 1) {
        verdict = "WARN";
        notes.push(`receipt read back ${n} times`);
      }
      if (state?.pending) {
        verdict = "WARN";
        notes.push(`a proposal is still pending after the apply: ${state.pending.summary}`);
      }
      return done(notes, verdict);
    },
  },
  {
    n: 8,
    title: "Retry: ALREADY_APPLIED, ledger unchanged",
    say: "Sorry, did that go through? Book Friday morning again just to be safe.",
    evaluate(turns, all) {
      const notes: string[] = [];
      const state = lastState(turns);
      const applied = state?.applied ?? [];
      if (applied.length !== 1) return fail(`ledger has ${applied.length} entries after the retry, expected 1`);
      const applies = calls(turns, "apply_resolution");
      if (applies.some((c) => applyStatus(c) === "APPLIED")) return fail("APPLIED seen on the retry");
      const already = applies.filter((c) => applyStatus(c) === "ALREADY_APPLIED");
      if (already.length === 0) {
        return fail(applies.length ? `apply_resolution answered ${applies.map((c) => applyStatus(c) ?? c.phase).join(", ")}, not ALREADY_APPLIED` : "ALREADY_APPLIED path not exercised: apply_resolution was not called on the retry");
      }
      let verdict: Verdict = "PASS";
      const receipt = applied[0].receipt;
      const text = turns.map((t) => t.text).join(" ");
      if (!text.includes(receipt)) {
        verdict = "WARN";
        notes.push(`receipt ${receipt} not repeated`);
      }
      if (applies.some((c) => applyStatus(c) === "NEEDS_CONFIRMATION")) {
        verdict = "WARN";
        notes.push("a different slot was proposed on the retry");
      }
      const before = all.filter((t) => t.step < 8).flatMap((t) => t.tools).filter((c) => applyStatus(c) === "ALREADY_APPLIED").length;
      if (before) notes.push(`ALREADY_APPLIED also seen ${before} time(s) before step 8`);
      return done(notes, verdict);
    },
  },
];

// ---------------------------------------------------------------- runner

export interface DemoRunner {
  /** Sends one customer line and resolves when the turn is over (state and latency known). */
  sendTurn(text: string, step: number, extra: boolean): Promise<TurnRecord>;
  /** False when the run is over voice; the filler lint only applies to text turns. */
  textMode?: boolean;
  log?(line: string): void;
  steps?: DemoStep[];
}

function nearestRank(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

export function summarizeLatency(turns: TurnRecord[]): LatencySummary {
  const ft = turns.map((t) => t.firstTokenMs).filter((v): v is number => typeof v === "number");
  const tot = turns.map((t) => t.totalMs).filter((v): v is number => typeof v === "number");
  return {
    samples: turns.length,
    firstTokenMs: { p50: nearestRank(ft, 50), p95: nearestRank(ft, 95) },
    totalMs: { p50: nearestRank(tot, 50), p95: nearestRank(tot, 95) },
  };
}

function describeTool(t: ToolSeen): string {
  const status = applyStatus(t);
  const id = argOrderId(t);
  const issue = argIssue(t);
  const arg = id ? `(${id}${issue ? ` ${issue}` : ""})` : "";
  if (t.phase === "blocked") return `${t.name}${arg}[BLOCKED ${status ?? /^([A-Z_]+):/.exec(t.detail ?? "")?.[1] ?? ""}]`;
  if (t.phase === "start") return `${t.name}${arg}[unfinished]`;
  if (t.error) return `${t.name}${arg}[ERROR]`;
  if (status) return `${t.name}${arg}[${status}]`;
  if (t.name === "escalate_case") return `${t.name}${arg}[${/"status":"([A-Z_]+)"/.exec(t.detail ?? "")?.[1] ?? "end"}]`;
  return `${t.name}${arg}`;
}

export async function runDemo(runner: DemoRunner): Promise<DemoReport> {
  const steps = runner.steps ?? DEMO_STEPS;
  const textMode = runner.textMode ?? true;
  const log = runner.log ?? (() => undefined);
  const turns: TurnRecord[] = [];
  const reports: StepReport[] = [];

  for (const step of steps) {
    if (step.voiceOnly) {
      reports.push({ n: step.n, title: step.title, verdict: "SKIP", notes: [step.voiceOnly], tools: [], firstTokenMs: null, totalMs: null });
      log(`step ${step.n} SKIP ${step.title}: ${step.voiceOnly}`);
      continue;
    }
    if (step.say) {
      log(`step ${step.n} USER: ${step.say}`);
      const t = await runner.sendTurn(step.say, step.n, false);
      turns.push(t);
      log(`step ${step.n} AGENT: ${t.text.trim()}`);
    }
    const from = step.since ?? step.n;
    const scope = () => turns.filter((t) => t.step >= from && t.step <= step.n);
    let result = step.evaluate(scope(), turns);
    if (result.extra) {
      const line = result.extra;
      log(`step ${step.n} extra turn (${result.notes.join("; ")}) USER: ${line}`);
      const t = await runner.sendTurn(line, step.n, true);
      turns.push(t);
      log(`step ${step.n} AGENT: ${t.text.trim()}`);
      const again = step.evaluate(scope(), turns);
      result = {
        verdict: again.verdict === "PASS" ? "WARN" : again.verdict,
        notes: [...again.notes, `needed one extra turn: "${line}" (${result.notes.join("; ")})`],
      };
    }
    const own = turns.filter((t) => t.step === step.n);
    // Evaluator notes of a failed step are marked like lint failures, so the table labels them alike.
    const notes = result.notes.map((n) => (result.verdict === "FAIL" && !n.startsWith("FAIL:") && !n.startsWith("needed one extra turn") ? `FAIL: ${n}` : n));
    let verdict = result.verdict;
    for (const t of own) {
      for (const note of lintTurn(t, { textMode })) {
        notes.push(note);
        if (note.startsWith("FAIL:")) verdict = "FAIL";
        else if (verdict === "PASS") verdict = "WARN";
      }
    }
    const tools = own.flatMap((t) => t.tools).map(describeTool);
    const first = own[0];
    reports.push({
      n: step.n,
      title: step.title,
      say: step.say,
      verdict,
      notes,
      tools: tools.length ? tools : step.say ? [] : ["(evaluated on the previous step's turn)"],
      firstTokenMs: first?.firstTokenMs ?? null,
      totalMs: first?.totalMs ?? null,
    });
    log(`step ${step.n} ${verdict}${notes.length ? `: ${notes.join("; ")}` : ""}`);
  }

  const failures = reports.filter((r) => r.verdict === "FAIL").length;
  const warnings = reports.filter((r) => r.verdict === "WARN").length;
  return { steps: reports, turns, latency: summarizeLatency(turns), failures, warnings, ok: failures === 0 };
}

// ---------------------------------------------------------------- printing

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function ms(v: number | null): string {
  return v === null ? "n/a" : `${Math.round(v)}`;
}

export function formatReport(report: DemoReport): string {
  const lines: string[] = [];
  lines.push(`${pad("step", 5)}${pad("verdict", 9)}${pad("firstTokenMs", 14)}${pad("totalMs", 9)}tools seen`);
  for (const s of report.steps) {
    lines.push(`${pad(String(s.n), 5)}${pad(s.verdict, 9)}${pad(ms(s.firstTokenMs), 14)}${pad(ms(s.totalMs), 9)}${s.tools.join(" -> ") || "(none)"}`);
    for (const n of s.notes) {
      const label = n.startsWith("FAIL:") ? "fail" : s.verdict === "WARN" ? "warn" : "note";
      lines.push(`     ${label}: ${n.replace(/^FAIL:\s*/, "")}`);
    }
  }
  const l = report.latency;
  lines.push("");
  lines.push(`latency over ${l.samples} text turn(s): firstToken p50 ${ms(l.firstTokenMs.p50)} ms, p95 ${ms(l.firstTokenMs.p95)} ms; total p50 ${ms(l.totalMs.p50)} ms, p95 ${ms(l.totalMs.p95)} ms`);
  const last = report.turns[report.turns.length - 1]?.state;
  if (last) {
    lines.push(
      `final state: applied ${last.applied.length} (${last.applied.map((a) => `${a.receipt} ${a.type} ${a.orderId} ${JSON.stringify(a.params)}`).join("; ") || "none"}); cases ${last.cases.length} (${last.cases.map((c) => `${c.id} ${c.orderId}`).join("; ") || "none"}); pending ${last.pending ? last.pending.summary : "none"}`,
    );
  }
  lines.push(`result: ${report.ok ? "PASS" : "FAIL"} (${report.failures} failed, ${report.warnings} warned, ${report.steps.filter((s) => s.verdict === "SKIP").length} skipped)`);
  return lines.join("\n");
}
