/**
 * Global performance monitor singleton.
 *
 * KioskDisplay writes metrics here; the /review page reads them for visualization.
 * Uses BroadcastChannel to sync data across tabs (kiosk tab → review tab).
 *
 * Three resolution tiers:
 *   - "10m": 600 samples, 1/sec  (10 minutes)
 *   - "1h":  360 samples, 10/sec (1 hour)
 *   - "24h": 1440 samples, 1/min (24 hours)
 */

// ── Types ──

export interface PerfSample {
  /** Unix timestamp (seconds) */
  ts: number;
  /** Average CV analysis time (ms) */
  cvMs: number;
  /** Number of analyze() calls (per-second for 10m, averaged for coarser) */
  frameCount: number;
  /** YOLO Tier 1 inference time (ms), or null if not fired */
  yoloMs: number | null;
  /** Legacy second-stage local inference time (ms). Always null in the
   *  current 2-tier pipeline; kept so historical samples still parse. */
  worldMs: number | null;
  /** Whether thermal throttling was active */
  throttling: boolean;
  /** Avg/baseline ratio at this moment (0 = no baseline yet) */
  thermalRatio: number;
}

export interface PerfStats {
  min: number;
  avg: number;
  max: number;
  count: number;
}

export interface ThermalEvent {
  ts: number;
  throttling: boolean;
}

export type TimeScale = "10m" | "1h" | "24h";

type PerfListener = () => void;

// ── Constants ──

const CHANNEL_NAME = "perf-monitor";

interface TierConfig {
  size: number;
  /** How many 1-sec samples to aggregate into one entry */
  bucketSec: number;
}

const TIERS: Record<TimeScale, TierConfig> = {
  "10m": { size: 600, bucketSec: 1 },
  "1h":  { size: 360, bucketSec: 10 },
  "24h": { size: 1440, bucketSec: 60 },
};

// ── BroadcastChannel message types ──

type PerfMessage =
  | { type: "sample"; sample: PerfSample; thermalRatio: number }
  | { type: "thermal"; throttling: boolean; ratio: number; event?: ThermalEvent };

// ── Circular buffer helper ──

class CircularBuffer {
  private _buf: PerfSample[];
  private _wi = 0;
  private _size = 0;
  private _cap: number;

  constructor(capacity: number) {
    this._cap = capacity;
    this._buf = new Array<PerfSample>(capacity);
  }

  push(sample: PerfSample): void {
    this._buf[this._wi] = sample;
    this._wi = (this._wi + 1) % this._cap;
    if (this._size < this._cap) this._size++;
  }

  toArray(): PerfSample[] {
    if (this._size === 0) return [];
    const result: PerfSample[] = [];
    const start = this._size < this._cap ? 0 : this._wi;
    for (let i = 0; i < this._size; i++) {
      const idx = (start + i) % this._cap;
      if (this._buf[idx]) result.push(this._buf[idx]);
    }
    return result;
  }
}

// ── Downsampling accumulator ──

class DownsampleAcc {
  private _bucketSec: number;
  private _currentBucket = 0;
  private _samples: PerfSample[] = [];
  private _target: CircularBuffer;

  constructor(bucketSec: number, target: CircularBuffer) {
    this._bucketSec = bucketSec;
    this._target = target;
  }

  add(sample: PerfSample): void {
    const bucket = Math.floor(sample.ts / this._bucketSec);
    if (this._currentBucket === 0) {
      this._currentBucket = bucket;
    }
    if (bucket !== this._currentBucket) {
      this._flush();
      this._currentBucket = bucket;
    }
    this._samples.push(sample);
  }

