'use strict';

/**
 * context.js
 *
 * Phase 14 — Match context adjustments for the 2026 FIFA World Cup.
 *
 * Adjusts a team's effective Elo before a match based on physical and tournament
 * context factors:
 *   - rest days (fatigue)
 *   - travel distance and time-zone shifts
 *   - altitude acclimation
 *   - venue-level host advantage
 *   - climate / heat (lightweight, optional)
 *
 * The adjustments are intentionally small (a few to a few dozen Elo points) so
 * they nudge the model without overwhelming the underlying Elo rating.
 *
 * Zero third-party dependencies.
 */

const fs = require('fs');
const path = require('path');

// --- Reverse map dataset names -> display names ------------------------------
const DATASET_TO_DISPLAY = {};
for (const [display, dataset] of Object.entries({
  USA: 'United States',
  'Bosnia & Herzegovina': 'Bosnia and Herzegovina',
})) {
  DATASET_TO_DISPLAY[dataset] = display;
}
function displayName(datasetName) {
  return DATASET_TO_DISPLAY[datasetName] || datasetName;
}

// --- Tunable constants -------------------------------------------------------

// Rest-day fatigue curve. World Cup group matches are typically spaced 4-5
// days apart. Fewer than 3 days is a clear penalty; 6+ days is neutral.
const REST_DAY_PENALTIES = [
  { days: 2, penalty: -35 },
  { days: 3, penalty: -20 },
  { days: 4, penalty: -8 },
  { days: 5, penalty: -3 },
  { days: 6, penalty: 0 },
];

// Travel distance (haversine) thresholds. Penalties are asymmetric: both teams
// pay for long flights, but the team that travelled farther pays a bit more.
const TRAVEL_KM_PENALTIES = [
  { km: 2000, penalty: -2 },
  { km: 4000, penalty: -6 },
  { km: 6000, penalty: -12 },
  { km: 9000, penalty: -20 },
];
const TRAVEL_GAP_PENALTY_PER_KM = -0.003; // extra for the team that travelled farther
const TRAVEL_GAP_MAX = -15;

// Time-zone shift. Each hour away from home costs a little, capped.
const TIMEZONE_HOUR_PENALTY = -1.5;
const TIMEZONE_MAX_PENALTY = -12;

// Altitude. Thresholds in meters.
const ALTITUDE_THRESHOLD_HIGH = 1500; // venues above this are "high"
const ALTITUDE_THRESHOLD_EXTREME = 2000; // venues above this are "extreme"
const TEAM_ACCLIMATED_ALT = 1500; // teams from bases above this are considered acclimated

const ALTITUDE_BONUSES = [
  { venue: 1500, acclimated: 0, unacclimated: -10 },
  { venue: 2000, acclimated: +5, unacclimated: -25 },
  { venue: 2500, acclimated: +10, unacclimated: -40 },
];

// Venue-level host advantage (complements the existing HOST_ELO_BONUS).
const HOST_VENUE_SAME_COUNTRY_BONUS = 18;
const HOST_VENUE_HOST_COUNTRY_BONUS = 5; // another host country (e.g., USA in Mexico)

// Lightweight climate/heat adjustment. Teams from cold/wet climates suffer a
// little in hot/humid venues; teams from hot climates get a tiny bonus.
const HEAT_VENUE_THRESHOLD = 26; // average summer high (Celsius) considered hot
const HEAT_TEAM_COLD_THRESHOLD = 12; // average home high considered cool
const HEAT_PENALTY = -8;
const HEAT_BONUS = +4;

// Cap on total absolute context adjustment per side.
const MAX_TOTAL_ADJUSTMENT = 80;

// --- 2026 World Cup venue data -----------------------------------------------
// Coordinates are approximate city-center/stadium coordinates. Timezones are
// standard offsets (UTC-x). Daylight saving time is ignored for simplicity —
// the model is interested in relative shifts, not clock time.

