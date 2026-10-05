#!/usr/bin/env node
/* Verify a database is ready to be production, without ever disclosing how to
   reach it.

   Run:  node --env-file=.env.local tools/db-check.js

   Nothing here prints the connection string, the password, the host or the
   database name. It reports facts about the server and the schema and
   nothing that would let somebody connect.

   It is read-only in effect: the one write it performs is inside a
   transaction that is always rolled back, so it proves the role can write
   without leaving a row behind. No package, user or claim data is created. */

"use strict";

const { Client } = require("pg");

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;

/* Never log a value derived from the credential. These helpers answer
   questions about it without reproducing any of it. */
function shape(connectionString) {
  try {
    const u = new URL(connectionString);
    const host = u.hostname || "";
    return {
      protocolOk: /^postgres(ql)?:$/.test(u.protocol),
      provider: /neon\.tech$/i.test(host)
        ? "Neon"
        : /supabase\./i.test(host)
        ? "Supabase"
        : /rds\.amazonaws\.com$/i.test(host)
        ? "AWS RDS"
        : /\b(127\.0\.0\.1|localhost)\b/.test(host)
        ? "local"
        : "other",
      pooled: /-pooler\./i.test(host),
      tls: /sslmode=require|sslmode=verify/i.test(u.search),
      tlsDisabled: /sslmode=disable/i.test(u.search),
      hasPassword: Boolean(u.password),
    };
  } catch (e) {
    return null;
  }
}

const ok = (s) => `  [ok]   ${s}`;
const warn = (s) => `  [warn] ${s}`;
const bad = (s) => `  [FAIL] ${s}`;

/* Every table the application expects, and what it is for. A missing one
   means a migration did not apply. */
const EXPECTED_TABLES = [
  "schema_migrations",
  "users",
  "sessions",
  "packages",
  "claims",
  "challenges",
  "wallets",
  "releases",
  "events",
  "repositories",
  "contributors",
  "package_contributors",
  "download_snapshots",
  "verification_events",
  "onchain_registrations",
  "onchain_releases",
  "audit_log",
];

