// lib/weather-writeup.js — turns the weather numbers into the written briefing on the Weather
// tab. Every sentence is generated from the same figures the charts show, so the prose can't
// drift from the data; thresholds below decide which sentences appear.

const { fmtHour } = require('./teetimes');

const r1 = v => (v === null || v === undefined ? '—' : Math.round(v));
const s1 = v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1);
const DOW = date => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });

function windWord(mph) {
  if (mph < 6) return 'calm';
  if (mph < 10) return 'light';
  if (mph < 15) return 'moderate';
  if (mph < 20) return 'breezy';
  if (mph < 25) return 'windy';
  return 'very windy';
}

function angleDiff(a, b) {
  return ((b - a + 540) % 360) - 180; // signed, -180..180; + = clockwise (veering)
}

// Playable daylight: sunrise to sunset when known, else 7 AM–7 PM.
function playHours(day) {
  const hr = iso => (iso ? Number(String(iso).slice(11, 13)) : null);
  const from = hr(day.sunrise) ?? 7, to = hr(day.sunset) ?? 19;
  return day.hours.filter(h => h.hour >= from && h.hour <= to);
}

const article = w => (/^[AEIOU]/.test(w) ? 'an' : 'a');

function dayParagraph(day, wave) {
  const play = playHours(day);
  if (!play.length) return `${DOW(day.date)}: no hourly data yet for this date.`;
  const morning = play.filter(h => h.hour < 12), afternoon = play.filter(h => h.hour >= 12);
  const avg = (rows, k) => rows.reduce((s, r) => s + (r[k] || 0), 0) / (rows.length || 1);
  const peak = play.reduce((a, b) => ((b.gust || 0) > (a.gust || 0) ? b : a));
  const amW = avg(morning, 'wind'), pmW = avg(afternoon, 'wind');
  const parts = [];
  parts.push(`${DOW(day.date)} (R${day.round}) — ${day.cond.toLowerCase()}, ${r1(day.tempMin)}–${r1(day.tempMax)}°F.`);
  if (Math.abs(pmW - amW) >= 3) {
    parts.push(`Wind ${pmW > amW ? 'builds' : 'eases'} from ${r1(amW)} mph in the morning to ${r1(pmW)} mph in the afternoon, out of the ${day.dirLabel}.`);
  } else {
    parts.push(`A ${windWord((amW + pmW) / 2)} ${r1((amW + pmW) / 2)} mph most of the day, out of the ${day.dirLabel}.`);
  }
  if ((peak.gust || 0) >= 20) parts.push(`Gusts peak near ${r1(peak.gust)} mph around ${fmtHour(peak.hour)}.`);
  const mDir = morning.length ? morning[Math.floor(morning.length / 2)].dir : null;
  const aDir = afternoon.length ? afternoon[Math.floor(afternoon.length / 2)].dir : null;
  if (mDir !== null && aDir !== null && Math.abs(angleDiff(mDir, aDir)) >= 45 && Math.max(amW, pmW) >= 8) {
    const d = angleDiff(mDir, aDir);
    parts.push(`The wind ${d > 0 ? 'veers' : 'backs'} from ${morning[0].dirLabel} to ${afternoon[afternoon.length - 1].dirLabel} through the day, so holes will play differently for the two waves even at similar speeds.`);
  }
  const wet = play.filter(h => (h.precipProb ?? 0) >= 40);
  if (wet.length) {
    parts.push(`Rain risk ${wet.length > 6 ? 'most of the day' : `${fmtHour(wet[0].hour)}–${fmtHour(wet[wet.length - 1].hour + 1)}`} (up to ${r1(Math.max(...wet.map(h => h.precipProb)))}%).`);
  }
  if (play.some(h => h.code >= 95)) parts.push('Thunderstorms are in the forecast — a weather suspension is possible, which can strand a wave mid-round and reshuffle the draw.');
  if (wave?.am && wave?.pm) {
    const e = wave.edge;
    if (Math.abs(e) >= 0.25) parts.push(`Estimated wave gap: the ${e > 0 ? 'morning' : 'afternoon'} wave plays about ${Math.abs(e).toFixed(1)} strokes easier.`);
    else parts.push('No meaningful gap between the morning and afternoon waves.');
  }
  return parts.join(' ');
}

