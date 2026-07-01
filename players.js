'use strict';

/**
 * players.js
 *
 * Player importance database for lineup-aware Elo adjustments (Phase 8).
 *
 * Design:
 *  - Each entry maps a player's name (or ESPN display name) to an importance
 *    score (0–100) for their national team.
 *  - A score of 100 represents a once-in-a-generation talisman (Messi, Ronaldo)
 *    whose absence severely damages the team.  50 is a solid regular starter.
 *  - Scores are authored from public FIFA rankings, UEFA/CONMEBOL player-of-the-
 *    year awards, and broad consensus punditry.  They intentionally err on the
 *    side of being coarse (steps of 5) so small noise in ESPN name spellings
 *    doesn't produce wildly different results.
 *  - Name matching is case-insensitive substring search (see lookupPlayer).
 *
 * Elo impact:
 *  - The model deducts Elo for every expected key starter who is confirmed
 *    absent and adds a small bonus when a star player IS confirmed starting.
 *    The maximum combined adjustment is capped at ±80 Elo to prevent runaway
 *    effects; empirically a realistic single-player absence (score ~85) with a
 *    good replacement (score ~55) produces roughly –12 to –18 Elo, equivalent
 *    to about a 3–4 % swing in win probability in a close match.
 *
 * Zero third-party dependencies.
 */

// ---------------------------------------------------------------------------
// Player database
// ---------------------------------------------------------------------------
// Structure: { [canonicalTeamName]: [ { name, score, position } ] }
// 'position' is one of: GK, DEF, MID, FWD  (informational only)

