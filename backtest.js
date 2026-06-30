'use strict';

/**
 * backtest.js
 *
 * Validates the model against past World Cups (2018 and 2022). It rebuilds Elo
 * ratings using only matches before the tournament, then runs the simulation and
 * compares the predictions to what actually happened.
 *
 * Zero third-party dependencies.
 */

const { loadResults, parseMatches } = require('./elo');
const { expectedGoals, HOSTS } = require('./simulation');
const { sampleDixonColes, jointProbabilityMatrix, estimateRhoFromDataset } = require('./dixoncoles');

const MAX_GOALS = 10;

const PAST_TOURNAMENTS = {
  2018: {
    start: '2018-06-14',
    host: 'Russia',
    champion: 'France',
    groups: {
      A: ['Russia', 'Saudi Arabia', 'Egypt', 'Uruguay'],
      B: ['Portugal', 'Spain', 'Morocco', 'Iran'],
      C: ['France', 'Australia', 'Peru', 'Denmark'],
      D: ['Argentina', 'Iceland', 'Croatia', 'Nigeria'],
      E: ['Brazil', 'Switzerland', 'Costa Rica', 'Serbia'],
      F: ['Germany', 'Mexico', 'Sweden', 'South Korea'],
      G: ['Belgium', 'Panama', 'Tunisia', 'England'],
      H: ['Poland', 'Senegal', 'Colombia', 'Japan'],
    },
  },
  2022: {
    start: '2022-11-20',
    host: 'Qatar',
    champion: 'Argentina',
    groups: {
      A: ['Qatar', 'Ecuador', 'Senegal', 'Netherlands'],
      B: ['England', 'Iran', 'United States', 'Wales'],
      C: ['Argentina', 'Saudi Arabia', 'Mexico', 'Poland'],
      D: ['France', 'Australia', 'Denmark', 'Tunisia'],
      E: ['Spain', 'Costa Rica', 'Germany', 'Japan'],
      F: ['Belgium', 'Canada', 'Morocco', 'Croatia'],
      G: ['Brazil', 'Serbia', 'Switzerland', 'Cameroon'],
      H: ['Portugal', 'Ghana', 'Uruguay', 'South Korea'],
    },
  },
};

// 32-team World Cup knockout bracket template.
const R16_PAIRS = [
  ['A1', 'B2'], ['C1', 'D2'], ['B1', 'A2'], ['D1', 'C2'],
  ['E1', 'F2'], ['G1', 'H2'], ['F1', 'E2'], ['H1', 'G2'],
];
const QF_PAIRS = [[0, 1], [2, 3], [4, 5], [6, 7]];
const SF_PAIRS = [[0, 1], [2, 3]];

/** Build Elo ratings as of a given date. */
async function buildHistoricalElo(beforeDate, options = {}) {
  const { buildEloModel } = require('./elo');
  return buildEloModel({ ...options, beforeDate });
}

