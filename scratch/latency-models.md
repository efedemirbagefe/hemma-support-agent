# Model latency, measured 2026-09-03 from Istanbul, scripts/smoke.ts (one tool call + answer, so two model round trips per run)

| model            | run 1 first token / total | run 2 first token / total |
|------------------|---------------------------|---------------------------|
| claude-haiku-4-5 | 1976 / 2104 ms            | 2310 / 2371 ms            |
| claude-sonnet-4-6| 4093 / 4231 ms            | 3145 / 3482 ms            |
| claude-sonnet-4-5| 2363 / 2601 ms            | 2772 / 2963 ms            |

"first token" here is the first text token of the final answer, i.e. after the tool round trip. Per single model call: Haiku ~1.0 s, Sonnet 4.5 ~1.3 s, Sonnet 4.6 ~1.8 s.
Decision: default model for the voice path = claude-haiku-4-5; MODEL_ID env overrides; Sonnet 4.5 when tool-use quality needs it.
