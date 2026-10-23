// Parlay pricing from the simulation, and grading of locked snapshots.
const test = require('node:test');
const assert = require('node:assert');
const { simulate, priceGroup } = require('../lib/simulator');
const { groupIndex, priceParlay, autoParlays } = require('../lib/parlay');
const { gradeSnapshot } = require('../lib/grading');

function field(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `f${i}`, name: `F${i}`, status: 'ACTIVE', rounds: [], rating: { sg: 1.5 - (3 * i) / (n - 1), sd: 2.8, se: 0.2 } }));
}
// 3-balls f0-f2, f3-f5, ... in R1; 2-balls of the first 20 in R3 (just for pricing).
function payloadFor(sim, n) {
  const three = [];
  for (let i = 0; i + 2 < n; i += 3) three.push([`f${i}`, `f${i + 1}`, `f${i + 2}`]);
  const two = [];
  for (let i = 0; i + 1 < 20; i += 2) two.push([`f${i}`, `f${i + 1}`]);
  const grp = (round, ids) => ({ local: '8:00 AM', startHole: 1, wave: 'AM', players: priceGroup(sim, round, ids).map(x => ({ ...x })) });
  return { matchups: [{ round: 1, groups: three.map(ids => grp(1, ids)) }, { round: 3, groups: two.map(ids => grp(3, ids)) }] };
}

test('parlay: single leg equals its group price; legs in different groups ~ independent', () => {
  const sim = simulate({ players: field(60), cut: null, sims: 6000, seed: 21 });
  const idx = groupIndex(payloadFor(sim, 60));
  const one = priceParlay(sim, [{ round: 1, id: 'f0' }], idx);
  assert.ok(Math.abs(one.joint - priceGroup(sim, 1, ['f0', 'f1', 'f2'])[0].deadHeat) < 1e-9);
  const two = priceParlay(sim, [{ round: 1, id: 'f0' }, { round: 1, id: 'f30' }], idx);
  assert.ok(Math.abs(two.lift - 1) < 0.08, `no shared weather -> lift ≈ 1, got ${two.lift}`);
  assert.ok(Math.abs(two.fairDecimal - 1 / two.joint) < 1e-9);
});

test('parlay: same group is rejected, EV uses dead-heat settlement', () => {
  const sim = simulate({ players: field(30), cut: null, sims: 4000, seed: 22 });
  const idx = groupIndex(payloadFor(sim, 30));
  assert.match(priceParlay(sim, [{ round: 1, id: 'f0' }, { round: 1, id: 'f1' }], idx).error, /same group/);
  // At exactly fair odds for a single leg, EV ≈ 0.
  const p = priceParlay(sim, [{ round: 1, id: 'f3' }], idx);
  const fair = priceParlay(sim, [{ round: 1, id: 'f3', dec: 1 / p.joint }], idx);
  assert.ok(Math.abs(fair.ev) < 1e-6, `fair-odds EV ${fair.ev}`);
});

test('parlay: 2-ball pushes void the leg instead of losing it', () => {
  const sim = simulate({ players: field(30), cut: null, sims: 4000, seed: 23 });
  const idx = groupIndex(payloadFor(sim, 30));
  const r = priceParlay(sim, [{ round: 3, id: 'f0', dec: 1.9 }], idx);
  const g = priceGroup(sim, 3, ['f0', 'f1'])[0];
  // hit = outright win + push; EV = win*1.9 + push*1 - 1.
  assert.ok(Math.abs(r.joint - (g.outright + g.tie)) < 1e-9);
  assert.ok(Math.abs(r.ev - (g.outright * 1.9 + g.tie - 1)) < 1e-6);
});

test('auto parlays: ranked, one leg per group, honest about small pools', () => {
  const sim = simulate({ players: field(60), cut: null, sims: 3000, seed: 24 });
  const idx = groupIndex(payloadFor(sim, 60));
  const cands = [...idx.values()].filter(g => g.round === 1).flatMap(g => g.ids.map(id => ({ round: 1, id })));
  const out = autoParlays(sim, idx, cands, { size: 3, count: 5 });
  assert.strictEqual(out.parlays.length, 5);
  for (let i = 1; i < 5; i++) assert.ok(out.parlays[i - 1].joint >= out.parlays[i].joint);
  for (const p of out.parlays) assert.strictEqual(new Set(p.legs.map(l => l.group.ids.join())).size, 3);
  const small = autoParlays(sim, idx, [{ round: 1, id: 'f0' }], { size: 3 });
  assert.strictEqual(small.parlays.length, 0);
  assert.match(small.note, /at least 2/);
});

test('grading: markets, calibration sums and 3-ball favorites', () => {
  const players = Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, odds: { win: i === 0 ? 0.3 : 0.7 / 29, top10Any: i < 10 ? 0.6 : 0.15, top20Any: i < 20 ? 0.8 : 0.2, makeCut: i < 20 ? 0.9 : 0.3 } }));
  const ev = { players: players.map((p, i) => ({ id: p.id, name: p.name, status: i < 20 ? 'ACTIVE' : 'CUT', position: i < 20 ? String(i + 1) : 'CUT', rounds: [{ round: 1, strokes: 70 + (i % 3), complete: true }] })) };
  const snap = { players, matchups: [{ round: 1, groups: [[{ id: 'p0', deadHeat: 0.5 }, { id: 'p1', deadHeat: 0.3 }, { id: 'p2', deadHeat: 0.2 }]] }] };
  const g = gradeSnapshot(snap, ev);
  assert.strictEqual(g.winner, 'P0');
  assert.strictEqual(g.winnerRank, 1);
  assert.strictEqual(g.markets.win.n, 30);
  assert.ok(g.markets.top20.brier < g.markets.top20.brierBase, 'informative probabilities beat the base rate');
  assert.strictEqual(g.markets.top20.bins.reduce((s, b) => s + b.n, 0), 30);
  assert.deepStrictEqual([g.threeBalls.groups, g.threeBalls.favActual, g.threeBalls.favExpected], [1, 1, 0.5]);
});
