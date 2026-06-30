'use strict';

/**
 * simulation.js
 *
 * Poisson expected-goals match model plus a Monte Carlo simulation of the full
 * 48-team 2026 World Cup (group stage + protected knockout bracket).
 *
 * Zero third-party dependencies.
 */

const { GROUPS } = require('./worldcup2026');
const { DEFAULT_RHO, sampleDixonColes, jointProbabilityMatrix } = require('./dixoncoles');

const TOTAL_EXPECTED_GOALS = 2.5; // total xG split between the two sides
const ELO_GOAL_SCALE = 400; // sensitivity of the goal split to the Elo gap
const HOST_ELO_BONUS = 65; // host-nation home advantage, in Elo points
const PEN_DAMPING = 0.5; // shootouts keep only half the Elo edge (more random)
const MAX_GOALS = 10; // cap for the analytic scoreline grid

// Knockout calibration: historical World Cup underdogs win ~25-35% of knockout
// matches. Without a cap, the Elo gap produces too lopsided an xG split and the
// simulated rate drops to ~17%. Capping the favorite's share keeps knockouts
// competitive while still respecting the rating gap.
const KNOCKOUT_MAX_FAV_SHARE = 0.70; // favorite can claim at most 70% of xG

const HOSTS = new Set(['USA', 'Canada', 'Mexico']);

// --- Expected goals & Poisson ---------------------------------------------

/**
 * Split ~2.5 expected goals between two teams based on their Elo gap.
 * `hostA`/`hostB` apply the host-nation home bonus where relevant.
 * In knockout matches, the favorite's share is capped to prevent blowout xG
 * splits that under-represent real tournament upsets.
 */
function expectedGoals(eloA, eloB, hostA = false, hostB = false, knockout = false) {
  const adjA = eloA + (hostA ? HOST_ELO_BONUS : 0);
  const adjB = eloB + (hostB ? HOST_ELO_BONUS : 0);
  const diff = adjA - adjB;
  let shareA = 1 / (1 + Math.pow(10, -diff / ELO_GOAL_SCALE));
  if (knockout) {
    const min = 1 - KNOCKOUT_MAX_FAV_SHARE;
    const max = KNOCKOUT_MAX_FAV_SHARE;
    shareA = Math.max(min, Math.min(max, shareA));
  }
  return [TOTAL_EXPECTED_GOALS * shareA, TOTAL_EXPECTED_GOALS * (1 - shareA)];
}

/** Sample a Poisson-distributed count (Knuth's algorithm; fine for small λ). */
function samplePoisson(lambda) {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= Math.random();
  } while (p > L);
  return k - 1;
}

/** Elo expected score for A (0..1). */
function eloExpected(eloA, eloB) {
  return 1 / (1 + Math.pow(10, (eloB - eloA) / 400));
}

// --- Single-match analytic prediction -------------------------------------

/**
 * Analytic head-to-head prediction (no Monte Carlo needed). Returns win/draw/
 * loss probabilities, each side's expected goals and the single most likely
 * exact scoreline.
 */
function predictMatch(eloA, eloB, hostA = false, hostB = false, rho = DEFAULT_RHO) {
  const [lambdaA, lambdaB] = expectedGoals(eloA, eloB, hostA, hostB);
  const probs = jointProbabilityMatrix(lambdaA, lambdaB, rho, MAX_GOALS);

  let pWin = 0;
  let pDraw = 0;
  let pLoss = 0;
  let best = { p: -1, a: 0, b: 0 };
  const n = MAX_GOALS + 1;
  for (let k = 0; k < probs.length; k++) {
    const i = Math.floor(k / n);
    const j = k % n;
    const p = probs[k];
    if (i > j) pWin += p;
    else if (i === j) pDraw += p;
    else pLoss += p;
    if (p > best.p) best = { p, a: i, b: j };
  }

  return {
    pWin,
    pDraw,
    pLoss,
    xgA: lambdaA,
    xgB: lambdaB,
    scoreline: [best.a, best.b],
  };
}

// --- Single simulated match (Poisson draw) --------------------------------

