// GET /api/sync?tour=pga&season=2025 — backfill completed events into Postgres. Each call does
// as much as fits in ~45s and reports `remaining`; call again until it reaches 0. The weekly
// cron (?cron=1) syncs the current season for every configured tour.
// GET /api/sync?snapshot=1 — builds each tour's current event so its pre-tournament projection is
// saved even if nobody opens the site before the first tee time (daily cron).
const { syncSeason, DEFAULT_TOURS } = require('../lib/store');
const db = require('../lib/db');
const { param, numParam, tourParam, send, fail } = require('./_util');

async function snapshots() {
  const { buildTournament } = require('../lib/tournament');
  const out = [];
  for (const tour of DEFAULT_TOURS) {
    try {
      const p = await buildTournament({ tour });
      out.push({ tour, event: p.event?.name || null, state: p.event?.state || null, snapshot: p.snapshot || { saved: false, reason: p.event?.state === 'pre' ? 'not saved' : `event is ${p.event?.state}, only pre-event projections are saved` } });
    } catch (err) { out.push({ tour, error: err.message }); }
  }
  return out;
}

module.exports = async (req, res) => {
  try {
    if (param(req, 'snapshot')) return send(res, 200, { snapshots: await snapshots() });
    if (!db.hasDb) return send(res, 400, { error: `No database connected — set ${db.DB_VARS[0]} (or ${db.DB_VARS[1]}). History sync needs Postgres.` });
    const deadline = Date.now() + 45000;
    const season = numParam(req, 'season', new Date().getUTCFullYear(), { min: 2015, max: 2100 });
    const tours = param(req, 'cron') ? DEFAULT_TOURS : [tourParam(req)];
    const results = [];
    for (const tour of tours) {
      if (Date.now() > deadline) break;
      results.push(await syncSeason(tour, season, { deadline }));
    }
    // The weekly cron also grades last week's locked projections.
    let grading = null;
    if (param(req, 'cron')) grading = await require('../lib/grading').gradeAll({ deadline: Date.now() + 10000 }).then(g => g.newlyGraded).catch(err => ({ error: err.message }));
    send(res, 200, { season, results, grading });
  } catch (err) { fail(res, err); }
};
