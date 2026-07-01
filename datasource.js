'use strict';

/**
 * datasource.js
 *
 * ESPN public API data fetcher for live World Cup match data.
 * No authentication required — ESPN's public endpoints are open.
 *
 * Provides:
 *  - Live scoreboard (all today's WC matches)
 *  - Match summary (lineups, events, formations, stats)
 *
 * Zero third-party dependencies (uses Node.js built-in fetch).
 */

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world';

/**
 * Fetch today's World Cup scoreboard (or a specific date).
 * Returns an array of match objects with scores, status, and events.
 * @param {string} [date] - Optional date in YYYYMMDD format
 */
async function fetchScoreboard(date) {
  const url = date ? `${BASE}/scoreboard?dates=${date}` : `${BASE}/scoreboard`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN scoreboard request failed: ${res.status}`);
  const data = await res.json();
  return (data.events || []).map(parseEvent);
}

/**
 * Fetch detailed match summary (lineups, events timeline, stats).
 * @param {string} eventId - ESPN event ID (from scoreboard)
 */
async function fetchMatchSummary(eventId) {
  const url = `${BASE}/summary?event=${eventId}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN summary request failed: ${res.status}`);
  const data = await res.json();
  return parseSummary(data, eventId);
}

/**
 * Fetch all live (in-progress) World Cup matches right now.
 * Convenience wrapper that filters the scoreboard.
 */
async function fetchLiveMatches() {
  const all = await fetchScoreboard();
  return all.filter(m => m.status === 'in');
}

// --- Internal parsers --------------------------------------------------------

function parseEvent(event) {
  const comp = event.competitions?.[0] || {};
  const competitors = comp.competitors || [];
  const home = competitors.find(c => c.homeAway === 'home') || {};
  const away = competitors.find(c => c.homeAway === 'away') || {};

  const status = event.status || {};
  const state = status.type?.state || 'pre'; // pre, in, post

  // Parse match events (goals, cards, subs) from competition details
  const details = (comp.details || []).map(d => ({
    type: d.type?.text || d.type?.id || 'Unknown',
    minute: d.clock?.displayValue || '',
    player: d.athletesInvolved?.[0]?.displayName || '',
    team: d.team?.displayName || '',
  }));

  return {
    id: event.id,
    name: event.name || event.shortName,
    status: state, // 'pre', 'in', 'post'
    statusDetail: status.type?.shortDetail || status.type?.detail || '',
    clock: status.clock || 0,
    minute: parseMinute(status.type?.shortDetail || status.displayClock || ''),
    period: status.period || 0,
    home: {
      id: home.team?.id,
      name: home.team?.displayName || '',
      abbr: home.team?.abbreviation || '',
      score: parseInt(home.score, 10) || 0,
    },
    away: {
      id: away.team?.id,
      name: away.team?.displayName || '',
      abbr: away.team?.abbreviation || '',
      score: parseInt(away.score, 10) || 0,
    },
    events: details,
    venue: comp.venue?.fullName || '',
  };
}

function parseSummary(data, eventId) {
  // Lineups / rosters
  const rosters = (data.rosters || []).map(r => ({
    team: r.team?.displayName || '',
    teamId: r.team?.id || '',
    formation: r.formation || '',
    starters: (r.roster || []).filter(p => p.starter).map(parsePlayer),
    subs: (r.roster || []).filter(p => !p.starter).map(parsePlayer),
  }));

  // Key events (goals, cards, subs) from keyEvents
  const keyEvents = (data.keyEvents || []).map(e => ({
    type: e.type?.text || '',
    minute: e.clock?.displayValue || '',
    player: e.participants?.[0]?.athlete?.displayName || '',
    team: e.team?.displayName || '',
  })).filter(e => e.type); // drop empty ones

  // Team statistics from boxscore
  const teamStats = (data.boxscore?.teams || []).map(t => ({
    team: t.team?.displayName || '',
    stats: (t.statistics || []).reduce((acc, s) => {
      acc[s.name] = s.displayValue || s.value;
      return acc;
    }, {}),
  }));

  // Header info (score, status)
  const header = data.header || {};
  const competitions = header.competitions || [];
  const comp = competitions[0] || {};
  const competitors = comp.competitors || [];

  return {
    eventId,
    rosters,
    keyEvents,
    teamStats,
    commentary: (data.commentary || []).slice(0, 20), // last 20 commentary items
    odds: data.odds || null,
  };
}

function parsePlayer(p) {
  const athlete = p.athlete || {};
  const pos = athlete.position || p.position || {};
  const posStr = typeof pos === 'string' ? pos : (pos.abbreviation || pos.displayName || '');
  return {
    id: athlete.id || '',
    name: athlete.displayName || athlete.shortName || '',
    position: posStr,
    jersey: athlete.jersey || '',
  };
}

/** Extract numeric minute from strings like "67'", "45'+2'", "HT", "FT" */
function parseMinute(str) {
  if (!str) return 0;
  // Handle "45'+2'" -> 47, "90'+3'" -> 93
  const addedTime = str.match(/(\d+)'\+(\d+)/);
  if (addedTime) return parseInt(addedTime[1], 10) + parseInt(addedTime[2], 10);
  const simple = str.match(/(\d+)/);
  if (simple) return parseInt(simple[1], 10);
  if (str === 'HT') return 45;
  if (str === 'FT') return 90;
  return 0;
}

module.exports = {
  fetchScoreboard,
  fetchMatchSummary,
  fetchLiveMatches,
  parseMinute,
};
