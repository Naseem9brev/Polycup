'use strict';

/**
 * clubform.js
 *
 * Phase 13: Club minutes, league strength, and club stats model.
 *
 * This module estimates a national team's effective strength from the club
 * performance of its players, without using transfer market values.
 *
 * Design:
 *  - League strength index based on UEFA country coefficients and regional equivalents
 *  - Player club minutes weighted by league strength and individual performance
 *  - Club strength score computed as weighted sum of squad's club output
 *  - Returns Elo-style adjustment for integration with existing prediction system
 *
 * Zero third-party dependencies.
 */

// ---------------------------------------------------------------------------
// League strength index (normalized to 1.0 for Premier League)
// ---------------------------------------------------------------------------

const LEAGUE_STRENGTH = {
  // Top 5 European leagues (UEFA coefficients 2024)
  'Premier League': 1.00,
  'Serie A': 0.87,
  'La Liga': 0.86,
  'Bundesliga': 0.83,
  'Ligue 1': 0.64,

  // Second-tier European leagues
  'Eredivisie': 0.59,
  'Primeira Liga': 0.54,
  'Pro League': 0.47,
  'Süper Lig': 0.37,
  'Scottish Premiership': 0.35,
  'Super League': 0.32,

  // Major non-European leagues
  'MLS': 0.42,
  'Liga MX': 0.48,
  'Brasileirão': 0.52,
  'Saudi Pro League': 0.45,
  'J1 League': 0.38,
  'K League 1': 0.35,
  'Chinese Super League': 0.30,

  // Other notable leagues
  'Championship': 0.55,
  'Serie B': 0.50,
  '2. Bundesliga': 0.48,
  'Ligue 2': 0.45,
  'Segunda División': 0.52,
};

// ---------------------------------------------------------------------------
// Club information database (extended from players.js)
// ---------------------------------------------------------------------------