const VENUES = {
  'Atlanta': { city: 'Atlanta', country: 'USA', lat: 33.7490, lon: -84.3880, tz: -5, alt: 300, heat: 31 },
  'Boston': { city: 'Boston', country: 'USA', lat: 42.3601, lon: -71.0589, tz: -5, alt: 90, heat: 27 },
  'Foxborough': { city: 'Foxborough', country: 'USA', lat: 42.0653, lon: -71.2483, tz: -5, alt: 90, heat: 27 },
  'Dallas': { city: 'Dallas', country: 'USA', lat: 32.7767, lon: -96.7970, tz: -6, alt: 200, heat: 34 },
  'Arlington': { city: 'Arlington', country: 'USA', lat: 32.7357, lon: -97.1081, tz: -6, alt: 184, heat: 34 },
  'Houston': { city: 'Houston', country: 'USA', lat: 29.7604, lon: -95.3698, tz: -6, alt: 15, heat: 34 },
  'Kansas City': { city: 'Kansas City', country: 'USA', lat: 39.0997, lon: -94.5786, tz: -6, alt: 260, heat: 31 },
  'Los Angeles': { city: 'Los Angeles', country: 'USA', lat: 34.0522, lon: -118.2437, tz: -8, alt: 22, heat: 28 },
  'Inglewood': { city: 'Inglewood', country: 'USA', lat: 33.9562, lon: -118.3531, tz: -8, alt: 22, heat: 28 },
  'Miami': { city: 'Miami', country: 'USA', lat: 25.7617, lon: -80.1918, tz: -5, alt: 2, heat: 32 },
  'Miami Gardens': { city: 'Miami Gardens', country: 'USA', lat: 25.9580, lon: -80.2369, tz: -5, alt: 2, heat: 32 },
  'New York': { city: 'New York', country: 'USA', lat: 40.7128, lon: -74.0060, tz: -5, alt: 5, heat: 28 },
  'East Rutherford': { city: 'East Rutherford', country: 'USA', lat: 40.8340, lon: -74.0971, tz: -5, alt: 5, heat: 28 },
  'Philadelphia': { city: 'Philadelphia', country: 'USA', lat: 39.9526, lon: -75.1652, tz: -5, alt: 12, heat: 29 },
  'San Francisco': { city: 'San Francisco', country: 'USA', lat: 37.7749, lon: -122.4194, tz: -8, alt: 16, heat: 22 },
  'Santa Clara': { city: 'Santa Clara', country: 'USA', lat: 37.3541, lon: -121.9552, tz: -8, alt: 20, heat: 27 },
  'Seattle': { city: 'Seattle', country: 'USA', lat: 47.6062, lon: -122.3321, tz: -8, alt: 50, heat: 23 },
  'Toronto': { city: 'Toronto', country: 'Canada', lat: 43.6510, lon: -79.3470, tz: -5, alt: 76, heat: 25 },
  'Vancouver': { city: 'Vancouver', country: 'Canada', lat: 49.2827, lon: -123.1207, tz: -8, alt: 30, heat: 21 },
  'Guadalajara': { city: 'Guadalajara', country: 'Mexico', lat: 20.6597, lon: -103.3496, tz: -6, alt: 1500, heat: 31 },
  'Zapopan': { city: 'Zapopan', country: 'Mexico', lat: 20.7236, lon: -103.3848, tz: -6, alt: 1500, heat: 31 },
  'Mexico City': { city: 'Mexico City', country: 'Mexico', lat: 19.4326, lon: -99.1332, tz: -6, alt: 2240, heat: 25 },
  'Monterrey': { city: 'Monterrey', country: 'Mexico', lat: 25.6866, lon: -100.3161, tz: -6, alt: 510, heat: 35 },
  'Guadalupe': { city: 'Guadalupe', country: 'Mexico', lat: 25.6768, lon: -100.2565, tz: -6, alt: 510, heat: 35 },
};

// Some dataset entries use the full venue name or a different spelling.
const VENUE_ALIASES = {
  'mercedes-benz stadium': 'Atlanta',
  'gillette stadium': 'Boston',
  'at&t stadium': 'Dallas',
  'nrg stadium': 'Houston',
  'arrowhead stadium': 'Kansas City',
  'sofi stadium': 'Los Angeles',
  'hard rock stadium': 'Miami',
  'metlife stadium': 'New York',
  'lincoln financial field': 'Philadelphia',
  'levi\'s stadium': 'San Francisco',
  'lumen field': 'Seattle',
  'bmo field': 'Toronto',
  'bc place': 'Vancouver',
  'estadio akron': 'Guadalajara',
  'estadio azteca': 'Mexico City',
  'estadio bbva': 'Monterrey',
};

