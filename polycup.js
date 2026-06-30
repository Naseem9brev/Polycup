#!/usr/bin/env node
'use strict';

/**
 * polycup.js
 *
 * CLI entry point. Loads/caches the historical results, computes Elo ratings,
 * runs the Monte Carlo tournament simulation, prints the title-odds table and
 * drops into an interactive head-to-head prediction prompt.
 *
 * Predictions are a probabilistic model for entertainment, not betting advice.
 *
 * Zero third-party dependencies.
 */

const readline = require('readline');
const { buildEloModel } = require('./elo');
const { runMonteCarlo, predictMatch, HOSTS } = require('./simulation');
const { GROUPS, TEAMS, GROUP_OF, resolveTeam } = require('./worldcup2026');

const DISCLAIMER =
  'Disclaimer: Polycup is a probabilistic model for entertainment only — not betting advice.';

function parseIterations() {
  const arg = process.argv.slice(2).find((a) => /^--sims=/.test(a) || /^\d+$/.test(a));
  if (!arg) return 10000;
  const n = Number(arg.replace('--sims=', ''));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10000;
}

const pct = (p) => (p * 100).toFixed(1);

/** Print the title-odds table, sorted by championship probability. */
function printTitleTable(odds) {
  const rows = Object.entries(odds).sort((a, b) => b[1].champion - a[1].champion);
  console.log('');
  console.log('  2026 World Cup — title odds (Monte Carlo)');
  console.log('  ' + '-'.repeat(56));
  console.log(
    '  ' +
      'Rank'.padEnd(5) +
      'Team'.padEnd(22) +
      'Grp'.padEnd(5) +
      'Champ'.padStart(7) +
      'Final'.padStart(8) +
      'Semis'.padStart(8)
  );
  console.log('  ' + '-'.repeat(56));
  rows.forEach(([team, p], i) => {
    console.log(
      '  ' +
        String(i + 1).padEnd(5) +
        team.padEnd(22) +
        GROUP_OF[team].padEnd(5) +
        (pct(p.champion) + '%').padStart(7) +
        (pct(p.final) + '%').padStart(8) +
        (pct(p.sf) + '%').padStart(8)
    );
  });
  console.log('  ' + '-'.repeat(56));
  console.log('');
}

/** Print all 48 teams grouped by their group. */
function printTeams() {
  console.log('');
  console.log('  Qualified teams (48) — 12 groups of 4:');
  for (const [letter, teams] of Object.entries(GROUPS)) {
    console.log(`  Group ${letter}: ${teams.join(', ')}`);
  }
  console.log('');
}

/** Render a single head-to-head prediction. */
function printPrediction(elo, teamA, teamB) {
  const hostA = HOSTS.has(teamA);
  const hostB = HOSTS.has(teamB);
  const r = predictMatch(elo.getRating(teamA), elo.getRating(teamB), hostA, hostB);
  console.log('');
  console.log(`  ${teamA}  vs  ${teamB}`);
  console.log('  ' + '-'.repeat(40));
  console.log(`  ${teamA} win : ${pct(r.pWin)}%`);
  console.log(`  Draw       : ${pct(r.pDraw)}%`);
  console.log(`  ${teamB} win : ${pct(r.pLoss)}%`);
  console.log(`  Expected goals : ${teamA} ${r.xgA.toFixed(2)} - ${r.xgB.toFixed(2)} ${teamB}`);
  console.log(`  Most likely score : ${teamA} ${r.scoreline[0]}-${r.scoreline[1]} ${teamB}`);
  if (hostA || hostB) console.log('  (host-nation home advantage applied)');
  console.log('');
}

const HELP = `
Commands:
  <team1> vs <team2>   head-to-head match prediction (e.g. "Brazil vs France")
  titles               reprint the full title-odds table
  teams                list all 48 qualified teams and their groups
  help                 show this help
  quit / exit          leave Polycup

Team names are loose: "Brazil", "BRA" and "bra" all resolve to Brazil.
${DISCLAIMER}
`;

function handleMatch(elo, line) {
  // Split on "vs" / "v" / "-" surrounded by spaces.
  const parts = line.split(/\s+(?:vs?|v\.?|-)\s+/i);
  if (parts.length !== 2) return false;
  const teamA = resolveTeam(parts[0]);
  const teamB = resolveTeam(parts[1]);
  if (!teamA || !teamB) {
    const unknown = !teamA ? parts[0].trim() : parts[1].trim();
    console.log(`  Unknown team: "${unknown}". Type "teams" to list valid teams.`);
    return true;
  }
  if (teamA === teamB) {
    console.log('  Please pick two different teams.');
    return true;
  }
  printPrediction(elo, teamA, teamB);
  return true;
}

function startPrompt(elo, odds) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt('> ');
  console.log('Type "help" for commands, "quit" to exit.');
  rl.prompt();

  rl.on('line', (raw) => {
    const line = raw.trim();
    if (!line) { rl.prompt(); return; }
    const lower = line.toLowerCase();

    if (lower === 'quit' || lower === 'exit' || lower === 'q') { rl.close(); return; }
    else if (lower === 'help' || lower === '?') console.log(HELP);
    else if (lower === 'titles' || lower === 'odds') printTitleTable(odds);
    else if (lower === 'teams' || lower === 'groups') printTeams();
    else if (/\s+(?:vs?|v\.?|-)\s+/i.test(line)) handleMatch(elo, line);
    else console.log('  Unrecognized command. Type "help" for options.');

    rl.prompt();
  });

  rl.on('close', () => {
    console.log('\nThanks for using Polycup!');
    process.exit(0);
  });
}

async function main() {
  const iterations = parseIterations();
  console.log('Polycup — 2026 FIFA World Cup predictor');
  console.log(DISCLAIMER);
  console.log('');

  const log = (msg) => console.log(msg);
  const elo = await buildEloModel({ log });
  log(`Computed Elo ratings from ${elo.matchCount.toLocaleString()} historical matches.`);

  log(`Running ${iterations.toLocaleString()} tournament simulations ...`);
  const odds = runMonteCarlo(elo, iterations, {
    onProgress: (done, total) => {
      process.stdout.write(`\r  simulated ${done.toLocaleString()} / ${total.toLocaleString()}`);
    },
  });
  process.stdout.write('\r' + ' '.repeat(40) + '\r');

  printTitleTable(odds);
  startPrompt(elo, odds);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
