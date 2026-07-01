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
const fs = require('fs');
const { buildEloModel } = require('./elo');
const { runMonteCarlo, runMonteCarloDetailed, predictMatch, expectedGoals, HOSTS } = require('./simulation');
const { estimateRhoFromDataset } = require('./dixoncoles');
const { runBacktest, runAllBacktests } = require('./backtest');
const { runLiveSimulation } = require('./live');
const { generateBracketHTML } = require('./bracket');
const { generateReportHTML } = require('./report');
const { toJSON, oddsToCSV, headToHeadToCSV } = require('./export');
const { formatProfile } = require('./profile');
const { startWatch, listWatchableMatches } = require('./watch');
const { GROUPS, TEAMS, GROUP_OF, resolveTeam } = require('./worldcup2026');

const DISCLAIMER =
  'Disclaimer: Polycup is a probabilistic model for entertainment only — not betting advice.';

function parseIterations() {
  const arg = process.argv.slice(2).find((a) => /^--sims=/.test(a) || /^\d+$/.test(a));
  if (!arg) return 10000;
  const n = Number(arg.replace('--sims=', ''));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10000;
}

/** Find a value-bearing CLI flag like --bracket=foo.html, or true if bare. */
function flagValue(name) {
  const argv = process.argv.slice(2);
  const exact = argv.find((a) => a === `--${name}`);
  if (exact) return true;
  const withVal = argv.find((a) => a.startsWith(`--${name}=`));
  if (withVal) return withVal.slice(`--${name}=`.length);
  return undefined;
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
function printPrediction(elo, teamA, teamB, rho) {
  const hostA = HOSTS.has(teamA);
  const hostB = HOSTS.has(teamB);
  const r = predictMatch(elo.getRating(teamA), elo.getRating(teamB), hostA, hostB, rho);
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
  watch                list today's matches and attach to a live match
  watch <A> vs <B>     live-track a match with auto-updating predictions
  titles               reprint the full title-odds table
  teams                list all 48 qualified teams and their groups
  backtest [year|all]  validate against 2018 or 2022 World Cup (e.g. "backtest 2022")
  live                 re-download results, lock played matches, simulate rest
  profile <team>       show a team's Elo, group, path odds and recent form
  bracket [file]       write the predicted knockout bracket to an HTML file
  report [file]        write a full HTML report (odds, groups, paths) to a file
  export json|csv [f]  export title odds (and head-to-head) as JSON or CSV
  help                 show this help
  quit / exit          leave Polycup

Team names are loose: "Brazil", "BRA" and "bra" all resolve to Brazil.
${DISCLAIMER}
`;

function handleMatch(elo, line, rho) {
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
  printPrediction(elo, teamA, teamB, rho);
  return true;
}

const MODEL_TEXT = `· ${new Date().toISOString().slice(0, 10)}`;

/** Write a generated artifact to disk and report the path. */
function writeArtifact(defaultName, fileArg, content) {
  const file = fileArg && fileArg.trim() ? fileArg.trim() : defaultName;
  try {
    fs.writeFileSync(file, content);
    console.log(`  Wrote ${file} (${content.length.toLocaleString()} bytes).`);
  } catch (e) {
    console.log(`  Could not write ${file}: ${e.message}`);
  }
}

function handleProfile(elo, odds, rho, rest) {
  const team = resolveTeam(rest);
  if (!team) {
    console.log(`  Unknown team: "${rest}". Type "teams" to list valid teams.`);
    return;
  }
  console.log(formatProfile(team, elo, odds, rho));
}

function handleExport(elo, odds, rho, rest) {
  const parts = rest.split(/\s+/).filter(Boolean);
  const kind = (parts[0] || 'json').toLowerCase();
  const fileArg = parts[1];
  if (kind === 'json') {
    writeArtifact('polycup-odds.json', fileArg, toJSON({ odds, elo, rho }));
  } else if (kind === 'csv') {
    const file = fileArg && fileArg.trim() ? fileArg.trim() : 'polycup-odds.csv';
    writeArtifact(file, file, oddsToCSV(odds));
    const h2hFile = file.replace(/\.csv$/i, '') + '-h2h.csv';
    writeArtifact(h2hFile, h2hFile, headToHeadToCSV(elo, rho));
  } else {
    console.log('  Usage: export json|csv [file]');
  }
}

function startPrompt(elo, odds, rho, bracket) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt('> ');
  console.log('Type "help" for commands, "quit" to exit.');

  const queue = [];
  let busy = false;
  let closeRequested = false;

  function finish() {
    console.log('\nThanks for using Polycup!');
    process.exit(0);
  }

  async function processNext() {
    if (busy || queue.length === 0) {
      if (closeRequested && !busy) finish();
      return;
    }
    busy = true;
    const line = queue.shift();
    const lower = line.toLowerCase();

    if (lower === 'quit' || lower === 'exit' || lower === 'q') {
      busy = false;
      if (closeRequested) finish();
      else rl.close();
      return;
    }
    else if (lower === 'help' || lower === '?') console.log(HELP);
    else if (lower === 'titles' || lower === 'odds') printTitleTable(odds);
    else if (lower === 'teams' || lower === 'groups') printTeams();
    else if (lower.startsWith('backtest')) {
      const rest = lower.replace('backtest', '').trim();
      const yearArg = rest || '2022';
      try {
        if (yearArg === 'all') await runAllBacktests({ log: (m) => console.log(m) });
        else await runBacktest(Number(yearArg), { log: (m) => console.log(m) });
      } catch (e) {
        console.log(`  Backtest error: ${e.message}`);
      }
    }
    else if (lower === 'live') {
      try {
        const liveOdds = await runLiveSimulation({
          log: (m) => console.log(m),
          onProgress: (done, total) => {
            process.stdout.write(`\r  simulated ${done.toLocaleString()} / ${total.toLocaleString()}`);
          },
        });
        process.stdout.write('\r' + ' '.repeat(40) + '\r');
        printTitleTable(liveOdds);
      } catch (e) {
        console.log(`  Live error: ${e.message}`);
      }
    }
    else if (lower.startsWith('watch')) {
      const rest = line.slice('watch'.length).trim();
      if (!rest) {
        // List today's matches
        try {
          const { text } = await listWatchableMatches();
          console.log(text);
        } catch (e) {
          console.log(`  Watch error: ${e.message}`);
        }
      } else {
        // Parse "team1 vs team2"
        const parts = rest.split(/\s+(?:vs?|v\.?|-)\s+/i);
        if (parts.length === 2) {
          const wTeamA = resolveTeam(parts[0]);
          const wTeamB = resolveTeam(parts[1]);
          if (!wTeamA || !wTeamB) {
            const unknown = !wTeamA ? parts[0].trim() : parts[1].trim();
            console.log(`  Unknown team: "${unknown}". Type "teams" to list valid teams.`);
          } else {
            try {
              const watcher = await startWatch(wTeamA, wTeamB, elo, rho, {
                onExit: () => {
                  try { rl.prompt(); } catch (e) { /* ignore */ }
                },
              });
              // Listen for 'q' to stop watching
              const quitHandler = (raw) => {
                if (raw.trim().toLowerCase() === 'q' && watcher.isRunning()) {
                  watcher.stop();
                  console.log('\n  Exited watch mode.\n');
                  rl.removeListener('line', quitHandler);
                  rl.prompt();
                }
              };
              rl.on('line', quitHandler);
            } catch (e) {
              console.log(`  Watch error: ${e.message}`);
            }
          }
        } else {
          console.log('  Usage: watch <team1> vs <team2>  or  watch  (to list matches)');
        }
      }
    }
    else if (lower.startsWith('profile')) handleProfile(elo, odds, rho, line.slice('profile'.length).trim());
    else if (lower.startsWith('bracket')) {
      writeArtifact('polycup-bracket.html', line.slice('bracket'.length).trim(),
        generateBracketHTML({ odds, bracket, modelText: MODEL_TEXT }));
    }
    else if (lower.startsWith('report')) {
      writeArtifact('polycup-report.html', line.slice('report'.length).trim(),
        generateReportHTML({ odds, elo, rho, modelText: MODEL_TEXT }));
    }
    else if (lower.startsWith('export')) handleExport(elo, odds, rho, line.slice('export'.length).trim());
    else if (/\s+(?:vs?|v\.?|-)\s+/i.test(line)) handleMatch(elo, line, rho);
    else console.log('  Unrecognized command. Type "help" for options.');

    busy = false;
    if (closeRequested) {
      finish();
      return;
    }
    try { rl.prompt(); } catch (e) { return; }
    processNext();
  }

  rl.on('line', (raw) => {
    const line = raw.trim();
    if (!line) { rl.prompt(); return; }
    queue.push(line);
    processNext();
  });

  rl.on('close', () => {
    closeRequested = true;
    if (!busy) finish();
  });

  rl.prompt();
  processNext();
}

async function main() {
  const iterations = parseIterations();
  console.log('Polycup — 2026 FIFA World Cup predictor');
  console.log(DISCLAIMER);
  console.log('');

  const log = (msg) => console.log(msg);
  const elo = await buildEloModel({ log });
  log(`Computed Elo ratings from ${elo.matchCount.toLocaleString()} historical matches.`);

  const rho = await estimateRhoFromDataset(elo, expectedGoals, { log });

  log(`Running ${iterations.toLocaleString()} tournament simulations ...`);
  const { odds, bracket } = runMonteCarloDetailed(elo, iterations, {
    rho,
    onProgress: (done, total) => {
      process.stdout.write(`\r  simulated ${done.toLocaleString()} / ${total.toLocaleString()}`);
    },
  });
  process.stdout.write('\r' + ' '.repeat(40) + '\r');

  // Non-interactive export flags: generate the artifact and exit.
  const jsonFlag = flagValue('json');
  const csvFlag = flagValue('csv');
  const bracketFlag = flagValue('bracket');
  const reportFlag = flagValue('report');

  if (jsonFlag !== undefined) {
    const out = toJSON({ odds, elo, rho });
    if (typeof jsonFlag === 'string') writeArtifact(jsonFlag, jsonFlag, out);
    else process.stdout.write(out + '\n');
    return;
  }
  if (csvFlag !== undefined) {
    const out = oddsToCSV(odds);
    if (typeof csvFlag === 'string') writeArtifact(csvFlag, csvFlag, out);
    else process.stdout.write(out);
    return;
  }
  if (bracketFlag !== undefined) {
    writeArtifact('polycup-bracket.html', typeof bracketFlag === 'string' ? bracketFlag : '',
      generateBracketHTML({ odds, bracket, modelText: MODEL_TEXT }));
    return;
  }
  if (reportFlag !== undefined) {
    writeArtifact('polycup-report.html', typeof reportFlag === 'string' ? reportFlag : '',
      generateReportHTML({ odds, elo, rho, modelText: MODEL_TEXT }));
    return;
  }

  printTitleTable(odds);
  startPrompt(elo, odds, rho, bracket);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
