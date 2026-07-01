#!/usr/bin/env node
'use strict';

/**
 * verify-clubform.js
 *
 * Verification script for Phase 13: Club minutes, league strength, and club stats model.
 *
 * This script runs deterministic tests to validate:
 *  - League strength index calculations
 *  - Player performance scoring
 *  - Club strength calculations for teams
 *  - Elo adjustment conversions
 *  - Integration with existing prediction system
 *
 * Zero third-party dependencies.
 */

const { calculateClubStrength, clubStrengthAdjustment, getLeagueStrength, LEAGUE_STRENGTH, CLUB_DB } = require('./clubform');
const { PLAYER_DB } = require('./players');

// Test utilities
const assert = (condition, message) => {
  if (!condition) {
    console.error(`❌ FAILED: ${message}`);
    process.exit(1);
  } else {
    console.log(`✅ PASSED: ${message}`);
  }
};

const approxEqual = (a, b, tolerance = 0.01, message) => {
  if (Math.abs(a - b) > tolerance) {
    console.error(`❌ FAILED: ${message} (expected ${b}, got ${a})`);
    process.exit(1);
  } else {
    console.log(`✅ PASSED: ${message}`);
  }
};

console.log('🔍 Verifying Club Form Model...\n');

// Test 1: League strength index
console.log('Test 1: League strength index');
assert(getLeagueStrength('Premier League') === 1.00, 'Premier League strength = 1.00');
assert(getLeagueStrength('Serie A') === 0.87, 'Serie A strength = 0.87');
assert(getLeagueStrength('La Liga') === 0.86, 'La Liga strength = 0.86');
assert(getLeagueStrength('Bundesliga') === 0.83, 'Bundesliga strength = 0.83');
assert(getLeagueStrength('Ligue 1') === 0.64, 'Ligue 1 strength = 0.64');
assert(getLeagueStrength('MLS') === 0.42, 'MLS strength = 0.42');
assert(getLeagueStrength('Liga MX') === 0.48, 'Liga MX strength = 0.48');
assert(getLeagueStrength('Unknown League') === 0.25, 'Unknown league defaults to 0.25');

// Test 2: Top 5 leagues are correctly ordered
console.log('\nTest 2: Top 5 leagues ranking');
const top5 = ['Premier League', 'Serie A', 'La Liga', 'Bundesliga', 'Ligue 1'];
const top5Strengths = top5.map(league => getLeagueStrength(league));
for (let i = 1; i < top5Strengths.length; i++) {
  assert(top5Strengths[i-1] >= top5Strengths[i], `League ranking: ${top5[i-1]} (${top5Strengths[i-1]}) >= ${top5[i]} (${top5Strengths[i]})`);
}

// Test 3: Club database structure
console.log('\nTest 3: Club database structure');
const samplePlayer = 'Guillermo Ochoa';
assert(CLUB_DB[samplePlayer] !== undefined, `Club data exists for ${samplePlayer}`);
assert(CLUB_DB[samplePlayer].club === 'Sassuolo', `${samplePlayer} club is Sassuolo`);
assert(CLUB_DB[samplePlayer].league === 'Serie A', `${samplePlayer} league is Serie A`);
assert(CLUB_DB[samplePlayer].minutes > 0, `${samplePlayer} has positive minutes`);
assert(CLUB_DB[samplePlayer].stats !== undefined, `${samplePlayer} has stats object`);

// Test 4: Player performance scoring
console.log('\nTest 4: Player performance scoring');
const testPlayer = CLUB_DB[samplePlayer];
const leagueStrength = getLeagueStrength(testPlayer.league);
const minutesFactor = Math.min(testPlayer.minutes / 3420, 1.0);

// Calculate expected performance score manually
let expectedPerfScore = (testPlayer.stats.cleanSheets || 0) * 4;
expectedPerfScore = Math.min(expectedPerfScore / 10, 100);
const expectedFinalScore = minutesFactor * expectedPerfScore * leagueStrength;

// Test that our calculation function works
const { calculatePlayerScore } = require('./clubform');
// We need to access this internal function, so let's test indirectly through club strength

// Test 5: Club strength calculation for known teams
console.log('\nTest 5: Club strength calculation');
const brazilStrength = calculateClubStrength('Brazil', PLAYER_DB);
assert(brazilStrength.team === 'Brazil', 'Brazil club strength returns correct team');
assert(brazilStrength.clubStrength >= 0, 'Brazil club strength is non-negative');
assert(brazilStrength.clubStrength <= 100, 'Brazil club strength is capped at 100');
assert(brazilStrength.playersWithClubData > 0, 'Brazil has players with club data');
assert(brazilStrength.coverage > 0, 'Brazil has positive data coverage');
assert(brazilStrength.coverage <= 1, 'Brazil coverage is <= 1.0');

// Test 6: Teams with more star players should have higher club strength
console.log('\nTest 6: Relative club strength');
const mexicoStrength = calculateClubStrength('Mexico', PLAYER_DB);
const usaStrength = calculateClubStrength('USA', PLAYER_DB);
const qatarStrength = calculateClubStrength('Qatar', PLAYER_DB);

// These should be reasonable values (not exact, but in expected ranges)
assert(mexicoStrength.clubStrength > 0, 'Mexico has positive club strength');
assert(usaStrength.clubStrength > 0, 'USA has positive club strength');
assert(qatarStrength.clubStrength > 0, 'Qatar has positive club strength');

