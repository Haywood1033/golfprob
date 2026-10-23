// DK scoring + optimizer: brute-force verification of every "optimal" claim on small pools.
const test = require('node:test');
const assert = require('node:assert');
const { bestN, buildLineups } = require('../lib/dk-optimizer');
const { roundTable, holeLayout, finishPoints, dkProjections } = require('../lib/dk');
const { makeRng } = require('../lib/rng');
const { simulate } = require('../lib/simulator');

function randomPool(rng, n) {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, salary: 6000 + Math.round(rng.uniform() * 60) * 100, points: 40 + rng.uniform() * 50 }));
}
function* combos(arr, k, start = 0, acc = []) {
  if (acc.length === k) { yield acc; return; }
  for (let i = start; i < arr.length; i++) yield* combos(arr, k, i + 1, [...acc, arr[i]]);
}
function bruteAll(pool, cap = 50000) {
  const out = [];
  for (const c of combos(pool, 6)) {
    const sal = c.reduce((s, p) => s + p.salary, 0);
    if (sal <= cap) out.push({ pts: c.reduce((s, p) => s + p.points, 0), ids: c.map(p => p.id).sort().join() });
  }
  return out.sort((a, b) => b.pts - a.pts);
}

test('bestN matches exhaustive search on 200 random pools', () => {
  const rng = makeRng(42);
  for (let t = 0; t < 200; t++) {
    const pool = randomPool(rng, 10 + (t % 6));
    const r = bestN(pool, 500, 6);
    const brute = bruteAll(pool);
    if (!brute.length) { assert.strictEqual(r, null); continue; }
    assert.ok(Math.abs(r.points - brute[0].pts) < 1e-6, `trial ${t}`);
    assert.strictEqual(new Set(r.players.map(p => p.id)).size, 6, 'no duplicate players');
    assert.ok(r.salary <= 50000);
  }
});

test('top-K lineups are exactly the K best distinct lineups', () => {
  const rng = makeRng(7);
  for (let t = 0; t < 40; t++) {
    const pool = randomPool(rng, 12);
    const brute = bruteAll(pool);
    const K = Math.min(15, brute.length);
    const { lineups } = buildLineups(pool, { count: K });
    assert.strictEqual(lineups.length, K);
    lineups.forEach((l, i) => assert.ok(Math.abs(l.points - brute[i].pts) < 1e-6, `trial ${t} rank ${i}`));
    assert.strictEqual(new Set(lineups.map(l => l.players.map(p => p.id).sort().join())).size, K, 'all distinct');
  }
});

test('locks, excludes, exposure cap and uniqueness are honored', () => {
  const pool = randomPool(makeRng(3), 30);
  const { lineups } = buildLineups(pool, { count: 10, locks: ['p5'], excludes: ['p0', 'p1'], maxExposure: 0.5, minUnique: 2 });
  assert.strictEqual(lineups.length, 10);
  for (const l of lineups) {
    const ids = l.players.map(p => p.id);
    assert.ok(ids.includes('p5'));
    assert.ok(!ids.includes('p0') && !ids.includes('p1'));
  }
  const use = new Map();
  lineups.forEach(l => l.players.forEach(p => use.set(p.id, (use.get(p.id) || 0) + 1)));
  for (const [id, n] of use) if (id !== 'p5') assert.ok(n <= 5, `${id} used ${n}`);
  for (let i = 0; i < lineups.length; i++) for (let j = 0; j < i; j++) {
    const a = new Set(lineups[i].players.map(p => p.id));
    assert.ok(lineups[j].players.filter(p => a.has(p.id)).length <= 4);
  }
});

test('dominance pruning never changes the optimum', () => {
  const { prune } = require('../lib/dk-optimizer');
  const rng = makeRng(77);
  for (let t = 0; t < 100; t++) {
    const pool = randomPool(rng, 14);
    const full = bestN(pool, 500, 6), pruned = bestN(prune(pool, new Set()), 500, 6);
    assert.strictEqual(full === null, pruned === null);
    if (full) assert.ok(Math.abs(full.points - pruned.points) < 1e-9);
  }
});

test('sequential lineups with uniqueness match brute force', () => {
  const rng = makeRng(5);
  for (let t = 0; t < 20; t++) {
    const pool = randomPool(rng, 12);
    const all = bruteAll(pool).map(x => ({ ...x, set: new Set(x.ids.split(',')) }));
    const { lineups } = buildLineups(pool, { count: 5, minUnique: 2 });
    // Brute-force the same greedy: each next = best lineup sharing <= 4 with every earlier one.
    const chosen = [];
    for (const cand of all) {
      if (chosen.length === 5) break;
      if (chosen.every(c => [...cand.set].filter(id => c.set.has(id)).length <= 4)) chosen.push(cand);
    }
    assert.strictEqual(lineups.length, chosen.length, `trial ${t}`);
    lineups.forEach((l, i) => assert.ok(Math.abs(l.points - chosen[i].pts) < 1e-6, `trial ${t} lineup ${i}`));
  }
});

test('honest shortfall when the rules can’t fill the count', () => {
  const pool = randomPool(makeRng(9), 7); // only 7 choose 6 = 7 lineups exist
  const r = buildLineups(pool, { count: 20, cap: 100000 });
  assert.strictEqual(r.lineups.length, 7);
  assert.match(r.reason, /Only 7 lineups/);
});

test('DK round table: realistic and monotone', () => {
  const t = roundTable(holeLayout({ par: 72 }));
  assert.ok(t.get(0) > 14 && t.get(0) < 19, `even par ${t.get(0)}`);
  assert.ok(t.get(-8) > 32 && t.get(-8) < 40, `64 = ${t.get(-8)}`);
  for (let x = -15; x <= 24; x++) assert.ok(t.get(x) < t.get(x - 1), `monotone at ${x}`);
  assert.deepStrictEqual([1, 2, 10, 11, 20, 21, 50, 51].map(finishPoints), [30, 20, 7, 6, 5, 4, 1, 0]);
  assert.strictEqual(holeLayout({ par: 71 }).reduce((a, b) => a + b), 71);
});

test('DK projections: stronger players project higher, cut players only score two rounds', () => {
  const players = Array.from({ length: 120 }, (_, i) => ({ id: `f${i}`, name: `F${i}`, status: 'ACTIVE', rounds: [], rating: { sg: 2 - (4 * i) / 119, sd: 2.8, se: 0.3 } }));
  const sim = simulate({ players, par: 72, courseOffset: 0.5, cut: { round: 2, top: 65 }, sims: 3000, seed: 4 });
  const dk = dkProjections(sim, { par: 72 });
  const best = dk.get('f0'), worst = dk.get('f119');
  assert.ok(best.mean > worst.mean + 20, `${best.mean} vs ${worst.mean}`);
  assert.ok(best.p90 > best.mean && best.mean > best.p10);
  assert.ok(best.mean > 60 && best.mean < 110, `top player ${best.mean}`);
  assert.ok(worst.p50 < 45, 'a likely missed cut scores two rounds of points');
});
