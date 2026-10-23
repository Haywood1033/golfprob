// api/_util.js — shared request helpers for the route handlers (Vercel ignores _-prefixed files
// as routes). Keeps every handler to: parse params, call lib/, send JSON.

function param(req, name, fallback = null) {
  const v = req.query?.[name];
  return v === undefined || v === '' ? fallback : Array.isArray(v) ? v[0] : v;
}

function numParam(req, name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(param(req, name, fallback));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function tourParam(req) {
  const t = String(param(req, 'tour', 'pga')).toLowerCase();
  return ['pga', 'liv', 'eur', 'ntw'].includes(t) ? t : 'pga';
}

function send(res, status, body, cacheSeconds = 0) {
  if (cacheSeconds) res.setHeader('Cache-Control', `s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 2}`);
  res.status(status).json(body);
}

function fail(res, err) {
  console.error(err);
  send(res, err.status || 500, { error: err.message || 'Unexpected error' });
}

module.exports = { param, numParam, tourParam, send, fail };
