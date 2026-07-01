#!/usr/bin/env node
'use strict';

/**
 * verify-lineupelo.js
 *
 * Verification / smoke-test script for Phase 8: Lineup-aware Elo adjustments.
 *
 * Runs a series of deterministic unit-style checks against players.js and
 * lineupelo.js, then runs an end-to-end integration check using the Elo model
 * and predictMatch().  All tests run locally with no network calls.
 *
 * Usage:
 *   node verify-lineupelo.js
 *
 * Exit code 0 = all tests passed.  Exit code 1 = one or more failures.
 */

const {
  lookupPlayer,
  getTopPlayers,
  getTeamPlayers,
  PLAYER_DB,
} = require('./players');

const {
  computeLineupDelta,
  computeMatchLineupDeltas,
  extractStarterNames,
  formatLineupPrediction,
  formatWatchLineupNote,
  ABSENCE_SCALE,
  PRESENCE_SCALE,
  MIN_KEY_SCORE,
  EXPECTED_STARTERS,
  MAX_LINEUP_ELO_DELTA,
} = require('./lineupelo');

// We'll also run an integration test that needs predictMatch
const { predictMatch } = require('./simulation');

// ---------------------------------------------------------------------------
// Minimal test harness
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function assert(condition, description) {
  if (condition) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${description}`);
    failed++;
  }
}

function assertApprox(actual, expected, tolerance, description) {
  const ok = Math.abs(actual - expected) <= tolerance;
  if (ok) {
    console.log(`  ✓ ${description} (got ${actual.toFixed(3)}, expected ≈ ${expected})`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${description} — got ${actual.toFixed(3)}, expected ≈ ${expected} (±${tolerance})`);
    failed++;
  }
}

function section(title) {
  console.log('');
  console.log(`── ${title} ${'─'.repeat(Math.max(0, 60 - title.length - 4))}`);
}

// ---------------------------------------------------------------------------
// 1. players.js — database coverage
// ---------------------------------------------------------------------------

section('1. players.js — database coverage');

assert(Object.keys(PLAYER_DB).length >= 40, 'DB covers at least 40 teams');
assert(PLAYER_DB['Argentina'] !== undefined, 'Argentina is in the DB');
assert(PLAYER_DB['France'] !== undefined, 'France is in the DB');
assert(PLAYER_DB['England'] !== undefined, 'England is in the DB');
assert(PLAYER_DB['Brazil'] !== undefined, 'Brazil is in the DB');
assert(PLAYER_DB['Germany'] !== undefined, 'Germany is in the DB');
assert(PLAYER_DB['Spain'] !== undefined, 'Spain is in the DB');

// Every team in the DB must have at least 1 player
const teamsWithNoPlayers = Object.entries(PLAYER_DB)
  .filter(([, ps]) => !Array.isArray(ps) || ps.length === 0)
  .map(([t]) => t);
assert(teamsWithNoPlayers.length === 0,
  `No team has an empty player list (empty: ${teamsWithNoPlayers.join(', ')})`);

// All scores must be 0–100
const badScores = [];
for (const [team, players] of Object.entries(PLAYER_DB)) {
  for (const p of players) {
    if (p.score < 0 || p.score > 100) badScores.push(`${team}/${p.name}=${p.score}`);
  }
}
assert(badScores.length === 0, `All importance scores are in [0, 100] (bad: ${badScores.join(', ')})`);

// ---------------------------------------------------------------------------
// 2. players.js — lookupPlayer
// ---------------------------------------------------------------------------

section('2. players.js — lookupPlayer');

const messiEntry = lookupPlayer('Lionel Messi', 'Argentina');
assert(messiEntry !== null, 'lookupPlayer finds Messi for Argentina');
assert(messiEntry && messiEntry.score === 100, 'Messi has score 100');

const mbappeEntry = lookupPlayer('Kylian Mbappé', 'France');
assert(mbappeEntry !== null, 'lookupPlayer finds Mbappé for France');
assert(mbappeEntry && mbappeEntry.score >= 95, 'Mbappé has score ≥ 95');

// Alias look-up: "mbappe" → Kylian Mbappé
const mbappeAlias = lookupPlayer('mbappe', 'France');
assert(mbappeAlias !== null, 'lookupPlayer resolves "mbappe" alias for France');

