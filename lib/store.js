// lib/store.js — historical round scores, the model's backbone (golf's "nflverse"). Built by
// walking ESPN's completed events: one row per player per completed round. With DATABASE_URL
// the rows persist in golf_rounds (backfilled by /api/sync); without it, the most recent events
// are fetched live into memory so the app still works, just with a shorter history.

const db = require('./db');
const { fetchCalendar, fetchLeaderboard } = require('./espn');
const { mapLimit } = require('./http');

const DEFAULT_TOURS = (process.env.TOURS || 'pga,liv,eur').split(',').map(s => s.trim()).filter(Boolean);
const MEMORY_EVENTS_PER_TOUR = { pga: 40, liv: 14, eur: 24, ntw: 20 };
const DAY = 86400000;

function addDays(iso, n) {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// One completed leaderboard -> round rows. Only complete rounds are kept; an event still in
// progress contributes nothing (it would be half-rounds and pre-cut fields).
// Events whose scores aren't individual stroke play never feed ratings:
//  - team formats (Zurich Classic, Grant Thornton, ...) list teams, and best-ball / alternate-shot
//    scores aren't a player's own; ESPN team entries have no athlete name, so a mostly "Unknown"
//    field counts as a team event too
//  - points formats (modified Stableford at the Barracuda) report points, not strokes
const TEAM_EVENT_RE = /zurich|grant thornton|\bteam\b|four-?ball|foursomes|mixed/i;
const POINTS_EVENT_RE = /barracuda|stableford/i;
function excludedReason(ev) {
  if (!ev) return null;
  if (TEAM_EVENT_RE.test(ev.name || '')) return 'team event';
  // Only an explicit points/match label excludes — ESPN's exact name for ordinary stroke play
  // isn't confirmed, so an unfamiliar label must never drop a normal event.
  if (ev.scoringSystem && /stableford|points|match/i.test(ev.scoringSystem)) return `scoring: ${ev.scoringSystem}`;
  if (POINTS_EVENT_RE.test(ev.name || '')) return 'points scoring';
  const unknown = ev.players.filter(p => p.name === 'Unknown').length;
  if (ev.players.length > 0 && unknown / ev.players.length > 0.5) return 'team event';
  return null;
}

function roundsFromEvent(ev) {
  const rows = [];
  if (!ev || ev.state !== 'post' || excludedReason(ev)) return rows;
  for (const p of ev.players) {
    for (const r of p.rounds) {
      if (!r.complete || !r.strokes) continue;
      if (r.strokes < 55 || r.strokes > 95) continue; // guard against parse garbage
      rows.push({
        tour: ev.tour, eventId: ev.id, eventName: ev.name, round: r.round,
        playerId: p.id, name: p.name,
        date: ev.startDate ? addDays(ev.startDate, r.round - 1) : null,
        course: ev.course.name, par: ev.course.par, strokes: r.strokes,
        teeTime: r.teeTime, startHole: r.startHole, holes: r.holes.map(h => h.strokes),
        finish: p.position || p.status,
      });
    }
  }
  return rows;
}

async function saveEvent(ev, rows) {
  await db.ensureTables();
  await db.query(
    `INSERT INTO golf_events (tour, event_id, name, start_date, end_date, course, par, completed, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
     ON CONFLICT (tour, event_id) DO UPDATE SET name=EXCLUDED.name, completed=EXCLUDED.completed, synced_at=NOW()`,
    [ev.tour, ev.id, ev.name, ev.startDate?.slice(0, 10) || null, ev.endDate?.slice(0, 10) || null, ev.course.name, ev.course.par, ev.state === 'post']
  );
  // Multi-row upsert in chunks — one round-trip per ~200 rows.
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const vals = [], params = [];
    chunk.forEach((r, j) => {
      const b = j * 13;
      vals.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12},$${b + 13})`);
      params.push(r.tour, r.eventId, r.round, r.playerId, r.name, r.date, r.course, r.par, r.strokes, r.teeTime, r.startHole, JSON.stringify(r.holes), r.finish);
    });
    await db.query(
      `INSERT INTO golf_rounds (tour, event_id, round, player_id, player_name, round_date, course, par, strokes, tee_time, start_hole, holes, finish)
       VALUES ${vals.join(',')}
       ON CONFLICT (tour, event_id, round, player_id) DO UPDATE SET strokes=EXCLUDED.strokes, finish=EXCLUDED.finish, holes=EXCLUDED.holes`,
      params
    );
  }
}

// Sync completed events for one tour/season that the DB doesn't already have. Stops before the
// serverless deadline and reports what's left, so repeated calls finish a backfill.
// Remove rounds stored from team / points events before detection existed.
async function purgeExcludedEvents() {
  const res = await db.query(
    `DELETE FROM golf_rounds r USING golf_events e
     WHERE r.tour = e.tour AND r.event_id = e.event_id AND e.name ~* $1`,
    ['zurich|grant thornton|\\mteam\\M|four-?ball|foursomes|mixed|barracuda|stableford']
  );
  return res.rowCount;
}

async function syncSeason(tour, season, { maxEvents = 12, deadline = Date.now() + 45000 } = {}) {
  await db.ensureTables();
  const purged = await purgeExcludedEvents();
  const cal = await fetchCalendar(tour, season);
  const done = await db.query(`SELECT event_id FROM golf_events WHERE tour=$1 AND completed=TRUE`, [tour]);
  const have = new Set(done.rows.map(r => r.event_id));
  const now = Date.now();
  const todo = cal.filter(e => !have.has(e.id) && e.endDate && new Date(e.endDate).getTime() + DAY < now);
  const synced = [], failed = [];
  for (const e of todo.slice(0, maxEvents)) {
    if (Date.now() > deadline) break;
    try {
      const ev = await fetchLeaderboard(tour, e.id);
      const rows = roundsFromEvent(ev);
      if (ev) await saveEvent(ev, rows);
      synced.push({ id: e.id, name: e.name, rounds: rows.length });
    } catch (err) {
      failed.push({ id: e.id, name: e.name, error: err.message });
    }
  }
  return { tour, season, calendarEvents: cal.length, alreadyStored: have.size, excludedRoundsPurged: purged, synced, failed, remaining: Math.max(0, todo.length - synced.length - failed.length) };
}

function rowFromDb(r) {
  return {
    tour: r.tour, eventId: r.event_id, round: r.round, playerId: r.player_id, name: r.player_name,
    date: r.round_date instanceof Date ? r.round_date.toISOString().slice(0, 10) : String(r.round_date).slice(0, 10),
    course: r.course, par: r.par, strokes: r.strokes, finish: r.finish,
    teeTime: r.tee_time ? new Date(r.tee_time).toISOString() : null, startHole: r.start_hole,
  };
}

let memory = null; // { at, rows, events }

async function loadFromEspn(tours) {
  const year = new Date().getUTCFullYear();
  const now = Date.now();
  const events = [];
  for (const tour of tours) {
    const cals = await Promise.all([year, year - 1].map(y => fetchCalendar(tour, y).catch(() => [])));
    const done = cals.flat()
      .filter(e => e.endDate && new Date(e.endDate).getTime() + DAY < now)
      .sort((a, b) => new Date(b.startDate) - new Date(a.startDate))
      .slice(0, MEMORY_EVENTS_PER_TOUR[tour] || 20);
    events.push(...done);
  }
  const boards = await mapLimit(events, 6, e => fetchLeaderboard(e.tour, e.id).catch(() => null));
  return boards.flatMap(roundsFromEvent);
}

// All stored rounds within `sinceDays` before `before` (exclusive) — `before` is what keeps a
// backtest leak-free: an event's own rounds are never visible to its own projection.
async function loadRounds({ before = new Date(), sinceDays = 760, tours = DEFAULT_TOURS } = {}) {
  const beforeIso = new Date(before).toISOString().slice(0, 10);
  const sinceIso = new Date(new Date(before).getTime() - sinceDays * DAY).toISOString().slice(0, 10);
  let rows;
  let source;
  if (db.hasDb) {
    await db.ensureTables();
    const res = await db.query(
      `SELECT tour, event_id, round, player_id, player_name, round_date, course, par, strokes, finish, tee_time, start_hole
       FROM golf_rounds WHERE round_date < $1 AND round_date >= $2 AND tour = ANY($3)`,
      [beforeIso, sinceIso, tours]
    );
    rows = res.rows.map(rowFromDb);
    source = 'database';
  } else {
    if (!memory || Date.now() - memory.at > 6 * 3600 * 1000) memory = { at: Date.now(), rows: await loadFromEspn(tours) };
    rows = memory.rows.filter(r => r.date && r.date < beforeIso && r.date >= sinceIso && tours.includes(r.tour));
    source = 'live-espn';
  }
  return { rows, source };
}

async function dataStatus() {
  if (!db.hasDb) return { source: 'live-espn', note: 'No DATABASE_URL set — history is fetched live (most recent events only). Add a database and run /api/sync for the full two-season history.' };
  await db.ensureTables();
  const ev = await db.query(`SELECT tour, EXTRACT(YEAR FROM start_date)::int AS season, COUNT(*)::int AS events, MAX(end_date) AS latest FROM golf_events WHERE completed GROUP BY 1,2 ORDER BY 1,2`);
  const rd = await db.query(`SELECT COUNT(*)::int AS rounds, COUNT(DISTINCT player_id)::int AS players, MIN(round_date) AS first, MAX(round_date) AS last FROM golf_rounds`);
  return { source: 'database', seasons: ev.rows, totals: rd.rows[0] };
}

async function saveSnapshot(event, payload) {
  if (!db.hasDb) return false;
  await db.ensureTables();
  const res = await db.query(
    // Overwritten on every pre-tournament load; the tournament only calls this while state is
    // 'pre', so the row ends up holding the last projection before the first tee time.
    `INSERT INTO golf_snapshots (event_id, tour, name, start_date, payload) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (event_id) DO UPDATE SET payload = EXCLUDED.payload, saved_at = NOW(), graded = NULL, graded_at = NULL`,
    [event.id, event.tour, event.name, event.startDate?.slice(0, 10) || null, JSON.stringify(payload)]
  );
  return res.rowCount > 0;
}

// Save and report: { saved, at } or { saved: false, reason } — never throws, never hangs.
async function saveSnapshotSafely(event, payload) {
  if (!db.hasDb) return { saved: false, reason: `no database connected (set ${db.DB_VARS[0]})` };
  try { await db.withTimeout(saveSnapshot(event, payload), 8000); return { saved: true, at: new Date().toISOString() }; }
  catch (err) { console.error('snapshot save failed', err); return { saved: false, reason: err.message }; }
}

// What the Accuracy tab shows about storage: connected or not, and the latest saved projection.
async function snapshotStatus() {
  if (!db.hasDb) return { connected: false, note: `No database connected, so pre-tournament projections aren't being saved. Set ${db.DB_VARS[0]} (or ${db.DB_VARS[1]}) to a Postgres connection string.` };
  try {
    await db.ensureTables();
    const r = await db.withTimeout(db.query(`SELECT COUNT(*)::int AS saved, COUNT(graded)::int AS graded, MAX(saved_at) AS last_at FROM golf_snapshots`), 8000);
    const last = await db.query(`SELECT name, saved_at FROM golf_snapshots ORDER BY saved_at DESC LIMIT 1`);
    return { connected: true, variable: db.dbVar, saved: r.rows[0].saved, graded: r.rows[0].graded, last: last.rows[0] ? { name: last.rows[0].name, savedAt: last.rows[0].saved_at } : null };
  } catch (err) { return { connected: false, variable: db.dbVar, error: err.message, note: `${db.dbVar} is set but the database didn't answer: ${err.message}` }; }
}

module.exports = { DEFAULT_TOURS, excludedReason, roundsFromEvent, syncSeason, loadRounds, dataStatus, saveSnapshot, saveSnapshotSafely, snapshotStatus };
