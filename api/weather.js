// GET /api/weather?tour=pga&event={espnId}
// Hourly course forecast for each round, AM/PM wave comparison, the draw verdict with ensemble
// agreement, and the generated written briefing.
const { loadEventContext, publicWeather } = require('../lib/tournament');
const { param, tourParam, send, fail } = require('./_util');

module.exports = async (req, res) => {
  try {
    const lat = param(req, 'lat'), lon = param(req, 'lon');
    const ctx = await loadEventContext({
      tour: tourParam(req), eventId: param(req, 'event'),
      lat: lat !== null ? Number(lat) : null, lon: lon !== null ? Number(lon) : null,
    });
    const sheetSummary = Object.values(ctx.sheets).map(s => ({
      round: s.round, inferred: !!s.inferred, groups: s.groups.length,
      am: s.groups.filter(g => g.wave === 'AM').length, pm: s.groups.filter(g => g.wave === 'PM').length,
    }));
    send(res, 200, {
      event: { id: ctx.ev.id, name: ctx.ev.name, state: ctx.ev.state, course: ctx.ev.course.name, city: ctx.ev.course.city, region: ctx.ev.course.state || ctx.ev.course.country, startDate: ctx.ev.startDate },
      teeSheets: sheetSummary,
      weather: publicWeather(ctx),
    }, 600);
  } catch (err) { fail(res, err); }
};
