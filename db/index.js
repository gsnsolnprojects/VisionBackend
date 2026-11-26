/**
 * Accounts database (Postgres) access.
 *
 * Three ways in:
 *   asUser(user, fn)  - for requests a signed-in user makes on their own behalf. Runs as the
 *                       `authenticated` role with request.jwt.claims set, so the same RLS policies
 *                       and triggers that protected these tables under Supabase still decide.
 *   asSystem(fn)      - trusted server-side work (auth internals, admin panel, webhooks). Runs as
 *                       `service_role`, which bypasses RLS. The caller must check permissions itself.
 *   query(sql, args)  - shorthand for a single statement inside asSystem.
 *
 * Every call is its own transaction; `fn` receives a client with .query(sql, params).
 */
const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set (postgres://vision_app:<password>@<host>:5432/vision)');
    }
    pool = new Pool({
      connectionString,
      max: Number(process.env.DATABASE_POOL_MAX || 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on('error', (err) => console.error('[db] idle client error:', err.message));
  }
  return pool;
}

async function inTransaction(setup, fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await setup(client);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection may already be broken */ }
    throw err;
  } finally {
    client.release();
  }
}

/** Run fn as the signed-in user (RLS + triggers apply). user needs { id, email }. */
function asUser(user, fn) {
  if (!user?.id) throw new Error('asUser needs a signed-in user');
  const claims = JSON.stringify({ sub: user.id, role: 'authenticated', email: user.email || null });
  return inTransaction(async (client) => {
    await client.query('SET LOCAL ROLE authenticated');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims]);
  }, fn);
}

/** Run fn as the trusted backend (bypasses RLS; triggers treat it as a server call). */
function asSystem(fn) {
  return inTransaction(async (client) => {
    await client.query('SET LOCAL ROLE service_role');
  }, fn);
}

/** One statement as the trusted backend. Returns the pg result. */
function query(sql, params) {
  return asSystem((client) => client.query(sql, params));
}

/** First row or null */
async function one(sql, params) {
  const { rows } = await query(sql, params);
  return rows[0] || null;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
function ident(name) {
  if (!IDENT.test(name)) throw new Error(`unsafe SQL identifier: ${name}`);
  return `"${name}"`;
}
function tableName(name) {
  return String(name).split('.').map(ident).join('.');
}

/**
 * Insert a row, or update the given columns if a row with the same conflict key exists
 * (same as Supabase's upsert: columns not in `row` are left alone). Runs as service_role
 * unless a client is passed. Returns the saved row.
 */
async function upsert(table, row, conflictColumn, client) {
  const cols = Object.keys(row);
  const updates = cols.filter((c) => c !== conflictColumn);
  const sql = `insert into ${tableName(table)} (${cols.map(ident).join(', ')})
    values (${cols.map((_, i) => `$${i + 1}`).join(', ')})
    on conflict (${ident(conflictColumn)}) do ${updates.length
      ? `update set ${updates.map((c) => `${ident(c)} = excluded.${ident(c)}`).join(', ')}`
      : 'nothing'}
    returning *`;
  const params = cols.map((c) => row[c]);
  const { rows } = client ? await client.query(sql, params) : await query(sql, params);
  return rows[0] || null;
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { asUser, asSystem, query, one, upsert, ident, close, getPool };
