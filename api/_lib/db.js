/* The database. One pool, one migrate(), and parameterised queries only.

   Two drivers, one dialect:
     DATABASE_URL set            -> node-postgres against a real server
     PACKAGES_DEV_DB=memory      -> pg-mem, which speaks the same wire client

   The point of the second is that development and the test suite run the same
   SQL as production rather than a hand-rolled stand-in. If neither is set the
   server refuses to start, because a silent in-memory fallback in production
   would lose every account on the next deploy. */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { config } = require("./env");

let pool = null;
let driver = null;

function createPool() {
  if (config.databaseUrl) {
    const { Pool } = require("pg");
    driver = "postgres";
    return new Pool({
      connectionString: config.databaseUrl,
      max: 8,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 8000,
      // Managed Postgres (Neon, Supabase, RDS) terminates TLS with a chain the
      // local store often does not have. Verifying it properly needs the CA
      // bundle, which is deployment configuration; a connection string with
      // sslmode=disable opts out explicitly.
      ssl: /sslmode=disable/.test(config.databaseUrl)
        ? false
        : { rejectUnauthorized: false },
    });
  }

  if (config.devDb === "memory") {
    const { newDb } = require("pg-mem");
    const mem = newDb({ autoCreateForeignKeyIndices: true });
    // pg-mem has no now() drift and no uuid extension; the application
    // supplies every id, so neither is needed.
    const pg = mem.adapters.createPg();
    driver = "pg-mem";
    const MemPool = pg.Pool;
    return new MemPool();
  }

  throw new Error(
    "no database configured: set DATABASE_URL, or PACKAGES_DEV_DB=memory for local development"
  );
}

function db() {
  if (!pool) pool = createPool();
  return pool;
}

async function query(text, params) {
  const started = Date.now();
  try {
    return await db().query(text, params || []);
  } catch (e) {
    // The connection string can appear in a pg connection error; never let it
    // travel with the exception.
    const safe = new Error(`query failed: ${e.message}`);
    safe.code = e.code;
    safe.sql = text.split("\n")[0].slice(0, 120);
    throw safe;
  } finally {
    const ms = Date.now() - started;
    if (ms > 1500) console.warn(`[db] slow query ${ms}ms: ${text.slice(0, 80)}`);
  }
}

const one = async (text, params) => {
  const r = await query(text, params);
  return r.rows[0] || null;
};

const many = async (text, params) => (await query(text, params)).rows;

/* Run several statements atomically on one connection.

   The callback gets a `tx` with the same { query, one, many } shape, so code
   inside reads like code outside. It must use that handle: anything calling
   the module-level helpers would take a different connection from the pool
   and sit outside the transaction, which is the usual way this abstraction
   gets quietly defeated.

   Used where a half-applied change would be a lie about the world: marking a
   claim verified and recording who owns the package are two statements that
   must both happen or neither. */
async function transaction(fn) {
  const pool = db();
  const client = await pool.connect();
  const tx = {
    query: (text, params) => client.query(text, params || []),
    one: async (text, params) => (await client.query(text, params || [])).rows[0] || null,
    many: async (text, params) => (await client.query(text, params || [])).rows,
  };
  try {
    await client.query("BEGIN");
    const result = await fn(tx);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      // The connection is already broken; the original error is the useful one.
      console.warn("[db] rollback failed:", rollbackError.message);
    }
    throw e;
  } finally {
    client.release();
  }
}

/* Migrations.

   Numbered files in api/migrations, applied in order, each recorded in
   schema_migrations with a checksum of the file as it was applied. Running
   twice is a no-op. Editing a file that has already been applied is an error
   rather than a silent divergence between what the table claims ran and what
   the database actually contains.

   Statements are split on a semicolon at end of line, so a semicolon inside a
   string or a function body does not break the splitter. */

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

/* Line endings are normalised before hashing. A checkout on Windows with
   core.autocrlf set produces the same SQL with CRLF, which is a different
   byte sequence and so a different checksum, and the boot would then refuse
   to start claiming an applied migration had been edited when nothing had
   changed. The statements are what matter here, not how the lines end. */
const checksum = (sql) =>
  crypto
    .createHash("sha256")
    .update(String(sql).replace(/\r\n/g, "\n"))
    .digest("hex")
    .slice(0, 16);

function migrationFiles() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function statementsIn(sql) {
  return sql
    .split(/;\s*(?:\r?\n)/)
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean);
}

async function migrate(options) {
  const quiet = options && options.quiet;

  /* The ledger table itself is created by asking the catalogue first rather
     than with "if not exists": pg-mem parses that form but its planner
     rejects it when the table is already there, so an idempotent startup —
     the whole point of this function — would fail on the second run. */
  const ledger = await one(
    `select 1 as present from information_schema.tables
      where table_schema = 'public' and table_name = 'schema_migrations'`
  );
  if (!ledger) {
    await query(
      `create table schema_migrations (
         name text primary key,
         checksum text not null,
         applied_at timestamptz not null default now()
       )`
    );
  }

  const applied = new Map(
    (await many("select name, checksum from schema_migrations")).map((r) => [
      r.name,
      r.checksum,
    ])
  );

  const results = [];
  for (const name of migrationFiles()) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), "utf8");
    const sum = checksum(sql);

    if (applied.has(name)) {
      if (applied.get(name) !== sum) {
        throw new Error(
          `migration ${name} has changed since it was applied; add a new ` +
            `migration rather than editing an applied one`
        );
      }
      results.push({ name, status: "already-applied" });
      continue;
    }

    const statements = statementsIn(sql);
    for (const statement of statements) await query(statement);
    await query("insert into schema_migrations (name, checksum) values ($1, $2)", [
      name,
      sum,
    ]);
    results.push({ name, status: "applied", statements: statements.length });
    if (!quiet) {
      console.log(`[db] applied ${name} (${statements.length} statements)`);
    }
  }

  return { driver, migrations: results };
}

async function close() {
  if (pool && pool.end) await pool.end();
  pool = null;
}

// Used by the test suite to start from a known-empty database.
function _reset() {
  pool = null;
  driver = null;
}

module.exports = { query, one, many, transaction, migrate, migrationFiles, close, _reset, get driver() { return driver; } };
