#!/usr/bin/env node
'use strict';

/**
 * polycup.js
 *
 * CLI entry point. Loads/caches the historical results, computes Elo ratings,
 * runs the Monte Carlo tournament simulation, prints the title-odds table and
 * drops into an interactive head-to-head prediction prompt.
 *
 * Defaults may be set in ~/.polycup/config.json or a local .polycuprc.json.
 * CLI flags always override config values.
 *
 * Predictions are a probabilistic model for entertainment, not betting advice.
 *
 * Zero third-party dependencies.
 */

const readline = require('readline');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { buildEloModel } = require('./elo');
const { runMonteCarlo, runMonteCarloDetailed, predictMatch, expectedGoals, HOSTS } = require('./simulation');
const { estimateRhoFromDataset, jointProbabilityMatrix } = require('./dixoncoles');
const { runBacktest, runAllBacktests } = require('./backtest');
const { runLiveSimulation } = require('./live');
const { generateBracketHTML } = require('./bracket');
const { generateReportHTML } = require('./report');
const { toJSON, oddsToCSV, headToHeadToCSV } = require('./export');
const { formatProfile } = require('./profile');
const { startWatch, listWatchableMatches } = require('./watch');
const { GROUPS, TEAMS, GROUP_OF, resolveTeam } = require('./worldcup2026');
const { mergeConfig, loadConfig } = require('./config');
const { fetchScoreboard, fetchMatchSummary } = require('./datasource');
const { enrichMatchState } = require('./matchstate');
const {
  computeMatchLineupDeltas,
  extractStarterNames,
  formatLineupPrediction,
} = require('./lineupelo');
const { buildPlayerModel, PLAYER_BLEND } = require('./playerxg');
const { buildPenaltyModel } = require('./penalty');

const DISCLAIMER =
  'Disclaimer: Polycup is a probabilistic model for entertainment only — not betting advice.';

const HISTORY_FILE = path.join(os.homedir(), '.polycup_history');
const HISTORY_SIZE = 100;

/** Parse supported CLI flags. */
function parseArgs(argv) {
  const args = {
    sims: undefined,
    seed: undefined,
    resume: false,
    rho: undefined,
    format: undefined,
    favorites: undefined,
  };

  for (const arg of argv) {
    if (/^--sims=/.test(arg)) {
      args.sims = Number(arg.replace('--sims=', ''));
    } else if (/^--seed=/.test(arg)) {
      args.seed = arg.replace('--seed=', '');
    } else if (arg === '--resume' || arg === '-r') {
      args.resume = true;
    } else if (/^--rho=/.test(arg)) {
      args.rho = Number(arg.replace('--rho=', ''));
    } else if (/^--format=/.test(arg)) {
      args.format = arg.replace('--format=', '').toLowerCase();
    } else if (/^--favorites=/.test(arg)) {
      args.favorites = arg.replace('--favorites=', '').split(',').map((s) => s.trim()).filter(Boolean);
    } else if (/^--no-config$/.test(arg)) {
      args.noConfig = true;
    } else if (/^\d+$/.test(arg)) {
      args.sims = Number(arg);
    }
  }

  return args;
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
function printTitleTable(odds, favorites = new Set()) {
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
    const fav = favorites.has(team) ? '*' : ' ';
    console.log(
      '  ' +
        String(i + 1).padEnd(5) +
        (fav + team).padEnd(22) +
        GROUP_OF[team].padEnd(5) +
        (pct(p.champion) + '%').padStart(7) +
        (pct(p.final) + '%').padStart(8) +
        (pct(p.sf) + '%').padStart(8)
    );
  });
  console.log('  ' + '-'.repeat(56));
  if (favorites.size > 0) console.log('  * = favorite team listed in config');
  console.log('');
}

