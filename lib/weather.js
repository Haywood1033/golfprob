// lib/weather.js — course weather for the tournament days (Open-Meteo, free, no key).
//   forecast  api.open-meteo.com/v1/forecast          hourly wind/gust/direction/rain/temp
//   ensemble  ensemble-api.open-meteo.com/v1/ensemble  GFS 31-member wind + rain, for confidence
//   archive   archive-api.open-meteo.com/v1/archive    completed events (backtests, past weeks)
//
// The scoring model is a heuristic v0, stated openly in the write-up: wind cost grows with the
// square of sustained speed (drag does), gusts above 25 mph add on top, and heavy rain adds a
// little. A player's cost is the average over the ~5 hours after their tee time. Only the
// DIFFERENCE between tee windows matters for finishing odds — a windy day for everyone moves
// nobody. Calibrate the coefficients against stored wave splits once enough history exists.

const { fetchJson, TTL } = require('./http');

const CARDS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const cardinal = deg => (deg === null || deg === undefined ? '—' : CARDS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16]);

const ROUND_HOURS = 5;         // threesome pace; twosomes on the weekend are ~4.25
const SLOT_START = 5, SLOT_END = 17, SLOT = 0.25;

function hourCost(wind, gust, precip) {
  const w = Math.max(0, wind || 0);
  return 0.0055 * w * w + 0.03 * Math.max(0, (gust || 0) - 25) + 1.2 * Math.min(Math.max(0, precip || 0), 0.3);
}

function conditionLabel(code) {
  if (code === null || code === undefined) return { label: '—', icon: 'unknown' };
  if (code === 0) return { label: 'Clear', icon: 'clear' };
  if (code <= 2) return { label: 'Partly cloudy', icon: 'partly' };
  if (code === 3) return { label: 'Overcast', icon: 'cloudy' };
  if (code <= 48) return { label: 'Fog', icon: 'fog' };
  if (code <= 57) return { label: 'Drizzle', icon: 'drizzle' };
  if (code <= 67) return { label: code >= 65 ? 'Heavy rain' : 'Rain', icon: 'rain' };
  if (code <= 77) return { label: 'Snow', icon: 'snow' };
  if (code <= 82) return { label: 'Showers', icon: 'rain' };
  if (code <= 86) return { label: 'Snow showers', icon: 'snow' };
  return { label: 'Thunderstorms', icon: 'storm' };
}

