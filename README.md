<p align="center">
  ⚽🏆🇺🇸🇲🇽🇨🇦🇧🇷🇦🇷🇫🇷🇩🇪🇪🇸🇳🇱🇵🇹🇮🇹🇧🇪🇺🇾🇭🇷🇯🇵🇰🇷🇲🇦⚽🏆
</p>

<h1 align="center">⚽ Polycup 🏆</h1>

<p align="center">
  <strong>Node.js · Elo · Dixon-Coles · Poisson · Monte Carlo</strong>
</p>

<p align="center">
  🏆🇫🇷⚽🇧🇷🇦🇷🇩🇪🇺🇸🇲🇽🇨🇦🇪🇸🇳🇱🇵🇹🇮🇹🇧🇪🇺🇾🇭🇷🇯🇵🇰🇷🇲🇦⚽🏆
</p>

A dependency-free Node.js CLI that predicts the **2026 FIFA World Cup**. It
computes Elo ratings from ~49,000 historical international matches, feeds them
into a **Dixon-Coles** scoring model, and runs a Monte Carlo simulation of the
full 48-team tournament (10,000 runs by default) to estimate every team's odds of
winning the title, reaching the final, and reaching the semis. It then drops you
into an interactive prompt where you can type two teams and get a head-to-head
prediction.

During the tournament, the `live` command re-downloads the latest results, locks
in every match already played, and only simulates the fixtures still to come.

> **Disclaimer:** Polycup is a probabilistic model for entertainment only — it
> is **not betting advice**.

## Features

- **Zero dependencies** — runs with just Node.js; no `npm install`.
- **Elo ratings** from ~49,000 historical internationals, weighted by importance,
  goal margin, and home advantage.
- **Dixon-Coles** bivariate Poisson model to fix the classic under-counting of
  low-scoring draws.
- **Official 2026 bracket** — 12 groups, 8 best third-place teams, and the FIFA
  fixed-seeding knockout bracket.
- **Live mode** — locks played matches and only simulates the rest once the
  tournament starts.
- **Watch mode** — attach to a live match and get auto-updating win/draw/loss
  probabilities, predicted final score, and event-driven model adjustments
  (red cards, momentum) via ESPN's public API. No API key needed.
- **Lineup-aware Elo** — player importance database covering all 48 qualified
  teams; automatically adjusts a team's effective Elo when star players are
  confirmed absent from the starting XI. Use `lineups <A> vs <B>` to see a
  side-by-side base vs. adjusted prediction for any match-day lineup.
- **Club form model** — [EXPERIMENTAL] estimates national team strength from
  players' recent club minutes, league strength, and club performance stats.
  No transfer market values used. Use `clubform <A> vs <B>` to compare base
  Elo predictions against club-form-adjusted predictions.
- **Backtest** — validate against the 2018 and 2022 World Cups with accuracy,
  log-loss, Brier score, and Expected Calibration Error.
- **Interactive CLI** — fuzzy team names, title-odds table, and head-to-head
  predictions.

## Requirements

- Node.js **>= 18** (uses the built-in global `fetch`; developed on Node 24).
- **No `npm install` step.** There are zero third-party dependencies.

## Installation

Choose whichever method fits your workflow. Polycup itself has no dependencies.

### npm / npx

Install globally:

```bash
npm install -g polycup
polycup
```

Or run without installing:

```bash
npx polycup
```

### From source

Clone the repository and link the command locally:

```bash
git clone https://github.com/avikabra/Polycup.git
cd Polycup
npm link        # then run:
polycup
```

### Docker

A minimal image is published to the GitHub Container Registry:

```bash
docker pull ghcr.io/avikabra/polycup:latest
docker run --rm -it ghcr.io/avikabra/polycup:latest
```

Or build the image yourself:

```bash
docker build -t polycup .
docker run --rm -it polycup
```

The container runs `polycup.js` as its entrypoint. Pass the usual arguments:

```bash
docker run --rm -it polycup --sims=50000
```

### Prebuilt binary

