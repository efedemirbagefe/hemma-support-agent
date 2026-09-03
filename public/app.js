// Hemma support: browser client.
// Mic -> AudioWorklet (16 kHz Int16) -> WS binary. WS binary -> AudioWorklet ring buffer -> speakers.
// JSON control messages as in CONTRACTS.md. No dependencies.
//
// Two surfaces share one socket: the customer conversation (bubbles, mic, text input) and the
// "Under the hood" panel (tool calls, session state, latency, event log). Every server message
// type is handled exactly as before; only where each piece of information is drawn has moved.
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const els = {
    connStatus: $("connStatus"),
    chaosStatus: $("chaosStatus"),
    hoodDot: $("hoodDot"),
    speakStatus: $("speakStatus"),
    audioInfo: $("audioInfo"),
    voiceInfo: $("voiceInfo"),
    btnMic: $("btnMic"),
    micHint: $("micHint"),
    micLevel: $("micLevel"),
    btnReset: $("btnReset"),
    btnSend: $("btnSend"),
    btnHood: $("btnHood"),
    hood: $("hood"),
    modelBanner: $("modelBanner"),
    ttsNote: $("ttsNote"),
    textForm: $("textForm"),
    textInput: $("textInput"),
    transcript: $("transcript"),
    eventLog: $("eventLog"),
    toolsBody: $("toolsBody"),
    toolsEmpty: $("toolsEmpty"),
    latencyBody: $("latencyBody"),
    latencyFoot: $("latencyFoot"),
    latencyEmpty: $("latencyEmpty"),
    stateSummary: $("stateSummary"),
    receipts: $("receipts"),
    state: $("state"),
    toast: $("toast"),
  };

  const state = {
    ws: null,
    wsOpen: false,
    ready: false, // the `ready` message of the current socket has arrived
    everConnected: false,
    lostNoted: false, // one "connection lost" note per outage in the conversation
    retryIn: 0,
    reconnectDelay: 1000,
    reconnectTimer: null,
    countdownTimer: null,
    audio: { ctx: null, playback: null, capture: null, source: null, stream: null, inputRate: 0, outputRate: 0, initPromise: null, carry: null },
    pendingAudio: [],
    voice: { stt: true, tts: true, ttsEngine: "" }, // server capabilities from the `ready` message
    chaos: [], // active chaos toggles from the `ready` message (the ?fail= query)
    // Model availability. `modelOffline` is hard evidence (healthz features.model false, or an
    // "Agent unavailable" error) and disables Send and the mic; `modelError` is a "Model error"
    // event and only shows the banner, so a transient failure keeps the controls usable. Both
    // are cleared by the next agent_text delta, which proves the model answered.
    modelOffline: false,
    modelError: false,
    micOn: false,
    micStarting: false,
    currentTurnId: null,
    turnNumbers: new Map(), // turnId -> 1, 2, 3 ...
    turns: new Map(), // turnId -> { t0, firstTextAt, firstAudioAt, playedAt, playedSent, server, clientToolMs }
    lastUserTurnEndAt: 0,
    agentEntries: new Map(), // turnId -> conversation element
    interimEl: null,
    toolRows: [], // { turnId, name, phase, ms, args, note, at }
    speakingTimer: null,
    toastTimer: null,
  };

  const HOOD_KEY = "hemma.hood";
  const EVENT_LOG_MAX = 200;

  // ------------------------------------------------------------------ helpers
  const now = () => performance.now();
  // Audio queued before the first user gesture is only replayed if its turn started within this
  // window, so a `played` report is never sent for a turn that finished long ago.
  const PENDING_AUDIO_MAX_AGE_MS = 3000;

  function toast(message) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { els.toast.hidden = true; }, 6000);
  }

  function compact(value, max) {
    let s;
    try { s = typeof value === "string" ? value : JSON.stringify(value); } catch { s = String(value); }
    if (s == null) return "";
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  }

  function fmtMs(v) {
    return typeof v === "number" && isFinite(v) ? String(Math.round(v)) : null;
  }

  // Nearest-rank percentile: sort ascending, take the value at ceil(p/100 * n). p50 of one
  // value is that value; p95 of fewer than 20 values is the maximum.
  function percentile(values, p) {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const rank = Math.ceil((p / 100) * sorted.length);
    return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
  }

  // The `fail` query on the page URL is forwarded to the server on the WS handshake so the
  // chaos toggles (?fail=tts, ?fail=tts,stt) apply to this connection. The server echoes the
  // active list in `ready.chaos`.
  function failQuery() {
    try {
      const v = new URLSearchParams(location.search).get("fail");
      return v ? v.trim() : "";
    } catch {
      return "";
    }
  }

  // `ready.chaos` is a list of toggle names; an object form ({ tts: true }) is read too.
  function chaosList(value) {
    if (Array.isArray(value)) return value.filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim());
    if (value && typeof value === "object") return Object.keys(value).filter((k) => value[k]);
    if (typeof value === "string" && value.trim()) return value.split(",").map((v) => v.trim()).filter(Boolean);
    return [];
  }

  function turnNo(turnId) {
    if (turnId == null) return "?";
    if (!state.turnNumbers.has(turnId)) state.turnNumbers.set(turnId, state.turnNumbers.size + 1);
    return "#" + state.turnNumbers.get(turnId);
  }

  function turnRecord(turnId) {
    let t = state.turns.get(turnId);
    if (!t) {
      t = { t0: state.lastUserTurnEndAt || now(), firstTextAt: 0, firstAudioAt: 0, playedAt: 0, playedSent: false, server: {}, clientToolMs: 0 };
      state.turns.set(turnId, t);
      turnNo(turnId);
    }
    return t;
  }

  // Only agent_text and tool start may retarget currentTurnId: binary audio frames are tagged
  // with it, so a late event for a finished turn (latency re-send, tool end after a barge-in)
  // must not relabel the next turn's audio.
  function onTurnSeen(turnId) {
    if (turnId == null) return null;
    const t = turnRecord(turnId);
    state.currentTurnId = turnId;
    return t;
  }

  function turnRecordOrNull(turnId) {
    return turnId == null ? null : turnRecord(turnId);
  }

  function timeStamp() {
    try { return new Date().toLocaleTimeString([], { hour12: false }); } catch { return ""; }
  }

  // ------------------------------------------------------------ conversation
  function scrollFlow() {
    els.transcript.scrollTop = els.transcript.scrollHeight;
  }

  // One bubble. `role` is "user" or "assistant" (plus "interim" for speech still being recognised).
  function addMessage(role, text) {
    const wrap = document.createElement("div");
    wrap.className = "msg " + role;
    const bubble = document.createElement("div");
    bubble.className = "bubble" + (text ? "" : " empty");
    const span = document.createElement("span");
    span.className = "text";
    span.textContent = text;
    bubble.appendChild(span);
    wrap.appendChild(bubble);
    els.transcript.appendChild(wrap);
    scrollFlow();
    return wrap;
  }

  // A short centered note in the conversation: connection lost, sound off, an error.
  function noteLine(text, kind) {
    const div = document.createElement("div");
    div.className = "sysnote" + (kind ? " " + kind : "");
    div.textContent = text;
    els.transcript.appendChild(div);
    scrollFlow();
    return div;
  }

  // Engineering events (connection, mic, TTS engine, chaos, barge-in) go to the event log in the
  // "Under the hood" panel, not the conversation.
  function logLine(text) {
    const log = els.eventLog;
    if (!log) return;
    const li = document.createElement("li");
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = timeStamp();
    const s = document.createElement("span");
    s.textContent = text;
    li.append(t, s);
    log.appendChild(li);
    while (log.children.length > EVENT_LOG_MAX) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }

  // The red inline note on error, and the same text in the event log.
  function errLine(text) {
    logLine(text);
    return noteLine(text, "err");
  }

  function clearFlow() {
    els.transcript.replaceChildren();
    state.interimEl = null;
  }

  function agentEntry(turnId) {
    let el = state.agentEntries.get(turnId);
    if (!el) {
      el = addMessage("assistant", "");
      // Tool activity chips sit above the assistant's text, in the order the tools ran.
      const activity = document.createElement("div");
      activity.className = "activity";
      el.insertBefore(activity, el.firstChild);
      state.agentEntries.set(turnId, el);
    }
    return el;
  }

  function appendAgentText(el, delta) {
    const bubble = el.querySelector(".bubble");
    bubble.querySelector(".text").textContent += delta;
    bubble.classList.remove("empty");
    scrollFlow();
  }

  function setInterim(text) {
    if (!text) {
      if (state.interimEl) { state.interimEl.remove(); state.interimEl = null; }
      return;
    }
    if (!state.interimEl) state.interimEl = addMessage("user interim", text);
    else state.interimEl.querySelector(".text").textContent = text;
    scrollFlow();
  }

  function finalUserLine(text) {
    if (state.interimEl) {
      state.interimEl.className = "msg user";
      state.interimEl.querySelector(".text").textContent = text;
      state.interimEl = null;
    } else {
      addMessage("user", text);
    }
    scrollFlow();
  }

  // ------------------------------------------------------------------ panels
  function renderTools() {
    const rows = state.toolRows;
    els.toolsEmpty.hidden = rows.length > 0;
    const frag = document.createDocumentFragment();
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      const tr = document.createElement("tr");
      const phaseCls = r.phase === "end" && r.error ? "error" : r.phase;
      const phaseText = r.phase === "end" && r.error ? "error" : r.phase === "start" ? "running" : r.phase;
      const args = compact(r.args, 60);
      tr.innerHTML =
        `<td>${turnNo(r.turnId)}</td>` +
        `<td class="mono">${escapeHtml(r.name)}</td>` +
        `<td><span class="ph ${escapeHtml(phaseCls)}">${escapeHtml(phaseText)}</span></td>` +
        `<td class="num">${fmtMs(r.ms) ?? "-"}</td>` +
        `<td class="mono" title="${escapeHtml(compact(r.args, 2000))}">${escapeHtml(args)}</td>` +
        `<td class="wrap" title="${escapeHtml(compact(r.note || "", 2000))}">${escapeHtml(compact(r.note || "", 200))}</td>`;
      frag.appendChild(tr);
    }
    els.toolsBody.replaceChildren(frag);
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function cell(serverVal, clientVal) {
    const s = fmtMs(serverVal);
    if (s != null) return `<td class="num">${s}</td>`;
    const c = fmtMs(clientVal);
    if (c != null) return `<td class="num est" title="measured in the browser">~${c}</td>`;
    return `<td class="num est">-</td>`;
  }

  // The four summarised metrics of a turn: the server's number when it has one, else the
  // browser's own estimate (marked est). `total` is server only; the browser has no end mark.
  function turnMetrics(t) {
    const sv = t.server || {};
    const pick = (serverVal, clientVal) => {
      if (typeof serverVal === "number" && isFinite(serverVal)) return { v: serverVal, est: false };
      if (typeof clientVal === "number" && isFinite(clientVal)) return { v: clientVal, est: true };
      return { v: null, est: false };
    };
    return {
      firstToken: pick(sv.firstTokenMs, t.firstTextAt ? t.firstTextAt - t.t0 : null),
      firstAudio: pick(sv.firstAudioMs, t.firstAudioAt ? t.firstAudioAt - t.t0 : null),
      played: pick(sv.playedMs, t.playedAt ? t.playedAt - t.t0 : null),
      total: pick(sv.totalMs, null),
    };
  }

  function ttsEngineOf(sv) {
    if (typeof sv.ttsEngine === "string" && sv.ttsEngine) return sv.ttsEngine;
    if (sv.tts && typeof sv.tts === "object" && typeof sv.tts.engine === "string" && sv.tts.engine) return sv.tts.engine;
    return null;
  }

  function renderLatency() {
    const ids = [...state.turns.keys()];
    els.latencyEmpty.hidden = ids.length > 0;
    const frag = document.createDocumentFragment();
    // Per metric: the values that go into p50/p95, and whether any of them is a browser estimate.
    const summary = {
      firstToken: { values: [], est: false },
      firstAudio: { values: [], est: false },
      played: { values: [], est: false },
      total: { values: [], est: false },
    };
    for (let i = ids.length - 1; i >= 0; i--) {
      const id = ids[i];
      const t = state.turns.get(id);
      const sv = t.server || {};
      const m = turnMetrics(t);
      const cut = sv.cancelled === true;
      for (const key of Object.keys(summary)) {
        if (m[key].v == null) continue;
        if (key === "total" && cut) continue; // a cut turn's total is the time to the barge-in, not a latency
        summary[key].values.push(m[key].v);
        if (m[key].est) summary[key].est = true;
      }
      const engine = ttsEngineOf(sv);
      const tr = document.createElement("tr");
      tr.title = "turn " + id + (sv.source ? " (" + sv.source + ")" : "") + (cut ? ", cut by a barge-in" : "");
      if (cut) tr.className = "cut";
      tr.innerHTML =
        `<td>${turnNo(id)}${cut ? ' <span class="est" title="cut by a barge-in">cut</span>' : ""}</td>` +
        cell(sv.sttFinalMs, null) +
        metricCell(m.firstToken) +
        metricCell(m.firstAudio) +
        metricCell(m.played) +
        cell(sv.toolMs, t.clientToolMs || null) +
        metricCell(m.total) +
        `<td class="mono">${engine ? escapeHtml(engine) : '<span class="est">-</span>'}</td>`;
      frag.appendChild(tr);
    }
    els.latencyBody.replaceChildren(frag);
    renderLatencySummary(summary, ids.length);
  }

  function metricCell(m) {
    const s = fmtMs(m.v);
    if (s == null) return `<td class="num est">-</td>`;
    return m.est ? `<td class="num est" title="measured in the browser">~${s}</td>` : `<td class="num">${s}</td>`;
  }

  // One summary row under the table: "p50 / p95" of first token, first audio, played and total
  // across the session's turns. Each cell's title says how many turns had a value for it.
  function renderLatencySummary(summary, turnCount) {
    const foot = els.latencyFoot;
    if (!foot) return;
    if (turnCount === 0) {
      foot.hidden = true;
      foot.replaceChildren();
      return;
    }
    const tr = document.createElement("tr");
    tr.className = "sum";
    const label = `<td class="label" title="nearest-rank percentiles over ${turnCount} turn${turnCount === 1 ? "" : "s"}; turns cut by a barge-in are left out of total">p50 / p95</td>`;
    const sumCell = (key) => {
      const s = summary[key];
      const p50 = fmtMs(percentile(s.values, 50));
      const p95 = fmtMs(percentile(s.values, 95));
      if (p50 == null || p95 == null) return `<td class="num est" title="no ${key} value yet">-</td>`;
      const n = s.values.length;
      const title = `${key} over ${n} turn${n === 1 ? "" : "s"}` + (s.est ? ", includes browser estimates" : "");
      const pre = s.est ? "~" : "";
      return `<td class="num${s.est ? " est" : ""}" title="${escapeHtml(title)}">${pre}${p50} / ${pre}${p95}</td>`;
    };
    tr.innerHTML =
      label +
      `<td class="num est">-</td>` +
      sumCell("firstToken") +
      sumCell("firstAudio") +
      sumCell("played") +
      `<td class="num est">-</td>` +
      sumCell("total") +
      `<td class="est">-</td>`;
    foot.replaceChildren(tr);
    foot.hidden = false;
  }

  function renderState(session) {
    const s = session && typeof session === "object" ? session : {};
    const chips = [];
    if (s.customer && typeof s.customer === "object") {
      chips.push("Customer: " + (s.customer.name || s.customer.id || "?") + (s.customer.tier ? " (" + s.customer.tier + ")" : ""));
    } else {
      chips.push("Customer: none");
    }
    if (s.activeOrderId) chips.push("Active order: " + s.activeOrderId);
    if (s.pending && typeof s.pending === "object") {
      chips.push("Pending: " + (s.pending.summary || [s.pending.type, s.pending.orderId].filter(Boolean).join(" ")));
    } else {
      chips.push("Pending: none");
    }
    const appliedList = Array.isArray(s.applied) ? s.applied : s.applied && typeof s.applied === "object" ? Object.values(s.applied) : [];
    chips.push("Applied: " + appliedList.length);
    chips.push("Cases: " + (Array.isArray(s.cases) ? s.cases.length : 0));
    els.stateSummary.replaceChildren(...chips.map((c) => { const span = document.createElement("span"); span.textContent = c; return span; }));
    renderReceipts(appliedList);
    let text;
    try { text = JSON.stringify(s, null, 2); } catch { text = String(s); }
    els.state.textContent = text;
  }

  // One green block per ledger entry, newest first, with the receipt id large. This is the
  // number the customer is read back, and the thing to point at in the "exactly once" step:
  // a retry must not add a block or change the id.
  function renderReceipts(appliedList) {
    const box = els.receipts;
    if (!box) return;
    const entries = appliedList.filter((r) => r && typeof r === "object");
    if (!entries.length) {
      box.hidden = true;
      box.replaceChildren();
      return;
    }
    const blocks = entries.slice().reverse().map((rec, i) => {
      const div = document.createElement("div");
      div.className = "receipt";
      const label = document.createElement("div");
      label.className = "label";
      label.textContent = entries.length > 1 ? "Receipt " + (entries.length - i) + " of " + entries.length : "Receipt";
      const id = document.createElement("div");
      id.className = "id";
      id.textContent = typeof rec.receipt === "string" && rec.receipt ? rec.receipt : rec.key ? String(rec.key) : "?";
      const what = document.createElement("div");
      what.className = "what";
      what.textContent = receiptText(rec);
      div.append(label, id, what);
      return div;
    });
    box.replaceChildren(...blocks);
    box.hidden = false;
  }

  function receiptText(rec) {
    const parts = [];
    if (rec.type) parts.push(String(rec.type));
    if (rec.orderId) parts.push(String(rec.orderId));
    const params = rec.params && typeof rec.params === "object" ? rec.params : null;
    if (params) {
      const kv = Object.keys(params).map((k) => {
        const v = params[k];
        return k + " " + (v && typeof v === "object" ? compact(v, 40) : String(v));
      });
      if (kv.length) parts.push(kv.join(", "));
    }
    if (typeof rec.appliedAt === "number" && isFinite(rec.appliedAt)) {
      try { parts.push("applied " + new Date(rec.appliedAt).toLocaleTimeString()); } catch {}
    }
    return parts.join(" · ");
  }

  function resetPanels() {
    state.currentTurnId = null;
    state.turnNumbers.clear();
    state.turns.clear();
    state.agentEntries.clear();
    state.toolRows = [];
    state.interimEl = null;
    renderTools();
    renderLatency();
    renderState({});
  }

  // ----------------------------------------------------------- status views
  // Header pill: connecting / connected / voice ready / text only / reconnecting.
  function renderConn() {
    const el = els.connStatus;
    let text = "connecting";
    let cls = "";
    let title = "";
    if (state.wsOpen) {
      if (!state.ready) {
        text = "connected";
        cls = "ok";
      } else if (state.voice.stt) {
        text = "voice ready";
        cls = "ok";
        title = state.voice.tts ? "Speech in, speech out" : "Speech in, replies as text";
      } else {
        text = "text only";
        title = "Voice input is off on this deployment";
      }
    } else if (state.everConnected) {
      text = "reconnecting";
      cls = "bad";
      title = state.retryIn ? "retry in " + state.retryIn + "s" : "";
    }
    el.textContent = text;
    el.className = "pill" + (cls ? " " + cls : "");
    el.title = title;
  }

  // Send is enabled whenever the socket is open and the model is not known to be off.
  function renderControls() {
    els.btnSend.disabled = !(state.wsOpen && !state.modelOffline);
    renderMic();
  }

  // The round mic button: green idle, ochre with a pulsing ring while listening, grey with the
  // reason as a tooltip and a caption when voice is unavailable.
  function renderMic() {
    const b = els.btnMic;
    let disabled = false;
    let hint = "Tap to talk";
    if (state.modelOffline) {
      disabled = true;
      hint = "The assistant is offline";
    } else if (!state.voice.stt) {
      disabled = true;
      hint = "Voice input is off on this deployment";
    } else if (state.micStarting) {
      disabled = true;
      hint = "Starting the microphone";
    } else if (state.micOn) {
      hint = "Listening. Tap to stop.";
    }
    b.disabled = disabled;
    b.classList.toggle("listening", state.micOn);
    b.setAttribute("aria-pressed", state.micOn ? "true" : "false");
    b.setAttribute("aria-label", state.micOn ? "Stop voice input" : "Start voice input");
    b.title = disabled ? hint : "";
    // A disabled button does not show a tooltip in every browser; the wrapper carries it too.
    if (b.parentElement) b.parentElement.title = disabled ? hint : "";
    els.micHint.textContent = hint;
    if (!state.micOn) els.micLevel.style.transform = "";
  }

  function renderModelBanner() {
    els.modelBanner.hidden = !(state.modelOffline || state.modelError);
  }

  // Hard evidence about the model key: /healthz features.model, or a ready.features.model if a
  // server ever sends one.
  function applyModelFlag(available) {
    if (available === false) {
      if (!state.modelOffline) logLine("Model is off on this deployment (no model key configured). Turns will fail.");
      state.modelOffline = true;
      if (state.micOn) stopMic(); // the button is about to be disabled; never leave a mic capturing behind it
    } else if (available === true) {
      if (state.modelOffline) logLine("Model key present according to /healthz.");
      state.modelOffline = false;
    }
    renderModelBanner();
    renderControls();
  }

  // The `ready` message carries voice capabilities and chaos flags only; the model flag lives on
  // GET /healthz (features.model = has ANTHROPIC_API_KEY). Read it once per socket so the
  // banner shows before the first failed turn, not after it. Any failure here changes nothing.
  async function checkModel() {
    let features = null;
    try {
      const res = await fetch("/healthz", { cache: "no-store" });
      if (!res.ok) return;
      const body = await res.json();
      features = body && typeof body === "object" ? body.features : null;
    } catch {
      return;
    }
    if (!features || typeof features !== "object") return;
    if (typeof features.model === "boolean") applyModelFlag(features.model);
  }

  function noteModelError(message) {
    if (/^Agent unavailable/i.test(message)) {
      applyModelFlag(false);
    } else if (/^Model error/i.test(message)) {
      state.modelError = true;
      renderModelBanner();
    }
  }

  // A text delta from the model is proof it answers: drop both flags and the banner.
  function noteModelWorks() {
    if (!state.modelOffline && !state.modelError) return;
    state.modelOffline = false;
    state.modelError = false;
    renderModelBanner();
    renderControls();
  }

  function setHood(open, persist) {
    els.hood.hidden = !open;
    els.btnHood.setAttribute("aria-expanded", open ? "true" : "false");
    if (persist) {
      try { localStorage.setItem(HOOD_KEY, open ? "1" : "0"); } catch {}
    }
  }

  // --------------------------------------------------------------- websocket
  function sendJson(obj) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      toast("Not connected to the server.");
      return false;
    }
    state.ws.send(JSON.stringify(obj));
    return true;
  }

  function sendBinary(buf) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(buf);
  }

  function clearTimers() {
    clearTimeout(state.reconnectTimer);
    clearInterval(state.countdownTimer);
    state.reconnectTimer = null;
    state.countdownTimer = null;
  }

  function connect() {
    clearTimers();
    state.ready = false;
    state.retryIn = 0;
    renderConn();
    const fail = failQuery();
    const url = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws" + (fail ? "?fail=" + encodeURIComponent(fail) : "");
    let ws;
    try { ws = new WebSocket(url); } catch (e) { scheduleReconnect(); return; }
    ws.binaryType = "arraybuffer";
    state.ws = ws;
    ws.onopen = () => {
      state.wsOpen = true;
      state.reconnectDelay = 1000;
      state.lostNoted = false;
      renderConn();
      renderControls();
      if (state.everConnected) {
        resetPanels();
        logLine("Reconnected. The server started a new session, panels were cleared.");
        noteLine("Connection restored. The assistant starts a new session from here.");
      } else {
        logLine("Connected to " + url);
      }
      state.everConnected = true;
      checkModel();
    };
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) { onAudioChunk(ev.data); return; }
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg && typeof msg === "object") onServerMessage(msg);
    };
    ws.onclose = () => {
      if (state.ws !== ws) return;
      state.wsOpen = false;
      state.ready = false;
      state.ws = null;
      clearPlayback();
      setInterim("");
      renderControls();
      if (state.everConnected && !state.lostNoted) {
        state.lostNoted = true;
        noteLine("Connection lost. Reconnecting.");
      }
      scheduleReconnect();
    };
    ws.onerror = () => { /* onclose follows and schedules the retry */ };
  }

  function scheduleReconnect() {
    clearTimers();
    const delay = state.reconnectDelay;
    state.reconnectDelay = Math.min(10000, delay * 2);
    let remain = Math.ceil(delay / 1000);
    state.retryIn = remain;
    renderConn();
    if (state.everConnected) logLine("Connection lost. Reconnecting in " + remain + "s.");
    state.countdownTimer = setInterval(() => {
      remain -= 1;
      if (remain > 0) { state.retryIn = remain; renderConn(); }
    }, 1000);
    state.reconnectTimer = setTimeout(connect, delay);
  }

  function onServerMessage(msg) {
    switch (msg.type) {
      case "ready": {
        state.ready = true;
        const voice = msg.voice && typeof msg.voice === "object" ? msg.voice : {};
        applyVoiceCaps({
          stt: voice.stt !== false,
          tts: voice.tts !== false,
          ttsEngine: typeof voice.ttsEngine === "string" ? voice.ttsEngine
            : typeof voice.engine === "string" ? voice.engine
            : Array.isArray(voice.ttsEngines) ? voice.ttsEngines.filter((v) => typeof v === "string").join(", ")
            : "",
        });
        applyChaos(chaosList(msg.chaos));
        const features = msg.features && typeof msg.features === "object" ? msg.features : null;
        if (features && typeof features.model === "boolean") applyModelFlag(features.model);
        renderConn();
        break;
      }
      case "stt": {
        if (msg.final) {
          const text = (msg.text || "").trim();
          if (text) finalUserLine(text);
          else setInterim("");
          state.lastUserTurnEndAt = now();
        } else {
          setInterim(msg.text || "");
        }
        break;
      }
      case "agent_text": {
        const t = onTurnSeen(msg.turnId);
        const el = agentEntry(msg.turnId);
        const delta = typeof msg.delta === "string" ? msg.delta : msg.text || "";
        if (delta) {
          if (t && !t.firstTextAt) { t.firstTextAt = now(); renderLatency(); }
          appendAgentText(el, delta);
          noteModelWorks();
        }
        break;
      }
      case "tool": {
        // Only a tool start belongs to the live turn; end/blocked can arrive late (after a
        // barge-in) and must not retarget the audio that follows.
        const t = msg.phase === "start" ? onTurnSeen(msg.turnId) : turnRecordOrNull(msg.turnId);
        onToolMessage(msg, t);
        break;
      }
      case "state": {
        renderState(msg.session);
        break;
      }
      case "clear_audio": {
        clearPlayback();
        const el = state.currentTurnId != null ? state.agentEntries.get(state.currentTurnId) : null;
        if (el && !el.classList.contains("interrupted")) {
          el.classList.add("interrupted");
          const tag = document.createElement("span");
          tag.className = "tag";
          tag.textContent = "interrupted";
          el.appendChild(tag);
        }
        logLine("Barge-in: audio cleared.");
        break;
      }
      case "latency": {
        // The server re-sends a turn's latency when `played` lands after finalize, so this is
        // often for a finished turn: record it without retargeting currentTurnId.
        const t = turnRecordOrNull(msg.turnId);
        if (t) {
          t.server = { ...t.server, ...msg };
          renderLatency();
        }
        break;
      }
      case "error": {
        const message = msg.message || "unknown";
        errLine(message);
        toast(message);
        noteModelError(message);
        break;
      }
      default:
        break;
    }
  }

  function onToolMessage(msg, t) {
    // Server shape (src/voice/session-voice.ts): the guard reason, the tool result or the failure
    // text travel in `detail`; `error: true` marks a tool that ran and failed. `reason` is read
    // as a fallback so a server that follows the CONTRACTS.md wording verbatim still shows a note.
    const note = typeof msg.detail === "string" ? msg.detail : typeof msg.reason === "string" ? msg.reason : "";
    const failed = msg.error === true || msg.ok === false;
    const closing = msg.phase === "end" || msg.phase === "blocked";
    const rows = state.toolRows;
    if (closing) {
      // pi-agent-core emits tool_execution_start before the guard runs, so a blocked call arrives
      // as `start` then `blocked`. Either closing phase completes the open start row; its args
      // are kept because the closing message carries none.
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i];
        if (r.turnId === msg.turnId && r.name === msg.name && r.phase === "start") {
          r.phase = msg.phase;
          r.ms = msg.ms;
          r.error = failed;
          if (note) r.note = note;
          if (msg.args !== undefined) r.args = msg.args;
          setChip(r);
          countToolMs(t, msg);
          renderTools();
          renderLatency();
          return;
        }
      }
    }
    const row = { turnId: msg.turnId, name: msg.name || "?", phase: msg.phase || "start", ms: msg.ms, args: msg.args, note, error: failed, chip: null, at: now() };
    rows.push(row);
    if (rows.length > 300) rows.splice(0, rows.length - 300);
    const chip = document.createElement("span");
    agentEntry(msg.turnId).querySelector(".activity").appendChild(chip);
    row.chip = chip;
    setChip(row);
    if (closing) countToolMs(t, msg);
    renderTools();
    renderLatency();
  }

  // What the customer sees for each tool. Unknown names fall back to the name with spaces.
  const TOOL_LABELS = {
    find_customer: "Finding your account",
    get_order: "Checking your order",
    get_delivery_slots: "Looking up delivery slots",
    check_resolution_options: "Checking what we can do",
    apply_resolution: "Applying the change",
    escalate_case: "Opening a case",
  };

  function toolLabel(name) {
    if (Object.prototype.hasOwnProperty.call(TOOL_LABELS, name)) return TOOL_LABELS[name];
    return String(name || "tool").replace(/_/g, " ");
  }

  // The chip in the conversation follows the row: a blinking dot while running, a plain label
  // when done, "blocked" or "failed" appended otherwise. The tool name and the server's detail
  // (guard reason, failure text) are in the tooltip; the table in the panel has them in full.
  function setChip(row) {
    if (!row.chip) return;
    const kind = row.phase === "blocked" ? "blocked" : row.phase === "end" && row.error ? "error" : row.phase === "start" ? "running" : "done";
    row.chip.className = "chip " + kind;
    row.chip.replaceChildren();
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = toolLabel(row.name);
    row.chip.appendChild(label);
    const suffix = kind === "blocked" ? "blocked" : kind === "error" ? "failed" : "";
    if (suffix) {
      const s = document.createElement("span");
      s.className = "state";
      s.textContent = suffix;
      row.chip.appendChild(s);
    }
    row.chip.title = row.name + (row.note ? ": " + compact(row.note, 300) : "");
  }

  function countToolMs(t, msg) {
    if (t && typeof msg.ms === "number" && isFinite(msg.ms)) t.clientToolMs += msg.ms;
  }

  function applyVoiceCaps(voice) {
    const prev = state.voice;
    state.voice = voice;
    if (!voice.stt) {
      if (state.micOn) stopMic();
      if (prev.stt) logLine("Server has no speech recognition. Type your messages below.");
    }
    if (!voice.tts && prev.tts) logLine("Server has no TTS, replies are text only.");
    if (voice.tts && voice.ttsEngine && voice.ttsEngine !== prev.ttsEngine) logLine("TTS engine: " + voice.ttsEngine + ".");
    els.ttsNote.hidden = !!voice.tts;
    if (els.voiceInfo) {
      els.voiceInfo.textContent = "stt " + (voice.stt ? "on" : "off") + ", tts " + (voice.tts ? voice.ttsEngine || "on" : "off");
    }
    renderControls();
    renderConn();
  }

  // Red badge in the "Under the hood" panel while the server runs with chaos toggles on (?fail=tts
  // on the page URL, forwarded on the WS handshake), plus a small dot on the panel toggle so the
  // badge is not missed while the panel is closed. Hidden when the list is empty.
  function applyChaos(list) {
    const prev = state.chaos;
    state.chaos = list;
    const el = els.chaosStatus;
    if (!list.length) {
      if (el) { el.hidden = true; el.textContent = ""; }
      if (els.hoodDot) els.hoodDot.hidden = true;
      els.btnHood.title = "";
      if (prev.length) logLine("Chaos off.");
      return;
    }
    const text = "chaos: " + list.join(", ");
    if (el) {
      el.textContent = text;
      el.className = "pill chaos";
      el.hidden = false;
    }
    if (els.hoodDot) els.hoodDot.hidden = false;
    els.btnHood.title = text + " (from the ?fail= query)";
    if (list.join(",") !== prev.join(",")) logLine("Chaos on: " + list.join(", ") + " will fail on purpose (from the ?fail= query).");
  }

  // ------------------------------------------------------------------- audio
  async function ensureAudio() {
    const a = state.audio;
    if (!a.playback) {
      // One init at a time: the mic and Send can race and must not open two contexts.
      if (!a.initPromise) a.initPromise = initPlayback().finally(() => { a.initPromise = null; });
      await a.initPromise;
    }
    if (a.ctx.state !== "running") await a.ctx.resume();
  }

  async function initPlayback() {
    const a = state.audio;
    if (!window.AudioContext) throw new Error("Web Audio is not available in this browser.");
    // The context is created once and stays on state even when the worklet module fails to load
    // (404, wrong MIME type, CSP), so a retry reuses it instead of opening another hardware
    // context. Chrome stops at about six of those.
    if (!a.ctx) a.ctx = new AudioContext();
    const ctx = a.ctx;
    if (!ctx.audioWorklet) {
      a.ctx = null;
      try { await ctx.close(); } catch {}
      throw new Error("AudioWorklet is not available in this browser.");
    }
    await ctx.audioWorklet.addModule("/worklet.js");
    const node = new AudioWorkletNode(ctx, "playback-processor", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
    node.port.onmessage = (e) => onPlaybackMessage(e.data || {});
    node.connect(ctx.destination);
    a.playback = node;
    a.outputRate = ctx.sampleRate;
    updateAudioInfo();
    flushPendingAudio(node);
  }

  // Replay audio that arrived before playback existed, but only for turns whose first chunk is
  // recent. A turn queued 40 s ago would otherwise play now and report a 40 s `played`.
  function flushPendingAudio(node) {
    const items = state.pendingAudio;
    state.pendingAudio = [];
    if (!items.length) return;
    const firstAt = new Map();
    for (const item of items) if (!firstAt.has(item.turnId)) firstAt.set(item.turnId, item.at);
    const cutoff = now() - PENDING_AUDIO_MAX_AGE_MS;
    let dropped = 0;
    for (const item of items) {
      if (firstAt.get(item.turnId) < cutoff) { dropped++; continue; }
      node.port.postMessage({ type: "audio", data: item.data, turnId: item.turnId }, [item.data]);
    }
    if (dropped) console.info("dropped " + dropped + " stale audio chunk(s) that were queued before playback was enabled");
  }

  function updateAudioInfo() {
    const a = state.audio;
    const parts = [];
    if (a.inputRate) parts.push("mic " + a.inputRate + " Hz to 16 kHz");
    if (a.outputRate) parts.push("playback 16 kHz to " + a.outputRate + " Hz");
    els.audioInfo.textContent = parts.join(", ");
  }

  function onAudioChunk(buf) {
    const turnId = state.currentTurnId;
    if (turnId != null) {
      const t = turnRecord(turnId);
      if (!t.firstAudioAt) { t.firstAudioAt = now(); renderLatency(); }
    }
    const node = state.audio.playback;
    if (node) {
      node.port.postMessage({ type: "audio", data: buf, turnId }, [buf]);
    } else {
      state.pendingAudio.push({ data: buf, turnId, at: now() });
      if (state.pendingAudio.length > 500) state.pendingAudio.shift();
      if (state.pendingAudio.length === 1) {
        logLine("Audio arrived before playback was enabled. Press the mic or Send once to enable sound.");
        noteLine("Sound is off until you press the mic or send a message once.");
      }
    }
  }

  function clearPlayback() {
    state.pendingAudio = [];
    if (state.audio.playback) state.audio.playback.port.postMessage({ type: "clear" });
  }

  function onPlaybackMessage(m) {
    if (m.type === "turn_started") {
      const turnId = m.turnId;
      if (turnId == null) return;
      const t = turnRecord(turnId);
      if (t.playedSent) return;
      t.playedSent = true;
      t.playedAt = now();
      sendJson({ type: "played", turnId, t: Date.now() });
      renderLatency();
    } else if (m.type === "playing") {
      clearTimeout(state.speakingTimer);
      els.speakStatus.hidden = false;
    } else if (m.type === "drained") {
      clearTimeout(state.speakingTimer);
      state.speakingTimer = setTimeout(() => { els.speakStatus.hidden = true; }, m.reason === "cleared" ? 0 : 250);
    } else if (m.type === "overflow") {
      console.warn("playback buffer overflow, dropped samples:", m.dropped);
    }
  }

  async function startMic() {
    if (state.micOn || state.micStarting) return;
    state.micStarting = true;
    renderMic();
    try {
      if (!window.isSecureContext) throw new Error("Microphone needs HTTPS or localhost. Use the text input instead.");
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("getUserMedia is not available here. Use the text input instead.");
      await ensureAudio();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const a = state.audio;
      const source = a.ctx.createMediaStreamSource(stream);
      const capture = new AudioWorkletNode(a.ctx, "capture-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        channelCountMode: "explicit",
        channelInterpretation: "speakers",
      });
      capture.port.onmessage = (e) => {
        const d = e.data;
        if (d instanceof ArrayBuffer) {
          if (state.micOn) sendBinary(d);
        } else if (d && d.type === "level") {
          // The inner ring grows with the mic level; the outer pulse is CSS.
          const level = Math.min(1, d.rms * 4);
          els.micLevel.style.transform = "scale(" + (1 + level * 0.45).toFixed(3) + ")";
        } else if (d && d.type === "ready") {
          a.inputRate = d.inputRate;
          updateAudioInfo();
        }
      };
      source.connect(capture);
      capture.connect(a.ctx.destination); // the capture processor writes no output, this only keeps it scheduled
      a.stream = stream;
      a.source = source;
      a.capture = capture;
      a.inputRate = a.ctx.sampleRate;
      updateAudioInfo();
      state.micOn = true;
      state.micStarting = false;
      renderMic();
      logLine("Mic on. Speak, or type below.");
    } catch (err) {
      state.micStarting = false;
      const text = micErrorText(err);
      errLine(text);
      toast(text);
      renderMic();
    }
  }

  function micErrorText(err) {
    const name = (err && err.name) || "";
    const message = (err && err.message) || "";
    const hint = " Use the text input instead.";
    switch (name) {
      case "NotAllowedError": return "Microphone permission was denied." + hint;
      case "NotFoundError": return "No microphone found." + hint;
      case "NotReadableError": return "Microphone is in use by another app or could not be opened." + hint;
      case "OverconstrainedError": return "Microphone does not support the requested audio settings." + hint;
      case "SecurityError": return "Microphone blocked by browser settings." + hint;
      case "AbortError": return "Microphone access was interrupted." + hint;
      default: break;
    }
    // Plain Errors are our own messages; a DOMException with an empty message still names itself.
    const base = !name || name === "Error" ? message || String(err) : name + (message ? ": " + message : "");
    if (base.includes(hint.trim())) return base; // already carries the hint
    return base + (/[.!?]$/.test(base) ? "" : ".") + hint;
  }

  function stopMic() {
    const a = state.audio;
    state.micOn = false;
    if (a.capture) {
      try { a.capture.port.postMessage({ type: "enable", value: false }); } catch {}
      try { a.capture.disconnect(); } catch {}
    }
    if (a.source) { try { a.source.disconnect(); } catch {} }
    if (a.stream) a.stream.getTracks().forEach((t) => t.stop());
    a.capture = null;
    a.source = null;
    a.stream = null;
    renderMic();
    logLine("Mic off.");
  }

  // --------------------------------------------------------------------- UI
  els.btnMic.addEventListener("click", () => {
    if (state.micOn) stopMic();
    else startMic();
  });
  els.btnReset.addEventListener("click", () => {
    if (!sendJson({ type: "reset" })) return;
    clearPlayback();
    resetPanels();
    clearFlow();
    logLine("Session reset.");
  });
  els.textForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (els.btnSend.disabled) return; // Enter still submits a form whose button is disabled
    const text = els.textInput.value.trim();
    if (!text) return;
    try { await ensureAudio(); } catch (err) { console.warn("audio unavailable, text only:", err); }
    if (!sendJson({ type: "text", text })) return;
    els.textInput.value = "";
    setInterim("");
    finalUserLine(text);
    state.lastUserTurnEndAt = now();
  });
  els.textInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      els.textForm.requestSubmit();
    }
  });
  els.btnHood.addEventListener("click", () => setHood(els.hood.hidden, true));
  window.addEventListener("beforeunload", () => {
    if (state.ws) { state.ws.onclose = null; state.ws.close(); }
  });

  let hoodOpen = false;
  try { hoodOpen = localStorage.getItem(HOOD_KEY) === "1"; } catch {}
  setHood(hoodOpen, false);
  renderModelBanner();
  renderState({});
  renderTools();
  renderLatency();
  renderConn();
  renderControls();
  connect();
})();
