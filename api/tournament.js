// GET /api/tournament?tour=pga&event={espnId}&sims=15000
// Field, model ratings, simulated finishing odds, and 2-ball/3-ball prices for one event.
const { buildTournament } = require('../lib/tournament');
const { param, numParam, tourParam, send, fail } = require('./_util');

module.exports = async (req, res) => {
  try {
    const lat = param(req, 'lat'), lon = param(req, 'lon');
    const payload = await buildTournament({
      tour: tourParam(req),
      eventId: param(req, 'event'),
      sims: numParam(req, 'sims', 15000, { min: 1000, max: 30000 }),
      lat: lat !== null ? Number(lat) : null,
      lon: lon !== null ? Number(lon) : null,
    });
    send(res, 200, payload, payload.event.state === 'in' ? 120 : 600);
  } catch (err) { fail(res, err); }
};
