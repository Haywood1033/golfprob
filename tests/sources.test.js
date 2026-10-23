// Parsers and helpers: ESPN leaderboard shape, tee sheets, name matching, weather + write-up.
// The ESPN and Open-Meteo fixtures follow the documented/observed response shapes; /api/health
// confirms them against the live services after deploy.
const test = require('node:test');
const assert = require('node:assert');
const { parseLeaderboard } = require('../lib/espn');
const { roundsFromEvent } = require('../lib/store');
const { buildRoundSheet, inferNextRound, waveSplit } = require('../lib/teetimes');
const { buildMatcher } = require('../lib/names');
const { clearCache } = require('../lib/http');

const holes = (strokes) => strokes.map((v, i) => ({ period: i + 1, value: v }));

function leaderboardFixture(state = 'post') {
  return {
    events: [{
      id: '401999', name: 'Test Championship', date: '2026-10-22T04:00Z', endDate: '2026-10-25T04:00Z',
      status: { type: { state: state, detail: 'Final' } },
      tournament: { numberOfRounds: 4 },
      courses: [{ name: 'TPC Summerlin', shotsToPar: 71, totalYards: 7255, address: { city: 'Las Vegas', state: 'NV', country: 'USA' } }],
      competitions: [{
        status: { period: 4 },
        competitors: [
          { id: '1', athlete: { displayName: 'Ludvig Åberg', flag: { alt: 'Sweden' } }, status: { position: { displayName: '1' }, teeTime: '2026-10-22T15:10Z', startHole: 1, type: { name: 'STATUS_FINISH' } },
            linescores: [1, 2, 3, 4].map(r => ({ period: r, value: 67, linescores: holes([4, 3, 4, 4, 5, 3, 4, 4, 4, 4, 3, 4, 4, 5, 3, 4, 4, 1]) })) },
          { id: '2', athlete: { displayName: 'Cut Player' }, status: { position: { displayName: 'CUT' }, type: { name: 'STATUS_CUT' } },
            linescores: [{ period: 1, value: 75, linescores: [] }, { period: 2, value: 76, linescores: [] }] },
          { id: '3', athlete: { displayName: 'Withdrew Early' }, status: { type: { name: 'STATUS_WITHDRAWN' } }, linescores: [{ period: 1, value: 0, linescores: holes([5, 5, 6]) }] },
        ],
      }],
    }],
  };
}

test('ESPN leaderboard parse: rounds, holes, statuses, course', () => {
  const ev = parseLeaderboard(leaderboardFixture(), 'pga');
  assert.strictEqual(ev.name, 'Test Championship');
  assert.strictEqual(ev.course.par, 71);
  assert.strictEqual(ev.players.length, 3);
  const [a, c, w] = ev.players;
  assert.strictEqual(a.rounds.length, 4);
  assert.ok(a.rounds.every(r => r.complete && r.strokes === 67 && r.holes.length === 18));
  assert.strictEqual(c.status, 'CUT');
  assert.deepStrictEqual(c.rounds.map(r => r.strokes), [75, 76]);
  assert.strictEqual(w.status, 'WD');
  assert.strictEqual(w.rounds[0].complete, false);
  const rows = roundsFromEvent(ev);
  assert.strictEqual(rows.length, 6); // 4 + 2, the WD partial round is dropped
  assert.strictEqual(rows[0].date, '2026-10-22');
  assert.strictEqual(rows[3].date, '2026-10-25');
});

test('in-progress events contribute no history rows', () => {
  assert.strictEqual(roundsFromEvent(parseLeaderboard(leaderboardFixture('in'), 'pga')).length, 0);
});

