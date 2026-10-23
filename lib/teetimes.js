// lib/teetimes.js — tee sheet handling: local tee hours, AM/PM wave split, the R1 -> R2 flip,
// and the playing groups that 2-balls and 3-balls are priced on.
//
// ESPN only exposes the tee time for a player's current/next round. On the PGA Tour the R1
// and R2 groups are the same players, and the waves flip (early R1 -> late R2, and the 1st/10th
// tee swap), so R2 is inferred from R1 and marked `inferred` until ESPN posts the real times.

function localHour(iso, tzOffsetSec) {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  if (isNaN(ms)) return null;
  const d = new Date(ms + tzOffsetSec * 1000);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}

function localDate(iso, tzOffsetSec) {
  const ms = new Date(iso).getTime();
  return new Date(ms + tzOffsetSec * 1000).toISOString().slice(0, 10);
}

function fmtHour(h) {
  if (h === null || h === undefined) return '—';
  const hh = Math.floor(h), mm = Math.round((h - hh) * 60);
  const H = ((hh + 11) % 12) + 1;
  return `${H}:${String(mm === 60 ? 0 : mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
}

// Split tee hours into waves at the largest gap between 9:30 and 14:30; a two-tee start
// always has one (the lunch break between waves). Fallback 11:45 if the sheet is one tee.
function waveSplit(hours) {
  const hs = [...new Set(hours.filter(h => h !== null))].sort((a, b) => a - b);
  let best = null;
  for (let i = 1; i < hs.length; i++) {
    const mid = (hs[i] + hs[i - 1]) / 2;
    if (mid < 9.5 || mid > 14.5) continue;
    const gap = hs[i] - hs[i - 1];
    if (!best || gap > best.gap) best = { gap, split: mid };
  }
  return best && best.gap >= 0.5 ? best.split : 11.75;
}

// players: [{id, teeTime, startHole}] for ONE round. Returns {date, split, byPlayer, groups}.
function buildRoundSheet(players, tzOffsetSec, { round, inferred = false } = {}) {
  const withTimes = players.filter(p => p.teeTime);
  if (!withTimes.length) return null;
  const hours = withTimes.map(p => localHour(p.teeTime, tzOffsetSec));
  const split = waveSplit(hours);
  const byPlayer = new Map();
  const groupMap = new Map();
  for (const p of withTimes) {
    const h = localHour(p.teeTime, tzOffsetSec);
    const wave = h < split ? 'AM' : 'PM';
    byPlayer.set(p.id, { teeTime: p.teeTime, hour: h, startHole: p.startHole || 1, wave, inferred });
    const key = `${p.teeTime}|${p.startHole || 1}`;
    if (!groupMap.has(key)) groupMap.set(key, { round, teeTime: p.teeTime, hour: h, startHole: p.startHole || 1, wave, inferred, ids: [] });
    groupMap.get(key).ids.push(p.id);
  }
  const groups = [...groupMap.values()].sort((a, b) => a.hour - b.hour || a.startHole - b.startHole);
  return { round, date: localDate(withTimes[0].teeTime, tzOffsetSec), split, byPlayer, groups, inferred };
}

// Infer R2 from R1: same groups, waves swapped. The offset is the gap between the first
// tee times of each wave, so an AM group goes out that much later and a PM group that much earlier.
function inferNextRound(sheet, round) {
  if (!sheet) return null;
  const am = sheet.groups.filter(g => g.wave === 'AM'), pm = sheet.groups.filter(g => g.wave === 'PM');
  if (!am.length || !pm.length) return null;
  const shiftMs = (new Date(pm[0].teeTime) - new Date(am[0].teeTime));
  const players = [];
  for (const g of sheet.groups) {
    const t = new Date(new Date(g.teeTime).getTime() + 86400000 + (g.wave === 'AM' ? shiftMs : -shiftMs)).toISOString();
    const startHole = g.startHole === 1 ? 10 : g.startHole === 10 ? 1 : g.startHole;
    for (const id of g.ids) players.push({ id, teeTime: t, startHole });
  }
  return players;
}

module.exports = { localHour, localDate, fmtHour, waveSplit, buildRoundSheet, inferNextRound };
