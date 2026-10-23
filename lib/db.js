// lib/db.js — shared Postgres access (Supabase-compatible). Optional: with no DATABASE_URL the
// store falls back to fetching history live from ESPN, so the app still runs before a DB exists.
const hasDb = !!process.env.DATABASE_URL;
let pool = null;

function getPool() {
  if (!hasDb) return null;
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });
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
`;

let ensured = false;
async function ensureTables() {
  if (!hasDb || ensured) return;
  await query(ENSURE_SQL);
  ensured = true;
}

module.exports = { hasDb, query, ensureTables };