  private _flush(): void {
    if (this._samples.length === 0) return;
    const n = this._samples.length;
    let cvSum = 0, fpsSum = 0, yoloSum = 0, yoloN = 0, worldSum = 0, worldN = 0;
    let ratioSum = 0, throttleCount = 0;

    for (const s of this._samples) {
      cvSum += s.cvMs;
      fpsSum += s.frameCount;
      if (s.yoloMs !== null) { yoloSum += s.yoloMs; yoloN++; }
      if (s.worldMs !== null) { worldSum += s.worldMs; worldN++; }
      ratioSum += s.thermalRatio;
      if (s.throttling) throttleCount++;
    }

    this._target.push({
      ts: this._samples[0].ts,
      cvMs: cvSum / n,
      frameCount: Math.round(fpsSum / n),
      yoloMs: yoloN > 0 ? yoloSum / yoloN : null,
      worldMs: worldN > 0 ? worldSum / worldN : null,
      throttling: throttleCount > n / 2,
      thermalRatio: ratioSum / n,
    });
    this._samples = [];
  }
}

// ── Singleton ──

class PerfMonitor {
  // Tiered buffers
  private _buf10m = new CircularBuffer(TIERS["10m"].size);
  private _buf1h = new CircularBuffer(TIERS["1h"].size);
  private _buf24h = new CircularBuffer(TIERS["24h"].size);

  // Downsamplers feed coarser buffers
  private _ds1h = new DownsampleAcc(TIERS["1h"].bucketSec, this._buf1h);
  private _ds24h = new DownsampleAcc(TIERS["24h"].bucketSec, this._buf24h);

  // Accumulator for current second
  private _currentSecond = 0;
  private _cvDurations: number[] = [];
  private _yoloEvents: number[] = [];
  private _worldEvents: number[] = [];
  private _lastThrottling = false;

  // Lifetime stats accumulators
  private _lifetimeCv = { sum: 0, min: Infinity, max: -Infinity, count: 0 };
  private _lifetimeFps = { sum: 0, min: Infinity, max: -Infinity, count: 0 };
  private _lifetimeYolo = { sum: 0, min: Infinity, max: -Infinity, count: 0 };
  private _lifetimeWorld = { sum: 0, min: Infinity, max: -Infinity, count: 0 };

  /** Current ratio of avg analysis time to baseline. */
  private _thermalRatio = 0;
  private _lastRatioBroadcast = 0;

  // Thermal event log (keep last 100 transitions)
  private _thermalLog: ThermalEvent[] = [];

  // Subscribers
  private _listeners: Set<PerfListener> = new Set();

  // Cross-tab channel
  private _channel: BroadcastChannel | null = null;

  constructor() {
    if (typeof BroadcastChannel !== "undefined") {
      this._channel = new BroadcastChannel(CHANNEL_NAME);
      this._channel.onmessage = (ev: MessageEvent<PerfMessage>) => {
        const msg = ev.data;
        if (msg.type === "sample") {
          this._commitSample(msg.sample);
          this._thermalRatio = msg.thermalRatio;
          this._notify();
        } else if (msg.type === "thermal") {
          this._thermalRatio = msg.ratio;
          this._lastThrottling = msg.throttling;
          if (msg.event) {
            this._thermalLog.push(msg.event);
            if (this._thermalLog.length > 100) this._thermalLog.shift();
          }
          this._notify();
        }
      };
    }
  }

  // ── Write API (called from KioskDisplay) ──

  recordCvFrame(durationMs: number): void {
    this._ensureSecond();
    this._cvDurations.push(durationMs);
  }

  recordYoloInference(durationMs: number): void {
    this._ensureSecond();
    this._yoloEvents.push(durationMs);
  }

  recordWorldInference(durationMs: number): void {
    this._ensureSecond();
    this._worldEvents.push(durationMs);
  }

  recordThermalState(throttling: boolean, ratio?: number): void {
    if (ratio !== undefined) this._thermalRatio = ratio;
    if (throttling !== this._lastThrottling) {
      const event: ThermalEvent = { ts: Date.now() / 1000, throttling };
      this._thermalLog.push(event);
      if (this._thermalLog.length > 100) this._thermalLog.shift();
      this._lastThrottling = throttling;
      this._channel?.postMessage({
        type: "thermal", throttling, ratio: this._thermalRatio, event,
      } satisfies PerfMessage);
    } else if (ratio !== undefined) {
      const now = Date.now();
      if (now - this._lastRatioBroadcast > 1000) {
        this._lastRatioBroadcast = now;
        this._channel?.postMessage({
          type: "thermal", throttling, ratio: this._thermalRatio,
        } satisfies PerfMessage);
      }
    }
  }

