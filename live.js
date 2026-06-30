'use strict';

/**
 * live.js
 *
 * Live tournament re-simulation for the 2026 World Cup. Re-downloads the latest
 * results, locks in already-played group and knockout matches, and only
 * simulates the remaining fixtures.
 *
 * Zero third-party dependencies.
 */

const { loadResults, parseMatches } = require('./elo');
const {
  expectedGoals,
  HOSTS,
  R32_TEMPLATE,
  LATER_ROUNDS,
  ROUND_OF,
  GROUP_LETTERS,
  compareStandings,
  assignThirds,
  emptyStanding,
} = require('./simulation');
const { sampleDixonColes, estimateRhoFromDataset } = require('./dixoncoles');
const { GROUPS, TEAMS } = require('./worldcup2026');

const MAX_GOALS = 10;

function getMatchResult(m) {
  if (!m || m.homeScore === 'NA' || m.awayScore === 'NA') return null;
  if (m.homeScore > m.awayScore) return 'H';
  if (m.awayScore > m.homeScore) return 'A';
  return 'D';
}

/** Find the played match between two teams (order-independent). */
function findPlayedMatch(played, a, b) {
  return played.find((m) => (m.home === a && m.away === b) || (m.home === b && m.away === a)) || null;
}

/** Compute group standings from a mix of played and simulated matches. */
function simulateGroupWithLocks(teams, ratings, rho, playedGroupMatches) {
  const table = {};
  for (const t of teams) table[t] = emptyStanding(t);

  // Replay all played group matches.
  for (const m of playedGroupMatches) {
    if (!teams.includes(m.home) || !teams.includes(m.away)) continue;
    table[m.home].gf += m.homeScore;
    table[m.home].ga += m.awayScore;
    table[m.away].gf += m.awayScore;
    table[m.away].ga += m.homeScore;
    if (m.homeScore > m.awayScore) table[m.home].pts += 3;
    else if (m.awayScore > m.homeScore) table[m.away].pts += 3;
    else { table[m.home].pts += 1; table[m.away].pts += 1; }
  }

  // Simulate remaining group matches.
  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      const A = teams[i];
      const B = teams[j];
      if (findPlayedMatch(playedGroupMatches, A, B)) continue;
      const [la, lb] = expectedGoals(ratings[A], ratings[B], HOSTS.has(A), HOSTS.has(B));
      const { ga, gb } = sampleDixonColes(la, lb, rho, MAX_GOALS);
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

/** Decide a knockout tie. Returns winner team name. */
function knockoutWinnerTeam(a, b, ratings, rho) {
  const rA = ratings[a] || 1000;
  const rB = ratings[b] || 1000;
  const hostA = HOSTS.has(a);
  const hostB = HOSTS.has(b);
  const [la, lb] = expectedGoals(rA, rB, hostA, hostB, true);
  const { ga, gb } = sampleDixonColes(la, lb, rho, MAX_GOALS);
  if (ga > gb) return a;
  if (gb > ga) return b;
  const e = 1 / (1 + Math.pow(10, ((rB + (hostB ? 65 : 0)) - (rA + (hostA ? 65 : 0))) / 400));
  const pA = 0.5 + (e - 0.5) * 0.5;
  return Math.random() < pA ? a : b;
}

/**
 * Run one live tournament simulation. `played` is an array of already-played
 * 2026 World Cup matches with actual scores. Returns { team: furthestStage }.
 */
function simLiveTournament(ratings, rho, played) {
  // Split played matches into group stage and knockout by chronological position.
  // First 72 (12 groups * 6) are group stage; the rest are knockout.
  const playedSorted = played.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const playedGroup = playedSorted.slice(0, 72);
  const playedKnockout = playedSorted.slice(72);

  // Group stage with locks.
  const winners = {};
  const runners = {};
  const thirds = [];
  for (const letter of GROUP_LETTERS) {
    const standings = simulateGroupWithLocks(GROUPS[letter], ratings, rho, playedGroup);
    winners[letter] = standings[0].team;
    runners[letter] = standings[1].team;
    thirds.push({ group: letter, ...standings[2] });
  }

  // Best 8 third-place teams.
  thirds.sort((a, b) => compareStandings(a, b, ratings));
  const advancingThirds = thirds.slice(0, 8);
  const thirdByGroup = {};
  for (const t of advancingThirds) thirdByGroup[t.group] = t.team;

  // Assign the 8 advancing third-place teams to the fixed third-slots.
  const thirdAssignment = assignThirds(advancingThirds.map((t) => t.group));
  const thirdByMatch = {};
  for (const m of R32_TEMPLATE) {
    if (m.b.t === 'third') thirdByMatch[m.n] = thirdByGroup[thirdAssignment[m.n]];
  }

  // Resolve R32 slots into concrete teams.
  function resolveSlot(slot, matchNumber) {
    if (slot.t === 'w') return winners[slot.g];
    if (slot.t === 'ru') return runners[slot.g];
    return thirdByMatch[matchNumber];
  }

  const reached = {};
  const markReach = (team, stage) => {
    if (!(team in reached) || ['R32', 'R16', 'QF', 'SF', 'FINAL', 'CHAMPION'].indexOf(stage) > ['R32', 'R16', 'QF', 'SF', 'FINAL', 'CHAMPION'].indexOf(reached[team])) {
      reached[team] = stage;
    }
  };

  const matchWinner = {};
  const matchScore = {};

  // Round of 32.
  for (const m of R32_TEMPLATE) {
    const teamA = resolveSlot(m.a, m.n);
    const teamB = resolveSlot(m.b, m.n);
    // Map to actual played knockout match if possible.
    const playedMatch = findPlayedMatch(playedKnockout, teamA, teamB);
    let winner;
    if (playedMatch) {
      winner = getMatchResult(playedMatch) === 'H' ? playedMatch.home : playedMatch.away;
      matchScore[m.n] = [playedMatch.homeScore, playedMatch.awayScore];
    } else {
      winner = knockoutWinnerTeam(teamA, teamB, ratings, rho);
      matchScore[m.n] = null;
    }
    markReach(teamA, 'R32');
    markReach(teamB, 'R32');
    matchWinner[m.n] = winner;
  }

  // Later rounds.
  for (const m of LATER_ROUNDS) {
    const teamA = matchWinner[m.a];
    const teamB = matchWinner[m.b];
    const playedMatch = findPlayedMatch(playedKnockout, teamA, teamB);
    const stage = ROUND_OF[m.n];
    markReach(teamA, stage);
    markReach(teamB, stage);
    let winner;
    if (playedMatch) {
      winner = getMatchResult(playedMatch) === 'H' ? playedMatch.home : playedMatch.away;
      matchScore[m.n] = [playedMatch.homeScore, playedMatch.awayScore];
    } else {
      winner = knockoutWinnerTeam(teamA, teamB, ratings, rho);
      matchScore[m.n] = null;
    }
    matchWinner[m.n] = winner;
    if (m.n === 103) markReach(winner, 'CHAMPION');
  }

  return reached;
}

/**
 * Run the live Monte Carlo simulation. Re-downloads the dataset, recomputes
 * Elo ratings, and simulates the remaining 2026 tournament `iterations` times.
 */
async function runLiveSimulation({ iterations = 10000, log = console.log, onProgress } = {}) {
  log('\n=== Live 2026 World Cup simulation ===');
  log('Refreshing dataset ...');
  const { buildEloModel } = require('./elo');
  const elo = await buildEloModel({ log, forceDownload: true });
  const text = await loadResults({ log: () => {} });
  const allMatches = parseMatches(text, true);
  const played2026 = allMatches.filter((m) => m.date.startsWith('2026') && m.tournament === 'FIFA World Cup' && m.played);
  const unplayed2026 = allMatches.filter((m) => m.date.startsWith('2026') && m.tournament === 'FIFA World Cup' && !m.played);
  log(`Locked ${played2026.length.toLocaleString()} played matches; ${unplayed2026.length.toLocaleString()} fixtures remaining.`);

  const rho = await estimateRhoFromDataset(elo, expectedGoals, { log: () => {} });
  log(`Estimated ρ = ${rho.toFixed(4)}`);

  const allTeams = TEAMS;
  const ratings = {};
  for (const t of allTeams) ratings[t] = elo.getRating(t);

  const tally = {};
  for (const t of allTeams) tally[t] = { r32: 0, r16: 0, qf: 0, sf: 0, final: 0, champion: 0 };

  for (let i = 0; i < iterations; i++) {
    const reached = simLiveTournament(ratings, rho, played2026);
    for (const [team, stage] of Object.entries(reached)) {
      const rank = { R32: 1, R16: 2, QF: 3, SF: 4, FINAL: 5, CHAMPION: 6 }[stage];
      const acc = tally[team];
      if (rank >= 1) acc.r32++;
      if (rank >= 2) acc.r16++;
      if (rank >= 3) acc.qf++;
      if (rank >= 4) acc.sf++;
      if (rank >= 5) acc.final++;
      if (rank >= 6) acc.champion++;
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

module.exports = { runLiveSimulation, simLiveTournament };