async function main() {
  const problems = [];
  const warnings = [];

  if (!url) {
    console.error(
      "no DATABASE_URL. Put it in .env.local and run:\n" +
        "  node --env-file=.env.local tools/db-check.js"
    );
    process.exit(1);
  }

  console.log("Connection string");
  const s = shape(url);
  if (!s) {
    console.log(bad("could not be parsed as a url"));
    process.exit(1);
  }
  console.log(s.protocolOk ? ok("is a postgres url") : bad("is not a postgres url"));
  if (!s.protocolOk) problems.push("not a postgres url");

  console.log(`  [info] provider looks like: ${s.provider}`);
  if (s.provider === "local") {
    warnings.push("this points at a local database, which cannot serve production");
  }
  if (s.provider === "Neon") {
    console.log(
      s.pooled
        ? ok("using the pooled endpoint, which is what an app should use")
        : warn("not the pooled endpoint; prefer the pooled string for an app")
    );
    if (!s.pooled) warnings.push("not using Neon's pooled endpoint");
  }

  if (s.tlsDisabled) {
    console.log(bad("sslmode=disable: traffic would not be encrypted"));
    problems.push("TLS explicitly disabled");
  } else if (s.tls) {
    console.log(ok("sslmode requires TLS"));
  } else {
    console.log(warn("no sslmode in the url; a managed provider usually needs sslmode=require"));
    warnings.push("no sslmode specified");
  }
  console.log(s.hasPassword ? ok("carries a password") : warn("carries no password"));

  /* ------------------------------------------------------- connect ----- */

  console.log("\nServer");
  const client = new Client({
    connectionString: url,
    ssl: /sslmode=disable/.test(url) ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });

  try {
    await client.connect();
  } catch (e) {
    // The driver puts the host in its error text; say only what failed.
    console.log(bad(`could not connect (${e.code || "connection failed"})`));
    process.exit(1);
  }
  console.log(ok("connected"));

  const version = await client.query("select version()");
  console.log(`  [info] ${version.rows[0].version.split(",")[0]}`);

  const who = await client.query(
    "select current_user as role, current_database() is not null as has_db"
  );
  console.log(ok(`authenticated as a role with a database assigned`));
  void who;

  /* ------------------------------------------------------ migrations -- */

  console.log("\nMigrations");
  const applied = await client
    .query("select name, checksum, applied_at from schema_migrations order by name")
    .catch(() => null);

  if (!applied) {
    console.log(bad("schema_migrations does not exist: migrations have not been run"));
    problems.push("migrations not applied");
  } else {
    const fs = require("fs");
    const path = require("path");
    const dir = path.join(__dirname, "..", "api", "migrations");
    const onDisk = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    const appliedNames = applied.rows.map((r) => r.name);

    for (const name of onDisk) {
      const was = applied.rows.find((r) => r.name === name);
      console.log(
        was
          ? ok(`${name} applied ${new Date(was.applied_at).toISOString().slice(0, 16)}Z`)
          : bad(`${name} NOT applied`)
      );
      if (!was) problems.push(`${name} not applied`);
    }

    const extra = appliedNames.filter((n) => !onDisk.includes(n));
    if (extra.length) {
      console.log(warn(`recorded but not on disk: ${extra.join(", ")}`));
      warnings.push("migrations recorded that are not in this checkout");
    }
  }

  /* ---------------------------------------------------------- tables -- */

  console.log("\nSchema");
  const tables = await client.query(
    `select table_name from information_schema.tables
      where table_schema = 'public' order by table_name`
  );
  const present = new Set(tables.rows.map((r) => r.table_name));

  const missing = EXPECTED_TABLES.filter((t) => !present.has(t));
  console.log(
    missing.length
      ? bad(`missing ${missing.length} table(s): ${missing.join(", ")}`)
      : ok(`all ${EXPECTED_TABLES.length} expected tables present`)
  );
  if (missing.length) problems.push("tables missing");

  const unexpected = [...present].filter((t) => !EXPECTED_TABLES.includes(t));
  if (unexpected.length) {
    console.log(warn(`tables this app does not own: ${unexpected.join(", ")}`));
    warnings.push("the database contains tables from something else");
  }

  // Indexes matter for the queries the product actually runs.
  const indexes = await client.query(
    `select count(*)::int as n from pg_indexes where schemaname = 'public'`
  );
  console.log(ok(`${indexes.rows[0].n} indexes present`));

  /* ------------------------------------------------------- emptiness -- */

  console.log("\nContents");
  const counts = {};
  for (const t of ["users", "packages", "claims", "verification_events", "onchain_registrations"]) {
    if (!present.has(t)) continue;
    const r = await client.query(`select count(*)::int as n from ${t}`);
    counts[t] = r.rows[0].n;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(
    total === 0
      ? ok("empty, as a new production database should be")
      : warn(`contains data: ${JSON.stringify(counts)}`)
  );

  if (present.has("packages")) {
    const verified = await client.query(
      "select count(*)::int as n from packages where verified_owner_id is not null"
    );
    console.log(
      verified.rows[0].n === 0
        ? ok("no package is marked verified")
        : bad(`${verified.rows[0].n} package(s) marked verified in a new database`)
    );
    if (verified.rows[0].n > 0) problems.push("pre-existing verified packages");
  }

  /* ------------------------------------------------------ write test -- */

  /* Proves the role can write, inside a transaction that is always rolled
     back. Nothing survives this, so no fake data is created. */
  console.log("\nPermissions");
  try {
    await client.query("BEGIN");
    await client.query(
      `insert into events (id, kind, package_name, payload)
       values ('00000000-0000-4000-8000-00000000dead', 'healthcheck', null, '{}')`
    );
    const readBack = await client.query(
      "select kind from events where id = '00000000-0000-4000-8000-00000000dead'"
    );
    const wrote = readBack.rows.length === 1;
    await client.query("ROLLBACK");

    const left = await client.query(
      "select count(*)::int as n from events where id = '00000000-0000-4000-8000-00000000dead'"
    );

    console.log(wrote ? ok("insert succeeded") : bad("insert did not take effect"));
    console.log(
      left.rows[0].n === 0
        ? ok("rolled back cleanly: nothing was left behind")
        : bad("the rollback did not remove the row")
    );
    if (!wrote) problems.push("cannot write");
    if (left.rows[0].n !== 0) problems.push("rollback failed");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.log(bad(`write test failed (${e.code || e.message.slice(0, 40)})`));
    problems.push("write test failed");
  }

  /* ---------------------------------------------------------- timing -- */

  const started = Date.now();
  await client.query("select 1");
  const rtt = Date.now() - started;
  console.log(`  [info] round trip: ${rtt}ms`);
  if (rtt > 400) {
    warnings.push(`round trip is ${rtt}ms; consider a region closer to the app`);
  }

  await client.end();

  /* --------------------------------------------------------- verdict -- */

  console.log("\n" + "-".repeat(58));
  if (problems.length) {
    console.log(`NOT READY. ${problems.length} problem(s):`);
    problems.forEach((p) => console.log(`  - ${p}`));
  } else {
    console.log("READY for production.");
  }
  if (warnings.length) {
    console.log(`\n${warnings.length} thing(s) to be aware of:`);
    warnings.forEach((w) => console.log(`  - ${w}`));
  }
  process.exit(problems.length ? 1 : 0);
}

main().catch((e) => {
  // Never let a stack trace carry the connection string outward.
  console.error("check failed:", e.code || String(e.message).slice(0, 80));
  process.exit(1);
});
