# golfprob

PGA Tour probability engine: one Monte Carlo tournament simulator feeds every market (win, top-N, make-cut, 2-balls, 3-balls), plus weather, a parlay builder, DraftKings Classic, best plays and a grading tracker.

One of the owner's seven sibling apps (cfbprob, golfprob, hrprob, nascarprob, nflprob, nhlprob,
ufcprob), each its own repo and Vercel project, sharing the same stack and design kit.

## Layout

- `lib/espn.js`, `lib/store.js`, `lib/tournament.js`, `lib/teetimes.js`: fields, results, tee times.
- `lib/ratings.js`, `lib/simulator.js`, `lib/cut-rules.js`: player ratings and the tournament
  simulator (only standard cut rules are trusted).
- `lib/weather.js`, `lib/weather-writeup.js`: wave-by-wave weather and its written briefing.
- `lib/parlay.js`, `lib/plays.js`, `lib/dk.js`, `lib/dk-optimizer.js`: products.
- `lib/grading.js`, `lib/backtest.js`: the accuracy record.
- `docs/BUILD-READOUT.md`: the model in detail. `TOURS` env var selects tours.

## Open items

- Offered, not yet decided: audit the Best plays / pick lists for the same live-rebuild problem
  nhlprob had (plays changing once the event starts); add a write-once lock if so.

## How to work in this repo

- **Commands:** `npm test` runs the test suite (synthetic data, no network). After editing
  `app.html`, extract its `<script>` block and run `node --check` on it.
- **Deploy:** Vercel deploys `main` automatically; there's no build step. Pushing straight to `main`
  is fine for this project. A hard refresh (Cmd+Shift+R) may be needed after a deploy.
- **Secrets:** the database URL and any keys live in Vercel's environment variables. Refer to
  variable names only; never put values in code, commits or messages.
- **Stack:** Vercel serverless functions in `api/` (one file per route, `_util.js` shared), model
  and data code in `lib/`, the whole frontend in one `app.html` (vanilla JS, no framework), optional
  Postgres via `lib/db.js` (`DATABASE_URL`, `POSTGRES_URL` or the Prisma/Supabase variants).

## House rules (the owner's preferences)

- **Data first, honestly reported.** Model changes are checked on real past games (a leak-free
  replay: each day predicted only from earlier days) before they're called improvements, and
  results are reported as measured, including when a change doesn't help.
- **Public pages speak plainly.** No internal jargon, debug chips or "how we built it" notes on the
  page: that knowledge stays in the code and docs.
- **Picks lock.** Anything shown as the day's pick is saved write-once before the first start and
  never changes after; a database that doesn't answer writes nothing and shows "unconfirmed".
- **Never** put an AI model name in commits or code.
