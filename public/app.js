// Hemma support: browser client.
// Mic -> AudioWorklet (16 kHz Int16) -> WS binary. WS binary -> AudioWorklet ring buffer -> speakers.
// JSON control messages as in CONTRACTS.md. No dependencies.
//
// Three surfaces share one socket: the first screen (one button, "Start a call"), the conversation
// (bubbles, mic with a live ring, a status word, phrase chips, text input) and the "Under the hood"
// panel (tool calls, session state, latency, event log). Every server message type is handled as
// before. The call flow on top of it (greet, language) is optional protocol: an older server that
// answers "Unknown message type" for `greet` or `lang` is noted in the event log and the page keeps
// working without it.
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const els = {
    connStatus: $("connStatus"),
    chaosStatus: $("chaosStatus"),
    hoodDot: $("hoodDot"),
    audioInfo: $("audioInfo"),
    voiceInfo: $("voiceInfo"),
    btnStart: $("btnStart"),
    btnTypeInstead: $("btnTypeInstead"),
    cta: $("cta"),
    call: $("call"),
    howto: $("howto"),
    composer: $("composer"),
    phrases: $("phrases"),
    status: $("status"),
    statusWord: $("statusWord"),
    bars: $("bars"),
    liveHint: $("liveHint"),
    langButtons: [$("langEn"), $("langTr")].filter(Boolean),
    btnMic: $("btnMic"),
    micHint: $("micHint"),
    micLevel: $("micLevel"),
    btnReset: $("btnReset"),
    btnSend: $("btnSend"),
    btnHood: $("btnHood"),
    btnHood2: $("btnHood2"),
    chkBarge: $("chkBarge"),
    hoodDot2: $("hoodDot2"),
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

  // ------------------------------------------------------------------ strings
  // Every visible UI string in both languages. Event log lines, tool names and the raw snapshot
  // stay English: they are the engineering trail, not the customer surface.
  const STRINGS = {
    en: {
      title: "Hemma support",
      "lang.label": "Language",
      "call.label": "Conversation",
      "hero.title": "Customer support you can talk to.",
      "hero.lead": "Ask about an existing order: delivery dates, damaged items, late parcels. Speak or type, the assistant checks your order and applies what you confirm.",
      "cta.start": "Start a call",
      "cta.noMic": "No microphone?",
      "cta.type": "Type instead",
      "how.title": "How it works",
      "how.1": "Say who you are",
      "how.1s": "Your name and customer number, or the phone number on the order.",
      "how.2": "Ask about an order",
      "how.2s": "A delivery date, a damaged item, a late parcel.",
      "how.3": "Confirm before anything changes",
      "how.3s": "Nothing is applied until you say yes.",
      "phrases.label": "Try saying",
      "status.connecting": "Connecting",
      "status.listening": "Listening",
      "status.thinking": "Thinking",
      "status.speaking": "Speaking",
      "status.replying": "Replying",
      "status.yourTurn": "Your turn",
      "hint.interrupt": "You can interrupt any time, just start talking.",
      "hint.text": "Type a message or tap a phrase.",
      "mic.tap": "Tap to talk",
      "mic.listening": "Listening. Tap to mute.",
      "mic.starting": "Starting the microphone",
      "mic.offline": "The assistant is offline",
      "mic.voiceOff": "Voice input is off on this deployment",
      "mic.ariaStart": "Start voice input",
      "mic.ariaStop": "Stop voice input",
      "composer.placeholder": "Type a message",
      "composer.ariaMessage": "Message",
      "composer.send": "Send",
      "composer.reset": "Start over",
      "hood.toggle": "Under the hood",
      "hood.inline": "Under the hood: tool calls, session state and latency, live",
      "barge.label": "Let me interrupt the assistant",
      "conn.connecting": "connecting",
      "conn.connected": "connected",
      "conn.voiceReady": "voice ready",
      "conn.textOnly": "text only",
      "conn.reconnecting": "reconnecting",
      "conn.voiceReadyTitle": "Speech in, speech out",
      "conn.voiceReadyTextTitle": "Speech in, replies as text",
      "conn.textOnlyTitle": "Voice input is off on this deployment",
      "conn.retryIn": "retry in {s}s",
      "banner.model": "The assistant is offline on this deployment: the model key is not configured.",
      "note.tts": "Replies are text only on this deployment",
      "note.micFallback": "The microphone is not available, so this is a text conversation. Type below or tap a phrase.",
      "note.voiceOffFallback": "Voice is off on this deployment, so this is a text conversation. Type below or tap a phrase.",
      "note.noGreet": "The assistant is ready. Say hello, or tap a phrase.",
      "note.lost": "Connection lost. Reconnecting.",
      "note.restored": "Connection restored. The assistant starts a new session from here.",
      "note.soundOff": "Sound is off until you press the mic or send a message once.",
      "note.notConnected": "Not connected to the server.",
      "mic.err.hint": "Use the text input instead.",
      "mic.err.denied": "Microphone permission was denied.",
      "mic.err.notFound": "No microphone found.",
      "mic.err.busy": "Microphone is in use by another app or could not be opened.",
      "mic.err.constraints": "Microphone does not support the requested audio settings.",
      "mic.err.security": "Microphone blocked by browser settings.",
      "mic.err.aborted": "Microphone access was interrupted.",
      "mic.err.https": "Microphone needs HTTPS or localhost.",
      "mic.err.noGum": "Microphone access is not available in this browser.",
      "tag.interrupted": "interrupted",
      "chip.blocked": "blocked",
      "chip.failed": "failed",
      "tool.find_customer": "Finding your account",
      "tool.get_order": "Checking your order",
      "tool.get_delivery_slots": "Looking up delivery slots",
      "tool.check_resolution_options": "Checking what we can do",
      "tool.apply_resolution": "Applying the change",
      "tool.escalate_case": "Opening a case",
      "demo.title": "Demo customer",
      "demo.customerNo": "Customer number",
      "demo.phone": "Phone",
      "demo.order1": "Linen sofa cover, EUR 89, arriving Tuesday 8 September",
      "demo.order2": "Arc floor lamp, EUR 240, delivered 28 August",
      "demo.alt": "Second customer: Jonas Berg, <code>HM-2305</code>, order <code>HM-1010</code> is four days late.",
      "hood.title": "Under the hood",
      "hood.tools": "Tool calls",
      "hood.state": "Session state",
      "hood.latency": "Latency per turn (ms)",
      "hood.log": "Event log",
      "hood.raw": "Raw snapshot",
      "hood.toolsEmpty": "No tool calls yet.",
      "hood.latencyEmpty": "No turns yet. Values marked ~ are measured in the browser from the end of your turn; the rest come from the server. The p50 / p95 row summarises first token, first audio, played and total over the session's turns (nearest rank; turns cut by a barge-in are left out of total).",
      "hood.chaos": "Chaos: add <code>?fail=tts</code> to this page's URL and reload (comma separated for several, e.g. <code>?fail=tts,stt</code>); the server makes that part fail on purpose and the red badge above lists what is active.",
      "th.turn": "Turn",
      "th.tool": "Tool",
      "th.phase": "Phase",
      "th.ms": "ms",
      "th.args": "Args",
      "th.note": "Note",
      "th.sttFinal": "STT final",
      "th.firstToken": "First token",
      "th.firstAudio": "First audio",
      "th.played": "Played",
      "th.toolMs": "Tool ms",
      "th.total": "Total",
      "th.tts": "TTS",
      "state.customer": "Customer",
      "state.none": "none",
      "state.activeOrder": "Active order",
      "state.pending": "Pending",
      "state.applied": "Applied",
      "state.cases": "Cases",
      receipt: "Receipt",
      "receipt.n": "Receipt {i} of {n}",
      "foot.note": "Hemma is a fictional store built for a case study. Nothing here is a real order.",
      "foot.brief": "How this was built",
    },
    tr: {
      title: "Hemma destek",
      "lang.label": "Dil",
      "call.label": "Görüşme",
      "hero.title": "Konuşarak destek alın.",
      "hero.lead": "Mevcut bir siparişiniz hakkında sorun: teslimat tarihi, hasarlı ürün, geciken paket. Asistan siparişinizi kontrol eder, onayınızı alır ve uygular.",
      "cta.start": "Görüşmeyi başlat",
      "cta.noMic": "Mikrofon yok mu?",
      "cta.type": "Yazarak devam edin",
      "how.title": "Nasıl çalışır",
      "how.1": "Kim olduğunuzu söyleyin",
      "how.1s": "Adınız ve müşteri numaranız, ya da siparişteki telefon numarası.",
      "how.2": "Bir sipariş hakkında sorun",
      "how.2s": "Teslimat tarihi, hasarlı ürün, geciken paket.",
      "how.3": "Değişiklikten önce onaylayın",
      "how.3s": "Siz evet demeden hiçbir şey uygulanmaz.",
      "phrases.label": "Şunları deneyebilirsiniz",
      "status.connecting": "Bağlanıyor",
      "status.listening": "Dinliyor",
      "status.thinking": "Düşünüyor",
      "status.speaking": "Konuşuyor",
      "status.replying": "Yanıtlıyor",
      "status.yourTurn": "Sıra sizde",
      "hint.interrupt": "İstediğiniz an sözünü kesebilirsiniz, konuşmaya başlamanız yeterli.",
      "hint.text": "Bir mesaj yazın ya da bir cümleye dokunun.",
      "mic.tap": "Konuşmak için dokunun",
      "mic.listening": "Dinliyor. Susturmak için dokunun.",
      "mic.starting": "Mikrofon açılıyor",
      "mic.offline": "Asistan çevrimdışı",
      "mic.voiceOff": "Bu kurulumda sesli giriş kapalı",
      "mic.ariaStart": "Sesli girişi başlat",
      "mic.ariaStop": "Sesli girişi durdur",
      "composer.placeholder": "Mesajınızı yazın",
      "composer.ariaMessage": "Mesaj",
      "composer.send": "Gönder",
      "composer.reset": "Baştan başla",
      "hood.toggle": "Perde arkası",
      "hood.inline": "Perde arkası: tool çağrıları, oturum durumu ve gecikme, canlı",
      "barge.label": "Asistanın sözünü kesebilirim",
      "conn.connecting": "bağlanıyor",
      "conn.connected": "bağlandı",
      "conn.voiceReady": "ses hazır",
      "conn.textOnly": "yalnızca yazı",
      "conn.reconnecting": "yeniden bağlanıyor",
      "conn.voiceReadyTitle": "Sesli giriş, sesli yanıt",
      "conn.voiceReadyTextTitle": "Sesli giriş, yazılı yanıt",
      "conn.textOnlyTitle": "Bu kurulumda sesli giriş kapalı",
      "conn.retryIn": "{s} sn sonra yeniden denenecek",
      "banner.model": "Asistan bu kurulumda çevrimdışı: model anahtarı tanımlı değil.",
      "note.tts": "Bu kurulumda yanıtlar yalnızca yazılı",
      "note.micFallback": "Mikrofona erişilemedi, görüşme yazılı devam ediyor. Aşağıya yazabilir ya da bir cümleye dokunabilirsiniz.",
      "note.voiceOffFallback": "Bu kurulumda ses kapalı, görüşme yazılı devam ediyor. Aşağıya yazabilir ya da bir cümleye dokunabilirsiniz.",
      "note.noGreet": "Asistan hazır. Merhaba diyebilir ya da bir cümleye dokunabilirsiniz.",
      "note.lost": "Bağlantı koptu. Yeniden bağlanılıyor.",
      "note.restored": "Bağlantı yeniden kuruldu. Asistan buradan itibaren yeni bir oturum başlatıyor.",
      "note.soundOff": "Mikrofona basana ya da bir mesaj gönderene kadar ses kapalı.",
      "note.notConnected": "Sunucuya bağlı değil.",
      "mic.err.hint": "Bunun yerine yazabilirsiniz.",
      "mic.err.denied": "Mikrofon izni verilmedi.",
      "mic.err.notFound": "Mikrofon bulunamadı.",
      "mic.err.busy": "Mikrofon başka bir uygulama tarafından kullanılıyor ya da açılamadı.",
      "mic.err.constraints": "Mikrofon istenen ses ayarlarını desteklemiyor.",
      "mic.err.security": "Mikrofon tarayıcı ayarları tarafından engellendi.",
      "mic.err.aborted": "Mikrofon erişimi kesildi.",
      "mic.err.https": "Mikrofon için HTTPS ya da localhost gerekiyor.",
      "mic.err.noGum": "Bu tarayıcıda mikrofon erişimi yok.",
      "tag.interrupted": "kesildi",
      "chip.blocked": "engellendi",
      "chip.failed": "başarısız",
      "tool.find_customer": "Hesabınız bulunuyor",
      "tool.get_order": "Siparişiniz kontrol ediliyor",
      "tool.get_delivery_slots": "Teslimat saatleri aranıyor",
      "tool.check_resolution_options": "Seçenekler kontrol ediliyor",
      "tool.apply_resolution": "Değişiklik uygulanıyor",
      "tool.escalate_case": "Kayıt açılıyor",
      "demo.title": "Demo müşteri",
      "demo.customerNo": "Müşteri numarası",
      "demo.phone": "Telefon",
      "demo.order1": "Keten kanepe kılıfı, 89 EUR, 8 Eylül Salı günü teslim edilecek",
      "demo.order2": "Yay lambader, 240 EUR, 28 Ağustos'ta teslim edildi",
      "demo.alt": "İkinci müşteri: Jonas Berg, <code>HM-2305</code>; <code>HM-1010</code> numaralı sipariş dört gündür gecikmiş durumda.",
      "hood.title": "Perde arkası",
      "hood.tools": "Araç çağrıları",
      "hood.state": "Oturum durumu",
      "hood.latency": "Tur başına gecikme (ms)",
      "hood.log": "Olay günlüğü",
      "hood.raw": "Ham görüntü",
      "hood.toolsEmpty": "Henüz araç çağrısı yok.",
      "hood.latencyEmpty": "Henüz tur yok. ~ ile işaretli değerler tarayıcıda, sizin turunuzun bitiminden itibaren ölçülür; diğerleri sunucudan gelir. p50 / p95 satırı oturumdaki turların ilk token, ilk ses, çalınma ve toplam değerlerini özetler (en yakın sıra; sözü kesilen turlar toplama dahil edilmez).",
      "hood.chaos": "Kaos: bu sayfanın adresine <code>?fail=tts</code> ekleyip yenileyin (birden fazlası için virgülle ayırın, örneğin <code>?fail=tts,stt</code>); sunucu o parçayı bilerek bozar ve yukarıdaki kırmızı rozet aktif olanları listeler.",
      "th.turn": "Tur",
      "th.tool": "Araç",
      "th.phase": "Aşama",
      "th.ms": "ms",
      "th.args": "Argümanlar",
      "th.note": "Not",
      "th.sttFinal": "STT final",
      "th.firstToken": "İlk token",
      "th.firstAudio": "İlk ses",
      "th.played": "Çalındı",
      "th.toolMs": "Araç ms",
      "th.total": "Toplam",
      "th.tts": "TTS",
      "state.customer": "Müşteri",
      "state.none": "yok",
      "state.activeOrder": "Aktif sipariş",
      "state.pending": "Bekleyen",
      "state.applied": "Uygulanan",
      "state.cases": "Kayıtlar",
      receipt: "Makbuz",
      "receipt.n": "Makbuz {i} / {n}",
      "foot.note": "Hemma, bir vaka çalışması için kurgulanmış bir mağazadır. Buradaki hiçbir sipariş gerçek değildir.",
      "foot.brief": "Nasıl yapıldı",
    },
  };

  // The demo phrases, in the order of the run sheet (DEMO.md). The first one identifies the demo
  // customer; the rest assume it. Tapping one sends it as a text turn, in voice mode too.
  const PHRASES = {
    en: [
      "Hi, this is Anna Weber, customer number HM-2201.",
      "What's happening with my most recent order?",
      "A lamp from an earlier order arrived damaged",
      "Move the sofa cover delivery to Friday",
      "The morning slot, please",
      "Yes, go ahead",
      "Did that go through? Book it again",
    ],
    tr: [
      "Merhaba, ben Anna Weber, müşteri numaram HM-2201.",
      "En son siparişim ne durumda?",
      "Önceki siparişimdeki lamba hasarlı geldi",
      "Kanepe kılıfı teslimatını Cuma'ya alalım",
      "Sabah saati olsun lütfen",
      "Evet, onaylıyorum",
      "İşlem yapıldı mı? Bir daha kaydeder misiniz",
    ],
  };

  const freshCall = () => ({ active: false, mode: null, greetWanted: false, micCapturing: false, micFrameTimer: null, fellBack: false });

  const state = {
    lang: "en",
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
    voice: { stt: true, tts: true, ttsEngine: "", ttsEngines: [] }, // server capabilities from the `ready` message
    chaos: [], // active chaos toggles from the `ready` message (the ?fail= query)
    // Browser tts tier (CONTRACTS.md "speak"): local Web Speech API playback when no vendor
    // engine can speak a turn. `capsSent` is re-armed per socket, like `greeted`.
    browserTts: { supported: false, voiceCache: Object.create(null) },
    capsSent: false,
    // Model availability. `modelOffline` is hard evidence (healthz features.model false, or an
    // "Agent unavailable" error) and disables Send and the mic; `modelError` is a "Model error"
    // event and only shows the banner, so a transient failure keeps the controls usable. Both
    // are cleared by the next agent_text delta, which proves the model answered.
    modelOffline: false,
    modelError: false,
    micOn: false,
    micStarting: false,
    micLastError: null,
    currentTurnId: null,
    turnNumbers: new Map(), // turnId -> 1, 2, 3 ...
    turns: new Map(), // turnId -> { t0, firstTextAt, firstAudioAt, playedAt, playedSent, server, clientToolMs }
    lastUserTurnEndAt: 0,
    agentEntries: new Map(), // turnId -> conversation element
    interimEl: null,
    toolRows: [], // { turnId, name, phase, ms, args, note, at }
    lastSession: {},
    speakingTimer: null,
    toastTimer: null,
    // The call: the first screen's one action. `greetWanted` is set by Start a call / Type instead
    // and not by a typed or tapped first message, where the customer has already spoken first.
    call: freshCall(),
    greeted: false, // `greet` sent on this socket (re-armed on a new socket and by Start over)
    greetSupported: null, // false after an older server answered "Unknown message type: greet"
    langSupported: null, // true once `ready` echoes `lang`, false after "Unknown message type: lang"
    usedPhrases: new Set(),
    // Status word inputs: a turn is open from the customer's line (or the greet) to the server's
    // `latency` for it; `openTurnId` is set once that turn produces output.
    turnOpen: false,
    openTurnId: null,
    turnWatchdog: null,
    hearing: false, // an stt interim is on screen
    playing: false, // the playback worklet is rendering audio
    textStreaming: false, // agent_text deltas are arriving (drives "Replying" when TTS is off)
    textStreamTimer: null,
    runningTool: "",
    interruptExplained: false,
    phase: "idle",
  };

  const HOOD_KEY = "hemma.hood";
  const LANG_KEY = "hemma.lang";
  const EVENT_LOG_MAX = 200;
  const MIC_FRAME_TIMEOUT_MS = 1500; // greet anyway if the capture worklet posts no frame in time
  const TURN_WATCHDOG_MS = 30000; // "Thinking" cannot outlive the server's turn by more than this
  const TEXT_STREAM_IDLE_MS = 1200;

  // ------------------------------------------------------------------ helpers
  const now = () => performance.now();
  // Audio queued before the first user gesture is only replayed if its turn started within this
  // window, so a `played` report is never sent for a turn that finished long ago.
  const PENDING_AUDIO_MAX_AGE_MS = 3000;

  function t(key, vars) {
    const table = STRINGS[state.lang] || STRINGS.en;
    let s = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : STRINGS.en[key];
    if (s == null) return key;
    if (vars) for (const k of Object.keys(vars)) s = s.split("{" + k + "}").join(String(vars[k]));
    return s;
  }

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
  // must not relabel the next turn's audio. A turn seen for the first time is also an open turn
  // for the status word, whether or not the client saw the customer's line that started it.
  function onTurnSeen(turnId) {
    if (turnId == null) return null;
    const isNew = !state.turns.has(turnId);
    const t = turnRecord(turnId);
    state.currentTurnId = turnId;
    if (isNew || state.turnOpen) {
      state.turnOpen = true;
      state.openTurnId = turnId;
      armTurnWatchdog();
    }
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
    state.lastSession = s;
    const chips = [];
    if (s.customer && typeof s.customer === "object") {
      chips.push(t("state.customer") + ": " + (s.customer.name || s.customer.id || "?") + (s.customer.tier ? " (" + s.customer.tier + ")" : ""));
    } else {
      chips.push(t("state.customer") + ": " + t("state.none"));
    }
    if (s.activeOrderId) chips.push(t("state.activeOrder") + ": " + s.activeOrderId);
    if (s.pending && typeof s.pending === "object") {
      chips.push(t("state.pending") + ": " + (s.pending.summary || [s.pending.type, s.pending.orderId].filter(Boolean).join(" ")));
    } else {
      chips.push(t("state.pending") + ": " + t("state.none"));
    }
    const appliedList = Array.isArray(s.applied) ? s.applied : s.applied && typeof s.applied === "object" ? Object.values(s.applied) : [];
    chips.push(t("state.applied") + ": " + appliedList.length);
    chips.push(t("state.cases") + ": " + (Array.isArray(s.cases) ? s.cases.length : 0));
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
      label.textContent = entries.length > 1 ? t("receipt.n", { i: entries.length - i, n: entries.length }) : t("receipt");
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
    let text = t("conn.connecting");
    let cls = "";
    let title = "";
    if (state.wsOpen) {
      if (!state.ready) {
        text = t("conn.connected");
        cls = "ok";
      } else if (state.voice.stt) {
        text = t("conn.voiceReady");
        cls = "ok";
        title = state.voice.tts ? t("conn.voiceReadyTitle") : t("conn.voiceReadyTextTitle");
      } else {
        text = t("conn.textOnly");
        title = t("conn.textOnlyTitle");
      }
    } else if (state.everConnected) {
      text = t("conn.reconnecting");
      cls = "bad";
      title = state.retryIn ? t("conn.retryIn", { s: state.retryIn }) : "";
    }
    el.textContent = text;
    el.className = "pill" + (cls ? " " + cls : "");
    el.title = title || text;
  }

  // Send and the phrase chips are enabled whenever the socket is open and the model is not known
  // to be off. Start a call only needs the model: the socket may still be connecting behind it.
  function renderControls() {
    const canSend = state.wsOpen && !state.modelOffline;
    els.btnSend.disabled = !canSend;
    for (const b of els.phrases.children) b.disabled = !canSend;
    if (els.btnStart) els.btnStart.disabled = state.modelOffline;
    if (els.btnTypeInstead) els.btnTypeInstead.disabled = state.modelOffline;
    renderMic();
  }

  // The round mic button: green idle, ochre with a pulsing ring while listening, grey with the
  // reason as a tooltip and a caption when voice is unavailable.
  function renderMic() {
    const b = els.btnMic;
    let disabled = false;
    let hint = t("mic.tap");
    if (state.modelOffline) {
      disabled = true;
      hint = t("mic.offline");
    } else if (!state.voice.stt) {
      disabled = true;
      hint = t("mic.voiceOff");
    } else if (state.micStarting) {
      disabled = true;
      hint = t("mic.starting");
    } else if (state.micOn) {
      hint = t("mic.listening");
    }
    b.disabled = disabled;
    b.classList.toggle("listening", state.micOn);
    b.setAttribute("aria-pressed", state.micOn ? "true" : "false");
    b.setAttribute("aria-label", state.micOn ? t("mic.ariaStop") : t("mic.ariaStart"));
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
    if (els.btnHood2) els.btnHood2.setAttribute("aria-expanded", open ? "true" : "false");
    if (persist) {
      try { localStorage.setItem(HOOD_KEY, open ? "1" : "0"); } catch {}
    }
  }

  // --------------------------------------------------------------- language
  // URL ?lang= wins (a shareable Turkish link), then the saved choice, then the browser language.
  function initialLang() {
    try {
      const q = new URLSearchParams(location.search).get("lang");
      if (q === "tr" || q === "en") return q;
    } catch {}
    try {
      const saved = localStorage.getItem(LANG_KEY);
      if (saved === "tr" || saved === "en") return saved;
    } catch {}
    try {
      const nav = String((typeof navigator !== "undefined" && navigator.language) || "").toLowerCase();
      if (nav.startsWith("tr")) return "tr";
    } catch {}
    return "en";
  }

  // Static markup carries data-i18n keys; everything rendered from JS reads t() at render time.
  function applyStrings() {
    const all = (sel) => { try { return Array.from(document.querySelectorAll(sel)); } catch { return []; } };
    for (const el of all("[data-i18n]")) el.textContent = t(el.getAttribute("data-i18n"));
    for (const el of all("[data-i18n-html]")) el.innerHTML = t(el.getAttribute("data-i18n-html"));
    for (const el of all("[data-i18n-placeholder]")) el.setAttribute("placeholder", t(el.getAttribute("data-i18n-placeholder")));
    for (const el of all("[data-i18n-aria]")) el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria")));
    try { document.title = t("title"); } catch {}
    try { if (document.documentElement) document.documentElement.lang = state.lang; } catch {}
  }

  // Switches every UI string, the chips and (when the socket is open) the assistant's language.
  // The WS URL carries `lang` on connect; mid-session the `lang` message does it.
  function setLang(lang, opts) {
    const next = lang === "tr" ? "tr" : "en";
    const o = opts || {};
    const changed = next !== state.lang;
    state.lang = next;
    if (o.persist) {
      try { localStorage.setItem(LANG_KEY, next); } catch {}
    }
    applyStrings();
    for (const b of els.langButtons) b.setAttribute("aria-pressed", b.getAttribute("data-lang") === next ? "true" : "false");
    renderPhrases();
    renderConn();
    renderControls();
    renderStatus();
    renderState(state.lastSession);
    for (const row of state.toolRows) setChip(row);
    for (const tag of els.transcript.querySelectorAll(".tag")) tag.textContent = t("tag.interrupted");
    if (changed && o.send !== false && state.wsOpen && state.langSupported !== false) {
      if (sendJson({ type: "lang", lang: next })) logLine("Language switched to " + next + " (lang message sent).");
    } else if (changed) {
      logLine("Language switched to " + next + ".");
    }
  }

  // ----------------------------------------------------------------- phrases
  function renderPhrases() {
    const list = PHRASES[state.lang] || PHRASES.en;
    const canSend = state.wsOpen && !state.modelOffline;
    const frag = document.createDocumentFragment();
    list.forEach((text, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "phrase" + (state.usedPhrases.has(i) ? " used" : "");
      b.textContent = text;
      b.disabled = !canSend;
      b.addEventListener("click", () => {
        state.usedPhrases.add(i);
        b.classList.add("used");
        sendUserText(text);
      });
      frag.appendChild(b);
    });
    els.phrases.replaceChildren(frag);
  }

  // ---------------------------------------------------------------- the call
  function renderCall() {
    const active = state.call.active;
    if (els.cta) els.cta.hidden = active;
    if (els.howto) els.howto.hidden = active;
    els.transcript.hidden = !active;
    if (els.composer) els.composer.hidden = !active;
    if (els.call) els.call.classList.toggle("active", active);
  }

  function focusInput() {
    if (state.call.mode !== "text") return;
    try { if (typeof els.textInput.focus === "function") els.textInput.focus({ preventScroll: true }); } catch {}
  }

  // On a phone the hero fills the first screen; once the call starts the conversation is what
  // matters, so it is scrolled under the header.
  function bringCallIntoView() {
    try {
      if (!window.innerWidth || window.innerWidth > 860) return;
      if (!els.call || typeof els.call.scrollIntoView !== "function") return;
      let reduce = false;
      try { reduce = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch {}
      els.call.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
    } catch {}
  }

  function activateCall(mode, wantGreet) {
    state.call = { active: true, mode, greetWanted: !!wantGreet, micCapturing: false, micFrameTimer: null, fellBack: false };
    state.turnOpen = false;
    state.openTurnId = null;
    state.hearing = false;
    renderCall();
    renderControls();
    renderStatus();
    logLine("Call started (" + mode + ", " + state.lang + ").");
    bringCallIntoView();
  }

  // Start a call: ask for the mic, then greet once the mic is capturing. Type instead: text mode,
  // greet right away. Both wait for `ready` if the socket is still connecting.
  async function startCall(mode) {
    if (state.call.active) return;
    activateCall(mode, true);
    try { await ensureAudio(); } catch (err) { logLine("Audio unavailable: " + ((err && err.message) || err)); }
    if (mode === "voice") {
      if (state.ready && !state.voice.stt) {
        fallbackToText("voiceOff");
      } else {
        const ok = await startMic();
        if (!ok) fallbackToText("mic", state.micLastError);
        else if (!state.voice.stt) { stopMic(); fallbackToText("voiceOff"); } // `ready` with stt off landed meanwhile
      }
    } else {
      focusInput();
    }
    maybeGreet();
  }

  // The one line of explanation when the mic is refused or voice is off on the server; the call
  // goes on as text.
  function fallbackToText(reason, err) {
    if (!state.call.active || state.call.fellBack) return;
    state.call.fellBack = true;
    state.call.mode = "text";
    state.call.micCapturing = false;
    if (err) logLine("Mic unavailable: " + (((err && err.name) || "") + " " + ((err && err.message) || "")).trim());
    else logLine("Voice input is off on the server, the call continues as text.");
    noteLine(t(reason === "mic" ? "note.micFallback" : "note.voiceOffFallback"));
    focusInput();
    renderStatus();
    maybeGreet();
  }

  // `greet` once per socket (re-armed by Start over, which starts a new server session): after
  // `ready`, and in voice mode only once the capture worklet has posted its first frame.
  function maybeGreet() {
    const c = state.call;
    if (!c.active || !c.greetWanted || state.greeted) return;
    if (!state.wsOpen || !state.ready || state.greetSupported === false) return;
    if (c.mode === "voice" && !c.micCapturing) return;
    state.greeted = true;
    if (!sendJson({ type: "greet" })) { state.greeted = false; return; }
    // The greet turn is measured from here: the browser's first token / first audio / played
    // estimates are relative to the request, like a customer turn is to the end of their line.
    state.lastUserTurnEndAt = now();
    state.turnOpen = true;
    state.openTurnId = null;
    armTurnWatchdog();
    logLine("Greet requested (" + c.mode + ", " + state.lang + ").");
    renderStatus();
  }

  function onMicCapturing(how) {
    if (state.call.micCapturing) return;
    state.call.micCapturing = true;
    clearTimeout(state.call.micFrameTimer);
    state.call.micFrameTimer = null;
    logLine(how === "timeout" ? "No mic frame after " + MIC_FRAME_TIMEOUT_MS + " ms, greeting anyway." : "Mic is capturing (first frame sent).");
    maybeGreet();
  }

  // A customer line went to the server (typed, tapped or spoken). Marks the turn open for the
  // status word; the first one also retires the interrupt hint.
  function userTurnSent() {
    state.lastUserTurnEndAt = now();
    state.turnOpen = true;
    state.openTurnId = null;
    state.hearing = false;
    // The interrupt hint is only ever on screen in voice mode with the mic on; the first customer
    // line while it is showing retires it for the rest of the page's life.
    if (state.call.mode === "voice" && state.micOn) state.interruptExplained = true;
    armTurnWatchdog();
    renderStatus();
  }

  function closeTurn() {
    state.turnOpen = false;
    state.openTurnId = null;
    state.runningTool = "";
    clearTimeout(state.turnWatchdog);
    state.turnWatchdog = null;
    renderStatus();
  }

  function armTurnWatchdog() {
    clearTimeout(state.turnWatchdog);
    state.turnWatchdog = setTimeout(() => {
      if (!state.turnOpen) return;
      logLine("No turn end from the server in " + TURN_WATCHDOG_MS / 1000 + " s, status reset.");
      closeTurn();
    }, TURN_WATCHDOG_MS);
  }

  // Sends a customer line as text. Before the call this starts one in text mode without a greet:
  // the customer has spoken first.
  async function sendUserText(text) {
    if (!text) return false;
    if (!state.call.active) activateCall("text", false);
    try { await ensureAudio(); } catch (err) { console.warn("audio unavailable, text only:", err); }
    if (!sendJson({ type: "text", text })) return false;
    setInterim("");
    finalUserLine(text);
    userTurnSent();
    return true;
  }

  // ----------------------------------------------------------- status word
  // Listening / Thinking / Speaking, from what the page can see: stt interims, the open turn,
  // tool activity, the playback worklet.
  function computePhase() {
    const c = state.call;
    if (!c.active) return "idle";
    if (!state.wsOpen || !state.ready) return "connecting";
    if (state.hearing) return "listening";
    if (state.playing) return "speaking";
    if (!state.voice.tts && state.textStreaming) return "speaking";
    if (state.turnOpen) return "thinking";
    if (state.micOn) return "listening";
    return "yourTurn";
  }

  function phaseWord(phase) {
    switch (phase) {
      case "connecting": return t("status.connecting");
      case "listening": return t("status.listening");
      case "thinking": return t("status.thinking");
      case "speaking": return state.voice.tts ? t("status.speaking") : t("status.replying");
      case "yourTurn": return t("status.yourTurn");
      default: return "";
    }
  }

  function hintText(phase) {
    if (phase === "thinking" && state.runningTool) return toolLabel(state.runningTool);
    if (state.call.mode === "voice" && state.micOn && !state.interruptExplained) return t("hint.interrupt");
    if (state.call.mode === "text" && phase === "yourTurn") return t("hint.text");
    return "";
  }

  function renderStatus() {
    if (!els.status) return;
    const phase = computePhase();
    state.phase = phase;
    els.status.className = "status " + phase;
    els.statusWord.textContent = phaseWord(phase);
    els.bars.hidden = phase !== "speaking";
    els.liveHint.textContent = hintText(phase);
  }

  function noteTextStreaming() {
    state.textStreaming = true;
    clearTimeout(state.textStreamTimer);
    state.textStreamTimer = setTimeout(() => { state.textStreaming = false; renderStatus(); }, TEXT_STREAM_IDLE_MS);
  }

  // --------------------------------------------------------------- websocket
  function sendJson(obj) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      toast(t("note.notConnected"));
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

  function wsUrl() {
    const params = new URLSearchParams();
    params.set("lang", state.lang);
    const fail = failQuery();
    if (fail) params.set("fail", fail);
    return (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws?" + params.toString();
  }

  function connect() {
    clearTimers();
    state.ready = false;
    state.retryIn = 0;
    renderConn();
    const url = wsUrl();
    let ws;
    try { ws = new WebSocket(url); } catch (e) { scheduleReconnect(); return; }
    ws.binaryType = "arraybuffer";
    state.ws = ws;
    ws.onopen = () => {
      state.wsOpen = true;
      state.reconnectDelay = 1000;
      state.lostNoted = false;
      state.greeted = false; // a new socket is a new server session
      state.capsSent = false; // caps is one-shot per socket too
      state.turnOpen = false;
      state.openTurnId = null;
      state.runningTool = "";
      renderConn();
      renderControls();
      if (state.everConnected) {
        resetPanels();
        logLine("Reconnected. The server started a new session, panels were cleared.");
        noteLine(t("note.restored"));
      } else {
        logLine("Connected to " + url);
      }
      state.everConnected = true;
      renderStatus();
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
      state.hearing = false;
      renderControls();
      if (state.everConnected && !state.lostNoted) {
        state.lostNoted = true;
        noteLine(t("note.lost"));
      }
      renderStatus();
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
        const ttsEngines = Array.isArray(voice.ttsEngines) ? voice.ttsEngines.filter((v) => typeof v === "string") : [];
        applyVoiceCaps({
          stt: voice.stt !== false,
          tts: voice.tts !== false,
          ttsEngine: typeof voice.ttsEngine === "string" ? voice.ttsEngine
            : typeof voice.engine === "string" ? voice.engine
            : ttsEngines.length ? ttsEngines.join(", ")
            : "",
          ttsEngines,
        });
        applyChaos(chaosList(msg.chaos));
        if (!state.capsSent) { state.capsSent = true; sendCaps(); }
        const features = msg.features && typeof msg.features === "object" ? msg.features : null;
        if (features && typeof features.model === "boolean") applyModelFlag(features.model);
        // A server that speaks the language protocol echoes `lang`. A mismatch is logged, not
        // corrected: the page keeps the customer's choice.
        if (typeof msg.lang === "string") {
          state.langSupported = true;
          if (msg.lang !== state.lang) logLine("Server language is " + msg.lang + ", the page is " + state.lang + ".");
          else logLine("Server language: " + msg.lang + ".");
        }
        renderConn();
        renderStatus();
        maybeGreet();
        break;
      }
      case "stt": {
        if (msg.final) {
          const text = (msg.text || "").trim();
          if (text) {
            finalUserLine(text);
            userTurnSent();
          } else {
            setInterim("");
            state.hearing = false;
            renderStatus();
          }
          state.lastUserTurnEndAt = now();
        } else {
          setInterim(msg.text || "");
          state.hearing = !!(msg.text || "").trim();
          renderStatus();
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
          noteTextStreaming();
        }
        renderStatus();
        break;
      }
      case "speak": {
        // Browser tts tier (CONTRACTS.md): no server audio for this turn, speak locally. Text
        // already arrived through agent_text, so this does not retarget currentTurnId.
        const text = typeof msg.text === "string" ? msg.text : "";
        const lang = msg.lang === "tr" ? "tr" : "en";
        const seq = typeof msg.seq === "number" ? msg.seq : 0;
        if (text && state.browserTts.supported) speakBrowser(String(msg.turnId), seq, text, lang);
        else if (text) sendJson({ type: "speak_done", turnId: msg.turnId, seq, t: Date.now() }); // no local voice: never hang the turn
        break;
      }
      case "tool": {
        // Only a tool start belongs to the live turn; end/blocked can arrive late (after a
        // barge-in) and must not retarget the audio that follows.
        const t = msg.phase === "start" ? onTurnSeen(msg.turnId) : turnRecordOrNull(msg.turnId);
        onToolMessage(msg, t);
        if (msg.phase === "start") state.runningTool = msg.name || "";
        else if (state.runningTool === (msg.name || "")) state.runningTool = "";
        renderStatus();
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
          tag.textContent = t("tag.interrupted");
          el.appendChild(tag);
        }
        logLine("Barge-in: audio cleared.");
        // The turn that was producing output is cancelled. A turn the customer just sent (text
        // while audio still played) has no output yet and stays open.
        if (state.openTurnId != null) closeTurn();
        else renderStatus();
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
        if (state.turnOpen && (state.openTurnId == null || msg.turnId === state.openTurnId)) closeTurn();
        break;
      }
      case "error": {
        const message = msg.message || "unknown";
        // An older server answers the optional `greet` / `lang` messages with this. Not an
        // error for the customer: noted in the event log, the page carries on without them.
        const unknown = /^Unknown message type: (greet|lang)$/.exec(message);
        if (unknown) {
          logLine("Server does not support the " + unknown[1] + " message (older server).");
          if (unknown[1] === "greet") {
            state.greetSupported = false;
            closeTurn();
            noteLine(t("note.noGreet"));
          } else {
            state.langSupported = false;
          }
          break;
        }
        errLine(message);
        toast(message);
        noteModelError(message);
        if (/^(Model error|Agent unavailable)/i.test(message)) closeTurn();
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

  // What the customer sees for each tool, in the current language. Unknown names fall back to
  // the name with spaces.
  function toolLabel(name) {
    const key = "tool." + name;
    if (Object.prototype.hasOwnProperty.call(STRINGS.en, key)) return t(key);
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
    const suffix = kind === "blocked" ? t("chip.blocked") : kind === "error" ? t("chip.failed") : "";
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
      // A voice call on a server without STT carries on as text, with the one-line explanation.
      if (state.call.active && state.call.mode === "voice") fallbackToText("voiceOff");
    }
    if (!voice.tts && prev.tts) logLine("Server has no TTS, replies are text only.");
    if (voice.tts && voice.ttsEngine && voice.ttsEngine !== prev.ttsEngine) logLine("TTS engine: " + voice.ttsEngine + ".");
    els.ttsNote.hidden = !!voice.tts;
    if (els.voiceInfo) {
      els.voiceInfo.textContent = "stt " + (voice.stt ? "on" : "off") + ", tts " + (voice.tts ? voice.ttsEngine || "on" : "off");
    }
    renderControls();
    renderConn();
    renderStatus();
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
      if (els.hoodDot2) els.hoodDot2.hidden = true;
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
    if (els.hoodDot2) els.hoodDot2.hidden = false;
    els.btnHood.title = text + " (from the ?fail= query)";
    if (list.join(",") !== prev.join(",")) logLine("Chaos on: " + list.join(", ") + " will fail on purpose (from the ?fail= query).");
  }

  // -------------------------------------------------------------- browser tts
  // Last-resort speech tier (CONTRACTS.md): no vendor engine, no quota, whatever voice the OS
  // already has. Feature-detected once per socket and reported to the server as `caps`; driven
  // per sentence by the server's `speak` messages, never opened on our own initiative.
  const VOICES_WAIT_MS = 300; // Chrome loads voices asynchronously; never block longer than this.

  function getVoicesOnce() {
    return new Promise((resolve) => {
      if (!window.speechSynthesis) { resolve([]); return; }
      let voices;
      try { voices = speechSynthesis.getVoices(); } catch { resolve([]); return; }
      if (voices && voices.length) { resolve(voices); return; }
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        try { speechSynthesis.removeEventListener("voiceschanged", onChanged); } catch {}
        let v = [];
        try { v = speechSynthesis.getVoices() || []; } catch {}
        resolve(v);
      };
      const onChanged = () => finish();
      try { speechSynthesis.addEventListener("voiceschanged", onChanged); } catch {}
      setTimeout(finish, VOICES_WAIT_MS);
    });
  }

  // Feature-detect and report to the server once per socket. Sent after `ready`, per CONTRACTS.md.
  async function sendCaps() {
    const supported = !!(window.speechSynthesis && window.SpeechSynthesisUtterance);
    let voiceNames = [];
    if (supported) {
      try { voiceNames = (await getVoicesOnce()).map((v) => v.lang + (v.name ? " " + v.name : "")); } catch {}
    }
    state.browserTts.supported = supported;
    sendJson({ type: "caps", browserTts: supported, voices: voiceNames });
    // The barge-in box sits on the first screen, so someone in a noisy room can turn it off
    // before the call starts. The socket did not exist then, so send that choice now.
    if (els.chkBarge && !els.chkBarge.checked) sendJson({ type: "barge_in", enabled: false });
    logLine("Capabilities sent: browserTts=" + supported + (voiceNames.length ? " (" + voiceNames.length + " voice(s))" : ""));
    if (!supported) {
      // Only worth a note if there is nothing else that could speak either; a vendor engine
      // still carries the turn otherwise.
      const vendorEngines = (state.voice.ttsEngines || []).filter((e) => e !== "browser");
      if (vendorEngines.length === 0) {
        els.ttsNote.hidden = false;
        logLine("This browser has no speech synthesis and the server has no TTS engine: replies are text only.");
      }
    }
  }

  // Prefer a local voice whose lang starts with the requested language; remember the choice so
  // later sentences in the same language do not re-scan the voice list.
  function pickVoice(lang) {
    const cache = state.browserTts.voiceCache;
    if (Object.prototype.hasOwnProperty.call(cache, lang)) return cache[lang];
    let voices = [];
    try { voices = speechSynthesis.getVoices() || []; } catch {}
    const matches = voices.filter((v) => v && typeof v.lang === "string" && v.lang.toLowerCase().startsWith(lang));
    const voice = matches.find((v) => v.localService) || matches[0] || null;
    cache[lang] = voice;
    return voice;
  }

  // One sentence on the browser tts tier. speechSynthesis.speak() queues internally and plays
  // utterances strictly in the order they were queued, so sentences never overlap without any
  // queue of our own; clearPlayback() (on clear_audio) empties that queue with cancel().
  function speakBrowser(turnId, seq, text, lang) {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang === "tr" ? "tr-TR" : "en-US";
    const voice = pickVoice(lang);
    if (voice) u.voice = voice;
    u.rate = 1.0;
    u.pitch = 1.0;
    let doneSent = false;
    const sendDone = () => {
      if (doneSent) return;
      doneSent = true;
      sendJson({ type: "speak_done", turnId, seq, t: Date.now() });
      onBrowserSpeakSettled();
    };
    u.onstart = () => {
      sendJson({ type: "speak_start", turnId, seq, t: Date.now() });
      onBrowserSpeakStart(turnId);
    };
    u.onend = sendDone;
    u.onerror = sendDone; // a failure must not hang the turn either
    try {
      speechSynthesis.speak(u);
    } catch (err) {
      logLine("speechSynthesis.speak failed: " + ((err && err.message) || err));
      sendDone();
    }
  }

  // Mirrors what onAudioChunk / onPlaybackMessage do for vendor audio: first-audio timing for the
  // latency table and the "Speaking" status word, from the utterance's own start/end/error events
  // rather than the playback worklet (there is no worklet on this tier).
  function onBrowserSpeakStart(turnId) {
    const t = turnRecord(turnId);
    if (!t.firstAudioAt) { t.firstAudioAt = now(); renderLatency(); }
    if (!t.playedAt) { t.playedAt = now(); renderLatency(); } // no separate transport delay to measure here
    clearTimeout(state.speakingTimer);
    state.playing = true;
    renderStatus();
  }

  function onBrowserSpeakSettled() {
    clearTimeout(state.speakingTimer);
    state.speakingTimer = setTimeout(() => { state.playing = false; renderStatus(); }, 250);
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
        noteLine(t("note.soundOff"));
      }
    }
  }

  function clearPlayback() {
    state.pendingAudio = [];
    if (state.audio.playback) state.audio.playback.port.postMessage({ type: "clear" });
    // Browser tts tier: cancel any speech in progress or queued. This also drops every utterance
    // still queued for the cancelled turn, since speechSynthesis.cancel() empties the whole queue.
    try { if (window.speechSynthesis) speechSynthesis.cancel(); } catch {}
    // The buffered audio is gone now; the worklet's own "drained (cleared)" follows and agrees.
    clearTimeout(state.speakingTimer);
    state.playing = false;
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
      state.playing = true;
      renderStatus();
    } else if (m.type === "drained") {
      // A short grace so a gap between two sentences does not flicker the status word.
      clearTimeout(state.speakingTimer);
      state.speakingTimer = setTimeout(() => { state.playing = false; renderStatus(); }, m.reason === "cleared" ? 0 : 250);
    } else if (m.type === "overflow") {
      console.warn("playback buffer overflow, dropped samples:", m.dropped);
    }
  }

  function micError(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
  }

  // Opens the mic. Returns true when capturing; on failure the error is in state.micLastError and
  // the caller decides what to show (the call start shows the text fallback line, the mic button
  // shows the error).
  async function startMic() {
    if (state.micOn) return true;
    if (state.micStarting) return false;
    state.micStarting = true;
    state.micLastError = null;
    renderMic();
    try {
      if (!window.isSecureContext) throw micError("https", "Microphone needs HTTPS or localhost.");
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw micError("nogum", "getUserMedia is not available here.");
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
          if (state.micOn && !state.call.micCapturing) onMicCapturing("frame");
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
      if (state.call.active) state.call.mode = "voice";
      renderMic();
      renderStatus();
      logLine("Mic on. Speak, or type below.");
      clearTimeout(state.call.micFrameTimer);
      state.call.micFrameTimer = setTimeout(() => { if (state.micOn && state.call.active) onMicCapturing("timeout"); }, MIC_FRAME_TIMEOUT_MS);
      return true;
    } catch (err) {
      state.micStarting = false;
      state.micLastError = err;
      renderMic();
      renderStatus();
      return false;
    }
  }

  function micErrorText(err) {
    const name = (err && err.name) || "";
    const message = (err && err.message) || "";
    const code = (err && err.code) || "";
    const hint = " " + t("mic.err.hint");
    const known = {
      NotAllowedError: "mic.err.denied",
      NotFoundError: "mic.err.notFound",
      NotReadableError: "mic.err.busy",
      OverconstrainedError: "mic.err.constraints",
      SecurityError: "mic.err.security",
      AbortError: "mic.err.aborted",
    };
    if (Object.prototype.hasOwnProperty.call(known, name)) return t(known[name]) + hint;
    if (code === "https") return t("mic.err.https") + hint;
    if (code === "nogum") return t("mic.err.noGum") + hint;
    // Plain Errors are our own messages; a DOMException with an empty message still names itself.
    const base = !name || name === "Error" ? message || String(err) : name + (message ? ": " + message : "");
    return base + (/[.!?]$/.test(base) ? "" : ".") + hint;
  }

  function stopMic() {
    const a = state.audio;
    state.micOn = false;
    clearTimeout(state.call.micFrameTimer);
    state.call.micFrameTimer = null;
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
    renderStatus();
    logLine("Mic off.");
  }

  // --------------------------------------------------------------------- UI
  if (els.btnStart) els.btnStart.addEventListener("click", () => { startCall("voice"); });
  if (els.btnTypeInstead) els.btnTypeInstead.addEventListener("click", () => { startCall("text"); });
  for (const b of els.langButtons) {
    b.addEventListener("click", () => setLang(b.getAttribute("data-lang"), { persist: true }));
  }
  els.btnMic.addEventListener("click", async () => {
    if (state.micOn) { stopMic(); return; }
    const ok = await startMic();
    if (!ok) {
      const text = micErrorText(state.micLastError);
      errLine(text);
      toast(text);
      return;
    }
    maybeGreet();
  });
  // Start over: the server gets a fresh session, the page returns to the first screen, and the
  // next Start a call greets again.
  els.btnReset.addEventListener("click", () => {
    const sent = sendJson({ type: "reset" });
    clearPlayback();
    resetPanels();
    clearFlow();
    if (sent) logLine("Session reset.");
    if (state.micOn) stopMic();
    state.call = freshCall();
    state.greeted = false;
    state.turnOpen = false;
    state.openTurnId = null;
    state.runningTool = "";
    state.hearing = false;
    state.playing = false;
    state.textStreaming = false;
    clearTimeout(state.turnWatchdog);
    state.usedPhrases.clear();
    renderPhrases();
    renderCall();
    renderControls();
    renderStatus();
    logLine("Call ended.");
  });
  els.textForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (els.btnSend.disabled) return; // Enter still submits a form whose button is disabled
    const text = els.textInput.value.trim();
    if (!text) return;
    if (await sendUserText(text)) els.textInput.value = "";
  });
  els.textInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      els.textForm.requestSubmit();
    }
  });
  els.btnHood.addEventListener("click", () => setHood(els.hood.hidden, true));
  if (els.btnHood2) els.btnHood2.addEventListener("click", () => setHood(els.hood.hidden, true));
  if (els.chkBarge) {
    els.chkBarge.addEventListener("change", () => {
      const enabled = !!els.chkBarge.checked;
      sendJson({ type: "barge_in", enabled });
      logLine(enabled ? "barge-in on" : "barge-in off");
    });
  }
  window.addEventListener("beforeunload", () => {
    if (state.ws) { state.ws.onclose = null; state.ws.close(); }
  });

  let hoodOpen = false;
  try { hoodOpen = localStorage.getItem(HOOD_KEY) === "1"; } catch {}
  setHood(hoodOpen, false);
  state.lang = initialLang();
  setLang(state.lang, { persist: false, send: false });
  renderModelBanner();
  renderState({});
  renderTools();
  renderLatency();
  renderCall();
  renderConn();
  renderControls();
  renderStatus();
  connect();
})();
