/* Starts a throwaway PostgreSQL server for development and testing.

   The API's default local database is pg-mem, which runs the same SQL in
   process. pg-mem is not Postgres though, so before trusting a query it is
   worth running it against the real thing. This boots a real server from the
   embedded-postgres dev dependency, prints its connection string and waits.

   Run:  node tools/pg-dev.js
         DATABASE_URL=<printed url> npm test

   Nothing here runs in production and nothing it writes is kept: the data
   directory is temporary and the server is not persistent.                 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const imported = require("embedded-postgres");
const EmbeddedPostgres = imported.default || imported;

const PORT = Number(process.env.PG_DEV_PORT) || 54329;
const DIR = path.join(os.tmpdir(), `packages-pg-${PORT}`);

async function main() {
  // A left-over directory from a killed run makes initialise() fail.
  if (fs.existsSync(DIR)) fs.rmSync(DIR, { recursive: true, force: true });

  const pg = new EmbeddedPostgres({
    databaseDir: DIR,
    user: "packages",
    password: "packages",
    port: PORT,
    persistent: false,
    onLog: () => {},
  });

  await pg.initialise();
  await pg.start();
  try {
    await pg.createDatabase("packages_test");
  } catch (e) {
    // Already there from a previous run against a persistent directory.
  }

  const url = `postgresql://packages:packages@127.0.0.1:${PORT}/packages_test?sslmode=disable`;
  console.log(url);
  console.log("[pg-dev] ready. ctrl-c to stop.");

  const stop = async () => {
    try {
      await pg.stop();
    } finally {
      fs.rmSync(DIR, { recursive: true, force: true });
      process.exit(0);
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  console.error("[pg-dev] failed:", e.message);
  process.exit(1);
});
