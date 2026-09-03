# Approach

Hemma support agent, voice, six hours. How I read the brief before writing code, what done means, what I cut, where the time went, and how to review the result.

## The customer on the phone

Someone who already has a problem: a delivery date that no longer works, a lamp that arrived dented, a table that is four days late. They want it handled, not discussed. A good call is short. The agent knows who they are after one sentence, asks one question at a time, offers only what the store can actually do today, and does nothing irreversible until the customer has said yes to a specific proposal with a date, a window or an amount in it. When the customer changes subject halfway, the agent follows and then comes back to the open request by itself. The silence after the customer stops talking is short enough that they do not start filling it.

## What done means

I wrote this list first. The tests follow it.

Correct tool order: find the customer, get the order, check options or slots, then apply. Never offer an option a tool did not return.

One confirmation before anything consequential. Reschedule, replacement, refund and compensation are proposed first and applied only after an explicit yes to that exact proposal.

Exactly once. The same resolution asked twice, retried after an error, or cut off by an interruption is applied at most once. The ledger decides, not the model's memory.

Topic switching: an unfinished request survives a detour and the agent returns to it.

Latency you do not notice: first audio well under two seconds after the customer stops, a spoken filler when a tool runs past 700 ms, barge-in that stops the agent's audio the moment the customer speaks.

## What I left out

From the brief's out-of-scope list: [fill in from the brief before sending]. My own cuts: no persistence (a session lives in memory and dies with the connection), no identity check beyond customer reference or phone, no payment or logistics integration (apply writes a ledger entry and returns a receipt), no telephony (browser microphone only; a SIP leg would replace the client, not the pipeline), one voice. Each is real work, and each would have taken hours from the parts that decide whether the agent can be trusted: the guard, the ledger and the tests.

## What I added

Turkish earned its place inside the six hour box for two reasons. The reviewer is hiring for a Turkish company, and a demo that only speaks English answers half the brief. A second language is also the cheapest way to prove the rules live in code and not in English sentences a model happens to phrase well: the EUR 200 threshold, the two-phase apply, the ledger key do not move when the words around them do. If they had been prompt text instead of playbook functions, Turkish would have meant rewriting the rules, not translating them.

The first screen changed from a mic button to one action, Start a call. A blank page with a microphone icon asks the customer to already know what to do, and a demo especially cannot assume that. One button, a spoken greeting, and phrases you can tap instead of speaking mean the call starts itself, and a reviewer who never says a word out loud can still watch the whole thing work. The engineering panels, tool calls, latency, session state, moved behind an "Under the hood" toggle for the same reason: a customer does not want to see them, a reviewer wants them one click away, not on by default.

The ElevenLabs quota ran out mid-testing, not in a spec sheet: the free workspace's 10,000 characters were gone partway through a run, and Deepgram's Aura fallback has no Turkish voice at all. Together that meant the demo could go silent mid-call, on the one day it matters most. The fix was a third tier, the browser's own speech synthesis, which needs no vendor key and no quota. It sounds worse than either vendor voice, but never being silent matters more than sounding good on the day the reviewer is listening.

## Where the six hours went

Time log is in TIMELOG.md

## Three rules from my day job

I work on a voice agent platform that takes real customer calls. Three rules came with me.

Rules live in code, not in the prompt. The playbooks in `src/domain/policies` are data plus pure functions: the 200 euro escalation line, the late-delivery thresholds, the slot rules. The prompt tells the model that rules exist; the tools and the guard enforce them. A customer can argue with a prompt. Nobody can argue with a function.

Consequential actions are guarded deterministically. `apply_resolution` is two-phase: the first call registers a pending action and returns NEEDS_CONFIRMATION; the second is allowed only when the pending key matches and the customer's last utterance, the transcript itself and not the model's reading of it, contains an affirmative and no negation. The idempotency key and the ledger turn a repeat into a no-op that returns the original receipt.

Every completion claim carries its evidence label. Done comes in two levels here: written and tested (`npm test` green, no model in the loop) or verified live (a real call, a transcript line, a latency row). DEMO.md says which claim is which. Anything else is written as not measured.

## Claude Code as the pair

Claude Code wrote most of the lines. I wrote the contract it worked from (CONTRACTS.md), fixed the module boundaries and the tool names, read every file, and sent back what did not match. For review that means one thing: I own what exists and why. Any file, any line, any decision, ask me.
