/* Response shaping.

   One function per public shape, so a field means the same thing on every
   endpoint that returns it. The rule throughout: a value npm or GitHub did not
   report is null, and null renders as a dash. Nothing here computes, estimates
   or rounds a figure into existence. */

"use strict";

const verify = require("./verify");

/* The card shape, used by search results, the explore grid and the homepage.
   `claimed` and `verified` are separate: a package can be known to the
   product without anybody having verified it, and the front end must be able
   to tell those apart without inferring. */
function packageCard(pkg, row, extra) {
  const e = extra || {};
  return {
    name: pkg.name,
    description: pkg.description || null,
    latestVersion: pkg.latestVersion || pkg.version || null,
    license: pkg.license || null,
    keywords: (pkg.keywords || []).slice(0, 6),
    repo: pkg.repo || null,
    publishedAt: pkg.modifiedAt || pkg.publishedAt || null,
    versionCount: pkg.versionCount ?? null,
    downloadsWeekly: e.downloadsWeekly ?? pkg.downloadsWeekly ?? null,
    dependents: pkg.dependents ?? null,
    deprecated: pkg.deprecated || null,
    claimed: Boolean(row),
    verified: Boolean(row && row.verified_owner_id),
    verifiedAt: row && row.verified_at ? row.verified_at : null,
    owner:
      row && row.owner_login
        ? { login: row.owner_login, avatarUrl: row.owner_avatar || null }
        : null,
    launchedAt: row && row.launched_at ? row.launched_at : null,
    identityAddress: row && row.identity_pda ? row.identity_pda : null,
  };
}

/* The full package page. `verification` is always present and always explains
   itself: when nothing has been claimed it says so rather than being absent,
   so the page never has to guess what an empty field means. */
function packageDetail({ pkg, row, claim, owner, repo, contributors, downloads, series, releases, identity, githubReleases, commits, ownerWallets, history, state, freshness }) {
  return {
    name: pkg.name,
    description: pkg.description,
    latestVersion: pkg.latestVersion,
    distTags: pkg.distTags || {},
    license: pkg.license,
    homepage: pkg.homepage,
    keywords: pkg.keywords || [],
    maintainers: pkg.maintainers || [],
    createdAt: pkg.createdAt,
    modifiedAt: pkg.modifiedAt,
    versionCount: pkg.versionCount,
    unpackedSize: pkg.unpackedSize,
    fileCount: pkg.fileCount,
    // A fact npm reports, not a judgement made here.
    deprecated: pkg.deprecated || null,
    integrity: pkg.integrity || null,
    shasum: pkg.shasum || null,
    tarball: pkg.tarball || null,
    engines: pkg.engines || null,
    npmUrl: `https://www.npmjs.com/package/${pkg.name}`,

    // Declared by the publisher in package.json and not checked by npm, which
    // is why it is labelled as declared everywhere it is shown.
    declaredRepo: pkg.repo || null,
    repoDirectory: pkg.repoDirectory || null,

    publisher: pkg.publisher || null,
    hasProvenance: Boolean(pkg.hasProvenance),

    downloads: {
      lastWeek: downloads && downloads.week ? downloads.week.downloads : null,
      lastMonth: downloads && downloads.month ? downloads.month.downloads : null,
      series: series || null,
    },

    releases: (pkg.releases || []).slice(0, 60),
    recordedReleases: releases || [],

    repository: repo && !repo.error && !repo.missing ? repo : null,
    repositoryError: repo && (repo.error || repo.missing) ? "github did not return that repository" : null,
    contributors: Array.isArray(contributors) ? contributors : [],
    contributorsRateLimited: Boolean(contributors && contributors.rateLimited),
    githubReleases: githubReleases || [],
    commits: commits || [],

    /* The single derived lifecycle state, with what it means and what comes
       next, so no surface re-infers it. */
    lifecycle: state
      ? {
          state,
          description: require("./lifecycle").DESCRIPTIONS[state] || null,
          next: require("./lifecycle").nextActionFor(state),
        }
      : null,
    /* When each piece of imported information was last successfully read, so
       the page can say how old it is rather than implying it is current. */
    freshness: freshness || null,
    verification: verificationSummary(row, claim, owner, ownerWallets),
    /* Append-only: every check that has run against this package, pass or
       fail. Public, because how a package came to be verified is part of
       what the verification means. */
    verificationHistory: (history || []).map((h) => ({
      kind: h.kind,
      passed: h.passed,
      reason: h.reason,
      actor: h.actor,
      at: h.created_at,
    })),
    identity: identity || null,
  };
}

/* The one explanation of a package's verification state, shared by the public
   package page and the dashboard so the two can never disagree. */
function verificationSummary(row, claim, owner, wallets) {
  if (!claim) {
    return {
      status: row && row.verified_owner_id ? "verified" : "unclaimed",
      verified: Boolean(row && row.verified_owner_id),
      verifiedAt: row && row.verified_at ? row.verified_at : null,
      owner: owner ? { login: owner.github_login, avatarUrl: owner.avatar_url, profileUrl: owner.profile_url } : null,
      evidence: [],
      walletVerified: Boolean(wallets && wallets.length),
      wallets: (wallets || []).map((w) => ({ pubkey: w.pubkey, cluster: w.cluster, verifiedAt: w.verified_at })),
      nextStep: null,
      explanation:
        row && row.verified_owner_id
          ? "a developer proved publish authority for this package"
          : "nobody has claimed this package here yet",
    };
  }

  const status = verify.statusFor(claim);
  return {
    status,
    verified: status === "verified",
    verifiedAt: claim.verified_at || null,
    owner: owner ? { login: owner.github_login, avatarUrl: owner.avatar_url, profileUrl: owner.profile_url } : null,
    evidence: verify.evidenceFor(claim),
    walletVerified: Boolean(wallets && wallets.length),
    wallets: (wallets || []).map((w) => ({ pubkey: w.pubkey, cluster: w.cluster, verifiedAt: w.verified_at })),
    nextStep: verify.nextStepFor(claim),
    explanation: explain(status),
  };
}

function explain(status) {
  if (status === "verified") {
    return "publish authority for this package was proved, either by a proof string in a published version or by npm's own attestation that a release was built from the linked repository";
  }
  if (status === "repo_linked") {
    return "a developer has proved they control the repository this package declares. That is not the same as being able to publish it, so this package is linked but not verified";
  }
  return "a claim has been started but no proof has been accepted yet";
}

/* The activity feed. Release entries come straight from the registry's own
   timestamps; product entries come from the events table. Each carries its
   source so the page can say where a line came from. */
function activityEntry(entry) {
  return {
    kind: entry.kind,
    source: entry.source,
    packageName: entry.packageName || null,
    version: entry.version || null,
    actor: entry.actor || null,
    at: entry.at || null,
    detail: entry.detail || null,
    url: entry.url || null,
  };
}

function userProfile(user, packages, wallets) {
  return {
    login: user.github_login,
    name: user.display_name || null,
    avatarUrl: user.avatar_url || null,
    profileUrl: user.profile_url || null,
    joinedAt: user.created_at || null,
    packages: packages || [],
    wallets: (wallets || []).map((w) => ({
      pubkey: w.pubkey,
      cluster: w.cluster,
      verifiedAt: w.verified_at,
    })),
  };
}

module.exports = {
  packageCard,
  packageDetail,
  verificationSummary,
  activityEntry,
  userProfile,
};
