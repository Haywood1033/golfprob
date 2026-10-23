// lib/simulator.js — Monte Carlo tournament simulator. Every market comes out of the same draws
// (finishing position, top-N, make cut, 2-balls, 3-balls), so the numbers can't contradict
// each other.
//
// A simulated round for player i:
//   strokes = par + courseOffset - SG_i + week_i + wave_i,r + shock_r,wave + e * sigma_i
//   week_i   one draw per tournament: "had it this week" form, plus uncertainty in SG_i itself
//            (thin-history players get more of it, so they are genuinely more volatile)
//   wave     weather cost of this player's tee window vs the field average (lib/weather.js);
//            each sim draws one forecast ensemble member, so forecast uncertainty propagates
//   shock    shared by everyone in the same wave that round — conditions nobody forecast
// Rounds are rounded to whole strokes, so ties (cut line, dead heats, pushes) occur naturally.
// Completed rounds use the actual score; a round in progress uses the strokes so far plus a
// projection of only the remaining holes.

const { makeRng } = require('./rng');

const WEEK_SD = 0.3;
const SHOCK_SD = 0.35;
const NOT_PLAYED = -1;

function simulate({ players, par = 72, courseOffset = 0.3, numberOfRounds = 4, cut = null, sheets = {}, roundDates = [], wx = null, sims = 15000, seed = 1 }) {
  const rng = makeRng(seed);
  const field = players.filter(p => p.status !== 'WD' && p.status !== 'DQ');
  const P = field.length;
  const R = numberOfRounds;

  // Per-player, per-round state known before simulating.
  const known = field.map(p => {
    const byRound = new Map(p.rounds.map(r => [r.round, r]));
    return Array.from({ length: R }, (_, r) => byRound.get(r + 1) || null);
  });
  const alreadyCut = field.map(p => p.status === 'CUT' || p.status === 'MDF');
  const cutDecided = alreadyCut.some(Boolean);

  // Per-hole field scoring average for rounds in progress — remaining holes are projected at
  // what the field is actually averaging on them today, not a flat per-hole par.
  const holeAvg = Array.from({ length: R }, (_, r) => {
    const sum = new Array(19).fill(0), n = new Array(19).fill(0);
    for (let i = 0; i < P; i++) for (const h of known[i][r]?.holes || []) { sum[h.hole] += h.strokes; n[h.hole]++; }
    return sum.map((s, h) => (n[h] >= 10 ? s / n[h] : null));
  });

  // Course offset: blend history with this week's completed rounds (field-skill corrected).
  let offset = courseOffset;
  const weekOffsets = [];
  for (let r = 0; r < R; r++) {
    let s = 0, n = 0;
    for (let i = 0; i < P; i++) {
      const k = known[i][r];
      if (k?.complete && k.strokes) { s += k.strokes - par + field[i].rating.sg; n++; }
    }
    if (n >= 30) weekOffsets.push(s / n);
  }
  if (weekOffsets.length) offset = weekOffsets.reduce((a, b) => a + b, 0) / weekOffsets.length;

  const sg = field.map(p => p.rating.sg);
  const weekSd = field.map(p => Math.sqrt(WEEK_SD ** 2 + (p.rating.se || 0) ** 2));
  const roundSd = field.map(p => Math.sqrt(Math.max(1.6, (p.rating.sd || 2.8) ** 2 - WEEK_SD ** 2)));

  const members = wx?.members || 1;
  // Precompute wave costs for rounds whose tee sheet is known: [member][round][player].
  const sheetCost = Array.from({ length: members }, (_, m) => Array.from({ length: R }, (_, r) => {
    const sheet = sheets[r + 1];
    if (!sheet || !wx) return null;
    const costs = new Float64Array(P);
    let mean = 0, n = 0;
    for (let i = 0; i < P; i++) {
      const t = sheet.byPlayer.get(field[i].id);
      if (!t) continue;
      costs[i] = wx.cost(m, roundDates[r], t.hour);
      mean += costs[i]; n++;
    }
    if (n) for (let i = 0; i < P; i++) costs[i] = sheet.byPlayer.get(field[i].id) ? costs[i] - mean / n : 0;
    return costs;
  }));
  const waveOf = Array.from({ length: R }, (_, r) => field.map(p => sheets[r + 1]?.byPlayer.get(p.id)?.wave || null));

  // Output accumulators.
  const win = new Float64Array(P), top5 = new Float64Array(P), top10 = new Float64Array(P), top20 = new Float64Array(P);
  const top5Raw = new Float64Array(P), top10Raw = new Float64Array(P), top20Raw = new Float64Array(P);
  const made = new Float64Array(P), finishSum = new Float64Array(P), finishN = new Float64Array(P);
  const BUCKETS = [1, 5, 10, 20, 30, 40, 50, 65, Infinity];
  const hist = field.map(() => new Float64Array(BUCKETS.length + 1)); // last slot = missed cut
  const roundScores = Array.from({ length: R }, () => new Int16Array(P * sims));

  const total = new Float64Array(P);
  const alive = new Uint8Array(P);
  const week = new Float64Array(P);
  const idx = Array.from({ length: P }, (_, i) => i);

  for (let s = 0; s < sims; s++) {
    const m = members > 1 ? Math.floor(rng.uniform() * members) : 0;
    for (let i = 0; i < P; i++) { total[i] = 0; alive[i] = alreadyCut[i] ? 0 : 1; week[i] = rng.normal() * weekSd[i]; }

    for (let r = 0; r < R; r++) {
      const shockAM = rng.normal() * SHOCK_SD, shockPM = rng.normal() * SHOCK_SD;
      const costs = sheetCost[m][r];
      // Weekend rounds without a posted tee sheet: tee order follows the leaderboard (leaders
      // last), so weather in the afternoon lands on the leaders — computed per sim.
      let weekendHour = null;
      if (!costs && wx && r >= 2 && roundDates[r]) {
        const order = idx.filter(i => alive[i]).sort((a, b) => total[b] - total[a]);
        weekendHour = new Float64Array(P);
        const n = order.length;
        order.forEach((i, k) => { weekendHour[i] = 7.5 + (n > 1 ? (k / (n - 1)) * 6 : 0); });
      }
      let wkMean = 0, wkN = 0;
      const wkCost = weekendHour ? new Float64Array(P) : null;
      if (wkCost) {
        for (let i = 0; i < P; i++) if (alive[i]) { wkCost[i] = wx.cost(m, roundDates[r], weekendHour[i]); wkMean += wkCost[i]; wkN++; }
        wkMean = wkN ? wkMean / wkN : 0;
      }

      for (let i = 0; i < P; i++) {
        const cell = s + i * sims;
        const k = known[i][r];
        // Already-cut players keep their real R1/R2 scores so those rounds' matchups still price.
        if (!alive[i]) { roundScores[r][cell] = k?.complete && k.strokes ? k.strokes : NOT_PLAYED; continue; }
        let score;
        if (k?.complete && k.strokes) {
          score = k.strokes;
        } else if (k && k.thruHoles > 0 && k.partialStrokes) {
          const played = new Set(k.playedHoles || k.holes.map(h => h.hole));
          let remBase = 0, rem = 0, fromAvg = true;
          for (let h = 1; h <= 18; h++) if (!played.has(h)) { rem++; if (holeAvg[r][h] === null) fromAvg = false; remBase += holeAvg[r][h] ?? 0; }
          // No hole-by-hole data: remaining holes at their par plus the course offset.
          if (!fromAvg) remBase = (k.remainingPar ?? (par * rem) / 18) + (offset * rem) / 18;
          const f = rem / 18;
          score = Math.round(k.partialStrokes + remBase + (-sg[i] + week[i]) * f + rng.normal() * roundSd[i] * Math.sqrt(f));
        } else {
          const wave = waveOf[r][i];
          const shock = wave === 'PM' ? shockPM : wave === 'AM' ? shockAM : (shockAM + shockPM) / 2;
          const wcost = costs ? costs[i] : wkCost ? wkCost[i] - wkMean : 0;
          score = Math.round(par + offset - sg[i] + week[i] + wcost + shock + rng.normal() * roundSd[i]);
        }
        roundScores[r][cell] = score;
        total[i] += score;
      }

      // The cut, after the cut round, unless this week's cut already happened for real.
      if (cut?.top && r + 1 === cut.round && !cutDecided) {
        const live = idx.filter(i => alive[i]).map(i => total[i]).sort((a, b) => a - b);
        if (live.length > cut.top) {
          const line = live[cut.top - 1];
          for (let i = 0; i < P; i++) if (alive[i] && total[i] > line) alive[i] = 0;
        }
      }
    }

    // Finishing positions among players who played all rounds; ties share the position.
    const finishers = idx.filter(i => alive[i]).sort((a, b) => total[a] - total[b]);
    const best = finishers.length ? total[finishers[0]] : 0;
    const leaders = finishers.filter(i => total[i] === best);
    const winner = leaders[Math.floor(rng.uniform() * leaders.length)]; // playoff
    let k = 0;
    while (k < finishers.length) {
      let j = k;
      while (j + 1 < finishers.length && total[finishers[j + 1]] === total[finishers[k]]) j++;
      const pos = k + 1, tied = j - k + 1;
      for (let q = k; q <= j; q++) {
        const i = finishers[q];
        const p = i === winner ? 1 : (pos === 1 ? 2 : pos);
        finishSum[i] += p; finishN[i]++; made[i]++;
        // Dead heat: a tie straddling the cutoff is paid the share of spots left over.
        const dh = n => (pos > n ? 0 : pos + tied - 1 <= n ? 1 : (n - pos + 1) / tied);
        top5[i] += dh(5); top10[i] += dh(10); top20[i] += dh(20);
        if (pos <= 5) top5Raw[i]++;
        if (pos <= 10) top10Raw[i]++;
        if (pos <= 20) top20Raw[i]++;
        let b = 0;
        while (p > BUCKETS[b]) b++;
        hist[i][b]++;
      }
      k = j + 1;
    }
    if (winner !== undefined) win[winner]++;
    for (let i = 0; i < P; i++) if (!alive[i]) hist[i][BUCKETS.length]++;
  }

  const results = field.map((p, i) => ({
    id: p.id,
    win: win[i] / sims,
    top5: top5[i] / sims, top10: top10[i] / sims, top20: top20[i] / sims,
    top5Any: top5Raw[i] / sims, top10Any: top10Raw[i] / sims, top20Any: top20Raw[i] / sims,
    makeCut: made[i] / sims,
    avgFinish: finishN[i] ? finishSum[i] / finishN[i] : null,
    finishDist: Array.from(hist[i], v => v / sims),
  }));
  return {
    results, sims, offset, members,
    bucketLabels: ['Win', '2–5', '6–10', '11–20', '21–30', '31–40', '41–50', '51–65', '66+', 'MC'],
    index: new Map(field.map((p, i) => [p.id, i])),
    roundScores,
  };
}