// Last-name only
const kaneEntry = lookupPlayer('Kane', 'England');
assert(kaneEntry !== null, 'lookupPlayer finds "Kane" (last-name) for England');

// Wrong team → null
const messiEngland = lookupPlayer('Lionel Messi', 'England');
assert(messiEngland === null, 'lookupPlayer returns null for Messi on wrong team (England)');

// Unknown player
const unknown = lookupPlayer('Totally Unknown Player', 'Brazil');
assert(unknown === null, 'lookupPlayer returns null for unknown player');

// Short ESPN format: "C. Ronaldo"
const crEntry = lookupPlayer('C. Ronaldo', 'Portugal');
// "ronaldo" is a last-name word match
assert(crEntry !== null, 'lookupPlayer finds "C. Ronaldo" for Portugal');

// ---------------------------------------------------------------------------
// 3. players.js — getTopPlayers
// ---------------------------------------------------------------------------

section('3. players.js — getTopPlayers');

const argTop3 = getTopPlayers('Argentina', 3);
assert(argTop3.length === 3, 'getTopPlayers(Argentina, 3) returns 3 players');
assert(argTop3[0].name === 'Lionel Messi', 'Top player for Argentina is Messi');
assert(argTop3[0].score >= argTop3[1].score, 'Players are sorted by score descending');

const brazTop5 = getTopPlayers('Brazil', 5);
assert(brazTop5.length === 5, 'getTopPlayers(Brazil, 5) returns 5 players');

// ---------------------------------------------------------------------------
// 4. lineupelo.js — computeLineupDelta (graceful degradation)
// ---------------------------------------------------------------------------

section('4. lineupelo.js — computeLineupDelta graceful degradation');

const noDataResult = computeLineupDelta('England', []);
assert(noDataResult.delta === 0, 'Empty starters → delta === 0');
assert(noDataResult.hasData === false, 'Empty starters → hasData === false');

const nullResult = computeLineupDelta('England', null);
assert(nullResult.delta === 0, 'null starters → delta === 0');
assert(nullResult.hasData === false, 'null starters → hasData === false');

const unknownTeamResult = computeLineupDelta('UnknownFC', ['Player A', 'Player B']);
assert(unknownTeamResult.delta === 0, 'Team not in DB → delta === 0');

// ---------------------------------------------------------------------------
// 5. lineupelo.js — computeLineupDelta with confirmed stars
// ---------------------------------------------------------------------------

section('5. lineupelo.js — computeLineupDelta with confirmed stars starting');

// Scenario: full first-choice lineup including Messi
const argFirstChoice = [
  'Lionel Messi', 'Julián Álvarez', 'Rodrigo De Paul', 'Alexis Mac Allister',
  'Emiliano Martínez', 'Cristian Romero', 'Lautaro Martínez', 'Rodrigo Bentancur',
  'Nicolás Otamendi', 'Lisandro Martínez', 'Angel Di María',
];
const argFullResult = computeLineupDelta('Argentina', argFirstChoice);
assert(argFullResult.hasData === true, 'Full Argentina lineup → hasData = true');
assert(argFullResult.delta >= 0, 'Full star-studded lineup produces non-negative delta');
assert(argFullResult.confirmed.length > 0, 'At least one DB player confirmed in lineup');
assert(argFullResult.absent.length < argFullResult.confirmed.length,
  'Fewer absences than confirmed stars when full lineup is given');

// ---------------------------------------------------------------------------
// 6. lineupelo.js — computeLineupDelta with key player absent
// ---------------------------------------------------------------------------

section('6. lineupelo.js — computeLineupDelta absent star produces penalty');

// Scenario: Argentina without Messi
const argWithoutMessi = [
  'Julián Álvarez', 'Rodrigo De Paul', 'Alexis Mac Allister',
  'Emiliano Martínez', 'Cristian Romero', 'Lautaro Martínez',
  'Nicolás Otamendi', 'Lisandro Martínez', 'Angel Di María',
  'Leandro Paredes', 'Nicolás González',
];
const argNoMessi = computeLineupDelta('Argentina', argWithoutMessi);
assert(argNoMessi.hasData === true, 'No-Messi lineup → hasData = true');
assert(argNoMessi.delta < 0, 'Missing Messi produces a negative delta');
const expectedAbsencePenalty = -100 * ABSENCE_SCALE; // Messi score=100
assertApprox(argNoMessi.delta, expectedAbsencePenalty, 20,
  'Absent Messi penalty ≈ −100 × ABSENCE_SCALE (±20 due to other confirmed starters)');

