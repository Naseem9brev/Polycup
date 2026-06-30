'use strict';

/**
 * worldcup2026.js
 *
 * The 48 qualified teams and their group assignments per the official FIFA
 * final draw (5 December 2025, Washington, D.C.), plus the name-mapping layer
 * that reconciles this project's display names with the historical dataset's
 * spellings and the loose aliases a user might type at the CLI prompt.
 */

// 12 groups of 4. Display names are this project's canonical names.
const GROUPS = {
  A: ['Mexico', 'South Africa', 'South Korea', 'Czech Republic'],
  B: ['Canada', 'Bosnia & Herzegovina', 'Qatar', 'Switzerland'],
  C: ['Brazil', 'Morocco', 'Haiti', 'Scotland'],
  D: ['USA', 'Paraguay', 'Australia', 'Turkey'],
  E: ['Germany', 'Curaçao', 'Ivory Coast', 'Ecuador'],
  F: ['Netherlands', 'Japan', 'Sweden', 'Tunisia'],
  G: ['Belgium', 'Egypt', 'Iran', 'New Zealand'],
  H: ['Spain', 'Cape Verde', 'Saudi Arabia', 'Uruguay'],
  I: ['France', 'Senegal', 'Iraq', 'Norway'],
  J: ['Argentina', 'Algeria', 'Austria', 'Jordan'],
  K: ['Portugal', 'DR Congo', 'Uzbekistan', 'Colombia'],
  L: ['England', 'Croatia', 'Ghana', 'Panama'],
};

// Flat list of all 48 teams.
const TEAMS = Object.values(GROUPS).flat();

// Group letter lookup for a given display name.
const GROUP_OF = {};
for (const [letter, teams] of Object.entries(GROUPS)) {
  for (const team of teams) GROUP_OF[team] = letter;
}

/**
 * Maps this project's display name -> the name used in martj42/international_results.
 * Only teams whose dataset spelling differs need an entry; everything else maps
 * to itself (handled by datasetName() below).
 */
const DISPLAY_TO_DATASET = {
  USA: 'United States',
  'Bosnia & Herzegovina': 'Bosnia and Herzegovina',
};

/** Returns the dataset spelling for a display name (identity by default). */
function datasetName(displayName) {
  return DISPLAY_TO_DATASET[displayName] || displayName;
}

/**
 * Aliases a user might type at the CLI -> canonical display name.
 * Covers FIFA 3-letter codes and a few common informal names. Matching is
 * normalized (lower-cased, accents stripped) so "BRA", "bra", "brazil" all work.
 */
const ALIASES = {
  // FIFA / common 3-letter codes
  mex: 'Mexico', rsa: 'South Africa', kor: 'South Korea', cze: 'Czech Republic',
  can: 'Canada', bih: 'Bosnia & Herzegovina', qat: 'Qatar', sui: 'Switzerland',
  bra: 'Brazil', mar: 'Morocco', hai: 'Haiti', sco: 'Scotland',
  usa: 'USA', par: 'Paraguay', aus: 'Australia', tur: 'Turkey',
  ger: 'Germany', cuw: 'Curaçao', civ: 'Ivory Coast', ecu: 'Ecuador',
  ned: 'Netherlands', jpn: 'Japan', swe: 'Sweden', tun: 'Tunisia',
  bel: 'Belgium', egy: 'Egypt', irn: 'Iran', nzl: 'New Zealand',
  esp: 'Spain', cpv: 'Cape Verde', ksa: 'Saudi Arabia', uru: 'Uruguay',
  fra: 'France', sen: 'Senegal', irq: 'Iraq', nor: 'Norway',
  arg: 'Argentina', alg: 'Algeria', aut: 'Austria', jor: 'Jordan',
  por: 'Portugal', cod: 'DR Congo', uzb: 'Uzbekistan', col: 'Colombia',
  eng: 'England', cro: 'Croatia', gha: 'Ghana', pan: 'Panama',
  // informal / alternative names
  'south korea': 'South Korea', 'korea': 'South Korea', 'korea republic': 'South Korea',
  'czechia': 'Czech Republic',
  'bosnia': 'Bosnia & Herzegovina', 'bosnia and herzegovina': 'Bosnia & Herzegovina',
  'united states': 'USA', 'usa men': 'USA', 'us': 'USA', 'america': 'USA',
  'turkiye': 'Turkey', 'türkiye': 'Turkey',
  'cote divoire': 'Ivory Coast', 'cote d ivoire': 'Ivory Coast', 'ivorycoast': 'Ivory Coast',
  'holland': 'Netherlands',
  'congo dr': 'DR Congo', 'drc': 'DR Congo', 'democratic republic of the congo': 'DR Congo',
  'saudi': 'Saudi Arabia',
  'new zealand': 'New Zealand',
  'south africa': 'South Africa',
  'cape verde': 'Cape Verde',
};

/** Lower-case, strip accents/diacritics and non-alphanumerics for matching. */
function normalize(s) {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Pre-build a normalized lookup from both canonical names and aliases.
const NORMALIZED_LOOKUP = {};
for (const team of TEAMS) NORMALIZED_LOOKUP[normalize(team)] = team;
for (const [alias, team] of Object.entries(ALIASES)) {
  NORMALIZED_LOOKUP[normalize(alias)] = team;
}

/**
 * Simple Levenshtein edit distance.
 */
function levenshtein(a, b) {
  if (a.length < b.length) return levenshtein(b, a);
  if (b.length === 0) return a.length;

  const previous = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const current = [i + 1];
    for (let j = 0; j < b.length; j++) {
      const insert = previous[j + 1] + 1;
      const del = current[j] + 1;
      const sub = a[i] === b[j] ? previous[j] : previous[j] + 1;
      current.push(Math.min(insert, del, sub));
    }
    for (let j = 0; j <= b.length; j++) previous[j] = current[j];
  }
  return previous[b.length];
}

/**
 * Resolves loose user input to a canonical display name, or null if unknown.
 * Tries: exact normalized match -> alias match -> unique prefix match ->
 * edit-distance fuzzy match (short inputs require a smaller absolute distance).
 */
function resolveTeam(input) {
  if (!input) return null;
  const key = normalize(input);
  if (key.length === 0) return null;
  if (NORMALIZED_LOOKUP[key]) return NORMALIZED_LOOKUP[key];

  // Unique prefix match against canonical names (e.g. "switz" -> Switzerland).
  const prefixHits = TEAMS.filter((t) => normalize(t).startsWith(key));
  if (prefixHits.length === 1) return prefixHits[0];

  // Fuzzy fallback: find the nearest canonical name or alias by edit distance.
  const threshold = key.length <= 4 ? 1 : 2;
  let best = null;
  let bestDistance = Infinity;
  const candidates = [
    ...TEAMS.map((t) => ({ name: t, key: normalize(t) })),
    ...Object.entries(ALIASES).map(([alias, team]) => ({ name: alias, key: normalize(alias), team })),
  ];

  for (const c of candidates) {
    const dist = levenshtein(key, c.key);
    if (dist <= threshold && dist < bestDistance) {
      bestDistance = dist;
      best = c.team || c.name;
    }
  }

  return best;
}

module.exports = {
  GROUPS,
  TEAMS,
  GROUP_OF,
  datasetName,
  resolveTeam,
  normalize,
};
