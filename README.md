<p align="center">
  ⚽🏆🇺🇸🇲🇽🇨🇦🇧🇷🇦🇷🇫🇷🇩🇪🇪🇸🇳🇱🇵🇹🇮🇹🇧🇪🇺🇾🇭🇷🇯🇵🇰🇷🇲🇦⚽🏆
</p>

<h1 align="center">⚽ Polycup 🏆</h1>

<p align="center">
  <strong>Node.js · Elo · Dixon-Coles · Poisson · Monte Carlo</strong>
</p>

A dependency-free Node.js CLI that predicts the **2026 FIFA World Cup**. Builds Elo ratings from ~49,000 historical internationals, runs a Dixon-Coles scoring model, and Monte Carlo simulates the full 48-team bracket (10,000 runs) to produce title odds for every team.

> **Disclaimer:** For entertainment only — not betting advice.

## Install

```bash
npm install -g polycup   # global install
npx polycup              # no install
```

Or from source:

```bash
git clone https://github.com/avikabra/Polycup.git && cd Polycup
node polycup.js
```

Requires Node.js >= 18. Zero third-party dependencies.

## Usage

```bash
polycup                  # run simulation + interactive prompt
polycup --sims=50000     # more iterations
polycup --context        # apply venue/travel/rest/altitude adjustments in simulation
polycup --xg             # pre-build xG model on startup
polycup --bracket=out.html --report=out.html --json --csv=out.csv
```

### Interactive commands

```
> Brazil vs France          # head-to-head prediction
> context Brazil vs France  # venue/travel/rest/altitude adjustments and revised prediction
> venue Brazil vs France at Mexico City  # explicit venue context
> xg Brazil vs France       # [EXPERIMENTAL] match-level xG vs Elo baseline
> player Brazil vs France   # [EXPERIMENTAL] player-level xG prediction
> clubform Brazil vs France # [EXPERIMENTAL] club-form-adjusted prediction
> penalty Brazil vs France  # penalty shootout prediction (alias: shootout)
> lineups Brazil vs France  # lineup-adjusted prediction (live ESPN data)
> watch                     # list today's live matches
> watch USA vs Mexico       # attach to a live match (auto-updating)
> live                      # lock played matches, re-simulate the rest
> titles                    # reprint title-odds table
> profile Brazil            # team card: Elo, path odds, form, schedule
> bracket / report          # export HTML bracket or full report
> export json / export csv  # export odds
> backtest 2022             # validate against 2018/2022 World Cup
> help / quit
```

Team names are fuzzy-matched — `BRA`, `bra`, `Brazl` all resolve correctly.

### Flags

| Flag | Default | Purpose |
|---|---|---|
| `--sims=N` | 10000 | Monte Carlo iterations |
| `--seed=VALUE` | — | Reproducible run (checkpoints every 1k, use `--resume` to continue) |
| `--rho=VALUE` | estimated | Override Dixon-Coles ρ |
| `--context` | off | Apply venue/travel/rest/altitude adjustments in tournament simulation |
| `--xg` | off | Pre-build match xG model on startup |
| `--format=json` | — | Print title odds as JSON and exit |
| `--favorites=A,B` | — | Highlight teams in odds table |
| `--bracket=file` | — | Write HTML bracket and exit |
| `--report=file` | — | Write HTML report and exit |
| `--json[=file]` | — | Export odds JSON |
| `--csv=file` | — | Export odds CSV |
| `--no-config` | — | Ignore config files |

Defaults can be stored in `~/.polycup/config.json` or `.polycuprc.json`.

## Features & models

### Core simulation pipeline

**Elo ratings** (`elo.js`) — the foundation of every prediction. Every international match since the 19th century is replayed in order, and each result updates both teams' ratings using a K-factor weighted by match importance (World Cup > continental tournaments > qualifiers > friendlies), goal margin, and home advantage. This gives a single number capturing long-run team strength that automatically accounts for squad changes over time.

**Dixon-Coles model** (`dixoncoles.js`, `simulation.js`) — Elo gaps are converted to expected goals, then match outcomes are drawn from a bivariate Poisson distribution with a Dixon-Coles correction. Standard independent-Poisson models under-count 0-0 and 1-1 draws and over-count 0-1/1-0 results. The correction factor ρ is estimated via maximum likelihood from the cached results dataset rather than taken from literature, so it reflects actual international football scoring patterns.

**Monte Carlo tournament** (`simulation.js`) — the full 48-team bracket runs 10,000 times. Each run draws match scores from the Dixon-Coles model, resolves group standings (points → goal difference → Elo tiebreak), picks the 8 best third-placed teams per the FIFA criteria, and seeds the knockout bracket using the official FIFA 2026 fixed-seeding template. The result is a probability distribution over every possible finishing position for every team.

---

### Penalty shootout model (`penalty.js`)

Pure Elo gives each team a 50/50 chance in a shootout — clearly wrong. This model blends four signals:

