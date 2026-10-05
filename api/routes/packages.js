/* Package reads: search, the featured strip, one package, and its releases. */

"use strict";

const { send, notFound, badRequest, forbidden } = require("../lib/http");
const validate = require("../lib/validate");
const npm = require("../lib/npm");
const github = require("../lib/github");
const db = require("../lib/db");
const store = require("../lib/store");
const present = require("../lib/present");
const solana = require("../lib/solana");
const lifecycle = require("../lib/lifecycle");
const refresh = require("../lib/refresh");
const cache = require("../lib/cache");

/* A sample of widely used packages, shown on the homepage when nothing has
   been verified yet so the grid demonstrates real data rather than invented
   placeholders. Every figure beside them is read live from npm, and each is
   labelled as unclaimed, because none of them has been verified here. */
const SAMPLE = [
  "express",
  "vite",
  "zod",
  "prettier",
  "tailwindcss",
  "fastify",
];

async function rowsFor(names) {
  if (!names.length) return new Map();
  // One query for the whole page rather than one per card.
  const placeholders = names.map((_, i) => `$${i + 1}`).join(",");
  const rows = await db.many(
    `select p.*, u.github_login as owner_login, u.avatar_url as owner_avatar
       from packages p
       left join users u on u.id = p.verified_owner_id
      where p.name in (${placeholders})`,
    names
  );
  return new Map(rows.map((r) => [r.name, r]));
}

async function search(req, res, ctx) {
  const q = validate.searchQuery(ctx.url.searchParams.get("q"));
  const size = validate.limit(ctx.url.searchParams.get("limit"), 12, 25);
  const results = await npm.search(q, size);
  const rows = await rowsFor(results.map((r) => r.name));
  send(req, res, 200, {
    query: q,
    count: results.length,
    results: results.map((r) => present.packageCard(r, rows.get(r.name))),
  });
}

async function featured(req, res) {
  const verifiedRows = await store.verifiedPackages(8);

  const verified = verifiedRows.map((row) =>
    present.packageCard(
      {
        name: row.name,
        description: row.description,
        latestVersion: row.latest_version,
        license: row.license,
        keywords: row.keywords || [],
        repo:
          row.repo_owner && row.repo_name
            ? { owner: row.repo_owner, repo: row.repo_name, url: row.repo_url }
            : null,
        modifiedAt: row.npm_modified_at,
        versionCount: row.version_count,
      },
      row
    )
  );

  // Only fill the grid when there is nothing verified to show. Live data for
  // real packages, each marked unclaimed.
  let sample = [];
  if (verified.length < 4) {
    sample = await cache.through("featured:sample", 300000, async () => {
      const loaded = await Promise.all(
        SAMPLE.map(async (name) => {
          try {
            const pkg = await npm.packument(name);
            const dl = await npm.downloadsPoint(name, "last-week");
            return present.packageCard(pkg, null, {
              downloadsWeekly: dl ? dl.downloads : null,
            });
          } catch (e) {
            // One unreachable package must not empty the whole strip.
            return null;
          }
        })
      );
      return loaded.filter(Boolean);
    });
  }

  send(req, res, 200, {
    verified,
    sample,
    sampleNote:
      "read live from the npm registry. These packages have not been claimed or verified here.",
  });
}

