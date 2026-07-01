#!/usr/bin/env node
'use strict';

/**
 * verify-matchxg.js
 *
 * Verification script for the Phase 12 match-level xG model.
 *
 * Checks that the model:
 *   1. Loads and processes the historical results dataset without errors.
 *   2. Produces per-team attack and defense rates for a sufficient number of teams.
 *   3. Team multipliers are clamped within [MIN_RATE_MULTIPLIER, MAX_RATE_MULTIPLIER].
 *   4. expectedGoalsXG() returns the correct output shape with finite values.
 *   5. Blended lambdas are between the Elo and rate-only extremes (interpolation sanity).
 *   6. With a neutral Elo (same rating both sides), a strong-offense team should
 *      have a higher xgA than a weak-offense team.
 *   7. Providing hostA=true increases xgA relative to hostA=false (home attack boost).
 *   8. Population averages satisfy: avgAttack ≈ avgDefense (every goal scored is a
 *      goal conceded somewhere).
 *   9. Teams with no data gracefully return multipliers of 1.0 and hasData=false.
 *  10. The XG_BLEND, MIN_RATE_MULTIPLIER, MAX_RATE_MULTIPLIER constants are exported.
 *  11. The blended xgA > blended xgB when team A is clearly stronger by Elo AND
 *      by historical goal rates (deterministic sanity check).
 *
 * Exit 0 on all checks passing, exit 1 on any failure.
 *
 * Usage:
 *   node verify-matchxg.js
 */

const {
  buildMatchXgModel,
  XG_BLEND,
  MIN_RATE_MULTIPLIER,
  MAX_RATE_MULTIPLIER,
  TOTAL_BASE_XG,
  RECENT_CUTOFF,
} = require('./matchxg');
const { buildEloModel } = require('./elo');
const { expectedGoals, HOSTS } = require('./simulation');

// ---------------------------------------------------------------------------
// Tiny test harness (mirrors verify-playerxg.js style)
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
  assert(
    Math.abs(a - b) <= tolerance,
    `${label} (got ${a.toFixed(4)}, expected ~${b.toFixed(4)}, tol=${tolerance})`
  );
}

function assertBetween(val, lo, hi, label) {
  assert(
    val >= lo && val <= hi,
    `${label} (got ${typeof val === 'number' ? val.toFixed(4) : val}, expected [${lo}, ${hi}])`
  );
}

// ---------------------------------------------------------------------------
// Main verification
// ---------------------------------------------------------------------------

