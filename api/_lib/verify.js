/* Verification policy.

   The rule this file exists to enforce:

     Control of a GitHub repository does NOT prove authority to publish an npm
     package. Anyone can put any repository url in their package.json, and the
     npm registry does not check it. A repository link is therefore a claim
     about provenance, not a proof of it.

   So four independent facts are collected, each one checked rather than
   assumed, and only two combinations of them reach "verified":

     repo_control            the signed-in GitHub user can push to the
                             repository the package declares. Checked against
                             the GitHub API with that user's own token.

     trusted_publisher       npm's own publish attestation for a released
                             version names that repository, by GitHub's
                             immutable numeric repository id, as the place the
                             tarball was built. npm only issues this for an
                             OIDC publish from that repository, so the
                             registry itself is vouching for the link.

     publish_proof           a nonce this server issued appears in a version
                             manifest on the registry. Only someone who can
                             run "npm publish" for that package can put it
                             there, so this proves publish authority directly
                             and needs no repository at all.

     maintainer_email_match  an npm maintainer's email equals one of the
                             GitHub account's verified emails. A useful
                             signal, never sufficient: a maintainer email is
                             public on the registry, and matching it proves
                             only that the same address is on both accounts.

   verified  <=  publish_proof
             OR  (repo_control AND trusted_publisher)

   repo_control on its own gives the status "repo_linked", which the product
   shows as exactly that and never as verified. */

"use strict";

const crypto = require("crypto");
const db = require("./db");
const npm = require("./npm");
const github = require("./github");
const { badRequest, conflict, notFound } = require("./http");

const CHALLENGE_TTL_MS = 30 * 60 * 1000;
const WALLET_CHALLENGE_TTL_MS = 10 * 60 * 1000;

/* The field a claimant adds to package.json, and the keyword form, which is
   easier to add to an existing publish pipeline. Either carries the proof. */
const PROOF_FIELD = "packagesVerification";
const PROOF_KEYWORD_PREFIX = "packages-verify-";

/* ------------------------------------------------------------ challenges -- */

