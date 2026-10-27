// lib/tournament.js — assembles one event end to end: ESPN field + tee sheet -> course location
// -> weather -> ratings -> simulation -> matchups. api/tournament.js and api/weather.js both call
// in here so the two tabs always describe the same event, tee sheet and forecast.

const { fetchLeaderboard } = require('./espn');
const { resolveCourseLocation } = require('./courses');
const { getTournamentWeather, analyzeWaves } = require('./weather');
const { buildWriteup } = require('./weather-writeup');
const { buildRoundSheet, inferNextRound, fmtHour, localHour } = require('./teetimes');
const { loadRounds, saveSnapshotSafely } = require('./store');
const { rateField } = require('./ratings');
const { simulate, priceGroup } = require('./simulator');
const { cutRule } = require('./cut-rules');
const { hashSeed } = require('./rng');
const { dkProjections } = require('./dk');

const memo = new Map(); // key -> { at, value, sim } — the sim stays server-side for parlays
const MEMO_MS = { pre: 10 * 60000, in: 3 * 60000, post: 60 * 60000 };

async function loadEventContext({ tour = 'pga', eventId = null, lat = null, lon = null }) {
  const ev = await fetchLeaderboard(tour, eventId, { live: true });
  if (!ev) throw Object.assign(new Error('ESPN returned no event for this tour/id'), { status: 404 });

  let loc = lat !== null && lon !== null ? { lat, lon, label: 'Manual location', approx: false, source: 'query' } : await resolveCourseLocation(ev.course);
  const startDate = (ev.startDate || new Date().toISOString()).slice(0, 10);

  let wx = null, wxError = null;
  if (loc) {
    try { wx = await getTournamentWeather({ lat: loc.lat, lon: loc.lon, startDate, rounds: ev.numberOfRounds }); }
    catch (err) { wxError = err.message; }
  }
  const tz = wx?.tzOffsetSec ?? -4 * 3600; // ET fallback only when weather is unavailable

  // Tee sheets per round: a round's own tee time when ESPN has it, else the player's current
  // tee time for the round in progress/next up; R2 inferred from R1 when not yet posted.
  const sheets = {};
  for (let r = 1; r <= ev.numberOfRounds; r++) {
    const list = ev.players.map(p => {
      const rd = p.rounds.find(x => x.round === r);
      const teeTime = rd?.teeTime || ((p.round === r || (ev.state === 'pre' && r === 1)) ? p.teeTime : null);
      let startHole = rd?.startHole || ((p.round === r || (ev.state === 'pre' && r === 1)) ? p.startHole : null);
      // ESPN only gives the start hole for the current round; R1/R2 swap tees, so the other
      // round's start hole tells us this one's. Keeps 1st- and 10th-tee groups apart.
      if (!startHole && r <= 2) {
        const other = p.rounds.find(x => x.round === 3 - r)?.startHole || (p.round === 3 - r ? p.startHole : null);
        if (other === 1 || other === 10) startHole = other === 1 ? 10 : 1;
      }
      return { id: p.id, teeTime, startHole };
    }).filter(x => x.teeTime && x.id && ev.players.find(p => p.id === x.id)?.status !== 'WD');
    const sheet = buildRoundSheet(list, tz, { round: r });
    if (sheet && sheet.groups.length >= 4) sheets[r] = sheet;
  }
  if (sheets[1] && !sheets[2] && ev.numberOfRounds >= 2) {
    const inferred = inferNextRound(sheets[1], 2);
    if (inferred) sheets[2] = buildRoundSheet(inferred, tz, { round: 2, inferred: true });
  }

  if (wx) {
    const waveHours = {};
    for (const [r, sh] of Object.entries(sheets)) {
      const am = sh.groups.filter(g => g.wave === 'AM'), pm = sh.groups.filter(g => g.wave === 'PM');
      if (am.length && pm.length) {
        const mid = arr => arr[Math.floor(arr.length / 2)].hour;
        waveHours[r] = { am: mid(am), pm: mid(pm) };
      }
    }
    Object.assign(wx, analyzeWaves(wx, waveHours));
  }
  return { ev, loc, wx, wxError, sheets, tz, startDate };
}

