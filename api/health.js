// GET /api/health?tour=pga — checks every upstream source from the live deployment and reports
// which ESPN fields actually resolved, so the parser can be confirmed against the real shape
// (the dev sandbox can't reach ESPN or Open-Meteo).
const { fetchJson } = require('../lib/http');
const { shapeReport, parseLeaderboard } = require('../lib/espn');
const { tourParam, send } = require('./_util');

async function check(name, fn) {
  const t = Date.now();
  try { const out = await fn(); return { name, ok: true, ms: Date.now() - t, ...out }; }
  catch (err) { return { name, ok: false, ms: Date.now() - t, error: err.message }; }
}

module.exports = async (req, res) => {
  const tour = tourParam(req);
  const checks = await Promise.all([
    check('espn-calendar', async () => {
      const d = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/golf/${tour}/scoreboard?dates=${new Date().getUTCFullYear()}`);
      const cal = d?.leagues?.[0]?.calendar || [];
      return { events: cal.length, sample: cal[0] || null };
    }),
    check('espn-leaderboard', async () => {
      const d = await fetchJson(`https://site.web.api.espn.com/apis/site/v2/sports/golf/leaderboard?league=${tour}`);
      const ev = parseLeaderboard(d, tour);
      const p = ev?.players?.[0];
      return {
        shape: shapeReport(d),
        parsed: ev ? { id: ev.id, name: ev.name, state: ev.state, round: ev.currentRound, course: ev.course, players: ev.players.length,
          withTeeTimes: ev.players.filter(x => x.teeTime).length, samplePlayer: p ? { ...p, rounds: p.rounds.map(r => ({ ...r, holes: r.holes.length })) } : null } : null,
      };
    }),
    check('open-meteo-forecast', async () => {
      const d = await fetchJson('https://api.open-meteo.com/v1/forecast?latitude=30.198&longitude=-81.394&hourly=wind_speed_10m&forecast_days=1');
      return { hours: d?.hourly?.time?.length || 0 };
    }),
    check('open-meteo-ensemble', async () => {
      const d = await fetchJson('https://ensemble-api.open-meteo.com/v1/ensemble?latitude=30.198&longitude=-81.394&hourly=wind_speed_10m&models=gfs025&forecast_days=1');
      return { members: Object.keys(d?.hourly || {}).filter(k => k.startsWith('wind_speed_10m')).length };
    }),
  ]);
  send(res, checks.every(c => c.ok) ? 200 : 502, { tour, checks, database: !!process.env.DATABASE_URL });
};
