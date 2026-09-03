// Hemma support demo: AudioWorklet processors.
// Loaded once with audioContext.audioWorklet.addModule('/worklet.js').
//
//   capture-processor  : mic input at the context rate (44.1 kHz, 48 kHz, anything)
//                        -> 16 kHz Int16 PCM frames posted to the main thread as ArrayBuffers
//   playback-processor : 16 kHz Int16 PCM from the server -> ring buffer -> context rate output
//
// Both run inside the audio rendering thread. `sampleRate` and `currentTime` are globals here.

const TARGET_RATE = 16000;

// ---------------------------------------------------------------------------
// Capture: box-filter resampler. Every output sample is the average of the input
// samples covering [pos, pos + ratio), with fractional weights at the edges. That
// handles integer ratios (48k / 16k = 3) and fractional ones (44.1k / 16k = 2.75625)
// with the same code and gives a cheap anti-alias filter for speech.
// ---------------------------------------------------------------------------
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.frameSamples = 320; // 20 ms at 16 kHz per WebSocket frame
    this.inBuf = new Float32Array(16384);
    this.inLen = 0;
    this.pos = 0; // fractional read position inside inBuf
    this.out = new Int16Array(this.frameSamples);
    this.outLen = 0;
    this.enabled = true;
    this.levelAcc = 0;
    this.levelN = 0;
    this.levelAt = 0;
    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === "enable") this.enabled = !!m.value;
    };
    this.port.postMessage({ type: "ready", inputRate: sampleRate, outputRate: TARGET_RATE, ratio: this.ratio });
  }

  process(inputs) {
    if (!this.enabled) return true;
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;
    const n = input[0].length;
    if (this.inLen + n > this.inBuf.length) {
      // Cannot happen while we consume every quantum, but never overrun the buffer.
      this.inLen = 0;
      this.pos = 0;
    }

    // Mix down to mono into inBuf.
    const chans = input.length;
    const base = this.inLen;
    if (chans === 1) {
      this.inBuf.set(input[0], base);
    } else {
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let c = 0; c < chans; c++) s += input[c][i];
        this.inBuf[base + i] = s / chans;
      }
    }
    this.inLen += n;

    // Level meter, posted roughly every 80 ms.
    for (let i = 0; i < n; i++) {
      const v = this.inBuf[base + i];
      this.levelAcc += v * v;
    }
    this.levelN += n;
    if (currentTime - this.levelAt >= 0.08) {
      this.port.postMessage({ type: "level", rms: Math.sqrt(this.levelAcc / Math.max(1, this.levelN)) });
      this.levelAcc = 0;
      this.levelN = 0;
      this.levelAt = currentTime;
    }

    // Resample.
    const ratio = this.ratio;
    const buf = this.inBuf;
    const len = this.inLen;
    let pos = this.pos;
    while (pos + ratio <= len) {
      const end = pos + ratio;
      const i0 = Math.floor(pos);
      const i1 = Math.ceil(end);
      let sum = 0;
      let wsum = 0;
      for (let i = i0; i < i1; i++) {
        const a = pos > i ? pos : i;
        const b = end < i + 1 ? end : i + 1;
        const w = b - a;
        if (w > 0) {
          sum += buf[i] * w;
          wsum += w;
        }
      }
      let v = wsum > 0 ? sum / wsum : 0;
      if (v > 1) v = 1;
      else if (v < -1) v = -1;
      this.out[this.outLen++] = v < 0 ? v * 32768 : v * 32767;
      if (this.outLen === this.frameSamples) {
        const frame = this.out;
        this.port.postMessage(frame.buffer, [frame.buffer]);
        this.out = new Int16Array(this.frameSamples);
        this.outLen = 0;
      }
      pos = end;
    }

    // Drop consumed input, keep the fractional remainder.
    const consumed = Math.floor(pos);
    if (consumed > 0) {
      buf.copyWithin(0, consumed, len);
      this.inLen = len - consumed;
      this.pos = pos - consumed;
    } else {
      this.pos = pos;
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// Playback: ring buffer holding 16 kHz float samples, read with linear
// interpolation at the context rate. Absolute counters (writeCount, readPos)
// avoid wrap bugs; the ring index is count % size.
//
// Rendering starts only once PREFILL_SAMPLES are buffered, or PREFILL_TIMEOUT_S after the first
// push into an empty buffer, whichever comes first. Without that cushion a small first TTS chunk
// followed by a short network gap is an audible dropout at the start of every sentence. An
// underrun while playing is a hard drain: the next burst prefills again before it starts. The
// last rendered sample is faded to zero over RAMP_SAMPLES on underrun and on clear, so a cut is
// not a click. `turn_started` still fires on the first rendered sample of the turn, so the
// client's `played` report stays honest.
//
// Messages in : { type: "audio", data: ArrayBuffer(Int16), turnId }
//               { type: "clear" }                       drop everything buffered, now
// Messages out: { type: "turn_started", turnId }        first sample of that turn rendered
//               { type: "playing" } / { type: "drained" }
//               { type: "overflow", dropped }
// ---------------------------------------------------------------------------
const PREFILL_SAMPLES = 640; // 40 ms at 16 kHz
const PREFILL_TIMEOUT_S = 0.08; // play a tiny tail chunk after 80 ms even if it never reaches the prefill
const RAMP_SAMPLES = 32; // 2 ms at 16 kHz, 0.7 ms at 48 kHz

class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.srcRate = TARGET_RATE;
    this.step = this.srcRate / sampleRate; // source samples advanced per output sample
    this.size = this.srcRate * 60; // 60 s of audio
    this.ring = new Float32Array(this.size);
    this.writeCount = 0;
    this.readPos = 0;
    this.markers = [];
    this.lastTurnId = undefined;
    this.playing = false;
    this.primedAt = -1; // currentTime of the first push while idle, -1 when nothing is waiting
    this.last = 0; // last rendered sample, the fade-out starts from here
    this.rampLeft = 0; // fade samples still to write, carried across quanta
    this.rampStep = 0;
    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === "audio" && m.data) this.push(new Int16Array(m.data), m.turnId);
      else if (m.type === "clear") this.clear();
    };
    this.port.postMessage({ type: "ready", outputRate: sampleRate, sourceRate: this.srcRate });
  }

  push(int16, turnId) {
    if (turnId !== this.lastTurnId) {
      this.markers.push({ turnId, pos: this.writeCount });
      this.lastTurnId = turnId;
    }
    const buffered = this.writeCount - Math.floor(this.readPos);
    const free = this.size - buffered;
    let n = int16.length;
    if (n > free) {
      this.port.postMessage({ type: "overflow", dropped: n - free });
      n = free;
    }
    if (!this.playing && this.primedAt < 0 && n > 0) this.primedAt = currentTime;
    const ring = this.ring;
    const size = this.size;
    let w = this.writeCount;
    for (let i = 0; i < n; i++) {
      ring[w % size] = int16[i] / 32768;
      w++;
    }
    this.writeCount = w;
  }

  clear() {
    this.readPos = this.writeCount;
    this.markers = [];
    this.lastTurnId = undefined;
    this.primedAt = -1;
    if (this.playing) {
      this.playing = false;
      this.port.postMessage({ type: "drained", reason: "cleared" });
    }
    // this.last is kept: the next quantum fades it out instead of cutting to zero.
  }

  // Fill out[from..] with a fade from the last rendered sample to zero, then silence. The fade is
  // exactly RAMP_SAMPLES long; when it does not fit in this quantum it continues in the next.
  silence(out, from) {
    let i = from;
    if (this.last !== 0) {
      if (this.rampLeft <= 0) {
        this.rampLeft = RAMP_SAMPLES;
        this.rampStep = this.last / RAMP_SAMPLES;
      }
      for (; this.rampLeft > 0 && i < out.length; this.rampLeft--, i++) {
        this.last -= this.rampStep;
        out[i] = this.rampLeft === 1 ? 0 : this.last;
      }
      if (this.rampLeft <= 0) this.last = 0;
    }
    for (; i < out.length; i++) out[i] = 0;
  }

  mirror(output, out) {
    for (let c = 1; c < output.length; c++) output[c].set(out);
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const out = output[0];
    const avail = this.writeCount - this.readPos;
    if (!this.playing) {
      const waited = this.primedAt >= 0 ? currentTime - this.primedAt : 0;
      const ready = avail >= PREFILL_SAMPLES || (avail >= 1 && waited >= PREFILL_TIMEOUT_S);
      if (!ready) {
        this.silence(out, 0);
        this.mirror(output, out);
        return true;
      }
      this.playing = true;
      this.primedAt = -1;
      this.port.postMessage({ type: "playing" });
    } else if (avail < 1) {
      // Underrun while playing: hard drain. The next push re-arms the prefill.
      this.playing = false;
      this.primedAt = -1;
      this.silence(out, 0);
      this.mirror(output, out);
      this.port.postMessage({ type: "drained" });
      return true;
    }

    const ring = this.ring;
    const size = this.size;
    const step = this.step;
    const end = this.writeCount;
    let pos = this.readPos;
    let i = 0;
    for (; i < out.length; i++) {
      if (pos >= end) break;
      const i0 = Math.floor(pos);
      const a = ring[i0 % size];
      if (i0 + 1 >= end) {
        out[i] = a;
      } else {
        const b = ring[(i0 + 1) % size];
        out[i] = a + (b - a) * (pos - i0);
      }
      pos += step;
    }
    if (i > 0) {
      this.last = out[i - 1];
      this.rampLeft = 0;
    }
    if (i < out.length) this.silence(out, i); // ran dry mid-quantum: fade the tail
    if (pos > end) pos = end;

    while (this.markers.length && this.markers[0].pos < pos) {
      const mk = this.markers.shift();
      this.port.postMessage({ type: "turn_started", turnId: mk.turnId });
    }
    this.readPos = pos;
    this.mirror(output, out);
    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
registerProcessor("playback-processor", PlaybackProcessor);
