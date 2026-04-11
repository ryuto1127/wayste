/**
 * Global performance monitor singleton.
 *
 * KioskDisplay writes metrics here; the /review page reads them for visualization.
 * Stores 600 seconds of 1-sample-per-second data in a circular buffer.
 */

// ── Types ──

export interface PerfSample {
  /** Unix timestamp (seconds) */
  ts: number;
  /** Average CV analysis time (ms) for frames in this second */
  cvMs: number;
  /** Number of analyze() calls in this second */
  frameCount: number;
  /** YOLO Tier 1 inference time (ms), or null if not fired */
  yoloMs: number | null;
  /** YOLO World Tier 2 inference time (ms), or null if not fired */
  worldMs: number | null;
  /** Whether thermal throttling was active */
  throttling: boolean;
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

type PerfListener = () => void;

// ── Constants ──

const BUFFER_SIZE = 600; // 10 minutes at 1 sample/sec

// ── Singleton ──

class PerfMonitor {
  // Circular buffer
  private _buffer: PerfSample[] = [];
  private _writeIndex = 0;
  private _size = 0;

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

  // Thermal event log (keep last 100 transitions)
  private _thermalLog: ThermalEvent[] = [];

  // Subscribers
  private _listeners: Set<PerfListener> = new Set();

  constructor() {
    // Pre-allocate buffer
    this._buffer = new Array<PerfSample>(BUFFER_SIZE);
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

  /** Current ratio of avg analysis time to baseline (1.0 = at baseline, 2.0 = throttle trigger). */
  private _thermalRatio = 0;

  recordThermalState(throttling: boolean, ratio?: number): void {
    if (ratio !== undefined) this._thermalRatio = ratio;
    if (throttling !== this._lastThrottling) {
      this._thermalLog.push({ ts: Date.now() / 1000, throttling });
      if (this._thermalLog.length > 100) this._thermalLog.shift();
      this._lastThrottling = throttling;
    }
  }

  /** Returns avg/baseline ratio. 0 = no data, 1.0 = baseline, >=2.0 = throttling. */
  getThermalRatio(): number {
    return this._thermalRatio;
  }

  // ── Read API (called from /review PerformancePanel) ──

  /** Returns ordered samples from oldest to newest. */
  getSamples(): PerfSample[] {
    this._flushCurrentSecond();
    if (this._size === 0) return [];
    const result: PerfSample[] = [];
    const start = this._size < BUFFER_SIZE ? 0 : this._writeIndex;
    for (let i = 0; i < this._size; i++) {
      const idx = (start + i) % BUFFER_SIZE;
      if (this._buffer[idx]) result.push(this._buffer[idx]);
    }
    return result;
  }

  getLifetimeStats(): {
    cv: PerfStats;
    fps: PerfStats;
    yolo: PerfStats;
    world: PerfStats;
  } {
    return {
      cv: this._toStats(this._lifetimeCv),
      fps: this._toStats(this._lifetimeFps),
      yolo: this._toStats(this._lifetimeYolo),
      world: this._toStats(this._lifetimeWorld),
    };
  }

  getThermalLog(): ThermalEvent[] {
    return [...this._thermalLog];
  }

  isThrottling(): boolean {
    return this._lastThrottling;
  }

  subscribe(fn: PerfListener): () => void {
    this._listeners.add(fn);
    return () => { this._listeners.delete(fn); };
  }

  // ── Internal ──

  private _nowSecond(): number {
    return Math.floor(Date.now() / 1000);
  }

  private _ensureSecond(): void {
    const sec = this._nowSecond();
    if (this._currentSecond === 0) {
      this._currentSecond = sec;
      return;
    }
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
    };

    // Write to circular buffer
    this._buffer[this._writeIndex] = sample;
    this._writeIndex = (this._writeIndex + 1) % BUFFER_SIZE;
    if (this._size < BUFFER_SIZE) this._size++;

    // Update lifetime stats
    this._accumulate(this._lifetimeCv, cvAvg);
    this._accumulate(this._lifetimeFps, frameCount);
    if (yoloMs !== null) this._accumulate(this._lifetimeYolo, yoloMs);
    if (worldMs !== null) this._accumulate(this._lifetimeWorld, worldMs);

    // Reset accumulators
    this._cvDurations = [];
    this._yoloEvents = [];
    this._worldEvents = [];

    // Notify subscribers
    for (const fn of this._listeners) {
      try { fn(); } catch { /* ignore */ }
    }
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

// Export singleton
export const perfMonitor = new PerfMonitor();
