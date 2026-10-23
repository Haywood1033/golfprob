// lib/backtest.js — leak-free backtest over completed events. For each event the model is rebuilt
// from ONLY the rounds dated before that event's first round (loadRounds({before}) plus the
// asOf filter inside rateField), then the event is simulated from scratch with no knowledge of
// its own scores, and the probabilities are graded against what actually happened.
//
// Scores: Brier and log loss per market vs a no-skill baseline (every player gets the market's
// base rate, e.g. 20/field for top 20), and calibration buckets: when the model says 30%, does
// it happen ~30% of the time? Weather is not applied in v0 backtests (no stored tee times yet).

const db = require('./db');
const { fetchCalendar, fetchLeaderboard } = require('./espn');
const { loadRounds, excludedReason } = require('./store');
const { rateField } = require('./ratings');
const { simulate } = require('./simulator');
const { cutRule } = require('./cut-rules');
const { hashSeed } = require('./rng');

const MARKETS = [
  { key: 'win', label: 'Win', prob: o => o.win, hit: pos => pos === 1, base: n => 1 / n },
  { key: 'top10', label: 'Top 10', prob: o => o.top10Any, hit: pos => pos !== null && pos <= 10, base: n => 10 / n },
  { key: 'top20', label: 'Top 20', prob: o => o.top20Any, hit: pos => pos !== null && pos <= 20, base: n => 20 / n },
  { key: 'makeCut', label: 'Make cut', prob: o => o.makeCut, hit: (pos, made) => made, base: (n, rate) => rate },
];
const BINS = [0, 0.05, 0.1, 0.2, 0.35, 0.5, 0.7, 0.85, 1.0001];

function parsePos(p) {
  const m = String(p.position || '').match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

async function recentCompletedEvents(tour, limit) {
  if (db.hasDb) {
    await db.ensureTables();
    const res = await db.query(`SELECT event_id AS id, name, start_date FROM golf_events WHERE tour=$1 AND completed ORDER BY start_date DESC LIMIT $2`, [tour, limit]);
    return res.rows.map(r => ({ id: r.id, name: r.name }));
  }
  const y = new Date().getUTCFullYear();
  const cal = (await Promise.all([y, y - 1].map(s => fetchCalendar(tour, s).catch(() => [])))).flat();
  return cal.filter(e => e.endDate && new Date(e.endDate).getTime() + 86400000 < Date.now())
    .sort((a, b) => new Date(b.startDate) - new Date(a.startDate)).slice(0, limit);
}

async function runBacktest({ tour = 'pga', limit = 8, sims = 4000, deadline = Date.now() + 50000 } = {}) {
  const events = await recentCompletedEvents(tour, limit);
  const { rows } = await loadRounds({ before: new Date() });
  const scored = []; // per player-market rows
  const perEvent = [];

  let stoppedEarly = false;
  for (const e of events) {
    if (Date.now() > deadline) { stoppedEarly = true; break; }
    const ev = await fetchLeaderboard(tour, e.id).catch(() => null);
    if (!ev || ev.state !== 'post' || !ev.startDate) continue;
    const start = ev.startDate.slice(0, 10);
    const field = ev.players.filter(p => p.status !== 'WD' && p.status !== 'DQ');
    if (field.length < 30 || excludedReason(ev)) continue;

    const { ratings, courseOffset } = rateField(field, rows, { asOf: start, courseNames: [ev.course.name] });
    const pre = field.map(p => ({ id: p.id, name: p.name, status: 'ACTIVE', rounds: [], rating: ratings.get(p.id) }));
    const cut = cutRule(ev);
    const sim = simulate({ players: pre, par: ev.course.par, courseOffset: courseOffset ?? 0.3, numberOfRounds: ev.numberOfRounds, cut, sims, seed: hashSeed(ev.id) });
    const byId = new Map(sim.results.map(r => [r.id, r]));

    const made = p => p.status !== 'CUT' && p.status !== 'MDF';
    const madeRate = field.filter(made).length / field.length;
    let ll = 0;
    for (const p of field) {
      const o = byId.get(p.id);
      const pos = made(p) ? parsePos(p) : null;
      for (const m of MARKETS) {
        if (m.key === 'makeCut' && !cut.top) continue;
        const pr = Math.min(0.999, Math.max(0.001, m.prob(o)));
        const y = m.hit(pos, made(p)) ? 1 : 0;
        scored.push({ market: m.key, p: pr, y, base: Math.min(0.999, Math.max(0.001, m.base(field.length, madeRate))) });
        if (m.key === 'top20') ll += -(y * Math.log(pr) + (1 - y) * Math.log(1 - pr));
      }
    }
    const winner = field.find(p => parsePos(p) === 1);
    const ranked = [...sim.results].sort((a, b) => b.win - a.win);
    perEvent.push({
      id: ev.id, name: ev.name, date: start, field: field.length,
      winner: winner?.name || null,
      winnerProb: winner ? byId.get(winner.id)?.win ?? null : null,
      winnerRank: winner ? ranked.findIndex(r => r.id === winner.id) + 1 : null,
      favorite: ranked[0] ? field.find(p => p.id === ranked[0].id)?.name : null,
      favoriteProb: ranked[0]?.win ?? null,
      top20LogLoss: ll / field.length,
    });
  }

  const markets = MARKETS.map(m => {
    const list = scored.filter(s => s.market === m.key);
    if (!list.length) return { key: m.key, label: m.label, n: 0 };
    const brier = list.reduce((s, x) => s + (x.p - x.y) ** 2, 0) / list.length;
    const brierBase = list.reduce((s, x) => s + (x.base - x.y) ** 2, 0) / list.length;
    const logLoss = list.reduce((s, x) => s - (x.y * Math.log(x.p) + (1 - x.y) * Math.log(1 - x.p)), 0) / list.length;
    const logLossBase = list.reduce((s, x) => s - (x.y * Math.log(x.base) + (1 - x.y) * Math.log(1 - x.base)), 0) / list.length;
    const bins = [];
    for (let b = 0; b < BINS.length - 1; b++) {
      const inBin = list.filter(x => x.p >= BINS[b] && x.p < BINS[b + 1]);
      if (!inBin.length) continue;
      bins.push({
        lo: BINS[b], hi: Math.min(1, BINS[b + 1]), n: inBin.length,
        predicted: inBin.reduce((s, x) => s + x.p, 0) / inBin.length,
        actual: inBin.reduce((s, x) => s + x.y, 0) / inBin.length,
      });
    }
    return { key: m.key, label: m.label, n: list.length, brier, brierBase, skill: 1 - brier / brierBase, logLoss, logLossBase, bins };
  });

  return { tour, eventsRequested: events.length, eventsScored: perEvent.length, sims, historyRounds: rows.length, markets, events: perEvent, stoppedEarly };
}

module.exports = { runBacktest, parsePos };