test('tee sheet: wave split, groups, and the R2 flip', () => {
  const tz = -7 * 3600; // Las Vegas, PDT
  const mk = (h, m, hole, ids) => ids.map(id => ({ id, teeTime: new Date(Date.UTC(2026, 9, 22, h + 7, m)).toISOString(), startHole: hole }));
  const list = [
    ...mk(6, 40, 1, ['a', 'b', 'c']), ...mk(6, 40, 10, ['d', 'e', 'f']), ...mk(7, 30, 1, ['g', 'h', 'i']),
    ...mk(11, 50, 1, ['j', 'k', 'l']), ...mk(11, 50, 10, ['m', 'n', 'o']), ...mk(12, 40, 10, ['p', 'q', 'r']),
  ];
  const sheet = buildRoundSheet(list, tz, { round: 1 });
  assert.strictEqual(sheet.groups.length, 6);
  assert.ok(sheet.split > 7.5 && sheet.split < 11.8, `split ${sheet.split}`);
  assert.strictEqual(sheet.byPlayer.get('a').wave, 'AM');
  assert.strictEqual(sheet.byPlayer.get('p').wave, 'PM');
  const r2 = buildRoundSheet(inferNextRound(sheet, 2), tz, { round: 2, inferred: true });
  assert.strictEqual(r2.byPlayer.get('a').wave, 'PM');
  assert.strictEqual(r2.byPlayer.get('a').startHole, 10);
  assert.strictEqual(r2.byPlayer.get('p').wave, 'AM');
  assert.strictEqual(r2.date, '2026-10-23');
  assert.strictEqual(waveSplit([8]), 11.75);
});

test('name matching: accents, Last-First, initials, suffix fallback', () => {
  const field = [{ id: 1, name: 'Ludvig Åberg' }, { id: 2, name: 'Scottie Scheffler' }, { id: 3, name: 'Davis Love III' }, { id: 4, name: 'Nicolai Højgaard' }, { id: 5, name: 'Rasmus Højgaard' }];
  const m = buildMatcher(field);
  assert.strictEqual(m('Ludvig Aberg').id, 1);
  assert.strictEqual(m('Scheffler, Scottie').id, 2);
  assert.strictEqual(m('S. Scheffler').id, 2);
  assert.strictEqual(m('Davis Love').id, 3);
  assert.strictEqual(m('N. Hojgaard').id, 4);
  assert.strictEqual(m('Hojgaard'), null); // ambiguous twins never guessed
  assert.strictEqual(m('Tiger Woods'), null);
});

function meteoFixture(start, days, windAt) {
  const time = [], wind = [], dir = [], gust = [], z = [];
  for (let d = 0; d < days; d++) {
    const date = new Date(Date.parse(start) + d * 86400000).toISOString().slice(0, 10);
    for (let h = 0; h < 24; h++) { time.push(`${date}T${String(h).padStart(2, '0')}:00`); const w = windAt(d, h); wind.push(w); gust.push(w * 1.5); dir.push(d === 0 && h >= 12 ? 270 : 180); z.push(0); }
  }
  const dates = Array.from({ length: days }, (_, d) => new Date(Date.parse(start) + d * 86400000).toISOString().slice(0, 10));
  return {
    utc_offset_seconds: -25200, timezone: 'America/Los_Angeles',
    hourly: { time, wind_speed_10m: wind, wind_direction_10m: dir, wind_gusts_10m: gust, temperature_2m: time.map(() => 70), apparent_temperature: time.map(() => 70), relative_humidity_2m: z, precipitation_probability: z, precipitation: z, weather_code: z, cloud_cover: z },
    daily: { time: dates, sunrise: dates.map(d => `${d}T06:50`), sunset: dates.map(d => `${d}T17:50`), temperature_2m_max: dates.map(() => 78), temperature_2m_min: dates.map(() => 58), weather_code: dates.map(() => 1), wind_speed_10m_max: dates.map(() => 20), wind_gusts_10m_max: dates.map(() => 30), wind_direction_10m_dominant: dates.map(() => 200), precipitation_probability_max: dates.map(() => 0), precipitation_sum: dates.map(() => 0) },
  };
}

