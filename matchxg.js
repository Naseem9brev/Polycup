'use strict';

/**
 * matchxg.js
 *
 * EXPERIMENTAL — Phase 12: Match-level xG model.
 *
 * Derives per-team offensive and defensive strength ratings directly from the
 * historical goals-scored / goals-conceded record in the martj42 dataset (the
 * same free source used by elo.js). These ratings are then combined into
 * expected-goals (xG) lambdas for a hypothetical match.
 *
 * Approach
 * --------
 * Because free xG data (FBref/Statbomb-style shot-level records) is not
 * available without authentication, we derive *pseudo-xG* from the existing
 * results CSV using a strength-of-schedule-adjusted goal model:
 *
 *   1. For every played match in a configurable recent window, record the
 *      (goals_scored, goals_conceded) pair for each team, weighted by:
 *        - Recency: exponential decay (half-life ≈ 2 years).
 *        - Importance: same K-factor tiers as elo.js.
 *
 *   2. Compute raw attack / defense rates:
 *        rawAttack[team]  = weighted_avg_goals_scored
 *        rawDefense[team] = weighted_avg_goals_conceded
 *
 *   3. Run a single global scaling pass (Dixon-Coles style) so that the
 *      expected total goals in an average match ≈ TOTAL_BASE_XG (2.5).
 *
 *   4. Expected goals for team A against team B:
 *        lambdaA = TOTAL_BASE_XG × (attackRateA / popAvgAttack)
 *                                × (popAvgDefense / defenseRateB)
 *      — i.e. a weaker-defending opponent raises A's expected goals, a
 *        stronger-defending opponent lowers them.
 *
 *   5. Blend the xG-model lambdas with the Elo-based lambdas using a
 *      configurable XG_BLEND weight (default 0.40).
 *
 * Design constraints
 * ------------------
 *   - Zero third-party runtime dependencies.
 *   - Reuses the already-cached results.csv via elo.js helpers.
 *   - Degrades gracefully: missing teams fall back to population-average rates.
 *   - The default Elo/Dixon-Coles path is completely unaffected.
 *   - Labeled EXPERIMENTAL everywhere it appears in the CLI.
 */

const { loadResults, parseMatches, importanceK, BASE_RATING } = require('./elo');
const { datasetName } = require('./worldcup2026');

// Mirror the constant from simulation.js to avoid a circular require.
const TOTAL_EXPECTED_GOALS = 2.5;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Only use matches from this date onward for xG rates.
// 5 years of data gives enough signal without too much squad turnover noise.
const RECENT_CUTOFF = '2020-01-01';

// Recency half-life: a match played HALF_LIFE_DAYS ago counts half as much.
// ~2 years ≈ 730 days.
const HALF_LIFE_DAYS = 730;

// Minimum weighted matches before we trust a team's rates.
// Teams with fewer data points fall back to population averages.
const MIN_WEIGHTED_MATCHES = 3;

// How much the xG model shifts the Elo baseline.
//   0 = pure Elo,  1 = fully xG-driven.
//   0.40 = modest 40 % influence (xG layer is supplementary).
const XG_BLEND = 0.40;

// Clamp individual team multipliers to this range (prevents extreme outliers).
const MIN_RATE_MULTIPLIER = 0.55;
const MAX_RATE_MULTIPLIER = 1.80;

// Total expected goals across both teams in an average-vs-average match.
// Mirrors simulation.js TOTAL_EXPECTED_GOALS so comparisons are fair.
const TOTAL_BASE_XG = TOTAL_EXPECTED_GOALS; // 2.5

// Host advantage in xG model: fraction boost to the host's attack rate.
const HOST_ATTACK_BOOST = 0.08; // +8 % attacking output at home