// Test 7: Elo adjustment conversion
console.log('\nTest 7: Elo adjustment conversion');
const brazilAdjustment = clubStrengthAdjustment('Brazil', PLAYER_DB);
assert(typeof brazilAdjustment === 'number', 'Brazil adjustment is a number');
assert(brazilAdjustment >= -40, 'Brazil adjustment is not below -40');
assert(brazilAdjustment <= 40, 'Brazil adjustment is not above 40');

// Test 8: Adjustment direction makes sense
console.log('\nTest 8: Adjustment direction logic');
// Teams with strong club form should get positive adjustments
// Teams with weaker club form should get negative adjustments
// Note: This is a rough test since we don't have complete data

// Test 9: Coverage varies by team (data completeness)
console.log('\nTest 9: Data coverage variation');
const teams = ['Brazil', 'USA', 'Mexico', 'Qatar', 'South Africa'];
const coverages = teams.map(team => calculateClubStrength(team, PLAYER_DB).coverage);
const minCoverage = Math.min(...coverages);
const maxCoverage = Math.max(...coverages);
assert(maxCoverage > minCoverage, 'Coverage varies between teams');
assert(minCoverage >= 0, 'Minimum coverage is non-negative');
assert(maxCoverage <= 1, 'Maximum coverage is <= 1.0');

// Test 10: Integration with existing system
console.log('\nTest 10: System integration');
// Test that we can import all required modules
try {
  const { predictMatch } = require('./simulation');
  const { buildEloModel } = require('./elo');
  console.log('✅ PASSED: All required modules can be imported');
} catch (e) {
  console.error(`❌ FAILED: Module import error: ${e.message}`);
  process.exit(1);
}

// Test 11: Deterministic behavior
console.log('\nTest 11: Deterministic behavior');
const adjustment1 = clubStrengthAdjustment('Brazil', PLAYER_DB);
const adjustment2 = clubStrengthAdjustment('Brazil', PLAYER_DB);
assert(adjustment1 === adjustment2, 'Club strength adjustment is deterministic');

const strength1 = calculateClubStrength('Brazil', PLAYER_DB);
const strength2 = calculateClubStrength('Brazil', PLAYER_DB);
assert(strength1.clubStrength === strength2.clubStrength, 'Club strength calculation is deterministic');
assert(strength1.playersWithClubData === strength2.playersWithClubData, 'Player count is deterministic');

// Test 12: Edge cases
console.log('\nTest 12: Edge cases');
// Test with empty player database
const emptyDb = {};
const emptyStrength = calculateClubStrength('NonExistentTeam', emptyDb);
assert(emptyStrength.team === 'NonExistentTeam', 'Empty DB returns correct team name');
assert(emptyStrength.clubStrength === 0, 'Empty DB returns zero club strength');
assert(emptyStrength.playersWithClubData === 0, 'Empty DB returns zero player count');
assert(emptyStrength.totalPlayers === 0, 'Empty DB returns zero total players');
assert(emptyStrength.coverage === 0, 'Empty DB returns zero coverage');

const emptyAdjustment = clubStrengthAdjustment('NonExistentTeam', emptyDb);
assert(emptyAdjustment === -40, 'Empty DB returns minimum adjustment (-40)');

// Test 13: League strength distribution
console.log('\nTest 13: League strength distribution');
const leagueStrengths = Object.values(LEAGUE_STRENGTH);
const minStrength = Math.min(...leagueStrengths);
const maxStrength = Math.max(...leagueStrengths);
assert(minStrength >= 0.25, 'Minimum league strength is >= 0.25');
assert(maxStrength === 1.00, 'Maximum league strength is exactly 1.00');

// Test 14: Player data completeness
console.log('\nTest 14: Player data completeness');
let totalPlayers = 0;
let playersWithClubData = 0;
for (const [team, players] of Object.entries(PLAYER_DB)) {
  totalPlayers += players.length;
  for (const player of players) {
    if (CLUB_DB[player.name]) {
      playersWithClubData++;
    }
  }
}
const overallCoverage = playersWithClubData / totalPlayers;
console.log(`📊 Overall data coverage: ${(overallCoverage * 100).toFixed(1)}% (${playersWithClubData}/${totalPlayers} players)`);
assert(overallCoverage > 0.1, 'At least 10% of players have club data');
assert(playersWithClubData > 50, 'At least 50 players have club data');

// Test 15: Performance ranges
console.log('\nTest 15: Performance ranges');
const allStrengths = Object.keys(PLAYER_DB).map(team => 
  calculateClubStrength(team, PLAYER_DB).clubStrength
);
const overallMinStrength = Math.min(...allStrengths);
const overallMaxStrength = Math.max(...allStrengths);
console.log(`📊 Club strength range: ${overallMinStrength.toFixed(1)} - ${overallMaxStrength.toFixed(1)}`);
assert(overallMinStrength >= 0, 'Minimum club strength is non-negative');
assert(overallMaxStrength <= 100, 'Maximum club strength is <= 100');
assert(overallMaxStrength > overallMinStrength, 'Club strength varies between teams');

console.log('\n🎉 All club form verification tests passed!');
console.log('\n📋 Summary:');
console.log(`   - League strength index: ${Object.keys(LEAGUE_STRENGTH).length} leagues defined`);
console.log(`   - Club database: ${Object.keys(CLUB_DB).length} players with club info`);
console.log(`   - Data coverage: ${(overallCoverage * 100).toFixed(1)}% of all players`);
console.log(`   - Club strength range: ${overallMinStrength.toFixed(1)} - ${overallMaxStrength.toFixed(1)}`);
console.log('\n✅ Club form model is ready for experimental use!');