test('weather: Thursday afternoon wind -> AM/PM draw favored, write-up says so', async () => {
  clearCache();
  const start = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const windAt = (d, h) => (d === 0 && h >= 12 ? 22 : 6);
  const realFetch = global.fetch;
  global.fetch = async url => ({
    ok: true, status: 200,
    json: async () => (String(url).includes('ensemble') ? (() => {
      const det = meteoFixture(start, 4, windAt);
      const hourly = { time: det.hourly.time, wind_speed_10m: det.hourly.wind_speed_10m };
      // Nine members agree with the deterministic run; member 10 has the wind in the morning.
      const flipped = meteoFixture(start, 4, (d, h) => (d === 0 && h < 12 ? 22 : 6)).hourly.wind_speed_10m;
      for (let m = 1; m <= 10; m++) hourly[`wind_speed_10m_member${String(m).padStart(2, '0')}`] = m === 10 ? flipped : det.hourly.wind_speed_10m;
      return { hourly };
    })() : meteoFixture(start, 4, windAt)),
  });
  try {
    const { getTournamentWeather } = require('../lib/weather');
    const { buildWriteup } = require('../lib/weather-writeup');
    const wx = await getTournamentWeather({ lat: 36.19, lon: -115.3, startDate: start, rounds: 4 });
    assert.strictEqual(wx.members, 11);
    assert.ok(wx.waves[0].edge > 1, `R1 wave edge ${wx.waves[0].edge}`);
    assert.strictEqual(wx.draw.favored, 'AM/PM');
    assert.ok(wx.draw.agreement > 0.85 && wx.draw.agreement < 1, `agreement ${wx.draw.agreement}`);
    assert.ok(wx.days[0].hours[14].windP90 >= wx.days[0].hours[14].windP10);
    const w = buildWriteup(wx, { eventName: 'Test', daysUntilStart: 2 });
    assert.match(w.headline, /AM\/PM draw favored/);
    const text = w.sections.flatMap(s => s.paragraphs).join(' ');
    assert.match(text, /builds from 6 mph/);
    assert.match(text, /veers from S/);
  } finally { global.fetch = realFetch; }
});

// The live leaderboard shape confirmed by /api/health on 2026-10-23: no hole-by-hole detail,
// competition period lagging the players' own period, nine totals on completed rounds.
function liveShapeFixture() {
  const holes = [4, 5, 3, 4, 4, 4, 5, 3, 4, 4, 4, 4, 3, 4, 4, 3, 5, 4].map((par, i) => ({ number: i + 1, shotsToPar: par }));
  const comp = (id, period, thru, startHole, rounds) => ({
    id, athlete: { displayName: `P${id}` }, score: { displayValue: '-2' },
    status: { period, thru, startHole, teeTime: '2026-10-23T11:30Z', type: { name: 'STATUS_IN_PROGRESS' }, position: { displayName: 'T5' } },
    linescores: rounds,
  });
  return {
    events: [{
      id: '401850917', name: 'Butterfield Bermuda Championship', date: '2026-10-22T04:00Z', endDate: '2026-10-25T04:00Z',
      status: { type: { state: 'in' } }, tournament: { numberOfRounds: 4, cutRound: 2, cutCount: 65 },
      courses: [{ name: 'Port Royal Golf Course', shotsToPar: 71, holes, address: { city: 'Southampton Parish', country: 'Bermuda' } }],
      competitions: [{ status: { period: 1 }, competitors: [
        // Finished R1 (69), R2 not started.
        comp('1', 2, 0, 1, [{ period: 1, value: 69, displayValue: '-2', outScore: 35, inScore: 34, teeTime: '2026-10-22T16:00Z' }, { period: 2, value: 0, displayValue: '-', teeTime: '2026-10-23T11:30Z' }]),
        // R1 72, R2 in progress: started on 10, thru 9, -2 today.
        comp('2', 2, 9, 10, [{ period: 1, value: 72, displayValue: '+1' }, { period: 2, value: 32, displayValue: '-2' }]),
        // Finished R1 known only by to-par.
        comp('3', 2, 0, 1, [{ period: 1, displayValue: 'E' }]),
      ] }],
    }],
  };
}

test('live ESPN shape: rounds finished by player period, partial round from hole pars', () => {
  const ev = parseLeaderboard(liveShapeFixture(), 'pga');
  assert.strictEqual(ev.currentRound, 2, 'event round follows the players, not the lagging competition period');
  assert.strictEqual(ev.cut.count, 65);
  const [a, b, c] = ev.players;
  assert.deepStrictEqual([a.rounds[0].complete, a.rounds[0].strokes], [true, 69]);
  assert.strictEqual(a.rounds[1].complete, false);
  assert.strictEqual(a.rounds[1].partialStrokes, null);
  // Back nine par: 4+4+4+3+4+4+3+5+4 = 35, so thru 9 at -2 is 33 strokes; front nine par 36 left.
  assert.deepStrictEqual([b.rounds[0].strokes, b.rounds[1].partialStrokes, b.rounds[1].thruHoles, b.rounds[1].remainingPar], [72, 33, 9, 36]);
  assert.deepStrictEqual(b.rounds[1].playedHoles, [10, 11, 12, 13, 14, 15, 16, 17, 18]);
  assert.deepStrictEqual([c.rounds[0].complete, c.rounds[0].strokes], [true, 71]);
});