const CLUB_DB = {
  // Format: { playerName: { club, league, minutes, stats } }
  // stats: { goals, assists, xg, keyPasses, tackles, cleanSheets }
  
  // ---- Group A ----------------------------------------------------------------
  'Guillermo Ochoa': { club: 'Sassuolo', league: 'Serie A', minutes: 2890, stats: { cleanSheets: 8 } },
  'Edson Álvarez': { club: 'West Ham', league: 'Premier League', minutes: 3156, stats: { tackles: 89, keyPasses: 34 } },
  'Hirving Lozano': { club: 'PSV', league: 'Eredivisie', minutes: 2678, stats: { goals: 12, assists: 8 } },
  'Raúl Jiménez': { club: 'Fulham', league: 'Premier League', minutes: 2434, stats: { goals: 8, assists: 4 } },
  'Alexis Vega': { club: 'Guadalajara', league: 'Liga MX', minutes: 2987, stats: { goals: 10, assists: 7 } },
  'Jorge Sánchez': { club: 'Porto', league: 'Primeira Liga', minutes: 2234, stats: { tackles: 67 } },
  'César Montes': { club: 'Espanyol', league: 'La Liga', minutes: 2567, stats: { tackles: 72, cleanSheets: 5 } },
  'Henry Martín': { club: 'América', league: 'Liga MX', minutes: 2789, stats: { goals: 15, assists: 6 } },

  'Ronwen Williams': { club: 'SuperSport United', league: 'South African Premiership', minutes: 3120, stats: { cleanSheets: 12 } },
  'Percy Tau': { club: 'Al Ahly', league: 'Egyptian Premier League', minutes: 2456, stats: { goals: 11, assists: 5 } },
  'Themba Zwane': { club: 'Mamelodi Sundowns', league: 'South African Premiership', minutes: 2890, stats: { goals: 8, assists: 9 } },
  'Lyle Foster': { club: 'Burnley', league: 'Premier League', minutes: 1876, stats: { goals: 6, assists: 3 } },
  'Bongokuhle Hlongwane': { club: 'Minnesota United', league: 'MLS', minutes: 2345, stats: { goals: 7, assists: 4 } },

  'Son Heung-min': { club: 'Tottenham', league: 'Premier League', minutes: 2987, stats: { goals: 17, assists: 10 } },
  'Kim Min-jae': { club: 'Bayern Munich', league: 'Bundesliga', minutes: 3123, stats: { tackles: 94, cleanSheets: 14 } },
  'Lee Kang-in': { club: 'Paris SG', league: 'Ligue 1', minutes: 2678, stats: { goals: 6, assists: 11 } },
  'Hwang Hee-chan': { club: 'Wolves', league: 'Premier League', minutes: 2456, stats: { goals: 12, assists: 3 } },
  'Hwang In-beom': { club: 'Crvena zvezda', league: 'Serbian SuperLiga', minutes: 2789, stats: { goals: 4, assists: 7 } },
  'Jo Hyeon-woo': { club: 'Ulsan Hyundai', league: 'K League 1', minutes: 2987, stats: { cleanSheets: 15 } },
  'Kim Young-gwon': { club: 'Ulsan Hyundai', league: 'K League 1', minutes: 2345, stats: { tackles: 56, cleanSheets: 10 } },

  'Tomáš Souček': { club: 'West Ham', league: 'Premier League', minutes: 2876, stats: { goals: 7, tackles: 98 } },
  'Patrik Schick': { club: 'Bayer Leverkusen', league: 'Bundesliga', minutes: 1987, stats: { goals: 8, assists: 2 } },
  'Vladimír Coufal': { club: 'West Ham', league: 'Premier League', minutes: 2765, stats: { tackles: 87 } },
  'Lukáš Provod': { club: 'Slavia Prague', league: 'Czech First League', minutes: 2567, stats: { goals: 6, assists: 8 } },
  'Ondřej Lingr': { club: 'Feyenoord', league: 'Eredivisie', minutes: 2345, stats: { goals: 9, assists: 6 } },
  'Jiří Pavlenka': { club: 'Werder Bremen', league: 'Bundesliga', minutes: 2987, stats: { cleanSheets: 9 } },

  // ---- Group B ----------------------------------------------------------------
  'Alphonso Davies': { club: 'Bayern Munich', league: 'Bundesliga', minutes: 2876, stats: { assists: 9, tackles: 78 } },
  'Jonathan David': { club: 'Lille', league: 'Ligue 1', minutes: 2987, stats: { goals: 19, assists: 7 } },
  'Tajon Buchanan': { club: 'Club Brugge', league: 'Pro League', minutes: 2456, stats: { goals: 4, assists: 6 } },
  'Cyle Larin': { club: 'Valladolid', league: 'La Liga', minutes: 2234, stats: { goals: 8, assists: 2 } },
  'Atiba Hutchinson': { club: 'Besiktas', league: 'Süper Lig', minutes: 1876, stats: { tackles: 45 } },
  'Stephen Eustáquio': { club: 'Porto', league: 'Primeira Liga', minutes: 2567, stats: { goals: 3, assists: 5 } },
  'Milan Borjan': { club: 'Red Star Belgrade', league: 'Serbian SuperLiga', minutes: 2789, stats: { cleanSheets: 13 } },
  'Richie Laryea': { club: 'Toronto FC', league: 'MLS', minutes: 2456, stats: { tackles: 67 } },

  'Christian Pulisic': { club: 'AC Milan', league: 'Serie A', minutes: 2789, stats: { goals: 12, assists: 8 } },
  'Weston McKennie': { club: 'Juventus', league: 'Serie A', minutes: 2456, stats: { goals: 4, assists: 3 } },
  'Tyler Adams': { club: 'Bournemouth', league: 'Premier League', minutes: 2234, stats: { tackles: 78 } },
  'Gio Reyna': { club: 'Borussia Dortmund', league: 'Bundesliga', minutes: 1876, stats: { goals: 5, assists: 7 } },
  'Antonee Robinson': { club: 'Fulham', league: 'Premier League', minutes: 2678, stats: { tackles: 87 } },
  'Matt Turner': { club: 'Crystal Palace', league: 'Premier League', minutes: 2345, stats: { cleanSheets: 8 } },
  'Tim Weah': { club: 'Juventus', league: 'Serie A', minutes: 1987, stats: { goals: 6, assists: 2 } },
  'Josh Sargent': { club: 'Norwich City', league: 'Championship', minutes: 2567, stats: { goals: 11, assists: 3 } },
  'Yunus Musah': { club: 'AC Milan', league: 'Serie A', minutes: 2234, stats: { goals: 2, assists: 4 } },
  'Sergiño Dest': { club: 'PSV', league: 'Eredivisie', minutes: 2456, stats: { tackles: 67 } },

  'Edin Džeko': { club: 'Fenerbahçe', league: 'Süper Lig', minutes: 2678, stats: { goals: 16, assists: 5 } },
  'Miralem Pjanić': { club: 'Sharjah', league: 'UAE Pro League', minutes: 2345, stats: { assists: 8 } },
  'Ermedin Demirović': { club: 'Augsburg', league: 'Bundesliga', minutes: 2456, stats: { goals: 8, assists: 3 } },
  'Haris Hajradinović': { club: 'Gaziantep', league: 'Süper Lig', minutes: 2234, stats: { goals: 6, assists: 7 } },
  'Sead Kolašinac': { club: 'Atalanta', league: 'Serie A', minutes: 1876, stats: { tackles: 78 } },

  'Akram Afif': { club: 'Al Sadd', league: 'Qatar Stars League', minutes: 2789, stats: { goals: 14, assists: 18 } },
  'Almoez Ali': { club: 'Al Duhail', league: 'Qatar Stars League', minutes: 2567, stats: { goals: 17, assists: 4 } },
  'Hassan Al-Haydos': { club: 'Al Duhail', league: 'Qatar Stars League', minutes: 2234, stats: { goals: 8, assists: 6 } },
  'Meshaal Barsham': { club: 'Al Duhail', league: 'Qatar Stars League', minutes: 2876, stats: { cleanSheets: 11 } },
  'Pedro Miguel': { club: 'Al Duhail', league: 'Qatar Stars League', minutes: 2456, stats: { tackles: 82 } },
  'Boualem Khoukhi': { club: 'Al Duhail', league: 'Qatar Stars League', minutes: 2345, stats: { tackles: 76, cleanSheets: 4 } },

  'Granit Xhaka': { club: 'Bayer Leverkusen', league: 'Bundesliga', minutes: 2987, stats: { goals: 4, assists: 9 } },
  'Xherdan Shaqiri': { club: 'Chicago Fire', league: 'MLS', minutes: 2234, stats: { goals: 6, assists: 7 } },
  'Yann Sommer': { club: 'Inter Milan', league: 'Serie A', minutes: 2876, stats: { cleanSheets: 12 } },
  'Haris Seferović': { club: 'Galatasaray', league: 'Süper Lig', minutes: 1876, stats: { goals: 7 } },
  'Remo Freuler': { club: 'Nottingham Forest', league: 'Premier League', minutes: 1987, stats: { goals: 2, assists: 4 } },
  'Silvan Widmer': { club: 'Mainz', league: 'Bundesliga', minutes: 2567, stats: { tackles: 71 } },
  'Manuel Akanji': { club: 'Manchester City', league: 'Premier League', minutes: 2234, stats: { tackles: 89, cleanSheets: 16 } },
  'Ruben Vargas': { club: 'Augsburg', league: 'Bundesliga', minutes: 2456, stats: { goals: 5, assists: 6 } },

  // ---- Group C ----------------------------------------------------------------
  'Vinicius Junior': { club: 'Real Madrid', league: 'La Liga', minutes: 2987, stats: { goals: 21, assists: 9 } },
  'Rodrygo': { club: 'Real Madrid', league: 'La Liga', minutes: 2765, stats: { goals: 14, assists: 8 } },
  'Casemiro': { club: 'Manchester United', league: 'Premier League', minutes: 2456, stats: { goals: 4, tackles: 87 } },
  'Marquinhos': { club: 'Paris SG', league: 'Ligue 1', minutes: 2876, stats: { tackles: 92, cleanSheets: 13 } },
  'Richarlison': { club: 'Tottenham', league: 'Premier League', minutes: 2234, stats: { goals: 11, assists: 3 } },
  'Lucas Paquetá': { club: 'West Ham', league: 'Premier League', minutes: 2567, stats: { goals: 5, assists: 7 } },
  'Alisson': { club: 'Liverpool', league: 'Premier League', minutes: 2789, stats: { cleanSheets: 17 } },
  'Raphinha': { club: 'Barcelona', league: 'La Liga', minutes: 2456, stats: { goals: 8, assists: 10 } },
  'Gabriel Martinelli': { club: 'Arsenal', league: 'Premier League', minutes: 2345, stats: { goals: 9, assists: 4 } },
  'Bruno Guimarães': { club: 'Newcastle', league: 'Premier League', minutes: 2678, stats: { goals: 6, assists: 5 } },
  'Éder Militão': { club: 'Real Madrid', league: 'La Liga', minutes: 1987, stats: { tackles: 78, cleanSheets: 8 } },
  'Endrick': { club: 'Real Madrid', league: 'La Liga', minutes: 1234, stats: { goals: 4, assists: 1 } },

  'Achraf Hakimi': { club: 'Paris SG', league: 'Ligue 1', minutes: 2876, stats: { goals: 4, assists: 8 } },
  'Hakim Ziyech': { club: 'Galatasaray', league: 'Süper Lig', minutes: 2456, stats: { goals: 7, assists: 11 } },
  'Youssef En-Nesyri': { club: 'Fenerbahçe', league: 'Süper Lig', minutes: 2234, stats: { goals: 14, assists: 3 } },
  'Sofiane Boufal': { club: 'Al Rayyan', league: 'Qatar Stars League', minutes: 1987, stats: { goals: 6, assists: 8 } },
  'Azzedine Ounahi': { club: 'Marseille', league: 'Ligue 1', minutes: 2567, stats: { goals: 3, assists: 6 } },
  'Romain Saïss': { club: 'Beşiktaş', league: 'Süper Lig', minutes: 2345, stats: { tackles: 78, cleanSheets: 6 } },
  'Yassine Bounou': { club: 'Al Hilal', league: 'Saudi Pro League', minutes: 2789, stats: { cleanSheets: 14 } },
  'Noussair Mazraoui': { club: 'Bayern Munich', league: 'Bundesliga', minutes: 2234, stats: { tackles: 82 } },
  'Selim Amallah': { club: 'Standard Liège', league: 'Pro League', minutes: 2456, stats: { goals: 5, assists: 7 } },

  'Andy Robertson': { club: 'Liverpool', league: 'Premier League', minutes: 2876, stats: { assists: 8, tackles: 94 } },
  'Scott McTominay': { club: 'Manchester United', league: 'Premier League', minutes: 2456, stats: { goals: 7, tackles: 76 } },
  'Kieran Tierney': { club: 'Real Sociedad', league: 'La Liga', minutes: 2234, stats: { tackles: 87 } },
  'John McGinn': { club: 'Aston Villa', league: 'Premier League', minutes: 2678, stats: { goals: 6, assists: 5 } },
  'Callum McGregor': { club: 'Celtic', league: 'Scottish Premiership', minutes: 2789, stats: { goals: 4, assists: 7 } },
  'Lawrence Shankland': { club: 'Heart of Midlothian', league: 'Scottish Premiership', minutes: 2567, stats: { goals: 16, assists: 3 } },
  'Ryan Christie': { club: 'Bournemouth', league: 'Premier League', minutes: 2345, stats: { goals: 5, assists: 4 } },
  'Craig Gordon': { club: 'Heart of Midlothian', league: 'Scottish Premiership', minutes: 2987, stats: { cleanSheets: 15 } },

  // Additional players would be added here for all 48 teams...
  // For brevity, showing key players from each group
};

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Get league strength multiplier (0-1, Premier League = 1.0)
 */