const messiAbsent = argNoMessi.absent.find(p => p.name === 'Lionel Messi');
assert(messiAbsent !== undefined, 'Messi appears in absent list');

// ---------------------------------------------------------------------------
// 7. lineupelo.js — full lineup delta vs. missing superstar comparison
// ---------------------------------------------------------------------------

section('7. lineupelo.js — full XI produces higher delta than XI without superstar');

// Argentina full vs. no-Messi
assert(argFullResult.delta > argNoMessi.delta,
  'Full Argentina lineup delta > no-Messi lineup delta');

// England: with vs without Kane + Bellingham
const engFull = [
  'Harry Kane', 'Bukayo Saka', 'Jude Bellingham', 'Declan Rice', 'Phil Foden',
  'Jordan Pickford', 'John Stones', 'Kieran Trippier', 'Marcus Rashford',
  'Kyle Walker', 'Trent Alexander-Arnold',
];
const engNoBigTwo = [
  'Bukayo Saka', 'Declan Rice', 'Jordan Pickford',
  'John Stones', 'Kieran Trippier', 'Marcus Rashford',
  'Kyle Walker', 'Trent Alexander-Arnold', 'Cole Palmer',
  'Phil Foden', 'Anthony Gordon',
];
const engFullDelta = computeLineupDelta('England', engFull);
const engNoBigTwoDelta = computeLineupDelta('England', engNoBigTwo);
assert(engFullDelta.delta > engNoBigTwoDelta.delta,
  'England full XI delta > XI missing Kane + Bellingham');

// ---------------------------------------------------------------------------
// 8. lineupelo.js — delta is capped at MAX_LINEUP_ELO_DELTA
// ---------------------------------------------------------------------------

section('8. lineupelo.js — delta is capped at ±MAX_LINEUP_ELO_DELTA');

// Artificially create a scenario: pass an empty starters list for a team
// whose every top player is "expected" — they all become absent.
const brazNoStarters = computeLineupDelta('Brazil', ['Completely Unknown Player 1', 'Unknown Player 2']);
// All top players absent → large penalty, but capped
assert(brazNoStarters.delta >= -MAX_LINEUP_ELO_DELTA,
  `Delta does not go below −MAX_LINEUP_ELO_DELTA (${-MAX_LINEUP_ELO_DELTA})`);
assert(brazNoStarters.delta <= MAX_LINEUP_ELO_DELTA,
  `Delta does not exceed +MAX_LINEUP_ELO_DELTA (+${MAX_LINEUP_ELO_DELTA})`);

// ---------------------------------------------------------------------------
// 9. lineupelo.js — computeMatchLineupDeltas
// ---------------------------------------------------------------------------

section('9. lineupelo.js — computeMatchLineupDeltas');

const { home, away } = computeMatchLineupDeltas(
  'Argentina', argFirstChoice,
  'England', engFull
);
assert(home.hasData === true, 'computeMatchLineupDeltas home.hasData = true');
assert(away.hasData === true, 'computeMatchLineupDeltas away.hasData = true');
assert(typeof home.delta === 'number', 'home.delta is a number');
assert(typeof away.delta === 'number', 'away.delta is a number');

// ---------------------------------------------------------------------------
// 10. lineupelo.js — extractStarterNames
// ---------------------------------------------------------------------------

section('10. lineupelo.js — extractStarterNames');

// Mock lineups object (shape from matchstate.extractLineups)
const mockLineups = [
  {
    team: 'France',
    starters: [
      { name: 'Kylian Mbappé' },
      { name: 'Antoine Griezmann' },
      { name: 'N\'Golo Kanté' },
      { name: 'Hugo Lloris' },
      { name: 'William Saliba' },
    ],
    subs: [],
  },
  {
    team: 'Germany',
    starters: [
      { name: 'Joshua Kimmich' },
      { name: 'Jamal Musiala' },
      { name: 'Florian Wirtz' },
      { name: 'Manuel Neuer' },
      { name: 'Antonio Rüdiger' },
    ],
    subs: [],
  },
];

