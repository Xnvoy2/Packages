/* Data freshness.

   The property worth protecting: an upstream being unavailable is not
   evidence about a package. A failed refresh must leave what was already
   known exactly as it was, and must be visible as a failure rather than
   silently presenting stale data as current. */

"use strict";

if (process.env.DATABASE_URL) {
  const name = (process.env.DATABASE_URL.split("/").pop() || "").split("?")[0];
  if (!/test/i.test(name) && process.env.PACKAGES_TEST_ALLOW_DB !== "yes") {
    console.error(`[test] refusing to run against the database "${name}"`);
    process.exit(1);
  }
}

process.env.PACKAGES_DEV_DB = process.env.DATABASE_URL ? "" : "memory";
process.env.PACKAGES_SESSION_SECRET =
  process.env.PACKAGES_SESSION_SECRET || "test-secret-not-for-production";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const db = require("../lib/db");
const store = require("../lib/store");
const refresh = require("../lib/refresh");
const npm = require("../lib/npm");
const cache = require("../lib/cache");

const RUN = crypto.randomBytes(4).toString("hex");
const PKG = `fixture-refresh-${RUN}`;

test.before(async () => {
  await db.migrate({ quiet: true });
  refresh._resetBackoff();
});

test.after(async () => {
  try {
    await db.query("delete from download_snapshots where package_name like $1", [`fixture-%${RUN}`]);
    await db.query("delete from package_contributors where package_name like $1", [`fixture-%${RUN}`]);
    await db.query("delete from releases where package_name like $1", [`fixture-%${RUN}`]);
    await db.query("delete from packages where name like $1", [`fixture-%${RUN}`]);
  } catch (e) {
    console.warn("[test] cleanup:", e.message);
  }
  await db.close();
});

test.beforeEach(() => {
  refresh._resetBackoff();
  cache.clear();
});

/* ------------------------------------------------------ staleness ------ */

test("staleness is measured against the right clock", () => {
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  assert.equal(refresh.isStale(now, refresh.MAX_AGE_MS.packument), false);
  assert.equal(refresh.isStale(old, refresh.MAX_AGE_MS.packument), true);
  // Never fetched is always stale, rather than never due.
  assert.equal(refresh.isStale(null, refresh.MAX_AGE_MS.packument), true);
});

test("different kinds of information have different lifetimes", () => {
  /* Treating a contributor list like a publish timestamp just spends
     somebody else's rate limit. */
  assert.ok(refresh.MAX_AGE_MS.packument < refresh.MAX_AGE_MS.downloads);
  assert.ok(refresh.MAX_AGE_MS.downloads <= refresh.MAX_AGE_MS.contributors);
});

/* ---------------------------------------------------- not tracked ------ */

test("refreshing a package nobody tracks does nothing", async () => {
  const result = await refresh.refreshPackage(`fixture-untracked-${RUN}`);
  assert.equal(result.skipped, "not_tracked");
});

/* ------------------------------------------------- failure behaviour --- */

test("a failed refresh leaves the existing record completely intact", async () => {
  /* The important one. An npm outage must not blank a package page. */
  await store.upsertPackage({
    name: PKG,
    description: "the description that must survive",
    latestVersion: "1.2.3",
    license: "MIT",
    homepage: "https://example.com",
    repo: { owner: "someone", repo: "something", url: "https://github.com/someone/something" },
    keywords: ["a", "b"],
    maintainers: [{ username: "someone", email: null }],
    createdAt: "2020-01-01T00:00:00.000Z",
    modifiedAt: "2024-01-01T00:00:00.000Z",
    versionCount: 9,
  });
  // Make it look stale so a refresh is actually attempted.
  await db.query("update packages set fetched_at = $2 where name = $1", [
    PKG,
    new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(),
  ]);

  const before = await store.getPackage(PKG);

  // The fixture name does not exist on npm, so the packument read fails.
  const result = await refresh.refreshPackage(PKG, { force: true });

  assert.ok(result.failed && result.failed.includes("packument"), JSON.stringify(result));
  assert.match(result.note, /left untouched/i);

  const after = await store.getPackage(PKG);
  assert.equal(after.description, before.description, "description must survive");
  assert.equal(after.latest_version, before.latest_version, "version must survive");
  assert.equal(after.license, before.license);
  assert.equal(after.repo_owner, before.repo_owner);
  assert.equal(after.version_count, before.version_count);
});

