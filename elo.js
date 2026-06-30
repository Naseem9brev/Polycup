'use strict';

/**
 * elo.js
 *
 * Downloads (and caches) the martj42/international_results dataset, replays
 * every played match in chronological order, and computes an Elo strength
 * rating for every national team. Ratings are weighted by match importance,
 * goal margin and home advantage.
 *
 * Zero third-party dependencies: uses Node's built-in fetch + fs and a small
 * hand-rolled CSV parser.
 */

const fs = require('fs');
const path = require('path');
const { datasetName } = require('./worldcup2026');

const RESULTS_URL =
  'https://raw.githubusercontent.com/martj42/international_results/master/results.csv';
const CACHE_FILE = path.join(process.cwd(), '.cache_results.csv');

// --- Elo tuning constants -------------------------------------------------
const BASE_RATING = 1000; // every team starts here
const HOME_ADVANTAGE = 65; // rating points added to the home side (non-neutral)

// Match-importance K factors (World Cup > continental > qualifiers > friendly).
const K_WORLD_CUP = 60;
const K_CONTINENTAL = 50;
const K_NATIONS_LEAGUE = 45;
const K_QUALIFIER = 40;
const K_OTHER = 30;
const K_FRIENDLY = 20;

// Continental championship finals (not qualifiers — those are handled first).
const CONTINENTAL_FINALS = [
  'UEFA Euro',
  'Copa América',
  'Copa America',
  'African Cup of Nations',
  'AFC Asian Cup',
  'Gold Cup',
  'CONCACAF Championship',
  'Oceania Nations Cup',
  'Confederations Cup',
];

/** Classify a tournament string into a base K factor. */
function importanceK(tournament) {
  const t = tournament || '';
  if (/qualification/i.test(t)) return K_QUALIFIER;
  if (/World Cup/i.test(t)) return K_WORLD_CUP;
  for (const name of CONTINENTAL_FINALS) {
    if (t.includes(name)) return K_CONTINENTAL;
  }
  if (/Nations League/i.test(t)) return K_NATIONS_LEAGUE;
  if (/^Friendly$/i.test(t)) return K_FRIENDLY;
  return K_OTHER;
}

/**
 * Goal-difference multiplier (World Football Elo style): bigger wins move
 * ratings more, with diminishing returns for blowouts.
 */
function goalMultiplier(goalDiff) {
  const gd = Math.abs(goalDiff);
  if (gd <= 1) return 1;
  if (gd === 2) return 1.5;
  return (11 + gd) / 8;
}

/** Parse a single CSV line, honoring double-quoted fields. */
function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

/** Download the dataset to the cache file (returns the raw text). */
async function download() {
  if (typeof fetch !== 'function') {
    throw new Error('Global fetch is unavailable; please use Node.js >= 18.');
  }
  const res = await fetch(RESULTS_URL);
  if (!res.ok) {
    throw new Error(`Failed to download results.csv (HTTP ${res.status}).`);
  }
  const text = await res.text();
  fs.writeFileSync(CACHE_FILE, text);
  return text;
}

/** Load the dataset from cache, downloading it on first run. */
async function loadResults({ log = () => {} } = {}) {
  if (fs.existsSync(CACHE_FILE)) {
    log(`Loading cached results from ${path.basename(CACHE_FILE)} ...`);
    return fs.readFileSync(CACHE_FILE, 'utf8');
  }
  log('No cache found. Downloading historical results (first run only) ...');
  const text = await download();
  log(`Downloaded and cached ${path.basename(CACHE_FILE)}.`);
  return text;
}

/**
 * Parse the CSV text into match records, skipping the header and any fixture
 * that has not been played yet (NA / blank scores).
 */
function parseMatches(text) {
  const lines = text.split(/\r?\n/);
  const matches = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const f = parseCsvLine(line);
    if (f.length < 9) continue;
    const [date, home, away, hs, as, tournament, , , neutral] = f;
    if (hs === 'NA' || as === 'NA' || hs === '' || as === '') continue; // not played
    const homeScore = Number(hs);
    const awayScore = Number(as);
    if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) continue;
    matches.push({
      date,
      home,
      away,
      homeScore,
      awayScore,
      tournament,
      neutral: String(neutral).trim().toUpperCase() === 'TRUE',
    });
  }
  // Dataset is already chronological, but sort defensively (oldest -> newest).
  matches.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return matches;
}

/** Replay all matches and return a { teamName: rating } map. */
function computeRatings(matches, beforeDate = null) {
  const ratings = Object.create(null);
  const get = (team) => (team in ratings ? ratings[team] : BASE_RATING);

  for (const m of matches) {
    if (beforeDate && m.date >= beforeDate) continue;
    const rHome = get(m.home);
    const rAway = get(m.away);
    const homeBoost = m.neutral ? 0 : HOME_ADVANTAGE;

    // Expected result for the home team.
    const expHome = 1 / (1 + Math.pow(10, (rAway - (rHome + homeBoost)) / 400));

    // Actual result for the home team.
    let actualHome;
    if (m.homeScore > m.awayScore) actualHome = 1;
    else if (m.homeScore < m.awayScore) actualHome = 0;
    else actualHome = 0.5;

    const K = importanceK(m.tournament);
    const G = goalMultiplier(m.homeScore - m.awayScore);
    const delta = K * G * (actualHome - expHome);

    ratings[m.home] = rHome + delta;
    ratings[m.away] = rAway - delta;
  }
  return ratings;
}

/**
 * Build the Elo model. Returns an object exposing rating lookups by display
 * name (via the worldcup2026 name mapping) plus the raw ratings table.
 */
async function buildEloModel(options = {}) {
  const text = await loadResults(options);
  const matches = parseMatches(text);
  const ratings = computeRatings(matches, options.beforeDate);

  /** Current Elo rating for a team by its display name. */
  function getRating(displayName) {
    const dsName = datasetName(displayName);
    return dsName in ratings ? ratings[dsName] : BASE_RATING;
  }

  return {
    getRating,
    ratings,
    matchCount: matches.length,
    BASE_RATING,
  };
}

module.exports = {
  buildEloModel,
  loadResults,
  parseMatches,
  importanceK,
  goalMultiplier,
  parseCsvLine,
  CACHE_FILE,
  BASE_RATING,
};