/** Extract actual World Cup matches from the dataset. */
async function loadActualMatches(year) {
  const text = await loadResults({ log: () => {} });
  const matches = parseMatches(text);
  const prefix = String(year);
  return matches
    .filter((m) => m.date.startsWith(prefix) && m.tournament === 'FIFA World Cup')
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Derive actual group standings from the first 48 matches. */
function deriveActualStandings(actualMatches, groups) {
  const groupMatches = actualMatches.slice(0, 48);
  const standings = {};
  for (const [letter, teams] of Object.entries(groups)) {
    const table = {};
    for (const t of teams) table[t] = { team: t, pts: 0, gf: 0, ga: 0, gd: 0 };
    for (const m of groupMatches) {
      if (!teams.includes(m.home) && !teams.includes(m.away)) continue;
      table[m.home].gf += m.homeScore;
      table[m.home].ga += m.awayScore;
      table[m.away].gf += m.awayScore;
      table[m.away].ga += m.homeScore;
      if (m.homeScore > m.awayScore) table[m.home].pts += 3;
      else if (m.awayScore > m.homeScore) table[m.away].pts += 3;
      else { table[m.home].pts += 1; table[m.away].pts += 1; }
    }
    for (const t of Object.values(table)) t.gd = t.gf - t.ga;
    standings[letter] = Object.values(table).sort((a, b) => {
      if (b.pts !== a.pts) return b.pts - a.pts;
      if (b.gd !== a.gd) return b.gd - a.gd;
      return b.gf - a.gf;
    });
  }
  return standings;
}

/** Simulate the knockout bracket using actual group positions. */
function simulateKnockout(standings, ratings, rho, host) {
  const positions = {};
  for (const [letter, table] of Object.entries(standings)) {
    positions[`${letter}1`] = table[0].team;
    positions[`${letter}2`] = table[1].team;
  }

  function win(a, b) {
    const rA = ratings[a] || 1000;
    const rB = ratings[b] || 1000;
    const hostA = a === host;
    const hostB = b === host;
    const [la, lb] = expectedGoals(rA, rB, hostA, hostB, true);
    const { ga, gb } = sampleDixonColes(la, lb, rho, MAX_GOALS);
    if (ga > gb) return a;
    if (gb > ga) return b;
    const e = 1 / (1 + Math.pow(10, ((rB + (hostB ? 65 : 0)) - (rA + (hostA ? 65 : 0))) / 400));
    const pA = 0.5 + (e - 0.5) * 0.5;
    return Math.random() < pA ? a : b;
  }

  const r16 = R16_PAIRS.map(([a, b]) => win(positions[a], positions[b]));
  const qf = QF_PAIRS.map(([i, j]) => win(r16[i], r16[j]));
  const sf = SF_PAIRS.map(([i, j]) => win(qf[i], qf[j]));
  const champion = win(sf[0], sf[1]);
  const runnerUp = champion === sf[0] ? sf[1] : sf[0];
  return { r16, qf, sf, champion, runnerUp };
}

/** Run many knockout simulations and tally stage probabilities. */
function runBacktestSim(standings, ratings, rho, host, iterations = 10000) {
  const tally = {};
  for (const table of Object.values(standings)) {
    for (const t of table) tally[t.team] = { r16: 0, qf: 0, sf: 0, final: 0, champion: 0 };
  }

  for (let i = 0; i < iterations; i++) {
    const res = simulateKnockout(standings, ratings, rho, host);
    for (const t of res.r16) tally[t].r16++;
    for (const t of res.qf) tally[t].qf++;
    for (const t of res.sf) tally[t].sf++;
    tally[res.champion].final++;
    tally[res.runnerUp].final++;
    tally[res.champion].champion++;
  }

  const result = {};
  for (const t of Object.keys(tally)) {
    result[t] = {
      r16: tally[t].r16 / iterations,
      qf: tally[t].qf / iterations,
      sf: tally[t].sf / iterations,
      final: tally[t].final / iterations,
      champion: tally[t].champion / iterations,
    };
  }
  return result;
}

/** Predict the outcome of each actual match and compare to reality. */
function evaluateMatchPredictions(actualMatches, ratings, rho, host) {
  let correct = 0;
  let total = 0;
  let logLoss = 0;
  const buckets = {};
  const stageBuckets = { group: { n: 0, correct: 0 }, knockout: { n: 0, correct: 0 } };

  for (let idx = 0; idx < actualMatches.length; idx++) {
    const m = actualMatches[idx];
    const rA = ratings[m.home] || 1000;
    const rB = ratings[m.away] || 1000;
    const hostA = m.home === host;
    const hostB = m.away === host;
    const [la, lb] = expectedGoals(rA, rB, hostA, hostB);
    const probs = jointProbabilityMatrix(la, lb, rho, MAX_GOALS);
    const n = MAX_GOALS + 1;

    let pHome = 0, pDraw = 0, pAway = 0;
    for (let k = 0; k < probs.length; k++) {
      const i = Math.floor(k / n);
      const j = k % n;
      if (i > j) pHome += probs[k];
      else if (i === j) pDraw += probs[k];
      else pAway += probs[k];
    }

    const predicted = pHome > pDraw && pHome > pAway ? 'H' : pDraw > pAway ? 'D' : 'A';
    let actual;
    if (m.homeScore > m.awayScore) actual = 'H';
    else if (m.homeScore < m.awayScore) actual = 'A';
    else actual = 'D';

    if (predicted === actual) correct++;
    total++;

    const pActual = actual === 'H' ? pHome : actual === 'D' ? pDraw : pAway;
    logLoss += -Math.log(pActual + 1e-12);

    const favProb = Math.max(pHome, pDraw, pAway);
    const bucket = Math.floor(favProb * 10) / 10;
    if (!buckets[bucket]) buckets[bucket] = { n: 0, correct: 0 };
    buckets[bucket].n++;
    if (predicted === actual) buckets[bucket].correct++;

    const stage = idx < 48 ? 'group' : 'knockout';
    stageBuckets[stage].n++;
    if (predicted === actual) stageBuckets[stage].correct++;
  }

  return { accuracy: correct / total, logLoss: logLoss / total, buckets, stageBuckets, total };
}

/** Run the full backtest for a single year. */
async function runBacktest(year, { log = console.log, iterations = 10000 } = {}) {
  const config = PAST_TOURNAMENTS[year];
  if (!config) throw new Error(`Unknown year: ${year}`);

  log(`\n=== Backtest: ${year} FIFA World Cup ===`);
  const elo = await buildHistoricalElo(config.start, { log: () => {} });
  const actualMatches = await loadActualMatches(year);
  const standings = deriveActualStandings(actualMatches, config.groups);
  const actualChampion = config.champion;

  log(`Actual champion: ${actualChampion}`);
  log('Actual group winners / runners-up:');
  for (const [letter, table] of Object.entries(standings)) {
    log(`  Group ${letter}: ${table[0].team}, ${table[1].team}`);
  }

  const rho = await estimateRhoFromDataset(elo, expectedGoals, { log: () => {} });
  log(`Estimated ρ = ${rho.toFixed(4)}`);

  const matchEval = evaluateMatchPredictions(actualMatches, elo.ratings, rho, config.host);
  log(`\nMatch prediction accuracy: ${(matchEval.accuracy * 100).toFixed(1)}% (${matchEval.total} matches)`);
  log(`  Group stage: ${(matchEval.stageBuckets.group.correct / matchEval.stageBuckets.group.n * 100).toFixed(1)}%`);
  log(`  Knockout: ${(matchEval.stageBuckets.knockout.correct / matchEval.stageBuckets.knockout.n * 100).toFixed(1)}%`);
  log(`Average log-loss: ${matchEval.logLoss.toFixed(3)}`);

  log('\nCalibration by favorite probability bucket:');
  const buckets = Object.entries(matchEval.buckets).sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]));
  for (const [bucket, v] of buckets) {
    const lo = parseFloat(bucket) * 100;
    const hi = lo + 10;
    log(`  ${lo.toFixed(0).padStart(2)}-${hi.toFixed(0).padStart(2)}%: ${v.correct}/${v.n} = ${(v.correct / v.n * 100).toFixed(1)}%`);
  }

  const sim = runBacktestSim(standings, elo.ratings, rho, config.host, iterations);
  const sorted = Object.entries(sim).sort((a, b) => b[1].champion - a[1].champion);
  log('\nTop 10 predicted title odds (* = actual champion):');
  for (const [team, p] of sorted.slice(0, 10)) {
    const marker = team === actualChampion ? ' *' : '';
    log(`  ${team.padEnd(20)} ${(p.champion * 100).toFixed(1)}%${marker}`);
  }
  const champProb = (sim[actualChampion] || { champion: 0 }).champion;
  log(`\nModel gave actual champion ${(champProb * 100).toFixed(1)}% title probability.`);

  return { matchEval, sim, actualChampion, championProb: champProb };
}

async function runAllBacktests({ log = console.log, iterations = 10000 } = {}) {
  for (const year of Object.keys(PAST_TOURNAMENTS)) {
    await runBacktest(Number(year), { log, iterations });
  }
}

module.exports = { runBacktest, runAllBacktests, buildHistoricalElo, loadActualMatches, deriveActualStandings };

if (require.main === module) {
  const arg = process.argv[2];
  if (arg === 'all') {
    runAllBacktests().catch((err) => { console.error(err); process.exit(1); });
  } else {
    const year = Number(arg) || 2022;
    runBacktest(year).catch((err) => { console.error(err); process.exit(1); });
  }
}