test('simulator projects only the remaining holes of a partial round', () => {
  const { simulate } = require('../lib/simulator');
  const ev = parseLeaderboard(liveShapeFixture(), 'pga');
  const players = ev.players.map(p => ({ ...p, rating: { sg: 0, sd: 2.8, se: 0 } }));
  const sim = simulate({ players, par: 71, courseOffset: 0, numberOfRounds: 4, cut: null, sims: 4000, seed: 1 });
  const S = sim.sims, r2 = sim.roundScores[1], i = sim.index.get('2');
  let sum = 0, sq = 0;
  for (let s = 0; s < S; s++) { const v = r2[s + i * S]; sum += v; sq += v * v; }
  const mean = sum / S, sd = Math.sqrt(sq / S - mean * mean);
  assert.ok(Math.abs(mean - 69) < 0.3, `33 thru 9 + front-nine par 36 ≈ 69, got ${mean.toFixed(2)}`);
  assert.ok(sd < 2.6, `half a round of noise, got sd ${sd.toFixed(2)}`);
});

test('R1 start hole inferred from R2 so same-time groups on 1 and 10 stay apart', async () => {
  const { clearCache } = require('../lib/http');
  clearCache();
  const fx = liveShapeFixture();
  const comps = fx.events[0].competitions[0].competitors;
  comps.length = 0;
  // Two R1 groups at 12:00 local (16:00Z), one off each tee; R2 tees posted with flipped holes.
  for (let i = 0; i < 6; i++) comps.push({ id: `g${i}`, athlete: { displayName: `G${i}` }, status: { period: 2, thru: 0, startHole: i < 3 ? 10 : 1, teeTime: '2026-10-23T11:30Z', type: { name: 'X' } },
    linescores: [{ period: 1, value: 70, teeTime: '2026-10-22T16:00Z' }, { period: 2, value: 0 }] });
  for (let i = 0; i < 30; i++) comps.push({ id: `f${i}`, athlete: { displayName: `F${i}` }, status: { period: 2, thru: 0, startHole: 1, teeTime: new Date(Date.UTC(2026, 9, 23, 11 + Math.floor(i / 3), 0)).toISOString(), type: { name: 'X' } },
    linescores: [{ period: 1, value: 71, teeTime: new Date(Date.UTC(2026, 9, 22, 11 + Math.floor(i / 3), 0)).toISOString() }, { period: 2, value: 0 }] });
  const real = global.fetch;
  global.fetch = async u => ({ ok: true, status: 200, json: async () => (String(u).includes('leaderboard') ? fx : { results: [] }) });
  try {
    const { loadEventContext } = require('../lib/tournament');
    const ctx = await loadEventContext({ tour: 'pga', eventId: '401850917', lat: 32.26, lon: -64.86 });
    const g = ctx.sheets[1].groups.filter(x => x.ids.some(id => id.startsWith('g')));
    assert.deepStrictEqual(g.map(x => [x.startHole, x.ids.length]).sort(), [[1, 3], [10, 3]]);
  } finally { global.fetch = real; }
});

test('team events never become rating history', () => {
  const { isTeamEvent } = require('../lib/store');
  const fx = leaderboardFixture();
  fx.events[0].name = 'Zurich Classic of New Orleans';
  const ev = parseLeaderboard(fx, 'pga');
  assert.ok(isTeamEvent(ev));
  assert.strictEqual(roundsFromEvent(ev).length, 0);
  // Unnamed (team) competitors flag it even without a known event name.
  const fx2 = leaderboardFixture();
  fx2.events[0].competitions[0].competitors.forEach(c => { delete c.athlete; c.team = { displayName: 'A/B' }; });
  assert.ok(isTeamEvent(parseLeaderboard(fx2, 'pga')));
});