/** Simulate one match; returns { ga, gb }. */
function simMatch(eloA, eloB, hostA, hostB, rho = DEFAULT_RHO) {
  const [lambdaA, lambdaB] = expectedGoals(eloA, eloB, hostA, hostB);
  return sampleDixonColes(lambdaA, lambdaB, rho, MAX_GOALS);
}

/** Decide a knockout tie. Returns winner index (0 = A, 1 = B). */
function knockoutWinner(eloA, eloB, hostA, hostB, rho = DEFAULT_RHO) {
  const [lambdaA, lambdaB] = expectedGoals(eloA, eloB, hostA, hostB, true);
  const { ga, gb } = sampleDixonColes(lambdaA, lambdaB, rho, MAX_GOALS);
  if (ga > gb) return 0;
  if (gb > ga) return 1;
  // Penalty shootout, lightly weighted by Elo (not a coin flip).
  const e = eloExpected(eloA + (hostA ? HOST_ELO_BONUS : 0), eloB + (hostB ? HOST_ELO_BONUS : 0));
  const pA = 0.5 + (e - 0.5) * PEN_DAMPING;
  return Math.random() < pA ? 0 : 1;
}

// --- Bracket template (official FIFA 2026 fixed seeding) -------------------
// Slot descriptors: w = group winner, ru = runner-up, third = best-third slot.

const R32_TEMPLATE = [
  { n: 73, a: { t: 'ru', g: 'A' }, b: { t: 'ru', g: 'B' } },
  { n: 74, a: { t: 'w', g: 'E' }, b: { t: 'third', allowed: ['A', 'B', 'C', 'D', 'F'] } },
  { n: 75, a: { t: 'w', g: 'F' }, b: { t: 'ru', g: 'C' } },
  { n: 76, a: { t: 'w', g: 'C' }, b: { t: 'ru', g: 'F' } },
  { n: 77, a: { t: 'w', g: 'I' }, b: { t: 'third', allowed: ['C', 'D', 'F', 'G', 'H'] } },
  { n: 78, a: { t: 'ru', g: 'E' }, b: { t: 'ru', g: 'I' } },
  { n: 79, a: { t: 'w', g: 'A' }, b: { t: 'third', allowed: ['C', 'E', 'F', 'H', 'I'] } },
  { n: 80, a: { t: 'w', g: 'L' }, b: { t: 'third', allowed: ['E', 'H', 'I', 'J', 'K'] } },
  { n: 81, a: { t: 'w', g: 'D' }, b: { t: 'third', allowed: ['B', 'E', 'F', 'I', 'J'] } },
  { n: 82, a: { t: 'w', g: 'G' }, b: { t: 'third', allowed: ['A', 'E', 'H', 'I', 'J'] } },
  { n: 83, a: { t: 'ru', g: 'K' }, b: { t: 'ru', g: 'L' } },
  { n: 84, a: { t: 'w', g: 'H' }, b: { t: 'ru', g: 'J' } },
  { n: 85, a: { t: 'w', g: 'B' }, b: { t: 'third', allowed: ['E', 'F', 'G', 'I', 'J'] } },
  { n: 86, a: { t: 'w', g: 'J' }, b: { t: 'ru', g: 'H' } },
  { n: 87, a: { t: 'w', g: 'K' }, b: { t: 'third', allowed: ['D', 'E', 'I', 'J', 'L'] } },
  { n: 88, a: { t: 'ru', g: 'D' }, b: { t: 'ru', g: 'G' } },
];

// Later rounds reference winners of earlier match numbers. This QF->SF mapping
// keeps every group's winner and runner-up in opposite halves of the bracket
// (verified against the official 2026 bracket).
const LATER_ROUNDS = [
  // Round of 16 (89-96)
  { n: 89, a: 73, b: 75 }, { n: 90, a: 74, b: 77 },
  { n: 91, a: 76, b: 78 }, { n: 92, a: 79, b: 80 },
  { n: 93, a: 81, b: 82 }, { n: 94, a: 83, b: 84 },
  { n: 95, a: 85, b: 87 }, { n: 96, a: 86, b: 88 },
  // Quarterfinals (97-100)
  { n: 97, a: 89, b: 90 }, { n: 98, a: 93, b: 94 },
  { n: 99, a: 91, b: 92 }, { n: 100, a: 95, b: 96 },
  // Semifinals (101-102)
  { n: 101, a: 97, b: 98 }, { n: 102, a: 99, b: 100 },
  // Final (103)
  { n: 103, a: 101, b: 102 },
];

