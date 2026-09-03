# Drop-in scenarios

A scenario is one playbook file: data plus pure functions, no LLM. The registry in `src/domain/policies/index.ts` is the single source: the `Scenario` type, the `issue` union of `check_resolution_options`, `apply_resolution`'s option lookup and the playbook list in the system prompt all derive from it. Adding a scenario is the file plus one registry entry.

`wrong-item.ts` here is a complete playbook for `wrong_item` (a different item than ordered was delivered: replacement when stock exists, otherwise refund, escalation above EUR 200, confirmation required). It is not in the live registry; `tests/domain.test.ts` loads it into a scratch registry and proves the tools serve it.

## Put it live: three commands from the repo root

1. Copy the file into the policies folder (the import path changes from `../../src/domain/types` to `../types`):

```
sed 's#"../../src/domain/types"#"../types"#' examples/scenarios/wrong-item.ts > src/domain/policies/wrong-item.ts
```

2. Add the registry entry (one import, one list entry; the two marker comments in `index.ts` exist for this):

```
perl -0pi -e 's#(// registry imports end)#import { wrongItemPlaybook } from "./wrong-item";\n$1#; s#(  // registry entries end)#  wrongItemPlaybook,\n$1#' src/domain/policies/index.ts
```

3. Restart the server:

```
npm start
```

The model then sees the playbook line in its prompt, `check_resolution_options` accepts `issue: "wrong_item"`, and `apply_resolution` resolves `replacement` and `refund` requests against it. `npx tsc --noEmit` stays clean with it registered. Two assertions in `tests/domain.test.ts` pin the live registry to the three shipped scenarios ("registry has three scenarios" and "scenarios, the issue schema and the action lookup derive from the live registry"); extend their expected lists with `wrong_item` when you keep it.

To take it out again: delete `src/domain/policies/wrong-item.ts` and remove the two lines from `index.ts`.

## What a playbook must provide

```ts
export const wrongItemPlaybook: Playbook<"wrong_item"> = {
  scenario: "wrong_item",          // unique; the Scenario union is built from these
  description: "...",              // one line, shown to the model
  actionTypes: ["replacement", "refund"],   // which apply_resolution types this playbook can offer
  toolOrder: [...],                // the expected tool sequence, shown to the model
  options(order, customer, ctx) {...},      // ResolutionOption[]; requiresEscalation blocks apply
  note?(order, customer, ctx) {...},        // optional caveat for the tool result
};
```

Limits that are honest to state: the four action types (`reschedule`, `replacement`, `refund`, `compensation`) are fixed in `src/domain/types.ts` and applied in `src/domain/actions.ts`. A scenario that needs a new action type also needs those two files. When two playbooks offer the same action with the same params for an order, `apply_resolution` consults every one of them, whatever the registry order: if any of them marks the option `requiresEscalation`, the tool answers `ESCALATION_REQUIRED` with that playbook's reason and the guard blocks the apply, so a lenient playbook earlier in the registry cannot bypass a stricter one added later. The idempotency key is per action, so it is one action either way.