  // ── Read API (called from /review PerformancePanel) ──

  getThermalRatio(): number { return this._thermalRatio; }

  getSamples(scale: TimeScale = "10m"): PerfSample[] {
    this._flushCurrentSecond();
    switch (scale) {
      case "10m": return this._buf10m.toArray();
      case "1h":  return this._buf1h.toArray();
      case "24h": return this._buf24h.toArray();
    }
  }

  getLifetimeStats() {
    return {
      cv: this._toStats(this._lifetimeCv),
      fps: this._toStats(this._lifetimeFps),
      yolo: this._toStats(this._lifetimeYolo),
      world: this._toStats(this._lifetimeWorld),
    };
  }

  getThermalLog(): ThermalEvent[] { return [...this._thermalLog]; }
  isThrottling(): boolean { return this._lastThrottling; }

  subscribe(fn: PerfListener): () => void {
    this._listeners.add(fn);
    return () => { this._listeners.delete(fn); };
  }

  // ── Internal ──

  /** Write a sample to all tier buffers + lifetime stats. */
  private _commitSample(sample: PerfSample): void {
    this._buf10m.push(sample);
    this._ds1h.add(sample);
    this._ds24h.add(sample);

    this._accumulate(this._lifetimeCv, sample.cvMs);
    this._accumulate(this._lifetimeFps, sample.frameCount);
    if (sample.yoloMs !== null) this._accumulate(this._lifetimeYolo, sample.yoloMs);
    if (sample.worldMs !== null) this._accumulate(this._lifetimeWorld, sample.worldMs);
    this._lastThrottling = sample.throttling;
  }

  private _notify(): void {
    for (const fn of this._listeners) {
      try { fn(); } catch { /* ignore */ }
    }
  }

  private _nowSecond(): number {
    return Math.floor(Date.now() / 1000);
  }

  private _ensureSecond(): void {
    const sec = this._nowSecond();
    if (this._currentSecond === 0) { this._currentSecond = sec; return; }
    if (sec !== this._currentSecond) {
      this._flushCurrentSecond();
      this._currentSecond = sec;
    }
  }

  private _flushCurrentSecond(): void {
    if (this._currentSecond === 0 || this._cvDurations.length === 0) return;

    const frameCount = this._cvDurations.length;
    const cvAvg = this._cvDurations.reduce((a, b) => a + b, 0) / frameCount;
    const yoloMs = this._yoloEvents.length > 0
      ? this._yoloEvents.reduce((a, b) => a + b, 0) / this._yoloEvents.length
      : null;
    const worldMs = this._worldEvents.length > 0
      ? this._worldEvents.reduce((a, b) => a + b, 0) / this._worldEvents.length
      : null;

    const sample: PerfSample = {
      ts: this._currentSecond,
      cvMs: cvAvg,
      frameCount,
      yoloMs,
      worldMs,
      throttling: this._lastThrottling,
      thermalRatio: this._thermalRatio,
    };

    this._commitSample(sample);

    // Broadcast to other tabs
    this._channel?.postMessage({
      type: "sample", sample, thermalRatio: this._thermalRatio,
    } satisfies PerfMessage);

    this._cvDurations = [];
    this._yoloEvents = [];
    this._worldEvents = [];

    this._notify();
  }

  private _accumulate(
    acc: { sum: number; min: number; max: number; count: number },
    value: number,
  ): void {
    acc.sum += value;
    acc.count++;
    if (value < acc.min) acc.min = value;
    if (value > acc.max) acc.max = value;
  }

  private _toStats(acc: { sum: number; min: number; max: number; count: number }): PerfStats {
    if (acc.count === 0) return { min: 0, avg: 0, max: 0, count: 0 };
    return {
      min: Math.round(acc.min * 100) / 100,
      avg: Math.round((acc.sum / acc.count) * 100) / 100,
      max: Math.round(acc.max * 100) / 100,
      count: acc.count,
    };
  }
}

export const perfMonitor = new PerfMonitor();