| Signal | Why it helps |
|---|---|
| **Historical shootout results** (`shootouts.csv`) | Some nations (Germany, Argentina) genuinely win shootouts more than others; recent history is weighted more than old |
| **Elo rating** | Stronger teams handle pressure better; a large Elo gap produces a small but real shootout edge |
| **Taker quality** (`players.js` + `goalscorers.csv`) | Teams with more clinical forwards and higher historical penalty-goal volume have better taker depth |
| **Host bonus** | USA, Canada, Mexico get a small edge shooting in familiar conditions |

Use `penalty <A> vs <B>` or `shootout <A> vs <B>`.

---

### Live & watch modes (`live.js`, `watch.js`)

**`live`** — re-downloads the latest results, locks every already-played match, and re-simulates only the remaining fixtures. Updated title odds that reflect who has actually qualified.

**`watch <A> vs <B>`** — attaches to a live match via ESPN's public API (no key needed). Every 30 seconds it fetches the current score and events, then re-runs the prediction conditioned on the current state:
- xG is scaled by remaining time
- Red cards subtract from the affected team's effective Elo (scaled by time left)
- Recent goals add a momentum bonus

This turns the model into a live win-probability tracker rather than a static pre-match forecast.

---

### Match context adjustments (`context.js`)

The base Elo treats every match as equally convenient for both teams. In a tournament played across a continent, that is rarely true. This layer adjusts a team's effective Elo before each match based on physical and tournament context.

**Factors modeled:**

| Factor | How it works | Example |
|---|---|---|
| **Rest days** | Fewer than 3 days since the last match carries a fatigue penalty; 6+ days is neutral | 4-day turnaround ≈ -8 Elo |
| **Travel distance** | Haversine distance from the team's home base to the venue; long flights cost Elo | South Africa to Mexico City ≈ -20 Elo |
| **Time zones** | Each hour away from the team's home timezone costs a little, capped at -12 Elo | Europe to Pacific venues ≈ -9 to -12 Elo |
| **Altitude** | Teams acclimated to high altitude (≥ 1500 m) get a bonus; sea-level teams are penalized at high-altitude venues | Mexico City gives Ecuador +5, Netherlands -25 |
| **Host venue** | Playing in your own host country adds a venue-level bonus on top of the existing host-nation Elo bonus | Mexico in Mexico City ≈ +18 Elo |
| **Climate / heat** | Hot/humid venues mildly hurt teams from cool climates; heat-acclimated teams get a small bonus | Northern Europe in Miami ≈ -8 Elo |

**Data:** hardcoded tables for the 16 2026 World Cup venues (city, country, altitude, timezone, coordinates) and representative home bases for all 48 qualified teams. Fixture dates and venues are read from the cached `results.csv`.

**Usage:**
- `polycup --context` — apply adjustments during the Monte Carlo tournament simulation.
- `context <A> vs <B>` — look up the 2026 fixture and show a side-by-side base vs. context prediction.
- `venue <A> vs <B> at <venue>` — run the same analysis for an explicit venue (e.g., `venue Brazil vs France at Mexico City`).

Adjustments are intentionally small (capped at ±80 Elo per side) so they nudge the model without overwhelming the underlying Elo rating.

---

### Lineup-aware Elo (`players.js`, `lineupelo.js`)

The base Elo reflects long-run team strength, not who is actually starting on the day. This layer adjusts for absences.

**Dataset:** a hand-curated player importance database covering all 48 qualified teams. Each player has a score 0–100 (Messi = 100, reliable starter ≈ 75, fringe player ≈ 55).

**Why it helps:** if a team's Elo is built assuming their best XI, a suspended Mbappé or injured Salah is a real hit to their odds that the base rating won't capture. When lineup data is available from ESPN, any key player (score ≥ 70) missing from the confirmed XI reduces the team's effective Elo by `score × 0.30` (capped at ±80 total).

Use `lineups <A> vs <B>` for a side-by-side base vs. adjusted prediction.

---

### Match-level xG model — experimental (`matchxg.js`)

**Dataset:** `results.csv` (reuses the Elo cache) — goals scored and conceded per team per match, 2020–present.

**Model:** each team gets an attack multiplier and a defense multiplier derived from their recency- and importance-weighted goal rates, normalized against the field average. Expected goals for a match are then `(avg_xG) × attackA × defenseB` for each side. The final prediction blends **60% Elo + 40% rate model**.

**Why it helps:** Elo treats all wins equally regardless of scoreline. A team that's been crushing opponents 4-0 looks the same as one scraping 1-0 wins. The rate model captures that underlying offensive and defensive quality and corrects for it.

Use `xg <A> vs <B>` for a three-column comparison (Elo baseline · xG rate model · blended).

---

### Player-level xG model — experimental (`playerxg.js`)

**Dataset:** `goalscorers.csv` — individual goal records for ~1,000 active internationals, recency-weighted with a 3-year half-life.

