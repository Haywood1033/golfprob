// lib/grading.js — grades the locked pre-tournament snapshots against what happened, so the
// track record builds week by week alongside the backtest. Same scoring as lib/backtest.js
// (Brier and log loss vs a no-skill baseline, calibration bins), plus 3-ball results for R1/R2.
//
// Grades are stored as additive sums on each snapshot row (golf_snapshots.graded), so pooling
// across any set of events is just adding them up — no re-fetching old leaderboards.

const db = require('./db');
const { fetchLeaderboard } = require('./espn');
const { parsePos } = require('./backtest');

const BINS = [0, 0.05, 0.1, 0.2, 0.35, 0.5, 0.7, 0.85, 1.0001];
const MARKETS = [
  { key: 'win', label: 'Win', prob: o => o.win, hit: (pos) => pos === 1, base: n => 1 / n },
  { key: 'top10', label: 'Top 10', prob: o => o.top10Any ?? o.top10, hit: pos => pos !== null && pos <= 10, base: n => 10 / n },
  { key: 'top20', label: 'Top 20', prob: o => o.top20Any ?? o.top20, hit: pos => pos !== null && pos <= 20, base: n => 20 / n },
  { key: 'makeCut', label: 'Make cut', prob: o => o.makeCut, hit: (pos, made) => made, base: (n, rate) => rate },
];

const clamp = p => Math.min(0.999, Math.max(0.001, p));
function emptyAgg() {
  return { n: 0, brier: 0, brierBase: 0, logLoss: 0, logLossBase: 0, bins: BINS.slice(0, -1).map(() => ({ n: 0, pred: 0, hit: 0 })) };
}
function addTo(agg, p, y, base) {
  p = clamp(p); base = clamp(base);
  agg.n++;
  agg.brier += (p - y) ** 2; agg.brierBase += (base - y) ** 2;
  agg.logLoss -= y * Math.log(p) + (1 - y) * Math.log(1 - p);
  agg.logLossBase -= y * Math.log(base) + (1 - y) * Math.log(1 - base);
  const b = BINS.findIndex((lo, i) => p >= lo && p < BINS[i + 1]);
  agg.bins[b].n++; agg.bins[b].pred += p; agg.bins[b].hit += y;
}

// snapshot = golf_snapshots.payload; ev = the completed ESPN event.
function gradeSnapshot(snapshot, ev) {
  const made = p => p.status !== 'CUT' && p.status !== 'MDF';
  const byId = new Map(ev.players.map(p => [p.id, p]));
  const field = snapshot.players.filter(sp => sp.odds && byId.has(sp.id) && !['WD', 'DQ'].includes(byId.get(sp.id).status));
  const cutHappened = ev.players.some(p => p.status === 'CUT');
  const madeRate = field.filter(sp => made(byId.get(sp.id))).length / (field.length || 1);
  const markets = {};
  for (const m of MARKETS) {
    if (m.key === 'makeCut' && !cutHappened) continue;
    const agg = emptyAgg();
    for (const sp of field) {
      const p = byId.get(sp.id);
      const pos = made(p) ? parsePos(p) : null;
      addTo(agg, m.prob(sp.odds), m.hit(pos, made(p)) ? 1 : 0, m.base(field.length, madeRate));
    }
    markets[m.key] = agg;
  }

  // 3-balls: model favorite's settled share vs the share the model expected for it.
  const threeBalls = { groups: 0, favExpected: 0, favActual: 0, brier: 0 };
  for (const m of snapshot.matchups || []) {
    for (const g of m.groups) {
      const strokes = g.map(x => byId.get(x.id)?.rounds.find(r => r.round === m.round)?.strokes ?? null);
      if (g.length < 2 || strokes.some(v => v === null)) continue;
      const lo = Math.min(...strokes), nLo = strokes.filter(v => v === lo).length;
      const fav = g.reduce((a, b, i) => (b.deadHeat > g[a].deadHeat ? i : a), 0);
      threeBalls.groups++;
      threeBalls.favExpected += g[fav].deadHeat;
      threeBalls.favActual += strokes[fav] === lo ? 1 / nLo : 0;
      g.forEach((x, i) => { threeBalls.brier += (x.deadHeat - (strokes[i] === lo ? 1 / nLo : 0)) ** 2; });
    }
  }

  const winner = ev.players.find(p => parsePos(p) === 1);
  const ranked = [...field].sort((a, b) => b.odds.win - a.odds.win);
  return {
    field: field.length,
    winner: winner?.name || null,
    winnerProb: winner ? field.find(sp => sp.id === winner.id)?.odds.win ?? null : null,
    winnerRank: winner ? ranked.findIndex(sp => sp.id === winner.id) + 1 || null : null,
    favorite: ranked[0]?.name || null, favoriteProb: ranked[0]?.odds.win ?? null,
    markets, threeBalls,
  };
}