// Price a playing group in one round from the stored draws. n-ball "win" uses dead-heat
// settlement (shared low score splits the stake); 2-balls also report the tie (push) rate.
function priceGroup(sim, round, ids) {
  const rs = sim.roundScores[round - 1];
  const S = sim.sims;
  const ix = ids.map(id => sim.index.get(id));
  if (ix.some(i => i === undefined)) return null;
  const share = new Float64Array(ix.length), outright = new Float64Array(ix.length);
  let ties = 0, played = 0;
  for (let s = 0; s < S; s++) {
    let lo = Infinity, nLo = 0, ok = true;
    for (const i of ix) {
      const v = rs[s + i * S];
      if (v === NOT_PLAYED) { ok = false; break; }
      if (v < lo) { lo = v; nLo = 1; } else if (v === lo) nLo++;
    }
    if (!ok) continue;
    played++;
    if (nLo > 1) ties++;
    ix.forEach((i, j) => {
      if (rs[s + i * S] === lo) { share[j] += 1 / nLo; if (nLo === 1) outright[j]++; }
    });
  }
  if (!played) return null;
  return ids.map((id, j) => ({
    id,
    deadHeat: share[j] / played,                       // 3-ball settlement
    outright: outright[j] / played,                     // wins with no tie
    noPush: ties < played ? outright[j] / (played - ties) : 0, // 2-ball, tie = push
    tie: ties / played,
  }));
}

module.exports = { simulate, priceGroup };