function getLeagueStrength(league) {
  return LEAGUE_STRENGTH[league] || 0.25; // Default for unknown leagues
}

/**
 * Calculate player performance score from club stats
 */
function calculatePlayerScore(playerInfo) {
  const { minutes, stats } = playerInfo;
  const leagueStrength = getLeagueStrength(playerInfo.league);
  
  // Normalize minutes (max ~3420 for full season)
  const minutesFactor = Math.min(minutes / 3420, 1.0);
  
  // Calculate performance score from stats
  let performanceScore = 0;
  
  // Goals and assists (weighted by position would be better, but using generic weights)
  performanceScore += (stats.goals || 0) * 8;
  performanceScore += (stats.assists || 0) * 5;
  
  // Defensive contributions
  performanceScore += (stats.tackles || 0) * 0.3;
  performanceScore += (stats.cleanSheets || 0) * 4;
  
  // Creative contributions
  performanceScore += (stats.keyPasses || 0) * 0.2;
  performanceScore += (stats.xg || 0) * 10;
  
  // Normalize performance score (rough scale: 0-100)
  performanceScore = Math.min(performanceScore / 10, 100);
  
  // Final score: minutes factor × performance score × league strength
  return minutesFactor * performanceScore * leagueStrength;
}

// ---------------------------------------------------------------------------
// Main club strength calculation
// ---------------------------------------------------------------------------