const HOURLY = 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation_probability,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m';
const DAILY = 'sunrise,sunset,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,weather_code';
const UNITS = 'wind_speed_unit=mph&temperature_unit=fahrenheit&precipitation_unit=inch&timezone=auto';

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function fetchDeterministic(lat, lon, start, end) {
  const today = new Date().toISOString().slice(0, 10);
  const daysAgo = (new Date(today) - new Date(end)) / 86400000;
  if (daysAgo > 60) {
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${start}&end_date=${end}&hourly=${HOURLY.replace('precipitation_probability,', '')}&daily=${DAILY.replace('precipitation_probability_max,', '')}&${UNITS}`;
    return { data: await fetchJson(url, { ttlMs: TTL.long }), source: 'archive' };
  }
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&start_date=${start}&end_date=${end}&hourly=${HOURLY}&daily=${DAILY}&${UNITS}`;
  return { data: await fetchJson(url, { ttlMs: TTL.short }), source: daysAgo > 0 ? 'recent' : 'forecast' };
}

async function fetchEnsemble(lat, lon, start, end) {
  const url = `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${lat}&longitude=${lon}&start_date=${start}&end_date=${end}&hourly=wind_speed_10m,wind_gusts_10m,precipitation&models=gfs025&${UNITS}`;
  return fetchJson(url, { ttlMs: TTL.short });
}

// Collect every member series for one variable: the control run plus *_memberNN keys.
function memberSeries(hourly, variable) {
  return Object.keys(hourly || {})
    .filter(k => k === variable || k.startsWith(`${variable}_member`))
    .sort()
    .map(k => hourly[k]);
}

function vectorMeanDir(rows) {
  let x = 0, y = 0;
  for (const r of rows) {
    if (r.dir === null || r.wind === null) continue;
    const rad = (r.dir * Math.PI) / 180;
    x += Math.sin(rad) * r.wind; y += Math.cos(rad) * r.wind;
  }
  if (!x && !y) return null;
  return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
}

function windowRows(hours, from, to) {
  return hours.filter(h => h.hour + 1 > from && h.hour < to);
}

function windowStats(hours, from, to) {
  const rows = windowRows(hours, from, to);
  if (!rows.length) return null;
  const avg = k => rows.reduce((s, r) => s + (r[k] || 0), 0) / rows.length;
  const max = k => Math.max(...rows.map(r => r[k] || 0));
  const dir = vectorMeanDir(rows);
  return {
    from, to,
    wind: avg('wind'), gustMax: max('gust'), windMax: max('wind'),
    dir, dirLabel: cardinal(dir),
    rainProbMax: Math.max(...rows.map(r => r.precipProb ?? 0)),
    precip: rows.reduce((s, r) => s + (r.precip || 0), 0),
    tempLo: Math.min(...rows.map(r => r.temp)), tempHi: Math.max(...rows.map(r => r.temp)),
    storm: rows.some(r => r.code >= 95),
  };
}

// lat/lon of the course, the event's first local date, number of rounds, and optional actual
// wave tee hours per round { 1: {am: 8.4, pm: 13.4}, ... } from the tee sheet.
async function getTournamentWeather({ lat, lon, startDate, rounds = 4, waveHours = {} }) {
  const start = startDate;
  const end = addDays(startDate, rounds - 1);
  const { data, source } = await fetchDeterministic(lat, lon, start, end);
  const H = data.hourly || {};
  const D = data.daily || {};
  const tzOffsetSec = data.utc_offset_seconds ?? 0;

  const days = [];
  for (let d = 0; d < rounds; d++) {
    const date = addDays(start, d);
    const hours = [];
    (H.time || []).forEach((t, i) => {
      if (!t.startsWith(date)) return;
      const hour = Number(t.slice(11, 13));
      const code = H.weather_code?.[i] ?? null;
      hours.push({
        hour, time: t,
        temp: H.temperature_2m?.[i] ?? null, feels: H.apparent_temperature?.[i] ?? null,
        humidity: H.relative_humidity_2m?.[i] ?? null,
        precipProb: H.precipitation_probability?.[i] ?? null, precip: H.precipitation?.[i] ?? 0,
        code, cond: conditionLabel(code).label, icon: conditionLabel(code).icon,
        cloud: H.cloud_cover?.[i] ?? null,
        wind: H.wind_speed_10m?.[i] ?? null, dir: H.wind_direction_10m?.[i] ?? null, dirLabel: cardinal(H.wind_direction_10m?.[i]),
        gust: H.wind_gusts_10m?.[i] ?? null,
        cost: hourCost(H.wind_speed_10m?.[i], H.wind_gusts_10m?.[i], H.precipitation?.[i]),
      });
    });
    const di = (D.time || []).indexOf(date);
    const code = D.weather_code?.[di] ?? null;
    days.push({
      round: d + 1, date, hours,
      sunrise: D.sunrise?.[di] || null, sunset: D.sunset?.[di] || null,
      tempMax: D.temperature_2m_max?.[di] ?? null, tempMin: D.temperature_2m_min?.[di] ?? null,
      rainProbMax: D.precipitation_probability_max?.[di] ?? null, precipSum: D.precipitation_sum?.[di] ?? null,
      windMax: D.wind_speed_10m_max?.[di] ?? null, gustMax: D.wind_gusts_10m_max?.[di] ?? null,
      dirDominant: D.wind_direction_10m_dominant?.[di] ?? null, dirLabel: cardinal(D.wind_direction_10m_dominant?.[di]),
      cond: conditionLabel(code).label, icon: conditionLabel(code).icon,
    });
  }

  // Ensemble: only meaningful for future days, and only when the API has them.
  let ens = null;
  if (source === 'forecast') {
    try {
      const e = await fetchEnsemble(lat, lon, start, end);
      const winds = memberSeries(e.hourly, 'wind_speed_10m');
      const gusts = memberSeries(e.hourly, 'wind_gusts_10m');
      const rains = memberSeries(e.hourly, 'precipitation');
      if (winds.length > 1) ens = { time: e.hourly.time, winds, gusts, rains };
    } catch { ens = null; }
  }

  // Per-member hourly cost by date -> tee-slot cost tables.
  const members = ens ? ens.winds.length : 1;
  const slotCount = Math.round((SLOT_END - SLOT_START) / SLOT) + 1;
  const tables = Array.from({ length: members }, () => new Map());
  for (const day of days) {
    for (let m = 0; m < members; m++) {
      const hc = new Array(24).fill(null);
      if (ens) {
        ens.time.forEach((t, i) => {
          if (!t.startsWith(day.date)) return;
          const h = Number(t.slice(11, 13));
          const w = ens.winds[m]?.[i];
          // No member gusts? Scale the deterministic gust by this member's wind ratio.
          const det = day.hours.find(x => x.hour === h);
          const g = ens.gusts[m]?.[i] ?? (det && det.wind ? (det.gust || 0) * (w / det.wind) : det?.gust);
          hc[h] = hourCost(w, g, ens.rains[m]?.[i] ?? det?.precip);
        });
      } else {
        for (const x of day.hours) hc[x.hour] = x.cost;
      }
      const slots = new Float64Array(slotCount);
      for (let s = 0; s < slotCount; s++) {
        const tee = SLOT_START + s * SLOT;
        let sum = 0, n = 0;
        for (let t = tee; t < tee + ROUND_HOURS; t += 0.25) {
          const h = Math.floor(t);
          if (hc[h] !== null && hc[h] !== undefined) { sum += hc[h]; n++; }
        }
        slots[s] = n ? sum / n : 0;
      }
      tables[m].set(day.date, slots);
    }
  }

  function cost(m, date, teeHour) {
    const slots = tables[m]?.get(date);
    if (!slots || teeHour === null || teeHour === undefined) return 0;
    const s = Math.max(0, Math.min(slotCount - 1, (teeHour - SLOT_START) / SLOT));
    const lo = Math.floor(s), hi = Math.min(slotCount - 1, lo + 1), f = s - lo;
    return slots[lo] * (1 - f) + slots[hi] * f;
  }

  // Ensemble spread per hour (10th-90th percentile sustained wind) for the chart's band.
  if (ens) {
    for (const day of days) {
      for (const h of day.hours) {
        const i = ens.time.indexOf(h.time);
        if (i < 0) continue;
        const vals = ens.winds.map(series => series[i]).filter(v => v !== null && v !== undefined).sort((a, b) => a - b);
        if (vals.length < 5) continue;
        h.windP10 = vals[Math.floor(vals.length * 0.1)];
        h.windP90 = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.9))];
      }
    }
  }

  const wx = {
    lat, lon, tzOffsetSec, timezone: data.timezone || null, source, members,
    ensemble: !!ens, generatedAt: new Date().toISOString(),
    days, cost,
  };
  return Object.assign(wx, analyzeWaves(wx));
}