function summarize(agg, label, key) {
  if (!agg || !agg.n) return { key, label, n: 0 };
  return {
    key, label, n: agg.n,
    brier: agg.brier / agg.n, brierBase: agg.brierBase / agg.n, skill: 1 - agg.brier / agg.brierBase,
    logLoss: agg.logLoss / agg.n, logLossBase: agg.logLossBase / agg.n,
    bins: agg.bins.map((b, i) => (b.n ? { lo: BINS[i], hi: Math.min(1, BINS[i + 1]), n: b.n, predicted: b.pred / b.n, actual: b.hit / b.n } : null)).filter(Boolean),
  };
}

// Grade every snapshot whose event has finished, then pool everything graded so far.
async function gradeAll({ deadline = Date.now() + 40000 } = {}) {
  if (!db.hasDb) return { available: false, note: 'Grading needs DATABASE_URL — snapshots are stored in Postgres.' };
  await db.ensureTables();
  const pending = await db.query(`SELECT event_id, tour, name, payload FROM golf_snapshots WHERE graded IS NULL ORDER BY start_date NULLS LAST`);
  const newlyGraded = [];
  for (const row of pending.rows) {
    if (Date.now() > deadline) break;
    const ev = await fetchLeaderboard(row.tour, row.event_id).catch(() => null);
    if (!ev || ev.state !== 'post') continue;
    const graded = gradeSnapshot(row.payload, ev);
    await db.query(`UPDATE golf_snapshots SET graded=$2, graded_at=NOW() WHERE event_id=$1`, [row.event_id, JSON.stringify(graded)]);
    newlyGraded.push(row.name);
  }
  const all = await db.query(`SELECT event_id, tour, name, start_date, saved_at, graded FROM golf_snapshots ORDER BY start_date DESC NULLS LAST`);
  const pooled = {};
  const tb = { groups: 0, favExpected: 0, favActual: 0, brier: 0 };
  const events = [];
  for (const r of all.rows) {
    if (!r.graded) { events.push({ id: r.event_id, name: r.name, date: r.start_date, status: 'pending', savedAt: r.saved_at }); continue; }
    for (const [k, a] of Object.entries(r.graded.markets)) {
      const p = pooled[k] || (pooled[k] = emptyAgg());
      p.n += a.n; p.brier += a.brier; p.brierBase += a.brierBase; p.logLoss += a.logLoss; p.logLossBase += a.logLossBase;
      a.bins.forEach((b, i) => { p.bins[i].n += b.n; p.bins[i].pred += b.pred; p.bins[i].hit += b.hit; });
    }
    for (const k of Object.keys(tb)) tb[k] += r.graded.threeBalls?.[k] || 0;
    const { markets, threeBalls, ...rest } = r.graded;
    events.push({ id: r.event_id, name: r.name, date: r.start_date, status: 'graded', ...rest, top20Skill: markets.top20 ? 1 - markets.top20.brier / markets.top20.brierBase : null, threeBalls });
  }
  return {
    available: true,
    newlyGraded,
    eventsGraded: events.filter(e => e.status === 'graded').length,
    markets: MARKETS.map(m => summarize(pooled[m.key], m.label, m.key)),
    threeBalls: tb.groups ? { groups: tb.groups, favExpected: tb.favExpected / tb.groups, favActual: tb.favActual / tb.groups, brier: tb.brier / tb.groups } : null,
    events,
  };
}

module.exports = { gradeSnapshot, gradeAll };
