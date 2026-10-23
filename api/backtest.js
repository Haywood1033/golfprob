// GET /api/backtest?tour=pga&events=8 — leak-free backtest of the most recent completed events.
const { runBacktest } = require('../lib/backtest');
const { numParam, tourParam, send, fail } = require('./_util');

module.exports = async (req, res) => {
  try {
    const out = await runBacktest({
      tour: tourParam(req),
      limit: numParam(req, 'events', 8, { min: 1, max: 30 }),
      sims: numParam(req, 'sims', 4000, { min: 1000, max: 10000 }),
    });
    send(res, 200, out, 3600);
  } catch (err) { fail(res, err); }
};
