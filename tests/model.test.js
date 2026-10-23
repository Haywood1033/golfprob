// Model + simulator tests on synthetic data with known ground truth.
const test = require('node:test');
const assert = require('node:assert');
const { fitRoundEffects, rateField } = require('../lib/ratings');
const { simulate, priceGroup } = require('../lib/simulator');
const { makeRng } = require('../lib/rng');
const { cutRule } = require('../lib/cut-rules');

function corr(a, b) {
  const ma = a.reduce((s, x) => s + x, 0) / a.length, mb = b.reduce((s, x) => s + x, 0) / b.length;
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return n / Math.sqrt(da * db);
}

// 300 players, true SG in [-3, +3]. Strong events draw the top half, weak events the bottom —
// the case where naive "vs field average" gets it wrong.
function synthHistory(seed = 7) {
  const rng = makeRng(seed);
  const players = Array.from({ length: 300 }, (_, i) => ({ id: `p${i}`, name: `Player ${i}`, sg: 3 - (6 * i) / 299 }));
  const rows = [];
  for (let e = 0; e < 60; e++) {
    const strong = e % 2 === 0;
    const pool = strong ? players.slice(0, 180) : players.slice(120);
    const field = pool.filter(() => rng.uniform() < 0.75);
    const date = new Date(Date.UTC(2025, 0, 1 + e * 7)).toISOString().slice(0, 10);
    for (let r = 1; r <= 4; r++) {
      const diff = 71 + rng.normal() * 1.5;
      for (const p of field) rows.push({ tour: 'pga', eventId: `e${e}`, round: r, course: `Course ${e % 12}`, par: 72, playerId: p.id, name: p.name, strokes: Math.round(diff - p.sg + rng.normal() * 2.7), date });
    }
  }
  return { players, rows };
}

test('fixed effects recover true skill across strong and weak fields', () => {
  const { players, rows } = synthHistory();
  const { adjusted } = fitRoundEffects(rows);
  const mean = new Map();
  for (const r of adjusted) { const m = mean.get(r.playerId) || { s: 0, n: 0 }; m.s += r.sg; m.n++; mean.set(r.playerId, m); }
  const ids = players.filter(p => mean.has(p.id));
  const est = ids.map(p => mean.get(p.id).s / mean.get(p.id).n);
  assert.ok(corr(est, ids.map(p => p.sg)) > 0.97, 'adjusted SG should track true SG');

  // Naive field-relative SG compresses the gap between a weak-field star and a strong-field
  // mid-pack player; fixed effects should not.
  const weakStar = players[200], strongMid = players[100]; // true SG -1.01 vs +0.99
  const fe = id => mean.get(id).s / mean.get(id).n;
  assert.ok(fe(strongMid.id) - fe(weakStar.id) > 1.6, `gap ${fe(strongMid.id) - fe(weakStar.id)}`);
});

test('rateField shrinks unknown players to the prior and flags them thin', () => {
  const { players, rows } = synthHistory();
  const field = [players[0], players[150], { id: 'rookie', name: 'New Guy' }];
  const { ratings } = rateField(field, rows, { asOf: '2026-06-01', courseNames: ['Course 3'] });
  assert.ok(ratings.get('p0').sg > ratings.get('p150').sg);
  assert.strictEqual(ratings.get('rookie').ci, 'low');
  assert.ok(Math.abs(ratings.get('rookie').sg - -1.0) < 1e-9);
  assert.ok(ratings.get('rookie').signals.some(s => s.key === 'thin'));
});

test('rateField never sees rounds on or after asOf (no leakage)', () => {
  const { players, rows } = synthHistory();
  const asOf = '2025-06-01';
  const poisoned = rows.concat(Array.from({ length: 40 }, (_, i) => ({ tour: 'pga', eventId: 'future', round: 1 + (i % 4), course: 'X', par: 72, playerId: 'p299', name: 'Player 299', strokes: 50, date: '2025-06-01' })));
  const a = rateField([players[299]], rows, { asOf }).ratings.get('p299').sg;
  const b = rateField([players[299]], poisoned, { asOf }).ratings.get('p299').sg;
  assert.strictEqual(a, b);
});

function fieldOf(n, spread = 2) {
  return Array.from({ length: n }, (_, i) => ({
    id: `f${i}`, name: `F${i}`, status: 'ACTIVE', rounds: [],
    rating: { sg: spread - (2 * spread * i) / (n - 1), sd: 2.8, se: 0.3 },
  }));
}

test('simulator: probabilities are internally consistent', () => {
  const players = fieldOf(144);
  const sim = simulate({ players, cut: { round: 2, top: 65 }, sims: 4000, seed: 3 });
  const sum = k => sim.results.reduce((s, r) => s + r[k], 0);
  assert.ok(Math.abs(sum('win') - 1) < 1e-9, 'exactly one winner per sim');
  assert.ok(Math.abs(sum('top10') - 10) < 1e-6, 'dead-heat top 10 shares sum to 10');
  assert.ok(Math.abs(sum('top20') - 20) < 1e-6, 'dead-heat top 20 shares sum to 20');
  assert.ok(sum('makeCut') >= 65 && sum('makeCut') < 80, `made cut ${sum('makeCut')}`);
  for (const r of sim.results) {
    assert.ok(r.top5 <= r.top10 + 1e-9 && r.top10 <= r.top20 + 1e-9 && r.top20 <= r.makeCut + 1e-9);
    const d = r.finishDist.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(d - 1) < 1e-9, 'finish distribution sums to 1');
  }
  const first = sim.results[0], last = sim.results[sim.results.length - 1];
  assert.ok(first.win > 0.03 && first.win > 10 * last.win);
});