// Importance weight tiers mapped to K-factor bucket names.
// We scale match importance so World Cup matches count more.
const IMPORTANCE_SCALE = {
  60: 1.5, // K_WORLD_CUP
  50: 1.3, // K_CONTINENTAL
  45: 1.2, // K_NATIONS_LEAGUE
  40: 1.1, // K_QUALIFIER
  30: 1.0, // K_OTHER
  20: 0.8, // K_FRIENDLY
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TODAY_ISO = new Date().toISOString().slice(0, 10);

/** Days between two ISO date strings (YYYY-MM-DD). */
function daysBetween(a, b) {
  return Math.abs(Date.parse(b) - Date.parse(a)) / 86400000;
}

/** Exponential recency weight so recent matches count more. */
function recencyWeight(date) {
  const age = daysBetween(date, TODAY_ISO);
  return Math.pow(2, -age / HALF_LIFE_DAYS);
}

/** Match importance weight (higher = more influential on ratings). */
function importanceWeight(tournament) {
  const k = importanceK(tournament);
  return IMPORTANCE_SCALE[k] !== undefined ? IMPORTANCE_SCALE[k] : 1.0;
}

/**
 * Clamp a value to [min, max].
 */
function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

// ---------------------------------------------------------------------------
// Build team-level goal rates from historical matches
// ---------------------------------------------------------------------------

/**
 * Compute recency- and importance-weighted attack and defense rates for every
 * team. Returns a map of { [teamDatasetName]: { attack, defense, wMatches } }.
 *
 *   attack  = weighted_avg_goals_scored  per match
 *   defense = weighted_avg_goals_conceded per match
 *   wMatches = total weight (roughly: effective number of matches)
 */
function buildTeamRates(matches) {
  // Accumulators: { sumGoalsFor, sumGoalsAgainst, sumWeight }
  const acc = Object.create(null);

  function getAcc(team) {
    if (!acc[team]) acc[team] = { sumFor: 0, sumAgainst: 0, sumW: 0 };
    return acc[team];
  }

  for (const m of matches) {
    if (m.date < RECENT_CUTOFF) continue;
    if (!m.played) continue;

    const rW = recencyWeight(m.date);
    const iW = importanceWeight(m.tournament);
    const w = rW * iW;

    const ha = getAcc(m.home);
    ha.sumFor     += m.homeScore * w;
    ha.sumAgainst += m.awayScore * w;
    ha.sumW       += w;

    const aa = getAcc(m.away);
    aa.sumFor     += m.awayScore * w;
    aa.sumAgainst += m.homeScore * w;
    aa.sumW       += w;
  }

  const rates = Object.create(null);
  for (const [team, a] of Object.entries(acc)) {
    if (a.sumW < MIN_WEIGHTED_MATCHES) continue;
    rates[team] = {
      attack:   a.sumFor     / a.sumW,
      defense:  a.sumAgainst / a.sumW,
      wMatches: a.sumW,
    };
  }

  return rates;
}

/**
 * Compute the population average attack and defense rates across all teams
 * that have sufficient data. Used to normalize individual team multipliers.
 */
function computePopulationAverages(rates) {
  const teams = Object.values(rates);
  if (teams.length === 0) return { avgAttack: 1.0, avgDefense: 1.0 };

  // Weight each team's contribution by how many (weighted) matches they have.
  let sumA = 0, sumD = 0, sumW = 0;
  for (const r of teams) {
    sumA += r.attack  * r.wMatches;
    sumD += r.defense * r.wMatches;
    sumW += r.wMatches;
  }
  return {
    avgAttack:  sumA / sumW,
    avgDefense: sumD / sumW,
  };
}

// ---------------------------------------------------------------------------
// Core model object
// ---------------------------------------------------------------------------

/**
 * Build the match-level xG model from the historical dataset.
 *
 * @param {object} [options]
 * @param {Function} [options.log]            - Logger callback (no-op by default).
 * @param {boolean}  [options.forceDownload]  - Re-download results.csv.
 * @returns {object} matchXgModel
 */
async function buildMatchXgModel(options = {}) {
  const { log = () => {} } = options;

  log('Building match-level xG model from historical data ...');

  const text = await loadResults(options);
  const matches = parseMatches(text);

  const rates = buildTeamRates(matches);
  const teamCount = Object.keys(rates).length;
  log(`Computed xG rates for ${teamCount} teams from recent matches.`);

  const { avgAttack, avgDefense } = computePopulationAverages(rates);
  log(`Population averages — attack: ${avgAttack.toFixed(3)} goals/match, ` +
      `defense: ${avgDefense.toFixed(3)} goals/match.`);

  /**
   * Retrieve the (normalized) attack and defense multipliers for a team.
   * Returns { attack, defense } where 1.0 = population average.
   * Falls back to 1.0 if the team has insufficient data.
   *
   * @param {string} displayName  - Canonical display name (e.g. "France").
   * @param {boolean} [isHost]    - Whether to apply the home-ground attack boost.
   * @returns {{ attack: number, defense: number, hasData: boolean }}
   */
  function getTeamMultiplier(displayName, isHost = false) {
    const dsName = datasetName(displayName);
    const r = rates[dsName];

    if (!r) {
      return { attack: 1.0, defense: 1.0, hasData: false };
    }

    const rawAttackMul  = r.attack  / avgAttack;
    const rawDefenseMul = r.defense / avgDefense;

    let attackMul  = clamp(rawAttackMul,  MIN_RATE_MULTIPLIER, MAX_RATE_MULTIPLIER);
    let defenseMul = clamp(rawDefenseMul, MIN_RATE_MULTIPLIER, MAX_RATE_MULTIPLIER);

    if (isHost) {
      attackMul = Math.min(attackMul * (1 + HOST_ATTACK_BOOST), MAX_RATE_MULTIPLIER);
    }

    return { attack: attackMul, defense: defenseMul, hasData: true };
  }

  /**
   * Compute expected goals for teamA vs teamB based purely on the xG goal-rate
   * model (before blending with Elo).
   *
   * We use the standard bivariate Poisson attack/defense decomposition:
   *
   *   λA = μ × (αA / avgAttack) × (βB / avgDefense)
   *
   * where:
   *   μ           = TOTAL_BASE_XG / 2 (half the total at population average)
   *   αA          = team A's weighted average goals scored per match
   *   βB          = team B's weighted average goals conceded per match
   *   avgAttack   = population average goals scored
   *   avgDefense  = population average goals conceded
   *
   * Interpretation:
   *   - A strong attack (αA > avgAttack) pushes λA up.
   *   - A leaky defense (βB > avgDefense) also pushes λA up.
   *   - At population average (all multipliers = 1.0), λA = λB = μ.
   *
   * @param {string}  teamA
   * @param {string}  teamB
   * @param {boolean} hostA
   * @param {boolean} hostB
   * @returns {[number, number]}  [xgA, xgB]
   */
  function xgRateLambdas(teamA, teamB, hostA = false, hostB = false) {
    const mulA = getTeamMultiplier(teamA, hostA);
    const mulB = getTeamMultiplier(teamB, hostB);

    // Expected goals for A: A's attack multiplier × B's defense multiplier.
    // Both are already normalized against the population average, so at
    // average × average the product equals 1.0 and λ = halfBase.
    const halfBase = TOTAL_BASE_XG / 2;
    const rawA = halfBase * mulA.attack * mulB.defense;
    const rawB = halfBase * mulB.attack * mulA.defense;

    // Keep goals in a sane range.
    const xgA = clamp(rawA, 0.1, 6.0);
    const xgB = clamp(rawB, 0.1, 6.0);

    return [xgA, xgB];
  }

  /**
   * Primary exported function.
   *
   * Returns expected goals for a hypothetical match blending the xG goal-rate
   * model with Elo-based lambdas. Mirrors the signature of `expectedGoals()`
   * in simulation.js so it can be used as a drop-in replacement.
   *
   * @param {string}  teamA           - Display name of team A.
   * @param {string}  teamB           - Display name of team B.
   * @param {object}  [opts]
   * @param {Function} [opts.eloLambdaFn]  - `expectedGoals` from simulation.js;
   *                                         if omitted xG-only lambdas are used.
   * @param {number}  [opts.eloA]          - Elo rating for team A (required if
   *                                         eloLambdaFn is provided).
   * @param {number}  [opts.eloB]          - Elo rating for team B.
   * @param {boolean} [opts.hostA]         - Team A is a host nation.
   * @param {boolean} [opts.hostB]         - Team B is a host nation.
   * @param {boolean} [opts.knockout]      - Knockout match (capped xG share).
   * @param {number}  [opts.blend]         - Override blend factor (default XG_BLEND).
   * @returns {{ xgA: number, xgB: number,
   *             eloXgA: number, eloXgB: number,
   *             rateXgA: number, rateXgB: number,
   *             mulA: object, mulB: object }}
   */
  function expectedGoalsXG(teamA, teamB, opts = {}) {
    const {
      eloLambdaFn = null,
      eloA = BASE_RATING,
      eloB = BASE_RATING,
      hostA = false,
      hostB = false,
      knockout = false,
      blend = XG_BLEND,
    } = opts;

    // Step 1: xG goal-rate model lambdas.
    const [rateXgA, rateXgB] = xgRateLambdas(teamA, teamB, hostA, hostB);

    // Step 2: Elo-based lambdas (if an Elo function was supplied).
    let eloXgA, eloXgB;
    if (eloLambdaFn) {
      [eloXgA, eloXgB] = eloLambdaFn(eloA, eloB, hostA, hostB, knockout);
    } else {
      // Without an Elo function, treat the xG-rate model as authoritative.
      eloXgA = rateXgA;
      eloXgB = rateXgB;
    }

    // Step 3: Blend.  xgA = (1-blend) * eloXgA + blend * rateXgA
    const xgA = clamp((1 - blend) * eloXgA + blend * rateXgA, 0.1, 6.0);
    const xgB = clamp((1 - blend) * eloXgB + blend * rateXgB, 0.1, 6.0);

    // Multipliers for diagnostic display.
    const mulA = getTeamMultiplier(teamA, hostA);
    const mulB = getTeamMultiplier(teamB, hostB);

    return { xgA, xgB, eloXgA, eloXgB, rateXgA, rateXgB, mulA, mulB };
  }

  return {
    // Core functions
    expectedGoalsXG,
    getTeamMultiplier,
    xgRateLambdas,
    // Diagnostics
    rates,
    avgAttack,
    avgDefense,
    teamCount,
    // Constants (exported for verify script)
    XG_BLEND,
    MIN_RATE_MULTIPLIER,
    MAX_RATE_MULTIPLIER,
    TOTAL_BASE_XG,
    RECENT_CUTOFF,
  };
}

module.exports = {
  buildMatchXgModel,
  XG_BLEND,
  MIN_RATE_MULTIPLIER,
  MAX_RATE_MULTIPLIER,
  TOTAL_BASE_XG,
  RECENT_CUTOFF,
};
