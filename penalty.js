'use strict';

/**
 * penalty.js
 *
 * Phase 10 — Penalty shootout prediction model.
 *
 * Estimates each national team's penalty shootout strength from three free data
 * sources already used by Polycup:
 *
 *   1. Historical penalty shootout results from the martj42/international_results
 *      `shootouts.csv` (downloaded once and cached as `.cache_shootouts.csv`).
 *   2. Historical penalty goals from the cached `goalscorers.csv` as a proxy for
 *      a nation's designated taker depth / penalty experience.
 *   3. The curated `players.js` importance database for current top forwards and
 *      midfielders (the players who usually take shootout kicks).
 *   4. Elo rating as a proxy for performing under high-pressure knockout
 *      moments, plus a small host-nation bonus.
 *
 * The model is team-level: it returns a single win probability for one side in a
 * hypothetical shootout. It does not simulate individual kicks (that is a future
 * refinement), but it is a large improvement over the previous Elo-damped coin
 * flip.
 *
 * Zero third-party dependencies.
 */

const fs = require('fs');
const path = require('path');
const { datasetName, TEAMS } = require('./worldcup2026');
const { parseCsvLine, CACHE_FILE: RESULTS_CACHE } = require('./elo');
const { getTopPlayers } = require('./players');

const SHOOTOUTS_URL =
  'https://raw.githubusercontent.com/martj42/international_results/master/shootouts.csv';
const SHOOTOUTS_CACHE = path.join(process.cwd(), '.cache_shootouts.csv');
const SCORERS_CACHE = path.join(process.cwd(), '.cache_scorers.csv');

// Recency: recent shootouts matter more. Half-life ≈ 8 years.
const HALF_LIFE_DAYS = 2920;
const TODAY_ISO = new Date().toISOString().slice(0, 10);

// Minimum weighted shootouts before we trust a team's historical win rate.
const MIN_SHOOTOUTS_FOR_RATE = 3;

// Empirical baseline: in international football, the first shooter wins a
// shootout roughly 52-54% of the time. We use a conservative 4% edge.
const FIRST_SHOOTER_EDGE = 0.04;

// Small host-nation bonus for shooting in familiar conditions.
const HOST_PENALTY_BONUS = 0.03;

// Cap the historical advantage so a tiny sample cannot dominate the model.
const MAX_HISTORY_ADVANTAGE = 0.15;

// Elo-derived pressure advantage: a 400-point gap maps to ~15% shootout edge.
// Penalty shootouts are much more random than open play, so this is intentionally
// smaller than the equivalent Elo match probability.
const ELO_ADVANTAGE_SCALE = 0.15;

// Taker quality: how much the team's top forwards / midfielders and historical
// penalty-goal volume move the needle.
const MAX_TAKER_ADVANTAGE = 0.08;

// ---------------------------------------------------------------------------
// CSV download & cache
// ---------------------------------------------------------------------------

