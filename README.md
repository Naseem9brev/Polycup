# Polycup

A dependency-free Node.js CLI that predicts the **2026 FIFA World Cup**. It
computes Elo ratings from ~49,000 historical international matches, feeds them
into a Poisson scoring model, and runs a Monte Carlo simulation of the full
48-team tournament (10,000 runs by default) to estimate every team's odds of
winning the title, reaching the final, and reaching the semis. It then drops you
into an interactive prompt where you can type two teams and get a head-to-head
prediction.

> **Disclaimer:** Polycup is a probabilistic model for entertainment only — it
> is **not betting advice**.

## Requirements

- Node.js **>= 18** (uses the built-in global `fetch`; developed on Node 24).
- **No `npm install` step.** There are zero third-party dependencies.

## Usage

Run directly:

```bash
node polycup.js
```

Or, optionally, install it as a global command (no third-party deps are pulled
in):

```bash
npm link        # then run:
polycup
```

Configure the number of Monte Carlo iterations (default 10,000):

```bash
node polycup.js --sims=50000
node polycup.js 2000
```

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
> Brazil vs France     # head-to-head match prediction
> titles               # reprint the full title-odds table
> teams                # list all 48 qualified teams + groups
> backtest 2022        # validate against the 2022 World Cup
> help                 # show available commands
> quit                 # exit
```

Team names are matched loosely: `Brazil`, `BRA`, and `bra` all resolve to the
same team. A head-to-head prints win/draw/loss probabilities for each side, each
team's expected goals, and the single most likely scoreline:

```
  Brazil  vs  France
  ----------------------------------------
  Brazil win : 21.7%
  Draw       : 25.2%
  France win : 53.1%
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
seven files:

| File | Responsibility |
|---|---|
| `elo.js` | Downloads/caches the results dataset, replays every played match in chronological order, and computes an Elo strength rating for every national team. |
| `dixoncoles.js` | Dixon-Coles adjustment for the Poisson goal model, plus data-driven estimation of the dependence parameter ρ from historical matches. |
| `simulation.js` | Expected-goals model, analytic match prediction, and Monte Carlo group stage + knockout bracket simulation. |
| `backtest.js` | Validates the model against past World Cups (2018 and 2022) by rebuilding pre-tournament Elo ratings and comparing predictions to actual results. |
| `calibration.js` | Calibration metrics (Brier score, Expected Calibration Error) for the backtest. |
| `worldcup2026.js` | The 48 qualified teams, their group assignments, and the name mapping between this project's display names and the dataset's spellings (plus loose CLI aliases). |
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
- **Knockout ties** are decided by a penalty shootout lightly weighted by Elo
  (not a coin flip, not deterministic).
- The full tournament runs **10,000 times by default**, tallying how often each
  team reaches each stage.

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

## Data source

Historical international results come from
[martj42/international_results](https://github.com/martj42/international_results)
(`results.csv`) — free, no API key, ~49,000+ matches from 1872 to present.