/** Print the title-odds table as JSON. */
function printTitleJson(odds, favorites = []) {
  const output = {
    favorites,
    odds: Object.fromEntries(
      Object.entries(odds)
        .sort((a, b) => b[1].champion - a[1].champion)
        .map(([team, p]) => [team, {
          champion: Number(pct(p.champion)),
          final: Number(pct(p.final)),
          semis: Number(pct(p.sf)),
        }])
    ),
  };
  console.log(JSON.stringify(output, null, 2));
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
  <team1> vs <team2>        head-to-head match prediction (e.g. "Brazil vs France")
  penalty <A> vs <B>        penalty shootout prediction (alias: shootout)
  lineups <A> vs <B>        lineup-adjusted prediction; fetches live ESPN lineup data
  player <A> vs <B>         [EXPERIMENTAL] player-level xG prediction vs Elo baseline
  watch                     list today's matches and attach to a live match
  watch <A> vs <B>          live-track a match with auto-updating predictions
  titles                    reprint the full title-odds table
  teams                     list all 48 qualified teams and their groups
  backtest [year|all]       validate against 2018 or 2022 World Cup (e.g. "backtest 2022")
  live                      re-download results, lock played matches, simulate rest
  profile <team>            show a team's Elo, group, path odds and recent form
  bracket [file]            write the predicted knockout bracket to an HTML file
  report [file]             write a full HTML report (odds, groups, paths) to a file
  export json|csv [f]       export title odds (and head-to-head) as JSON or CSV
  help                      show this help
  quit / exit               leave Polycup

Team names are loose: "Brazil", "BRA" and "bra" all resolve to Brazil.
Common typos are also corrected.
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

/**
 * Handle the "penalty <A> vs <B>" (or "shootout") command.
 * Builds the penalty shootout model on first use, then prints a side-by-side
 * prediction: win probability, likely takers, and key factors.
 */
async function handlePenalty(elo, cachedPenaltyModel, line, setPenaltyModel) {
  const parts = line.split(/\s+(?:vs?|v\.?|-)\s+/i);
  if (parts.length !== 2) {
    console.log('  Usage: penalty <team1> vs <team2>   (alias: shootout)');
    return;
  }
  const teamA = resolveTeam(parts[0].trim());
  const teamB = resolveTeam(parts[1].trim());

  if (!teamA || !teamB) {
    const unknown = !teamA ? parts[0].trim() : parts[1].trim();
    console.log(`  Unknown team: "${unknown}". Type "teams" to list valid teams.`);
    return;
  }
  if (teamA === teamB) {
    console.log('  Please pick two different teams.');
    return;
  }

  let pm = cachedPenaltyModel;
  if (!pm) {
    try {
      console.log('  Loading penalty shootout model (first use — may download ~50 KB) ...');
      pm = await buildPenaltyModel({ elo, log: (m) => console.log('  ' + m) });
      setPenaltyModel(pm);
    } catch (e) {
      console.log(`  Penalty model unavailable: ${e.message}`);
      console.log('  Falling back to Elo-damped estimate.\n');
      printPenaltyFallback(elo, teamA, teamB);
      return;
    }
  }

  printPenaltyPrediction(pm, teamA, teamB);
}

/** Print a penalty prediction using only the legacy Elo-damped fallback. */
function printPenaltyFallback(elo, teamA, teamB) {
  const eloA = elo.getRating(teamA);
  const eloB = elo.getRating(teamB);
  const hostA = HOSTS.has(teamA);
  const hostB = HOSTS.has(teamB);
  const e = 1 / (1 + Math.pow(10, ((eloB + (hostB ? 65 : 0)) - (eloA + (hostA ? 65 : 0))) / 400));
  const pA = 0.5 + (e - 0.5) * 0.5;

  console.log('');
  console.log(`  Penalty shootout — ${teamA}  vs  ${teamB} (Elo fallback)`);
  console.log('  ' + '-'.repeat(50));
  console.log(`  ${teamA} win : ${pct(pA)}%`);
  console.log(`  ${teamB} win : ${pct(1 - pA)}%`);
  console.log('  (No historical shootout data available for this prediction.)');
  console.log('');
}

/** Print a full penalty shootout prediction with takers and factors. */
function printPenaltyPrediction(pm, teamA, teamB) {
  const hostA = HOSTS.has(teamA);
  const hostB = HOSTS.has(teamB);
  const result = pm.predictPenaltyShootout(teamA, teamB, { hostA, hostB });
  const takersA = pm.getTakers(teamA, 5);
  const takersB = pm.getTakers(teamB, 5);

  const fmtFactor = (f) => (f >= 0 ? '+' : '') + (f * 100).toFixed(1) + '%';
  const fmtRate = (r) => r !== null && r !== undefined ? `${(r * 100).toFixed(1)}%` : 'n/a';
  const fmtTakers = (arr) => arr.length > 0 ? arr.map((p) => p.name).join(', ') : '(no data)';

  console.log('');
  console.log(`  Penalty shootout — ${teamA}  vs  ${teamB}`);
  console.log('  ' + '='.repeat(58));
  console.log(`  ${teamA.padEnd(22)} ${(pct(result.pA) + '%').padStart(10)}  win probability`);
  console.log(`  ${teamB.padEnd(22)} ${(pct(result.pB) + '%').padStart(10)}  win probability`);
  console.log('  ' + '-'.repeat(58));
  console.log(`  Factor                 ${teamA.padStart(10)}  ${teamB.padStart(10)}`);
  console.log('  ' + '-'.repeat(58));
  console.log(`  Elo pressure           ${fmtFactor(result.factorsA.eloAdvantage).padStart(10)}  ${fmtFactor(result.factorsB.eloAdvantage).padStart(10)}`);
  console.log(`  Shootout history       ${fmtRate(result.factorsA.winRate).padStart(10)}  ${fmtRate(result.factorsB.winRate).padStart(10)}`);
  console.log(`  Taker quality          ${(result.factorsA.takerQuality * 100).toFixed(1).padStart(9)}%  ${(result.factorsB.takerQuality * 100).toFixed(1).padStart(9)}%`);
  console.log(`  Host bonus             ${fmtFactor(result.factorsA.hostAdvantage).padStart(10)}  ${fmtFactor(result.factorsB.hostAdvantage).padStart(10)}`);
  console.log('  ' + '-'.repeat(58));
  console.log(`  ${teamA} likely takers : ${fmtTakers(takersA)}`);
  console.log(`  ${teamB} likely takers : ${fmtTakers(takersB)}`);
  console.log('  ' + '='.repeat(58));
  console.log('  Note: probabilities are team-level estimates. Individual kick order,');
  console.log('  keeper form, and in-match momentum can all shift a real shootout.');
  console.log('');
}

/**
 * Handle the "lineups <A> vs <B>" command.
 * Fetches live ESPN lineup data (if the match is on today's scoreboard),
 * runs the lineup-aware Elo adjustment, and prints a side-by-side comparison
 * of the base prediction vs. the lineup-adjusted prediction.
 * Degrades gracefully when ESPN data is unavailable.
 */
async function handleLineups(elo, line, rho) {
  const parts = line.split(/\s+(?:vs?|v\.?|-)\s+/i);
  if (parts.length !== 2) {
    console.log('  Usage: lineups <team1> vs <team2>');
    return;
  }
  const teamA = resolveTeam(parts[0].trim());
  const teamB = resolveTeam(parts[1].trim());

  if (!teamA || !teamB) {
    const unknown = !teamA ? parts[0].trim() : parts[1].trim();
    console.log(`  Unknown team: "${unknown}". Type "teams" to list valid teams.`);
    return;
  }
  if (teamA === teamB) {
    console.log('  Please pick two different teams.');
    return;
  }

  const hostA = HOSTS.has(teamA);
  const hostB = HOSTS.has(teamB);
  const baseEloA = elo.getRating(teamA);
  const baseEloB = elo.getRating(teamB);

  // Base prediction (no lineup adjustment)
  const basePred = predictMatch(baseEloA, baseEloB, hostA, hostB, rho);

  // Try to fetch today's ESPN lineup data
  let startersA = [];
  let startersB = [];

  console.log(`  Fetching lineup data for ${teamA} vs ${teamB} from ESPN...`);
  try {
    const scoreboard = await fetchScoreboard();
    const nameA = teamA.toLowerCase();
    const nameB = teamB.toLowerCase();
    const match = scoreboard.find(m => {
      const h = m.home.name.toLowerCase();
      const a = m.away.name.toLowerCase();
      return (h.includes(nameA) && a.includes(nameB)) ||
             (h.includes(nameB) && a.includes(nameA));
    });

    if (match) {
      const summary = await fetchMatchSummary(match.id);
      const state = enrichMatchState(match, summary);
      if (state.lineups) {
        const { startersA: sA, startersB: sB } = extractStarterNames(
          state.lineups, teamA, teamB
        );
        startersA = sA;
        startersB = sB;
      }
      if (startersA.length === 0 && startersB.length === 0) {
        console.log('  Lineup data not yet available (match may not have started).');
        console.log('  Showing base prediction with database-seeded key players.\n');
      } else {
        console.log(`  Got lineups: ${startersA.length} starters for ${teamA}, ${startersB.length} for ${teamB}.`);
      }
    } else {
      console.log(`  Match not found on today's ESPN scoreboard.`);
      console.log('  Showing base prediction only (no live lineup data).\n');
    }
  } catch (e) {
    console.log(`  ESPN data unavailable (${e.message}).`);
    console.log('  Showing base prediction only.\n');
  }

  // Compute lineup deltas
  const { home: homeResult, away: awayResult } =
    computeMatchLineupDeltas(teamA, startersA, teamB, startersB);

  // Lineup-adjusted prediction
  const adjEloA = baseEloA + homeResult.delta;
  const adjEloB = baseEloB + awayResult.delta;
  const adjPred = predictMatch(adjEloA, adjEloB, hostA, hostB, rho);

  // Print
  console.log(formatLineupPrediction(
    teamA, teamB,
    homeResult, awayResult,
    baseEloA, baseEloB,
    basePred, adjPred
  ));
}

/**
 * Handle the "player <A> vs <B>" command.
 *
 * Builds (or reuses) the player xG model and shows a side-by-side comparison:
 *   - Standard Elo/Dixon-Coles baseline
 *   - Player-adjusted prediction derived from historical goal-scoring data
 *
 * Degrades gracefully if the player model is unavailable (shows Elo only).
 *
 * @param {object}       elo          - Elo model
 * @param {object|null}  playerModel  - Already-built player model, or null if
 *                                      it hasn't been loaded yet
 * @param {string}       line         - The part after "player " (e.g. "Brazil vs France")
 * @param {number}       rho          - Dixon-Coles ρ
 * @param {Function}     setPlayerModel - Callback to cache the built model
 */
async function handlePlayer(elo, playerModel, line, rho, setPlayerModel) {
  const parts = line.split(/\s+(?:vs?|v\.?|-)\s+/i);
  if (parts.length !== 2) {
    console.log('  Usage: player <team1> vs <team2>');
    return;
  }
  const teamA = resolveTeam(parts[0].trim());
  const teamB = resolveTeam(parts[1].trim());
  if (!teamA || !teamB) {
    const unknown = !teamA ? parts[0].trim() : parts[1].trim();
    console.log(`  Unknown team: "${unknown}". Type "teams" to list valid teams.`);
    return;
  }
  if (teamA === teamB) {
    console.log('  Please pick two different teams.');
    return;
  }

  // Build the player model on first use; cache for subsequent calls.
  let pm = playerModel;
  if (!pm) {
    try {
      console.log('  Loading player model (first use — may download ~3 MB) ...');
      pm = await buildPlayerModel({ log: (m) => console.log('  ' + m) });
      setPlayerModel(pm);
    } catch (e) {
      console.log(`  Player model unavailable: ${e.message}`);
      console.log('  Falling back to standard Elo prediction.\n');
      printPrediction(elo, teamA, teamB, rho);
      return;
    }
  }

  printPlayerPrediction(elo, pm, teamA, teamB, rho);
}

/**
 * Render a player-model head-to-head prediction (experimental).
 *
 * Shows the standard Elo/Dixon-Coles baseline alongside the player-adjusted
 * prediction so the user can directly compare the two models.
 */
function printPlayerPrediction(elo, playerModel, teamA, teamB, rho) {
  const hostA = HOSTS.has(teamA);
  const hostB = HOSTS.has(teamB);
  const MAX_GOALS = 10;

  // Standard Elo prediction (baseline).
  const base = predictMatch(elo.getRating(teamA), elo.getRating(teamB), hostA, hostB, rho);

  // Player-adjusted lambdas.
  const pr = playerModel.predictMatchPlayerBased(
    elo.getRating(teamA),
    elo.getRating(teamB),
    teamA,
    teamB,
    hostA,
    hostB,
    expectedGoals
  );

  // Compute win/draw/loss from the player-adjusted lambdas using the same
  // Dixon-Coles joint probability matrix already imported.
  const adjProbs = jointProbabilityMatrix(pr.lambdaA, pr.lambdaB, rho, MAX_GOALS);
  let pWin = 0, pDraw = 0, pLoss = 0;
  let bestAdj = { p: -1, a: 0, b: 0 };
  const n = MAX_GOALS + 1;
  for (let k = 0; k < adjProbs.length; k++) {
    const i = Math.floor(k / n);
    const j = k % n;
    const p = adjProbs[k];
    if (i > j) pWin += p;
    else if (i === j) pDraw += p;
    else pLoss += p;
    if (p > bestAdj.p) bestAdj = { p, a: i, b: j };
  }

  const top5 = (arr) =>
    arr.length > 0
      ? arr.slice(0, 5).map((p) => p.name).join(', ')
      : '(no data)';

  const W = 60;
  const SEP = '  ' + '-'.repeat(W);
  const HDR = '  ' + '='.repeat(W);

  console.log('');
  console.log(`  [EXPERIMENTAL] Player-level xG — ${teamA}  vs  ${teamB}`);
  console.log(HDR);
  console.log(`  Blend: ${(PLAYER_BLEND * 100).toFixed(0)}% player data · ${((1 - PLAYER_BLEND) * 100).toFixed(0)}% Elo`);
  console.log(SEP);

  const col1 = 'Elo baseline';
  const col2 = 'Player-adjusted';
  console.log(`  ${''.padEnd(22)}${col1.padStart(14)}${col2.padStart(16)}`);
  console.log(SEP);
  console.log(`  ${'Expected goals:'.padEnd(22)}${''.padStart(14)}${''.padStart(16)}`);
  console.log(`  ${'  ' + teamA + ':'.padEnd(20)}${base.xgA.toFixed(2).padStart(14)}${pr.lambdaA.toFixed(2).padStart(16)}`);
  console.log(`  ${'  ' + teamB + ':'.padEnd(20)}${base.xgB.toFixed(2).padStart(14)}${pr.lambdaB.toFixed(2).padStart(16)}`);
  console.log(SEP);
  console.log(`  ${(teamA + ' win:').padEnd(22)}${(pct(base.pWin) + '%').padStart(14)}${(pct(pWin) + '%').padStart(16)}`);
  console.log(`  ${'Draw:'.padEnd(22)}${(pct(base.pDraw) + '%').padStart(14)}${(pct(pDraw) + '%').padStart(16)}`);
  console.log(`  ${(teamB + ' win:').padEnd(22)}${(pct(base.pLoss) + '%').padStart(14)}${(pct(pLoss) + '%').padStart(16)}`);
  console.log(SEP);
  console.log(`  Elo most likely score    : ${teamA} ${base.scoreline[0]}-${base.scoreline[1]} ${teamB}`);
  console.log(`  Player most likely score : ${teamA} ${bestAdj.a}-${bestAdj.b} ${teamB}`);
  console.log(SEP);
  console.log(`  ${teamA} key players : ${top5(pr.playersA)}`);
  console.log(`  ${teamB} key players : ${top5(pr.playersB)}`);
  console.log(`  Attack multipliers — ${teamA}: ×${pr.mulA.attack.toFixed(3)}, ${teamB}: ×${pr.mulB.attack.toFixed(3)}`);
  if (hostA || hostB) console.log('  (host-nation home advantage applied)');
  console.log(HDR);
  console.log('  Note: only historical goals scored are used as a proxy for player quality.');
  console.log('  Defensive ratings are approximated. Results are for exploration only.');
  console.log('');
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

/** Load previous command history from disk. */
function loadHistory() {
  try {
    const text = fs.readFileSync(HISTORY_FILE, 'utf8');
    return text.split('\n').filter((line) => line.trim()).slice(-HISTORY_SIZE);
  } catch (e) {
    return [];
  }
}

/** Append a command to the persistent history file. */
function appendHistory(line) {
  if (!line || !line.trim()) return;
  try {
    const existing = loadHistory();
    const updated = existing.filter((h) => h !== line.trim());
    updated.push(line.trim());
    const keep = updated.slice(-HISTORY_SIZE);
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.writeFileSync(HISTORY_FILE, keep.join('\n') + '\n');
  } catch (e) {
    // History is best-effort; ignore write failures.
  }
}

function startPrompt(elo, odds, rho, favorites, bracket, initialPlayerModel, initialPenaltyModel) {
  const history = loadHistory();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    history,
    historySize: HISTORY_SIZE,
  });
  rl.setPrompt('> ');
  console.log('Type "help" for commands, "quit" to exit.');

  const queue = [];
  let busy = false;
  let closeRequested = false;
  // Player model is loaded lazily on first `player` command; cache it here.
  let cachedPlayerModel = initialPlayerModel || null;
  // Penalty model is loaded lazily on first `penalty` command; cache it here.
  let cachedPenaltyModel = initialPenaltyModel || null;

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
    else if (lower === 'titles' || lower === 'odds') printTitleTable(odds, new Set(favorites));
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
          penaltyModel: cachedPenaltyModel,
        });
        process.stdout.write('\r' + ' '.repeat(40) + '\r');
        printTitleTable(liveOdds, new Set(favorites));
      } catch (e) {
        console.log(`  Live error: ${e.message}`);
      }
    }
    else if (lower.startsWith('penalty') || lower.startsWith('shootout')) {
      const keyword = lower.startsWith('penalty') ? 'penalty' : 'shootout';
      const rest = line.slice(keyword.length).trim();
      try {
        await handlePenalty(elo, cachedPenaltyModel, rest, (pm) => { cachedPenaltyModel = pm; });
      } catch (e) {
        console.log(`  Penalty error: ${e.message}`);
      }
    }
    else if (lower.startsWith('lineups')) {
      const rest = line.slice('lineups'.length).trim();
      try {
        await handleLineups(elo, rest, rho);
      } catch (e) {
        console.log(`  Lineups error: ${e.message}`);
      }
    }
    else if (lower.startsWith('player')) {
      const rest = line.slice('player'.length).trim();
      try {
        await handlePlayer(elo, cachedPlayerModel, rest, rho, (pm) => { cachedPlayerModel = pm; });
      } catch (e) {
        console.log(`  Player model error: ${e.message}`);
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
    appendHistory(line);
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
  const cliArgs = parseArgs(process.argv.slice(2));
  const configFile = cliArgs.noConfig ? {} : loadConfig();
  const settings = mergeConfig({ config: configFile, overrides: cliArgs });

  const iterations = Number.isFinite(settings.sims) && settings.sims > 0 ? Math.floor(settings.sims) : 10000;
  const seed = settings.seed || undefined;
  const resume = cliArgs.resume;
  const rho = settings.rho !== undefined ? settings.rho : undefined;
  const outputFormat = settings.format || 'table';
  const favorites = Array.isArray(settings.favorites) ? settings.favorites : [];

  console.log('Polycup — 2026 FIFA World Cup predictor');
  console.log(DISCLAIMER);
  console.log('');

  const log = (msg) => console.log(msg);
  const elo = await buildEloModel({ log });
  log(`Computed Elo ratings from ${elo.matchCount.toLocaleString()} historical matches.`);

  // Build the penalty shootout model on a best-effort basis. It is small (~50 KB)
  // and improves every knockout tie-break. If the download/cache fails, the
  // simulation transparently falls back to the Elo-damped shootout estimate.
  let penaltyModel = null;
  try {
    penaltyModel = await buildPenaltyModel({ elo, log: (m) => console.log('  ' + m) });
  } catch (e) {
    log(`Penalty shootout model unavailable: ${e.message}`);
    log('Falling back to Elo-damped penalty shootouts.');
  }

  const effectiveRho = rho !== undefined ? rho : await estimateRhoFromDataset(elo, expectedGoals, { log });

  log(`Running ${iterations.toLocaleString()} tournament simulations ${seed ? `(seed=${seed}) ` : ''}...`);
  const { odds, bracket } = runMonteCarloDetailed(elo, iterations, {
    rho: effectiveRho,
    seed,
    penaltyModel,
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
    const out = toJSON({ odds, elo, rho: effectiveRho });
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
      generateReportHTML({ odds, elo, rho: effectiveRho, modelText: MODEL_TEXT }));
    return;
  }

  // Config-driven compact JSON output (no interactive prompt).
  if (outputFormat === 'json') {
    printTitleJson(odds, favorites);
    return;
  }

  printTitleTable(odds, new Set(favorites));
  // Pass null for the player model — it will be built lazily on first `player` command.
  // Pass the pre-built penalty model so the `live` command can use it too.
  startPrompt(elo, odds, effectiveRho, favorites, bracket, null, penaltyModel);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
