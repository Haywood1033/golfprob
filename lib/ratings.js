// lib/ratings.js — player skill from round scores.
//
// Step 1, field-strength adjustment. A 68 in a weak opposite-field event is not a 68 at a major,
// so raw "strokes minus field average" overrates players who feast on weak fields. Fit a
// two-way model  strokes = difficulty(round) + ability(player) + noise  by alternating
// least squares; each round's adjusted score is then strokes - difficulty(round), on one
// scale across events, courses and tours (players who cross tours link the scales).
//
// Step 2, the projection as of a date: recency-weighted mean of adjusted rounds (geometric
// decay per round plus a one-year time half-life), regressed toward a below-average prior,
// plus a heavily regressed course-history term. The same patterns as nflprob, ported to rounds.
//
// Sign convention everywhere outside this file's internals: SG = strokes gained per round vs
// an average tour player in the history window. Positive is better.

const { normName } = require('./names');

const DAY = 86400000;
const PRIOR_SG = -1.0;     // unknown/thin-history players are usually qualifiers and exemptions
const PRIOR_K = 5;         // effective rounds before a player's own record dominates the prior
const ROUND_DECAY = 0.975; // per round back (half-life ~27 rounds, about 7 events)
const TIME_HALF_LIFE = 365;
const SD_PRIOR = 2.8;      // tour-wide per-round standard deviation in strokes
const SD_K = 20;
const FIT_K = 16;          // course-fit shrinkage: 16 rounds at a course to count half
const FIT_CAP = 0.8;
const MIN_ROUND_FIELD = 15;

function regress(actual, prior, weight, k) {
  if (!weight) return prior;
  return (actual * weight + prior * k) / (weight + k);
}

const courseKey = name => normName(name).replace(/\b(the|golf|club|country|cc|gc|course|links|resort)\b/g, '').replace(/\s+/g, ' ').trim();

// rows: [{tour, eventId, round, course, playerId, name, strokes, date, par}]
function fitRoundEffects(rows, { iterations = 12 } = {}) {
  const roundOf = r => `${r.tour}|${r.eventId}|${r.round}|${courseKey(r.course)}`;
  const byRound = new Map();
  for (const r of rows) {
    const k = roundOf(r);
    if (!byRound.has(k)) byRound.set(k, []);
    byRound.get(k).push(r);
  }
  const kept = [];
  for (const [k, list] of byRound) if (list.length >= MIN_ROUND_FIELD) for (const r of list) kept.push([k, r]);

  const ability = new Map(); // playerId -> strokes relative to baseline (lower is better)
  const diff = new Map();    // roundKey -> difficulty in strokes
  for (const [, r] of kept) ability.set(r.playerId, 0);

  for (let it = 0; it < iterations; it++) {
    const dSum = new Map(), dN = new Map();
    for (const [k, r] of kept) {
      dSum.set(k, (dSum.get(k) || 0) + r.strokes - ability.get(r.playerId));
      dN.set(k, (dN.get(k) || 0) + 1);
    }
    for (const [k, s] of dSum) diff.set(k, s / dN.get(k));
    const aSum = new Map(), aN = new Map();
    for (const [k, r] of kept) {
      aSum.set(r.playerId, (aSum.get(r.playerId) || 0) + r.strokes - diff.get(k));
      aN.set(r.playerId, (aN.get(r.playerId) || 0) + 1);
    }
    // Light shrinkage stabilizes one-event players without moving regulars.
    for (const [p, s] of aSum) ability.set(p, (s + 4 * -PRIOR_SG) / (aN.get(p) + 4));
    // Anchor the scale: the average round in the window is played by a 0.00 player.
    let mean = 0;
    for (const [, r] of kept) mean += ability.get(r.playerId);
    mean /= kept.length || 1;
    for (const [p, a] of ability) ability.set(p, a - mean);
  }

  const adjusted = kept.map(([k, r]) => ({ ...r, sg: diff.get(k) - r.strokes, roundKey: k }));

  // Course difficulty relative to par for an average player — the baseline the simulator uses
  // to turn relative projections back into realistic stroke totals.
  const courseOffset = new Map();
  const cAgg = new Map();
  for (const [k, list] of byRound) {
    if (!diff.has(k)) continue;
    const ck = courseKey(list[0].course);
    const a = cAgg.get(ck) || { s: 0, n: 0 };
    a.s += diff.get(k) - (list[0].par || 72);
    a.n += 1;
    cAgg.set(ck, a);
  }
  for (const [ck, a] of cAgg) courseOffset.set(ck, a.s / a.n);

  return { adjusted, courseOffset, roundsFit: kept.length, roundGroups: diff.size };
}

function groupByPlayer(adjusted) {
  const m = new Map();
  for (const r of adjusted) {
    if (!m.has(r.playerId)) m.set(r.playerId, []);
    m.get(r.playerId).push(r);
  }
  for (const list of m.values()) list.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.round - a.round);
  return m;
}

function ciTier(rounds12m) {
  if (rounds12m >= 40) return 'high';
  if (rounds12m >= 16) return 'mid';
  return 'low';
}