test('simulator: no-cut events keep the whole field', () => {
  const sim = simulate({ players: fieldOf(72), cut: { round: null, top: null }, sims: 2000, seed: 5 });
  for (const r of sim.results) assert.ok(Math.abs(r.makeCut - 1) < 1e-9);
});

test('simulator: completed rounds are respected', () => {
  const players = fieldOf(100, 1);
  // The worst-rated player has shot three 62s; everyone else three 72s.
  players.forEach((p, i) => {
    const s = i === 99 ? 62 : 72;
    p.rounds = [1, 2, 3].map(r => ({ round: r, strokes: s, complete: true, thruHoles: 18, holes: [] }));
  });
  const sim = simulate({ players, cut: { round: 2, top: 65 }, sims: 3000, seed: 9 });
  assert.ok(sim.results[99].win > 0.98, `leader by 30 should win: ${sim.results[99].win}`);
});

test('priceGroup matches brute force and settles dead heats', () => {
  const players = fieldOf(30);
  const sim = simulate({ players, cut: null, sims: 3000, seed: 11 });
  const ids = ['f0', 'f10', 'f20'];
  const priced = priceGroup(sim, 1, ids);
  assert.ok(Math.abs(priced.reduce((s, p) => s + p.deadHeat, 0) - 1) < 1e-9);
  // Brute force directly from the stored draws.
  const S = sim.sims, rs = sim.roundScores[0];
  const ix = ids.map(id => sim.index.get(id));
  const share = [0, 0, 0];
  for (let s = 0; s < S; s++) {
    const v = ix.map(i => rs[s + i * S]);
    const lo = Math.min(...v), n = v.filter(x => x === lo).length;
    v.forEach((x, j) => { if (x === lo) share[j] += 1 / n; });
  }
  share.forEach((v, j) => assert.ok(Math.abs(v / S - priced[j].deadHeat) < 1e-12));
  assert.ok(priced[0].deadHeat > priced[2].deadHeat);
  const two = priceGroup(sim, 1, ['f0', 'f20']);
  assert.ok(Math.abs(two[0].noPush + two[1].noPush - 1) < 1e-9, '2-ball no-push probabilities sum to 1');
  assert.ok(two[0].tie > 0.05 && two[0].tie < 0.2, `2-ball tie rate ${two[0].tie}`);
});

test('wave costs move the right players', () => {
  const players = fieldOf(120, 0.0001); // equal skill
  const byPlayer = new Map(players.map((p, i) => [p.id, { hour: i < 60 ? 8 : 13.5, wave: i < 60 ? 'AM' : 'PM' }]));
  const sheets = { 1: { byPlayer }, 2: { byPlayer: new Map([...byPlayer].map(([id, t]) => [id, { hour: t.wave === 'AM' ? 13.5 : 8, wave: t.wave === 'AM' ? 'PM' : 'AM' }])) } };
  // Afternoon of day 1 costs 2 strokes, day 2 is calm: R1 AM players get the edge.
  const wx = { members: 1, cost: (m, date, h) => (date === 'd1' && h > 11 ? 2 : 0) };
  const sim = simulate({ players, cut: { round: 2, top: 65 }, sheets, roundDates: ['d1', 'd2', 'd3', 'd4'], wx, sims: 3000, seed: 2 });
  const am = sim.results.slice(0, 60).reduce((s, r) => s + r.makeCut, 0) / 60;
  const pm = sim.results.slice(60).reduce((s, r) => s + r.makeCut, 0) / 60;
  assert.ok(am > pm + 0.1, `AM/PM make-cut ${am.toFixed(2)} vs PM/AM ${pm.toFixed(2)}`);
});

test('cut rules', () => {
  assert.strictEqual(cutRule({ name: 'Masters Tournament', players: new Array(90) }).top, 50);
  assert.strictEqual(cutRule({ name: 'Some Signature Event', players: new Array(72) }).top, null);
  assert.strictEqual(cutRule({ name: 'Shriners Children’s Open', players: new Array(144) }).top, 65);
  assert.strictEqual(cutRule({ name: 'X', players: new Array(144), cut: { count: 70, round: 2 } }).source, 'espn');
  // After the cut ESPN reports how many made it (73), not the rule (65 & ties).
  const players = cutRule({ name: 'THE PLAYERS Championship', state: 'post', players: new Array(123), cut: { count: 73, round: 2 } });
  assert.deepStrictEqual([players.top, players.source], [65, 'default rule']);
  assert.strictEqual(cutRule({ name: 'X', state: 'in', currentRound: 3, players: new Array(144), cut: { count: 70, round: 2 } }).source, 'default rule');
});
