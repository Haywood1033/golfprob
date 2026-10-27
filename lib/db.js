// lib/db.js — shared Postgres access (Supabase-compatible). Optional: with no DATABASE_URL the
// store falls back to fetching history live from ESPN, so the app still runs before a DB exists.
// Connection string: DATABASE_URL, or the POSTGRES_URL that Vercel's Supabase (and Neon)
// integrations set. sslmode is stripped from the URL: recent pg versions read sslmode=require as
// full certificate verification, which Supabase's pooler fails; TLS stays on via `ssl` below.
const DB_VARS = ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_URL_NON_POOLING', 'SUPABASE_DB_URL'];
const dbVar = DB_VARS.find(k => process.env[k]) || null;
const hasDb = !!dbVar;
// sslmode=disable is honoured (a local database without TLS); anything else connects over TLS.
const sslOff = () => { try { return new URL(process.env[dbVar]).searchParams.get('sslmode') === 'disable'; } catch { return false; } };
function connectionString() {
  try {
    const u = new URL(process.env[dbVar]);
    ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'supa'].forEach(k => u.searchParams.delete(k));
    return u.toString();
  } catch { return process.env[dbVar]; }
}
let pool = null;

function getPool() {
  if (!hasDb) return null;
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: connectionString(), ssl: sslOff() ? false : { rejectUnauthorized: false }, max: 3, connectionTimeoutMillis: 8000 });
  }
  return pool;
}

async function query(text, params) {
  const client = await getPool().connect();
  try { return await client.query(text, params); }
  finally { client.release(); }
}

const ENSURE_SQL = `
  CREATE TABLE IF NOT EXISTS golf_events (
    tour        VARCHAR(8)  NOT NULL,
    event_id    VARCHAR(24) NOT NULL,
    name        TEXT,
    start_date  DATE,
    end_date    DATE,
    course      TEXT,
    par         SMALLINT,
    completed   BOOLEAN DEFAULT FALSE,
    synced_at   TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (tour, event_id)
  );
  CREATE TABLE IF NOT EXISTS golf_rounds (
    tour        VARCHAR(8)  NOT NULL,
    event_id    VARCHAR(24) NOT NULL,
    round       SMALLINT    NOT NULL,
    player_id   VARCHAR(24) NOT NULL,
    player_name TEXT,
    round_date  DATE,
    course      TEXT,
    par         SMALLINT,
    strokes     SMALLINT    NOT NULL,
    tee_time    TIMESTAMPTZ,
    start_hole  SMALLINT,
    holes       JSONB,
    finish      TEXT,
    PRIMARY KEY (tour, event_id, round, player_id)
  );
  CREATE INDEX IF NOT EXISTS golf_rounds_date ON golf_rounds (round_date);
  CREATE TABLE IF NOT EXISTS golf_snapshots (
    event_id    VARCHAR(24) PRIMARY KEY,
    tour        VARCHAR(8),
    name        TEXT,
    saved_at    TIMESTAMP DEFAULT NOW(),
    payload     JSONB
  );
  ALTER TABLE golf_snapshots ADD COLUMN IF NOT EXISTS start_date DATE;
  ALTER TABLE golf_snapshots ADD COLUMN IF NOT EXISTS graded JSONB;
  ALTER TABLE golf_snapshots ADD COLUMN IF NOT EXISTS graded_at TIMESTAMP;
`;

let ensured = false;
async function ensureTables() {
  if (!hasDb || ensured) return;
  await query(ENSURE_SQL);
  ensured = true;
}

// Resolves with fn's result, or rejects after ms — so a slow database can't hang a page load.
function withTimeout(promise, ms, what = 'database') {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s`)), ms); })]).finally(() => clearTimeout(t));
}

module.exports = { hasDb, dbVar, DB_VARS, query, ensureTables, withTimeout };
