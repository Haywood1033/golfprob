// lib/espn.js — ESPN's unofficial golf API (free, no key). Two endpoints:
//   scoreboard  site.api.espn.com/apis/site/v2/sports/golf/{tour}/scoreboard?dates={season}
//               -> leagues[0].calendar: the season's events (id, label, start/end dates)
//   leaderboard site.web.api.espn.com/apis/site/v2/sports/golf/leaderboard?league={tour}&event={id}
//               -> the field, per-round strokes, hole-by-hole scores, tee times, status
// NOT YET VERIFIED LIVE: ESPN is blocked from the dev sandbox (same as nflprob). Every field is
// read through a getter that tries the known alternative paths, and /api/health reports which
// paths actually resolved on the real deployment so the parser can be tightened against it.

const { fetchJson, TTL } = require('./http');

const TOURS = { pga: 'PGA Tour', liv: 'LIV Golf', eur: 'DP World Tour', ntw: 'Korn Ferry Tour' };

const num = v => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));
const first = (...vals) => vals.find(v => v !== undefined && v !== null && v !== '');

function idFromRef(ref) {
  const m = String(ref || '').match(/events\/(\d+)/);
  return m ? m[1] : null;
}

async function fetchCalendar(tour, season) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/golf/${tour}/scoreboard?dates=${season}`;
  const data = await fetchJson(url, { ttlMs: TTL.long });
  const cal = data?.leagues?.[0]?.calendar || [];
  return cal.map(c => ({
    tour,
    id: String(first(c.id, idFromRef(c.event?.$ref), idFromRef(c.$ref)) || ''),
    name: first(c.label, c.name, c.shortName) || 'Event',
    startDate: c.startDate || null,
    endDate: c.endDate || null,
  })).filter(c => c.id);
}

// Upcoming/current event when no id is given: ESPN's own "current" leaderboard.
async function fetchLeaderboard(tour, eventId, { live = false } = {}) {
  const url = `https://site.web.api.espn.com/apis/site/v2/sports/golf/leaderboard?league=${tour}${eventId ? `&event=${eventId}` : ''}`;
  const data = await fetchJson(url, { ttlMs: live ? TTL.live : TTL.short });
  return parseLeaderboard(data, tour);
}

function parseStatus(c) {
  const t = c.status?.type || {};
  const raw = `${t.name || ''} ${t.shortDetail || ''} ${t.description || ''} ${c.status?.displayValue || ''}`.toUpperCase();
  if (/WITHDR|\bWD\b/.test(raw)) return 'WD';
  if (/DISQ|\bDQ\b/.test(raw)) return 'DQ';
  if (/\bMDF\b/.test(raw)) return 'MDF';
  if (/CUT/.test(raw)) return 'CUT';
  return 'ACTIVE';
}

function parseHoles(ls) {
  const holes = (ls?.linescores || [])
    .map(h => ({ hole: num(h.period), strokes: num(h.value) }))
    .filter(h => h.hole && h.strokes && h.strokes > 0)
    .sort((a, b) => a.hole - b.hole);
  return holes;
}

function parseRounds(c, eventState, currentRound) {
  const rounds = [];
  for (const ls of c.linescores || []) {
    const round = num(ls.period);
    if (!round) continue;
    const holes = parseHoles(ls);
    const v = num(ls.value);
    const holeSum = holes.reduce((s, h) => s + h.strokes, 0);
    let strokes = v && v > 50 ? v : (holes.length === 18 ? holeSum : null);
    const complete = holes.length === 18 || (strokes !== null && (eventState === 'post' || round < currentRound));
    if (!complete) strokes = null;
    rounds.push({
      round,
      strokes,
      complete,
      thruHoles: holes.length,
      partialStrokes: holes.length && !complete ? holeSum : null,
      holes,
      teeTime: ls.teeTime || null,
      startHole: num(ls.startHole),
    });
  }
  return rounds.sort((a, b) => a.round - b.round);
}

function parseLeaderboard(data, tour) {
  const e = data?.events?.[0] || data?.event || null;
  if (!e) return null;
  const comp = e.competitions?.[0] || {};
  const state = first(e.status?.type?.state, comp.status?.type?.state) || 'pre';
  const currentRound = num(first(comp.status?.period, e.status?.period)) || (state === 'pre' ? 1 : null);
  const course = e.courses?.[0] || comp.venue || {};
  const addr = course.address || {};
  const t = e.tournament || {};

  const holePars = (course.holes || []).map(h => ({ hole: num(h.number), par: num(h.shotsToPar), yards: num(h.totalYards) })).filter(h => h.hole);

  const players = (comp.competitors || []).map(c => {
    const a = c.athlete || {};
    const rounds = parseRounds(c, state, currentRound || 1);
    return {
      id: String(first(c.id, a.id) || ''),
      name: first(a.displayName, a.fullName, `${a.firstName || ''} ${a.lastName || ''}`.trim()) || 'Unknown',
      country: a.flag?.alt || a.citizenship || null,
      flag: a.flag?.href || null,
      amateur: !!a.amateur,
      status: parseStatus(c),
      position: first(c.status?.position?.displayName, c.position?.displayName) || null,
      toPar: first(c.score?.displayValue, typeof c.score === 'string' ? c.score : null) || null,
      teeTime: c.status?.teeTime || null,
      startHole: num(c.status?.startHole),
      thru: num(c.status?.thru),
      round: num(c.status?.period),
      rounds,
    };
  }).filter(p => p.id);

  return {
    tour,
    tourName: TOURS[tour] || tour.toUpperCase(),
    id: String(e.id),
    name: first(e.name, e.shortName) || 'Event',
    startDate: e.date || null,
    endDate: e.endDate || null,
    state, // pre | in | post
    statusDetail: first(e.status?.type?.detail, comp.status?.type?.detail, e.status?.type?.shortDetail) || null,
    currentRound,
    numberOfRounds: num(first(t.numberOfRounds, e.numberOfRounds)) || (tour === 'liv' ? 3 : 4),
    cut: num(t.cutCount) ? { count: num(t.cutCount), round: num(t.cutRound) || 2, score: t.cutScore ?? null } : null,
    course: {
      name: first(course.name, course.fullName) || null,
      par: num(first(course.shotsToPar, course.par)) || (holePars.length === 18 ? holePars.reduce((s, h) => s + (h.par || 0), 0) : 72),
      yards: num(course.totalYards),
      city: addr.city || null,
      state: addr.state || null,
      country: addr.country || null,
      holes: holePars,
    },
    players,
  };
}

// Which paths resolved — /api/health uses this to confirm the parser against the live shape.
function shapeReport(raw) {
  const e = raw?.events?.[0];
  const c = e?.competitions?.[0]?.competitors?.[0];
  return {
    hasEvent: !!e,
    eventKeys: e ? Object.keys(e) : [],
    competitionStatusPeriod: e?.competitions?.[0]?.status?.period ?? null,
    courseKeys: e?.courses?.[0] ? Object.keys(e.courses[0]) : [],
    tournamentKeys: e?.tournament ? Object.keys(e.tournament) : [],
    competitorCount: e?.competitions?.[0]?.competitors?.length || 0,
    competitorKeys: c ? Object.keys(c) : [],
    statusKeys: c?.status ? Object.keys(c.status) : [],
    teeTime: c?.status?.teeTime ?? null,
    linescoreSample: c?.linescores?.[0] ? { keys: Object.keys(c.linescores[0]), holes: c.linescores[0].linescores?.length || 0 } : null,
  };
}

module.exports = { TOURS, fetchCalendar, fetchLeaderboard, parseLeaderboard, shapeReport };
