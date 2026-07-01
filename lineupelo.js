'use strict';

/**
 * lineupelo.js
 *
 * Lineup-aware Elo adjustment engine (Phase 8).
 *
 * Rationale:
 *  The base Elo model captures long-run national team strength.  But on any
 *  given match day the actual lineup can deviate significantly: a star striker
 *  may be suspended, an elite keeper injured, or an entire first-choice back
 *  four benched for rotation.  This module translates those deviations into
 *  an additive Elo bump or penalty that can be fed directly into expectedGoals()
 *  or predictMatch().
 *
 * Model:
 *  1. For each confirmed starter we check whether they appear in the player
 *     database (players.js).  If they do, their importance score contributes
 *     a positive "lineup strength" value.
 *  2. For each database player who is *expected* to start (top-N by score) but
 *     does *not* appear in the confirmed starters, we record an absence penalty.
 *  3. The final Elo delta = (confirmed star bonus) + (absence penalty).
 *     Both components are scaled so that the *maximum plausible adjustment* is
 *     ±MAX_LINEUP_ELO_DELTA points; a single absent superstar (e.g. Messi, score
 *     100) produces roughly −25 to −30 Elo on its own, in line with empirical
 *     estimates from sports-analytics literature (Pantuso & Hvattum, 2021).
 *  4. When no lineup data is available, the adjustment is 0 (graceful degradation).
 *
 * Tuning constants:
 *  EXPECTED_STARTERS   — how many DB players we assume will usually start
 *  ABSENCE_SCALE       — Elo points lost per importance point of an absent star
 *  PRESENCE_SCALE      — Elo points gained per importance point of a confirmed star
 *  MAX_LINEUP_ELO_DELTA — hard cap to prevent single-player effects dominating
 *
 * Zero third-party dependencies.
 */

const { lookupPlayer, getTopPlayers, getTeamPlayers } = require('./players');

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

// We model this many "expected starters" from the DB per team.
// In practice only the top-N are considered "must-starts" for absence tracking.
const EXPECTED_STARTERS = 5;

// Elo lost per importance point when an expected star is confirmed absent.
// At 0.30, a player with score 100 absent → -30 Elo; score 80 absent → -24 Elo.
const ABSENCE_SCALE = 0.30;

// Elo gained per importance point when a confirmed starter is found in the DB
// and starts (validates expectation).  Set to 0: "star plays as expected" is
// already fully priced into the base Elo, so confirming the expected lineup
// produces no additional bonus.  Only absences move the needle.
const PRESENCE_SCALE = 0;

// Hard cap: total lineup adjustment cannot exceed ±80 Elo in either direction.
const MAX_LINEUP_ELO_DELTA = 80;

// Minimum importance score to be considered a "key" player worth tracking.
const MIN_KEY_SCORE = 70;

// ---------------------------------------------------------------------------
// Core adjustment function
// ---------------------------------------------------------------------------

/**
 * Compute the lineup-derived Elo adjustment for one team.
 *
 * @param {string}   team        - Canonical team display name (matches players.js keys)
 * @param {string[]} starters    - Names of confirmed starters (from ESPN rosters)
 * @returns {{
 *   delta: number,            // net Elo adjustment (positive = stronger than expected)
 *   confirmed: Array,         // DB players confirmed starting
 *   absent: Array,            // DB top players NOT found in starters
 *   unknown: string[],        // starter names with no DB entry
 *   hasData: boolean,         // false when starters array is empty / null
 * }}
 */
function computeLineupDelta(team, starters) {
  // Graceful degradation: no data → zero adjustment
  if (!starters || starters.length === 0) {
    return { delta: 0, confirmed: [], absent: [], unknown: [], hasData: false };
  }

  const topExpected = getTopPlayers(team, EXPECTED_STARTERS);
  const allDbPlayers = getTeamPlayers(team);

  const confirmed = [];
  const absent    = [];
  const unknown   = [];

  // Step 1 — scan confirmed starters against the DB
  for (const starterName of starters) {
    const entry = lookupPlayer(starterName, team);
    if (entry) {
      confirmed.push({ ...entry, starterName });
    } else {
      unknown.push(starterName);
    }
  }

  // Step 2 — find expected top players who are absent from the starting XI
  for (const expected of topExpected) {
    const found = confirmed.find(c => c.name === expected.name);
    if (!found && expected.score >= MIN_KEY_SCORE) {
      absent.push(expected);
    }
  }

  // Step 3 — calculate delta
  // Presence bonus: reward for having DB-tracked stars actually starting
  const presenceBonus = confirmed
    .filter(c => c.score >= MIN_KEY_SCORE)
    .reduce((sum, c) => sum + c.score * PRESENCE_SCALE, 0);

  // Absence penalty: proportional to how important the missing player is
  const absencePenalty = absent
    .reduce((sum, p) => sum + p.score * ABSENCE_SCALE, 0);

  const rawDelta = presenceBonus - absencePenalty;
  const delta = Math.max(-MAX_LINEUP_ELO_DELTA, Math.min(MAX_LINEUP_ELO_DELTA, rawDelta));

  return {
    delta,
    confirmed,
    absent,
    unknown,
    hasData: true,
  };
}

