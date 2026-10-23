// GET /api/sync?tour=pga&season=2025 — backfill completed events into Postgres. Each call does
// as much as fits in ~45s and reports `remaining`; call again until it reaches 0. The weekly
// cron (?cron=1) syncs the current season for every configured tour.
const { syncSeason, DEFAULT_TOURS } = require('../lib/store');
const db = require('../lib/db');
const { param, numParam, tourParam, send, fail } = require('./_util');

module.exports = async (req, res) => {
  try {
    if (!db.hasDb) return send(res, 400, { error: 'DATABASE_URL is not set — history sync needs Postgres.' });
    const deadline = Date.now() + 45000;
    const season = numParam(req, 'season', new Date().getUTCFullYear(), { min: 2015, max: 2100 });
    const tours = param(req, 'cron') ? DEFAULT_TOURS : [tourParam(req)];
    const results = [];
    for (const tour of tours) {
      if (Date.now() > deadline) break;
      results.push(await syncSeason(tour, season, { deadline }));
    }
    send(res, 200, { season, results });
  } catch (err) { fail(res, err); }
};