async function detail(req, res, ctx) {
  const name = validate.packageName(ctx.params.name);
  const pkg = await npm.packument(name);

  // Keep the local copy in step with what npm just said, but only for a
  // package the product already knows: a stranger's lookup should not create
  // rows, or the table becomes a crawl of the registry.
  let row = await store.getPackage(name);
  if (row) row = await store.upsertPackage(pkg);
  if (row) {
    row = await db.one(
      `select p.*, u.github_login as owner_login, u.avatar_url as owner_avatar
         from packages p left join users u on u.id = p.verified_owner_id
        where p.name = $1`,
      [name]
    );
  }

  const claim = row
    ? await db.one(
        `select * from claims where package_name = $1
          order by (status = 'verified') desc, updated_at desc limit 1`,
        [name]
      )
    : null;

  const owner = row && row.verified_owner_id
    ? await db.one("select * from users where id = $1", [row.verified_owner_id])
    : null;

  // The repository shown is the one npm declares, labelled as declared. When
  // a claim has proved control of it, the page says so through the
  // verification block rather than by styling the link differently.
  const declared = pkg.repo;
  const [repo, contributors, githubReleases, commits, week, month, series] =
    await Promise.all([
      declared ? github.publicRepository(declared.owner, declared.repo) : null,
      declared ? github.contributors(declared.owner, declared.repo, 12) : [],
      declared ? github.releases(declared.owner, declared.repo, 5) : [],
      declared ? github.recentCommits(declared.owner, declared.repo, 5) : [],
      npm.downloadsPoint(name, "last-week"),
      npm.downloadsPoint(name, "last-month"),
      npm.downloadsRange(name, "last-month"),
    ]);

  const releases = row ? await store.releasesFor(name, 20) : [];

  /* Persist what the upstreams just said, but only for a package the product
     already tracks. A stranger's lookup must not turn this into a crawl of
     the registry, and a graph built from drive-by reads would be noise. */
  if (row) {
    if (repo && repo.id) {
      await store.upsertRepository(repo);
      if (Array.isArray(contributors) && contributors.length) {
        await store.recordContributors(name, repo.id, contributors);
      }
    }
    if (week) await store.recordDownloads(name, "last-week", week);
    if (month) await store.recordDownloads(name, "last-month", month);
  }

  // The trail is public: how a package came to be verified is part of what
  // the verification means.
  const history = row ? await store.verificationHistory(name, 12) : [];

  // Only the verified owner's wallet says anything about this package.
  const ownerWallets = owner ? await store.walletsFor(owner.id) : [];

  /* One derived state, from the facts, so the package page, the dashboard and
     the connect flow cannot disagree about where a package has got to. */
  const freshness = row ? await refresh.freshnessFor(name) : null;
  const registration = row ? await store.latestRegistration(name) : null;
  const clusterState = await solana.clusterStatus();
  const state = lifecycle.stateFor(
    lifecycle.factsFrom({
      claim,
      pkg: row,
      wallets: ownerWallets,
      registration,
      registrationAvailable: clusterState.canRegister,
    })
  );

  send(req, res, 200, {
    package: present.packageDetail({
      pkg,
      row,
      claim,
      owner,
      repo,
      contributors,
      githubReleases,
      commits,
      downloads: { week, month },
      series,
      releases,
      ownerWallets,
      history,
      state,
      freshness,
      identity: {
        // Deterministic and shown for every package, with the deployment
        // state attached so the page can say whether it exists yet.
        derived: solana.identityAddress(name),
        registeredAddress: row && row.identity_pda ? row.identity_pda : null,
        registeredTx: row && row.identity_tx ? row.identity_tx : null,
        launchedAt: row && row.launched_at ? row.launched_at : null,
      },
    }),
  });
}

async function versions(req, res, ctx) {
  const name = validate.packageName(ctx.params.name);
  const pkg = await npm.packument(name);
  const recorded = await store.releasesFor(name, 500);
  const byVersion = new Map(recorded.map((r) => [r.version, r]));
  send(req, res, 200, {
    name: pkg.name,
    latestVersion: pkg.latestVersion,
    count: pkg.releases.length,
    versions: pkg.releases.map((r) => {
      const local = byVersion.get(r.version);
      return {
        version: r.version,
        publishedAt: r.publishedAt,
        unpublished: !r.present,
        recordHash: local ? local.record_hash : null,
        onchainTx: local ? local.onchain_tx : null,
      };
    }),
  });
}

async function contributors(req, res, ctx) {
  const name = validate.packageName(ctx.params.name);
  const pkg = await npm.packument(name);
  if (!pkg.repo) {
    throw notFound("this package declares no GitHub repository");
  }
  const list = await github.contributors(pkg.repo.owner, pkg.repo.repo, 30);
  send(req, res, 200, {
    repo: pkg.repo,
    rateLimited: Boolean(list && list.rateLimited),
    contributors: Array.isArray(list) ? list : [],
  });
}

module.exports = { search, featured, detail, versions, contributors, SAMPLE };

/* Refresh one package's imported information on demand.

   Restricted to the verified owner. Re-reading npm and GitHub on a stranger's
   request would be an easy way to make this server spend its rate limit for
   somebody else. */
async function refreshOne(req, res, ctx) {
  const session = require("../lib/session");
  const refresh = require("../lib/refresh");
  const current = await session.require(req);
  const name = validate.packageName(ctx.params.name);

  const row = await store.getPackage(name);
  if (!row) throw notFound("that package is not tracked here");
  if (row.verified_owner_id !== current.user.id) {
    throw forbidden("only the developer who verified a package can refresh it");
  }

  const result = await refresh.refreshPackage(name, { force: true });
  await store.audit("package.refresh", {
    userId: current.user.id,
    login: current.user.login,
    subject: name,
    detail: { refreshed: result.refreshed || [], failed: result.failed || [] },
  });

  send(req, res, 200, {
    ...result,
    freshness: await refresh.freshnessFor(name),
  });
}

module.exports.refreshOne = refreshOne;

