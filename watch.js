'use strict';

/**
 * watch.js
 *
 * Live match watcher. Polls ESPN for real-time match data, feeds it through
 * the prediction engine, and displays continuously updating win probabilities
 * and predicted final score in the terminal.
 *
 * Usage from the interactive prompt:
 *   > watch                     (shows live matches to pick from)
 *   > watch USA vs Mexico       (attaches to that specific match)
 *
 * The display auto-refreshes every 30 seconds (or when an event is detected).
 * Press 'q' or Ctrl+C to exit watch mode and return to the prompt.
 *
 * Zero third-party dependencies.
 */

const { fetchScoreboard, fetchMatchSummary, fetchLiveMatches } = require('./datasource');
const { enrichMatchState } = require('./matchstate');
const { predictMidMatch, expectedGoals, HOSTS } = require('./simulation');
const { resolveTeam } = require('./worldcup2026');

const POLL_INTERVAL = 30000; // 30 seconds between polls
const DISPLAY_WIDTH = 60;

// --- Watch mode entry points -------------------------------------------------

/**
 * Start watch mode for a specific match.
 * Polls ESPN, updates predictions, renders to terminal.
 *
 * @param {string} teamA - Home team display name
 * @param {string} teamB - Away team display name
 * @param {object} elo - Elo model from buildEloModel()
 * @param {number} rho - Dixon-Coles rho
 * @param {object} [opts] - Options
 * @param {function} [opts.onExit] - Called when user exits watch mode
 */
async function startWatch(teamA, teamB, elo, rho, opts = {}) {
  const { onExit } = opts;

  console.log('');
  console.log(`  Entering watch mode: ${teamA} vs ${teamB}`);
  console.log(`  Polling ESPN every ${POLL_INTERVAL / 1000}s for live updates.`);
  console.log('  Press q + Enter to exit watch mode.');
  console.log('');

  let running = true;
  let lastEventCount = 0;
  let pollCount = 0;

  // Initial fetch
  await pollAndRender(teamA, teamB, elo, rho);
  pollCount++;

  // Set up polling interval
  const interval = setInterval(async () => {
    if (!running) return;
    try {
      const result = await pollAndRender(teamA, teamB, elo, rho);
      pollCount++;
      // If match is over, stop polling
      if (result && result.status === 'post') {
        console.log('');
        console.log('  Match has ended. Exiting watch mode.');
        running = false;
        clearInterval(interval);
        if (onExit) onExit();
      }
    } catch (err) {
      console.log(`  [poll error: ${err.message}]`);
    }
  }, POLL_INTERVAL);

  // Return a stop function for the caller to use
  return {
    stop() {
      running = false;
      clearInterval(interval);
    },
    isRunning() { return running; },
  };
}

/**
 * Show all live/today's matches and let the user pick one.
 * Returns a formatted list string.
 */
async function listWatchableMatches() {
  const matches = await fetchScoreboard();
  if (matches.length === 0) {
    return { text: '  No World Cup matches today.', matches: [] };
  }

  let text = '\n  Today\'s World Cup matches:\n';
  text += '  ' + '-'.repeat(DISPLAY_WIDTH) + '\n';

  const watchable = [];
  matches.forEach((m, i) => {
    const statusIcon = m.status === 'in' ? ' LIVE' :
                       m.status === 'post' ? '   FT' : '  PRE';
    const score = m.status === 'pre' ? 'vs' : `${m.home.score}-${m.away.score}`;
    const minute = m.status === 'in' ? ` ${m.minute}'` : '';

    text += `  ${String(i + 1).padStart(2)}. ${statusIcon} ${m.home.name.padEnd(20)} ${score.padStart(5)} ${m.away.name.padEnd(20)}${minute}\n`;
    watchable.push(m);
  });

  text += '  ' + '-'.repeat(DISPLAY_WIDTH) + '\n';
  text += '  Use "watch <team1> vs <team2>" to attach to a match.\n';

  return { text, matches: watchable };
}

// --- Core poll + render logic ------------------------------------------------

async function pollAndRender(teamA, teamB, elo, rho) {
  // Fetch current scoreboard
  const matches = await fetchScoreboard();

  // Find the target match
  const match = findMatch(matches, teamA, teamB);
  if (!match) {
    console.log(`  Match ${teamA} vs ${teamB} not found in today's scoreboard.`);
    console.log('  It may not have started yet or is on a different day.');
    return null;
  }

  // Fetch detailed summary for lineups/events
  let summary = null;
  if (match.status === 'in' || match.status === 'post') {
    try {
      summary = await fetchMatchSummary(match.id);
    } catch (e) {
      // Summary fetch failed, proceed with basic data
    }
  }

  // Build enriched match state
  const state = enrichMatchState(match, summary);

  // Run prediction
  const eloA = elo.getRating(teamA) + state.eloAdjustments.home;
  const eloB = elo.getRating(teamB) + state.eloAdjustments.away;
  const hostA = HOSTS.has(teamA);
  const hostB = HOSTS.has(teamB);

  const prediction = predictMidMatch(eloA, eloB, [state.homeScore, state.awayScore], state.minute, {
    hostA, hostB, knockout: false, rho,
  });

  // Render the display
  renderWatchDisplay(state, prediction, teamA, teamB, elo, summary);

  return { status: match.status };
}