async function issueChallenge(kind, userId, packageName) {
  const nonce =
    kind === "wallet"
      ? crypto.randomBytes(16).toString("base64url")
      : crypto.randomBytes(12).toString("hex");
  const ttl = kind === "wallet" ? WALLET_CHALLENGE_TTL_MS : CHALLENGE_TTL_MS;
  const id = crypto.randomUUID();
  // Any earlier unused challenge of the same kind for the same target is
  // dropped, so a user cannot accumulate a drawer of valid nonces.
  await db.query(
    `delete from challenges
      where user_id = $1 and kind = $2
        and coalesce(package_name, '') = coalesce($3, '')
        and consumed_at is null`,
    [userId, kind, packageName || null]
  );
  await db.query(
    `insert into challenges (id, kind, nonce, user_id, package_name, expires_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [id, kind, nonce, userId, packageName || null, new Date(Date.now() + ttl).toISOString()]
  );
  return { id, nonce, expiresAt: new Date(Date.now() + ttl).toISOString() };
}

async function readChallenge(kind, userId, packageName) {
  const row = await db.one(
    `select * from challenges
      where user_id = $1 and kind = $2
        and coalesce(package_name, '') = coalesce($3, '')
        and consumed_at is null
      order by created_at desc
      limit 1`,
    [userId, kind, packageName || null]
  );
  if (!row) throw badRequest("no_challenge", "ask for a challenge first");
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    throw badRequest("challenge_expired", "that challenge has expired, ask for a new one");
  }
  return row;
}

const consumeChallenge = (id) =>
  db.query("update challenges set consumed_at = now() where id = $1", [id]);

/* ----------------------------------------------------------- repo control -- */

/* Does this GitHub user have push access to owner/repo?

   Three reads, in order of directness, because the "permissions" block on a
   repository read is only present for some token scopes. A token with no
   repository scope at all can still read it for a public repository, but if
   GitHub omits it the answer is "inconclusive" rather than "no": telling a
   maintainer they do not own their own repository because of a scope detail
   would be wrong. */
async function checkRepoControl(owner, repo, token, login, readers) {
  /* The read is taken as a dependency so each GitHub response shape can be
     driven in a test. It defaults to the real one, so production behaviour is
     unchanged and nothing in the running product is mocked. */
  const readRepository = (readers && readers.repository) || github.repository;
  const info = await readRepository(owner, repo, token);
  if (info.missing) {
    return { ok: false, reason: "repo_not_found", repo: null };
  }
  if (info.rateLimited) {
    return { ok: false, reason: "github_rate_limited", resetAt: info.resetAt, repo: null };
  }
  if (info.denied) {
    return { ok: false, reason: "github_denied", repo: null };
  }

  if (info.permissions) {
    const push = Boolean(info.permissions.push || info.permissions.admin || info.permissions.maintain);
    return {
      ok: push,
      reason: push ? "push_permission" : "no_push_permission",
      permission: info.permissions.admin
        ? "admin"
        : info.permissions.maintain
        ? "maintain"
        : info.permissions.push
        ? "push"
        : "read",
      repo: info,
    };
  }

  // The repository is owned by this user's own account: owner login equality
  // is decisive for a user-owned repository.
  if (info.ownerType === "User" && login && info.owner && info.owner.toLowerCase() === login.toLowerCase()) {
    return { ok: true, reason: "owner_account", permission: "admin", repo: info };
  }

  return {
    ok: false,
    reason: "permission_unknown",
    permission: null,
    repo: info,
  };
}

/* ------------------------------------------------------ trusted publisher -- */

/* Does npm attest that a released version was built from this repository?

   Compares GitHub's numeric repository id, not the name. A repository can be
   renamed and its old full name claimed by somebody else, so a name match is
   not a safe equality test; the id never changes.

   Up to three of the most recent versions are tried, because provenance is
   per-version and a project may have added it partway through its history. */
async function checkTrustedPublisher(pkg, repoInfo) {
  if (!repoInfo || !repoInfo.id) {
    return { ok: false, reason: "no_repo_to_compare" };
  }
  const candidates = pkg.releases
    .filter((r) => r.present)
    .slice(0, 3)
    .map((r) => r.version);
  if (pkg.latestVersion && !candidates.includes(pkg.latestVersion)) {
    candidates.unshift(pkg.latestVersion);
  }

  const seen = [];
  for (const version of candidates) {
    const prov = await npm.provenance(pkg.name, version);
    if (!prov.attested) {
      seen.push({ version, attested: false, reason: prov.reason || null });
      continue;
    }
    if (!prov.repositoryId) {
      seen.push({ version, attested: true, reason: "provenance names no repository id" });
      continue;
    }
    if (prov.repositoryId === repoInfo.id) {
      return {
        ok: true,
        reason: "provenance_repository_id_match",
        version,
        repositoryId: prov.repositoryId,
        workflow: prov.workflowPath,
        commit: prov.commit,
        attempts: seen,
      };
    }
    seen.push({
      version,
      attested: true,
      reason: "provenance names a different repository",
      repositoryId: prov.repositoryId,
    });
  }
  return { ok: false, reason: "no_matching_provenance", attempts: seen };
}

/* --------------------------------------------------------- publish proof -- */

/* Is the issued nonce present in a published version manifest?

   Scans the most recent versions rather than only the latest, so a proof
   release that is tagged "next" or published alongside a hotfix still counts.
   Only versions published after the challenge was issued are considered: an
   older manifest cannot contain a nonce that did not exist yet, and accepting
   one would mean a stale proof could be replayed. */
async function checkPublishProof(pkg, nonce, issuedAt) {
  const since = new Date(issuedAt).getTime();
  const candidates = pkg.releases
    .filter((r) => r.present)
    .filter((r) => !r.publishedAt || Date.parse(r.publishedAt) >= since - 60000)
    .slice(0, 5);

  if (!candidates.length) {
    return { ok: false, reason: "no_version_published_since_challenge" };
  }

  for (const release of candidates) {
    const manifest = await npm.versionManifest(pkg.name, release.version);
    if (!manifest) continue;
    const field = manifest[PROOF_FIELD];
    const keywords = Array.isArray(manifest.keywords) ? manifest.keywords : [];
    const expectedKeyword = `${PROOF_KEYWORD_PREFIX}${nonce}`;

    const fieldMatch =
      typeof field === "string" && timingSafeEqual(field.trim(), nonce);
    const keywordMatch = keywords.some(
      (k) => typeof k === "string" && timingSafeEqual(k.trim(), expectedKeyword)
    );

    if (fieldMatch || keywordMatch) {
      return {
        ok: true,
        reason: fieldMatch ? "manifest_field" : "manifest_keyword",
        version: release.version,
        publishedAt: release.publishedAt,
      };
    }
  }
  return { ok: false, reason: "nonce_not_found_in_recent_versions", checked: candidates.map((c) => c.version) };
}

// The nonce is not a secret that leaks through timing in any meaningful way,
// but comparing it in constant time costs nothing and keeps the habit.
function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/* ------------------------------------------------- maintainer email match -- */

async function checkMaintainerEmail(pkg, token) {
  const emails = await github.verifiedEmails(token);
  if (!emails.length) return { ok: false, reason: "no_verified_github_email" };
  for (const m of pkg.maintainers) {
    if (m.email && emails.includes(String(m.email).toLowerCase())) {
      return { ok: true, maintainer: m.username, reason: "verified_email_match" };
    }
  }
  return { ok: false, reason: "no_maintainer_email_matches" };
}

/* ------------------------------------------------------------- the status -- */

/* The one place the rule lives. Called with a claim row's four booleans. */
function statusFor(claim) {
  if (claim.publish_proof) return "verified";
  if (claim.repo_control && claim.trusted_publisher) return "verified";
  if (claim.repo_control) return "repo_linked";
  return "pending";
}

/* What a claim still needs, in words the dashboard can render directly. */
function nextStepFor(claim) {
  if (statusFor(claim) === "verified") return null;
  if (!claim.repo_control) {
    return "link the repository the package declares, from an account that can push to it";
  }
  if (!claim.trusted_publisher) {
    return "npm has no publish attestation linking that repository to this package, so prove publish authority by publishing a version carrying your proof string";
  }
  return "prove publish authority";
}

/* Human-readable evidence for every surface that explains a status, so the
   wording is identical on the dashboard and on the public package page. */
function evidenceFor(claim) {
  return [
    {
      key: "repo_control",
      label: "repository control",
      passed: Boolean(claim.repo_control),
      detail: claim.repo_control
        ? `GitHub reports ${claim.repo_permission || "push"} permission for this account`
        : "not established",
      sufficientAlone: false,
    },
    {
      key: "trusted_publisher",
      label: "npm publish attestation",
      passed: Boolean(claim.trusted_publisher),
      detail: claim.trusted_publisher
        ? `npm attests a release was built from ${claim.trusted_publisher_repo || "this repository"}`
        : "npm has published no provenance linking this package to this repository",
      sufficientAlone: false,
    },
    {
      key: "publish_proof",
      label: "publish authority",
      passed: Boolean(claim.publish_proof),
      detail: claim.publish_proof
        ? `a proof string issued here appeared in version ${claim.publish_proof_version}`
        : "no published version carries a proof string issued here",
      sufficientAlone: true,
    },
    {
      key: "maintainer_email_match",
      label: "maintainer email",
      passed: Boolean(claim.maintainer_email_match),
      detail: claim.maintainer_email_match
        ? `an npm maintainer email matches a verified email on this GitHub account (${claim.matched_maintainer})`
        : "no npm maintainer email matches a verified email on this GitHub account",
      // Stated explicitly rather than left implied: this is a signal only.
      sufficientAlone: false,
      signalOnly: true,
    },
  ];
}

/* ----------------------------------------------------------- persistence -- */

async function getClaim(packageName, userId) {
  return db.one(
    "select * from claims where package_name = $1 and user_id = $2",
    [packageName, userId]
  );
}

async function requireClaim(packageName, userId) {
  const claim = await getClaim(packageName, userId);
  if (!claim) {
    throw notFound("import that package first");
  }
  return claim;
}

/* Writes the four booleans back and recomputes the status. When a claim
   reaches verified it also takes ownership of the package row, which is the
   only place that happens. A package already verified by somebody else is a
   conflict rather than a silent overwrite. */
async function applyClaimUpdate(claim, patch) {
  const merged = { ...claim, ...patch };
  const status = statusFor(merged);
  const verifiedAt =
    status === "verified" ? claim.verified_at || new Date().toISOString() : null;

  /* One transaction. Marking a claim verified and recording who owns the
     package are two statements, and a crash between them would leave a claim
     saying "verified" with nobody owning the package, or a package owned by
     an account whose claim does not say so. Either is a lie about the world
     that no later read could detect. */
  return db.transaction(async (tx) => {
    const row = await tx.one(
      `update claims set
       repo_control = $2, repo_control_at = $3, repo_permission = $4,
       trusted_publisher = $5, trusted_publisher_repo = $6,
       publish_proof = $7, publish_proof_version = $8, publish_proof_at = $9,
       maintainer_email_match = $10, matched_maintainer = $11,
       status = $12, verified_at = $13, updated_at = now()
     where id = $1
     returning *`,
    [
      claim.id,
      Boolean(merged.repo_control),
      merged.repo_control_at || null,
      merged.repo_permission || null,
      Boolean(merged.trusted_publisher),
      merged.trusted_publisher_repo || null,
      Boolean(merged.publish_proof),
      merged.publish_proof_version || null,
      merged.publish_proof_at || null,
      Boolean(merged.maintainer_email_match),
        merged.matched_maintainer || null,
        status,
        verifiedAt,
      ]
    );

    if (status === "verified") {
      /* Locked, not merely read. Without FOR UPDATE two accounts proving the
         same package at the same moment can both see no owner and both write
         themselves in, and the second silently wins. The lock makes the
         second wait, then see the first. */
      const pkg = await tx.one(
        "select verified_owner_id from packages where name = $1 for update",
        [claim.package_name]
      );
      if (pkg && pkg.verified_owner_id && pkg.verified_owner_id !== claim.user_id) {
        throw conflict(
          "already_verified",
          "another account has already verified this package"
        );
      }
      await tx.query(
        `update packages set verified_owner_id = $2,
                verified_at = coalesce(verified_at, now())
           where name = $1`,
        [claim.package_name, claim.user_id]
      );
    }

    return row;
  });
}

module.exports = {
  issueChallenge,
  readChallenge,
  consumeChallenge,
  checkRepoControl,
  checkTrustedPublisher,
  checkPublishProof,
  checkMaintainerEmail,
  statusFor,
  nextStepFor,
  evidenceFor,
  getClaim,
  requireClaim,
  applyClaimUpdate,
  timingSafeEqual,
  PROOF_FIELD,
  PROOF_KEYWORD_PREFIX,
  CHALLENGE_TTL_MS,
  WALLET_CHALLENGE_TTL_MS,
};

/* --------------------------------------------------------- revocation --- */

/* Withdraw a verification without erasing that it happened.

   Three things must be true afterwards: the package is no longer claimed by
   anyone, so somebody else can prove it; the claim row reflects that; and the
   append-only trail still shows the verification and its withdrawal. A
   verification that could be deleted without trace would make the trail
   worthless, because an attacker who gained an account could prove a package,
   act on it, and tidy up.

   `reason` is recorded verbatim. "owner_withdrew" and "admin_revoked" are
   different facts and the trail keeps them apart. */
async function revokeVerification({ packageName, userId, actorLogin, reason }) {
  return db.transaction(async (tx) => {
    const claim = await tx.one(
      "select * from claims where package_name = $1 and user_id = $2 for update",
      [packageName, userId]
    );
    if (!claim) return { revoked: false, reason: "no_claim" };

    const wasVerified = claim.status === "verified";

    await tx.query(
      `update claims set
         status = 'revoked',
         repo_control = false,
         trusted_publisher = false,
         publish_proof = false,
         verified_at = null,
         updated_at = now()
       where id = $1`,
      [claim.id]
    );

    // Release the package only if this account held it, so a revocation can
    // never strip an owner who is not the subject.
    await tx.query(
      `update packages set verified_owner_id = null, verified_at = null
        where name = $1 and verified_owner_id = $2`,
      [packageName, userId]
    );

    await tx.query(
      `insert into verification_events
         (id, claim_id, package_name, user_id, kind, passed, reason, detail)
       values ($1, $2, $3, $4, 'revoked', false, $5, $6)`,
      [
        crypto.randomUUID(),
        claim.id,
        packageName,
        userId,
        reason || "revoked",
        JSON.stringify({ wasVerified, actor: actorLogin || null }),
      ]
    );

    return { revoked: true, wasVerified };
  });
}

module.exports.revokeVerification = revokeVerification;