const { startersA, startersB } = extractStarterNames(mockLineups, 'France', 'Germany');
assert(startersA.length === 5, 'extractStarterNames finds 5 France starters');
assert(startersB.length === 5, 'extractStarterNames finds 5 Germany starters');
assert(startersA.includes('Kylian Mbappé'), 'Mbappé is in France starters');
assert(startersB.includes('Joshua Kimmich'), 'Kimmich is in Germany starters');

// Empty / null lineup
const { startersA: emptyA, startersB: emptyB } = extractStarterNames(null, 'France', 'Germany');
assert(emptyA.length === 0, 'extractStarterNames returns [] for null lineups (A)');
assert(emptyB.length === 0, 'extractStarterNames returns [] for null lineups (B)');

// ---------------------------------------------------------------------------
// 11. Integration: predictMatch with lineup-adjusted Elo
// ---------------------------------------------------------------------------

section('11. Integration: predictMatch with and without lineup adjustment');

// Base Elo: France 1800, England 1750 (hypothetical; test stays deterministic)
const baseEloFrance  = 1800;
const baseEloEngland = 1750;

// Base prediction
const basePred = predictMatch(baseEloFrance, baseEloEngland);

// Scenario: France without Mbappé
const franceNoMbappe = [
  'Antoine Griezmann', 'N\'Golo Kanté', 'Aurélien Tchouaméni',
  'William Saliba', 'Hugo Lloris', 'Théo Hernandez',
  'Marcus Thuram', 'Eduardo Camavinga', 'Raphaël Varane', 'Bradley Barcola', 'Fabián Ruiz',
];
const franceNoMbappeDelta = computeLineupDelta('France', franceNoMbappe);

const adjEloFrance = baseEloFrance + franceNoMbappeDelta.delta;
const adjPred = predictMatch(adjEloFrance, baseEloEngland);

assert(adjPred.pWin < basePred.pWin,
  'France win% drops when Mbappé is absent');
assert(adjPred.pLoss > basePred.pLoss,
  'England win% rises when Mbappé is absent');

const winDrop = (basePred.pWin - adjPred.pWin) * 100;
assertApprox(winDrop, 2, 5,
  'Win probability drop from missing Mbappé is in plausible range 2±5 %');

// ---------------------------------------------------------------------------
// 12. Format helpers
// ---------------------------------------------------------------------------

section('12. Format helpers — formatWatchLineupNote / formatLineupPrediction');

const noDataNote = formatWatchLineupNote('France', 'England',
  { delta: 0, hasData: false, absent: [] },
  { delta: 0, hasData: false, absent: [] }
);
assert(noDataNote === null, 'formatWatchLineupNote returns null when no data for either team');

const oneTeamNote = formatWatchLineupNote('France', 'England',
  franceNoMbappeDelta,
  { delta: 0, hasData: false, absent: [] }
);
assert(typeof oneTeamNote === 'string', 'formatWatchLineupNote returns a string when at least one team has data');
assert(oneTeamNote.includes('France'), 'Watch lineup note mentions France');

const fullFormatStr = formatLineupPrediction(
  'France', 'England',
  franceNoMbappeDelta, { delta: 0, hasData: false, confirmed: [], absent: [], unknown: [] },
  baseEloFrance, baseEloEngland,
  basePred,
  predictMatch(adjEloFrance, baseEloEngland)
);
assert(typeof fullFormatStr === 'string' && fullFormatStr.length > 100,
  'formatLineupPrediction returns a non-trivial string');
assert(fullFormatStr.includes('LINEUP-AWARE PREDICTION'), 'Output contains section header');
assert(fullFormatStr.includes('Adjusted Elo'), 'Output contains Adjusted Elo line');

// ---------------------------------------------------------------------------
// Final report
// ---------------------------------------------------------------------------

console.log('');
console.log('═'.repeat(62));
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(62));
console.log('');

if (failed > 0) {
  process.exit(1);
}
