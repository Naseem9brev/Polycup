'use strict';

/**
 * playerxg.js
 *
 * EXPERIMENTAL — Phase 12: Player-level xG model.
 *
 * Builds a player-contribution model from the martj42/international_results
 * goalscorers dataset (the same free source used by elo.js). For each active
 * international player we compute a recency-weighted goals-per-appearance rate,
 * then aggregate the top-N players' contributions into a team-level attacking
 * and defensive modifier that adjusts the base Elo xG lambdas.
 *
 * Pipeline
 * --------
 *   1. Download/cache goalscorers.csv from the martj42 GitHub repo (same cache
 *      pattern as elo.js — one extra file, .cache_scorers.csv).
 *   2. Parse every goal entry (date, team, scorer, own_goal, penalty flag).
 *      Own-goals are excluded from the scorer's attacking tally.
 *   3. Use the cached results.csv to count each team's matches in the recent
 *      window — this becomes the appearance denominator.
 *   4. Compute player_xg_per90:
 *        recency-weighted_goals / appearances
 *      Goals further in the past are down-weighted with an exponential decay
 *      (half-life ≈ 3 years). Penalty goals count at 40% to avoid inflating
 *      a player's open-play danger rating.
 *   5. Name normalization: Unicode accent differences ("Álvarez" vs "Alvarez")
 *      are collapsed so each player appears only once per team.
 *   6. Build a team's "effective lineup": top LINEUP_SIZE players by xgPer90.
 *      Sum their individual contributions → teamXgPer90.
 *   7. Normalize against the population average across all 48 qualified teams
 *      to produce a dimensionless multiplier (1.0 = average).
 *   8. Blend the player-adjusted lambda with the Elo base lambda using a
 *      PLAYER_BLEND weight (default 0.35 — player data shifts the prediction
 *      by up to ±35% compared to pure Elo).
 *
 * Design constraints
 * ------------------
 *   - Zero third-party runtime dependencies.
 *   - All network calls use Node.js built-in `fetch` (Node >= 18).
 *   - Gracefully degrades: if the scorer cache is missing or a team has no data,
 *     the function returns the unmodified Elo lambdas (multiplier = 1.0).
 *   - Clearly labeled as experimental; the default Elo/Dixon-Coles path is
 *     unchanged by this module.
 */

const fs = require('fs');
const path = require('path');
const { datasetName } = require('./worldcup2026');
const { parseCsvLine, CACHE_FILE } = require('./elo');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCORERS_URL =
  'https://raw.githubusercontent.com/martj42/international_results/master/goalscorers.csv';
const SCORERS_CACHE = path.join(process.cwd(), '.cache_scorers.csv');

// Only use matches from this date onwards for player rates.
// 4 years gives recent form without noise from retired squads.
const RECENT_CUTOFF = '2022-01-01';

// Recency half-life: a goal scored HALF_LIFE_DAYS ago counts half as much.
// ~3 years (≈1095 days).
const HALF_LIFE_DAYS = 1095;

// Penalty goals exist in open play too, but are less indicative of danger.
// Down-weight them so a specialist penalty taker doesn't dominate.
const PENALTY_WEIGHT = 0.4;

// Number of top players to include in a team's "effective lineup".
const LINEUP_SIZE = 11;

// Clamp team attack/defense multipliers to this range to avoid extreme shifts.
const MIN_TEAM_MULTIPLIER = 0.70;
const MAX_TEAM_MULTIPLIER = 1.40;

// Blend factor: how much the player model shifts the Elo lambda.
// 0 = pure Elo, 1 = fully player-driven.  0.35 = modest 35% influence.
const PLAYER_BLEND = 0.35;

// Minimum distinct scoring appearances before we include a player.
// Filters out one-off heroes who happened to score in their only game.
const MIN_SCORING_APPEARANCES = 2;

// ---------------------------------------------------------------------------
// Normalise player names for deduplication
// ---------------------------------------------------------------------------