function publicWeather(ctx) {
  const { ev, loc, wx, wxError, startDate } = ctx;
  if (!wx) return { available: false, error: wxError || (loc ? 'Weather unavailable' : 'Course location unknown'), location: loc };
  const daysUntilStart = Math.round((new Date(`${startDate}T12:00:00Z`) - Date.now()) / 86400000);
  const writeup = buildWriteup(wx, {
    eventName: ev.name,
    daysUntilStart,
    locationNote: loc?.approx ? `Forecast point is ${loc.label} (town-level), not the course itself — fine for wind and rain, a little less precise in hilly or coastal terrain.` : null,
  });
  const { cost, ...rest } = wx;
  return {
    available: true,
    location: loc,
    ...rest,
    waves: rest.waves.map(({ memberEdges, ...w }) => w),
    writeup,
  };
}

function teeInfo(sheets, id) {
  const out = {};
  for (const [r, sh] of Object.entries(sheets)) {
    const t = sh.byPlayer.get(id);
    if (t) out[r] = { time: t.teeTime, local: fmtHour(t.hour), hour: t.hour, wave: t.wave, startHole: t.startHole, inferred: !!sh.inferred };
  }
  return out;
}

async function buildTournament({ tour = 'pga', eventId = null, sims = 15000, lat = null, lon = null } = {}) {
  const key = `${tour}|${eventId || 'current'}|${sims}|${lat},${lon}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < (MEMO_MS[hit.value.event.state] || MEMO_MS.pre)) return hit.value;
  return (await buildTournamentWithSim({ tour, eventId, sims, lat, lon, key })).payload;
}

// The payload plus the raw simulation (round scores, finish positions) for parlay pricing.
async function getSimContext({ tour = 'pga', eventId = null, sims = 15000, lat = null, lon = null } = {}) {
  const key = `${tour}|${eventId || 'current'}|${sims}|${lat},${lon}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < (MEMO_MS[hit.value.event.state] || MEMO_MS.pre)) return { payload: hit.value, sim: hit.sim };
  return buildTournamentWithSim({ tour, eventId, sims, lat, lon, key });
}

