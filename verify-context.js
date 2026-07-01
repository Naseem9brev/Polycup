#!/usr/bin/env node
'use strict';

/**
 * verify-context.js
 *
 * Verification script for Phase 14 — match context adjustments.
 *
 * Deterministic checks that the context module:
 *   1. Resolves venues and aliases correctly.
 *   2. Computes haversine distances accurately.
 *   3. Looks up team bases and applies altitude acclimation.
 *   4. Calculates rest-day penalties from fixtures.
 *   5. Applies travel, timezone, host-venue, and climate adjustments.
 *   6. Returns bounded total adjustments.
 *   7. Changes expectedGoals/predictMatch output when context is applied.
 *   8. Loads 2026 FIFA World Cup fixtures and finds specific fixtures.
 *   9. Produces deterministic results for identical inputs.
 *
 * Exit 0 on all checks passing, exit 1 on any failure.
 *
 * Usage:
 *   node verify-context.js
 */

const {
  VENUES,
  resolveVenue,
  getTeamBase,
  haversineKm,
  contextAdjustments,
  contextAdjustmentForTeam,
  loadFixtures,
  findFixture,
  parseDate,
  daysBetween,
  HOSTS,
} = require('./context');
const { expectedGoals, predictMatch } = require('./simulation');

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

function assertNotEqual(a, b, label) {
  assert(a !== b, `${label} (got ${a}, ${b})`);
}

// ---------------------------------------------------------------------------
// Main verification
// ---------------------------------------------------------------------------

