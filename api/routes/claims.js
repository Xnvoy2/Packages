/* Importing a package and proving authority over it.

   The policy lives in lib/verify.js; this file is the plumbing around it.
   Nothing in here decides what counts as verified. */

"use strict";

const crypto = require("crypto");
const { send, readJson, badRequest, conflict, HttpError } = require("../lib/http");
const validate = require("../lib/validate");
const session = require("../lib/session");
const npm = require("../lib/npm");
const verify = require("../lib/verify");
const store = require("../lib/store");
const db = require("../lib/db");
const solana = require("../lib/solana");
const { claimRow } = require("./auth");

/* --------------------------------------------------------------- import -- */

/* Import a package: confirm it exists on npm, store what the registry says,
   and open a claim. Importing proves nothing and the response says so. */
async function importPackage(req, res) {
  const current = await session.require(req);
  const body = await readJson(req);
  const name = validate.packageName(body.name);

  const pkg = await npm.packument(name);
  await store.upsertPackage(pkg);

  const existing = await store.getPackage(name);
  if (existing && existing.verified_owner_id && existing.verified_owner_id !== current.user.id) {
    throw conflict(
      "already_verified",
      "another developer has already verified this package here"
    );
  }

  let claim = await verify.getClaim(name, current.user.id);
  if (!claim) {
    claim = await db.one(
      `insert into claims (id, package_name, user_id) values ($1, $2, $3) returning *`,
      [crypto.randomUUID(), name, current.user.id]
    );
    await store.recordEvent("package.imported", {
      packageName: name,
      actorLogin: current.user.login,
      payload: { latestVersion: pkg.latestVersion },
    });
  }

  // Record the release history as it stands now. Append-only, so re-importing
  // adds only versions published since.
  await store.recordReleases(name, pkg.releases.filter((r) => r.present), (release) =>
    solana.releaseRecordHash({
      packageName: name,
      version: release.version,
      publishedAt: release.publishedAt,
    })
  );

  send(req, res, 201, {
    imported: true,
    claim: claimRow(await store.claimView(name, current.user.id)),
    declaredRepo: pkg.repo,
    note:
      "importing records what npm reports. It proves nothing about who you are: the proofs below do that.",
  });
}

async function removeClaim(req, res, ctx) {
  const current = await session.require(req);
  const name = validate.packageName(ctx.params.name);
  const claim = await verify.requireClaim(name, current.user.id);

  /* Revoke before deleting, so the append-only trail keeps a record that
     this package was verified by this account and then withdrawn. Deleting
     the claim alone would erase that. */
  await verify.revokeVerification({
    packageName: name,
    userId: current.user.id,
    actorLogin: current.user.login,
    reason: "owner_withdrew",
  });

  await db.query("delete from challenges where user_id = $1 and package_name = $2", [
    current.user.id,
    name,
  ]);
  await db.query("delete from claims where id = $1", [claim.id]);
  await store.recordEvent("package.released", {
    packageName: name,
    actorLogin: current.user.login,
    payload: {},
  });
  send(req, res, 200, { removed: true, name });
}

/* -------------------------------------------------------- repo control --- */

