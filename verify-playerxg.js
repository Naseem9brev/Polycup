#!/usr/bin/env node
'use strict';

/**
 * verify-playerxg.js
 *
 * Verification script for the Phase 12 player-level xG model.
 *
 * Checks that the model:
 *   1. Loads and parses the goalscorers dataset without errors.
 *   2. Correctly deduplicates player names with Unicode accent differences.
 *   3. Assigns sensible xG-per-90 rates to elite players (Mbappé, Messi, Kane).
 *   4. Computes team multipliers in [MIN_TEAM_MULTIPLIER, MAX_TEAM_MULTIPLIER].
 *   5. Produces player-adjusted lambdas that differ meaningfully from the Elo
 *      baseline (i.e. the model actually does something).
 *   6. Keeps total xG within a reasonable range (0.3–5.0 goals per team).
 *   7. Degrades gracefully — base Elo lambdas are always within the returned
 *      fields for side-by-side comparison.
 *   8. Produces the expected output shape from `predictMatchPlayerBased`.
 *
 * Exit 0 on all checks passing, exit 1 on any failure.
 *
 * Usage:
 *   node verify-playerxg.js
 */

const {
  buildPlayerModel,
  MIN_TEAM_MULTIPLIER,
  MAX_TEAM_MULTIPLIER,
  PLAYER_BLEND,
} = require('./playerxg');
const { buildEloModel } = require('./elo');
const { expectedGoals, HOSTS } = require('./simulation');

// ---------------------------------------------------------------------------
// Tiny test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.error(`  ✗  FAIL: ${label}`);
    failed++;
  }
}

function assertClose(a, b, tolerance, label) {
  assert(Math.abs(a - b) <= tolerance, `${label} (got ${a.toFixed(4)}, expected ~${b.toFixed(4)}, tol=${tolerance})`);
}

function assertBetween(val, lo, hi, label) {
  assert(val >= lo && val <= hi, `${label} (got ${val.toFixed(4)}, expected [${lo}, ${hi}])`);
}

// ---------------------------------------------------------------------------
// Main verification
// ---------------------------------------------------------------------------

