// lib/dk.js — DraftKings PGA Classic fantasy points from the tournament simulation.
//
// Scoring (DK PGA Classic):
//   per hole   double eagle+ 13 · eagle 8 · birdie 3 · par 0.5 · bogey −0.5 · double bogey+ −1
//   bonuses    hole in one +5 · 3+ birdies-or-better in a row +3 (once per round)
//              bogey-free round +3 · all four rounds under 70 strokes +5
//   finish     1st 30 · 2nd 20 · 3rd 18 · 4th 16 · 5th 14 · 6th 12 · 7th 10 · 8th 9 · 9th 8
//              10th 7 · 11–15 6 · 16–20 5 · 21–25 4 · 26–30 3 · 31–40 2 · 41–50 1
//              (ties are scored at the tied position)
//
// The simulator draws whole-round scores; hole-level points come from a per-hole model rather
// than simulated holes. Tour-average outcome rates for par 3s, 4s and 5s are exponentially
// tilted until the 18 holes' expected total equals the simulated round score, then expected hole
// points and bonus probabilities are read off exactly (the birdie streak by dynamic programming
// over the hole sequence). One table per course, indexed by round score vs par, so a sim costs a
// lookup per round. Finish points and the under-70 bonus come straight from the same sims, so a
// player's DK projection is consistent with their finishing odds.

// Outcome offsets vs par and their DK points. Index: -3, -2, -1, 0, +1, +2(+)
const OFFSETS = [-3, -2, -1, 0, 1, 2.2]; // "+2" bucket averages slightly over 2 (triples happen)
const POINTS = [13, 8, 3, 0.5, -0.5, -1];
const BASE = {
  3: [0, 0.002, 0.13, 0.68, 0.17, 0.018],   // the "eagle" on a par 3 is an ace
  4: [0, 0.003, 0.17, 0.62, 0.18, 0.027],
  5: [0.0005, 0.04, 0.42, 0.46, 0.07, 0.0095],
};
const FINISH = [0, 30, 20, 18, 16, 14, 12, 10, 9, 8, 7];
function finishPoints(pos) {
  if (!pos) return 0;
  if (pos <= 10) return FINISH[pos];
  if (pos <= 15) return 6;
  if (pos <= 20) return 5;
  if (pos <= 25) return 4;
  if (pos <= 30) return 3;
  if (pos <= 40) return 2;
  if (pos <= 50) return 1;
  return 0;
}

// Course layout: ESPN hole pars when present, else a standard mix for the course par.
function holeLayout(course = {}) {
  const holes = (course.holes || []).filter(h => h.par >= 3 && h.par <= 5).sort((a, b) => a.hole - b.hole);
  if (holes.length === 18) return holes.map(h => h.par);
  const par = course.par || 72;
  const fives = Math.max(0, Math.min(6, par - 68));
  // Spread them the way real cards are: par 3s and 5s in both nines.
  const out = new Array(18).fill(4);
  [2, 6, 11, 15].forEach(h => { out[h] = 3; });
  [1, 12, 8, 17, 4, 13].slice(0, fives).forEach(h => { out[h] = 5; });
  return out;
}

function tilt(base, theta) {
  const w = base.map((p, k) => p * Math.exp(theta * OFFSETS[k]));
  const z = w.reduce((a, b) => a + b, 0);
  return w.map(v => v / z);
}
const mean = dist => dist.reduce((s, p, k) => s + p * OFFSETS[k], 0);

// Expected DK points (holes + per-round bonuses) for every round score from −16 to +24 vs par.
function roundTable(layout) {
  const table = new Map();
  for (let x = -16; x <= 24; x++) {
    // Find theta so the expected total over the layout equals x (bisection; monotone in theta).
    let lo = -8, hi = 8;
    for (let it = 0; it < 60; it++) {
      const mid = (lo + hi) / 2;
      const total = layout.reduce((s, par) => s + mean(tilt(BASE[par], mid)), 0);
      if (total > x) hi = mid; else lo = mid;
    }
    const theta = (lo + hi) / 2;
    const dists = layout.map(par => tilt(BASE[par], theta));
    let pts = 0, pClean = 1;
    dists.forEach((d, h) => {
      pts += d.reduce((s, p, k) => s + p * POINTS[k], 0);
      if (layout[h] === 3) pts += 5 * d[1]; // hole in one
      pClean *= 1 - d[4] - d[5];
    });
    // P(at least one run of 3+ birdie-or-better holes): DP over current run length 0/1/2.
    let st = [1, 0, 0], hit = 0;
    for (const d of dists) {
      const q = d[0] + d[1] + d[2];
      const next = [(st[0] + st[1] + st[2]) * (1 - q), st[0] * q, st[1] * q];
      hit += st[2] * q;
      st = next;
    }
    table.set(x, pts + 3 * pClean + 3 * hit);
  }
  return table;
}

function quantile(sorted, q) {
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

// DK projections for every simulated player: mean and distribution quantiles.
function dkProjections(sim, { par = 72, course = {} } = {}) {
  const table = roundTable(holeLayout(course));
  const lookup = x => table.get(Math.max(-16, Math.min(24, x)));
  const S = sim.sims, R = sim.numberOfRounds;
  const out = new Map();
  for (const [id, i] of sim.index) {
    const pts = new Float32Array(S);
    for (let s = 0; s < S; s++) {
      let t = 0, under70 = R === 4, played = 0;
      for (let r = 0; r < R; r++) {
        const v = sim.roundScores[r][s + i * S];
        if (v < 0) { under70 = false; continue; }
        played++;
        t += lookup(v - par);
        if (v >= 70) under70 = false;
      }
      if (under70 && played === 4) t += 5;
      t += finishPoints(sim.finishPos[s + i * S]);
      pts[s] = t;
    }
    let sum = 0;
    for (let s = 0; s < S; s++) sum += pts[s];
    pts.sort();
    out.set(id, {
      mean: sum / S,
      p10: quantile(pts, 0.1), p25: quantile(pts, 0.25), p50: quantile(pts, 0.5),
      p75: quantile(pts, 0.75), p90: quantile(pts, 0.9), p95: quantile(pts, 0.95),
    });
  }
  return out;
}

module.exports = { dkProjections, roundTable, holeLayout, finishPoints };