function findMatch(matches, teamA, teamB) {
  // Try exact match (either direction)
  const nameA = teamA.toLowerCase();
  const nameB = teamB.toLowerCase();

  return matches.find(m => {
    const h = m.home.name.toLowerCase();
    const a = m.away.name.toLowerCase();
    return (h.includes(nameA) && a.includes(nameB)) ||
           (h.includes(nameB) && a.includes(nameA));
  });
}

// --- Terminal rendering ------------------------------------------------------

function renderWatchDisplay(state, prediction, teamA, teamB, elo, summary) {
  // Clear previous output and redraw
  const lines = [];

  lines.push('');
  lines.push('  ' + '='.repeat(DISPLAY_WIDTH));
  lines.push(`  POLYCUP LIVE  |  ${new Date().toLocaleTimeString()}`);
  lines.push('  ' + '='.repeat(DISPLAY_WIDTH));

  // Score header
  const minuteStr = state.status === 'in' ? `  ${state.minute}'` :
                    state.status === 'post' ? '  FT' : '  PRE';
  lines.push('');
  lines.push(`  ${teamA.padEnd(20)} ${String(state.homeScore)} - ${String(state.awayScore)} ${teamB.padStart(20)}`);
  lines.push(`  ${' '.repeat(20)} ${minuteStr}`);

  // Formation info if available
  if (summary && summary.rosters && summary.rosters.length >= 2) {
    const fmtA = summary.rosters[0].formation || '?';
    const fmtB = summary.rosters[1].formation || '?';
    lines.push(`  ${fmtA.padEnd(20)}       ${fmtB.padStart(20)}`);
  }

  lines.push('');
  lines.push('  ' + '-'.repeat(DISPLAY_WIDTH));

  // Win probabilities with visual bars
  lines.push('  Predicted outcome:');
  lines.push(`    ${teamA} win:  ${renderBar(prediction.pWin)} ${(prediction.pWin * 100).toFixed(1)}%`);
  lines.push(`    Draw:        ${renderBar(prediction.pDraw)} ${(prediction.pDraw * 100).toFixed(1)}%`);
  lines.push(`    ${teamB} win:  ${renderBar(prediction.pLoss)} ${(prediction.pLoss * 100).toFixed(1)}%`);

  lines.push('');

  // Predicted final score
  const [predA, predB] = prediction.predictedFinal;
  lines.push(`  Predicted final: ${teamA} ${predA}-${predB} ${teamB}`);

  // Top 3 most likely final scores
  if (prediction.scoreDist.length > 1) {
    lines.push('  Most likely scores:');
    prediction.scoreDist.slice(0, 5).forEach(s => {
      lines.push(`    ${s.score[0]}-${s.score[1]}  (${(s.prob * 100).toFixed(1)}%)`);
    });
  }

  // Remaining xG
  if (state.status === 'in') {
    lines.push('');
    lines.push(`  Remaining xG: ${teamA} ${prediction.xgRemA.toFixed(2)} - ${prediction.xgRemB.toFixed(2)} ${teamB}`);
  }

  // Red cards / adjustments
  if (state.redCards.home > 0 || state.redCards.away > 0) {
    lines.push('');
    const cards = [];
    if (state.redCards.home > 0) cards.push(`${teamA}: ${state.redCards.home} red`);
    if (state.redCards.away > 0) cards.push(`${teamB}: ${state.redCards.away} red`);
    lines.push(`  Red cards: ${cards.join(', ')}`);
  }

  // Recent events
  if (state.events.length > 0) {
    lines.push('');
    lines.push('  Match events:');
    // Show last 8 events
    const recentEvents = state.events.slice(-8);
    for (const e of recentEvents) {
      const icon = getEventIcon(e.type);
      lines.push(`    ${e.minute.padEnd(6)} ${icon} ${e.player || ''} ${e.team ? '(' + e.team + ')' : ''}`);
    }
  }

  lines.push('');
  lines.push('  ' + '='.repeat(DISPLAY_WIDTH));
  lines.push(`  Next update in ${POLL_INTERVAL / 1000}s | Press q + Enter to exit`);
  lines.push('');

  // Clear screen and print (use ANSI escape to move cursor up)
  process.stdout.write('\x1B[2J\x1B[H'); // clear screen, cursor to top
  console.log(lines.join('\n'));
}

function renderBar(probability) {
  const width = 20;
  const filled = Math.round(probability * width);
  return '[' + '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled) + ']';
}

function getEventIcon(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('goal')) return '\u26BD';
  if (t.includes('yellow')) return '\uD83D\uDFE8';
  if (t.includes('red')) return '\uD83D\uDFE5';
  if (t.includes('subst')) return '\u21C4';
  if (t.includes('var')) return '\uD83D\uDCFA';
  return '\u2022';
}

module.exports = {
  startWatch,
  listWatchableMatches,
  POLL_INTERVAL,
};