/** Download a small CSV file to the given path. */
async function downloadCsv(url, target) {
  if (typeof fetch !== 'function') {
    throw new Error('Global fetch is unavailable; please use Node.js >= 18.');
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download ${path.basename(target)} (HTTP ${res.status}).`);
  }
  const text = await res.text();
  fs.writeFileSync(target, text);
  return text;
}

/** Load shootouts.csv from cache, downloading on first run. */
async function loadShootouts({ log = () => {}, forceDownload = false } = {}) {
  if (!forceDownload && fs.existsSync(SHOOTOUTS_CACHE)) {
    log(`Loading cached shootouts from ${path.basename(SHOOTOUTS_CACHE)} ...`);
    return fs.readFileSync(SHOOTOUTS_CACHE, 'utf8');
  }
  if (forceDownload) {
    log('Refreshing shootouts dataset from GitHub ...');
  } else {
    log('No shootout cache. Downloading shootouts.csv (first run only) ...');
  }
  const text = await downloadCsv(SHOOTOUTS_URL, SHOOTOUTS_CACHE);
  log(`Downloaded and cached ${path.basename(SHOOTOUTS_CACHE)}.`);
  return text;
}

/** Load scorers.csv from the existing cache if it is present. */
function loadScorersCache({ log = () => {} } = {}) {
  if (!fs.existsSync(SCORERS_CACHE)) {
    log('No scorer cache found; penalty taker depth will be based on players.js only.');
    return '';
  }
  return fs.readFileSync(SCORERS_CACHE, 'utf8');
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse shootouts.csv.
 * Columns: date, home_team, away_team, winner, first_shooter
 */
function parseShootouts(text) {
  const entries = [];
  const lines = text.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const f = parseCsvLine(line);
    if (f.length < 4) continue;
    const [date, home, away, winner, firstShooter] = f;
    if (!date || !home || !away || !winner) continue;
    entries.push({
      date,
      home: home.trim(),
      away: away.trim(),
      winner: winner.trim(),
      firstShooter: (firstShooter || '').trim(),
    });
  }
  return entries;
}

/**
 * Parse goalscorers.csv for penalty-goal volume.
 * Columns: date, home_team, away_team, team, scorer, minute, own_goal, penalty
 */
function parseScorersForPenalties(text) {
  const goals = {}; // dataset team -> { penaltyGoals, totalGoals }
  const lines = text.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const f = parseCsvLine(line);
    if (f.length < 8) continue;
    const [, , , team, , , ownGoalStr, penaltyStr] = f;
    if (!team) continue;
    const t = team.trim();
    if (!goals[t]) goals[t] = { penaltyGoals: 0, totalGoals: 0 };
    goals[t].totalGoals += 1;
    const ownGoal = String(ownGoalStr).trim().toUpperCase() === 'TRUE';
    const penalty = String(penaltyStr).trim().toUpperCase() === 'TRUE';
    if (!ownGoal && penalty) goals[t].penaltyGoals += 1;
  }
  return goals;
}

// ---------------------------------------------------------------------------
// Recency weighting
// ---------------------------------------------------------------------------

function daysBetween(a, b) {
  return Math.abs(Date.parse(b) - Date.parse(a)) / 86400000;
}

function recencyWeight(date) {
  const age = daysBetween(date, TODAY_ISO);
  return Math.pow(2, -age / HALF_LIFE_DAYS);
}

// ---------------------------------------------------------------------------
// Historical shootout records
// ---------------------------------------------------------------------------

/**
 * Build per-team weighted shootout records.
 * Returns { datasetTeam: { wins, losses, weightedTotal, firstShoots } }.
 */
function buildShootoutRecords(entries) {
  const records = Object.create(null);
  for (const e of entries) {
    const w = recencyWeight(e.date);
    for (const team of [e.home, e.away]) {
      if (!records[team]) records[team] = { wins: 0, losses: 0, weightedTotal: 0, firstShoots: 0 };
      records[team].weightedTotal += w;
    }

    if (e.winner === e.home) {
      records[e.home].wins += w;
      records[e.away].losses += w;
    } else if (e.winner === e.away) {
      records[e.away].wins += w;
      records[e.home].losses += w;
    }

    if (e.firstShooter && records[e.firstShooter]) {
      records[e.firstShooter].firstShoots += w;
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// Taker quality
// ---------------------------------------------------------------------------

/**
 * Compute a 0..1 taker-quality score for a team.
 *
 * Sources:
 *   - `players.js` top forwards / midfielders (the usual penalty takers).
 *   - Historical penalty-goal volume from the scorers cache (proxy for a
 *     national-team culture of practicing / assigning penalties).
 */
function computeTakerQuality(teamDisplay, penaltyGoals) {
  const top = getTopPlayers(teamDisplay, 8);
  const takerTypes = top.filter((p) => p.position === 'FWD' || p.position === 'MID');
  const avgScore = takerTypes.length > 0
    ? takerTypes.reduce((s, p) => s + p.score, 0) / takerTypes.length
    : 50; // neutral default if no attackers listed

  // Normalize 0..100 importance to 0..1
  const playerQuality = avgScore / 100;

  const ds = datasetName(teamDisplay);
  const pg = penaltyGoals && penaltyGoals[ds] ? penaltyGoals[ds].penaltyGoals : 0;
  // Saturate the volume signal: a team with many historical penalty goals is
  // assumed to have more taker depth, but the signal caps quickly.
  const volumeSignal = Math.min(1, pg / 15);

  return 0.65 * playerQuality + 0.35 * volumeSignal;
}

// ---------------------------------------------------------------------------
// Strength computation
// ---------------------------------------------------------------------------

/**
 * Compute Elo-derived pressure advantage for a shootout.
 * A team 400 points above baseline gets a ~15% edge; a team 400 below gets -15%.
 */
function eloPressureAdvantage(elo, host) {
  const base = 1000;
  const raw = ((elo || base) - base) / 400 * ELO_ADVANTAGE_SCALE;
  const hostBonus = host ? HOST_PENALTY_BONUS : 0;
  return Math.max(-ELO_ADVANTAGE_SCALE, Math.min(ELO_ADVANTAGE_SCALE, raw)) + hostBonus;
}

/**
 * Build the per-team penalty-strength table from all data sources.
 *
 * @param {object} records      - from buildShootoutRecords
 * @param {object} penaltyGoals - from parseScorersForPenalties
 * @param {object} elos         - display team -> Elo rating
 * @param {Set}    hosts        - host nations
 */
function buildStrengthMap(records, penaltyGoals, elos, hosts) {
  const strengths = Object.create(null);
  for (const team of TEAMS) {
    const ds = datasetName(team);
    const rec = records[ds] || { wins: 0, losses: 0, weightedTotal: 0, firstShoots: 0 };
    const elo = (elos && elos[team]) || 1000;
    const host = hosts && hosts.has(team);

    // Historical shootout win rate with Laplace smoothing.
    let historyAdvantage = 0;
    let winRate = null;
    if (rec.weightedTotal >= MIN_SHOOTOUTS_FOR_RATE) {
      winRate = (rec.wins + 1) / (rec.weightedTotal + 2);
      historyAdvantage = Math.max(
        -MAX_HISTORY_ADVANTAGE,
        Math.min(MAX_HISTORY_ADVANTAGE, winRate - 0.5)
      );
    }

    const eloAdvantage = eloPressureAdvantage(elo, host);
    const takerQuality = computeTakerQuality(team, penaltyGoals);
    const takerAdvantage = (takerQuality - 0.5) * MAX_TAKER_ADVANTAGE * 2;

    const totalAdvantage = eloAdvantage + historyAdvantage + takerAdvantage;

    strengths[team] = {
      strength: 1 + totalAdvantage,
      factors: {
        eloAdvantage,
        historyAdvantage,
        takerAdvantage,
        hostAdvantage: host ? HOST_PENALTY_BONUS : 0,
        winRate,
        shootouts: rec.weightedTotal,
        takerQuality,
      },
    };
  }
  return strengths;
}

// ---------------------------------------------------------------------------
// Main model builder
// ---------------------------------------------------------------------------

/**
 * Build the penalty shootout model.
 *
 * @param {object}   opts
 * @param {object}   opts.elo          - Polycup Elo model with getRating()
 * @param {Function} opts.log          - Logging callback (default no-op)
 * @param {boolean}  opts.forceDownload - Re-download shootouts.csv even if cached
 *
 * @returns {{
 *   predictPenaltyShootout(teamA, teamB, opts): { pA, pB, factorsA, factorsB },
 *   getFactors(team): { eloAdvantage, historyAdvantage, takerAdvantage, hostAdvantage, winRate, shootouts, takerQuality },
 *   getTakers(team, n): Array<{ name, score, position }>,
 *   records: object,
 *   penaltyGoals: object,
 * }}
 */
async function buildPenaltyModel({ elo, log = () => {}, forceDownload = false } = {}) {
  if (!elo || typeof elo.getRating !== 'function') {
    throw new Error('buildPenaltyModel requires an Elo model with getRating().');
  }

  // 1. Historical shootout results.
  const shootoutsText = await loadShootouts({ log, forceDownload });
  const shootoutEntries = parseShootouts(shootoutsText);
  const records = buildShootoutRecords(shootoutEntries);
  log(
    `Penalty model: ${shootoutEntries.length.toLocaleString()} historical shootouts, ` +
    `${Object.keys(records).length.toLocaleString()} distinct teams.`
  );

  // 2. Historical penalty goals (best-effort cache).
  let penaltyGoals = Object.create(null);
  try {
    const scorersText = loadScorersCache({ log });
    if (scorersText) {
      penaltyGoals = parseScorersForPenalties(scorersText);
      log('Penalty model: loaded historical penalty-goal volume.');
    }
  } catch (e) {
    log(`Penalty model: could not load scorer cache: ${e.message}`);
  }

  // 3. Snapshot Elo ratings for all 48 qualified teams.
  const elos = Object.create(null);
  for (const team of TEAMS) elos[team] = elo.getRating(team);

  // 4. Build strength map.
  const HOSTS = new Set(['USA', 'Canada', 'Mexico']);
  const strengths = buildStrengthMap(records, penaltyGoals, elos, HOSTS);

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Predict a penalty shootout between two teams.
   *
   * @param {string} teamA
   * @param {string} teamB
   * @param {object} [opts]
   * @param {boolean} [opts.hostA]   - Team A is a host nation
   * @param {boolean} [opts.hostB]   - Team B is a host nation
   * @param {string}  [opts.firstShooter] - 'teamA' or 'teamB' (or omitted)
   *
   * @returns {{
   *   pA: number,
   *   pB: number,
   *   factorsA: object,
   *   factorsB: object,
   * }}
   */
  function predictPenaltyShootout(teamA, teamB, opts = {}) {
    if (!teamA || !teamB) throw new Error('predictPenaltyShootout requires two teams.');
    if (teamA === teamB) throw new Error('predictPenaltyShootout requires two different teams.');

    const a = strengths[teamA] || { strength: 1, factors: {} };
    const b = strengths[teamB] || { strength: 1, factors: {} };

    let pA = a.strength / (a.strength + b.strength);

    // Apply host-nation bonus if it was not already folded into the strength map.
    // The strength map already applies host to *both* teams, so this only adds
    // the conditional bonus when the caller explicitly asks for it.
    if (opts.hostA) pA += HOST_PENALTY_BONUS / 2;
    if (opts.hostB) pA -= HOST_PENALTY_BONUS / 2;

    if (opts.firstShooter === 'teamA') pA += FIRST_SHOOTER_EDGE;
    if (opts.firstShooter === 'teamB') pA -= FIRST_SHOOTER_EDGE;

    // Keep a floor so even a huge underdog is not zero.
    pA = Math.max(0.05, Math.min(0.95, pA));

    return {
      pA,
      pB: 1 - pA,
      factorsA: a.factors,
      factorsB: b.factors,
    };
  }

  function getFactors(team) {
    const s = strengths[team];
    return s ? { ...s.factors } : null;
  }

  function getTakers(team, n = 5) {
    return getTopPlayers(team, n)
      .filter((p) => p.position === 'FWD' || p.position === 'MID')
      .slice(0, n);
  }

  return {
    predictPenaltyShootout,
    getFactors,
    getTakers,
    records,
    penaltyGoals,
  };
}

module.exports = {
  buildPenaltyModel,
  SHOOTOUTS_CACHE,
  FIRST_SHOOTER_EDGE,
  HOST_PENALTY_BONUS,
};
