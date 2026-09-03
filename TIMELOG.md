# Time log

Wall-clock, Istanbul time, 2026-09-03. Timebox in the brief: 6 hours. Times come from file modification stamps, the GitHub authorization page and the workflow run durations, not from memory.

| Start | End | What | Notes |
|---|---|---|---|
| 10:45 | 11:05 | Read the brief, confirm what "Pi" is, scaffold, install Pi packages, smoke test the harness with one tool call | First smoke failed on API credit, fixed by topping up the personal account |
| 11:03 | 11:10 | Measure model latency (Haiku 4.5 vs Sonnet 4.5 vs 4.6) | scratch/latency-models.md. Decision: Haiku for the voice path |
| 11:00 | 11:20 | Write CONTRACTS.md: layout, types, tools, guards, voice protocol, mock data | The single source of truth all parallel work coded against |
| 11:20 | 11:58 | Build round 1: domain + guards + tests, voice pipeline, browser client, APPROACH and DEMO drafts, in parallel; adversarial review per area; fixes; integration | 12 agents, 28 review findings fixed, integration ALL_GREEN, 57 tests |
| 11:20 | 11:45 | In parallel: vendor keys, live checks of Deepgram STT/TTS and ElevenLabs REST and WebSocket | scratch/vendor-checks.md. Found: free ElevenLabs cannot use library voices, use the workspace's premade voices |
| 12:05 | 12:12 | First real runs: voice smoke with synthesized speech and a barge-in; the 8-step demo through the real model in text mode | Numbers in DECISIONS.md. Four defects found (weekday, order matching, filler in text mode, retry path untested) |
| 12:13 | 12:16 | Rename brand to Hemma, re-green tests | |
| 12:16 | 13:42 | Build round 2: the four fixes, demo:check, drop-in scenario, chaos toggles, Aura fallback, p50/p95, docs from measured numbers | |

| 13:42 | | Commit, push, deploy to Render, rehearsal | |

Elapsed at 13:42: about 3 hours.