// Wave comparison for each round, using actual wave tee hours from the tee sheet when known
// ({ 1: {am, pm}, 2: {am, pm} }) and typical 8:30 / 1:30 tee times otherwise.
function analyzeWaves(wx, waveHours = {}) {
  const { days, cost, members } = wx;
  const waves = days.map(day => {
    const wh = waveHours[day.round] || {};
    const am = wh.am ?? 8.5, pm = wh.pm ?? 13.5;
    const amStats = windowStats(day.hours, am, am + ROUND_HOURS);
    const pmStats = windowStats(day.hours, pm, pm + ROUND_HOURS);
    const memberEdges = Array.from({ length: members }, (_, m) => cost(m, day.date, pm) - cost(m, day.date, am));
    return {
      round: day.round, date: day.date, amTee: am, pmTee: pm, fromSheet: !!waveHours[day.round],
      am: amStats ? { ...amStats, cost: cost(0, day.date, am) } : null,
      pm: pmStats ? { ...pmStats, cost: cost(0, day.date, pm) } : null,
      edge: memberEdges.reduce((a, b) => a + b, 0) / members, // + = AM wave plays easier
      memberEdges,
    };
  });

  // The draw: R1 AM + R2 PM ("AM/PM") vs R1 PM + R2 AM ("PM/AM"). Positive favors AM/PM.
  let draw = null;
  if (waves.length >= 2 && waves[0].am && waves[1].am && waves[0].pm && waves[1].pm) {
    const edges = waves[0].memberEdges.map((e1, m) => e1 - waves[1].memberEdges[m]);
    const mean = edges.reduce((a, b) => a + b, 0) / edges.length;
    const sorted = [...edges].sort((a, b) => a - b);
    const q = p => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    draw = {
      edge: mean,
      favored: Math.abs(mean) < 0.15 ? 'neutral' : mean > 0 ? 'AM/PM' : 'PM/AM',
      agreement: edges.length > 1 ? edges.filter(e => Math.sign(e) === Math.sign(mean)).length / edges.length : null,
      p10: q(0.1), p50: q(0.5), p90: q(0.9),
      members: edges.length,
    };
  }
  return { waves, draw };
}

module.exports = { getTournamentWeather, analyzeWaves, hourCost, cardinal, conditionLabel, windowStats, ROUND_HOURS };
