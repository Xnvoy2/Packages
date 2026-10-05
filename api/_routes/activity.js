/* The activity feed.

   Two sources, each labelled:

     registry  real publish timestamps read from npm for the packages this
               product knows about. Read live rather than copied into a table,
               so a line is never a stale snapshot presented as current.

     packages  things this product did: an import, a repository link, a
               verification, a wallet proof.

   When no package has been imported there is nothing to report, and the
   endpoint says exactly that instead of filling the page. */

"use strict";

const { send } = require("../_lib/http");
const validate = require("../_lib/validate");
const db = require("../_lib/db");
const npm = require("../_lib/npm");
const github = require("../_lib/github");
const store = require("../_lib/store");
const present = require("../_lib/present");

async function feed(req, res, ctx) {
  const limit = validate.limit(ctx.url.searchParams.get("limit"), 30, 60);

  // Only packages somebody has imported. Scanning the registry at large would
  // be a different product and a far heavier one.
  const tracked = await db.many(
    `select name, repo_owner, repo_name from packages
      order by coalesce(verified_at, fetched_at) desc limit 12`
  );

  const entries = [];

  const releaseLists = await Promise.all(
    tracked.map(async (row) => {
      try {
        const pkg = await npm.packument(row.name);
        return pkg.releases
          .filter((r) => r.present && r.publishedAt)
          .slice(0, 6)
          .map((r) =>
            present.activityEntry({
              kind: "release.published",
              source: "registry",
              packageName: row.name,
              version: r.version,
              at: r.publishedAt,
              detail: `${row.name} ${r.version} published to npm`,
              url: `https://www.npmjs.com/package/${row.name}/v/${r.version}`,
            })
          );
      } catch (e) {
        // A package that has been unpublished or a registry blip must not
        // empty the whole feed.
        return [];
      }
    })
  );
  for (const list of releaseLists) entries.push(...list);

  // Development activity for the repositories those packages declare.
  const commitLists = await Promise.all(
    tracked
      .filter((row) => row.repo_owner && row.repo_name)
      .slice(0, 6)
      .map(async (row) => {
        try {
          const commits = await github.recentCommits(row.repo_owner, row.repo_name, 3);
          return commits
            .filter((c) => c.date)
            .map((c) =>
              present.activityEntry({
                kind: "commit.pushed",
                source: "github",
                packageName: row.name,
                actor: c.author,
                at: c.date,
                detail: c.message,
                url: c.url,
              })
            );
        } catch (e) {
          return [];
        }
      })
  );
  for (const list of commitLists) entries.push(...list);

  const events = await store.recentEvents(limit);
  for (const e of events) {
    entries.push(
      present.activityEntry({
        kind: e.kind,
        source: "packages",
        packageName: e.package_name,
        actor: e.actor_login,
        at: e.created_at,
        detail: describeEvent(e),
      })
    );
  }

  entries.sort((a, b) => {
    const ta = a.at ? Date.parse(a.at) : 0;
    const tb = b.at ? Date.parse(b.at) : 0;
    return tb - ta;
  });

  send(req, res, 200, {
    count: entries.length,
    trackedPackages: tracked.length,
    entries: entries.slice(0, limit),
    note:
      tracked.length === 0
        ? "no package has been imported yet, so there is no activity to read. Release activity appears here for packages that have been imported."
        : null,
  });
}

function describeEvent(e) {
  const name = e.package_name || "";
  const payload = e.payload || {};
  switch (e.kind) {
    case "package.imported":
      return `${name} imported${payload.latestVersion ? ` at ${payload.latestVersion}` : ""}`;
    case "package.repo_linked":
      return `${name} linked to ${payload.repo || "its repository"}`;
    case "package.verified":
      return payload.via === "publish_proof"
        ? `${name} verified by publish proof in ${payload.version}`
        : `${name} verified by npm publish attestation`;
    case "package.released":
      return `${name} claim withdrawn`;
    case "wallet.verified":
      return `a wallet was proved on ${payload.cluster || "devnet"}`;
    case "identity.registered":
      return `${name} identity registered onchain`;
    default:
      return e.kind;
  }
}

module.exports = { feed, describeEvent };