// Which round each match number belongs to (for stage labelling).
const ROUND_OF = {};
for (const m of R32_TEMPLATE) ROUND_OF[m.n] = 'R32';
for (const m of LATER_ROUNDS) {
  if (m.n <= 96) ROUND_OF[m.n] = 'R16';
  else if (m.n <= 100) ROUND_OF[m.n] = 'QF';
  else if (m.n <= 102) ROUND_OF[m.n] = 'SF';
  else ROUND_OF[m.n] = 'FINAL';
}

const GROUP_LETTERS = Object.keys(GROUPS);

// --- Group stage -----------------------------------------------------------

function emptyStanding(team) {
  return { team, pts: 0, gf: 0, ga: 0, gd: 0 };
}

/** Compare two standings by points, goal difference, goals for, then Elo. */
function compareStandings(a, b, ratings) {
  if (b.pts !== a.pts) return b.pts - a.pts;
  if (b.gd !== a.gd) return b.gd - a.gd;
  if (b.gf !== a.gf) return b.gf - a.gf;
  return ratings[b.team] - ratings[a.team]; // documented tiebreak approximation
}

/** Simulate a single group's round-robin; returns standings sorted best-first. */
function simGroup(teams, ratings, rho = DEFAULT_RHO) {
  const table = {};
  for (const t of teams) table[t] = emptyStanding(t);
  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      const A = teams[i];
      const B = teams[j];
      const { ga, gb } = simMatch(ratings[A], ratings[B], HOSTS.has(A), HOSTS.has(B), rho);
      table[A].gf += ga; table[A].ga += gb;
      table[B].gf += gb; table[B].ga += ga;
      if (ga > gb) table[A].pts += 3;
      else if (gb > ga) table[B].pts += 3;
      else { table[A].pts += 1; table[B].pts += 1; }
    }
  }
  for (const t of teams) table[t].gd = table[t].gf - table[t].ga;
  return Object.values(table).sort((x, y) => compareStandings(x, y, ratings));
}

// --- Third-place assignment (bipartite matching over allowed slots) --------

const THIRD_SLOTS = R32_TEMPLATE.filter((m) => m.b.t === 'third').map((m) => ({
  n: m.n,
  allowed: m.b.allowed,
}));

/**
 * Assign the 8 advancing third-place groups to the 8 third-slots, honoring each
 * slot's allowed-groups constraint. Returns { matchNumber: groupLetter }.
 * (FIFA's exact 495-row lookup table is approximated by any valid matching.)
 */
function assignThirds(thirdGroups) {
  const available = new Set(thirdGroups);
  const result = {};
  // Most-constrained slot first improves the odds of a quick valid matching.
  const slots = THIRD_SLOTS.map((s) => ({
    n: s.n,
    options: s.allowed.filter((g) => available.has(g)),
  }));

  function backtrack(idx, remaining) {
    if (idx === slots.length) return true;
    const slot = slots[idx];
    for (const g of slot.options) {
      if (!remaining.has(g)) continue;
      remaining.delete(g);
      result[slot.n] = g;
      if (backtrack(idx + 1, remaining)) return true;
      remaining.add(g);
      delete result[slot.n];
    }
    return false;
  }

  slots.sort((a, b) => a.options.length - b.options.length);
  if (backtrack(0, new Set(available))) return result;

  // Fallback (should not happen for valid 8-subsets): assign arbitrarily.
  const leftover = [...available];
  for (const s of THIRD_SLOTS) if (!(s.n in result)) result[s.n] = leftover.pop();
  return result;
}

// --- Full tournament -------------------------------------------------------

const STAGE_RANK = { GROUP: 0, R32: 1, R16: 2, QF: 3, SF: 4, FINAL: 5, CHAMPION: 6 };

/**
 * Simulate one full tournament. Returns { team: furthestStageName } for the
 * 32 knockout teams; teams not present exited in the group stage.
 */