/**
 * Strip Unicode diacritics and lower-case so "Álvarez" === "alvarez".
 * This prevents the same player appearing twice due to dataset encoding
 * inconsistencies (e.g. "Julián Álvarez" vs "Julián Alvarez").
 */
function normalizeName(name) {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// CSV download & cache
// ---------------------------------------------------------------------------

/** Download goalscorers.csv to the cache file. */
async function downloadScorers() {
  if (typeof fetch !== 'function') {
    throw new Error('Global fetch is unavailable; please use Node.js >= 18.');
  }
  const res = await fetch(SCORERS_URL);
  if (!res.ok) {
    throw new Error(`Failed to download goalscorers.csv (HTTP ${res.status}).`);
  }
  const text = await res.text();
  fs.writeFileSync(SCORERS_CACHE, text);
  return text;
}

/** Load goalscorers.csv from cache, downloading on first run. */
async function loadScorers({ log = () => {}, forceDownload = false } = {}) {
  if (!forceDownload && fs.existsSync(SCORERS_CACHE)) {
    log(`Loading cached goalscorers from ${path.basename(SCORERS_CACHE)} ...`);
    return fs.readFileSync(SCORERS_CACHE, 'utf8');
  }
  if (forceDownload) {
    log('Refreshing goalscorers dataset from GitHub ...');
  } else {
    log('No scorer cache. Downloading goalscorers.csv (first run only) ...');
  }
  const text = await downloadScorers();
  log(`Downloaded and cached ${path.basename(SCORERS_CACHE)}.`);
  return text;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse the goalscorers CSV.
 * Columns: date, home_team, away_team, team, scorer, minute, own_goal, penalty
 *
 * Returns entries with own_goal flagged so callers can exclude them from
 * attacking tallies.
 */
function parseScorers(text) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const f = parseCsvLine(line);
    if (f.length < 8) continue;
    const [date, homeTeam, awayTeam, team, scorer, , ownGoalStr, penaltyStr] = f;
    if (!date || !scorer) continue;
    entries.push({
      date,
      homeTeam,
      awayTeam,
      team,
      scorer: scorer.trim(),
      ownGoal: String(ownGoalStr).trim().toUpperCase() === 'TRUE',
      penalty: String(penaltyStr).trim().toUpperCase() === 'TRUE',
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Recency weighting
// ---------------------------------------------------------------------------

/** Days between two ISO date strings (YYYY-MM-DD). */
function daysBetween(a, b) {
  return Math.abs(Date.parse(b) - Date.parse(a)) / 86400000;
}

const TODAY_ISO = new Date().toISOString().slice(0, 10);

/** Recency weight: exponential decay so recent goals count more. */
function recencyWeight(date) {
  const age = daysBetween(date, TODAY_ISO);
  return Math.pow(2, -age / HALF_LIFE_DAYS);
}

// ---------------------------------------------------------------------------
// Team match-count map (from the already-cached results.csv)
// ---------------------------------------------------------------------------

/**
 * Count each team's matches in the recent window from the results CSV.
 * Returns { [teamDatasetName]: count }.
 */
function buildTeamMatchCounts(resultsText) {
  const counts = Object.create(null);
  if (!resultsText) return counts;
  const lines = resultsText.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const f = parseCsvLine(line);
    if (f.length < 9) continue;
    const [date, home, away, hs, as_] = f;
    if (date < RECENT_CUTOFF) continue;
    const unplayed = hs === 'NA' || as_ === 'NA' || hs === '' || as_ === '';
    if (unplayed) continue;
    counts[home] = (counts[home] || 0) + 1;
    counts[away] = (counts[away] || 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Player stats computation
// ---------------------------------------------------------------------------

/**
 * Build a canonical player stats map.
 *
 *   playerStats[normalizedName] = {
 *     displayName,          // most-seen raw spelling
 *     team,                 // dataset team name
 *     xgPer90,              // recency-weighted goals / appearances
 *     lastSeen,             // ISO date of most-recent goal
 *   }
 *
 * Appearance estimation:
 *   International data has no minute-by-minute lineups. We approximate a
 *   player's appearances as: max(scoringMatches, MIN_SCORING_APPEARANCES, teamMatches×0.35).
 *   The 0.35 floor prevents one-game wonders from inflating goals/90 while
 *   still letting genuine difference-makers (e.g. Mbappé, Messi) show high
 *   rates — because even with 58 "appearances", their weighted goal totals
 *   remain dominant.
 */
function buildPlayerStats(scorerEntries, teamMatchCounts) {
  // Filter to the recent window and exclude own-goals from attacking stats.
  const recent = scorerEntries.filter((e) => !e.ownGoal && e.date >= RECENT_CUTOFF);

  // Step 1: group by (normalizedName, team) to handle Unicode duplicates.
  // raw: "normName|team" -> { wGoals, scoringDates: Set<date>, lastSeen, rawNames: Map<name,count> }
  const raw = Object.create(null);
  for (const e of recent) {
    const normName = normalizeName(e.scorer);
    const key = `${normName}|${e.team}`;
    if (!raw[key]) {
      raw[key] = {
        wGoals: 0,
        scoringDates: new Set(),
        lastSeen: e.date,
        rawNames: new Map(),
      };
    }
    const w = recencyWeight(e.date) * (e.penalty ? PENALTY_WEIGHT : 1.0);
    raw[key].wGoals += w;
    raw[key].scoringDates.add(e.date);
    if (e.date > raw[key].lastSeen) raw[key].lastSeen = e.date;
    // Track the most-used raw spelling.
    raw[key].rawNames.set(e.scorer, (raw[key].rawNames.get(e.scorer) || 0) + 1);
  }

  // Step 2: build final stats per (normalizedName, team).
  const stats = Object.create(null); // normName -> { team, displayName, xgPer90, lastSeen }[]
  for (const [key, d] of Object.entries(raw)) {
    const pipeIdx = key.lastIndexOf('|');
    const normName = key.slice(0, pipeIdx);
    const team = key.slice(pipeIdx + 1);

    if (d.scoringDates.size < MIN_SCORING_APPEARANCES) continue;

    // Pick the most-used raw spelling as the display name.
    const displayName = [...d.rawNames.entries()].sort((a, b) => b[1] - a[1])[0][0];

    // Appearances denominator: the larger of unique scoring matches and a
    // floor derived from the team's match count in the period.
    const teamTotal = teamMatchCounts[team] || 30;
    const appearances = Math.max(d.scoringDates.size, Math.ceil(teamTotal * 0.35));

    const xgPer90 = d.wGoals / appearances;

    if (!stats[normName]) stats[normName] = [];
    stats[normName].push({ team, displayName, xgPer90, lastSeen: d.lastSeen });
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Team lineup & aggregation
// ---------------------------------------------------------------------------

/**
 * Get the top LINEUP_SIZE players for a given team and return their aggregate
 * xG-per-90 contribution alongside the individual player list.
 *
 * @param {string} teamDisplay  - Canonical display name (e.g. "Brazil")
 * @param {object} playerStats  - From buildPlayerStats()
 * @returns {{ players: Array<{name,xgPer90,lastSeen}>, totalXgPer90: number }}
 */
function teamLineup(teamDisplay, playerStats) {
  const dsName = datasetName(teamDisplay);

  // Collect all players who have data for this team.
  const candidates = [];
  for (const [, entries] of Object.entries(playerStats)) {
    const entry = entries.find((e) => e.team === dsName || e.team === teamDisplay);
    if (!entry) continue;
    // Exclude players last seen before 2020 (retired / not in current squad).
    if (entry.lastSeen < '2020-01-01') continue;
    candidates.push({
      name: entry.displayName,
      xgPer90: entry.xgPer90,
      lastSeen: entry.lastSeen,
    });
  }

  // Sort by xG/90 descending; take top LINEUP_SIZE.
  candidates.sort((a, b) => b.xgPer90 - a.xgPer90);
  const lineup = candidates.slice(0, LINEUP_SIZE);

  const totalXgPer90 = lineup.reduce((s, p) => s + p.xgPer90, 0);
  return { players: lineup, totalXgPer90 };
}

// ---------------------------------------------------------------------------
// Population average
// ---------------------------------------------------------------------------

/**
 * Compute the mean team xG-per-90 across the 48 qualified teams.
 * This is the reference value against which individual teams are compared.
 */
function computePopulationAvg(playerStats, qualifiedTeams) {
  const sums = [];
  for (const team of qualifiedTeams) {
    const { totalXgPer90 } = teamLineup(team, playerStats);
    if (totalXgPer90 > 0) sums.push(totalXgPer90);
  }
  if (sums.length === 0) return 1;
  return sums.reduce((a, b) => a + b, 0) / sums.length;
}

// ---------------------------------------------------------------------------
// Main model builder
// ---------------------------------------------------------------------------

/**
 * Build the player xG model.
 *
 * Downloads/caches goalscorers.csv on first call, then computes per-player
 * xG rates and exposes them through a simple API.
 *
 * @param {object}   opts
 * @param {Function} opts.log           - Logging callback (default: no-op)
 * @param {boolean}  opts.forceDownload - Re-download even if cache exists
 *
 * @returns {Promise<{
 *   getTeamMultiplier(displayName): { attack: number, defense: number },
 *   predictMatchPlayerBased(eloA, eloB, teamA, teamB, hostA, hostB, baseLambdaFn):
 *     { lambdaA, lambdaB, baseLambdaA, baseLambdaB, mulA, mulB, playersA, playersB },
 *   teamLineup(displayName): { players, totalXgPer90 },
 *   playerStats: object,
 *   populationAvgXg: number,
 * }>}
 */
async function buildPlayerModel({ log = () => {}, forceDownload = false } = {}) {
  // 1. Load scorer data.
  const scorersText = await loadScorers({ log, forceDownload });
  const scorerEntries = parseScorers(scorersText);

  // 2. Load results cache for appearance estimation.
  let resultsText = '';
  try {
    resultsText = fs.readFileSync(CACHE_FILE, 'utf8');
  } catch (_) {
    log('Warning: results cache not found; appearance estimates will be approximate.');
  }

  // 3. Build team match counts and player stats.
  const teamMatchCounts = buildTeamMatchCounts(resultsText);
  const playerStats = buildPlayerStats(scorerEntries, teamMatchCounts);

  // 4. Population average across all 48 qualified teams.
  const { TEAMS } = require('./worldcup2026');
  const populationAvgXg = computePopulationAvg(playerStats, TEAMS);

  const recentGoals = scorerEntries.filter((e) => !e.ownGoal && e.date >= RECENT_CUTOFF).length;
  log(
    `Player model: ${Object.keys(playerStats).length.toLocaleString()} players ` +
    `from ${recentGoals.toLocaleString()} recent goals. ` +
    `Population avg team xG/90: ${populationAvgXg.toFixed(4)}.`
  );

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Returns { attack, defense } multipliers for a team, both centered at 1.0.
   *
   *   attack  > 1 → above-average attacking output (boost team's lambda)
   *   defense < 1 → below-average goal concession (reduce opponent's lambda)
   *
   * Because only attacking data (goals scored) is available in this dataset,
   * defensive quality is proxied as 1 / sqrt(attack_raw).  This is a
   * deliberate simplification: strong scoring teams (who tend to be strong
   * overall) are assumed to also defend relatively well, and the sqrt dampens
   * the defensive signal to avoid over-correcting.
   */
  function getTeamMultiplier(displayName) {
    const { totalXgPer90 } = teamLineup(displayName, playerStats);
    if (populationAvgXg === 0 || totalXgPer90 === 0) {
      return { attack: 1.0, defense: 1.0 };
    }
    const raw = totalXgPer90 / populationAvgXg;
    const attack = Math.max(MIN_TEAM_MULTIPLIER, Math.min(MAX_TEAM_MULTIPLIER, raw));
    // Defensive proxy: inverse-sqrt of the raw ratio, clamped.
    const defense = Math.max(
      MIN_TEAM_MULTIPLIER,
      Math.min(MAX_TEAM_MULTIPLIER, 1 / Math.sqrt(raw))
    );
    return { attack, defense };
  }

  /**
   * Predict a match using the player-adjusted xG model.
   *
   * The returned lambdaA and lambdaB are ready to be passed directly into
   * the existing Dixon-Coles joint probability matrix (as a drop-in replacement
   * for the base Elo lambdas).
   *
   * @param {number}   eloA        - Elo rating of team A
   * @param {number}   eloB        - Elo rating of team B
   * @param {string}   teamA       - Display name of team A (e.g. "Brazil")
   * @param {string}   teamB       - Display name of team B (e.g. "France")
   * @param {boolean}  hostA       - Is team A a host nation?
   * @param {boolean}  hostB       - Is team B a host nation?
   * @param {Function} baseLambdaFn - `expectedGoals(eloA, eloB, hostA, hostB)`
   *                                  imported from simulation.js
   *
   * @returns {{
   *   lambdaA: number,      adjusted expected goals for team A
   *   lambdaB: number,      adjusted expected goals for team B
   *   baseLambdaA: number,  raw Elo-based lambda for team A (for comparison)
   *   baseLambdaB: number,  raw Elo-based lambda for team B
   *   mulA: { attack, defense },   player multipliers for team A
   *   mulB: { attack, defense },   player multipliers for team B
   *   playersA: Array,      top-rated players contributing for team A
   *   playersB: Array,      top-rated players contributing for team B
   * }}
   */
  function predictMatchPlayerBased(eloA, eloB, teamA, teamB, hostA, hostB, baseLambdaFn) {
    const [baseLambdaA, baseLambdaB] = baseLambdaFn(eloA, eloB, hostA, hostB);

    const mulA = getTeamMultiplier(teamA);
    const mulB = getTeamMultiplier(teamB);

    // Player-adjusted lambdas:
    //   teamA attacks vs. teamB defense → base × (mulA.attack / mulB.defense)
    //   teamB attacks vs. teamA defense → base × (mulB.attack / mulA.defense)
    const adjA = baseLambdaA * (mulA.attack / mulB.defense);
    const adjB = baseLambdaB * (mulB.attack / mulA.defense);

    // Blend: pure-Elo prediction + player-model adjustment.
    const lambdaA = (1 - PLAYER_BLEND) * baseLambdaA + PLAYER_BLEND * adjA;
    const lambdaB = (1 - PLAYER_BLEND) * baseLambdaB + PLAYER_BLEND * adjB;

    const { players: playersA } = teamLineup(teamA, playerStats);
    const { players: playersB } = teamLineup(teamB, playerStats);

    return {
      lambdaA,
      lambdaB,
      baseLambdaA,
      baseLambdaB,
      mulA,
      mulB,
      playersA,
      playersB,
    };
  }

  return {
    getTeamMultiplier,
    predictMatchPlayerBased,
    teamLineup: (name) => teamLineup(name, playerStats),
    playerStats,
    populationAvgXg,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  buildPlayerModel,
  loadScorers,
  parseScorers,
  SCORERS_CACHE,
  RECENT_CUTOFF,
  PLAYER_BLEND,
  MIN_TEAM_MULTIPLIER,
  MAX_TEAM_MULTIPLIER,
};
