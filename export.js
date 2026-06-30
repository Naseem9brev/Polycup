'use strict';

/**
 * export.js
 *
 * JSON and CSV export helpers for Polycup results.
 * Exports the title-odds table and a head-to-head prediction matrix for every
 * unique pair of qualified teams.
 *
 * Zero third-party dependencies.
 */

const { TEAMS } = require('./worldcup2026');
const { predictMatch, HOSTS } = require('./simulation');

function csvRow(fields) {
  return fields
    .map((f) => {
      const s = String(f == null ? '' : f);
      if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    })
    .join(',');
}

function buildOddsRecords(odds) {
  return Object.entries(odds)
    .map(([team, p]) => ({
      team,
      r32: p.r32,
      r16: p.r16,
      qf: p.qf,
      sf: p.sf,
      final: p.final,
      champion: p.champion,
    }))
    .sort((a, b) => b.champion - a.champion);
}

function buildHeadToHeadRecords(elo, rho) {
  const records = [];
  for (let i = 0; i < TEAMS.length; i++) {
    for (let j = i + 1; j < TEAMS.length; j++) {
      const A = TEAMS[i];
      const B = TEAMS[j];
      const r = predictMatch(elo.getRating(A), elo.getRating(B), HOSTS.has(A), HOSTS.has(B), rho);
      records.push({
        teamA: A,
        teamB: B,
        pWinA: r.pWin,
        pDraw: r.pDraw,
        pWinB: r.pLoss,
        xgA: r.xgA,
        xgB: r.xgB,
        mostLikelyScore: `${r.scoreline[0]}-${r.scoreline[1]}`,
      });
    }
  }
  return records;
}

function toJSON({ odds, elo, rho }) {
  const data = {
    generated: new Date().toISOString(),
    model: 'Polycup Elo + Dixon-Coles + Monte Carlo',
    titleOdds: buildOddsRecords(odds),
    headToHead: buildHeadToHeadRecords(elo, rho),
  };
  return JSON.stringify(data, null, 2);
}

function oddsToCSV(odds) {
  const records = buildOddsRecords(odds);
  const lines = [
    csvRow(['rank', 'team', 'r32', 'r16', 'qf', 'sf', 'final', 'champion']),
    ...records.map((r, i) =>
      csvRow([i + 1, r.team, r.r32.toFixed(6), r.r16.toFixed(6), r.qf.toFixed(6), r.sf.toFixed(6), r.final.toFixed(6), r.champion.toFixed(6)])
    ),
  ];
  return lines.join('\n') + '\n';
}

function headToHeadToCSV(elo, rho) {
  const records = buildHeadToHeadRecords(elo, rho);
  const lines = [
    csvRow(['team_a', 'team_b', 'p_win_a', 'p_draw', 'p_win_b', 'xg_a', 'xg_b', 'most_likely_score']),
    ...records.map((r) =>
      csvRow([
        r.teamA,
        r.teamB,
        r.pWinA.toFixed(6),
        r.pDraw.toFixed(6),
        r.pWinB.toFixed(6),
        r.xgA.toFixed(4),
        r.xgB.toFixed(4),
        r.mostLikelyScore,
      ])
    ),
  ];
  return lines.join('\n') + '\n';
}

module.exports = {
  toJSON,
  oddsToCSV,
  headToHeadToCSV,
  buildOddsRecords,
  buildHeadToHeadRecords,
};