async function verify() {
  console.log('');
  console.log('Polycup — Phase 12 Player xG model verification');
  console.log('='.repeat(56));

  // ---- 1. Build models -----
  console.log('\n[1] Loading Elo and player models ...');
  let elo, pm;
  try {
    elo = await buildEloModel({ log: (m) => process.stdout.write('    ' + m + '\n') });
    pm = await buildPlayerModel({ log: (m) => process.stdout.write('    ' + m + '\n') });
    assert(!!elo, 'Elo model loaded');
    assert(!!pm, 'Player model loaded');
  } catch (e) {
    console.error('  FATAL: could not build models:', e.message);
    process.exit(1);
  }

  // ---- 2. Player coverage ----
  console.log('\n[2] Player coverage ...');
  const totalPlayers = Object.keys(pm.playerStats).length;
  assert(totalPlayers >= 500, `At least 500 players in model (got ${totalPlayers})`);
  assert(totalPlayers <= 5000, `Player count is reasonable (<= 5000, got ${totalPlayers})`);
  assert(pm.populationAvgXg > 0, `Population average xG > 0 (got ${pm.populationAvgXg.toFixed(4)})`);
  assertBetween(pm.populationAvgXg, 0.5, 5.0, 'Population avg team xG/90 in [0.5, 5.0]');

  // ---- 3. Elite player rates ----
  console.log('\n[3] Elite player xG rates ...');
  const elites = [
    { query: 'Kylian Mbapp', team: 'France', minRate: 0.10, label: 'Kylian Mbappé' },
    { query: 'Lionel Messi', team: 'Argentina', minRate: 0.10, label: 'Lionel Messi' },
    { query: 'Harry Kane', team: 'England', minRate: 0.10, label: 'Harry Kane' },
    { query: 'Cristiano Ronaldo', team: 'Portugal', minRate: 0.05, label: 'Cristiano Ronaldo' },
  ];

  for (const { query, team, minRate, label } of elites) {
    const { players } = pm.teamLineup(team);
    const found = players.find((p) => p.name.toLowerCase().startsWith(query.toLowerCase()));
    assert(
      found !== undefined,
      `${label} appears in ${team} lineup`
    );
    if (found) {
      assert(
        found.xgPer90 >= minRate,
        `${label} xG/90 >= ${minRate} (got ${found.xgPer90.toFixed(4)})`
      );
    }
  }

  // ---- 4. Deduplication ----
  console.log('\n[4] Name deduplication (Unicode normalization) ...');
  const { players: argPlayers } = pm.teamLineup('Argentina');
  // "Julián Álvarez" and "Julián Alvarez" should collapse into one entry.
  const alvarezCount = argPlayers.filter((p) =>
    p.name.toLowerCase().replace(/[^a-z ]/g, '').includes('julian alvarez')
  ).length;
  assert(
    alvarezCount <= 1,
    `Julián Álvarez deduplicated (found ${alvarezCount} entries)`
  );

  // ---- 5. Team multipliers ----
  console.log('\n[5] Team multiplier range ...');
  const testTeams = ['Brazil', 'France', 'Argentina', 'England', 'Germany',
                     'Spain', 'Netherlands', 'Portugal', 'USA', 'Japan'];
  for (const team of testTeams) {
    const mul = pm.getTeamMultiplier(team);
    assertBetween(mul.attack,  MIN_TEAM_MULTIPLIER, MAX_TEAM_MULTIPLIER, `${team} attack multiplier in range`);
    assertBetween(mul.defense, MIN_TEAM_MULTIPLIER, MAX_TEAM_MULTIPLIER, `${team} defense multiplier in range`);
  }

  // ---- 6. Prediction output shape ----
  console.log('\n[6] predictMatchPlayerBased output shape ...');
  const pairs = [
    ['Brazil', 'France'],
    ['Argentina', 'England'],
    ['Germany', 'Spain'],
    ['Japan', 'Qatar'],    // weaker team vs strong team
    ['USA', 'Mexico'],     // host nations
  ];

  for (const [teamA, teamB] of pairs) {
    const hostA = HOSTS.has(teamA);
    const hostB = HOSTS.has(teamB);
    const r = pm.predictMatchPlayerBased(
      elo.getRating(teamA),
      elo.getRating(teamB),
      teamA,
      teamB,
      hostA,
      hostB,
      expectedGoals
    );

    const label = `${teamA} vs ${teamB}`;
    assert(typeof r.lambdaA === 'number' && isFinite(r.lambdaA), `${label}: lambdaA is finite`);
    assert(typeof r.lambdaB === 'number' && isFinite(r.lambdaB), `${label}: lambdaB is finite`);
    assertBetween(r.lambdaA, 0.1, 5.0, `${label}: lambdaA in [0.1, 5.0]`);
    assertBetween(r.lambdaB, 0.1, 5.0, `${label}: lambdaB in [0.1, 5.0]`);
    assert(Array.isArray(r.playersA), `${label}: playersA is array`);
    assert(Array.isArray(r.playersB), `${label}: playersB is array`);
    assert(typeof r.baseLambdaA === 'number', `${label}: baseLambdaA present`);
    assert(typeof r.baseLambdaB === 'number', `${label}: baseLambdaB present`);
    assert(typeof r.mulA === 'object', `${label}: mulA present`);
    assert(typeof r.mulB === 'object', `${label}: mulB present`);

    // Player-adjusted lambdas should differ from base (model is doing something).
    const diffA = Math.abs(r.lambdaA - r.baseLambdaA);
    const diffB = Math.abs(r.lambdaB - r.baseLambdaB);
    // Allow 0 difference only if PLAYER_BLEND is 0 or both multipliers are 1.
    if (PLAYER_BLEND > 0) {
      // At least one side should have a non-zero adjustment for most matches.
      assert(
        diffA > 0 || diffB > 0,
        `${label}: player model adjusts at least one lambda`
      );
    }
  }

  // ---- 7. Known-result sanity checks ----
  console.log('\n[7] Known-result sanity checks ...');

  // France should have higher adjusted lambda than base when facing a much weaker team
  // (their star-studded attack should push xG up).
  const fraVsHaiti = pm.predictMatchPlayerBased(
    elo.getRating('France'),
    elo.getRating('Haiti'),
    'France', 'Haiti', false, false, expectedGoals
  );
  assert(
    fraVsHaiti.lambdaA >= fraVsHaiti.baseLambdaA - 0.05,
    'France adj lambda ≥ base lambda vs Haiti (strong attack boosts them)'
  );

  // Both lambdas should sum to approximately TOTAL_EXPECTED_GOALS (2.5) ± player adjustment.
  // Total will drift but should stay within a reasonable range.
  const totalAdj = fraVsHaiti.lambdaA + fraVsHaiti.lambdaB;
  assertBetween(totalAdj, 1.0, 8.0, 'France vs Haiti total expected goals in [1.0, 8.0]');

  // Argentina vs England — Argentina is higher Elo, should have higher lambdaA.
  const argVsEng = pm.predictMatchPlayerBased(
    elo.getRating('Argentina'),
    elo.getRating('England'),
    'Argentina', 'England', false, false, expectedGoals
  );
  assert(argVsEng.lambdaA > argVsEng.lambdaB, 'Argentina lambdaA > England lambdaB (higher Elo + strong attack)');

  // ---- 8. Blend constant ----
  console.log('\n[8] PLAYER_BLEND constant ...');
  assertBetween(PLAYER_BLEND, 0.1, 0.6, `PLAYER_BLEND (${PLAYER_BLEND}) is in a sensible range [0.1, 0.6]`);

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log('');
  console.log('='.repeat(56));
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log('  All checks passed. Player xG model is working correctly.');
  } else {
    console.log(`  ${failed} check(s) failed — see above for details.`);
  }
  console.log('');

  process.exit(failed > 0 ? 1 : 0);
}

verify().catch((e) => {
  console.error('Unexpected error:', e);
  process.exit(1);
});
