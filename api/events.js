// GET /api/events?tour=pga&season=2026 — the season calendar for the event picker.
const { fetchCalendar } = require('../lib/espn');
const { numParam, tourParam, send, fail } = require('./_util');

module.exports = async (req, res) => {
  try {
    const tour = tourParam(req);
    const season = numParam(req, 'season', new Date().getUTCFullYear(), { min: 2015, max: 2100 });
    const events = await fetchCalendar(tour, season);
    send(res, 200, { tour, season, events }, 3600);
  } catch (err) { fail(res, err); }
};
