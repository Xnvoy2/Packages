/* Keeping launched packages current, without hammering anybody.

   npm and GitHub both rate-limit, and GitHub's unauthenticated budget is 60
   an hour for the whole server. So refreshing is deliberately unexciting:
   one package at a time, oldest first, only if it is actually stale, with a
   per-package backoff when the upstream fails.

   The rule that shapes all of it: **a failed refresh must never destroy what
   was already known.** An upstream being down is not evidence that a
   package's contributors have gone away. Every write here either replaces a
   value with a newer one or leaves the old one alone; nothing is cleared
   because a fetch failed. `fetched_at` records when we last *succeeded*, so
   a page can say how old its information is and be right. */

"use strict";

const npm = require("./npm");
const github = require("./github");
const store = require("./store");
const db = require("./db");
const solana = require("./solana");

/* How stale is stale. Different things change at different rates, and
   pretending otherwise just spends someone else's quota. */
const MAX_AGE_MS = {
  // A publish can happen at any time, and it is the thing people come for.
  packument: 30 * 60 * 1000,
  // Download figures are revised daily at best.
  downloads: 12 * 60 * 60 * 1000,
  // Stars and the contributor list move slowly.
  repository: 6 * 60 * 60 * 1000,
  contributors: 24 * 60 * 60 * 1000,
};

/* Backoff after a failure, per package. Doubling from a minute, capped, so a
   package whose repository has been deleted is retried occasionally rather
   than every cycle. In memory: a restart retrying once more is harmless. */
const failures = new Map();
const BACKOFF_BASE_MS = 60 * 1000;
const BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;

function backoffUntil(name) {
  const record = failures.get(name);
  return record ? record.until : 0;
}

function recordFailure(name, reason) {
  const record = failures.get(name) || { count: 0, until: 0 };
  record.count += 1;
  record.reason = reason;
  record.until =
    Date.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (record.count - 1));
  failures.set(name, record);
  return record;
}

const recordSuccess = (name) => failures.delete(name);

const isStale = (at, maxAge) => !at || Date.now() - new Date(at).getTime() > maxAge;

/* Refresh one package.

   Returns what was refreshed and what was skipped, so a caller can see the
   work rather than guess at it. Never throws for an upstream failure: that is
   an expected condition, recorded and backed off, not an exception. */
async function refreshPackage(name, options) {
  const opts = options || {};
  const now = Date.now();

  if (!opts.force && backoffUntil(name) > now) {
    return { name, skipped: "backoff", retryAt: new Date(backoffUntil(name)).toISOString() };
  }

  const row = await store.getPackage(name);
  if (!row) return { name, skipped: "not_tracked" };

  const done = [];
  const failed = [];

  /* The packument. If this fails nothing else is attempted, because
     everything below depends on what it says. */
  let pkg = null;
  if (opts.force || isStale(row.fetched_at, MAX_AGE_MS.packument)) {
    try {
      pkg = await npm.packument(name, { fresh: true });
      await store.upsertPackage(pkg);
      // Append-only: versions published since the last look.
      const added = await store.recordReleases(
        name,
        pkg.releases.filter((r) => r.present),
        (release) =>
          solana.releaseRecordHash({
            packageName: name,
            version: release.version,
            publishedAt: release.publishedAt,
          })
      );
      done.push(added ? `packument (+${added} releases)` : "packument");
    } catch (e) {
      const record = recordFailure(name, e.message);
      return {
        name,
        failed: ["packument"],
        reason: e.message,
        attempt: record.count,
        retryAt: new Date(record.until).toISOString(),
        // Said explicitly: the old record is still there and still valid.
        note: "previously known information was left untouched",
      };
    }
  } else {
    done.push("packument (fresh)");
  }

  const current = pkg || (await npm.packument(name).catch(() => null));

  // Downloads.
  if (current && (opts.force || isStale(row.fetched_at, MAX_AGE_MS.downloads))) {
    try {
      const week = await npm.downloadsPoint(name, "last-week");
      const month = await npm.downloadsPoint(name, "last-month");
      if (week) await store.recordDownloads(name, "last-week", week);
      if (month) await store.recordDownloads(name, "last-month", month);
      done.push(week || month ? "downloads" : "downloads (npm reports none)");
    } catch (e) {
      failed.push("downloads");
    }
  }

  // The repository and its contributor graph, if the package declares one.
  const repo = current && current.repo;
  if (repo) {
    try {
      const info = await github.publicRepository(repo.owner, repo.repo);
      if (info && info.id) {
        await store.upsertRepository(info);
        done.push("repository");

        const contributors = await github.contributors(repo.owner, repo.repo, 30);
        if (Array.isArray(contributors) && contributors.length) {
          await store.recordContributors(name, info.id, contributors);
          done.push(`contributors (${contributors.length})`);
        } else if (contributors && contributors.rateLimited) {
          // Not a failure of ours, and not a reason to drop the old graph.
          failed.push("contributors (github rate limited)");
        }
      } else if (info && info.rateLimited) {
        failed.push("repository (github rate limited)");
      } else {
        failed.push("repository (not available)");
      }
    } catch (e) {
      failed.push("repository");
    }
  }

  if (failed.length && !done.length) {
    const record = recordFailure(name, failed.join(", "));
    return { name, failed, attempt: record.count, retryAt: new Date(record.until).toISOString() };
  }

  recordSuccess(name);
  return { name, refreshed: done, failed, at: new Date().toISOString() };
}

