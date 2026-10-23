// lib/plays.js — the Best plays tab: top bet targets across matchups, finishing positions and
// finishing-position parlays, each with per-play reasons and a section summary that says what
// separates these plays from the rest of the slate. Every number comes from the tournament
// simulation already behind the other tabs.
//
// Two modes per section, stated in the response:
//   value  book prices were uploaded for that market: plays rank by expected profit per $1, and
//          only plays the model prices above the book (after removing the book's margin) qualify
//   model  no prices: plays rank by model strength (matchups: margin over the group's even share;
//          finishing: probability). Real value needs a price, and the UI says so.

const { priceGroup } = require('./simulator');
const { autoFinishParlays, FINISH_N } = require('./parlay');

const MARKETS = [
  { key: 'win', label: 'Win', n: 1 },
  { key: 'top5', label: 'Top 5', n: 5 },
  { key: 'top10', label: 'Top 10', n: 10 },
  { key: 'top20', label: 'Top 20', n: 20 },
  { key: 'makeCut', label: 'Make cut', n: null },
];
const PARLAY_MARKETS = ['top10', 'top20', 'makeCut'];
const MIN_EV = 0.03;

const pct = (p, d = 0) => `${(p * 100).toFixed(d)}%`;
const sgn = (v, d = 2) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}`;
const american = p => (p >= 0.5 ? `−${Math.round((100 * p) / (1 - p))}` : `+${Math.round((100 * (1 - p)) / p)}`);
const ordinal = n => `${n}${['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) ? 0 : Math.min(n % 10, 4) % 4] || 'th'}`;
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

// Field context: projected-skill rank, long-run-skill rank, and the "situational" rank that adds
// this week's draw on top of projected skill (course fit and form are already in projected SG).
function fieldContext(players) {
  const active = players.filter(p => p.status === 'ACTIVE' && p.odds);
  const rankBy = f => new Map([...active].sort((a, b) => f(b) - f(a)).map((p, i) => [p.id, i + 1]));
  return {
    n: active.length,
    skillRank: rankBy(p => p.model.skill),
    weekRank: rankBy(p => p.model.sg - (p.drawCost || 0)),
    sgRank: rankBy(p => p.model.sg),
  };
}

// Why this player: the model drivers that actually move them, most important first.
function playerReasons(p, ctx, market) {
  const r = [];
  const m = p.model;
  r.push(`Projected ${sgn(m.sg)} strokes/round vs an average tour player, ${ordinal(ctx.sgRank.get(p.id))} in the field`);
  const lift = ctx.skillRank.get(p.id) - ctx.weekRank.get(p.id);
  if (lift >= 5) r.push(`Rates ${ordinal(ctx.skillRank.get(p.id))} on long-run skill but ${ordinal(ctx.weekRank.get(p.id))} once this week's course fit, form and draw are added`);
  if (m.form >= 0.5) r.push(`In form: ${sgn(m.form, 1)} strokes/round over the last 12 rounds vs baseline`);
  if (m.courseFit >= 0.15) r.push(`Course history adds ${sgn(m.courseFit)} strokes/round (${m.courseRounds} rounds here, regressed)`);
  if (p.drawCost !== null && p.drawCost <= -0.3) r.push(`${p.draw} draw: tee times worth ${sgn(-p.drawCost, 1)} strokes vs the field over R1–R2`);
  if ((market === 'win' || market === 'top5') && m.sd >= 2.95) r.push(`High-variance scorer (${m.sd.toFixed(2)}-stroke round spread): more ceiling for a ${market === 'win' ? 'win' : 'top 5'}`);
  if ((market === 'makeCut' || market === 'top20') && m.sd <= 2.65) r.push(`Steady scorer (${m.sd.toFixed(2)}-stroke round spread): fewer blow-up rounds`);
  if (m.form <= -0.5) r.push(`Caution: ${sgn(m.form, 1)} strokes/round form dip over the last 12 rounds`);
  if (m.ci === 'low') r.push(`Caution: only ${m.rounds12m} tracked rounds in the last year, so the projection leans on the prior`);
  return r;
}

// Book lookup: { market -> Map(id -> {dec, raw, fair}) }, de-vigged within a market when the file
// covers most of the field (outrights) or within each group (matchups).
function bookIndex(book, payload) {
  const out = {};
  const field = payload.players.filter(p => p.status === 'ACTIVE').length || 1;
  for (const m of MARKETS) {
    const rows = book.filter(b => b.market === m.key && b.dec > 1);
    if (!rows.length) continue;
    const expected = m.n || payload.players.reduce((s, p) => s + (p.odds?.makeCut || 0), 0);
    const sum = rows.reduce((s, r) => s + 1 / r.dec, 0);
    const k = m.key !== 'makeCut' && rows.length / field >= 0.8 ? expected / sum : 1;
    out[m.key] = new Map(rows.map(r => [r.id, { dec: r.dec, raw: r.raw || null, fair: (1 / r.dec) * k, devig: k !== 1 }]));
  }
  return out;
}

function matchupPlays(payload, sim, book, ctx) {
  const byId = new Map(payload.players.map(p => [p.id, p]));
  const current = payload.event.state === 'pre' ? 1 : payload.event.currentRound || 1;
  const rounds = payload.matchups.filter(m => m.round >= current).slice(0, 2);
  return rounds.map(m => {
    const priced = new Map(book.filter(b => (b.market === '3ball' || b.market === '2ball') && Number(b.round || 1) === m.round && b.dec > 1).map(b => [b.id, b]));
    const mode = priced.size ? 'value' : 'model';
    const all = [];
    for (const g of m.groups) {
      const groupBook = g.players.every(x => priced.has(x.id)) ? g.players.reduce((s, x) => s + 1 / priced.get(x.id).dec, 0) : null;
      for (const x of g.players) {
        const p = byId.get(x.id);
        if (!p || p.status !== 'ACTIVE') continue;
        const prob = g.size === 2 ? x.noPush : x.deadHeat;
        const others = g.players.filter(o => o.id !== x.id).map(o => byId.get(o.id)).filter(Boolean);
        const strongest = others.reduce((a, b) => (b.model.sg > a.model.sg ? b : a), others[0]);
        const sgGap = p.model.sg - mean(others.map(o => o.model.sg));
        const bk = priced.get(x.id);
        let fair = null, edge = null, ev = null;
        if (bk) {
          fair = groupBook ? 1 / bk.dec / groupBook : 1 / bk.dec;
          edge = prob - fair;
          ev = g.size === 2 ? x.outright * bk.dec + x.tie - 1 : x.deadHeat * bk.dec - 1;
        }
        all.push({ p, g, x, prob, others, strongest, sgGap, bk, fair, edge, ev, score: mode === 'value' ? ev : prob - 1 / g.size });
      }
    }
    const eligible = mode === 'value' ? all.filter(a => a.bk && a.ev >= MIN_EV && a.edge > 0) : all.filter(a => a.prob - 1 / a.g.size > 0);
    const best = new Map();
    for (const a of eligible.sort((u, v) => v.score - u.score)) {
      const key = a.g.players.map(x => x.id).join();
      if (!best.has(key)) best.set(key, a);
    }
    const top = [...best.values()].slice(0, 6);
    const plays = top.map(a => {
      const h2h = a.strongest ? priceGroup(sim, m.round, [a.p.id, a.strongest.id]) : null;
      const reasons = [
        `Out-rates groupmates by ${sgn(a.sgGap)} strokes/round (${sgn(a.p.model.sg)} vs ${a.others.map(o => `${o.name} ${sgn(o.model.sg)}`).join(', ')})`,
      ];
      if (h2h && a.g.size > 2) reasons.push(`Beats ${a.strongest.name}, the toughest groupmate, in ${pct(h2h[0].noPush)} of simulated rounds head to head`);
      // Form, course and sample-size notes, phrased the same way as the finishing plays.
      reasons.push(...playerReasons(a.p, ctx, 'matchup').slice(1).filter(t => !/draw:|long-run skill|scorer/.test(t)));
      if (a.bk) reasons.unshift(`Book ${a.bk.raw || ''} implies ${pct(a.fair)} after removing the margin; the model has ${pct(a.prob)} → ${sgn(a.edge * 100, 1)} pts edge, ${a.ev >= 0 ? '+' : '−'}$${Math.abs(a.ev).toFixed(2)} expected per $1`);
      return {
        id: a.p.id, name: a.p.name, round: m.round, prob: a.prob, fairOdds: american(a.prob),
        group: { local: a.g.local, startHole: a.g.startHole, size: a.g.size, wave: a.g.wave, opponents: a.others.map(o => o.name) },
        book: a.bk ? { raw: a.bk.raw, dec: a.bk.dec, fair: a.fair, edge: a.edge, ev: a.ev } : null,
        sgGap: a.sgGap, reasons,
      };
    });

    // How these differ from the rest of the sheet.
    const favs = [];
    for (const g of m.groups) {
      const ps = g.players.map(x => ({ x, p: byId.get(x.id) })).filter(o => o.p);
      if (ps.length < 2) continue;
      const f = ps.reduce((a, b) => ((b.x.deadHeat ?? 0) > (a.x.deadHeat ?? 0) ? b : a));
      favs.push(f.p.model.sg - mean(ps.filter(o => o !== f).map(o => o.p.model.sg)));
    }
    let summary;
    if (!plays.length) summary = mode === 'value' ? `No R${m.round} price beats the model by ${pct(MIN_EV)}+ expected profit. The uploaded prices are close to fair or the book's margin eats the edge, so passing is the play.` : 'No group on this sheet has a clear favorite.';
    else if (mode === 'value') {
      const rest = all.filter(a => a.bk && !top.includes(a));
      summary = `Ranked by expected profit against your prices. These ${plays.length} average a ${sgn(mean(top.map(a => a.edge)) * 100, 1)}-point edge and ${mean(top.map(a => a.ev)) >= 0 ? '+' : '−'}$${Math.abs(mean(top.map(a => a.ev))).toFixed(2)} per $1, while the other ${rest.length} priced players average ${sgn(mean(rest.map(a => a.edge)) * 100, 1)} points: roughly the book's margin. One play per group, so no two picks can cancel each other out.`;
    } else {
      const boosted = top.filter(a => a.p.signals.some(s => (s.key === 'form' || s.key === 'course') && s.tone === 'pos')).length;
      summary = `The biggest mismatches on the R${m.round} sheet. These favorites out-rate their groupmates by ${sgn(mean(top.map(a => a.sgGap)))} strokes/round on average, vs ${sgn(mean(favs))} for a typical group favorite, and win their group ${pct(mean(top.map(a => a.prob)))} of the time vs ${pct(mean(top.map(a => 1 / a.g.size)))} for an even split.${boosted ? ` ${boosted} of ${plays.length} also carry a form or course-history boost.` : ''} Upload book prices on Matchups to rank by value instead.`;
    }
    return { round: m.round, inferred: m.inferred, mode, summary, plays };
  });
}

function finishingPlays(payload, books, ctx) {
  const out = {};
  const active = payload.players.filter(p => p.status === 'ACTIVE' && p.odds);
  for (const m of MARKETS) {
    if (m.key === 'makeCut' && !payload.event.cut?.top) continue;
    const bk = books[m.key];
    const mode = bk ? 'value' : 'model';
    const rows = active.map(p => {
      const prob = p.odds[m.key];
      const b = bk?.get(p.id) || null;
      return { p, prob, b, edge: b ? prob - b.fair : null, ev: b ? prob * b.dec - 1 : null };
    });
    // Value plays need a real chance and enough simulated hits for the EV to be signal: long
    // prices on near-zero probabilities otherwise top the list on simulation noise.
    const floor = Math.max(m.key === 'win' ? 0.01 : 0.03, 150 / (payload.model?.sims || 15000));
    const top = (mode === 'value' ? rows.filter(r => r.b && r.prob >= floor && r.ev >= MIN_EV && r.edge > 0).sort((a, b) => b.ev - a.ev) : rows.sort((a, b) => b.prob - a.prob)).slice(0, 6);
    const plays = top.map(r => {
      const reasons = playerReasons(r.p, ctx, m.key);
      if (r.b) reasons.unshift(`Book ${r.b.raw || ''} implies ${pct(r.b.fair, 1)}${r.b.devig ? ' after removing the margin' : ''}; the model has ${pct(r.prob, 1)} → ${r.ev >= 0 ? '+' : '−'}$${Math.abs(r.ev).toFixed(2)} expected per $1`);
      return { id: r.p.id, name: r.p.name, prob: r.prob, fairOdds: american(r.prob), draw: r.p.draw, book: r.b ? { raw: r.b.raw, dec: r.b.dec, fair: r.b.fair, edge: r.edge, ev: r.ev } : null, reasons };
    });
    const others = rows.filter(r => !top.includes(r));
    let summary;
    if (!plays.length) summary = `No ${m.label.toLowerCase()} price beats the model by ${pct(MIN_EV)}+ expected profit on a golfer with a realistic chance (${pct(floor, 0)}+), so there's no value play in this market at these prices.`;
    else if (mode === 'value') {
      summary = `Ranked by expected profit against your ${m.label.toLowerCase()} prices: these ${plays.length} average ${sgn(mean(top.map(r => r.edge)) * 100, 1)} points over the book's ${top[0].b.devig ? 'no-vig ' : ''}price, vs ${sgn(mean(others.filter(r => r.b).map(r => r.edge)) * 100, 1)} for the rest of the priced field.`;
    } else {
      const lifted = top.filter(r => ctx.skillRank.get(r.p.id) - ctx.weekRank.get(r.p.id) >= 5).length;
      const drawPos = top.filter(r => r.p.drawCost !== null && r.p.drawCost <= -0.3).length;
      summary = `The model's strongest ${m.label.toLowerCase()} candidates: ${pct(mean(top.map(r => r.prob)), m.key === 'makeCut' ? 0 : 1)} on average vs ${pct(mean(others.map(r => r.prob)), 1)} for the rest of the field. They project ${sgn(mean(top.map(r => r.p.model.sg)))} strokes/round vs ${sgn(mean(others.map(r => r.p.model.sg)))}.`;
      if (lifted || drawPos) summary += ` ${[lifted ? `${lifted} ${lifted === 1 ? 'rates' : 'rate'} meaningfully higher this week than long-run skill alone (course fit, form or draw)` : null, drawPos ? `${drawPos} ${drawPos === 1 ? 'has' : 'have'} the better side of the draw` : null].filter(Boolean).join('; ')}: the parts of a projection a skill-based price is most likely to miss.`;
      summary += ' Upload prices to see which of these are actually value.';
    }
    out[m.key] = { label: m.label, mode, summary, plays };
  }
  return out;
}

function parlayPlays(payload, sim, books) {
  const out = {};
  const active = payload.players.filter(p => p.status === 'ACTIVE' && p.odds);
  const nameOf = new Map(payload.players.map(p => [p.id, p]));
  for (const key of PARLAY_MARKETS) {
    if (key === 'makeCut' && !payload.event.cut?.top) continue;
    const bk = books[key];
    const candidates = active.map(p => ({ id: p.id, dec: bk?.get(p.id)?.dec || null }));
    const bySize = {};
    for (const size of [3, 4, 5]) {
      // Keep tickets bettable: each must cash often enough that it isn't a lottery ticket.
      const minJoint = { 3: 0.05, 4: 0.03, 5: 0.02 }[size];
      const res = autoFinishParlays(sim, bk ? candidates.filter(c => c.dec) : candidates, { market: key, size, count: 3, pool: size === 5 ? 11 : 12, minJoint });
      // No value ticket at this size: show the most likely one, priced against the book, labeled.
      let fallback = false;
      if (bk && !res.parlays.length) {
        const alt = autoFinishParlays(sim, candidates.filter(c => c.dec), { market: key, size, count: 1, pool: 12, minJoint, rankBy: 'joint' });
        if (alt.parlays.length) { res.parlays = alt.parlays; fallback = true; }
      }
      bySize[size] = {
        note: res.note, fallback,
        parlays: res.parlays.map(x => ({
          joint: x.joint, independent: x.independent, lift: x.lift, fairDecimal: x.fairDecimal, bookDecimal: x.bookDecimal, ev: x.ev,
          legs: x.legs.map(l => ({ id: l.id, name: nameOf.get(l.id)?.name || l.id, prob: l.prob, draw: nameOf.get(l.id)?.draw || null, dec: l.dec })),
        })),
      };
    }
    // The summary describes a real value ticket when prices exist (never a fallback), else the
    // 4-leg (or 3-leg) most likely ticket.
    const pick = bk ? [4, 3, 5].map(n => bySize[n]).find(x => x.parlays[0] && !x.fallback) : (bySize[4].parlays[0] ? bySize[4] : bySize[3]);
    const mid = pick?.parlays[0] || null;
    const label = MARKETS.find(m => m.key === key).label;
    let summary = '';
    if (bk && !mid) summary = `No ${label.toLowerCase()} ticket at your prices clears the bar: every leg +EV on its own and a realistic chance to cash. The cards show the most likely tickets instead, priced against your book, so you can see what each would cost.`;
    if (mid) {
      const n = mid.legs.length;
      const waves = new Set(mid.legs.map(l => l.draw).filter(Boolean));
      const corr = mid.lift < 0.97
        ? `${pct(1 - mid.lift)} lower than multiplying the legs, because ${label.toLowerCase()} legs compete for the same ${FINISH_N[key] || 'cut'} spots`
        : mid.lift > 1.03 ? `${pct(mid.lift - 1)} higher than multiplying the legs, because the legs tend to succeed together (shared conditions)` : 'close to what multiplying the legs gives: these legs are nearly independent';
      summary = bk
        ? `Built from your ${label.toLowerCase()} prices and ranked by expected profit. The best ${n}-leg ticket pays ${mid.bookDecimal ? `${mid.bookDecimal.toFixed(2)}x` : '—'} with ${mid.ev >= 0 ? '+' : '−'}$${Math.abs(mid.ev).toFixed(2)} expected per $1. It hits in ${pct(mid.joint, 1)} of simulated tournaments, ${corr}.`
        : `Every combination of the ${label.toLowerCase()} likeliest players, priced together inside the simulation. The best ${n}-leg ticket cashes in ${pct(mid.joint, 1)} of simulated tournaments (fair ${american(mid.joint)}), ${corr}.${waves.size > 1 ? ' The legs are spread across both halves of the draw, so one bad weather wave can’t sink the whole ticket.' : ''} Without prices this is the most likely ticket, not a value ranking.`;
    }
    out[key] = { label, mode: bk ? 'value' : 'model', summary, bySize };
  }
  return out;
}

function buildPlays(payload, sim, book = []) {
  const ctx = fieldContext(payload.players);
  const books = bookIndex(book, payload);
  return {
    event: { id: payload.event.id, name: payload.event.name, state: payload.event.state },
    minEv: MIN_EV,
    matchups: matchupPlays(payload, sim, book, ctx),
    finishing: finishingPlays(payload, books, ctx),
    parlays: parlayPlays(payload, sim, books),
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { buildPlays, playerReasons, fieldContext };
