// lib/http.js — every fetcher goes through fetchJson: a timeout, one retry on network/5xx
// errors, and a small in-memory TTL cache keyed by URL. Plain async, no side effects beyond the
// cache, so any API route can call any fetcher without re-fetching within the same instance.

const cache = new Map(); // url -> { at, ttlMs, value }
const MAX_ENTRIES = 400;

const MIN = 60 * 1000;
const TTL = {
  live: 2 * MIN,      // leaderboards mid-round
  short: 10 * MIN,    // forecasts, fields, tee times
  long: 6 * 60 * MIN, // completed events, calendars, geocoding
};

async function fetchJson(url, { ttlMs = TTL.short, timeoutMs = 15000, retries = 1 } = {}) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < hit.ttlMs) return hit.value;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'accept': 'application/json' } });
      if (res.status >= 500) throw new Error(`HTTP ${res.status} from ${url}`);
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} from ${url}`);
        err.status = res.status;
        throw Object.assign(err, { noRetry: true });
      }
      const value = await res.json();
      if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
      cache.set(url, { at: Date.now(), ttlMs, value });
      return value;
    } catch (err) {
      lastErr = err;
      if (err.noRetry) break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

// Run async jobs with a concurrency cap — used for multi-event backfills so a sync never opens
// fifty sockets to ESPN at once.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function clearCache() { cache.clear(); }

module.exports = { fetchJson, mapLimit, clearCache, TTL };
