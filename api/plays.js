// POST /api/plays?tour=pga&event={id}  body: { book: [{market, round, id, dec, raw}] }
// The Best plays tab: matchup targets, finishing-position targets and 3/4/5-leg finishing
// parlays, with reasons and section summaries. Book prices (optional) switch a section from
// model ranking to value ranking.
const { getSimContext } = require('../lib/tournament');
const { buildPlays } = require('../lib/plays');
const { param, tourParam, send, fail } = require('./_util');

module.exports = async (req, res) => {
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const book = (body.book || []).map(b => ({ market: String(b.market), round: b.round ? Number(b.round) : null, id: String(b.id), dec: Number(b.dec), raw: b.raw ? String(b.raw).slice(0, 12) : null }))
      .filter(b => b.dec > 1);
    const { payload, sim } = await getSimContext({ tour: tourParam(req), eventId: param(req, 'event') });
    res.setHeader('Cache-Control', 'no-store');
    send(res, 200, buildPlays(payload, sim, book));
  } catch (err) { fail(res, err); }
};
