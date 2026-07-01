'use strict';

/**
 * verify-penalty.js
 *
 * Deterministic sanity checks for the Phase 10 penalty shootout model.
 *
 * Runs 38 assertions covering:
 *   - model construction and data loading
 *   - output shape and probability bounds
 *   - favorite vs. underdog probability ordering
 *   - host-nation bonus
 *   - first-shooter edge
 *   - graceful degradation for missing data
 *   - deterministic reproducibility
 *   - taker and factor helpers
 *
 * Zero third-party dependencies.
 */

const fs = require('fs');
const { buildPenaltyModel } = require('./penalty');
const { TEAMS } = require('./worldcup2026');

const CHECK = '✓';
const CROSS = '✗';
let passed = 0;
let failed = 0;

function assert(name, condition, details = '') {
  if (condition) {
    passed++;
    console.log(`  ${CHECK} ${name}${details ? ' (' + details + ')' : ''}`);
  } else {
    failed++;
    console.log(`  ${CROSS} ${name}${details ? ' (' + details + ')' : ''}`);
  }
}

function assertInRange(name, value, [min, max]) {
  const ok = value >= min && value <= max;
  assert(name, ok, `got ${value.toFixed(4)}, expected [${min}, ${max}]`);
  return ok;
}

function assertApprox(name, value, expected, tol = 0.001) {
  const ok = Math.abs(value - expected) <= tol;
  assert(name, ok, `got ${value.toFixed(4)}, expected ${expected.toFixed(4)}`);
  return ok;
}

function makeMockElo(ratings) {
  return {
    getRating: (team) => (ratings && ratings[team] !== undefined ? ratings[team] : 1000),
  };
}