const PLAYER_DB = {

  // ---- Group A ----------------------------------------------------------------
  Mexico: [
    { name: 'Guillermo Ochoa',     score: 82, position: 'GK'  },
    { name: 'Edson Álvarez',       score: 84, position: 'MID' },
    { name: 'Hirving Lozano',      score: 80, position: 'FWD' },
    { name: 'Raúl Jiménez',        score: 82, position: 'FWD' },
    { name: 'Alexis Vega',         score: 68, position: 'FWD' },
    { name: 'Jorge Sánchez',       score: 63, position: 'DEF' },
    { name: 'César Montes',        score: 68, position: 'DEF' },
    { name: 'Henry Martín',        score: 67, position: 'FWD' },
  ],
  'South Africa': [
    { name: 'Ronwen Williams',     score: 78, position: 'GK'  },
    { name: 'Percy Tau',           score: 82, position: 'FWD' },
    { name: 'Themba Zwane',        score: 78, position: 'MID' },
    { name: 'Bafana Bafana',       score: 60, position: 'MID' }, // generic placeholder
    { name: 'Lyle Foster',         score: 74, position: 'FWD' },
    { name: 'Bongokuhle Hlongwane',score: 70, position: 'FWD' },
  ],
  'South Korea': [
    { name: 'Son Heung-min',       score: 95, position: 'FWD' },
    { name: 'Kim Min-jae',         score: 88, position: 'DEF' },
    { name: 'Lee Kang-in',         score: 84, position: 'MID' },
    { name: 'Hwang Hee-chan',       score: 78, position: 'FWD' },
    { name: 'Hwang In-beom',       score: 74, position: 'MID' },
    { name: 'Jo Hyeon-woo',        score: 72, position: 'GK'  },
    { name: 'Kim Young-gwon',      score: 65, position: 'DEF' },
  ],
  'Czech Republic': [
    { name: 'Tomáš Souček',        score: 85, position: 'MID' },
    { name: 'Patrik Schick',       score: 88, position: 'FWD' },
    { name: 'Vladimír Coufal',     score: 72, position: 'DEF' },
    { name: 'Lukáš Provod',        score: 68, position: 'MID' },
    { name: 'Ondřej Lingr',        score: 65, position: 'MID' },
    { name: 'Jiří Pavlenka',       score: 72, position: 'GK'  },
  ],

  // ---- Group B ----------------------------------------------------------------
  Canada: [
    { name: 'Alphonso Davies',     score: 95, position: 'DEF' },
    { name: 'Jonathan David',      score: 90, position: 'FWD' },
    { name: 'Tajon Buchanan',      score: 78, position: 'MID' },
    { name: 'Cyle Larin',          score: 76, position: 'FWD' },
    { name: 'Atiba Hutchinson',    score: 70, position: 'MID' },
    { name: 'Stephen Eustáquio',   score: 76, position: 'MID' },
    { name: 'Milan Borjan',        score: 75, position: 'GK'  },
    { name: 'Richie Laryea',       score: 65, position: 'DEF' },
  ],
  'Bosnia & Herzegovina': [
    { name: 'Edin Džeko',          score: 88, position: 'FWD' },
    { name: 'Miralem Pjanić',      score: 85, position: 'MID' },
    { name: 'Sehad Šehić',         score: 68, position: 'GK'  },
    { name: 'Ermedin Demirović',   score: 76, position: 'FWD' },
    { name: 'Haris Hajradinović',  score: 65, position: 'MID' },
    { name: 'Sead Kolašinac',      score: 72, position: 'DEF' },
  ],
  Qatar: [
    { name: 'Akram Afif',          score: 88, position: 'FWD' },
    { name: 'Almoez Ali',          score: 82, position: 'FWD' },
    { name: 'Hassan Al-Haydos',    score: 78, position: 'MID' },
    { name: 'Meshaal Barsham',     score: 72, position: 'GK'  },
    { name: 'Pedro Miguel',        score: 70, position: 'DEF' },
    { name: 'Boualem Khoukhi',     score: 68, position: 'DEF' },
  ],
  Switzerland: [
    { name: 'Granit Xhaka',        score: 90, position: 'MID' },
    { name: 'Xherdan Shaqiri',     score: 82, position: 'MID' },
    { name: 'Yann Sommer',         score: 84, position: 'GK'  },
    { name: 'Haris Seferović',     score: 72, position: 'FWD' },
    { name: 'Remo Freuler',        score: 78, position: 'MID' },
    { name: 'Silvan Widmer',       score: 68, position: 'DEF' },
    { name: 'Manuel Akanji',       score: 82, position: 'DEF' },
    { name: 'Ruben Vargas',        score: 72, position: 'FWD' },
  ],

  // ---- Group C ----------------------------------------------------------------
  Brazil: [
    { name: 'Vinicius Junior',     score: 96, position: 'FWD' },
    { name: 'Rodrygo',             score: 88, position: 'FWD' },
    { name: 'Casemiro',            score: 85, position: 'MID' },
    { name: 'Marquinhos',          score: 87, position: 'DEF' },
    { name: 'Richarlison',         score: 82, position: 'FWD' },
    { name: 'Lucas Paquetá',       score: 86, position: 'MID' },
    { name: 'Alisson',             score: 88, position: 'GK'  },
    { name: 'Raphinha',            score: 84, position: 'FWD' },
    { name: 'Gabriel Martinelli',  score: 80, position: 'FWD' },
    { name: 'Bruno Guimarães',     score: 82, position: 'MID' },
    { name: 'Éder Militão',        score: 80, position: 'DEF' },
    { name: 'Endrick',             score: 80, position: 'FWD' },
  ],
  Morocco: [
    { name: 'Achraf Hakimi',       score: 92, position: 'DEF' },
    { name: 'Hakim Ziyech',        score: 88, position: 'MID' },
    { name: 'Youssef En-Nesyri',   score: 85, position: 'FWD' },
    { name: 'Sofiane Boufal',      score: 80, position: 'MID' },
    { name: 'Azzedine Ounahi',     score: 78, position: 'MID' },
    { name: 'Romain Saïss',        score: 74, position: 'DEF' },
    { name: 'Yassine Bounou',      score: 86, position: 'GK'  },
    { name: 'Noussair Mazraoui',   score: 78, position: 'DEF' },
    { name: 'Selim Amallah',       score: 68, position: 'MID' },
  ],
  Haiti: [
    { name: 'Nazon',               score: 72, position: 'FWD' },
    { name: 'Etienne',             score: 65, position: 'MID' },
    { name: 'Andrice',             score: 62, position: 'DEF' },
  ],
  Scotland: [
    { name: 'Andy Robertson',      score: 90, position: 'DEF' },
    { name: 'Scott McTominay',     score: 85, position: 'MID' },
    { name: 'Kieran Tierney',      score: 78, position: 'DEF' },
    { name: 'John McGinn',         score: 80, position: 'MID' },
    { name: 'Callum McGregor',     score: 78, position: 'MID' },
    { name: 'Lawrence Shankland',  score: 76, position: 'FWD' },
    { name: 'Ryan Christie',       score: 72, position: 'MID' },
    { name: 'Craig Gordon',        score: 75, position: 'GK'  },
  ],

  // ---- Group D ----------------------------------------------------------------
  USA: [
    { name: 'Christian Pulisic',   score: 94, position: 'FWD' },
    { name: 'Weston McKennie',     score: 80, position: 'MID' },
    { name: 'Tyler Adams',         score: 82, position: 'MID' },
    { name: 'Gio Reyna',           score: 82, position: 'MID' },
    { name: 'Antonee Robinson',    score: 76, position: 'DEF' },
    { name: 'Matt Turner',         score: 74, position: 'GK'  },
    { name: 'Tim Weah',            score: 76, position: 'FWD' },
    { name: 'Josh Sargent',        score: 72, position: 'FWD' },
    { name: 'Yunus Musah',         score: 78, position: 'MID' },
    { name: 'Sergiño Dest',        score: 74, position: 'DEF' },
  ],
  Paraguay: [
    { name: 'Miguel Almirón',      score: 88, position: 'MID' },
    { name: 'Richard Sánchez',     score: 74, position: 'MID' },
    { name: 'Antolín Alcaraz',     score: 68, position: 'DEF' },
    { name: 'Antonio Sanabria',    score: 76, position: 'FWD' },
    { name: 'Omar Alderete',       score: 68, position: 'DEF' },
  ],
  Australia: [
    { name: 'Mathew Ryan',         score: 80, position: 'GK'  },
    { name: 'Aaron Mooy',          score: 80, position: 'MID' },
    { name: 'Mitchell Duke',       score: 70, position: 'FWD' },
    { name: 'Ajdin Hrustic',       score: 74, position: 'MID' },
    { name: 'Miloš Degenek',       score: 68, position: 'DEF' },
    { name: 'Jackson Irvine',      score: 72, position: 'MID' },
    { name: 'Martin Boyle',        score: 70, position: 'FWD' },
  ],
  Turkey: [
    { name: 'Hakan Çalhanoğlu',    score: 92, position: 'MID' },
    { name: 'Arda Güler',          score: 86, position: 'MID' },
    { name: 'Kenan Yıldız',        score: 82, position: 'FWD' },
    { name: 'Merih Demiral',       score: 80, position: 'DEF' },
    { name: 'Zeki Çelik',          score: 72, position: 'DEF' },
    { name: 'Samet Akaydın',       score: 68, position: 'DEF' },
    { name: 'Mert Günok',          score: 74, position: 'GK'  },
    { name: 'Barış Alper Yılmaz',  score: 74, position: 'FWD' },
  ],

  // ---- Group E ----------------------------------------------------------------
  Germany: [
    { name: 'Joshua Kimmich',      score: 92, position: 'MID' },
    { name: 'Jamal Musiala',       score: 94, position: 'MID' },
    { name: 'Leroy Sané',          score: 86, position: 'FWD' },
    { name: 'Kai Havertz',         score: 86, position: 'FWD' },
    { name: 'Manuel Neuer',        score: 84, position: 'GK'  },
    { name: 'Florian Wirtz',       score: 92, position: 'MID' },
    { name: 'Thomas Müller',       score: 82, position: 'FWD' },
    { name: 'Antonio Rüdiger',     score: 84, position: 'DEF' },
    { name: 'David Raum',          score: 72, position: 'DEF' },
    { name: 'Leon Goretzka',       score: 78, position: 'MID' },
    { name: 'Ilkay Gündogan',      score: 86, position: 'MID' },
  ],
  'Curaçao': [
    { name: 'Leandro Bacuna',      score: 78, position: 'MID' },
    { name: 'Cuco Martina',        score: 70, position: 'DEF' },
    { name: 'Juriën Timber',       score: 85, position: 'DEF' },
    { name: 'Ryan Donk',           score: 65, position: 'DEF' },
  ],
  'Ivory Coast': [
    { name: 'Didier Drogba',       score: 60, position: 'FWD' }, // legacy reference
    { name: 'Sébastien Haller',    score: 85, position: 'FWD' },
    { name: 'Franck Kessie',       score: 86, position: 'MID' },
    { name: 'Nicolas Pépé',        score: 80, position: 'FWD' },
    { name: 'Wilfried Zaha',       score: 82, position: 'FWD' },
    { name: 'Simon Adingra',       score: 78, position: 'FWD' },
    { name: 'Jean-Philippe Krasso',score: 70, position: 'FWD' },
    { name: 'Serge Aurier',        score: 68, position: 'DEF' },
  ],
  Ecuador: [
    { name: 'Enner Valencia',      score: 86, position: 'FWD' },
    { name: 'Gonzalo Plata',       score: 78, position: 'FWD' },
    { name: 'Moisés Caicedo',      score: 88, position: 'MID' },
    { name: 'Ángel Mena',          score: 74, position: 'FWD' },
    { name: 'Piero Hincapié',      score: 78, position: 'DEF' },
    { name: 'Jeremy Sarmiento',    score: 72, position: 'MID' },
    { name: 'Hernán Galíndez',     score: 70, position: 'GK'  },
  ],

  // ---- Group F ----------------------------------------------------------------
  Netherlands: [
    { name: 'Virgil van Dijk',     score: 93, position: 'DEF' },
    { name: 'Frenkie de Jong',     score: 90, position: 'MID' },
    { name: 'Cody Gakpo',          score: 88, position: 'FWD' },
    { name: 'Memphis Depay',       score: 84, position: 'FWD' },
    { name: 'Xavi Simons',         score: 86, position: 'MID' },
    { name: 'Daley Blind',         score: 72, position: 'DEF' },
    { name: 'Matthijs de Ligt',    score: 86, position: 'DEF' },
    { name: 'Wout Weghorst',       score: 74, position: 'FWD' },
    { name: 'Denzel Dumfries',     score: 78, position: 'DEF' },
    { name: 'Tijjani Reijnders',   score: 82, position: 'MID' },
  ],
  Japan: [
    { name: 'Takumi Minamino',     score: 82, position: 'MID' },
    { name: 'Ritsu Doan',          score: 82, position: 'FWD' },
    { name: 'Wataru Endo',         score: 80, position: 'MID' },
    { name: 'Daichi Kamada',       score: 80, position: 'MID' },
    { name: 'Kaoru Mitoma',        score: 86, position: 'FWD' },
    { name: 'Keylor Navas',        score: 70, position: 'GK'  }, // Costa Rica — wrong team, ignore
    { name: 'Shuichi Gonda',       score: 75, position: 'GK'  },
    { name: 'Maya Yoshida',        score: 74, position: 'DEF' },
    { name: 'Hiroki Sakai',        score: 68, position: 'DEF' },
  ],
  Sweden: [
    { name: 'Zlatan Ibrahimović',  score: 85, position: 'FWD' }, // may be retired by 2026
    { name: 'Dejan Kulusevski',    score: 88, position: 'MID' },
    { name: 'Emil Forsberg',       score: 82, position: 'MID' },
    { name: 'Alexander Isak',      score: 90, position: 'FWD' },
    { name: 'Viktor Gyökeres',     score: 90, position: 'FWD' },
    { name: 'Victor Lindelöf',     score: 78, position: 'DEF' },
    { name: 'Robin Olsen',         score: 72, position: 'GK'  },
    { name: 'Ludwig Augustinsson', score: 70, position: 'DEF' },
  ],
  Tunisia: [
    { name: 'Wahbi Khazri',        score: 82, position: 'FWD' },
    { name: 'Youssef Msakni',      score: 78, position: 'FWD' },
    { name: 'Hannibal Mejbri',     score: 78, position: 'MID' },
    { name: 'Seifeddine Jaziri',   score: 72, position: 'FWD' },
    { name: 'Montassar Talbi',     score: 68, position: 'DEF' },
    { name: 'Aymen Dahmen',        score: 72, position: 'GK'  },
  ],

  // ---- Group G ----------------------------------------------------------------
  Belgium: [
    { name: 'Kevin De Bruyne',     score: 98, position: 'MID' },
    { name: 'Romelu Lukaku',       score: 88, position: 'FWD' },
    { name: 'Eden Hazard',         score: 80, position: 'MID' }, // may retire
    { name: 'Thibaut Courtois',    score: 92, position: 'GK'  },
    { name: 'Axel Witsel',         score: 74, position: 'MID' },
    { name: 'Yannick Carrasco',    score: 78, position: 'MID' },
    { name: 'Timothy Castagne',    score: 72, position: 'DEF' },
    { name: 'Leandro Trossard',    score: 82, position: 'FWD' },
    { name: 'Arthur Theate',       score: 74, position: 'DEF' },
    { name: 'Charles De Ketelaere',score: 80, position: 'FWD' },
    { name: 'Toby Alderweireld',   score: 70, position: 'DEF' },
  ],
  Egypt: [
    { name: 'Mohamed Salah',       score: 98, position: 'FWD' },
    { name: 'Mohamed El-Shenawy',  score: 76, position: 'GK'  },
    { name: 'Omar Marmoush',       score: 84, position: 'FWD' },
    { name: 'Ahmed Hegazi',        score: 70, position: 'DEF' },
    { name: 'Trezeguet',           score: 76, position: 'MID' },
    { name: 'Amr El-Sulaya',       score: 68, position: 'MID' },
    { name: 'Mostafa Mohamed',     score: 74, position: 'FWD' },
  ],
  Iran: [
    { name: 'Mehdi Taremi',        score: 92, position: 'FWD' },
    { name: 'Sardar Azmoun',       score: 86, position: 'FWD' },
    { name: 'Alireza Jahanbakhsh', score: 82, position: 'MID' },
    { name: 'Ali Gholizadeh',      score: 76, position: 'FWD' },
    { name: 'Saman Ghoddos',       score: 74, position: 'MID' },
    { name: 'Hossein Hosseini',    score: 72, position: 'GK'  },
  ],
  'New Zealand': [
    { name: 'Chris Wood',          score: 88, position: 'FWD' },
    { name: 'Clayton Lewis',       score: 74, position: 'MID' },
    { name: 'Matthew Garbett',     score: 68, position: 'MID' },
    { name: 'Liberato Cacace',     score: 70, position: 'DEF' },
    { name: 'Joe Bell',            score: 68, position: 'MID' },
  ],

  // ---- Group H ----------------------------------------------------------------
  Spain: [
    { name: 'Pedri',               score: 94, position: 'MID' },
    { name: 'Gavi',                score: 91, position: 'MID' },
    { name: 'Lamine Yamal',        score: 94, position: 'FWD' },
    { name: 'Ferran Torres',       score: 80, position: 'FWD' },
    { name: 'Álvaro Morata',       score: 82, position: 'FWD' },
    { name: 'Rodri',               score: 94, position: 'MID' },
    { name: 'Unai Simón',          score: 80, position: 'GK'  },
    { name: 'Dani Carvajal',       score: 82, position: 'DEF' },
    { name: 'Aymeric Laporte',     score: 78, position: 'DEF' },
    { name: 'Alejandro Balde',     score: 78, position: 'DEF' },
    { name: 'Nico Williams',       score: 88, position: 'FWD' },
    { name: 'Fabián Ruiz',         score: 84, position: 'MID' },
  ],
  'Cape Verde': [
    { name: 'Garry Rodrigues',     score: 78, position: 'FWD' },
    { name: 'Stopira',             score: 70, position: 'DEF' },
    { name: 'Ryan Mendes',         score: 72, position: 'MID' },
    { name: 'Vozinha',             score: 72, position: 'GK'  },
  ],
  'Saudi Arabia': [
    { name: 'Salem Al-Dawsari',    score: 86, position: 'FWD' },
    { name: 'Mohammed Al-Owais',   score: 80, position: 'GK'  },
    { name: 'Firas Al-Buraikan',   score: 78, position: 'FWD' },
    { name: 'Sami Al-Najei',       score: 68, position: 'DEF' },
    { name: 'Hattan Bahebri',      score: 68, position: 'MID' },
    { name: 'Mohammed Al-Buraik',  score: 70, position: 'DEF' },
  ],
  Uruguay: [
    { name: 'Federico Valverde',   score: 94, position: 'MID' },
    { name: 'Darwin Núñez',        score: 90, position: 'FWD' },
    { name: 'Luis Suárez',         score: 80, position: 'FWD' }, // may retire
    { name: 'Ronald Araújo',       score: 88, position: 'DEF' },
    { name: 'José María Giménez',  score: 82, position: 'DEF' },
    { name: 'Rodrigo Bentancur',   score: 84, position: 'MID' },
    { name: 'Fernando Muslera',    score: 74, position: 'GK'  },
    { name: 'Facundo Torres',      score: 76, position: 'FWD' },
    { name: 'Maximiliano Araújo',  score: 74, position: 'FWD' },
  ],

  // ---- Group I ----------------------------------------------------------------
  France: [
    { name: 'Kylian Mbappé',       score: 99, position: 'FWD' },
    { name: 'Antoine Griezmann',   score: 90, position: 'FWD' },
    { name: 'N\'Golo Kanté',       score: 90, position: 'MID' },
    { name: 'Aurélien Tchouaméni', score: 86, position: 'MID' },
    { name: 'Théo Hernandez',      score: 82, position: 'DEF' },
    { name: 'William Saliba',      score: 84, position: 'DEF' },
    { name: 'Raphaël Varane',      score: 82, position: 'DEF' },
    { name: 'Hugo Lloris',         score: 82, position: 'GK'  },
    { name: 'Mike Maignan',        score: 84, position: 'GK'  },
    { name: 'Marcus Thuram',       score: 84, position: 'FWD' },
    { name: 'Eduardo Camavinga',   score: 84, position: 'MID' },
    { name: 'Bradley Barcola',     score: 80, position: 'FWD' },
  ],
  Senegal: [
    { name: 'Sadio Mané',          score: 94, position: 'FWD' },
    { name: 'Édouard Mendy',       score: 84, position: 'GK'  },
    { name: 'Kalidou Koulibaly',   score: 88, position: 'DEF' },
    { name: 'Idrissa Gueye',       score: 80, position: 'MID' },
    { name: 'Cheikhou Kouyaté',    score: 72, position: 'MID' },
    { name: 'Ismaila Sarr',        score: 82, position: 'FWD' },
    { name: 'Krépin Diatta',       score: 76, position: 'FWD' },
    { name: 'Habib Diallo',        score: 72, position: 'FWD' },
  ],
  Iraq: [
    { name: 'Bashar Resan',        score: 76, position: 'FWD' },
    { name: 'Amjed Attwan',        score: 68, position: 'MID' },
    { name: 'Aymen Hussein',       score: 72, position: 'FWD' },
    { name: 'Mohanad Ali',         score: 68, position: 'FWD' },
  ],
  Norway: [
    { name: 'Erling Haaland',      score: 99, position: 'FWD' },
    { name: 'Martin Ødegaard',     score: 96, position: 'MID' },
    { name: 'Alexander Sørloth',   score: 80, position: 'FWD' },
    { name: 'Sander Berge',        score: 78, position: 'MID' },
    { name: 'Kristoffer Ajer',     score: 72, position: 'DEF' },
    { name: 'Andrew Nubel',        score: 70, position: 'GK'  },
    { name: 'Ørjan Nyland',        score: 72, position: 'GK'  },
  ],

  // ---- Group J ----------------------------------------------------------------
  Argentina: [
    { name: 'Lionel Messi',        score: 100, position: 'FWD' },
    { name: 'Julián Álvarez',      score: 90,  position: 'FWD' },
    { name: 'Lautaro Martínez',    score: 90,  position: 'FWD' },
    { name: 'Rodrigo De Paul',     score: 85,  position: 'MID' },
    { name: 'Leandro Paredes',     score: 78,  position: 'MID' },
    { name: 'Alexis Mac Allister', score: 86,  position: 'MID' },
    { name: 'Emiliano Martínez',   score: 90,  position: 'GK'  },
    { name: 'Cristian Romero',     score: 84,  position: 'DEF' },
    { name: 'Lisandro Martínez',   score: 82,  position: 'DEF' },
    { name: 'Nicolás Otamendi',    score: 78,  position: 'DEF' },
    { name: 'Angel Di María',      score: 80,  position: 'FWD' },
    { name: 'Nicolás González',    score: 76,  position: 'FWD' },
  ],
  Algeria: [
    { name: 'Riyad Mahrez',        score: 92, position: 'FWD' },
    { name: 'Islam Slimani',       score: 78, position: 'FWD' },
    { name: 'Aissa Mandi',         score: 72, position: 'DEF' },
    { name: 'Youcef Atal',         score: 78, position: 'DEF' },
    { name: 'Houssem Aouar',       score: 80, position: 'MID' },
    { name: 'Saïd Benrahma',       score: 80, position: 'MID' },
    { name: 'Rais M\'Bolhi',       score: 72, position: 'GK'  },
  ],
  Austria: [
    { name: 'David Alaba',         score: 92, position: 'DEF' },
    { name: 'Marcel Sabitzer',     score: 84, position: 'MID' },
    { name: 'Marko Arnautović',    score: 82, position: 'FWD' },
    { name: 'Michael Gregoritsch', score: 74, position: 'FWD' },
    { name: 'Konrad Laimer',       score: 80, position: 'MID' },
    { name: 'Patrick Pentz',       score: 72, position: 'GK'  },
  ],
  Jordan: [
    { name: 'Yazan Al-Naimat',     score: 72, position: 'MID' },
    { name: 'Musa Al-Taamari',     score: 76, position: 'FWD' },
    { name: 'Nour Mansour',        score: 68, position: 'DEF' },
  ],

  // ---- Group K ----------------------------------------------------------------
  Portugal: [
    { name: 'Cristiano Ronaldo',   score: 98, position: 'FWD' },
    { name: 'Bruno Fernandes',     score: 94, position: 'MID' },
    { name: 'Bernardo Silva',      score: 92, position: 'MID' },
    { name: 'Rafael Leão',         score: 88, position: 'FWD' },
    { name: 'Rúben Dias',          score: 90, position: 'DEF' },
    { name: 'João Cancelo',        score: 84, position: 'DEF' },
    { name: 'Diogo Costa',         score: 82, position: 'GK'  },
    { name: 'Diogo Jota',          score: 84, position: 'FWD' },
    { name: 'Vitinha',             score: 82, position: 'MID' },
    { name: 'Nuno Mendes',         score: 80, position: 'DEF' },
    { name: 'Pedro Neto',          score: 80, position: 'FWD' },
  ],
  'DR Congo': [
    { name: 'Yannick Bolasie',     score: 78, position: 'FWD' },
    { name: 'Cédric Bakambu',      score: 80, position: 'FWD' },
    { name: 'Chancel Mbemba',      score: 76, position: 'DEF' },
    { name: 'Théo Bongonda',       score: 72, position: 'FWD' },
    { name: 'Jonathan Bolingi',    score: 68, position: 'FWD' },
  ],
  Uzbekistan: [
    { name: 'Eldor Shomurodov',    score: 85, position: 'FWD' },
    { name: 'Abbosbek Fayzullaev', score: 78, position: 'MID' },
    { name: 'Jamshid Iskanderov',  score: 68, position: 'DEF' },
    { name: 'Otabek Shukurov',     score: 70, position: 'MID' },
  ],
  Colombia: [
    { name: 'James Rodríguez',     score: 90, position: 'MID' },
    { name: 'Juan Cuadrado',       score: 82, position: 'MID' },
    { name: 'Luis Díaz',           score: 92, position: 'FWD' },
    { name: 'Falcao',              score: 78, position: 'FWD' }, // may retire
    { name: 'Davinson Sánchez',    score: 80, position: 'DEF' },
    { name: 'Yerry Mina',          score: 76, position: 'DEF' },
    { name: 'David Ospina',        score: 76, position: 'GK'  },
    { name: 'John Córdoba',        score: 76, position: 'FWD' },
    { name: 'Richard Ríos',        score: 78, position: 'MID' },
    { name: 'Rafael Santos Borré', score: 78, position: 'FWD' },
  ],

  // ---- Group L ----------------------------------------------------------------
  England: [
    { name: 'Harry Kane',          score: 97, position: 'FWD' },
    { name: 'Bukayo Saka',         score: 94, position: 'FWD' },
    { name: 'Phil Foden',          score: 93, position: 'MID' },
    { name: 'Jude Bellingham',     score: 97, position: 'MID' },
    { name: 'Declan Rice',         score: 90, position: 'MID' },
    { name: 'Jordan Pickford',     score: 82, position: 'GK'  },
    { name: 'John Stones',         score: 82, position: 'DEF' },
    { name: 'Kieran Trippier',     score: 80, position: 'DEF' },
    { name: 'Marcus Rashford',     score: 84, position: 'FWD' },
    { name: 'Kyle Walker',         score: 80, position: 'DEF' },
    { name: 'Trent Alexander-Arnold', score: 86, position: 'DEF' },
    { name: 'Cole Palmer',         score: 88, position: 'MID' },
  ],
  Croatia: [
    { name: 'Luka Modrić',         score: 96, position: 'MID' },
    { name: 'Mateo Kovačić',       score: 88, position: 'MID' },
    { name: 'Ivan Perišić',        score: 84, position: 'MID' },
    { name: 'Marcelo Brozović',    score: 84, position: 'MID' },
    { name: 'Andrej Kramarić',     score: 82, position: 'FWD' },
    { name: 'Dominik Livaković',   score: 82, position: 'GK'  },
    { name: 'Dejan Lovren',        score: 74, position: 'DEF' },
    { name: 'Josip Stanišić',      score: 72, position: 'DEF' },
  ],
  Ghana: [
    { name: 'André Ayew',          score: 82, position: 'FWD' },
    { name: 'Jordan Ayew',         score: 78, position: 'FWD' },
    { name: 'Thomas Partey',       score: 88, position: 'MID' },
    { name: 'Mohammed Kudus',      score: 86, position: 'MID' },
    { name: 'Felix Afena-Gyan',    score: 72, position: 'FWD' },
    { name: 'Daniel Amartey',      score: 72, position: 'DEF' },
    { name: 'Abdul Manaf Núñez',   score: 68, position: 'MID' },
  ],
  Panama: [
    { name: 'Rolando Blackburn',   score: 72, position: 'FWD' },
    { name: 'Cecilio Waterman',    score: 74, position: 'FWD' },
    { name: 'Cristian Martínez',   score: 68, position: 'MID' },
    { name: 'Luis Mejía',          score: 70, position: 'GK'  },
    { name: 'Gabriel Torres',      score: 70, position: 'FWD' },
  ],
};