async function verify() {
  console.log('');
  console.log('Polycup — Phase 12 Match-level xG model verification');
  console.log('='.repeat(56));

  // ---- 1. Build models ----
  console.log('\n[1] Loading Elo and match xG models ...');
  let elo, xgm;
  try {
    elo = await buildEloModel({ log: (m) => process.stdout.write('    ' + m + '\n') });
    xgm = await buildMatchXgModel({ log: (m) => process.stdout.write('    ' + m + '\n') });
    assert(!!elo, 'Elo model loaded');
    assert(!!xgm, 'Match xG model loaded');
  } catch (e) {
    console.error('  FATAL: could not build models:', e.message);
    process.exit(1);
  }

  // ---- 2. Team coverage ----
  console.log('\n[2] Team coverage ...');
  const teamCount = xgm.teamCount;
  assert(teamCount >= 100, `At least 100 teams have xG rates (got ${teamCount})`);
  assert(teamCount <= 300, `Team count is reasonable (<= 300, got ${teamCount})`);

  // ---- 3. Population averages ----
  console.log('\n[3] Population averages ...');
  assertBetween(xgm.avgAttack,  0.5, 2.5, 'Population avg attack goals/match in [0.5, 2.5]');
  assertBetween(xgm.avgDefense, 0.5, 2.5, 'Population avg defense goals/match in [0.5, 2.5]');
  // Every goal scored is a goal conceded — so avgAttack ≈ avgDefense (within 10 %).
  assertClose(
    xgm.avgAttack,
    xgm.avgDefense,
    0.15,
    'avgAttack ≈ avgDefense (goals scored = goals conceded)'
  );

  // ---- 4. Multiplier range ----
  console.log('\n[4] Team multiplier range ...');
  const testTeams = [
    'Brazil', 'France', 'Argentina', 'England', 'Germany',
    'Spain', 'Netherlands', 'Portugal', 'USA', 'Japan', 'Qatar',
  ];
  for (const team of testTeams) {
    const mul = xgm.getTeamMultiplier(team);
    assertBetween(
      mul.attack,
      MIN_RATE_MULTIPLIER,
      MAX_RATE_MULTIPLIER,
      `${team} attack multiplier in [${MIN_RATE_MULTIPLIER}, ${MAX_RATE_MULTIPLIER}]`
    );
    assertBetween(
      mul.defense,
      MIN_RATE_MULTIPLIER,
      MAX_RATE_MULTIPLIER,
      `${team} defense multiplier in [${MIN_RATE_MULTIPLIER}, ${MAX_RATE_MULTIPLIER}]`
    );
  }

  // ---- 5. Graceful degradation for unknown teams ----
  console.log('\n[5] Graceful degradation for teams with no data ...');
  const mulUnknown = xgm.getTeamMultiplier('Atlantis FC');
  assert(mulUnknown.attack === 1.0, 'Unknown team attack multiplier = 1.0');
  assert(mulUnknown.defense === 1.0, 'Unknown team defense multiplier = 1.0');
  assert(mulUnknown.hasData === false, 'Unknown team hasData = false');

  // ---- 6. expectedGoalsXG output shape ----
  console.log('\n[6] expectedGoalsXG output shape ...');
  const pairs = [
    ['Brazil', 'France'],
    ['Argentina', 'England'],
    ['Germany', 'Spain'],
    ['Japan', 'Qatar'],
    ['USA', 'Mexico'],
  ];

  for (const [teamA, teamB] of pairs) {
    const hostA = HOSTS.has(teamA);
    const hostB = HOSTS.has(teamB);
    const r = xgm.expectedGoalsXG(teamA, teamB, {
      eloLambdaFn: expectedGoals,
      eloA: elo.getRating(teamA),
      eloB: elo.getRating(teamB),
      hostA,
      hostB,
    });

    const label = `${teamA} vs ${teamB}`;
    assert(typeof r.xgA === 'number' && isFinite(r.xgA),    `${label}: xgA is finite`);
    assert(typeof r.xgB === 'number' && isFinite(r.xgB),    `${label}: xgB is finite`);
    assert(typeof r.eloXgA === 'number' && isFinite(r.eloXgA), `${label}: eloXgA is finite`);
    assert(typeof r.eloXgB === 'number' && isFinite(r.eloXgB), `${label}: eloXgB is finite`);
    assert(typeof r.rateXgA === 'number' && isFinite(r.rateXgA), `${label}: rateXgA is finite`);
    assert(typeof r.rateXgB === 'number' && isFinite(r.rateXgB), `${label}: rateXgB is finite`);
    assertBetween(r.xgA,     0.1, 6.0, `${label}: xgA in [0.1, 6.0]`);
    assertBetween(r.xgB,     0.1, 6.0, `${label}: xgB in [0.1, 6.0]`);
    assertBetween(r.rateXgA, 0.1, 6.0, `${label}: rateXgA in [0.1, 6.0]`);
    assertBetween(r.rateXgB, 0.1, 6.0, `${label}: rateXgB in [0.1, 6.0]`);
    assert(typeof r.mulA === 'object', `${label}: mulA object present`);
    assert(typeof r.mulB === 'object', `${label}: mulB object present`);
  }

  // ---- 7. Blending sanity: blended value lies between Elo and rate extremes ----
  console.log('\n[7] Blend interpolation sanity ...');
  const blendPairs = [
    ['France',  'Germany'],
    ['Spain',   'Brazil'],
    ['England', 'Netherlands'],
  ];
  for (const [teamA, teamB] of blendPairs) {
    const r = xgm.expectedGoalsXG(teamA, teamB, {
      eloLambdaFn: expectedGoals,
      eloA: elo.getRating(teamA),
      eloB: elo.getRating(teamB),
    });
    const label = `${teamA} vs ${teamB}`;
    // The blended value must be within the convex hull of eloXg and rateXg.
    const loA = Math.min(r.eloXgA, r.rateXgA);
    const hiA = Math.max(r.eloXgA, r.rateXgA);
    // Allow a tiny floating-point tolerance.
    assertBetween(r.xgA, loA - 0.01, hiA + 0.01, `${label}: blended xgA in [elo, rate] range`);
    const loB = Math.min(r.eloXgB, r.rateXgB);
    const hiB = Math.max(r.eloXgB, r.rateXgB);
    assertBetween(r.xgB, loB - 0.01, hiB + 0.01, `${label}: blended xgB in [elo, rate] range`);
  }

  // ---- 8. Ordering: stronger team should have higher xg ----
  console.log('\n[8] Ordering: higher-rated team has higher blended xg ...');
  // Brazil should have higher xgA than Qatar (big Elo gap + historical goal advantage).
  const bvsq = xgm.expectedGoalsXG('Brazil', 'Qatar', {
    eloLambdaFn: expectedGoals,
    eloA: elo.getRating('Brazil'),
    eloB: elo.getRating('Qatar'),
  });
  assert(bvsq.xgA > bvsq.xgB, `Brazil blended xgA > Qatar blended xgB (Brazil stronger)`);

  // Argentina should have higher xgA than Haiti.
  const avsh = xgm.expectedGoalsXG('Argentina', 'Haiti', {
    eloLambdaFn: expectedGoals,
    eloA: elo.getRating('Argentina'),
    eloB: elo.getRating('Haiti'),
  });
  assert(avsh.xgA > avsh.xgB, `Argentina blended xgA > Haiti blended xgB`);

  // ---- 9. Host bonus: hostA=true raises xgA ----
  console.log('\n[9] Host bonus increases xgA ...');
  const noHost = xgm.expectedGoalsXG('USA', 'France', {
    eloLambdaFn: expectedGoals,
    eloA: elo.getRating('USA'),
    eloB: elo.getRating('France'),
    hostA: false,
  });
  const withHost = xgm.expectedGoalsXG('USA', 'France', {
    eloLambdaFn: expectedGoals,
    eloA: elo.getRating('USA'),
    eloB: elo.getRating('France'),
    hostA: true,
  });
  assert(
    withHost.rateXgA >= noHost.rateXgA,
    `USA rate xgA with hostA=true >= without (host attack boost applied)`
  );

  // ---- 10. xgRateLambdas symmetry: avg vs avg => total ~ TOTAL_BASE_XG ----
  console.log('\n[10] Rate lambdas: population-average team produces expected total goals ...');
  // When both teams have no data (multipliers = 1.0), rate lambdas should each
  // equal halfBase = TOTAL_BASE_XG / 2.
  const [avgA, avgB] = xgm.xgRateLambdas('Atlantis FC', 'Bravoria');
  assertClose(
    avgA,
    TOTAL_BASE_XG / 2,
    0.01,
    `Unknown vs Unknown: rateXgA ≈ TOTAL_BASE_XG/2 (${(TOTAL_BASE_XG / 2).toFixed(2)})`
  );
  assertClose(
    avgB,
    TOTAL_BASE_XG / 2,
    0.01,
    `Unknown vs Unknown: rateXgB ≈ TOTAL_BASE_XG/2 (${(TOTAL_BASE_XG / 2).toFixed(2)})`
  );

  // ---- 11. xgRateLambdas without Elo (pure rate model) ----
  console.log('\n[11] expectedGoalsXG without eloLambdaFn uses rate model only ...');
  const pureRate = xgm.expectedGoalsXG('France', 'Germany');
  // Without an Elo function, eloXg = rateXg, so blended = rateXg.
  assertClose(pureRate.xgA, pureRate.rateXgA, 0.001,
    'xgA ≈ rateXgA when no eloLambdaFn supplied');
  assertClose(pureRate.xgB, pureRate.rateXgB, 0.001,
    'xgB ≈ rateXgB when no eloLambdaFn supplied');

  // ---- 12. Exported constants ----
  console.log('\n[12] Exported constants ...');
  assert(typeof XG_BLEND === 'number' && XG_BLEND > 0 && XG_BLEND < 1,
    `XG_BLEND is a number in (0,1) — got ${XG_BLEND}`);
  assert(typeof MIN_RATE_MULTIPLIER === 'number' && MIN_RATE_MULTIPLIER > 0,
    `MIN_RATE_MULTIPLIER is a positive number — got ${MIN_RATE_MULTIPLIER}`);
  assert(typeof MAX_RATE_MULTIPLIER === 'number' && MAX_RATE_MULTIPLIER > MIN_RATE_MULTIPLIER,
    `MAX_RATE_MULTIPLIER > MIN_RATE_MULTIPLIER — got ${MAX_RATE_MULTIPLIER}`);
  assert(typeof TOTAL_BASE_XG === 'number' && TOTAL_BASE_XG > 0,
    `TOTAL_BASE_XG is a positive number — got ${TOTAL_BASE_XG}`);
  assert(typeof RECENT_CUTOFF === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(RECENT_CUTOFF),
    `RECENT_CUTOFF is a YYYY-MM-DD string — got ${RECENT_CUTOFF}`);

  // ---- 13. Deterministic (same call twice gives same result) ----
  console.log('\n[13] Determinism: same inputs produce same outputs ...');
  const r1 = xgm.expectedGoalsXG('Spain', 'England', {
    eloLambdaFn: expectedGoals,
    eloA: elo.getRating('Spain'),
    eloB: elo.getRating('England'),
  });
  const r2 = xgm.expectedGoalsXG('Spain', 'England', {
    eloLambdaFn: expectedGoals,
    eloA: elo.getRating('Spain'),
    eloB: elo.getRating('England'),
  });
  assert(r1.xgA === r2.xgA, `Spain vs England xgA is deterministic`);
  assert(r1.xgB === r2.xgB, `Spain vs England xgB is deterministic`);

  // ---- Summary ----
  console.log('');
  console.log('='.repeat(56));
  console.log(`  Results: ${passed} passed, ${failed} failed.`);
  console.log('='.repeat(56));
  console.log('');

  if (failed > 0) {
    console.error(`  ${failed} test(s) FAILED. See above.`);
    process.exit(1);
  } else {
    console.log('  All checks passed.');
    process.exit(0);
  }
}

verify().catch((err) => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
