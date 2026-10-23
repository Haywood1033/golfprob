# golfprob — PGA Tour probability engine

Same stack and philosophy as nflprob: Vercel serverless functions + optional Supabase Postgres +
a single-file vanilla-JS frontend (`app.html`), free data only, every model output shipped with
its "why".

**The core idea:** one Monte Carlo tournament simulator feeds every market, so finishing odds,
top-N, make-cut, 2-balls and 3-balls can never contradict each other.

## Tabs

| Tab | What it shows |
|---|---|
| **Finishing odds** | Win / top 5 / top 10 / top 20 / make cut, fair odds, avg finish, draw (AM/PM) with weather cost, signals, confidence. Once the event starts, a **Pos** column shows leaderboard position, total to par and holes completed (sortable). Click a player for the finish distribution, recent rounds, tee times and reasoning. Upload book odds for an Edge column. |
| **Matchups** | Every 3-ball / 2-ball from the real tee sheet (R2 projected from R1 until posted), dead-heat-adjusted. Upload a CSV of book prices → de-vigged edges and a "best prices" list ranked by EV. **Parlay builder:** tap players to add legs; legs are priced together inside the simulation (shared wave, same player both rounds), with fair odds and EV vs your book. **Auto-build** finds the best 2/3/4-leg parlays (by EV with book prices, else most likely). |
| **DraftKings** | DK Classic projections (mean, floor, ceiling) from the same sims. Upload DKSalaries.csv → exact optimizer (6 golfers, $50k): Projection / Balanced / Ceiling, 1–150 lineups, exposure cap, min unique players, draw (wave) stacking, locks/excludes, exposure table, and a CSV in DK's upload format. |
| **Weather** | Draw verdict with ensemble agreement, day cards, hourly wind/gust chart with ensemble band and wave ribbons, direction strip, wind-by-wave compass, rain and temperature, a wave comparison table, and a full generated briefing. |
| **Model & backtest** | History data status, the **live track record** (each week's locked pre-tournament projection graded when final: market skill, winner rank, 3-ball favorites vs expected) and a leak-free backtest: Brier / log loss vs no-skill, calibration chart + table, per-event results. |

## How the model works

1. **History** (`lib/store.js`) — every completed round from ESPN (PGA + LIV + DP World by default,
   `TOURS` env to change), stored in `golf_rounds`. Without a database it falls back to fetching
   the most recent ~40 events live.
2. **Field-strength adjustment** (`lib/ratings.js`) — two-way fixed effects
   `strokes = round difficulty + player ability`, solved by alternating least squares, so a 68
   against a weak field isn't worth a 68 at a major. Players who cross tours link the scales.
3. **Projection** — recency-weighted (0.975 per round + 1-year half-life) mean of adjusted rounds,
   regressed toward a below-average prior (k = 5 rounds); per-player variance regressed to 2.8;
   course history regressed hard (k = 16, capped ±0.8). Confidence tier from rounds in the last year.
4. **Simulation** (`lib/simulator.js`) — 15,000 tournaments: a per-week form draw (plus skill
   uncertainty), per-round noise, shared wave shocks, the cut (rule from ESPN → event name → field
   size), integer scores so ties/dead heats/pushes happen naturally, playoffs. Completed rounds use
   real scores; a round in progress uses strokes so far + only the remaining holes.
5. **DraftKings** (`lib/dk.js`, `lib/dk-optimizer.js`) — each simulated round score becomes expected
   DK hole points via tour-average par-3/4/5 outcome rates tilted to match the score (exact bogey-free
   and birdie-streak probabilities over the real hole pars), plus finish points and the under-70 bonus
   from the same sims. The optimizer is nflprob's exact knapsack (full prefix table), brute-force
   verified; multiple lineups are each the exact best under exposure/uniqueness rules (branch and
   bound), with exact dominance pruning. Runs in a Web Worker.
6. **Parlays** (`lib/parlay.js`) — legs settled per simulated tournament (3-ball dead heats, 2-ball
   pushes), so the joint probability is counted, not multiplied.
7. **Grading** (`lib/grading.js`) — the pre-tournament projection is re-saved on every visit until the
   first tee time; finished events are graded on visit and by the weekly cron.
8. **Weather** (`lib/weather.js`) — Open-Meteo hourly forecast + GFS 31-member ensemble. Each tee
   time's cost averages ~5 hours of conditions (wind², gusts > 25 mph, heavy rain). Each sim draws
   one ensemble member, so forecast uncertainty flows into the odds. Weekend tee order follows the
   simulated leaderboard. `lib/weather-writeup.js` writes the briefing from the same numbers.

## Status — what's verified and what isn't

- ✅ **32 tests pass** (`npm test`) on synthetic data with known ground truth: fixed effects recover
  true skill across strong/weak fields, no leakage, probabilities sum correctly (one winner, top-10
  dead-heat shares sum to 10), 3-ball prices match brute force, wave costs move the right players,
  and an end-to-end run of every route with mocked ESPN/Open-Meteo.
- ✅ **ESPN and Open-Meteo confirmed reachable from the deployment** (`/api/health`, Oct 23 2026).
  Findings applied: the leaderboard has per-round strokes / to-par / nine totals but **no
  hole-by-hole detail**; the competition's round number lags the players' own; only the current
  round carries a start hole. Rounds in progress are rebuilt from the course's hole pars + today's
  to-par. Hole-by-hole (needed for DK scoring) will come from ESPN's core API in the DFS step.
- ⚠️ The weather cost coefficients are a stated heuristic (v0). Calibrate them against stored wave
  splits once a season of tee times is in the database.
- ⚠️ Backtests don't apply weather yet (no stored tee times for past events).

## Deploy

1. Import this repo to Vercel.
2. (Recommended) Set `DATABASE_URL` to a Supabase Postgres connection string. Tables create
   themselves on first use.
3. Deploy, then open `/api/health` to confirm ESPN + Open-Meteo shapes.
4. Backfill history: call `/api/sync?tour=pga&season=2025` (then `2026`, and `tour=liv`,
   `tour=eur`) repeatedly until each returns `remaining: 0`. A weekly cron keeps it current.

Without a database everything still works — the model just runs on a shorter live history.

## API

| Route | Purpose |
|---|---|
| `/api/tournament?tour=pga&event={id}&sims=15000` | Field, ratings, simulated odds, matchups |
| `/api/weather?tour=pga&event={id}` | Forecast, waves, draw verdict, briefing |
| `/api/events?tour=pga&season=2026` | Season calendar for the event picker |
| `/api/backtest?tour=pga&events=8` | Leak-free backtest |
| `/api/sync?tour=pga&season=2025` | Backfill completed events into Postgres |
| `POST /api/parlay` | Price a parlay `{legs:[{round,id,dec}]}` or auto-build `{auto:{round,size}}` |
| `/api/grades` | Grade finished snapshots, return the live track record |
| `/api/status` | History data status |
| `/api/health` | Upstream checks + ESPN shape report |

`lat`/`lon` query params override the course location if the lookup is wrong.

## Odds upload format

```csv
market,round,player,odds
3ball,1,Scottie Scheffler,+150
3ball,1,"Aberg, Ludvig",+220
2ball,3,Xander Schauffele,-115
top10,,Rory McIlroy,+275
```

Markets: `3ball`, `2ball`, `win`, `top5`, `top10`, `top20`, `make_cut`. American or decimal odds.
Names match through accents, "Last, First", initials and Jr./III suffixes (an ambiguous name is never
guessed). Uploaded files stay in the browser (localStorage), per event.

## Next

- DK hole-by-hole calibration: the per-hole outcome rates are tour averages; ESPN's core API has
  hole-by-hole scores to fit them per course once wired in
- Weather in backtests (store tee times for past events)
- Recalibrate the high-probability end if the 50–70% top-20 bin stays overconfident in live grades