async function buildTournamentWithSim({ tour, eventId, sims, lat, lon, key }) {

  const t0 = Date.now();
  const ctx = await loadEventContext({ tour, eventId, lat, lon });
  const { ev, wx, sheets } = ctx;

  const { rows, source } = await loadRounds({ before: ev.startDate || new Date() });
  const { ratings, courseOffset, meta } = rateField(ev.players, rows, { asOf: ev.startDate || new Date().toISOString(), courseNames: [ev.course.name] });

  const cut = cutRule(ev);
  const players = ev.players.map(p => ({ ...p, rating: ratings.get(p.id) }));
  const roundDates = wx ? wx.days.map(d => d.date) : [];
  const sim = simulate({
    players, par: ev.course.par, courseOffset: courseOffset ?? 0.3, numberOfRounds: ev.numberOfRounds,
    cut, sheets, roundDates, wx, sims, seed: hashSeed(`${ev.id}|${ev.state}|${rows.length}`),
  });

  // Each player's weather cost for R1/R2 vs field (deterministic run) and resulting draw label.
  const drawCost = new Map();
  if (wx) {
    for (const r of [1, 2]) {
      const sh = sheets[r];
      if (!sh) continue;
      const costs = [...sh.byPlayer.entries()].map(([id, t]) => [id, wx.cost(0, roundDates[r - 1], t.hour)]);
      const mean = costs.reduce((s, [, c]) => s + c, 0) / (costs.length || 1);
      for (const [id, c] of costs) drawCost.set(id, (drawCost.get(id) || 0) + c - mean);
    }
  }

  const simById = new Map(sim.results.map(r => [r.id, r]));
  const dk = dkProjections(sim, { par: ev.course.par, course: ev.course });
  const outPlayers = players.map(p => {
    const rt = p.rating;
    const tee = teeInfo(sheets, p.id);
    const wcost = drawCost.has(p.id) ? drawCost.get(p.id) : null;
    const signals = [...rt.signals];
    if (wcost !== null && wcost <= -0.4) signals.unshift({ key: 'draw', tone: 'pos', label: 'Good draw', why: `Tee times project ${Math.abs(wcost).toFixed(1)} strokes easier than the field average over R1–R2` });
    if (wcost !== null && wcost >= 0.4) signals.unshift({ key: 'draw', tone: 'neg', label: 'Tough draw', why: `Tee times project ${wcost.toFixed(1)} strokes harder than the field average over R1–R2` });
    return {
      id: p.id, name: p.name, country: p.country, amateur: p.amateur,
      status: p.status, position: p.position, toPar: p.toPar, thru: p.thru, round: p.round,
      rounds: p.rounds.map(r => ({ round: r.round, strokes: r.strokes, complete: r.complete, thru: r.thruHoles, toPar: r.toPar })),
      tee,
      draw: tee[1] && tee[2] ? `${tee[1].wave}/${tee[2].wave}` : tee[1] ? tee[1].wave : null,
      drawCost: wcost,
      model: {
        sg: rt.sg, skill: rt.skill, courseFit: rt.courseFit, form: rt.form, sd: rt.sd,
        ci: rt.ci, rounds: rt.rounds, rounds12m: rt.rounds12m, courseRounds: rt.courseRounds,
        recent: rt.recent,
      },
      signals,
      odds: simById.get(p.id) || null,
      dk: dk.get(p.id) || null,
    };
  }).sort((a, b) => (b.odds?.win ?? -1) - (a.odds?.win ?? -1) || (b.model.sg - a.model.sg));

  // Matchups for every round with a tee sheet.
  const nameOf = new Map(outPlayers.map(p => [p.id, p.name]));
  const matchups = Object.values(sheets).map(sh => ({
    round: sh.round, inferred: !!sh.inferred, date: roundDates[sh.round - 1] || sh.date,
    groups: sh.groups.map(g => {
      const priced = priceGroup(sim, sh.round, g.ids);
      return {
        teeTime: g.teeTime, local: fmtHour(g.hour), startHole: g.startHole, wave: g.wave,
        size: g.ids.length,
        players: (priced || g.ids.map(id => ({ id }))).map(x => ({ ...x, name: nameOf.get(x.id) || x.id })),
      };
    }).filter(g => g.size >= 2),
  })).sort((a, b) => a.round - b.round);

  const payload = {
    event: {
      tour: ev.tour, tourName: ev.tourName, id: ev.id, name: ev.name, state: ev.state, statusDetail: ev.statusDetail,
      startDate: ev.startDate, endDate: ev.endDate, currentRound: ev.currentRound, numberOfRounds: ev.numberOfRounds,
      course: { name: ev.course.name, par: ev.course.par, yards: ev.course.yards, city: ev.course.city, state: ev.course.state, country: ev.course.country },
      cut, fieldSize: ev.players.filter(p => p.status !== 'WD').length,
    },
    model: {
      sims: sim.sims, members: sim.members, courseOffset: sim.offset, historySource: source,
      historyRounds: rows.length, ...meta, weather: !!wx, draw: wx?.draw ? { favored: wx.draw.favored, edge: wx.draw.edge, agreement: wx.draw.agreement } : null,
      bucketLabels: sim.bucketLabels, ms: Date.now() - t0,
    },
    players: outPlayers,
    matchups,
    generatedAt: new Date().toISOString(),
  };

  // Keep the pre-tournament projection current until the first tee shot; the last one saved
  // before the event starts is what gets graded. Awaited: a serverless function can be frozen
  // as soon as the response goes out, which silently drops an un-awaited write.
  if (ev.state === 'pre') {
    payload.snapshot = await saveSnapshotSafely(ev, {
      generatedAt: payload.generatedAt, cut, sims: sim.sims,
      players: outPlayers.map(p => ({ id: p.id, name: p.name, sg: p.model.sg, ci: p.model.ci, odds: p.odds && { win: p.odds.win, top5: p.odds.top5, top10: p.odds.top10, top20: p.odds.top20, makeCut: p.odds.makeCut, top10Any: p.odds.top10Any, top20Any: p.odds.top20Any }, dk: p.dk?.mean ?? null })),
      matchups: matchups.filter(m => m.round <= 2).map(m => ({ round: m.round, groups: m.groups.map(g => g.players.map(x => ({ id: x.id, deadHeat: x.deadHeat, noPush: x.noPush }))) })),
    });
  }

  memo.set(key, { at: Date.now(), value: payload, sim });
  if (memo.size > 6) memo.delete(memo.keys().next().value);
  return { payload, sim };
}

module.exports = { buildTournament, getSimContext, loadEventContext, publicWeather, localHour };