// history: rounds for one player, most recent first.
function ratePlayer(history, { asOf, courseKeys = [] }) {
  const asOfMs = new Date(asOf).getTime();
  let sw = 0, swx = 0, rounds12m = 0;
  history.forEach((r, i) => {
    const daysAgo = Math.max(0, (asOfMs - new Date(r.date).getTime()) / DAY);
    const w = Math.pow(ROUND_DECAY, i) * Math.pow(0.5, daysAgo / TIME_HALF_LIFE);
    r._w = w;
    sw += w; swx += w * r.sg;
    if (daysAgo <= 365) rounds12m++;
  });
  const rawMean = sw ? swx / sw : PRIOR_SG;
  const skill = regress(rawMean, PRIOR_SG, sw, PRIOR_K);

  let sv = 0;
  for (const r of history) sv += r._w * (r.sg - skill) ** 2;
  const sd = Math.sqrt((sv + SD_K * SD_PRIOR ** 2) / (sw + SD_K));
  const se = sd / Math.sqrt(sw + PRIOR_K);

  // Form: last 12 rounds, steeper decay, compared with the long-run estimate.
  const recent = history.slice(0, 12);
  let fw = 0, fx = 0;
  recent.forEach((r, i) => { const w = Math.pow(0.88, i); fw += w; fx += w * r.sg; });
  const form = recent.length >= 6 ? fx / fw - skill : 0;

  // Course history: residual vs this player's own unweighted average, heavily regressed.
  let courseFit = 0, courseRounds = 0;
  if (courseKeys.length && history.length) {
    const overall = history.reduce((s, r) => s + r.sg, 0) / history.length;
    let res = 0;
    for (const r of history) {
      if (courseKeys.includes(courseKey(r.course))) { res += r.sg - overall; courseRounds++; }
    }
    if (courseRounds >= 2) courseFit = Math.max(-FIT_CAP, Math.min(FIT_CAP, res / (courseRounds + FIT_K)));
  }

  return {
    skill, courseFit, form, sd, se,
    sg: skill + courseFit,
    rounds: history.length, rounds12m, courseRounds,
    ci: ciTier(rounds12m),
    recent: history.slice(0, 24).map(r => ({ date: r.date, event: r.eventName || null, round: r.round, sg: +r.sg.toFixed(2), strokes: r.strokes })),
  };
}

function signalsFor(rt) {
  const s = [];
  if (rt.form >= 0.6) s.push({ key: 'form', tone: 'pos', label: 'Hot form', why: `+${rt.form.toFixed(1)} SG/round over the last 12 rounds vs baseline` });
  if (rt.form <= -0.6) s.push({ key: 'form', tone: 'neg', label: 'Cold form', why: `${rt.form.toFixed(1)} SG/round over the last 12 rounds vs baseline` });
  if (rt.courseFit >= 0.2) s.push({ key: 'course', tone: 'pos', label: 'Course history', why: `+${rt.courseFit.toFixed(2)} SG/round adjustment from ${rt.courseRounds} rounds here (regressed)` });
  if (rt.courseFit <= -0.2) s.push({ key: 'course', tone: 'neg', label: 'Poor course history', why: `${rt.courseFit.toFixed(2)} SG/round adjustment from ${rt.courseRounds} rounds here (regressed)` });
  if (rt.sd >= 3.05) s.push({ key: 'vol', tone: 'info', label: 'High variance', why: `Round-to-round spread of ${rt.sd.toFixed(2)} strokes, above the ${SD_PRIOR} tour norm — more boom/bust` });
  if (rt.ci === 'low') s.push({ key: 'thin', tone: 'warn', label: 'Thin sample', why: `${rt.rounds12m} tracked rounds in the last year — projection leans on the prior` });
  return s;
}

// Rate every field player as of `asOf`. Players with no history get the prior and a thin flag.
function rateField(field, rows, { asOf, courseNames = [] }) {
  const fit = fitRoundEffects(rows.filter(r => r.date && r.date < String(asOf).slice(0, 10)));
  const byPlayer = groupByPlayer(fit.adjusted);
  // Fallback for id mismatches across tours: normalized name.
  const byName = new Map();
  for (const [, list] of byPlayer) if (list[0]) byName.set(normName(list[0].name), list);
  const courseKeys = courseNames.filter(Boolean).map(courseKey);

  const ratings = new Map();
  for (const p of field) {
    const hist = byPlayer.get(p.id) || byName.get(normName(p.name)) || [];
    const rt = ratePlayer(hist, { asOf, courseKeys });
    rt.signals = signalsFor(rt);
    ratings.set(p.id, rt);
  }
  const offsets = courseKeys.map(k => fit.courseOffset.get(k)).filter(v => v !== undefined);
  return {
    ratings,
    courseOffset: offsets.length ? offsets.reduce((a, b) => a + b, 0) / offsets.length : null,
    meta: { roundsFit: fit.roundsFit, roundGroups: fit.roundGroups, playersRated: byPlayer.size },
  };
}

module.exports = { regress, fitRoundEffects, ratePlayer, rateField, courseKey, signalsFor, PRIOR_SG, SD_PRIOR };
