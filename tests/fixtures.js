// Synthetic ESPN + Open-Meteo responses for end-to-end tests and layout screenshots. Shapes
// follow lib/espn.js / lib/weather.js; values are generated (fake players, fake scores), never
// presented as real data.
const { makeRng } = require('../lib/rng');

const FIRST = ['Alex', 'Ben', 'Cole', 'Dane', 'Eli', 'Finn', 'Gabe', 'Hank', 'Ivan', 'Jack', 'Kurt', 'Luke', 'Max', 'Nate', 'Owen', 'Paul', 'Quin', 'Reid', 'Sam', 'Theo'];
const LAST = ['Archer', 'Brooks', 'Carver', 'Dalton', 'Ellis', 'Foster', 'Garner', 'Hayes', 'Irwin', 'Jensen', 'Keller', 'Lowry', 'Mercer', 'Nolan', 'Ortega', 'Pruitt', 'Quade', 'Rhodes', 'Sutton', 'Tate'];

function makePlayers(n = 160, seed = 4) {
  const rng = makeRng(seed);
  return Array.from({ length: n }, (_, i) => ({
    id: String(1000 + i),
    name: `${FIRST[i % 20]} ${LAST[Math.floor(i / 20) % 20]}${i >= 400 ? ' Jr.' : ''}`,
    sg: 2.6 - (5 * i) / (n - 1) + rng.normal() * 0.2,
  }));
}

const COURSES = ['TPC Summerlin', 'Sea Island', 'Colonial', 'Harbour Town', 'Quail Hollow', 'TPC Scottsdale'];

function addDays(iso, n) { const d = new Date(iso); d.setUTCDate(d.getUTCDate() + n); return d.toISOString(); }

// A completed event leaderboard for history.
function pastEvent(id, start, players, rng, course) {
  const field = players.filter(() => rng.uniform() < 0.8).slice(0, 144);
  const totals = new Map();
  const diff = 70.5 + rng.normal();
  const comps = field.map(p => {
    const rounds = [1, 2].map(r => Math.round(diff + 0.5 - p.sg + rng.normal() * 2.7));
    totals.set(p.id, rounds[0] + rounds[1]);
    return { p, rounds };
  });
  const line = [...totals.values()].sort((a, b) => a - b)[64];
  for (const c of comps) {
    if (totals.get(c.p.id) <= line) c.rounds.push(...[3, 4].map(() => Math.round(diff + 0.5 - c.p.sg + rng.normal() * 2.7)));
  }
  const made = comps.filter(c => c.rounds.length === 4).sort((a, b) => a.rounds.reduce((x, y) => x + y) - b.rounds.reduce((x, y) => x + y));
  const pos = new Map();
  made.forEach((c, i) => {
    const t = c.rounds.reduce((x, y) => x + y);
    const first = made.findIndex(m => m.rounds.reduce((x, y) => x + y) === t);
    const tied = made.filter(m => m.rounds.reduce((x, y) => x + y) === t).length;
    pos.set(c.p.id, `${tied > 1 ? 'T' : ''}${first + 1}`);
  });
  return {
    events: [{
      id, name: `Past Event ${id}`, date: start, endDate: addDays(start, 3),
      status: { type: { state: 'post', detail: 'Final' } },
      courses: [{ name: course, shotsToPar: 71, address: { city: 'Las Vegas', state: 'Nevada', country: 'USA' } }],
      competitions: [{ status: { period: 4 }, competitors: comps.map(c => ({
        id: c.p.id, athlete: { displayName: c.p.name, flag: { alt: 'USA' } },
        status: { position: { displayName: pos.get(c.p.id) || 'CUT' }, type: { name: pos.has(c.p.id) ? 'STATUS_FINISH' : 'STATUS_CUT' } },
        linescores: c.rounds.map((v, r) => ({ period: r + 1, value: v, linescores: [] })),
      })) }],
    }],
  };
}

// The upcoming event: field with R1 tee times on a two-tee start, Pacific time.
function upcomingEvent(start, players) {
  const field = players.slice(0, 132);
  const comps = field.map((p, i) => {
    const g = Math.floor(i / 3);            // 44 groups
    const wave = g % 2;                      // alternate AM/PM so both waves have stars
    const slot = Math.floor(g / 4);          // 11 tee slots per wave per tee
    const hole = Math.floor(g / 2) % 2 === 0 ? 1 : 10;
    const local = (wave === 0 ? 6.75 : 11.75) + slot * (11 / 60);
    const utc = new Date(Date.parse(start.slice(0, 10)) + (local + 7) * 3600000);
    return { id: p.id, athlete: { displayName: p.name, flag: { alt: i % 4 ? 'USA' : 'England' } }, status: { teeTime: utc.toISOString(), startHole: hole, period: 1, type: { name: 'STATUS_SCHEDULED' } }, linescores: [] };
  });
  return {
    events: [{
      id: '401777', name: 'Sample Open (synthetic data)', date: start, endDate: addDays(start, 3),
      status: { type: { state: 'pre', detail: 'Thu, Round 1' } },
      courses: [{ name: 'TPC Summerlin', shotsToPar: 71, totalYards: 7255, address: { city: 'Las Vegas', state: 'Nevada', country: 'USA' } }],
      competitions: [{ status: { period: 1 }, competitors: comps }],
    }],
  };
}