async function checkRepo(req, res) {
  const current = await session.require(req);
  const body = await readJson(req);
  const name = validate.packageName(body.name);
  const claim = await verify.requireClaim(name, current.user.id);

  const pkg = await npm.packument(name);
  if (!pkg.repo) {
    throw badRequest(
      "no_declared_repo",
      "this package declares no GitHub repository, so there is no repository to link. Prove publish authority instead."
    );
  }

  if (!current.githubToken) {
    throw new HttpError(
      409,
      "github_token_missing",
      "this session has no GitHub token; sign out and sign in again"
    );
  }

  const control = await verify.checkRepoControl(
    pkg.repo.owner,
    pkg.repo.repo,
    current.githubToken,
    current.user.login
  );

  if (control.reason === "github_rate_limited") {
    throw new HttpError(503, "github_rate_limited", "GitHub's rate limit was reached; try again shortly", {
      resetAt: control.resetAt || null,
    });
  }

  // Trusted-publisher provenance is checked in the same call, because the
  // repository that was just read is exactly what it has to be compared
  // against, and asking the user to press a second button for a check they
  // cannot influence would be theatre.
  let trusted = { ok: false, reason: "not_checked" };
  if (control.ok && control.repo) {
    trusted = await verify.checkTrustedPublisher(pkg, control.repo);
  }

  const emailMatch = await verify.checkMaintainerEmail(pkg, current.githubToken);

  // The trail is written whatever the outcome: a failed check is part of a
  // claim's history and must survive the claim row being overwritten.
  await store.recordVerificationEvent({
    claimId: claim.id,
    packageName: name,
    userId: current.user.id,
    kind: "repo_control",
    passed: control.ok,
    reason: control.reason,
    detail: {
      permission: control.permission || null,
      repo: control.repo ? control.repo.fullName : null,
      repositoryId: control.repo ? control.repo.id : null,
    },
  });
  await store.recordVerificationEvent({
    claimId: claim.id,
    packageName: name,
    userId: current.user.id,
    kind: "trusted_publisher",
    passed: trusted.ok,
    reason: trusted.reason,
    detail: { version: trusted.version || null, repositoryId: trusted.repositoryId || null },
  });
  await store.recordVerificationEvent({
    claimId: claim.id,
    packageName: name,
    userId: current.user.id,
    kind: "maintainer_email_match",
    passed: emailMatch.ok,
    reason: emailMatch.reason,
    detail: { maintainer: emailMatch.maintainer || null },
  });

  // What GitHub said about the repository, kept as an imported fact.
  if (control.repo && control.repo.id) {
    await store.upsertRepository(control.repo);
  }

  const updated = await verify.applyClaimUpdate(claim, {
    repo_control: control.ok,
    repo_control_at: control.ok ? new Date().toISOString() : null,
    repo_permission: control.permission || null,
    trusted_publisher: trusted.ok,
    trusted_publisher_repo: trusted.ok && control.repo ? control.repo.fullName : null,
    maintainer_email_match: emailMatch.ok,
    matched_maintainer: emailMatch.ok ? emailMatch.maintainer : null,
  });

  if (verify.statusFor(updated) === "verified" && !claim.verified_at) {
    await store.recordEvent("package.verified", {
      packageName: name,
      actorLogin: current.user.login,
      payload: { via: "repo_control+trusted_publisher" },
    });
  } else if (control.ok && !claim.repo_control) {
    await store.recordEvent("package.repo_linked", {
      packageName: name,
      actorLogin: current.user.login,
      payload: { repo: control.repo ? control.repo.fullName : null },
    });
  }

  send(req, res, 200, {
    claim: claimRow(await store.claimView(name, current.user.id)),
    repoControl: {
      ok: control.ok,
      reason: control.reason,
      permission: control.permission || null,
      repo: control.repo
        ? { fullName: control.repo.fullName, id: control.repo.id, url: control.repo.url }
        : null,
      // Said out loud, because it is the whole point of the two-proof design.
      note: control.ok
        ? "you control this repository. On its own that does not prove you can publish the package: npm does not check the repository a package declares."
        : null,
      // A scope detail must not be reported as "you do not own this".
      hint:
        control.reason === "permission_unknown"
          ? "GitHub did not return a permission block for this repository with the scopes granted. Re-authorise with repository access, or prove publish authority instead."
          : control.reason === "repo_not_found"
          ? "GitHub has no repository at the address this package declares, or it is private and this account cannot see it."
          : null,
    },
    trustedPublisher: trusted,
    maintainerEmail: emailMatch,
  });
}

/* ------------------------------------------------------- publish proof --- */

async function publishChallenge(req, res) {
  const current = await session.require(req);
  const body = await readJson(req);
  const name = validate.packageName(body.name);
  await verify.requireClaim(name, current.user.id);
  // Confirm the package still exists before handing out a proof string.
  await npm.packument(name);

  const challenge = await verify.issueChallenge("npm_publish", current.user.id, name);
  send(req, res, 201, {
    nonce: challenge.nonce,
    expiresAt: challenge.expiresAt,
    field: verify.PROOF_FIELD,
    keyword: `${verify.PROOF_KEYWORD_PREFIX}${challenge.nonce}`,
    instructions: [
      `add "${verify.PROOF_FIELD}": "${challenge.nonce}" to your package.json, or add the keyword ${verify.PROOF_KEYWORD_PREFIX}${challenge.nonce}`,
      "publish a new version to npm",
      "come back and press check",
    ],
    why:
      "only an account that can run npm publish for this package can put a string into a published version, so this proves publish authority directly. Nothing else does.",
  });
}

async function checkPublishProof(req, res) {
  const current = await session.require(req);
  const body = await readJson(req);
  const name = validate.packageName(body.name);
  const claim = await verify.requireClaim(name, current.user.id);
  const challenge = await verify.readChallenge("npm_publish", current.user.id, name);

  // Ask the registry fresh: a version published a moment ago must be visible,
  // so this one read bypasses the cache rather than clearing it for everyone.
  const pkg = await npm.packument(name, { fresh: true });

  const proof = await verify.checkPublishProof(pkg, challenge.nonce, challenge.created_at);

  await store.recordVerificationEvent({
    claimId: claim.id,
    packageName: name,
    userId: current.user.id,
    kind: "publish_proof",
    passed: proof.ok,
    reason: proof.reason,
    detail: { version: proof.version || null, checked: proof.checked || null },
  });

  if (!proof.ok) {
    return send(req, res, 200, {
      verified: false,
      proof,
      claim: claimRow(await store.claimView(name, current.user.id)),
      hint:
        proof.reason === "no_version_published_since_challenge"
          ? "no version of this package has been published since the proof string was issued. Publish one, then check again."
          : "the proof string was not in the versions published since it was issued. Check the spelling, then publish again.",
    });
  }

  await verify.consumeChallenge(challenge.id);
  const updated = await verify.applyClaimUpdate(claim, {
    publish_proof: true,
    publish_proof_version: proof.version,
    publish_proof_at: new Date().toISOString(),
  });

  if (!claim.verified_at) {
    await store.recordEvent("package.verified", {
      packageName: name,
      actorLogin: current.user.login,
      payload: { via: "publish_proof", version: proof.version },
    });
  }

  await store.upsertPackage(pkg);
  send(req, res, 200, {
    verified: true,
    proof,
    claim: claimRow(await store.claimView(name, current.user.id)),
  });
}

module.exports = {
  importPackage,
  removeClaim,
  checkRepo,
  publishChallenge,
  checkPublishProof,
};