/**
 * Calculate club strength score for a national team
 */
function calculateClubStrength(team, playerDb) {
  const players = playerDb[team] || [];
  let totalScore = 0;
  let playerCount = 0;
  
  for (const player of players) {
    const clubInfo = CLUB_DB[player.name];
    if (clubInfo) {
      const playerScore = calculatePlayerScore(clubInfo);
      totalScore += playerScore;
      playerCount++;
    }
  }
  
  // Average score per player, scaled to meaningful range
  const averageScore = playerCount > 0 ? totalScore / playerCount : 0;
  
  return {
    team,
    clubStrength: averageScore,
    playersWithClubData: playerCount,
    totalPlayers: players.length,
    coverage: players.length > 0 ? playerCount / players.length : 0
  };
}

/**
 * Convert club strength to Elo adjustment
 * Scale: roughly ±40 Elo for strong/weak club form
 */
function clubStrengthAdjustment(team, playerDb) {
  const { clubStrength } = calculateClubStrength(team, playerDb);
  
  // Map club strength (0-100) to Elo adjustment (-40 to +40)
  // 50 = neutral, below 50 = negative adjustment, above 50 = positive
  const eloAdjustment = (clubStrength - 50) * 0.8;
  
  return Math.round(eloAdjustment);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

module.exports = {
  calculateClubStrength,
  clubStrengthAdjustment,
  getLeagueStrength,
  LEAGUE_STRENGTH,
  CLUB_DB
};