// --- Team home bases (approximate representative city) -----------------------
// Each entry: lat, lon, timezone offset, altitude (m), average summer high (C).

const TEAM_BASES = {
  'Mexico': { lat: 19.4326, lon: -99.1332, tz: -6, alt: 2240, heat: 25 },
  'South Africa': { lat: -26.2041, lon: 28.0473, tz: 2, alt: 1753, heat: 20 },
  'South Korea': { lat: 37.5665, lon: 126.9780, tz: 9, alt: 38, heat: 27 },
  'Czech Republic': { lat: 50.0755, lon: 14.4378, tz: 1, alt: 235, heat: 23 },
  'Canada': { lat: 43.6510, lon: -79.3470, tz: -5, alt: 76, heat: 25 },
  'Bosnia & Herzegovina': { lat: 43.8563, lon: 18.4131, tz: 1, alt: 511, heat: 25 },
  'Qatar': { lat: 25.2854, lon: 51.5310, tz: 3, alt: 25, heat: 41 },
  'Switzerland': { lat: 47.3769, lon: 8.5417, tz: 1, alt: 408, heat: 24 },
  'Brazil': { lat: -22.9068, lon: -43.1729, tz: -3, alt: 0, heat: 28 },
  'Morocco': { lat: 34.0209, lon: -6.8416, tz: 1, alt: 60, heat: 26 },
  'Haiti': { lat: 18.5944, lon: -72.3074, tz: -5, alt: 20, heat: 32 },
  'Scotland': { lat: 55.9533, lon: -3.1883, tz: 0, alt: 47, heat: 18 },
  'USA': { lat: 39.0997, lon: -94.5786, tz: -6, alt: 260, heat: 31 },
  'Paraguay': { lat: -25.2637, lon: -57.5759, tz: -4, alt: 54, heat: 25 },
  'Australia': { lat: -33.8688, lon: 151.2093, tz: 10, alt: 3, heat: 22 },
  'Turkey': { lat: 41.0082, lon: 28.9784, tz: 3, alt: 39, heat: 27 },
  'Germany': { lat: 52.5200, lon: 13.4050, tz: 1, alt: 34, heat: 23 },
  'Curaçao': { lat: 12.1696, lon: -68.9900, tz: -4, alt: 10, heat: 31 },
  'Ivory Coast': { lat: 5.3599, lon: -4.0083, tz: 0, alt: 5, heat: 30 },
  'Ecuador': { lat: -0.1807, lon: -78.4678, tz: -5, alt: 2850, heat: 19 },
  'Netherlands': { lat: 52.3676, lon: 4.9041, tz: 1, alt: -2, heat: 21 },
  'Japan': { lat: 35.6762, lon: 139.6503, tz: 9, alt: 17, heat: 26 },
  'Sweden': { lat: 59.3293, lon: 18.0686, tz: 1, alt: 0, heat: 20 },
  'Tunisia': { lat: 36.8065, lon: 10.1815, tz: 1, alt: 4, heat: 30 },
  'Belgium': { lat: 50.8476, lon: 4.3572, tz: 1, alt: 13, heat: 22 },
  'Egypt': { lat: 30.0444, lon: 31.2357, tz: 2, alt: 23, heat: 34 },
  'Iran': { lat: 35.6892, lon: 51.3890, tz: 3.5, alt: 1200, heat: 32 },
  'New Zealand': { lat: -36.8485, lon: 174.7633, tz: 12, alt: 48, heat: 20 },
  'Spain': { lat: 40.4168, lon: -3.7038, tz: 1, alt: 650, heat: 28 },
  'Cape Verde': { lat: 14.9167, lon: -23.5087, tz: -1, alt: 10, heat: 27 },
  'Saudi Arabia': { lat: 24.7136, lon: 46.6753, tz: 3, alt: 612, heat: 42 },
  'Uruguay': { lat: -34.9011, lon: -56.1645, tz: -3, alt: 43, heat: 18 },
  'France': { lat: 48.8566, lon: 2.3522, tz: 1, alt: 35, heat: 24 },
  'Senegal': { lat: 14.7167, lon: -17.4677, tz: 0, alt: 12, heat: 29 },
  'Iraq': { lat: 33.3152, lon: 44.3661, tz: 3, alt: 34, heat: 39 },
  'Norway': { lat: 59.9139, lon: 10.7522, tz: 1, alt: 5, heat: 20 },
  'Argentina': { lat: -34.6037, lon: -58.3816, tz: -3, alt: 25, heat: 17 },
  'Algeria': { lat: 36.7538, lon: 3.0588, tz: 1, alt: 0, heat: 29 },
  'Austria': { lat: 48.2082, lon: 16.3738, tz: 1, alt: 151, heat: 24 },
  'Jordan': { lat: 31.9454, lon: 35.9284, tz: 2, alt: 700, heat: 32 },
  'Portugal': { lat: 38.7223, lon: -9.1393, tz: 0, alt: 45, heat: 25 },
  'DR Congo': { lat: -4.4419, lon: 15.2663, tz: 1, alt: 240, heat: 28 },
  'Uzbekistan': { lat: 41.2995, lon: 69.2401, tz: 5, alt: 455, heat: 33 },
  'Colombia': { lat: 4.7110, lon: -74.0721, tz: -5, alt: 2640, heat: 19 },
  'England': { lat: 51.5074, lon: -0.1278, tz: 0, alt: 11, heat: 21 },
  'Croatia': { lat: 45.8150, lon: 15.9819, tz: 1, alt: 122, heat: 25 },
  'Ghana': { lat: 5.6037, lon: -0.1870, tz: 0, alt: 0, heat: 28 },
  'Panama': { lat: 8.9824, lon: -79.5199, tz: -5, alt: 0, heat: 30 },
};