/* One pass over the packages worth refreshing.

   Bounded on both sides: at most `limit` packages, and strictly one at a
   time. Concurrency here would buy very little and spend the GitHub budget
   several times faster. */
async function refreshCycle(options) {
  const opts = options || {};
  const limit = Math.min(opts.limit || 5, 25);

  /* Launched and verified packages first, then anything else tracked, oldest
     refresh first. A package nobody has claimed is not worth a request. */
  const candidates = await db.many(
    `select name from packages
      where verified_owner_id is not null or identity_pda is not null
      order by fetched_at asc nulls first
      limit $1`,
    [limit]
  );

  const results = [];
  for (const row of candidates) {
    results.push(await refreshPackage(row.name, opts));
  }
  return {
    considered: candidates.length,
    refreshed: results.filter((r) => r.refreshed && r.refreshed.length).length,
    skipped: results.filter((r) => r.skipped).length,
    failed: results.filter((r) => r.failed && r.failed.length).length,
    results,
  };
}

/* The periodic runner. Off by default: a dev machine refreshing in the
   background is a surprise, and in production it should be a deliberate
   setting. One cycle every interval, never overlapping. */
let timer = null;
let running = false;

function start(intervalMs) {
  if (timer) return { started: false, reason: "already running" };
  const interval = Math.max(60000, intervalMs || 15 * 60 * 1000);

  timer = setInterval(async () => {
    // Skip rather than queue: a slow cycle must not stack up behind itself.
    if (running) return;
    running = true;
    try {
      const result = await refreshCycle({ limit: 5 });
      if (result.refreshed || result.failed) {
        console.log(
          `[refresh] ${result.refreshed} refreshed, ${result.failed} failed, ` +
            `${result.skipped} skipped`
        );
      }
    } catch (e) {
      console.warn("[refresh] cycle failed:", e.message);
    } finally {
      running = false;
    }
  }, interval);

  timer.unref();
  return { started: true, intervalMs: interval };
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  return { stopped: true };
}

/* What a page needs to say how old its information is. */
async function freshnessFor(name) {
  const row = await store.getPackage(name);
  if (!row) return null;
  const contributors = await db.one(
    "select max(retrieved_at) as at from package_contributors where package_name = $1",
    [name]
  );
  const downloads = await db.one(
    "select max(retrieved_at) as at from download_snapshots where package_name = $1",
    [name]
  );
  const failure = failures.get(name);

  return {
    packageFetchedAt: row.fetched_at,
    contributorsAt: contributors ? contributors.at : null,
    downloadsAt: downloads ? downloads.at : null,
    stale: isStale(row.fetched_at, MAX_AGE_MS.packument),
    // Surfaced so a page can say "last checked X, and the last check failed"
    // rather than quietly showing old data as current.
    lastFailure: failure
      ? { reason: failure.reason, attempts: failure.count, retryAt: new Date(failure.until).toISOString() }
      : null,
  };
}

const _resetBackoff = () => failures.clear();

module.exports = {
  refreshPackage,
  refreshCycle,
  freshnessFor,
  start,
  stop,
  isStale,
  MAX_AGE_MS,
  _resetBackoff,
  _failures: failures,
};
