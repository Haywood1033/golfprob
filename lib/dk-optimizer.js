// lib/dk-optimizer.js — exact DraftKings PGA Classic lineup optimizer: 6 golfers, $50,000 cap,
// no positions. Runs in the browser (window.DKOpt) and in node tests (module.exports).
//
// bestN is nflprob's 0/1 knapsack (exactly-N items, maximize points, weight = salary in $100
// units), kept as the FULL per-item-prefix table so reconstruction walks back by item index —
// the collapsed take[k][w] pointer version silently duplicated players in nflprob.
//
// Multiple lineups are built one at a time, each the exact best lineup that satisfies the rules
// against the lineups already chosen (exposure cap, minimum players different). Each is found by
// best-first branch and bound: solve without the uniqueness rule; if the answer overlaps an
// earlier lineup too much, branch on excluding each shared player (any valid lineup must drop
// at least one of them), and the first valid answer popped is optimal. Before every solve, any
// golfer whom six cheaper-or-equal golfers all out-project is dropped: a lineup holding them can
// always swap one in, so it never changes the optimum but shrinks the knapsack a lot.
(function (root) {
  'use strict';
  const CAP = 50000, UNIT = 100, ROSTER = 6;

  // One flat buffer reused across solves: dp[(p * (n+1) + k) * Wd + w]. Multi-lineup builds run
  // thousands of solves, and allocating fresh tables each time dominated the run time.
  let buf = new Float64Array(0);
  function bestN(players, budgetUnits, n) {
    if (n === 0) return { points: 0, salary: 0, players: [] };
    if (budgetUnits < 0 || players.length < n) return null;
    const NEG = -Infinity, P = players.length, Wd = budgetUnits + 1, K = n + 1;
    const size = (P + 1) * K * Wd;
    if (buf.length < size) buf = new Float64Array(size);
    const dp = buf;
    dp.fill(NEG, 0, K * Wd);
    dp.fill(0, 0, Wd); // p = 0, k = 0
    const wts = players.map(x => Math.round(x.salary / UNIT));
    for (let p = 1; p <= P; p++) {
      const w = wts[p - 1], v = players[p - 1].points;
      const prevBase = (p - 1) * K * Wd, curBase = p * K * Wd;
      for (let k = 0; k <= n; k++) {
        const pk = prevBase + k * Wd, pk1 = prevBase + (k - 1) * Wd, ck = curBase + k * Wd;
        for (let wt = 0; wt < Wd; wt++) {
          let best = dp[pk + wt];
          if (k && wt >= w) { const b = dp[pk1 + wt - w]; if (b !== NEG && b + v > best) best = b + v; }
          dp[ck + wt] = best;
        }
      }
    }
    const last = P * K * Wd + n * Wd;
    let bestW = -1;
    for (let wt = 0; wt < Wd; wt++) if (dp[last + wt] > NEG && (bestW < 0 || dp[last + wt] > dp[last + bestW] + 1e-9)) bestW = wt;
    if (bestW < 0) return null;
    const chosen = [];
    let k = n, wt = bestW;
    for (let p = P; p >= 1 && k > 0; p--) {
      // Item p-1 wasn't needed if the prefix without it already reaches this value.
      if (dp[(p * K + k) * Wd + wt] === dp[((p - 1) * K + k) * Wd + wt]) continue;
      chosen.push(players[p - 1]);
      wt -= wts[p - 1]; k--;
    }
    const salary = chosen.reduce((s, x) => s + x.salary, 0);
    return { points: dp[last + bestW], salary, players: chosen };
  }

  // Drop golfers dominated by 6 others (salary <= theirs and points >= theirs): exact pruning.
  function prune(players, keep) {
    const sorted = [...players].sort((a, b) => a.salary - b.salary || b.points - a.points);
    return sorted.filter(p => {
      if (keep.has(p.id)) return true;
      let n = 0;
      for (const q of sorted) {
        if (q.salary > p.salary) break;
        if (q !== p && q.points >= p.points) { n++; if (n >= ROSTER) return false; }
      }
      return true;
    });
  }

  // Best lineup with some players forced in and some forced out (by id).
  function solve(pool, forcedIn, forcedOut, cap) {
    const ins = pool.filter(p => forcedIn.has(p.id));
    if (ins.length > ROSTER) return null;
    const used = ins.reduce((s, p) => s + p.salary, 0);
    if (used > cap) return null;
    const rest = prune(pool.filter(p => !forcedIn.has(p.id) && !forcedOut.has(p.id)), new Set());
    const r = bestN(rest, Math.floor((cap - used) / UNIT), ROSTER - ins.length);
    if (!r) return null;
    const players = [...ins, ...r.players].sort((a, b) => b.salary - a.salary);
    return { players, points: players.reduce((s, p) => s + p.points, 0), salary: used + r.salary };
  }

  // pool: [{id, name, salary, points}] · opts: {count, locks, excludes, maxExposure (0..1),
  // minUnique (players that must differ from every earlier lineup), cap, maxNodes per lineup,
  // timeLimitMs, onProgress(built, count)}
  function buildLineups(pool, opts = {}) {
    const count = opts.count || 1, cap = opts.cap || CAP;
    const locks = new Set(opts.locks || []), excludes = new Set(opts.excludes || []);
    const maxUse = opts.maxExposure ? Math.max(1, Math.floor(opts.maxExposure * count + 1e-9)) : Infinity;
    const maxShared = ROSTER - Math.max(1, opts.minUnique || 1);
    const maxNodes = opts.maxNodes || 600;
    const usable = pool.filter(p => p.salary > 0 && isFinite(p.points));
    const lineups = [], usage = new Map();
    let examined = 0, reason = null;
    const deadline = opts.timeLimitMs ? Date.now() + opts.timeLimitMs : Infinity;

    for (let n = 0; n < count; n++) {
      if (Date.now() > deadline) { reason = `Built ${n} of ${count} before the time limit — fewer lineups or looser rules will finish.`; break; }
      const capped = usable.filter(p => !locks.has(p.id) && (usage.get(p.id) || 0) >= maxUse).map(p => p.id);
      const baseOut = new Set([...excludes, ...capped]);
      const heap = [];
      const push = node => {
        let lo = 0, hi = heap.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (heap[mid].sol.points >= node.sol.points) lo = mid + 1; else hi = mid; }
        heap.splice(lo, 0, node);
      };
      const seen = new Set();
      const first = solve(usable, locks, baseOut, cap);
      if (first) push({ sol: first, outs: baseOut });
      let found = null, nodes = 0;
      while (heap.length && nodes < maxNodes) {
        const node = heap.shift();
        nodes++;
        const ids = new Set(node.sol.players.map(p => p.id));
        const clash = lineups.find(l => l.players.filter(p => ids.has(p.id)).length > maxShared);
        if (!clash) { found = node.sol; break; }
        for (const p of clash.players) {
          if (!ids.has(p.id) || locks.has(p.id)) continue;
          const outs = new Set(node.outs); outs.add(p.id);
          const key = [...outs].sort().join('|');
          if (seen.has(key)) continue;
          seen.add(key);
          const sol = solve(usable, locks, outs, cap);
          if (sol) push({ sol, outs });
        }
      }
      examined += nodes;
      if (!found) {
        reason = n === 0 ? 'No lineup fits the cap with these locks/excludes.'
          : nodes >= maxNodes ? `Built ${n} of ${count}: the next lineup needed more search than allowed — loosen the exposure cap or uniqueness rule.`
          : `Only ${n} lineups satisfy these rules (exposure cap ${opts.maxExposure ? Math.round(opts.maxExposure * 100) + '%' : 'none'}, ${ROSTER - maxShared} unique per lineup).`;
        break;
      }
      lineups.push(found);
      for (const p of found.players) usage.set(p.id, (usage.get(p.id) || 0) + 1);
      if (opts.onProgress) opts.onProgress(n + 1, count);
    }
    return { lineups, examined, reason };
  }

  const api = { bestN, solve, prune, buildLineups, CAP, ROSTER };
  // Inside a Web Worker: build on request and stream progress back to the page.
  if (typeof WorkerGlobalScope !== 'undefined' && root instanceof WorkerGlobalScope) {
    root.onmessage = e => {
      const { pool, opts } = e.data;
      const out = buildLineups(pool, { ...opts, onProgress: (built, count) => root.postMessage({ type: 'progress', built, count }) });
      root.postMessage({ type: 'done', ...out });
    };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DKOpt = api;
})(typeof self !== 'undefined' ? self : this);