function buildWriteup(wx, { eventName, daysUntilStart = null, locationNote = null } = {}) {
  const sections = [];
  const d = wx.draw;
  const w1 = wx.waves[0], w2 = wx.waves[1];

  // Bottom line.
  let headline, bottom;
  if (!d) {
    headline = 'Not enough forecast data to compare the draws yet';
    bottom = 'Hourly forecasts for both of the first two rounds are needed to compare the tee-time draws.';
  } else if (d.favored === 'neutral') {
    headline = 'No draw bias — both waves face similar conditions';
    bottom = `Across Thursday and Friday the two halves of the draw come out within ${Math.abs(d.edge).toFixed(1)} strokes of each other. Weather shouldn't drive any pre-cut decisions this week; lean on skill and course fit.`;
  } else {
    headline = `${d.favored} draw favored by ~${Math.abs(d.edge).toFixed(1)} strokes`;
    const fav = d.favored === 'AM/PM' ? 'Thursday morning / Friday afternoon' : 'Thursday afternoon / Friday morning';
    bottom = `Players going out ${fav} get the better of the conditions by roughly ${Math.abs(d.edge).toFixed(1)} strokes over the first 36 holes.`;
    if (d.agreement !== null) bottom += ` ${Math.round(d.agreement * 100)}% of ${d.members} forecast ensemble members agree on the direction (middle 80% range ${s1(d.p10)} to ${s1(d.p90)} strokes).`;
    bottom += Math.abs(d.edge) >= 1 ? ' That is a large edge — big enough to matter for outrights, top-N, the cut line and DFS.' : ' A modest edge: a tiebreaker between similar plays, not a reason to bet a weaker player.';
  }
  sections.push({ title: 'Bottom line', paragraphs: [bottom] });

  // The draw in detail.
  if (w1?.am && w1?.pm && w2?.am && w2?.pm) {
    const p = [];
    for (const w of [w1, w2]) {
      p.push(`R${w.round} (${DOW(w.date)}): morning wave (${w.fromSheet ? 'median tee ' : 'typical tee '}${fmtHour(w.amTee)}) averages ${r1(w.am.wind)} mph from the ${w.am.dirLabel}, gusts to ${r1(w.am.gustMax)}; afternoon wave (${fmtHour(w.pmTee)}) averages ${r1(w.pm.wind)} mph from the ${w.pm.dirLabel}, gusts to ${r1(w.pm.gustMax)}. Gap ${s1(w.edge)} strokes (positive = morning easier).`);
    }
    if (!w1.fromSheet) p.push('Tee times aren’t posted yet, so these use typical wave times (8:30 AM and 1:30 PM). The numbers will sharpen once the tee sheet is out.');
    sections.push({ title: 'The draw: Thursday & Friday', paragraphs: p });
  }

  // Day by day.
  sections.push({ title: 'Day by day', paragraphs: wx.days.map((day, i) => dayParagraph(day, wx.waves[i])) });

  // Weekend.
  const weekend = wx.days.slice(2);
  if (weekend.length) {
    const windy = weekend.filter(day => (day.windMax || 0) >= 15);
    const p = [];
    if (windy.length) p.push(`${windy.map(day => DOW(day.date)).join(' and ')} ${windy.length > 1 ? 'look' : 'looks'} windy (peaks ${windy.map(day => r1(day.windMax)).join(' / ')} mph). Wind spreads out scores, so leaderboards get more volatile: good for longer-odds players already in contention, bad for a leader protecting a lead.`);
    else p.push('The weekend looks manageable, so scoring should stay compressed and the leaders hard to catch from far back.');
    p.push('On the weekend the leaders tee off last. When wind builds through the day, afternoon conditions land on the top of the leaderboard — the simulator models this by giving each simulated leaderboard a matching tee order.');
    sections.push({ title: 'Weekend', paragraphs: p });
  }

  // How to use it.
  const use = [];
  if (d && d.favored !== 'neutral') {
    use.push(`Outrights & top-N: the finishing odds already include the wave gap. When two players price similarly, take the one on the ${d.favored} side.`);
    use.push(`DFS: ${article(d.favored)} ${d.favored} stack is a real lineup-construction choice, since cash games care most about making the cut. Fade the other wave's thin cut-makers.`);
    use.push('Cut line: players near the projected cut who are on the tougher side are the riskiest make-cut bets. A missed cut on the tough side often comes down to the draw, not the player.');
  } else {
    use.push('Outrights, top-N & DFS: no adjustment for the draw this week.');
  }
  use.push('3-balls & R1/R2 2-balls: everyone in a group plays the same holes at the same time, so weather mostly cancels out. Price these on skill.');
  use.push('Tournament matchups (72-hole) between players in different waves are where the draw edge matters most.');
  sections.push({ title: 'How to use this', paragraphs: use });

  // Confidence & caveats.
  const caveat = [];
  if (daysUntilStart !== null && daysUntilStart > 3) caveat.push(`R1 is ${daysUntilStart} days out. Wind forecasts beyond about 3 days are rough, so treat the draw call as preliminary and recheck Wednesday.`);
  if (!wx.ensemble && wx.source === 'forecast') caveat.push('The ensemble forecast wasn’t available, so there is no agreement score. The edge is from a single deterministic run.');
  if (wx.source !== 'forecast') caveat.push(`These are ${wx.source === 'archive' ? 'archived observations' : 'recent model analyses'}, not a forecast.`);
  caveat.push('Strokes are estimated with a heuristic: cost grows with the square of sustained wind, plus extra for gusts above 25 mph and for heavy rain, averaged over each player’s ~5-hour round. It doesn’t yet account for hole orientation or how exposed the course is. Calibration against past wave splits comes once the database has a season of tee times.');
  if (locationNote) caveat.push(locationNote);
  sections.push({ title: 'Confidence & caveats', paragraphs: caveat });

  return { headline, eventName: eventName || null, sections };
}

module.exports = { buildWriteup };
