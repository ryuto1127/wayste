/**
 * Master sensitivity → threshold derivation.
 *
 * All CV and inference thresholds are derived from a single sensitivity
 * parameter (0.0 = strict, 1.0 = sensitive, default 0.5).
 * Auto-calibration data from FrameAnalyzer can override the ROI foreground
 * threshold for environment-specific tuning.
 */

/** Auto-calibration data collected during background settling. */
export interface Calibration {
  /** Mean foreground ratio during calibration (noise floor). */
  noiseFgMean: number;
  /** Standard deviation of foreground ratio during calibration. */
  noiseFgStd: number;
  /** Mean largest blob ratio during calibration (noise blob baseline). */
  noiseBlobMean: number;
}

/** All derived thresholds consumed by the CV pipeline and inference tiers. */
export interface ThresholdConfig {
  ROI_FG_THRESHOLD: number;
  ROI_BLOB_THRESHOLD: number;
  RESULT_FG_THRESHOLD: number;
  RESULT_BLOB_THRESHOLD: number;
  ROI_BLOB_DIAGONAL_THRESHOLD: number;
  YOLO_FALLBACK_THRESHOLD: number;
  FG_PERSIST_FRAMES: number;
  OBJECT_GONE_FRAMES: number;
  /** Continuous mode: smoothed confidence to SEED a new track (hysteresis high). */
  TRACK_APPEAR_THRESHOLD: number;
  /** Continuous mode: confidence floor to KEEP matching an existing track (hysteresis low). */
  TRACK_KEEP_THRESHOLD: number;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Derive all pipeline thresholds from a single sensitivity value.
 *
 * @param sensitivity 0.0 (strict) → 1.0 (sensitive), default 0.5
 * @param calibration Auto-calibration data from FrameAnalyzer (optional)
 */
export function computeThresholds(
  sensitivity: number = 0.5,
  calibration?: Calibration,
): ThresholdConfig {
  const s = clamp(sensitivity, 0, 1);

  // ROI foreground threshold — calibration overrides when available.
  //
  // The calibration upper bound (0.08) is intentionally higher than the
  // uncalibrated range's max (0.05). Rationale: in noisy environments
  // (HVAC vibration, foot-traffic shadows, low-light sensor noise) the
  // rolling calibration can legitimately observe a noise floor above 0.05.
  // Letting the clamp rise above the uncalibrated range lets auto-calibration
  // suppress those environments' false positives at the cost of some
  // sensitivity — a deliberate tradeoff favoring precision over recall for
  // sites where manual tuning isn't feasible. If a site's calibrated
  // threshold pegs near 0.08 in practice, treat that as a signal to revisit
  // camera placement or lighting before changing the clamp.
  let ROI_FG_THRESHOLD: number;
  if (calibration) {
    ROI_FG_THRESHOLD = clamp(
      calibration.noiseFgMean + 3 * calibration.noiseFgStd,
      0.02,
      0.08,
    );
  } else {
    ROI_FG_THRESHOLD = lerp(0.05, 0.02, s);
  }

  const ROI_BLOB_THRESHOLD = ROI_FG_THRESHOLD * 0.33;
  const RESULT_FG_THRESHOLD = ROI_FG_THRESHOLD * 0.73;
  const RESULT_BLOB_THRESHOLD = ROI_BLOB_THRESHOLD * 0.8;
  const ROI_BLOB_DIAGONAL_THRESHOLD = lerp(0.45, 0.30, s);
  const YOLO_FALLBACK_THRESHOLD = lerp(0.80, 0.65, s);
  const FG_PERSIST_FRAMES = s > 0.7 ? 2 : 3;
  const OBJECT_GONE_FRAMES = s > 0.7 ? 2 : 3;
  // Continuous-mode hysteresis: entry is strict, hold is lenient. The keep
  // floor is also passed to YOLO as its confidence cutoff, so low-confidence
  // frames still feed existing tracks instead of reading as "item vanished".
  const TRACK_APPEAR_THRESHOLD = lerp(0.60, 0.45, s);
  const TRACK_KEEP_THRESHOLD = TRACK_APPEAR_THRESHOLD * 0.65;

  return {
    ROI_FG_THRESHOLD,
    ROI_BLOB_THRESHOLD,
    RESULT_FG_THRESHOLD,
    RESULT_BLOB_THRESHOLD,
    ROI_BLOB_DIAGONAL_THRESHOLD,
    YOLO_FALLBACK_THRESHOLD,
    FG_PERSIST_FRAMES,
    OBJECT_GONE_FRAMES,
    TRACK_APPEAR_THRESHOLD,
    TRACK_KEEP_THRESHOLD,
  };
}