test("a failure is reported with an attempt count and a retry time", async () => {
  const result = await refresh.refreshPackage(PKG, { force: true });
  assert.ok(result.attempt >= 1);
  assert.ok(Date.parse(result.retryAt) > Date.now(), "retryAt must be in the future");
});

test("backoff grows with repeated failures", async () => {
  refresh._resetBackoff();
  const first = await refresh.refreshPackage(PKG, { force: true });
  const second = await refresh.refreshPackage(PKG, { force: true });
  const third = await refresh.refreshPackage(PKG, { force: true });

  assert.equal(first.attempt, 1);
  assert.equal(second.attempt, 2);
  assert.equal(third.attempt, 3);

  // Each wait is longer than the last, so a permanently broken package is
  // retried occasionally rather than every cycle.
  assert.ok(
    Date.parse(third.retryAt) > Date.parse(first.retryAt),
    "backoff should increase"
  );
});

test("a package in backoff is skipped rather than retried", async () => {
  refresh._resetBackoff();
  await refresh.refreshPackage(PKG, { force: true });
  // Without force, the backoff applies.
  const skipped = await refresh.refreshPackage(PKG);
  assert.equal(skipped.skipped, "backoff");
  assert.ok(skipped.retryAt);
});

/* ------------------------------------------------------- freshness ----- */

test("freshness reports when each piece was last read, and any failure", async () => {
  refresh._resetBackoff();
  const clean = await refresh.freshnessFor(PKG);
  assert.ok(clean.packageFetchedAt, "a tracked package has a fetch time");
  assert.equal(clean.lastFailure, null);

  await refresh.refreshPackage(PKG, { force: true });
  const afterFailure = await refresh.freshnessFor(PKG);
  /* The page must be able to say "this is old and the last check failed"
     rather than showing stale data as though it were current. */
  assert.ok(afterFailure.lastFailure, "a failure must be visible");
  assert.ok(afterFailure.lastFailure.attempts >= 1);
  assert.ok(afterFailure.lastFailure.retryAt);
});

test("freshness is null for a package nobody tracks", async () => {
  assert.equal(await refresh.freshnessFor(`fixture-nope-${RUN}`), null);
});

/* ----------------------------------------------------------- cycle ----- */

test("a cycle only considers claimed or launched packages", async () => {
  /* Refreshing every package anyone ever looked up would turn this into a
     crawler of the registry. */
  const result = await refresh.refreshCycle({ limit: 5 });
  assert.ok(Number.isInteger(result.considered));
  // The fixture above is tracked but unclaimed, so it must not be picked up.
  const names = result.results.map((r) => r.name);
  assert.ok(!names.includes(PKG), "an unclaimed package is not worth a request");
});

test("a cycle is bounded however large the limit asked for", async () => {
  const result = await refresh.refreshCycle({ limit: 1000 });
  assert.ok(result.considered <= 25, "the cycle caps its own batch size");
});

/* --------------------------------------------------- real refresh ------ */

test("a real package refreshes and records its releases", async (t) => {
  // Needs npm. Skipped rather than failed when offline.
  let online = true;
  const pkg = await npm.packument("left-pad").catch(() => {
    online = false;
    return null;
  });
  if (!online || !pkg) return t.skip("npm unreachable");

  const name = "left-pad";
  await store.upsertPackage(pkg);
  const result = await refresh.refreshPackage(name, { force: true });

  assert.ok(result.refreshed && result.refreshed.length, JSON.stringify(result));
  assert.ok(
    result.refreshed.some((r) => r.startsWith("packument")),
    "the packument should have been refreshed"
  );

  const freshness = await refresh.freshnessFor(name);
  assert.ok(freshness.packageFetchedAt);
  assert.equal(freshness.stale, false, "just refreshed, so not stale");
  assert.equal(freshness.lastFailure, null);
});
