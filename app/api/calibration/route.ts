import { NextResponse } from "next/server";
import { getCalibrationData } from "@/lib/calibration";

/**
 * GET /api/calibration
 *
 * Returns confidence calibration data — predicted confidence buckets
 * (0.05 increments) with actual accuracy from review verdicts.
 * Used to tune detection thresholds for deployment.
 */
export async function GET() {
  try {
    const buckets = await getCalibrationData();

    // Summarise only non-empty buckets for quick overview
    const nonEmpty = buckets.filter((b) => b.predictions > 0);
    const totalPredictions = nonEmpty.reduce((s, b) => s + b.predictions, 0);
    const totalCorrect = nonEmpty.reduce((s, b) => s + b.correct, 0);
    const totalReviewed = nonEmpty.reduce(
      (s, b) => s + (b.accuracy !== null ? b.predictions : 0),
      0,
    );

    return NextResponse.json({
      buckets,
      summary: {
        totalPredictions,
        totalCorrect,
        totalReviewed,
        overallAccuracy:
          totalReviewed > 0
            ? Math.round((totalCorrect / totalReviewed) * 1000) / 1000
            : null,
      },
    });
  } catch (err) {
    console.error("[calibration] Error:", err);
    return NextResponse.json(
      { error: "Failed to load calibration data" },
      { status: 500 },
    );
  }
}
