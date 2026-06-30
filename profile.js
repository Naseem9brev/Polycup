'use strict';

/**
 * profile.js
 *
 * Prints a rich text "profile card" for a single team: Elo rating, group,
 * path probabilities from the Monte Carlo simulation, and recent form from the
 * historical dataset.
 *
 * Zero third-party dependencies.
 */

const { GROUPS, GROUP_OF, datasetName } = require('./worldcup2026');
const { predictMatch, HOSTS } = require('./simulation');

const RECENT_FORM_COUNT = 5;

function pct(p) {
  return (p * 100).toFixed(1) + '%';
}

function getRecentForm(teamDisplayName, matches) {
  const ds = datasetName(teamDisplayName);
  const teamMatches = matches
    .filter((m) => m.played && (m.home === ds || m.away === ds))
    .sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first

  const recent = teamMatches.slice(0, RECENT_FORM_COUNT);
  const results = recent.map((m) => {
    const isHome = m.home === ds;
    const opponent = isHome ? m.away : m.home;
    const gf = isHome ? m.homeScore : m.awayScore;
    const ga = isHome ? m.awayScore : m.homeScore;
    let result;
    if (gf > ga) result = 'W';
    else if (gf < ga) result = 'L';
    else result = 'D';
    return { date: m.date, opponent, result, gf, ga, tournament: m.tournament };
  });

  const record = { W: 0, D: 0, L: 0 };
  for (const r of results) record[r.result]++;
  return { record, results };
}

function getGroupSchedule(team, elo, rho) {
  const group = GROUPS[GROUP_OF[team]];
  return group
    .filter((t) => t !== team)
    .map((opp) => {
      const r = predictMatch(elo.getRating(team), elo.getRating(opp), HOSTS.has(team), HOSTS.has(opp), rho);
      return { opponent: opp, pWin: r.pWin, pDraw: r.pDraw, pLoss: r.pLoss, xgA: r.xgA, xgB: r.xgB };
    });
}

function formatProfile(team, elo, odds, rho) {
  const lines = [];
  const group = GROUP_OF[team];
  const rating = elo.getRating(team);
  const teamOdds = odds[team] || { r32: 0, r16: 0, qf: 0, sf: 0, final: 0, champion: 0 };

  lines.push('');
  lines.push(`  ${team}`);
  lines.push(`  ${'='.repeat(team.length + 4)}`);
  lines.push(`  Group ${group} · Elo ${Math.round(rating)}${HOSTS.has(team) ? ' · Host nation' : ''}`);
  lines.push('');

  lines.push('  Path probabilities');
  lines.push('  ' + '-'.repeat(44));
  lines.push(
    '  ' + ['Round of 32', 'Round of 16', 'Quarterfinal', 'Semifinal', 'Final', 'Champion']
      .map((s) => s.padStart(12))
      .join('')
  );
  lines.push(
    '  ' +
      [teamOdds.r32, teamOdds.r16, teamOdds.qf, teamOdds.sf, teamOdds.final, teamOdds.champion]
        .map((p) => pct(p).padStart(12))
        .join('')
  );
  lines.push('  ' + '-'.repeat(44));
  lines.push('');

  const form = getRecentForm(team, elo.matches);
  lines.push(`  Recent form (last ${Math.min(RECENT_FORM_COUNT, form.results.length)} matches): ${form.record.W}-${form.record.D}-${form.record.L}`);
  lines.push('  ' + '-'.repeat(56));
  for (const m of form.results) {
    const opp = m.opponent.padEnd(22);
    const score = `${m.gf}-${m.ga}`.padStart(4);
    const res = `${m.result}`.padStart(2);
    lines.push(`  ${m.date}  ${res}  ${score}  ${opp}  ${m.tournament}`);
  }
  if (form.results.length === 0) {
    lines.push('  No recent matches found in the dataset.');
  }
  lines.push('  ' + '-'.repeat(56));
  lines.push('');

  const schedule = getGroupSchedule(team, elo, rho);
  lines.push('  Group stage schedule');
  lines.push('  ' + '-'.repeat(56));
  lines.push('  ' + 'Opponent'.padEnd(22) + 'Win'.padStart(8) + 'Draw'.padStart(8) + 'Loss'.padStart(8) + 'xG'.padStart(10));
  lines.push('  ' + '-'.repeat(56));
  let expPts = 0;
  for (const m of schedule) {
    expPts += 3 * m.pWin + 1 * m.pDraw;
    lines.push(
      '  ' +
        m.opponent.padEnd(22) +
        pct(m.pWin).padStart(8) +
        pct(m.pDraw).padStart(8) +
        pct(m.pLoss).padStart(8) +
        `${m.xgA.toFixed(2)}-${m.xgB.toFixed(2)}`.padStart(10)
    );
  }
  lines.push('  ' + '-'.repeat(56));
  lines.push(`  Expected group points: ${expPts.toFixed(1)}`);
  lines.push('  ' + '-'.repeat(56));
  lines.push('');

  return lines.join('\n');
}

module.exports = { formatProfile, getRecentForm, getGroupSchedule };
