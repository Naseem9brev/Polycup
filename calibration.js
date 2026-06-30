'use strict';

/**
 * calibration.js
 *
 * Calibration metrics for probabilistic football predictions. Given a list of
 * predicted probabilities and actual outcomes, this reports how well the
 * model's confidence matches reality.
 *
 * Zero third-party dependencies.
 */

/**
 * Multi-class Brier score for H/D/A predictions.
 * For each match, the Brier contribution is the sum of squared errors between
 * the predicted probability of each outcome and the observed outcome (1 or 0).
 * Lower is better; 0 is perfect, 2 is worst.
 */
function brierScore(predictions) {
  let total = 0;
  for (const { pHome, pDraw, pAway, actual } of predictions) {
    const yH = actual === 'H' ? 1 : 0;
    const yD = actual === 'D' ? 1 : 0;
    const yA = actual === 'A' ? 1 : 0;
    total += Math.pow(pHome - yH, 2) + Math.pow(pDraw - yD, 2) + Math.pow(pAway - yA, 2);
  }
  return total / predictions.length;
}

/**
 * Expected Calibration Error (ECE) using favorite-probability buckets.
 * Each prediction is placed in a bucket by its highest probability. ECE is the
 * weighted average of |bucket accuracy - bucket mean predicted probability|.
 * Lower is better; 0 is perfectly calibrated.
 */
function expectedCalibrationError(predictions, bucketCount = 10) {
  const buckets = [];
  for (let i = 0; i < bucketCount; i++) buckets.push({ predicted: [], correct: 0, n: 0 });

  for (const { pHome, pDraw, pAway, actual } of predictions) {
    const fav = Math.max(pHome, pDraw, pAway);
    const idx = Math.min(bucketCount - 1, Math.floor(fav * bucketCount));
    buckets[idx].predicted.push(fav);
    buckets[idx].n++;
    const predictedOutcome = pHome > pDraw && pHome > pAway ? 'H' : pDraw > pAway ? 'D' : 'A';
    if (predictedOutcome === actual) buckets[idx].correct++;
  }

  let ece = 0;
  for (const b of buckets) {
    if (b.n === 0) continue;
    const meanPredicted = b.predicted.reduce((a, v) => a + v, 0) / b.n;
    const accuracy = b.correct / b.n;
    ece += Math.abs(accuracy - meanPredicted) * (b.n / predictions.length);
  }
  return ece;
}

/**
 * Build a calibration report: Brier score, ECE, and per-bucket accuracy.
 */
function report(predictions) {
  const brier = brierScore(predictions);
  const ece = expectedCalibrationError(predictions);

  const bucketCount = 10;
  const buckets = [];
  for (let i = 0; i < bucketCount; i++) buckets.push({ lo: i / bucketCount, hi: (i + 1) / bucketCount, predicted: [], correct: 0, n: 0 });
  for (const { pHome, pDraw, pAway, actual } of predictions) {
    const fav = Math.max(pHome, pDraw, pAway);
    const idx = Math.min(bucketCount - 1, Math.floor(fav * bucketCount));
    buckets[idx].predicted.push(fav);
    buckets[idx].n++;
    const predictedOutcome = pHome > pDraw && pHome > pAway ? 'H' : pDraw > pAway ? 'D' : 'A';
    if (predictedOutcome === actual) buckets[idx].correct++;
  }

  return { brier, ece, buckets };
}

module.exports = { brierScore, expectedCalibrationError, report };