function meteo(startDate, days, ensemble) {
  const time = [], wind = [], gust = [], dir = [], temp = [], code = [], pp = [], pr = [], cloud = [], hum = [];
  for (let d = 0; d < days; d++) {
    const date = new Date(Date.parse(startDate) + d * 86400000).toISOString().slice(0, 10);
    for (let h = 0; h < 24; h++) {
      time.push(`${date}T${String(h).padStart(2, '0')}:00`);
      const build = d === 0 ? Math.max(0, h - 10) * 2.4 : d === 3 ? Math.max(0, h - 9) * 1.6 : Math.max(0, h - 11) * 0.8;
      const w = Math.min(26, 5 + build);
      wind.push(+w.toFixed(1)); gust.push(+(w * 1.45 + 3).toFixed(1));
      dir.push(d === 0 ? (h < 12 ? 160 : 235) : 200 + d * 15);
      temp.push(+(58 + 18 * Math.sin(Math.max(0, h - 6) / 14 * Math.PI)).toFixed(0));
      const rainy = d === 2 && h >= 13 && h <= 17;
      code.push(rainy ? 61 : h > 15 && d === 0 ? 2 : 0); pp.push(rainy ? 55 : d === 2 ? 20 : 5); pr.push(rainy ? 0.06 : 0);
      cloud.push(rainy ? 90 : 20); hum.push(30);
    }
  }
  const dates = Array.from({ length: days }, (_, d) => new Date(Date.parse(startDate) + d * 86400000).toISOString().slice(0, 10));
  if (ensemble) {
    const hourly = { time, wind_speed_10m: wind };
    const rng = makeRng(17);
    for (let m = 1; m <= 30; m++) {
      const k = 0.8 + rng.uniform() * 0.45;
      hourly[`wind_speed_10m_member${String(m).padStart(2, '0')}`] = wind.map((w, i) => +(Math.max(0, w * k + (time[i].slice(11, 13) < '12' ? rng.normal() * 1.5 : rng.normal() * 2.5))).toFixed(1));
    }
    return { hourly };
  }
  const by = (arr, fn) => dates.map((d, i) => fn(arr.slice(i * 24, i * 24 + 24)));
  return {
    utc_offset_seconds: -25200, timezone: 'America/Los_Angeles',
    hourly: { time, wind_speed_10m: wind, wind_gusts_10m: gust, wind_direction_10m: dir, temperature_2m: temp, apparent_temperature: temp, relative_humidity_2m: hum, precipitation_probability: pp, precipitation: pr, weather_code: code, cloud_cover: cloud },
    daily: {
      time: dates, sunrise: dates.map(d => `${d}T06:52`), sunset: dates.map(d => `${d}T17:41`),
      temperature_2m_max: by(temp, a => Math.max(...a)), temperature_2m_min: by(temp, a => Math.min(...a)),
      weather_code: by(code, a => Math.max(...a)), wind_speed_10m_max: by(wind, a => Math.max(...a)), wind_gusts_10m_max: by(gust, a => Math.max(...a)),
      wind_direction_10m_dominant: dates.map((_, d) => 200 + d * 15), precipitation_probability_max: by(pp, a => Math.max(...a)), precipitation_sum: by(pr, a => a.reduce((x, y) => x + y, 0)),
    },
  };
}

// Install a fetch mock serving the whole synthetic world. Returns a restore function.
function installMockFetch({ start }) {
  const players = makePlayers();
  const rng = makeRng(99);
  const past = [];
  for (let k = 1; k <= 40; k++) {
    const s = new Date(Date.parse(start) - k * 7 * 86400000).toISOString();
    past.push({ id: String(500 + k), start: s, course: COURSES[k % COURSES.length] });
  }
  const boards = new Map(past.map(e => [e.id, pastEvent(e.id, e.start, players, rng, e.course)]));
  const upcoming = upcomingEvent(start, players);
  const real = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    let body;
    if (u.includes('/scoreboard')) {
      const year = Number((u.match(/dates=(\d{4})/) || [])[1]);
      const cal = past.filter(e => new Date(e.start).getUTCFullYear() === year).map(e => ({ id: e.id, label: `Past Event ${e.id}`, startDate: e.start, endDate: addDays(e.start, 3) }));
      if (new Date(start).getUTCFullYear() === year) cal.push({ id: '401777', label: 'Sample Open (synthetic data)', startDate: start, endDate: addDays(start, 3) });
      body = { leagues: [{ calendar: u.includes('/pga/') ? cal : [] }] };
    } else if (u.includes('/leaderboard')) {
      const id = (u.match(/event=(\d+)/) || [])[1];
      if (!u.includes('league=pga')) body = { events: [] };
      else body = !id || id === '401777' ? upcoming : boards.get(id) || { events: [] };
    } else if (u.includes('ensemble-api')) {
      body = meteo(start.slice(0, 10), 4, true);
    } else if (u.includes('open-meteo')) {
      body = meteo(start.slice(0, 10), 4, false);
    } else {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => body };
  };
  return () => { global.fetch = real; };
}

module.exports = { installMockFetch, makePlayers };