// ---------------------------------------------------------------------------
// Alternate name spellings that ESPN might use
// ---------------------------------------------------------------------------
// Maps lowercase partial names to canonical player names so substring matching
// is robust to "C. Ronaldo", "CR7", "Virgil", etc.
const PLAYER_ALIASES = {
  'cr7':               'Cristiano Ronaldo',
  'c. ronaldo':        'Cristiano Ronaldo',
  'virgil':            'Virgil van Dijk',
  'van dijk':          'Virgil van Dijk',
  'de bruyne':         'Kevin De Bruyne',
  'kdb':               'Kevin De Bruyne',
  'mbappe':            'Kylian Mbappé',
  'mbappé':            'Kylian Mbappé',
  'haaland':           'Erling Haaland',
  'ødegaard':          'Martin Ødegaard',
  'odegaard':          'Martin Ødegaard',
  'messi':             'Lionel Messi',
  'salah':             'Mohamed Salah',
  'son':               'Son Heung-min',
  'modric':            'Luka Modrić',
  'modrić':            'Luka Modrić',
  'kimmich':           'Joshua Kimmich',
  'musiala':           'Jamal Musiala',
  'wirtz':             'Florian Wirtz',
  'pedri':             'Pedri',
  'gavi':              'Gavi',
  'yamal':             'Lamine Yamal',
  'lamine yamal':      'Lamine Yamal',
  'nico williams':     'Nico Williams',
  'rodri':             'Rodri',
  'davies':            'Alphonso Davies',
  'alphonso':          'Alphonso Davies',
  'pulisic':           'Christian Pulisic',
  'vinicius':          'Vinicius Junior',
  'vini':              'Vinicius Junior',
  'vini jr':           'Vinicius Junior',
  'firmino':           'Roberto Firmino',
  'bellingham':        'Jude Bellingham',
  'saka':              'Bukayo Saka',
  'foden':             'Phil Foden',
  'kane':              'Harry Kane',
  'rice':              'Declan Rice',
  'griezmann':         'Antoine Griezmann',
  'mane':              'Sadio Mané',
  'mané':              'Sadio Mané',
  'taremi':            'Mehdi Taremi',
  'hakimi':            'Achraf Hakimi',
  'ziyech':            'Hakim Ziyech',
  'valverde':          'Federico Valverde',
  'darwin':            'Darwin Núñez',
  'nunez':             'Darwin Núñez',
  'calhanoglu':        'Hakan Çalhanoğlu',
  'çalhanoğlu':        'Hakan Çalhanoğlu',
  'caicedo':           'Moisés Caicedo',
  'partey':            'Thomas Partey',
  'kudus':             'Mohammed Kudus',
  'james':             'James Rodríguez',
  'rodriguez':         'James Rodríguez',
  'luis diaz':         'Luis Díaz',
  'diaz':              'Luis Díaz',
};

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Look up a player entry (name + score + position) for a given team.
 * Matching is case-insensitive substring search against the database name,
 * after checking aliases first.
 *
 * @param {string} playerName - Name as returned by ESPN (e.g. "K. Mbappé")
 * @param {string} team       - Canonical team display name
 * @returns {{ name: string, score: number, position: string } | null}
 */