**Model:** each player's goals-per-90 rate is computed (with penalty goals down-weighted to 40%), and the top 11 players per team are summed into a team attack multiplier. A defensive proxy (`1 / sqrt(attackMul)`) approximates team-level defensive quality. The final prediction blends **65% Elo + 35% player-adjusted**.

**Why it helps:** two teams can have the same Elo but very different attacking rosters — one packed with elite scorers, one with workmanlike contributors. Individual goal rates surface that difference and shift the expected-goals split accordingly.

Use `player <A> vs <B>`.

---

### Club form model — experimental (`clubform.js`)

**Dataset:** manually compiled club data — minutes played, league of each club, and club performance stats (goals, assists, tackles, clean sheets) for national team players.

**Model:** each player is scored by their club output weighted by league strength (UEFA 2024 coefficients, Premier League = 1.0 down to lower leagues ≈ 0.3). A team's club-strength score is the average across its players. The difference between two teams is converted to an Elo adjustment, capped at ±40 points.

**Why it helps:** Elo is built from international results, which are infrequent and can lag a team's current form by months. Club data is continuous — if a nation's squad is in poor form across their club sides right now, that's a signal the international Elo hasn't yet priced in. This model captures recent real-world form without relying on transfer market values.

Use `clubform <A> vs <B>` for a base vs. club-form-adjusted comparison.

---

### Backtest (`backtest.js`)

Validates the model against the 2018 and 2022 World Cups by rebuilding Elo ratings and ρ from data available *before* each tournament, then comparing predictions to actual results.

- **2022:** 54.7% match accuracy (62.5% knockouts), Brier 0.624, ECE 0.142 — Argentina given ~23% title odds
- **2018:** 54.7% match accuracy (43.8% knockouts), Brier 0.582, ECE 0.040 — France given ~7% title odds

Run `backtest 2022`, `backtest 2018`, or `backtest all` from the prompt.

---

### Exports (`bracket.js`, `report.js`, `export.js`, `profile.js`)

All outputs are self-contained and dependency-free:

| Command / flag | Output |
|---|---|
| `bracket` / `--bracket=file` | SVG knockout bracket, winner probabilities per slot |
| `report` / `--report=file` | Full HTML report: title odds, expected group standings, team paths |
| `export json` / `--json` | Title odds + full head-to-head matrix as JSON |
| `export csv` / `--csv=file` | Same as CSV |
| `profile <team>` | Terminal team card: Elo, group, path odds, recent form, schedule |

## Data sources

| Dataset | Used for | Why |
|---|---|---|
| `results.csv` ([martj42](https://github.com/martj42/international_results)) | Elo ratings, match xG model | ~49,000 international results; the most complete free dataset available |
| `goalscorers.csv` ([martj42](https://github.com/martj42/international_results)) | Player xG model | Individual goal records with dates — enables per-player scoring rate estimation |
| `shootouts.csv` ([martj42](https://github.com/martj42/international_results)) | Penalty model | Historical penalty shootout outcomes; the only public dataset with team-level shootout win rates |
| ESPN public API | Live watch mode, lineup data | Real-time scores, match events, and confirmed starting XIs — no API key required |
| Club data (compiled) | Club form model | Minutes played + league of each national team player; captures current club-level form |

All martj42 files are cached locally on first use (`.cache_results.csv`, `.cache_scorers.csv`, `.cache_shootouts.csv`). Delete a cache file to force a fresh download.

## Groups (FIFA final draw, Dec 2025)

| Group | Teams |
|---|---|
| A | Mexico, South Africa, South Korea, Czech Republic |
| B | Canada, Bosnia & Herzegovina, Qatar, Switzerland |
| C | Brazil, Morocco, Haiti, Scotland |
| D | USA, Paraguay, Australia, Turkey |
| E | Germany, Curaçao, Ivory Coast, Ecuador |
| F | Netherlands, Japan, Sweden, Tunisia |
| G | Belgium, Egypt, Iran, New Zealand |
| H | Spain, Cape Verde, Saudi Arabia, Uruguay |
| I | France, Senegal, Iraq, Norway |
| J | Argentina, Algeria, Austria, Jordan |
| K | Portugal, DR Congo, Uzbekistan, Colombia |
| L | England, Croatia, Ghana, Panama |

## Data & caching

All data comes from [martj42/international_results](https://github.com/martj42/international_results) (free, no API key). Files are cached locally on first run:

| Cache file | Source |
|---|---|
| `.cache_results.csv` | Match results (~49k rows) |
| `.cache_scorers.csv` | Goalscorers (player xG) |
| `.cache_shootouts.csv` | Penalty shootout history |

Delete any cache file to force a fresh download.

## Verification

```bash
node verify-lineupelo.js   # 58 assertions — lineup Elo model
node verify-playerxg.js    # 94 assertions — player xG model
node verify-matchxg.js     # 112 assertions — match xG model
node verify-penalty.js     # 31 assertions — penalty model
node verify-clubform.js    # 15 assertions — club form model
```
