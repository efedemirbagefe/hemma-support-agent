import type { ActionType, Playbook } from "../types";
import { damagedPlaybook } from "./damaged";
import { latePlaybook } from "./late";
import { reschedulePlaybook } from "./reschedule";
// registry imports end

export type { Playbook, PlaybookContext } from "../types";

/**
 * The registry. Adding a scenario = one playbook file in this folder + one entry below
 * (with its import above). The Scenario type, the `issue` union of check_resolution_options,
 * apply_resolution's option lookup and the prompt's playbook list all derive from this array,
 * so nothing else needs an edit. See examples/scenarios/README.md for the drop-in commands.
 */
export const playbooks = [
  reschedulePlaybook,
  damagedPlaybook,
  latePlaybook,
  // registry entries end
] as const satisfies readonly Playbook[];

export type Scenario = (typeof playbooks)[number]["scenario"];

/** Scenario names of the live registry, in registry order. */
export const scenarios: readonly Scenario[] = playbooks.map((p) => p.scenario);

export function scenariosOf(registry: readonly Playbook[]): string[] {
  return registry.map((p) => p.scenario);
}

export function isScenario(value: unknown, registry: readonly Playbook[] = playbooks): value is Scenario {
  return typeof value === "string" && registry.some((p) => p.scenario === value);
}

export function getPlaybook(scenario: string, registry: readonly Playbook[] = playbooks): Playbook {
  const playbook = registry.find((p) => p.scenario === scenario);
  if (!playbook) throw new Error(`Unknown scenario: ${scenario}. Known: ${scenariosOf(registry).join(", ")}`);
  return playbook;
}

/**
 * Playbooks that can offer this action type, in registry order. apply_resolution consults
 * every one of them: an option that any of them marks requiresEscalation is escalated.
 */
export function playbooksForAction(type: ActionType, registry: readonly Playbook[] = playbooks): Playbook[] {
  return registry.filter((p) => p.actionTypes.includes(type));
}

/**
 * Throws on an empty registry, a duplicate scenario name or a playbook without actionTypes;
 * called once at startup by Session, so a mis-edited registry fails before any tool exists.
 */
export function assertRegistry(registry: readonly Playbook[]): void {
  if (registry.length === 0) {
    throw new Error("Playbook registry is empty: at least one playbook is needed (see src/domain/policies/index.ts)");
  }
  const seen = new Set<string>();
  for (const p of registry) {
    if (seen.has(p.scenario)) throw new Error(`Duplicate scenario in playbook registry: ${p.scenario}`);
    seen.add(p.scenario);
    if (p.actionTypes.length === 0) throw new Error(`Playbook ${p.scenario} declares no actionTypes`);
  }
}