(async () => {
  console.log('Penalty shootout model verification');
  console.log('=' .repeat(58));

  // ---------------------------------------------------------------------------
  // [1] Model construction
  // ---------------------------------------------------------------------------
  console.log('\n[1] Model construction');
  let penaltyModel;
  try {
    const elo = makeMockElo({});
    penaltyModel = await buildPenaltyModel({ elo, log: () => {} });
    assert('buildPenaltyModel resolves', true);
    assert('predictPenaltyShootout is a function', typeof penaltyModel.predictPenaltyShootout === 'function');
    assert('getFactors is a function', typeof penaltyModel.getFactors === 'function');
    assert('getTakers is a function', typeof penaltyModel.getTakers === 'function');
  } catch (e) {
    console.log(`  ${CROSS} Could not build penalty model: ${e.message}`);
    failed += 4;
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // [2] Output shape and probability bounds
  // ---------------------------------------------------------------------------
  console.log('\n[2] Output shape and bounds');
  const result = penaltyModel.predictPenaltyShootout('Brazil', 'France');
  assert('returns pA', typeof result.pA === 'number' && !Number.isNaN(result.pA));
  assert('returns pB', typeof result.pB === 'number' && !Number.isNaN(result.pB));
  assert('returns factorsA', result.factorsA && typeof result.factorsA === 'object');
  assert('returns factorsB', result.factorsB && typeof result.factorsB === 'object');
  assertInRange('pA in [0, 1]', result.pA, [0, 1]);
  assertInRange('pB in [0, 1]', result.pB, [0, 1]);
  assertApprox('pA + pB ≈ 1', result.pA + result.pB, 1.0, 0.0001);

  // ---------------------------------------------------------------------------
  // [3] Determinism
  // ---------------------------------------------------------------------------
  console.log('\n[3] Determinism');
  const r1 = penaltyModel.predictPenaltyShootout('Argentina', 'Germany');
  const r2 = penaltyModel.predictPenaltyShootout('Argentina', 'Germany');
  assert('same inputs produce same pA', r1.pA === r2.pA, `pA=${r1.pA}`);
  assert('same inputs produce same pB', r1.pB === r2.pB, `pB=${r1.pB}`);

  // ---------------------------------------------------------------------------
  // [4] Elo ordering: a stronger team is favored in a shootout
  // ---------------------------------------------------------------------------
  console.log('\n[4] Elo-based ordering');
  // Use real 2026 teams but supply a very large Elo gap so the Elo component is
  // the dominant signal. History and taker factors still apply to real teams,
  // but the Elo gap should push Brazil well ahead.
  const elo = makeMockElo({
    Brazil: 1900,
    Haiti: 600,
  });
  const eloModel = await buildPenaltyModel({ elo, log: () => {} });
  const eloResult = eloModel.predictPenaltyShootout('Brazil', 'Haiti');
  assert('stronger team has higher shootout probability', eloResult.pA > 0.55, `pA=${eloResult.pA.toFixed(3)}`);
  assertInRange('strong-team probability is not extreme', eloResult.pA, [0.55, 0.95]);

  // ---------------------------------------------------------------------------
  // [5] Host-nation bonus
  // ---------------------------------------------------------------------------
  console.log('\n[5] Host-nation bonus');
  const hostElo = makeMockElo({});
  const hostModel = await buildPenaltyModel({ elo: hostElo, log: () => {} });
  const neutral = hostModel.predictPenaltyShootout('USA', 'Mexico');
  const withHost = hostModel.predictPenaltyShootout('USA', 'Mexico', { hostA: true });
  assert('hostA option increases USA probability', withHost.pA > neutral.pA, `neutral=${neutral.pA.toFixed(4)}, host=${withHost.pA.toFixed(4)}`);

  // ---------------------------------------------------------------------------
  // [6] First-shooter edge
  // ---------------------------------------------------------------------------
  console.log('\n[6] First-shooter edge');
  const firstA = hostModel.predictPenaltyShootout('USA', 'Mexico', { firstShooter: 'teamA' });
  const firstB = hostModel.predictPenaltyShootout('USA', 'Mexico', { firstShooter: 'teamB' });
  assert('first shooter A > first shooter B', firstA.pA > firstB.pA, `A-first=${firstA.pA.toFixed(4)}, B-first=${firstB.pA.toFixed(4)}`);

  // ---------------------------------------------------------------------------
  // [7] Graceful degradation for unknown / equal teams
  // ---------------------------------------------------------------------------
  console.log('\n[7] Graceful degradation');
  const unknown = hostModel.predictPenaltyShootout('Atlantis', 'Neverland');
  assertInRange('unknown teams produce a valid probability', unknown.pA, [0.05, 0.95]);
  assertApprox('unknown teams default to near 50/50', unknown.pA, 0.5, 0.05);
  assert('factor keys present for known teams', Object.keys(result.factorsA).includes('eloAdvantage'));
  assert('factor keys present for known teams', Object.keys(result.factorsA).includes('takerQuality'));
  assert('factor keys present for known teams', Object.keys(result.factorsA).includes('historyAdvantage'));

  // ---------------------------------------------------------------------------
  // [8] Taker helpers
  // ---------------------------------------------------------------------------
  console.log('\n[8] Taker helpers');
  const takers = penaltyModel.getTakers('Brazil', 5);
  assert('getTakers returns an array', Array.isArray(takers));
  assert('takers are FWD or MID', takers.every((p) => p.position === 'FWD' || p.position === 'MID'), `got ${takers.map((p) => p.position).join(',')}`);
  assert('takers capped at requested count', takers.length <= 5, `length=${takers.length}`);

  // ---------------------------------------------------------------------------
  // [9] Real 2026 teams: ordering sanity checks
  // ---------------------------------------------------------------------------
  console.log('\n[9] Real 2026 team ordering sanity checks');
  const realElo = makeMockElo({});
  const realModel = await buildPenaltyModel({ elo: realElo, log: () => {} });
  const argGer = realModel.predictPenaltyShootout('Argentina', 'Germany');
  const gerArg = realModel.predictPenaltyShootout('Germany', 'Argentina');
  assert('symmetry: pA(A,B) = pB(B,A)', argGer.pA === gerArg.pB, `AB=${argGer.pA.toFixed(4)}, BA=${gerArg.pB.toFixed(4)}`);
  assert('self-match is rejected', (() => {
    try {
      realModel.predictPenaltyShootout('Brazil', 'Brazil');
      return false;
    } catch (e) {
      return true;
    }
  })());
  assert('missing teams are rejected', (() => {
    try {
      realModel.predictPenaltyShootout(null, 'Brazil');
      return false;
    } catch (e) {
      return true;
    }
  })());

  // ---------------------------------------------------------------------------
  // [10] Integration with simulation.js knockoutWinner fallback
  // ---------------------------------------------------------------------------
  console.log('\n[10] Integration with simulation.js');
  const { knockoutWinner } = require('./simulation');
  // Mock penalty models that always return a lopsided shootout probability for A.
  const highModel = {
    predictPenaltyShootout: () => ({ pA: 0.9, pB: 0.1, factorsA: {}, factorsB: {} }),
  };
  const lowModel = {
    predictPenaltyShootout: () => ({ pA: 0.1, pB: 0.9, factorsA: {}, factorsB: {} }),
  };
  let highWinsA = 0;
  let lowWinsA = 0;
  const trials = 2000;
  for (let i = 0; i < trials; i++) {
    if (knockoutWinner(1000, 1000, false, false, -0.04, 'Brazil', 'France', highModel) === 0) highWinsA++;
    if (knockoutWinner(1000, 1000, false, false, -0.04, 'Brazil', 'France', lowModel) === 0) lowWinsA++;
  }
  assert('knockoutWinner respects high penalty probability', highWinsA > lowWinsA, `high=${highWinsA}, low=${lowWinsA}`);
  assert('high shootout probability increases overall A wins', highWinsA / trials > 0.5, `rate=${(highWinsA / trials).toFixed(3)}`);

  // ---------------------------------------------------------------------------
  // [11] Cache file created
  // ---------------------------------------------------------------------------
  console.log('\n[11] Cache behavior');
  const { SHOOTOUTS_CACHE } = require('./penalty');
  assert('shootouts cache file exists', fs.existsSync(SHOOTOUTS_CACHE), `path=${SHOOTOUTS_CACHE}`);

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log('\n' + '='.repeat(58));
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log('  All checks passed. Penalty shootout model is working correctly.');
  } else {
    console.log('  Some checks failed.');
    process.exit(1);
  }
})();