/**
 * Compute lineup-aware Elo adjustments for both teams in a match.
 *
 * @param {string}   teamA       - Home team display name
 * @param {string[]} startersA   - Confirmed starters for team A (may be null/empty)
 * @param {string}   teamB       - Away team display name
 * @param {string[]} startersB   - Confirmed starters for team B (may be null/empty)
 * @returns {{
 *   home: { delta, confirmed, absent, unknown, hasData },
 *   away: { delta, confirmed, absent, unknown, hasData },
 * }}
 */
function computeMatchLineupDeltas(teamA, startersA, teamB, startersB) {
  return {
    home: computeLineupDelta(teamA, startersA),
    away: computeLineupDelta(teamB, startersB),
  };
}

// ---------------------------------------------------------------------------
// Roster extraction helper
// ---------------------------------------------------------------------------

/**
 * Extract starter name arrays from the lineups object stored in matchstate
 * (which mirrors the parseSummary rosters structure).
 *
 * Handles two shapes:
 *  (a) summary.rosters  — direct from datasource.parseSummary (each has .team, .starters[])
 *  (b) matchState.lineups — from matchstate.extractLineups (same shape)
 *
 * @param {object|null} lineups  - lineups from matchState or summary.rosters
 * @param {string}      teamA   - home team display name (for roster matching)
 * @param {string}      teamB   - away team display name
 * @returns {{ startersA: string[], startersB: string[] }}
 */
