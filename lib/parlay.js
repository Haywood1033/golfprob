// lib/parlay.js — 2-ball / 3-ball parlays priced inside the tournament simulation. Each leg is
// evaluated in every simulated tournament, so the joint probability is counted directly rather
// than multiplied: legs in the same wave share that wave's conditions, and the same player in
// R1 and R2 shares a week of form. Settlement follows the books:
//   3-ball  a tie for low is a dead heat — the leg pays its odds on 1/n of the stake
//   2-ball  a tie is a push — the leg drops out of the parlay (factor 1)

const MAX_LEGS = 6;

// Every playing group by round, from the tournament payload's matchups.
function groupIndex(payload) {
  const idx = new Map();
  for (const m of payload.matchups || []) {
    for (const g of m.groups) {
      const ids = g.players.map(p => p.id);
      for (const id of ids) idx.set(`${m.round}|${id}`, { round: m.round, ids, size: ids.length, local: g.local, startHole: g.startHole, wave: g.wave, inferred: m.inferred });
    }
  }
  return idx;
}

// Per-sim settlement of one leg: `hit` (share won, push counts as not losing) and `pay` (the
// leg's payout multiplier at decimal odds `dec`).
function legSeries(sim, leg, group) {
  const S = sim.sims, rs = sim.roundScores[leg.round - 1];
  const me = sim.index.get(leg.id);
  const ix = group.ids.map(id => sim.index.get(id));
  const hit = new Float32Array(S), pay = new Float32Array(S);
  const dec = leg.dec || null;
  for (let s = 0; s < S; s++) {
    let lo = Infinity, nLo = 0, ok = true;
    for (const i of ix) {
      const v = rs[s + i * S];
      if (v < 0) { ok = false; break; }
      if (v < lo) { lo = v; nLo = 1; } else if (v === lo) nLo++;
    }
    if (!ok) { hit[s] = 1; pay[s] = 1; continue; } // a player didn't tee it up: leg void
    const mine = rs[s + me * S];
    if (mine !== lo) continue; // lost
    if (group.size === 2 && nLo > 1) { hit[s] = 1; pay[s] = 1; continue; } // push
    hit[s] = 1 / nLo;
    pay[s] = dec ? dec / nLo : 0;
  }
  return { hit, pay };
}

function validate(legs, idx) {
  if (!legs.length) return 'Add at least one leg.';
  if (legs.length > MAX_LEGS) return `At most ${MAX_LEGS} legs.`;
  const seen = new Set();
  for (const l of legs) {
    const g = idx.get(`${l.round}|${l.id}`);
    if (!g) return `No R${l.round} group found for one of the legs.`;
    const key = `${l.round}|${g.ids.slice().sort().join()}`;
    if (seen.has(key)) return 'Two legs from the same group and round can’t both win — keep one.';
    seen.add(key);
  }
  return null;
}

function priceParlay(sim, legs, idx) {
  const err = validate(legs, idx);
  if (err) return { error: err };
  const S = sim.sims;
  const series = legs.map(l => legSeries(sim, l, idx.get(`${l.round}|${l.id}`)));
  const allDec = legs.every(l => l.dec);
  let joint = 0, payout = 0;
  for (let s = 0; s < S; s++) {
    let h = 1, p = 1;
    for (const x of series) { h *= x.hit[s]; if (!h) break; p *= x.pay[s]; }
    joint += h; payout += h ? p : 0;
  }
  joint /= S; payout /= S;
  const marginals = series.map(x => x.hit.reduce((a, b) => a + b, 0) / S);
  const independent = marginals.reduce((a, b) => a * b, 1);
  return {
    legs: legs.map((l, i) => ({ ...l, group: idx.get(`${l.round}|${l.id}`), prob: marginals[i] })),
    joint, independent, lift: independent ? joint / independent : null,
    fairDecimal: joint ? 1 / joint : null,
    bookDecimal: allDec ? legs.reduce((a, l) => a * l.dec, 1) : null,
    ev: allDec ? payout - 1 : null,
  };
}

function* combos(arr, k, start = 0, acc = []) {
  if (acc.length === k) { yield acc; return; }
  for (let i = start; i < arr.length; i++) yield* combos(arr, k, i + 1, [...acc, arr[i]]);
}

// Best parlays of `size` legs from a candidate list. With book odds the ranking is EV; without,
// it's the most likely parlays (model favorites), and the response says which.
function autoParlays(sim, idx, candidates, { size = 3, count = 5, pool = 14 } = {}) {
  const priced = candidates
    .filter(c => idx.has(`${c.round}|${c.id}`))
    .map(c => {
      const g = idx.get(`${c.round}|${c.id}`);
      const s = legSeries(sim, c, g);
      const prob = s.hit.reduce((a, b) => a + b, 0) / sim.sims;
      const ev = c.dec ? s.pay.reduce((a, b) => a + b, 0) / sim.sims - 1 : null;
      return { ...c, prob, ev, groupKey: `${c.round}|${g.ids.slice().sort().join()}` };
    });
  const byBook = priced.some(c => c.dec);
  // One leg per group (its best), then the top of the list.
  const bestPerGroup = new Map();
  for (const c of priced) {
    const score = byBook ? (c.ev ?? -Infinity) : c.prob;
    const cur = bestPerGroup.get(c.groupKey);
    if (!cur || score > cur.score) bestPerGroup.set(c.groupKey, { ...c, score });
  }
  const top = [...bestPerGroup.values()].sort((a, b) => b.score - a.score).slice(0, pool);
  const n = Math.min(size, top.length);
  if (n < 2) return { byBook, parlays: [], note: `Only ${top.length} eligible leg${top.length === 1 ? '' : 's'} — a parlay needs at least 2 from different groups.` };
  const results = [];
  for (const c of combos(top, n)) {
    const r = priceParlay(sim, c.map(({ round, id, dec, name }) => ({ round, id, dec, name })), idx);
    if (!r.error) results.push(r);
  }
  results.sort((a, b) => (byBook ? (b.ev ?? -Infinity) - (a.ev ?? -Infinity) : b.joint - a.joint));
  return {
    byBook,
    parlays: results.slice(0, count),
    note: n < size ? `Only ${top.length} groups have eligible legs, so these are ${n}-leg parlays.` : null,
  };
}

module.exports = { groupIndex, priceParlay, autoParlays, MAX_LEGS };