/* Discovery.

   Every view here is built from what this product has actually indexed, which
   is only the packages somebody has connected. That is a small set and the
   response says so: claiming to index npm would be a lie that the first empty
   page would expose anyway.

   There is deliberately no "trending". Trending needs a measured rate of
   change, which needs a run of download snapshots taken over time. The
   snapshots are being collected; until there are enough of them to compute a
   rate honestly, the view does not exist. */
const DISCOVERY_VIEWS = {
  verified: {
    label: "verified publishers",
    description: "packages whose publisher proved authority to publish them",
    sql: `select p.*, u.github_login as owner_login, u.avatar_url as owner_avatar
            from packages p
            join users u on u.id = p.verified_owner_id
           where p.verified_owner_id is not null
           order by p.verified_at desc
           limit $1`,
  },
  launched: {
    label: "recently launched",
    description: "packages with an identity account confirmed on the cluster",
    sql: `select p.*, u.github_login as owner_login, u.avatar_url as owner_avatar
            from packages p
            left join users u on u.id = p.verified_owner_id
           where p.identity_pda is not null
           order by p.launched_at desc
           limit $1`,
  },
  updated: {
    label: "recently updated",
    description: "connected packages by their most recent publish to npm",
    sql: `select p.*, u.github_login as owner_login, u.avatar_url as owner_avatar
            from packages p
            left join users u on u.id = p.verified_owner_id
           where p.npm_modified_at is not null
           order by p.npm_modified_at desc
           limit $1`,
  },
  active: {
    label: "active development",
    description:
      "connected packages whose declared repository was pushed to most recently, as GitHub reported it",
    sql: `select p.*, u.github_login as owner_login, u.avatar_url as owner_avatar,
                 r.pushed_at
            from packages p
            left join users u on u.id = p.verified_owner_id
            join repositories r on r.full_name = p.repo_owner || '/' || p.repo_name
           where r.pushed_at is not null
           order by r.pushed_at desc
           limit $1`,
  },
  downloads: {
    label: "most downloaded",
    description:
      "connected packages by the most recent weekly download figure npm reported",
    sql: `select p.*, u.github_login as owner_login, u.avatar_url as owner_avatar,
                 d.downloads
            from packages p
            left join users u on u.id = p.verified_owner_id
            join (
              select distinct on (package_name) package_name, downloads
                from download_snapshots
               where period = 'last-week'
               order by package_name, retrieved_at desc
            ) d on d.package_name = p.name
           order by d.downloads desc
           limit $1`,
  },
};

async function discover(req, res, ctx) {
  const view = String(ctx.url.searchParams.get("view") || "verified");
  const limit = validate.limit(ctx.url.searchParams.get("limit"), 12, 50);

  /* hasOwnProperty, not a plain lookup: DISCOVERY_VIEWS["__proto__"] walks
     the prototype chain and returns a truthy object, so a plain check would
     let that through and then build a query from undefined. */
  const chosen = Object.prototype.hasOwnProperty.call(DISCOVERY_VIEWS, view)
    ? DISCOVERY_VIEWS[view]
    : null;
  if (!chosen || typeof chosen.sql !== "string") {
    throw badRequest(
      "unknown_view",
      `no such view. Available: ${Object.keys(DISCOVERY_VIEWS).join(", ")}`
    );
  }

  const rows = await db.many(chosen.sql, [limit]);
  const indexed = await db.one("select count(*)::int as n from packages");
  const verified = await db.one(
    "select count(*)::int as n from packages where verified_owner_id is not null"
  );

  send(req, res, 200, {
    view,
    label: chosen.label,
    description: chosen.description,
    views: Object.entries(DISCOVERY_VIEWS).map(([key, v]) => ({
      key,
      label: v.label,
      description: v.description,
    })),
    count: rows.length,
    results: rows.map((row) =>
      present.packageCard(
        {
          name: row.name,
          description: row.description,
          latestVersion: row.latest_version,
          license: row.license,
          keywords: row.keywords || [],
          repo:
            row.repo_owner && row.repo_name
              ? { owner: row.repo_owner, repo: row.repo_name, url: row.repo_url }
              : null,
          modifiedAt: row.npm_modified_at,
          versionCount: row.version_count,
        },
        row,
        { downloadsWeekly: row.downloads === undefined ? null : Number(row.downloads) }
      )
    ),
    /* The scope, stated rather than implied. This product indexes what people
       have connected to it and nothing else. */
    scope: {
      indexedPackages: indexed.n,
      verifiedPackages: verified.n,
      note:
        "Packages indexes only the packages somebody has connected here. It is not a mirror of the npm registry: use search to reach any package on npm.",
    },
  });
}

module.exports.discover = discover;
module.exports.DISCOVERY_VIEWS = DISCOVERY_VIEWS;