const HOSTS = new Set(['USA', 'Canada', 'Mexico']);

// --- Utility functions -------------------------------------------------------

/** Normalize a string for venue lookup: lower-case, strip diacritics, trim. */
function normalizeVenue(input) {
  if (!input) return '';
  return String(input)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Resolve a venue name (city, stadium, or alias) to a VENUES entry. */
function resolveVenue(venueName) {
  if (!venueName) return null;
  const key = normalizeVenue(venueName);
  if (VENUES[key]) return VENUES[key];
  if (VENUE_ALIASES[key]) return VENUES[VENUE_ALIASES[key]];
  // Try matching keys as substrings.
  for (const [name, entry] of Object.entries(VENUES)) {
    if (key.includes(normalizeVenue(name)) || normalizeVenue(name).includes(key)) return entry;
  }
  for (const [alias, name] of Object.entries(VENUE_ALIASES)) {
    if (key.includes(normalizeVenue(alias)) || normalizeVenue(alias).includes(key)) {
      return VENUES[name];
    }
  }
  return null;
}

/** Get a team base, or a safe default if unknown. */
function getTeamBase(teamName) {
  return TEAM_BASES[teamName] || { lat: 40.0, lon: 0.0, tz: 0, alt: 100, heat: 22 };
}

/** Haversine distance between two lat/lon points in kilometers. */
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371.0;
  const toRad = (deg) => deg * (Math.PI / 180);
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/** Parse a date string into a local Date (midnight). Accepts YYYY-MM-DD. */
function parseDate(dateInput) {
  if (!dateInput) return null;
  if (dateInput instanceof Date) return dateInput;
  const d = new Date(dateInput + 'T00:00:00');
  return isNaN(d.getTime()) ? null : d;
}

/** Difference in whole days between two dates. */
function daysBetween(a, b) {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((b - a) / msPerDay);
}

/** Find the most recent fixture for a team before a given date. */
function findLastFixture(team, fixtures, beforeDate) {
  if (!Array.isArray(fixtures) || fixtures.length === 0) return null;
  const before = parseDate(beforeDate);
  let best = null;
  let bestDate = null;
  for (const f of fixtures) {
    if (!f.date || (f.home !== team && f.away !== team)) continue;
    const d = parseDate(f.date);
    if (!d || !before || d >= before) continue;
    if (!bestDate || d > bestDate) {
      bestDate = d;
      best = f;
    }
  }
  return best;
}

/** Compute rest-day adjustment for a single team. */
function restAdjustment(team, matchDate, fixtures) {
  const last = findLastFixture(team, fixtures, matchDate);
  if (!last) return 0;
  const days = daysBetween(parseDate(last.date), parseDate(matchDate));
  if (days < 0) return 0;
  // Interpolate/lookup on the penalty curve.
  for (let i = 0; i < REST_DAY_PENALTIES.length; i++) {
    if (days <= REST_DAY_PENALTIES[i].days) return REST_DAY_PENALTIES[i].penalty;
  }
  // Long rest (rust) — tiny penalty, but less than short rest.
  if (days > 14) return -3;
  return 0;
}

/** Travel distance adjustment for a team. */
function travelAdjustment(team, venue) {
  const base = getTeamBase(team);
  const dist = haversineKm(base.lat, base.lon, venue.lat, venue.lon);
  let adj = 0;
  for (const { km, penalty } of TRAVEL_KM_PENALTIES) {
    if (dist >= km) adj = penalty;
    else break;
  }
  return { adj, dist };
}

/** Time-zone shift adjustment for a team. */
function timezoneAdjustment(team, venue) {
  const base = getTeamBase(team);
  const hours = Math.abs(venue.tz - base.tz);
  return Math.max(TIMEZONE_MAX_PENALTY, hours * TIMEZONE_HOUR_PENALTY);
}

/** Altitude adjustment for a team at a venue. */
function altitudeAdjustment(team, venue) {
  const base = getTeamBase(team);
  if (venue.alt < ALTITUDE_THRESHOLD_HIGH) return 0;
  const acclimated = base.alt >= TEAM_ACCLIMATED_ALT;
  let bonus = 0;
  let penalty = 0;
  for (const { venue: v, acclimated: b, unacclimated: p } of ALTITUDE_BONUSES) {
    if (venue.alt >= v) {
      bonus = b;
      penalty = p;
    }
  }
  return acclimated ? bonus : penalty;
}

/** Venue-level host advantage adjustment. */
function hostVenueAdjustment(team, venue) {
  if (!HOSTS.has(team)) return 0;
  if (venue.country === teamToCountry(team)) return HOST_VENUE_SAME_COUNTRY_BONUS;
  // Another 2026 host country still gives a small cultural/familiarity edge.
  if (HOSTS.has(venue.country)) return HOST_VENUE_HOST_COUNTRY_BONUS;
  return 0;
}

/** Lightweight climate/heat adjustment. */
function climateAdjustment(team, venue) {
  const base = getTeamBase(team);
  if (venue.heat < HEAT_VENUE_THRESHOLD) return 0;
  if (base.heat >= venue.heat) return HEAT_BONUS; // already used to heat
  if (base.heat <= HEAT_TEAM_COLD_THRESHOLD) return HEAT_PENALTY; // cold-climate team
  return -4; // moderate discomfort
}

/** Map a team name to its country (used for host-venue matching). */
function teamToCountry(team) {
  if (team === 'USA') return 'USA';
  if (team === 'Czech Republic') return 'Czech Republic'; // not a host
  if (team === 'Bosnia & Herzegovina') return 'Bosnia & Herzegovina';
  if (team === 'DR Congo') return 'DR Congo';
  if (team === 'South Korea') return 'South Korea';
  return team;
}

// --- Public API --------------------------------------------------------------

/**
 * Compute context-based Elo adjustments for a single team at a given venue.
 *
 * @param {string} team - Canonical team name
 * @param {string|object} venue - Venue name or resolved VENUES entry
 * @param {string} matchDate - YYYY-MM-DD match date
 * @param {object[]} fixtures - Previous fixtures to compute rest days
 * @returns {object} { total, factors, restDays, distanceKm }
 */
function contextAdjustmentForTeam(team, venue, matchDate, fixtures) {
  const v = typeof venue === 'string' ? resolveVenue(venue) : venue;
  if (!v) return { total: 0, factors: {}, restDays: null, distanceKm: null };

  const rest = restAdjustment(team, matchDate, fixtures);
  const { adj: travel, dist } = travelAdjustment(team, v);
  const tz = timezoneAdjustment(team, v);
  const alt = altitudeAdjustment(team, v);
  const host = hostVenueAdjustment(team, v);
  const climate = climateAdjustment(team, v);

  let total = rest + travel + tz + alt + host + climate;
  total = Math.max(-MAX_TOTAL_ADJUSTMENT, Math.min(MAX_TOTAL_ADJUSTMENT, total));

  return {
    total,
    factors: { rest, travel, timezone: tz, altitude: alt, hostVenue: host, climate },
    restDays: findLastFixture(team, fixtures, matchDate)
      ? daysBetween(parseDate(findLastFixture(team, fixtures, matchDate).date), parseDate(matchDate))
      : null,
    distanceKm: dist,
  };
}

/**
 * Compute context adjustments for both sides of a match.
 *
 * @param {string} teamA - Home / first team
 * @param {string} teamB - Away / second team
 * @param {string|object} venue - Venue name or resolved VENUES entry
 * @param {string} matchDate - YYYY-MM-DD match date
 * @param {object[]} fixtures - Previous fixtures for rest-day calculation
 * @returns {object} { homeAdj, awayAdj, homeFactors, awayFactors, venue }
 */
function contextAdjustments(teamA, teamB, venue, matchDate, fixtures) {
  const v = typeof venue === 'string' ? resolveVenue(venue) : venue;
  const a = contextAdjustmentForTeam(teamA, v, matchDate, fixtures);
  const b = contextAdjustmentForTeam(teamB, v, matchDate, fixtures);

  // Travel-gap edge: the side that travelled farther loses a little more.
  if (a.distanceKm !== null && b.distanceKm !== null) {
    const gap = a.distanceKm - b.distanceKm;
    const extra = Math.max(-TRAVEL_GAP_MAX, Math.min(TRAVEL_GAP_MAX, gap * TRAVEL_GAP_PENALTY_PER_KM));
    if (Math.abs(gap) > 1000) {
      a.total += extra;
      b.total -= extra;
    }
  }

  a.total = Math.max(-MAX_TOTAL_ADJUSTMENT, Math.min(MAX_TOTAL_ADJUSTMENT, a.total));
  b.total = Math.max(-MAX_TOTAL_ADJUSTMENT, Math.min(MAX_TOTAL_ADJUSTMENT, b.total));

  return {
    homeAdj: a.total,
    awayAdj: b.total,
    homeFactors: a.factors,
    awayFactors: b.factors,
    venue: v,
  };
}

/**
 * Load the 2026 FIFA World Cup fixtures from the cached dataset. Returns an
 * array of { date, home, away, venue, city, country } objects. Only fixtures
 * (unplayed matches) are included; already-played matches are still useful for
 * rest-day calculation so we include both, with a `played` boolean.
 *
 * The dataset uses the project's display names for home/away, so no mapping is
 * required.
 */
function loadFixtures({ resultsPath = path.join(process.cwd(), '.cache_results.csv') } = {}) {
  try {
    const text = fs.readFileSync(resultsPath, 'utf8');
    const lines = text.trim().split(/\r?\n/);
    const fixtures = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const cols = line.split(',');
      if (cols.length < 8) continue;
      const [date, home, away, homeScore, awayScore, tournament, city, country] = cols;
      if (tournament !== 'FIFA World Cup' || !date.startsWith('2026')) continue;
      fixtures.push({
        date,
        home: displayName(home),
        away: displayName(away),
        homeScore: homeScore === 'NA' ? null : Number(homeScore),
        awayScore: awayScore === 'NA' ? null : Number(awayScore),
        played: homeScore !== 'NA' && awayScore !== 'NA',
        venue: city,
        city,
        country,
      });
    }
    return fixtures;
  } catch (e) {
    return [];
  }
}

/**
 * Find a fixture between two teams in the loaded fixture list. The order of
 * teamA/teamB does not matter.
 */
function findFixture(fixtures, teamA, teamB) {
  if (!Array.isArray(fixtures)) return null;
  return fixtures.find(
    (f) => (f.home === teamA && f.away === teamB) || (f.home === teamB && f.away === teamA)
  ) || null;
}

module.exports = {
  VENUES,
  VENUE_ALIASES,
  TEAM_BASES,
  HOSTS,
  resolveVenue,
  getTeamBase,
  haversineKm,
  contextAdjustmentForTeam,
  contextAdjustments,
  loadFixtures,
  findFixture,
  parseDate,
  daysBetween,
  normalizeVenue,
};
