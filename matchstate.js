'use strict';

/**
 * matchstate.js
 *
 * Converts raw ESPN API data into model-friendly match state that can feed
 * into the prediction engine. Applies adjustments for:
 *  - Current score and time remaining
 *  - Red cards (reduces effective Elo for the affected team)
 *  - Recent momentum (goals in a short span)
 *  - Extra time / stoppage time awareness
 *
 * Zero third-party dependencies.
 */

// --- Constants for match state adjustments -----------------------------------

// A red card reduces a team's effective Elo by this amount.
// Research suggests a man-advantage is worth roughly +0.5 xG over 90 min.
// Scaled to Elo: roughly 60 points per red card for the remaining time.
const RED_CARD_ELO_PENALTY = 60;

// Goals scored in the last N minutes increase team momentum.
const MOMENTUM_WINDOW = 10; // minutes

// Momentum bonus: a goal in the last 10 min gives +15 Elo to that team's
// effective rating (captures psychological pressure / fatigue effects).
const MOMENTUM_BONUS_PER_GOAL = 15;

// --- Main state builder ------------------------------------------------------

/**
 * Build a normalized match state from ESPN scoreboard event and optional summary.
 *
 * @param {object} event - Parsed event from datasource.fetchScoreboard()
 * @param {object} [summary] - Optional parsed summary from datasource.fetchMatchSummary()
 * @returns {object} Match state for the prediction engine
 */
function buildMatchState(event, summary = null) {
  const minute = event.minute || 0;
  const homeScore = event.home.score;
  const awayScore = event.away.score;

  // Count red cards from match events
  const redCards = countRedCards(event.events);

  // Count recent goals for momentum
  const momentum = computeMomentum(event.events, minute);

  // Extract lineups from summary if available
  const lineups = summary ? extractLineups(summary) : null;

  // Compute Elo adjustments based on match state
  const eloAdjustments = computeEloAdjustments(redCards, momentum, minute);

  return {
    // Core state
    minute,
    homeScore,
    awayScore,
    status: event.status, // 'pre', 'in', 'post'
    statusDetail: event.statusDetail,
    period: event.period,

    // Team info
    home: event.home.name,
    away: event.away.name,
    homeAbbr: event.home.abbr,
    awayAbbr: event.away.abbr,

    // Adjustments for prediction engine
    eloAdjustments,
    redCards,
    momentum,

    // Rich data (if summary available)
    lineups,
    events: event.events,

    // Derived
    isExtraTime: minute > 90,
    isFirstHalf: minute <= 45,
    isSecondHalf: minute > 45 && minute <= 90,
    minutesRemaining: Math.max(0, 90 - minute),
    timeFraction: Math.min(1, minute / 90),
  };
}

/**
 * Count red cards per team from event list.
 * @returns {{ home: number, away: number }}
 */
function countRedCards(events) {
  const result = { home: 0, away: 0 };
  for (const e of events) {
    const type = (e.type || '').toLowerCase();
    if (type.includes('red card') || type === 'red card') {
      // We determine side by the team name, but since we may not have full
      // context here, we'll count them generically and map them in buildMatchState
      result[e._side || 'home']++;
    }
  }
  return result;
}

/**
 * Classify events by home/away side given team names.
 */
function classifyEvents(events, homeName, awayName) {
  return events.map(e => {
    let side = 'unknown';
    if (e.team) {
      const t = e.team.toLowerCase();
      if (t === homeName.toLowerCase() || homeName.toLowerCase().includes(t)) side = 'home';
      else if (t === awayName.toLowerCase() || awayName.toLowerCase().includes(t)) side = 'away';
    }
    return { ...e, _side: side };
  });
}

/**
 * Compute momentum based on recent goals.
 * @returns {{ home: number, away: number }} - Number of recent goals per side
 */
function computeMomentum(events, currentMinute) {
  const result = { home: 0, away: 0 };
  for (const e of events) {
    const type = (e.type || '').toLowerCase();
    if (!type.includes('goal') || type.includes('own goal')) continue;
    const eventMinute = parseEventMinute(e.minute);
    if (eventMinute > 0 && currentMinute - eventMinute <= MOMENTUM_WINDOW) {
      const side = e._side || 'home';
      if (side === 'home' || side === 'away') result[side]++;
    }
  }
  return result;
}

/**
 * Compute Elo adjustments based on current match state.
 * These get added to team Elo ratings before computing conditional predictions.
 *
 * @returns {{ home: number, away: number }} - Elo adjustment for each team
 */
function computeEloAdjustments(redCards, momentum, minute) {
  // Time scaling: red cards / momentum matter more with more time remaining
  const timeRemaining = Math.max(0, 90 - minute) / 90;

  let homeAdj = 0;
  let awayAdj = 0;

  // Red card penalty (scaled by remaining time)
  homeAdj -= redCards.home * RED_CARD_ELO_PENALTY * timeRemaining;
  awayAdj -= redCards.away * RED_CARD_ELO_PENALTY * timeRemaining;

  // Momentum bonus
  homeAdj += momentum.home * MOMENTUM_BONUS_PER_GOAL;
  awayAdj += momentum.away * MOMENTUM_BONUS_PER_GOAL;

  return { home: homeAdj, away: awayAdj };
}

/**
 * Extract lineups from summary data into a simple format.
 */
function extractLineups(summary) {
  if (!summary.rosters || summary.rosters.length < 2) return null;
  return summary.rosters.map(r => ({
    team: r.team,
    formation: r.formation,
    starters: r.starters,
    subs: r.subs,
  }));
}

/** Parse "67'" or "45'+2'" into a number */
function parseEventMinute(str) {
  if (!str) return 0;
  const added = str.match(/(\d+)'\+(\d+)/);
  if (added) return parseInt(added[1], 10) + parseInt(added[2], 10);
  const simple = str.match(/(\d+)/);
  return simple ? parseInt(simple[1], 10) : 0;
}

/**
 * Enrich an event list with side classification, then rebuild the match state.
 * Call this to get properly classified events before building state.
 */
function enrichMatchState(event, summary = null) {
  const classified = classifyEvents(event.events, event.home.name, event.away.name);
  const enrichedEvent = { ...event, events: classified };

  // Recount red cards with proper sides
  const redCards = { home: 0, away: 0 };
  for (const e of classified) {
    const type = (e.type || '').toLowerCase();
    if (type.includes('red card')) {
      if (e._side === 'home') redCards.home++;
      else if (e._side === 'away') redCards.away++;
    }
  }

  const state = buildMatchState(enrichedEvent, summary);
  state.redCards = redCards;
  state.eloAdjustments = computeEloAdjustments(
    redCards,
    computeMomentum(classified, event.minute),
    event.minute
  );
  return state;
}

module.exports = {
  buildMatchState,
  enrichMatchState,
  classifyEvents,
  countRedCards,
  computeMomentum,
  computeEloAdjustments,
  RED_CARD_ELO_PENALTY,
  MOMENTUM_BONUS_PER_GOAL,
  MOMENTUM_WINDOW,
};
