'use strict';

/**
 * dixoncoles.js
 *
 * Dixon-Coles adjustment for the Poisson goal model. Plain Poisson assumes the
 * two teams' goal counts are independent, which under-counts low-scoring draws
 * (0-0, 1-1) and over-counts 0-1/1-0 results. The Dixon-Coles correction adds a
 * dependence term τ(i,j) that fixes this, making it the standard upgrade for
 * football score prediction.
 *
 * Zero third-party dependencies.
 */

// Literature value for football: low-scoring draws are more common than
// independent Poisson predicts, while 0-1/1-0 results are slightly less common.
// Typical fitted values range from 0.05 to 0.15.
const DEFAULT_RHO = 0.075;

const { loadResults, parseMatches } = require('./elo');
const { rng } = require('./rng');

/** Poisson probability mass for exactly k events. */
function poissonPmf(lambda, k) {
  let logp = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logp -= Math.log(i);
  return Math.exp(logp);
}

/**
 * Dixon-Coles dependence factor τ(i,j) for goals i (home/A) and j (away/B).
 * Negative ρ means the two teams' goal counts are negatively correlated.
 */
function dixonColesFactor(lambdaA, lambdaB, rho, i, j) {
  if (i === 0 && j === 0) return 1 - lambdaA * lambdaB * rho;
  if (i === 1 && j === 1) return 1 - rho;
  if (i === 0 && j === 1) return 1 + lambdaA * rho;
  if (i === 1 && j === 0) return 1 + lambdaB * rho;
  return 1;
}

/**
 * Build a normalized joint probability matrix P(i,j) for i,j in [0, maxGoals]
 * using the Dixon-Coles adjustment. Returns a flat array of probabilities and
 * the dimensions.
 */
function jointProbabilityMatrix(lambdaA, lambdaB, rho, maxGoals) {
  const probs = [];
  let total = 0;
  for (let i = 0; i <= maxGoals; i++) {
    for (let j = 0; j <= maxGoals; j++) {
      const p =
        dixonColesFactor(lambdaA, lambdaB, rho, i, j) *
        poissonPmf(lambdaA, i) *
        poissonPmf(lambdaB, j);
      probs.push(p);
      total += p;
    }
  }
  // Renormalize after truncation (the infinite sum is not exactly 1 once capped).
  for (let k = 0; k < probs.length; k++) probs[k] /= total;
  return probs;
}

/**
 * Sample a scoreline (ga, gb) from the Dixon-Coles joint distribution.
 */
function sampleDixonColes(lambdaA, lambdaB, rho = DEFAULT_RHO, maxGoals = 10) {
  const probs = jointProbabilityMatrix(lambdaA, lambdaB, rho, maxGoals);
  const r = rng();
  let cum = 0;
  const n = maxGoals + 1;
  for (let k = 0; k < probs.length; k++) {
    cum += probs[k];
    if (r <= cum) {
      return { ga: Math.floor(k / n), gb: k % n };
    }
  }
  return { ga: maxGoals, gb: maxGoals };
}

/**
 * Estimate ρ from a list of historical matches by grid search maximizing log-
 * likelihood. Each match should have {homeScore, awayScore, homeElo, awayElo}
 * or use pre-computed λ values.
 */
function estimateRho(matches, maxGoals = 5) {
  const candidates = [];
  for (let rho = -0.15; rho <= 0.05; rho += 0.005) {
    candidates.push(rho);
  }

  let bestRho = DEFAULT_RHO;
  let bestLL = -Infinity;

  for (const rho of candidates) {
    let ll = 0;
    for (const m of matches) {
      const p =
        dixonColesFactor(m.lambdaA, m.lambdaB, rho, m.homeScore, m.awayScore) *
        poissonPmf(m.lambdaA, m.homeScore) *
        poissonPmf(m.lambdaB, m.awayScore);
      ll += Math.log(p + 1e-12);
    }
    if (ll > bestLL) {
      bestLL = ll;
      bestRho = rho;
    }
  }
  return bestRho;
}

/**
 * Estimate ρ from the cached historical dataset using the supplied Elo model.
 * `expectedGoalsFn` should be the same function used in the simulator (to keep
 * λ values consistent). Returns the best ρ found via grid search.
 */
async function estimateRhoFromDataset(eloModel, expectedGoalsFn, { cutoff = '2004-01-01', maxGoals = 5, log = () => {} } = {}) {
  log('Estimating Dixon-Coles ρ from historical matches ...');
  const text = await loadResults({ log: () => {} });
  const matches = parseMatches(text).filter((m) => m.date >= cutoff);
  const samples = [];
  for (const m of matches) {
    const rA = eloModel.ratings[m.home] || eloModel.BASE_RATING;
    const rB = eloModel.ratings[m.away] || eloModel.BASE_RATING;
    const [lambdaA, lambdaB] = expectedGoalsFn(rA, rB, !m.neutral, !m.neutral);
    samples.push({ lambdaA, lambdaB, homeScore: m.homeScore, awayScore: m.awayScore });
  }
  const rho = estimateRho(samples, maxGoals);
  log(`Estimated Dixon-Coles ρ = ${rho.toFixed(4)} from ${samples.length.toLocaleString()} matches.`);
  return rho;
}

module.exports = {
  DEFAULT_RHO,
  dixonColesFactor,
  jointProbabilityMatrix,
  sampleDixonColes,
  estimateRho,
  estimateRhoFromDataset,
};