Download the single-file binary for your platform from the
[GitHub Releases](https://github.com/avikabra/Polycup/releases) page:

```bash
# macOS example
chmod +x polycup-macos
./polycup-macos
```

To build a binary locally, run:

```bash
npm run build:binary
./dist/polycup
```

This uses Node.js [Single Executable Applications](https://nodejs.org/api/single-executable-applications.html)
(`--experimental-sea-config`). It needs Node.js >= 20.6; `postject` is resolved
automatically via `npx` at build time and is **not** added to the package.

> **Note for local macOS builds:** Node 24's macOS binary may contain the SEA
> sentinel string more than once, which causes `postject` to fail. If that
> happens, download Node 20/22 for macOS and point the build script to it:
>
> ```bash
> SEA_NODE_BIN=/path/to/node-20 npm run build:binary
> ```
>
> The GitHub Actions release workflow already uses Node 20, so the published
> release binaries are not affected.

## Usage

Run directly:

```bash
node polycup.js
```

Or, after installing via any method above, simply run:

```bash
polycup
```

Configure the number of Monte Carlo iterations (default 10,000):

```bash
node polycup.js --sims=50000
node polycup.js 2000
```

### Options & configuration

| Flag | Purpose |
|---|---|
| `--sims=N` (or a bare number) | number of Monte Carlo iterations (default 10,000) |
| `--seed=VALUE` | seed the RNG for fully reproducible runs |
| `--resume` | resume an interrupted seeded run from `.polycup_progress.json` |
| `--rho=VALUE` | override the estimated Dixon-Coles ρ |
| `--format=json` | print title odds as JSON and exit (no prompt) |
| `--favorites=A,B` | highlight favorite teams in the odds table |
| `--no-config` | ignore config files for this run |

Defaults can be stored in a config file so you don't have to pass flags every
time. Polycup reads, in order (later overrides earlier, and CLI flags override
both):

1. `~/.polycup/config.json` — global user defaults
2. `.polycuprc.json` — project-local defaults in the working directory

```json
{
  "sims": 20000,
  "seed": "wc2026",
  "favorites": ["Brazil", "France"],
  "format": "table"
}
```

Reproducibility: with `--seed`, the same seed always produces identical odds.
A seeded run also checkpoints progress every 1,000 iterations, so a long run
interrupted with Ctrl-C can be continued with `--seed=... --resume`.

Team names are fuzzy-matched: in addition to aliases and prefixes, common typos
(`Brazl`, `Frnace`, `Swizerland`) resolve to the intended team via edit distance.
The interactive prompt also keeps a command history (up-arrow) in
`~/.polycup_history`.

### Shareable output (presentation)

Polycup can generate shareable artifacts non-interactively, then exit:

```bash
node polycup.js --bracket=bracket.html   # predicted knockout bracket (HTML + SVG)
node polycup.js --report=report.html     # full HTML report: odds, groups, paths
node polycup.js --json                   # title odds + head-to-head to stdout
node polycup.js --json=odds.json         # ... or to a file
node polycup.js --csv=odds.csv           # title odds as CSV (+ a -h2h.csv file)
```

The same artifacts are available from the interactive prompt via the `bracket`,
`report`, and `export json|csv` commands, plus a `profile <team>` command that
prints a team card (Elo, path odds, recent form, and group-stage schedule). All
outputs are self-contained and dependency-free.

### First run vs. cached runs

- **First run:** downloads the historical results dataset
  ([martj42/international_results](https://github.com/martj42/international_results),
  `results.csv`) from GitHub and caches it locally as `.cache_results.csv` in
  the working directory.
- **Subsequent runs:** load instantly from the cache — no network call.
- To force a fresh download, simply delete `.cache_results.csv`.

The dataset is live and already includes played 2026 World Cup matches, which
feed into the Elo ratings normally. Fixtures that have not been played yet carry
no score and are ignored.

### Interactive prompt

After the simulation runs and prints the title-odds table, you get a prompt:

```
> Brazil vs France          # head-to-head match prediction
> clubform Brazil vs France # [EXPERIMENTAL] club-form-adjusted prediction vs Elo baseline
> penalty Brazil vs France  # penalty shootout prediction (alias: shootout)
> player Brazil vs France   # [EXPERIMENTAL] player-level xG prediction alongside Elo
> lineups Brazil vs France  # lineup-adjusted prediction (fetches live ESPN data)
> watch                     # list today's live matches
> watch USA vs Mexico        # attach to a live match with auto-updating predictions
> titles                    # reprint the full title-odds table
> teams                     # list all 48 qualified teams + groups
> profile Brazil            # team card: Elo, path odds, recent form, group schedule
> bracket                   # write the predicted knockout bracket to an HTML file
> report                    # write a full HTML report (odds, groups, paths)
> export json               # export title odds + head-to-head as JSON
> export csv                # export title odds + head-to-head as CSV
> backtest 2022             # validate against the 2022 World Cup
> live                      # re-download latest results and lock played matches
> help                      # show available commands
> quit                      # exit
```

Team names are matched loosely: `Brazil`, `BRA`, and `bra` all resolve to the
same team. A head-to-head prints win/draw/loss probabilities for each side, each
team's expected goals, and the single most likely scoreline:

```
  Brazil  vs  France
  ----------------------------------------
  Brazil win : 22.6%
  Draw       : 23.4%
  France win : 54.0%
  Expected goals : Brazil 0.91 - 1.59 France
  Most likely score : Brazil 0-1 France
```

## Teams & groups

Per the official FIFA final draw (5 December 2025, Washington, D.C.):

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

## How it works

The pipeline is **Elo → expected goals → Dixon-Coles/Poisson → Monte Carlo**, split across
seventeen files:

| File | Responsibility |
|---|---|
| `elo.js` | Downloads/caches the results dataset, replays every played match in chronological order, and computes an Elo strength rating for every national team. |
| `dixoncoles.js` | Dixon-Coles adjustment for the Poisson goal model, plus data-driven estimation of the dependence parameter ρ from historical matches. |
| `simulation.js` | Expected-goals model, analytic match prediction, and Monte Carlo group stage + knockout bracket simulation. |
| `backtest.js` | Validates the model against past World Cups (2018 and 2022) by rebuilding pre-tournament Elo ratings and comparing predictions to actual results. |
| `calibration.js` | Calibration metrics (Brier score, Expected Calibration Error) for the backtest. |
| `live.js` | During the tournament, re-downloads the latest results, locks in played matches, and only simulates the remaining fixtures. |
| `bracket.js` | Generates a self-contained HTML/SVG visualization of the predicted knockout bracket from the Monte Carlo bracket occupancies. |
| `report.js` | Generates a single self-contained HTML report: title odds, expected group standings, and team path probabilities. |
| `export.js` | JSON and CSV exporters for the title odds and the full head-to-head prediction matrix. |
| `profile.js` | Renders a per-team text profile card (Elo, group, path odds, recent form, group-stage schedule). |
| `watch.js` | Live match watcher: polls ESPN every 30s for scores/events, feeds match state into the prediction engine, and renders an auto-refreshing terminal display. Lineup-aware Elo adjustments are shown when ESPN roster data is available. |
| `datasource.js` | ESPN public API fetcher (no auth required): live scores, lineups, formations, match events for the World Cup. |
| `matchstate.js` | Converts raw ESPN data into model-friendly state: classifies events, counts red cards, computes momentum, and derives Elo adjustments. |
| `players.js` | Player importance database (Phase 8): maps key players for all 48 World Cup teams to an importance score (0–100) used to compute lineup-aware Elo adjustments. |
| `lineupelo.js` | Lineup-aware Elo engine (Phase 8): computes per-team Elo deltas from confirmed starters vs. expected key players, with graceful degradation and display formatters for the CLI and watch mode. |
| `verify-lineupelo.js` | Verification script for the lineup Elo model: runs 58 assertions covering player lookup, absence detection, delta arithmetic, the cap, graceful degradation, and integration with `predictMatch`. |
| `config.js` | Loads defaults from `~/.polycup/config.json` and `.polycuprc.json`, validated and merged under CLI flags. |
| `rng.js` | Seedable pseudo-random number generator (sfc32) with a swappable global hook, enabling reproducible and resumable Monte Carlo runs. |
| `worldcup2026.js` | The 48 qualified teams, their group assignments, the name mapping between this project's display names and the dataset's spellings (plus loose CLI aliases), and fuzzy typo matching. |
| `playerxg.js` | **[EXPERIMENTAL]** Player-level xG model: downloads and caches `goalscorers.csv`, computes recency-weighted goals-per-90 rates for ~1,000 active internationals, and adjusts team xG lambdas based on their attacking quality relative to the field average. |
| `verify-playerxg.js` | Verification script for the player xG model: runs 94 sanity checks covering data loading, deduplication, elite-player rates, multiplier bounds, prediction shape, and known-result validation. |
| `penalty.js` | Penalty shootout model (Phase 10): downloads and caches `shootouts.csv`, blends historical shootout results, Elo pressure, taker quality, and host bonus to predict tied knockout matches. |
| `verify-penalty.js` | Verification script for the penalty shootout model: runs 31 deterministic assertions covering output shape, probability bounds, ordering, degradation, and simulation integration. |
| `clubform.js` | **[EXPERIMENTAL]** Club form model (Phase 13): estimates national team strength from players' recent club minutes, league strength (based on UEFA coefficients), and club performance stats. No transfer market values used. |
| `verify-clubform.js` | Verification script for the club form model: runs 15 deterministic tests covering league strength index, player scoring, club strength calculations, Elo adjustments, and system integration. |
| `polycup.js` | The CLI entry point: wires everything together, runs the simulation, renders the title-odds table, and launches the interactive prompt. |

### Elo model (`elo.js`)

- Every team starts at rating 1000.
- Matches are processed oldest-to-newest so ratings reflect current form.
- Each rating update is weighted by:
  - **Match importance** — World Cup > continental championship (Euros, Copa
    América, AFCON, Asian Cup, …) > qualifiers > friendlies, via tiered K
    factors.
  - **Goal margin** — bigger wins move ratings more (World Football Elo style).
  - **Home advantage** — home teams get a rating bump; matches the dataset flags
    as neutral get none.

### Scoring & simulation (`simulation.js`)

- **Expected goals:** the Elo gap between two teams splits ~2.5 total expected
  goals between them (favored team gets the larger share). Host nations (USA,
  Canada, Mexico) get a home-advantage bump.
- **Match outcome:** goals are drawn from a **Dixon-Coles** bivariate Poisson
  model instead of independent Poissons. This corrects the well-known under-
  counting of low-scoring draws (0-0, 1-1) and over-counting of 0-1/1-0 results.
- **Dixon-Coles ρ:** estimated from the cached historical dataset at run time
  via grid-search maximum likelihood (currently ~-0.04 for recent international
  matches). Falls back to a literature value if the cache is unavailable.
- **Single match prediction:** computed analytically from the Dixon-Coles joint
  distribution (no Monte Carlo needed) — instant in the CLI.
- **Tournament:** 12 groups of 4 play round-robin; standings use points, then
  goal difference, then goals scored (head-to-head / fair-play are approximated
  by an Elo tiebreak). Top 2 from each group plus the 8 best third-placed teams
  advance to a 32-team knockout bracket.
- **Bracket:** uses the official FIFA 2026 fixed seeding template — group winners
  are protected from each other in the Round of 32, and each group's winner and
  runner-up sit in opposite halves so they can only meet again in the final.
  FIFA's exact 495-row third-place lookup table is approximated by a valid
  constraint-respecting assignment.
- **Knockout calibration:** in knockout matches, the favorite's share of the
  ~2.5 xG is capped at 70%. Without this, large Elo gaps produced a simulated
  underdog win rate of only ~17%, well below the historical World Cup knockout
  rate of ~25–35%. The cap keeps the model closer to real tournament behavior
  while still letting the Elo gap matter.
- **Knockout ties** are decided by a dedicated penalty shootout model (Phase 10).
  It blends historical shootout results, Elo-derived pressure handling, a small
  host-nation bonus, and the quality of each team's likely takers. If penalty
  data is unavailable it degrades back to the Elo-damped estimate.
- The full tournament runs **10,000 times by default**, tallying how often each
  team reaches each stage.

### Penalty shootout model (`penalty.js`)

Polycup no longer resolves tied knockout matches with a simple coin flip. The
Phase 10 penalty model estimates each team's shootout strength from four
sources:

1. **Historical shootout results** — the martj42/international_results
   `shootouts.csv` is downloaded and cached as `.cache_shootouts.csv`. Recent
   shootouts are weighted more heavily, and a Laplace-smoothed win rate becomes
   the history component.
2. **Elo rating** — stronger teams are assumed to handle high-pressure knockout
   moments better; the Elo gap is converted to a modest shootout edge (much
   smaller than the equivalent open-play probability, because shootouts are
   inherently random).
3. **Likely takers** — the curated `players.js` database identifies top forwards
   and midfielders who usually take penalties, and the cached `goalscorers.csv`
   penalty-goal volume adds a proxy for taker depth.
4. **Host-nation bonus** — a small edge for USA/Canada/Mexico shooting in
   familiar conditions.

Use it from the interactive prompt:

```
> penalty Brazil vs France
> shootout Argentina vs Germany
```

The output prints a side-by-side comparison: win probability, Elo pressure,
shootout history, taker quality, host bonus, and the most likely takers for
each side.

Verification:

```bash
node verify-penalty.js
```

The script runs 31 deterministic assertions covering model construction, output
shape, probability bounds, favorite/underdog ordering, host and first-shooter
edges, graceful degradation, and integration with `simulation.js`.

### Backtesting (`backtest.js`)

The model can be validated against the 2018 and 2022 FIFA World Cups. For each
year, it:

1. Rebuilds Elo ratings using only matches before the tournament started.
2. Estimates Dixon-Coles ρ from that same pre-tournament data.
3. Predicts every match outcome (group + knockout) and compares it to the actual
   result, reporting match-level accuracy, log-loss, **Brier score**, and
   **Expected Calibration Error (ECE)**.
4. Runs the knockout bracket using the actual group-stage finishers and reports
   the predicted title odds for the actual champion.

Run it from the interactive prompt:

```
> backtest 2022
> backtest 2018
> backtest all
```

Or standalone:

```bash
node backtest.js 2022
node backtest.js 2018
node backtest.js all
```

Recent results:

- **2022:** 54.7% match-prediction accuracy (62.5% in knockouts), log-loss 1.092,
  Brier 0.624, ECE 0.142. Actual champion Argentina was given ~23% title probability.
- **2018:** 54.7% match-prediction accuracy (43.8% in knockouts), log-loss 0.990,
  Brier 0.582, ECE 0.040. Actual champion France was given ~7% title probability.

### Live simulation during the tournament (`live.js`)

Once the tournament starts, the `live` command re-downloads the latest dataset,
locks in every match that has already been played, and only simulates the
remaining fixtures. This gives updated title odds that respect the actual group
standings and any knockout results already in the book.

```
> live
```

It uses the same 2026 bracket template, group standings, and third-place
assignment as the main simulation, so the locked results flow naturally into
the rest of the bracket.

### Watch mode — live in-match predictions (`watch.js`)

Attach to a live match and get continuously updating predictions as goals,
cards, and substitutions happen:

```
> watch                    # list today's World Cup matches
> watch France vs Sweden   # attach to that match
```

The display auto-refreshes every 30 seconds, showing:

- **Live score + match minute**
- **Win/Draw/Loss probability bars** — update as events change the match state
- **Predicted final score** — the single most likely outcome given current state
- **Top 5 most likely scorelines** with probabilities
- **Remaining expected goals** — how much attacking output each team is expected
  to produce in the time left
- **Red card indicators** — a red card reduces the affected team's effective Elo
- **Match event timeline** — goals, cards, substitutions as they happen

The model works by:

1. Computing full-match expected goals from pre-match Elo (same as `predictMatch`)
2. Scaling xG by remaining time: `remainingXG = fullXG × (minutesLeft / 90)`
3. Applying state modifiers: red card = −60 Elo (scaled by remaining time),
   momentum = +15 Elo per goal in the last 10 minutes
4. Running Dixon-Coles on the *remaining* goals to get P(each possible final score)

Data comes from ESPN's public API (no API key, no signup). Press `q` + Enter to
exit watch mode and return to the interactive prompt.

Watch mode automatically incorporates lineup-aware Elo adjustments (see below)
when ESPN roster data is available for the match.

### Lineup-aware Elo adjustments (`players.js`, `lineupelo.js`)

The base Elo model captures long-run team strength, but on any given match day
the actual XI can diverge: a star striker suspended, an elite keeper injured, or
a key midfielder rested for rotation. Phase 8 translates those deviations into an
additive Elo adjustment fed directly into the prediction engine.

#### How it works

1. **Player importance database** (`players.js`) — a hand-curated roster for all
   48 qualified teams. Each entry maps a player's name to an importance score
   (0–100), where 100 is a once-in-a-generation talisman (Messi, Mbappé) and
   50–70 is a solid regular starter. Scores follow a coarse 5-point grid so minor
   name-matching noise does not produce wildly different results.

2. **Absence detection** — for each of a team's top-N (default: 5) most important
   players, the engine checks whether they appear in the confirmed starting XI. If
   a key player is missing, an Elo penalty proportional to their importance score
   is applied: `penalty = score × 0.30`. A missing Messi (score 100) → −30 Elo;
   a missing backup-quality player (score 55, below the 70-point threshold) → no
   penalty.

3. **Lineup confidence** — when no lineup data is available the delta is 0 and the
   base Elo is used unchanged. The feature gracefully degrades in all cases.

4. **Cap** — the total lineup adjustment is capped at ±80 Elo to prevent any
   single-player effect from dominating the prediction.

#### `lineups` command

```
> lineups France vs England
```

1. Fetches today's ESPN scoreboard and match summary (if available).
2. Extracts the confirmed starting XIs.
3. Computes the lineup Elo delta for each team.
4. Prints a side-by-side comparison of the **base prediction** (Elo only) vs.
   the **lineup-adjusted prediction**.

Example output:

```
  ============================================================
  LINEUP-AWARE PREDICTION: France  vs  England
  ============================================================

  France
    Base Elo      : 1842
    Lineup delta  : -30 Elo
    Adjusted Elo  : 1812
    Key players absent (1):
      ✗ Kylian Mbappé [FWD, score 99] — not in starting XI

  England
    Base Elo      : 1798
    Lineup delta  : 0 Elo
    Adjusted Elo  : 1798

  ─────────────────────────────────────────────────────────
  PREDICTION COMPARISON
  ─────────────────────────────────────────────────────────
                          Base   Adjusted
  France win             54.3%      49.2%
  Draw                   22.8%      23.4%
  England win            22.9%      27.4%

  Expected goals  (adj): France 1.19 — 1.31 England
  Most likely score     : France 1-1 England
```

The command degrades gracefully: if the match is not yet on the ESPN scoreboard,
it falls back to the base prediction with a note explaining why lineup data is
unavailable.

#### Verification

Run the self-contained smoke-test script (no network required, no Elo model download):

```bash
node verify-lineupelo.js
```

This runs 58 deterministic assertions covering player lookup, absence/presence
detection, Elo delta arithmetic, the cap, graceful degradation, format helpers,
and end-to-end integration with `predictMatch`.

### Player-level xG model — experimental (`playerxg.js`)

> **This is an experimental feature.** Results should be treated as exploratory.
> Only goals scored are used as a proxy for player quality; defensive and creative
> contributions beyond scoring are not captured.

The `player` command adds a second data dimension to any head-to-head prediction:
how does each team's *individual player roster* shift the expected-goals picture
compared to the pure Elo baseline?

```
> player Brazil vs France
```

Sample output:

```
  [EXPERIMENTAL] Player-level xG — Brazil  vs  France
  ============================================================
  Blend: 35% player data · 65% Elo
  ------------------------------------------------------------
                              Elo baseline   Player-adjusted
  ------------------------------------------------------------
  Expected goals:
    Brazil:                          0.95              1.08
    France:                          1.55              1.80
  ------------------------------------------------------------
  Brazil win:                       24.1%             23.6%
  Draw:                             23.7%             21.5%
  France win:                       52.2%             54.9%
  ------------------------------------------------------------
  Elo most likely score    : Brazil 0-1 France
  Player most likely score : Brazil 0-1 France
  ------------------------------------------------------------
  Brazil key players : Vinícius Júnior, Matheus Cunha, Raphinha, Richarlison, Rodrygo
  France key players : Kylian Mbappé, Ousmane Dembélé, Bradley Barcola, …
  Attack multipliers — Brazil: ×1.081, France: ×1.400
  ============================================================
  Note: only historical goals scored are used as a proxy for player quality.
  Defensive ratings are approximated. Results are for exploration only.
```

#### How the player model works

1. **Data source:** `goalscorers.csv` from the
   [martj42/international_results](https://github.com/martj42/international_results)
   GitHub repository — the same free, no-key source used by the Elo model.
   Downloaded and cached as `.cache_scorers.csv` on first `player` command.

2. **Recency weighting:** Goals scored further in the past count less. The weight
   decays exponentially with a half-life of ~3 years, so a goal today counts
   roughly twice as much as one scored 3 years ago.

3. **Appearances:** Because per-minute lineup data is unavailable, each player's
   appearance count is estimated as `max(scoringMatches, 35% of team's total matches)`.
   This prevents one-game heroes from inflating their goals-per-90 rate.

4. **Penalty down-weighting:** Penalty goals count at 40% to avoid over-weighting
   specialist penalty takers who are less dangerous in open play.

5. **Name deduplication:** Unicode diacritics are stripped and names are lower-
   cased before grouping, so "Julián Álvarez" and "Julián Alvarez" (dataset
   encoding variants) are treated as the same player.

6. **Team lineup:** The top 11 players by xG/90 are summed to form a team's total
   attacking output. This is normalized against the population average across all
   48 qualified teams to produce a dimensionless **attack multiplier** (1.0 = average).

7. **Defensive proxy:** Because only offensive data is available, defensive quality
   is approximated as `1 / sqrt(attack_multiplier)`. Strong scoring teams tend to
   be strong overall; this is a deliberate simplification.

8. **Lambda adjustment:**
   - `adjustedLambdaA = baseLambdaA × (mulA.attack / mulB.defense)`
   - `adjustedLambdaB = baseLambdaB × (mulB.attack / mulA.defense)`
   - **Blend:** `finalLambda = 65% × Elo_base + 35% × player_adjusted`

9. **Clamping:** Multipliers are clamped to [0.70, 1.40] to prevent extreme
   adjustments for teams with sparse or missing data.

#### Caching

The first `player` command downloads `goalscorers.csv` (~3 MB) and saves it as
`.cache_scorers.csv`. Subsequent calls load from cache instantly. To refresh,
delete `.cache_scorers.csv`.

#### Limitations

- Only goals scored feed the model — no assists, key passes, or defensive actions.
- Defensive quality is a rough proxy, not measured directly.
- Injured, suspended, or otherwise absent key players are not detected.
- The model distinguishes current vs. older squads only through recency weighting
  on individual goals, not through actual squad selection data.
- Weak scoring teams (e.g. Qatar, Haiti) may have limited data coverage;
  their multipliers fall back toward 1.0 (neutral).

#### Verification

```bash
node verify-playerxg.js
```

Runs 94 sanity checks: data loading, name deduplication, elite-player rates,
multiplier range, prediction output shape, and known-result validation.

## Data source

Historical international results come from
[martj42/international_results](https://github.com/martj42/international_results)
(`results.csv`) — free, no API key, ~49,000+ matches from 1872 to present.
