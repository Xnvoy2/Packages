#!/usr/bin/env node
/* Apply database migrations.

   Run: npm run migrate

   Safe to run repeatedly and safe to run on startup: each migration is
   applied once and recorded with a checksum. It is the production deploy
   step, and it is also what the test suite calls, so the schema a test sees
   is the schema a deploy produces. */

"use strict";

const db = require("./_lib/db");
const { config } = require("./_lib/env");

async function main() {
  if (!config.databaseUrl && config.devDb !== "memory") {
    console.error(
      "[migrate] no database configured: set DATABASE_URL, or " +
        "PACKAGES_DEV_DB=memory for a throwaway one"
    );
    process.exit(1);
  }

  const result = await db.migrate();
  const applied = result.migrations.filter((m) => m.status === "applied");

  console.log(
    `[migrate] ${result.driver}: ${applied.length} applied, ` +
      `${result.migrations.length - applied.length} already present`
  );
  await db.close();
}

main().catch((e) => {
  console.error("[migrate] failed:", e.message);
  process.exit(1);
});