function extractStarterNames(lineups, teamA, teamB) {
  if (!lineups || !Array.isArray(lineups) || lineups.length < 2) {
    return { startersA: [], startersB: [] };
  }

  // Match rosters to teams by fuzzy name comparison
  function rosterFor(teamName) {
    const lower = teamName.toLowerCase();
    return lineups.find(r => {
      if (!r.team) return false;
      const rt = r.team.toLowerCase();
      return rt.includes(lower) || lower.includes(rt) ||
             rt.split(' ').some(w => w.length >= 4 && lower.includes(w));
    });
  }

  const rosterA = rosterFor(teamA);
  const rosterB = rosterFor(teamB);

  const namesOf = (roster) =>
    roster && Array.isArray(roster.starters)
      ? roster.starters.map(p => (typeof p === 'string' ? p : p.name || '')).filter(Boolean)
      : [];

  return {
    startersA: namesOf(rosterA),
    startersB: namesOf(rosterB),
  };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/**
 * Format a human-readable lineup adjustment summary for a single team.
 *
 * @param {string} team
 * @param {object} result - return value of computeLineupDelta()
 * @param {number} baseElo
 * @returns {string[]} array of display lines
 */
function formatLineupAdjustment(team, result, baseElo) {
  const lines = [];
  const sign  = result.delta >= 0 ? '+' : '';

  lines.push(`  ${team}`);
  lines.push(`    Base Elo      : ${Math.round(baseElo)}`);
  lines.push(`    Lineup delta  : ${sign}${Math.round(result.delta)} Elo`);
  lines.push(`    Adjusted Elo  : ${Math.round(baseElo + result.delta)}`);

  if (!result.hasData) {
    lines.push('    (no lineup data — adjustment not applied)');
    return lines;
  }

  if (result.confirmed.length > 0) {
    lines.push(`    Key starters confirmed (${result.confirmed.length}):`);
    for (const p of result.confirmed) {
      lines.push(`      ✓ ${p.name} [${p.position}, score ${p.score}]`);
    }
  }

  if (result.absent.length > 0) {
    lines.push(`    Key players absent (${result.absent.length}):`);
    for (const p of result.absent) {
      lines.push(`      ✗ ${p.name} [${p.position}, score ${p.score}] — not in starting XI`);
    }
  }

  return lines;
}

/**
 * Build a full two-team lineup-adjusted prediction summary.
 *
 * @param {string} teamA
 * @param {string} teamB
 * @param {object} homeResult - computeLineupDelta result for teamA
 * @param {object} awayResult - computeLineupDelta result for teamB
 * @param {number} baseEloA
 * @param {number} baseEloB
 * @param {object} basePred   - predictMatch result WITHOUT lineup adjustment
 * @param {object} adjPred    - predictMatch result WITH lineup adjustment
 * @returns {string} formatted multi-line string
 */
function formatLineupPrediction(teamA, teamB, homeResult, awayResult,
                                 baseEloA, baseEloB, basePred, adjPred) {
  const pct = (p) => (p * 100).toFixed(1);
  const lines = [];

  lines.push('');
  lines.push('  ' + '='.repeat(60));
  lines.push(`  LINEUP-AWARE PREDICTION: ${teamA}  vs  ${teamB}`);
  lines.push('  ' + '='.repeat(60));

  // Team A
  lines.push('');
  lines.push(...formatLineupAdjustment(teamA, homeResult, baseEloA));

  lines.push('');

  // Team B
  lines.push(...formatLineupAdjustment(teamB, awayResult, baseEloB));

  // Prediction comparison
  lines.push('');
  lines.push('  ' + '-'.repeat(60));
  lines.push('  PREDICTION COMPARISON');
  lines.push('  ' + '-'.repeat(60));

  const hasAnyData = homeResult.hasData || awayResult.hasData;

  if (hasAnyData) {
    lines.push(`  ${''.padEnd(22)} ${'Base'.padStart(8)} ${'Adjusted'.padStart(10)}`);
    lines.push(`  ${teamA} win`.padEnd(22) +
               `${(pct(basePred.pWin) + '%').padStart(8)}` +
               `${(pct(adjPred.pWin) + '%').padStart(10)}`);
    lines.push(`  Draw`.padEnd(22) +
               `${(pct(basePred.pDraw) + '%').padStart(8)}` +
               `${(pct(adjPred.pDraw) + '%').padStart(10)}`);
    lines.push(`  ${teamB} win`.padEnd(22) +
               `${(pct(basePred.pLoss) + '%').padStart(8)}` +
               `${(pct(adjPred.pLoss) + '%').padStart(10)}`);
    lines.push('');
    lines.push(`  Expected goals  (adj): ${teamA} ${adjPred.xgA.toFixed(2)} — ${adjPred.xgB.toFixed(2)} ${teamB}`);
    lines.push(`  Most likely score     : ${teamA} ${adjPred.scoreline[0]}-${adjPred.scoreline[1]} ${teamB}`);
  } else {
    // No lineup data at all — just show the base prediction
    lines.push('  (No lineup data available — showing base prediction only)');
    lines.push(`  ${teamA} win : ${pct(basePred.pWin)}%`);
    lines.push(`  Draw       : ${pct(basePred.pDraw)}%`);
    lines.push(`  ${teamB} win : ${pct(basePred.pLoss)}%`);
    lines.push(`  Expected goals : ${teamA} ${basePred.xgA.toFixed(2)} — ${basePred.xgB.toFixed(2)} ${teamB}`);
    lines.push(`  Most likely score : ${teamA} ${basePred.scoreline[0]}-${basePred.scoreline[1]} ${teamB}`);
  }

  lines.push('');
  lines.push('  ' + '='.repeat(60));

  return lines.join('\n');
}

/**
 * Format a short one-line Elo adjustment note for the watch-mode display.
 * Example: "  Lineup adj: FRA −18 / ENG +3 Elo"
 *
 * @param {string} teamA
 * @param {string} teamB
 * @param {object} homeResult
 * @param {object} awayResult
 * @returns {string|null}  null when neither team has data
 */
function formatWatchLineupNote(teamA, teamB, homeResult, awayResult) {
  if (!homeResult.hasData && !awayResult.hasData) return null;

  const fmtDelta = (r) => {
    if (!r.hasData) return 'n/a';
    const s = Math.round(r.delta);
    return (s >= 0 ? '+' : '') + String(s);
  };

  const absentNames = (r) => {
    if (!r.hasData || r.absent.length === 0) return '';
    return ` (missing: ${r.absent.map(p => p.name).join(', ')})`;
  };

  const lineA = `${teamA} ${fmtDelta(homeResult)}${absentNames(homeResult)}`;
  const lineB = `${teamB} ${fmtDelta(awayResult)}${absentNames(awayResult)}`;
  return `  Lineup Elo adj: ${lineA} / ${lineB}`;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  computeLineupDelta,
  computeMatchLineupDeltas,
  extractStarterNames,
  formatLineupAdjustment,
  formatLineupPrediction,
  formatWatchLineupNote,
  // Exported for testing / verification
  EXPECTED_STARTERS,
  ABSENCE_SCALE,
  PRESENCE_SCALE,
  MAX_LINEUP_ELO_DELTA,
  MIN_KEY_SCORE,
};
