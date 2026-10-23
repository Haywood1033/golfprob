// POST /api/parlay?tour=pga&event={id}
//   { legs: [{round, id, dec?}] }                      -> price one parlay
//   { auto: {round, size, count}, candidates?: [...] }  -> best parlays of `size` legs
// Priced inside the tournament simulation, so the joint probability is counted, not multiplied.
const { getSimContext } = require('../lib/tournament');
const { groupIndex, priceParlay, autoParlays } = require('../lib/parlay');
const { param, tourParam, send, fail } = require('./_util');

module.exports = async (req, res) => {
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { payload, sim } = await getSimContext({ tour: tourParam(req), eventId: param(req, 'event') });
    const idx = groupIndex(payload);
    res.setHeader('Cache-Control', 'no-store');
    if (body.auto) {
      const round = Number(body.auto.round) || payload.matchups[0]?.round;
      const candidates = (body.candidates && body.candidates.length ? body.candidates : [...idx.values()].filter(g => g.round === round).flatMap(g => g.ids.map(id => ({ round, id }))))
        .filter(c => Number(c.round) === round)
        .map(c => ({ round, id: String(c.id), dec: Number(c.dec) || null }));
      const unique = [...new Map(candidates.map(c => [c.id, c])).values()];
      return send(res, 200, autoParlays(sim, idx, unique, { size: Math.min(6, Math.max(2, Number(body.auto.size) || 3)), count: Math.min(10, Number(body.auto.count) || 5) }));
    }
    const legs = (body.legs || []).map(l => ({ round: Number(l.round), id: String(l.id), dec: Number(l.dec) || null }));
    const out = priceParlay(sim, legs, idx);
    send(res, out.error ? 400 : 200, out);
  } catch (err) { fail(res, err); }
};
