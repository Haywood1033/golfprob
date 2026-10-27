// GET /api/health?tour=pga — checks every upstream source from the live deployment and reports
// which ESPN fields actually resolved, so the parser can be confirmed against the real shape
// (the dev sandbox can't reach ESPN or Open-Meteo).
//
// GET /api/health?tour=pga&event={id} — audit one event's parse instead: how many rounds each
// player should have (4 if they made the cut, 2 if not) vs how many parsed as complete, with the
// raw ESPN linescores for the players that don't add up.
const { fetchJson } = require('../lib/http');
const { shapeReport, parseLeaderboard } = require('../lib/espn');
const { roundsFromEvent } = require('../lib/store');
const { tourParam, param, send } = require('./_util');

async function auditEvent(tour, eventId) {
  const raw = await fetchJson(`https://site.web.api.espn.com/apis/site/v2/sports/golf/leaderboard?league=${tour}&event=${eventId}`);
  const ev = parseLeaderboard(raw, tour);
  if (!ev) return { error: 'No event in the ESPN response' };
  const rawById = new Map((raw.events[0].competitions[0].competitors || []).map(c => [String(c.id), c]));
  const statusCounts = {};
  const perRound = {};
  const mismatches = [];
  for (const p of ev.players) {
    statusCounts[p.status] = (statusCounts[p.status] || 0) + 1;
    for (const r of p.rounds) {
      const k = `R${r.round}`;
      perRound[k] = perRound[k] || { complete: 0, incomplete: 0 };
      perRound[k][r.complete ? 'complete' : 'incomplete']++;
    }
    const expected = p.status === 'CUT' ? 2 : p.status === 'ACTIVE' ? ev.numberOfRounds : null;
    const got = p.rounds.filter(r => r.complete).length;
    if (expected !== null && got !== expected && mismatches.length < 8) {
      const c = rawById.get(p.id) || {};
      mismatches.push({
        name: p.name, status: p.status, position: p.position, expected, got,
        rawStatus: { period: c.status?.period, thru: c.status?.thru, type: c.status?.type?.name, detail: c.status?.type?.detail || c.status?.displayValue },
        rawRounds: (c.linescores || []).map(l => ({ period: l.period, value: l.value, displayValue: l.displayValue, out: l.outScore, in: l.inScore })),
        parsed: p.rounds.map(r => ({ round: r.round, complete: r.complete, strokes: r.strokes })),
      });
    }
  }
  const rows = roundsFromEvent(ev);
  return {
    excluded: require('../lib/store').excludedReason(ev),
    event: { id: ev.id, name: ev.name, state: ev.state, scoringSystem: ev.scoringSystem, rounds: ev.numberOfRounds, par: ev.course.par, cut: ev.cut, statusDetail: ev.statusDetail },
    players: ev.players.length, statusCounts, perRound, storedRows: rows.length,
    mismatchCount: ev.players.filter(p => {
      const e = p.status === 'CUT' ? 2 : p.status === 'ACTIVE' ? ev.numberOfRounds : null;
      return e !== null && p.rounds.filter(r => r.complete).length !== e;
    }).length,
    mismatches,
  };
}

async function check(name, fn) {
  const t = Date.now();
  try { const out = await fn(); return { name, ok: true, ms: Date.now() - t, ...out }; }
  catch (err) { return { name, ok: false, ms: Date.now() - t, error: err.message }; }
}

module.exports = async (req, res) => {
  const tour = tourParam(req);
  const eventId = param(req, 'event');
  if (eventId) {
    try { return send(res, 200, await auditEvent(tour, eventId)); }
    catch (err) { return send(res, 502, { error: err.message }); }
  }
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
    // Snapshot storage: fails only when a database is configured but doesn't answer; with none
    // configured it passes and says projections aren't being saved.
    check('snapshot-storage', async () => {
      const st = await require('../lib/store').snapshotStatus();
      if (st.variable && !st.connected) throw new Error(st.note);
      return st;
    }),
  ]);
  send(res, checks.every(c => c.ok) ? 200 : 502, { tour, checks, database: require('../lib/db').dbVar });
};