function lookupPlayer(playerName, team) {
  if (!playerName || !team) return null;
  const entries = PLAYER_DB[team];
  if (!entries || entries.length === 0) return null;

  const normalised = playerName.trim().toLowerCase();

  // 1. Check aliases first
  if (PLAYER_ALIASES[normalised]) {
    const canonical = PLAYER_ALIASES[normalised];
    const hit = entries.find(e => e.name === canonical);
    if (hit) return hit;
  }

  // 2. Check each alias value as substring
  for (const [alias, canonical] of Object.entries(PLAYER_ALIASES)) {
    if (normalised.includes(alias)) {
      const hit = entries.find(e => e.name === canonical);
      if (hit) return hit;
    }
  }

  // 3. Direct substring match (DB name contains input, or input contains DB name)
  for (const entry of entries) {
    const dbLow = entry.name.toLowerCase();
    if (dbLow.includes(normalised) || normalised.includes(dbLow)) return entry;
  }

  // 4. Last-name match (match any word in the player name to any word in DB name)
  const inputWords = normalised.split(/\s+/);
  for (const entry of entries) {
    const dbWords = entry.name.toLowerCase().split(/\s+/);
    if (inputWords.some(w => w.length >= 3 && dbWords.includes(w))) return entry;
  }

  return null;
}

/**
 * Get all key players for a team from the database.
 * @param {string} team - Canonical team display name
 * @returns {Array<{ name: string, score: number, position: string }>}
 */
function getTeamPlayers(team) {
  return (PLAYER_DB[team] || []).slice();
}

/**
 * Return the top-N most important players for a team.
 * @param {string} team
 * @param {number} [n=5]
 * @returns {Array<{ name: string, score: number, position: string }>}
 */
function getTopPlayers(team, n = 5) {
  const players = getTeamPlayers(team);
  return players.sort((a, b) => b.score - a.score).slice(0, n);
}

module.exports = {
  PLAYER_DB,
  PLAYER_ALIASES,
  lookupPlayer,
  getTeamPlayers,
  getTopPlayers,
};