function verify() {
  console.log('');
  console.log('Polycup — Phase 14 context-adjustment verification');
  console.log('='.repeat(56));

  // ---- 1. Venue resolution ----
  console.log('\n[1] Venue resolution ...');
  assert(!!resolveVenue('Mexico City'), 'Resolves Mexico City');
  assert(!!resolveVenue('mexico city'), 'Resolves lower-case Mexico City');
  assert(!!resolveVenue('Estadio Azteca'), 'Resolves stadium alias Estadio Azteca');
  assert(!!resolveVenue('Inglewood'), 'Resolves suburban venue Inglewood');
  assert(resolveVenue('Mexico City').alt === 2240, 'Mexico City altitude is 2240 m');
  assert(resolveVenue('Atlanta').country === 'USA', 'Atlanta is in USA');
  assert(!resolveVenue('Narnia'), 'Unknown venue returns null');

  // ---- 2. Haversine distance ----
  console.log('\n[2] Haversine distance ...');
  // Mexico City to Johannesburg (South Africa base) ~ 14,600 km
  const mexicoCity = VENUES['Mexico City'];
  const johannesburg = getTeamBase('South Africa');
  assertClose(haversineKm(mexicoCity.lat, mexicoCity.lon, johannesburg.lat, johannesburg.lon), 14600, 500, 'Mexico City to Johannesburg distance');
  // Same point -> 0 km
  assertClose(haversineKm(0, 0, 0, 0), 0, 0.001, 'Same point distance is zero');
  // Known distance: New York to London ~ 5570 km
  assertClose(haversineKm(40.7128, -74.0060, 51.5074, -0.1278), 5570, 100, 'New York to London distance');

  // ---- 3. Team bases ----
  console.log('\n[3] Team bases ...');
  assert(!!getTeamBase('Mexico'), 'Mexico has a base');
  assert(!!getTeamBase('USA'), 'USA has a base');
  assert(getTeamBase('Ecuador').alt >= 2500, 'Ecuador base is high-altitude');
  assert(getTeamBase('Mexico').alt >= 2000, 'Mexico base is high-altitude');
  assert(HOSTS.has('USA') && HOSTS.has('Canada') && HOSTS.has('Mexico'), 'Host nations set correctly');

  // ---- 4. Date utilities ----
  console.log('\n[4] Date utilities ...');
  const d1 = parseDate('2026-06-11');
  const d2 = parseDate('2026-06-15');
  assert(!!d1 && !!d2, 'Parses YYYY-MM-DD dates');
  assert(daysBetween(d1, d2) === 4, 'Four days between 2026-06-11 and 2026-06-15');
  assert(daysBetween(d2, d1) === -4, 'Negative days in reverse');

  // ---- 5. Rest-day adjustment ----
  console.log('\n[5] Rest-day adjustment ...');
  const fixtures = [
    { date: '2026-06-11', home: 'Mexico', away: 'South Africa' },
    { date: '2026-06-15', home: 'Mexico', away: 'Brazil' },
  ];
  const restA = contextAdjustmentForTeam('Mexico', 'Mexico City', '2026-06-15', fixtures);
  assertClose(restA.factors.rest, -8, 1, 'Mexico gets -8 rest penalty for 4-day turnaround');
  const restB = contextAdjustmentForTeam('Mexico', 'Mexico City', '2026-06-22', fixtures);
  assertClose(restB.factors.rest, 0, 1, 'Mexico gets 0 rest penalty after 6+ days');
  const restC = contextAdjustmentForTeam('Mexico', 'Mexico City', '2026-06-12', fixtures);
  assertClose(restC.factors.rest, -35, 1, 'Mexico gets -35 rest penalty for 1-day turnaround');
  const restNoFixture = contextAdjustmentForTeam('Mexico', 'Mexico City', '2026-06-15', []);
  assertClose(restNoFixture.factors.rest, 0, 0, 'No fixtures means no rest penalty');

  // ---- 6. Altitude adjustment ----
  console.log('\n[6] Altitude adjustment ...');
  const mexCity = resolveVenue('Mexico City');
  const miami = resolveVenue('Miami'); // sea-level-ish venue for contrast
  const ecuador = contextAdjustmentForTeam('Ecuador', mexCity, '2026-06-11', []);
  const netherlands = contextAdjustmentForTeam('Netherlands', mexCity, '2026-06-11', []);
  assert(ecuador.factors.altitude >= 0, 'Ecuador (acclimated) gets altitude bonus or zero at Mexico City');
  assert(netherlands.factors.altitude < 0, 'Netherlands (sea-level) gets altitude penalty at Mexico City');
  const ecuadorMiami = contextAdjustmentForTeam('Ecuador', miami, '2026-06-11', []);
  assertClose(ecuadorMiami.factors.altitude, 0, 0, 'No altitude effect at low-altitude venue');

  // ---- 7. Host-venue adjustment ----
  console.log('\n[7] Host-venue adjustment ...');
  const mexInMexico = contextAdjustmentForTeam('Mexico', mexCity, '2026-06-11', []);
  const usaInMexico = contextAdjustmentForTeam('USA', mexCity, '2026-06-11', []);
  const fraInMexico = contextAdjustmentForTeam('France', mexCity, '2026-06-11', []);
  assert(mexInMexico.factors.hostVenue > 0, 'Mexico gets host-venue bonus in Mexico City');
  assert(usaInMexico.factors.hostVenue > 0, 'USA gets small host-venue bonus in co-host Mexico');
  assert(fraInMexico.factors.hostVenue === 0, 'France does not get host-venue bonus in Mexico City');

  // ---- 8. Travel and timezone adjustments ----
  console.log('\n[8] Travel and timezone adjustments ...');
  const saInMexico = contextAdjustmentForTeam('South Africa', mexCity, '2026-06-11', []);
  assert(saInMexico.factors.travel < 0, 'South Africa pays travel penalty to Mexico City');
  assert(saInMexico.factors.timezone < 0, 'South Africa pays timezone penalty to Mexico City');
  assert(saInMexico.distanceKm > 10000, 'South Africa travel distance > 10,000 km');

  // ---- 9. Full context adjustment for a known fixture ----
  console.log('\n[9] Full context adjustment for Mexico vs South Africa ...');
  const allFixtures = loadFixtures();
  assert(Array.isArray(allFixtures) && allFixtures.length >= 72, `Loads at least 72 2026 fixtures (got ${allFixtures.length})`);
  const fixture = findFixture(allFixtures, 'Mexico', 'South Africa');
  assert(!!fixture, 'Finds Mexico vs South Africa fixture');
  assert(fixture.venue === 'Mexico City', 'Mexico vs South Africa is in Mexico City');
  const matchCtx = contextAdjustments('Mexico', 'South Africa', fixture.venue, fixture.date, allFixtures);
  assert(matchCtx.homeAdj > 0, 'Mexico total adjustment is positive at home');
  assert(matchCtx.awayAdj < 0, 'South Africa total adjustment is negative away');
  assertBetween(matchCtx.homeAdj, -80, 80, 'Mexico adjustment bounded');
  assertBetween(matchCtx.awayAdj, -80, 80, 'South Africa adjustment bounded');

  // ---- 10. expectedGoals changes with context ----
  console.log('\n[10] expectedGoals and predictMatch respond to context ...');
  const eloA = 1700;
  const eloB = 1600;
  const baseXg = expectedGoals(eloA, eloB, false, false, false);
  const ctxXg = expectedGoals(eloA, eloB, false, false, false, { homeAdj: 50, awayAdj: -30 });
  assertNotEqual(baseXg[0], ctxXg[0], 'Home xG changes with context');
  assertNotEqual(baseXg[1], ctxXg[1], 'Away xG changes with context');
  assert(ctxXg[0] > baseXg[0], 'Positive home adjustment increases home xG');
  assert(ctxXg[1] < baseXg[1], 'Negative away adjustment decreases away xG');

  const basePred = predictMatch(eloA, eloB, false, false, -0.1);
  const ctxPred = predictMatch(eloA, eloB, false, false, -0.1, { homeAdj: 50, awayAdj: -30 });
  assertNotEqual(basePred.pWin, ctxPred.pWin, 'predictMatch win probability changes with context');
  assert(ctxPred.pWin > basePred.pWin, 'Home win probability increases with positive home context');

  // ---- 11. Determinism ----
  console.log('\n[11] Determinism ...');
  const ctx1 = contextAdjustments('Mexico', 'South Africa', 'Mexico City', '2026-06-11', allFixtures);
  const ctx2 = contextAdjustments('Mexico', 'South Africa', 'Mexico City', '2026-06-11', allFixtures);
  assert(ctx1.homeAdj === ctx2.homeAdj && ctx1.awayAdj === ctx2.awayAdj, 'Identical inputs produce identical adjustments');
  const pred1 = predictMatch(1700, 1600, false, false, -0.1, { homeAdj: 25, awayAdj: -15 });
  const pred2 = predictMatch(1700, 1600, false, false, -0.1, { homeAdj: 25, awayAdj: -15 });
  assert(pred1.pWin === pred2.pWin && pred1.pDraw === pred2.pDraw, 'predictMatch is deterministic with context');

  // ---- 12. Boundaries and graceful degradation ----
  console.log('\n[12] Boundaries and graceful degradation ...');
  const huge = contextAdjustments('Mexico', 'South Africa', 'Mexico City', '2026-06-11', allFixtures.concat([
    { date: '2026-06-10', home: 'Mexico', away: 'Unknown' },
  ]));
  assertBetween(huge.homeAdj, -80, 80, 'Total adjustment capped below 80 Elo points');
  const noVenue = contextAdjustments('Mexico', 'South Africa', 'Narnia', '2026-06-11', allFixtures);
  assert(noVenue.homeAdj === 0 && noVenue.awayAdj === 0, 'Unknown venue returns zero adjustments');

  // ---- Summary ----
  console.log('\n' + '='.repeat(56));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
  console.log('All context-adjustment checks passed.');
}

try {
  verify();
} catch (err) {
  console.error('Unexpected error:', err);
  process.exit(1);
}
