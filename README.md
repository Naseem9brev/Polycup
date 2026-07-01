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
polycup --xg             # pre-build xG model on startup
polycup --bracket=out.html --report=out.html --json --csv=out.csv
```

### Interactive commands

```
> Brazil vs France          # head-to-head prediction
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
| `--xg` | off | Pre-build match xG model on startup |
| `--format=json` | — | Print title odds as JSON and exit |
| `--favorites=A,B` | — | Highlight teams in odds table |
| `--bracket=file` | — | Write HTML bracket and exit |
| `--report=file` | — | Write HTML report and exit |
| `--json[=file]` | — | Export odds JSON |
| `--csv=file` | — | Export odds CSV |
| `--no-config` | — | Ignore config files |

Defaults can be stored in `~/.polycup/config.json` or `.polycuprc.json`.

## How it works

**Elo → xG → Dixon-Coles/Poisson → Monte Carlo**

- **Elo** (`elo.js`): Replay ~49,000 matches oldest-to-newest. K-factor weighted by match importance, goal margin, and home advantage.
- **Dixon-Coles** (`dixoncoles.js`): Bivariate Poisson correction for low-scoring draws. ρ estimated via MLE from the cached dataset.
- **Simulation** (`simulation.js`): 12 groups round-robin, top 2 + 8 best third-placers advance; official FIFA 2026 bracket seeding.
- **Penalty shootout** (`penalty.js`): Blends historical shootout results, Elo pressure, taker quality, and host bonus. Use `penalty <A> vs <B>`.
- **Live/Watch** (`live.js`, `watch.js`): `live` locks played matches and re-simulates. `watch` polls ESPN every 30s for in-match score/events, adjusts xG by remaining time, and displays auto-updating win probabilities.
- **Lineup-aware Elo** (`players.js`, `lineupelo.js`): Player importance database (0–100 scale) for all 48 teams. Absent key players reduce team Elo (`score × 0.30`, capped at ±80). Use `lineups <A> vs <B>`.
- **Match xG** (`matchxg.js`) [EXPERIMENTAL]: Per-team attack/defense rates from recency- and importance-weighted historical goals. Blends 60% Elo + 40% rate model.
- **Player xG** (`playerxg.js`) [EXPERIMENTAL]: Per-player recency-weighted goals/90, adjusted for squad depth. Blends 65% Elo + 35% player data.
- **Club form** (`clubform.js`) [EXPERIMENTAL]: National team strength estimated from club minutes, league strength (UEFA coefficients, Premier League = 1.0), and club stats. No transfer values. Elo adjustment ±40 max.
- **Backtest** (`backtest.js`): Validates against 2018/2022 WC — accuracy, log-loss, Brier score, ECE. 2022: 54.7% accuracy, Argentina given ~23% title odds.
- **Exports** (`bracket.js`, `report.js`, `export.js`, `profile.js`): Self-contained HTML bracket, full HTML report, JSON/CSV odds, per-team profile cards.

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