function simTournament(ratings, rho = DEFAULT_RHO) {
  // Group stage.
  const winners = {};
  const runners = {};
  const thirds = []; // { team, standing, group }
  for (const letter of GROUP_LETTERS) {
    const standings = simGroup(GROUPS[letter], ratings, rho);
    winners[letter] = standings[0].team;
    runners[letter] = standings[1].team;
    thirds.push({ group: letter, ...standings[2] });
  }

  // Best 8 third-placed teams.
  thirds.sort((a, b) => compareStandings(a, b, ratings));
  const advancingThirds = thirds.slice(0, 8);
  const thirdByGroup = {};
  for (const t of advancingThirds) thirdByGroup[t.group] = t.team;
  const thirdAssignment = assignThirds(advancingThirds.map((t) => t.group));

  // Resolve R32 slots into concrete teams.
  function resolveSlot(slot) {
    if (slot.t === 'w') return winners[slot.g];
    if (slot.t === 'ru') return runners[slot.g];
    return null; // third slots resolved via assignment below
  }

  const reached = {}; // team -> furthest stage
  const markReach = (team, stage) => {
    if (!(team in reached) || STAGE_RANK[stage] > STAGE_RANK[reached[team]]) {
      reached[team] = stage;
    }
  };

  const matchWinner = {}; // match number -> team that won it
  const matchHost = (team) => HOSTS.has(team);

  // Round of 32.
  for (const m of R32_TEMPLATE) {
    const teamA = m.a.t === 'third' ? thirdByGroup[thirdAssignment[m.n]] : resolveSlot(m.a);
    const teamB = m.b.t === 'third' ? thirdByGroup[thirdAssignment[m.n]] : resolveSlot(m.b);
    markReach(teamA, 'R32');
    markReach(teamB, 'R32');
    const w = knockoutWinner(ratings[teamA], ratings[teamB], matchHost(teamA), matchHost(teamB), rho);
    matchWinner[m.n] = w === 0 ? teamA : teamB;
  }

  // Later rounds.
  for (const m of LATER_ROUNDS) {
    const teamA = matchWinner[m.a];
    const teamB = matchWinner[m.b];
    const stage = ROUND_OF[m.n];
    markReach(teamA, stage);
    markReach(teamB, stage);
    const w = knockoutWinner(ratings[teamA], ratings[teamB], matchHost(teamA), matchHost(teamB), rho);
    const winner = w === 0 ? teamA : teamB;
    matchWinner[m.n] = winner;
    if (m.n === 103) markReach(winner, 'CHAMPION');
  }

  return reached;
}

/**
 * Run the Monte Carlo simulation `iterations` times and tally how often each
 * team reaches each stage. Returns per-team probabilities (0..1).
 */
function runMonteCarlo(eloModel, iterations = 10000, { rho = DEFAULT_RHO, onProgress } = {}) {
  const allTeams = Object.values(GROUPS).flat();
  // Snapshot ratings into a plain map for speed.
  const ratings = {};
  for (const t of allTeams) ratings[t] = eloModel.getRating(t);

  const tally = {};
  for (const t of allTeams) {
    tally[t] = { r32: 0, r16: 0, qf: 0, sf: 0, final: 0, champion: 0 };
  }

  for (let i = 0; i < iterations; i++) {
    const reached = simTournament(ratings, rho);
    for (const [team, stage] of Object.entries(reached)) {
      const r = STAGE_RANK[stage];
      const acc = tally[team];
      if (r >= STAGE_RANK.R32) acc.r32++;
      if (r >= STAGE_RANK.R16) acc.r16++;
      if (r >= STAGE_RANK.QF) acc.qf++;
      if (r >= STAGE_RANK.SF) acc.sf++;
      if (r >= STAGE_RANK.FINAL) acc.final++;
      if (r >= STAGE_RANK.CHAMPION) acc.champion++;
    }
    if (onProgress && (i + 1) % 1000 === 0) onProgress(i + 1, iterations);
  }

  const result = {};
  for (const t of allTeams) {
    const c = tally[t];
    result[t] = {
      r32: c.r32 / iterations,
      r16: c.r16 / iterations,
      qf: c.qf / iterations,
      sf: c.sf / iterations,
      final: c.final / iterations,
      champion: c.champion / iterations,
    };
  }
  return result;
}

module.exports = {
  expectedGoals,
  predictMatch,
  samplePoisson,
  simTournament,
  runMonteCarlo,
  HOSTS,
};
