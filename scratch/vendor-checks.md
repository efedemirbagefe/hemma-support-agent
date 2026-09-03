# Vendor checks, 2026-09-03, personal accounts only
- Anthropic: smoke test with tool call OK after credit top-up. Haiku 4.5 ~1.0 s per call, Sonnet 4.6 ~1.8 s.
- Deepgram: key valid (projects 200). STT nova-3 on a macOS `say` clip: exact transcript, confidence 1.0. Aura-2 TTS (aura-2-thalia-en, linear16 16 kHz) 200, 130 KB for one sentence; round trip STT reads it back correctly.
- ElevenLabs: free workspace, 10,000 chars. Library voice (Rachel 21m00Tcm4TlvDq8ikWAM) returns 402 paid_plan_required on the API. Premade voices already in the account work: Sarah EXAVITQu4vr4xnSDxMaL, eleven_flash_v2_5, pcm_16000, 200 OK.
- Decision: TTS primary ElevenLabs (Sarah), fallback Deepgram Aura when ElevenLabs errors or key missing. STT Deepgram nova-3.

## Live socket checks (scratch/vendor-dg-live.ts, scratch/vendor-el-ws.ts)
- Deepgram live WS with the exact query string from CONTRACTS: open +0.7 s, SpeechStarted fires ~0.45 s after audio starts (this is the barge-in trigger), interims every ~1 s, final with speech_final=true. Endpointing 300 ms works on a mic-paced 20 ms chunk stream.
- ElevenLabs stream-input WS (eleven_flash_v2_5, pcm_16000, voice Sarah): first audio 1.0 s after socket open including handshake, 3.3 s of audio for two sentences, isFinal after `{text:""}` flush. Keep the socket open across sentences and only flush at turn end.
