/* Attacks on publisher verification.

   Verification is the whole product: a package identity nobody can trust is
   worse than none. These are the attacks that would make a false claim stick,
   each one asserted to fail.

   The attack that shapes the design is the second one here: somebody who
   genuinely controls a GitHub repository, but cannot publish the npm package
   that points at it. Nothing stops them putting any repository url in a
   package.json, and npm does not check it, so repository control must never
   on its own produce a verified publisher. */

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

const db = require("../_lib/db");
const store = require("../_lib/store");
const verify = require("../_lib/verify");
const lifecycle = require("../_lib/lifecycle");
const npm = require("../_lib/npm");
const cache = require("../_lib/cache");

const RUN = crypto.randomBytes(4).toString("hex");

test.before(async () => {
  await db.migrate({ quiet: true });
});

test.after(async () => {
  try {
    const like = `%-${RUN}`;
    await db.query("delete from verification_events where package_name like $1", [`fixture-%${RUN}`]);
    await db.query(
      "delete from verification_events where user_id in (select id from users where github_login like $1)",
      [like]
    );
    await db.query("delete from challenges where user_id in (select id from users where github_login like $1)", [like]);
    await db.query("delete from claims where package_name like $1", [`fixture-%${RUN}`]);
    await db.query("delete from claims where user_id in (select id from users where github_login like $1)", [like]);
    await db.query("update packages set verified_owner_id = null where name like $1", [`fixture-%${RUN}`]);
    await db.query("delete from packages where name like $1", [`fixture-%${RUN}`]);
    await db.query("delete from sessions where user_id in (select id from users where github_login like $1)", [like]);
    await db.query("delete from users where github_login like $1", [like]);
  } catch (e) {
    console.warn("[test] cleanup:", e.message);
  }
  await db.close();
});

test.beforeEach(() => cache.clear());

const makeUser = (label) =>
  store.upsertUser({
    id: String(Math.floor(Math.random() * 1e9)),
    login: `${label}-${RUN}`,
    name: null,
    avatarUrl: null,
    profileUrl: null,
  });

async function makeClaim(packageName, userId) {
  await db.query("insert into packages (name) values ($1) on conflict (name) do nothing", [
    packageName,
  ]);
  return db.one(
    "insert into claims (id, package_name, user_id) values ($1,$2,$3) returning *",
    [crypto.randomUUID(), packageName, userId]
  );
}

/* ============================ the attack the design exists for ========== */

test("controlling the repository but not the package does not verify the publisher", async () => {
  /* The attacker genuinely controls github.com/attacker/thing. They publish
     an npm package whose package.json points at it, or they claim a package
     that happens to point at it. Repository control is real; publish
     authority is not. */
  const attacker = await makeUser("repo-only-attacker");
  const pkg = `fixture-repo-only-${RUN}`;
  const claim = await makeClaim(pkg, attacker.id);

  const updated = await verify.applyClaimUpdate(claim, {
    repo_control: true,
    repo_permission: "admin",
    // No attestation, no publish proof.
    trusted_publisher: false,
    publish_proof: false,
  });

  assert.equal(updated.status, "repo_linked");
  assert.notEqual(updated.status, "verified");

  const row = await db.one("select verified_owner_id from packages where name = $1", [pkg]);
  assert.equal(row.verified_owner_id, null, "the package must remain unowned");

  // And the lifecycle agrees, so no surface can present it as verified.
  const state = lifecycle.stateFor(
    lifecycle.factsFrom({ claim: updated, pkg: row, wallets: [] })
  );
  assert.equal(state, lifecycle.STATES.REPOSITORY_VERIFIED);
});

test("a wallet and a repository together still do not verify the publisher", async () => {
  const attacker = await makeUser("wallet-repo-attacker");
  const pkg = `fixture-wallet-repo-${RUN}`;
  const claim = await makeClaim(pkg, attacker.id);
  const updated = await verify.applyClaimUpdate(claim, {
    repo_control: true,
    maintainer_email_match: true,
  });
  await store.addWallet(attacker.id, "11111111111111111111111111111111", "devnet");

  assert.notEqual(updated.status, "verified");
  const state = lifecycle.stateFor(
    lifecycle.factsFrom({
      claim: updated,
      pkg: { identity_pda: null },
      wallets: [{ pubkey: "11111111111111111111111111111111" }],
    })
  );
  // A wallet proves a key, not a package.
  assert.equal(state, lifecycle.STATES.REPOSITORY_VERIFIED);
});

/* =========================== provenance and the declared repository ===== */

test("provenance naming a different repository does not match", async () => {
  /* The attacker points their package.json at a repository with real
     provenance from somebody else's project. The id comparison is against
     the repository the claimant controls, so a mismatch fails. */
  const pkg = {
    name: "fixture",
    latestVersion: "1.0.0",
    releases: [{ version: "1.0.0", present: true }],
  };
  const original = npm.provenance;
  npm.provenance = async () => ({
    attested: true,
    repositoryId: "999999",
    repoUrl: "https://github.com/someone-else/real-project",
  });
  try {
    const result = await verify.checkTrustedPublisher(pkg, {
      id: "12345",
      fullName: "attacker/their-fork",
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "no_matching_provenance");
  } finally {
    npm.provenance = original;
  }
});

test("an unattested release cannot be passed off as attested", async () => {
  const pkg = {
    name: "fixture",
    latestVersion: "1.0.0",
    releases: [{ version: "1.0.0", present: true }],
  };
  const original = npm.provenance;
  npm.provenance = async () => ({ attested: false, reason: "no attestation published" });
  try {
    const result = await verify.checkTrustedPublisher(pkg, { id: "1", fullName: "a/b" });
    assert.equal(result.ok, false);
  } finally {
    npm.provenance = original;
  }
});

test("provenance with no repository id is not a match", async () => {
  /* A provenance statement that names no repository id cannot establish which
     repository built it, so it must not count. */
  const pkg = {
    name: "fixture",
    latestVersion: "1.0.0",
    releases: [{ version: "1.0.0", present: true }],
  };
  const original = npm.provenance;
  npm.provenance = async () => ({
    attested: true,
    repositoryId: null,
    repoUrl: "https://github.com/a/b",
  });
  try {
    const result = await verify.checkTrustedPublisher(pkg, { id: "1", fullName: "a/b" });
    assert.equal(result.ok, false);
  } finally {
    npm.provenance = original;
  }
});

test("a repository rename does not break a match, because ids are compared", async () => {
  // The same repository under a new name is still the same repository.
  const pkg = {
    name: "fixture",
    latestVersion: "1.0.0",
    releases: [{ version: "1.0.0", present: true }],
  };
  const original = npm.provenance;
  npm.provenance = async () => ({
    attested: true,
    repositoryId: "10270250",
    repoUrl: "https://github.com/old-name/old-name",
  });
  try {
    const result = await verify.checkTrustedPublisher(pkg, {
      id: "10270250",
      fullName: "new-org/new-name",
    });
    assert.equal(result.ok, true, "the id is the same, so the repository is the same");
  } finally {
    npm.provenance = original;
  }
});

/* ================================== publish-proof challenge attacks ===== */

test("a challenge is bound to one package", async () => {
  const user = await makeUser("challenge-pkg");
  const a = `fixture-chal-a-${RUN}`;
  const b = `fixture-chal-b-${RUN}`;
  await makeClaim(a, user.id);
  await makeClaim(b, user.id);

  await verify.issueChallenge("npm_publish", user.id, a);

  // Reading it back for a different package must not find it.
  await assert.rejects(
    verify.readChallenge("npm_publish", user.id, b),
    (e) => e.code === "no_challenge",
    "a challenge for one package must not satisfy another"
  );
});

test("a challenge is bound to one account", async () => {
  const owner = await makeUser("challenge-owner");
  const thief = await makeUser("challenge-thief");
  const pkg = `fixture-chal-acct-${RUN}`;
  await makeClaim(pkg, owner.id);
  await makeClaim(pkg, thief.id);

  const issued = await verify.issueChallenge("npm_publish", owner.id, pkg);

  // The thief knows the nonce; it still does not work for them.
  await assert.rejects(
    verify.readChallenge("npm_publish", thief.id, pkg),
    (e) => e.code === "no_challenge"
  );
  assert.ok(issued.nonce);
});

test("a challenge is single use", async () => {
  const user = await makeUser("challenge-replay");
  const pkg = `fixture-chal-replay-${RUN}`;
  await makeClaim(pkg, user.id);

  const issued = await verify.issueChallenge("npm_publish", user.id, pkg);
  const read = await verify.readChallenge("npm_publish", user.id, pkg);
  assert.equal(read.nonce, issued.nonce);

  await verify.consumeChallenge(read.id);

  await assert.rejects(
    verify.readChallenge("npm_publish", user.id, pkg),
    (e) => e.code === "no_challenge",
    "a consumed challenge must not be readable again"
  );
});

test("an expired challenge is refused", async () => {
  const user = await makeUser("challenge-expired");
  const pkg = `fixture-chal-exp-${RUN}`;
  await makeClaim(pkg, user.id);

  await verify.issueChallenge("npm_publish", user.id, pkg);
  await db.query(
    "update challenges set expires_at = $2 where user_id = $1 and package_name = $3",
    [user.id, new Date(Date.now() - 1000).toISOString(), pkg]
  );

  await assert.rejects(
    verify.readChallenge("npm_publish", user.id, pkg),
    (e) => e.code === "challenge_expired"
  );
});

test("asking for a new challenge invalidates the old one", async () => {
  /* Otherwise a user could accumulate valid nonces and keep one in reserve
     after their authority lapsed. */
  const user = await makeUser("challenge-rotate");
  const pkg = `fixture-chal-rotate-${RUN}`;
  await makeClaim(pkg, user.id);

  const first = await verify.issueChallenge("npm_publish", user.id, pkg);
  const second = await verify.issueChallenge("npm_publish", user.id, pkg);
  assert.notEqual(first.nonce, second.nonce);

  const live = await db.many(
    "select nonce from challenges where user_id = $1 and package_name = $2 and consumed_at is null",
    [user.id, pkg]
  );
  assert.equal(live.length, 1, "only one challenge may be outstanding");
  assert.equal(live[0].nonce, second.nonce);
});

test("challenge nonces are unpredictable", async () => {
  const user = await makeUser("challenge-entropy");
  const pkg = `fixture-chal-entropy-${RUN}`;
  await makeClaim(pkg, user.id);

  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const issued = await verify.issueChallenge("npm_publish", user.id, pkg);
    assert.match(issued.nonce, /^[0-9a-f]{24}$/, "96 bits of hex");
    assert.ok(!seen.has(issued.nonce), "a nonce repeated");
    seen.add(issued.nonce);
  }
});

/* ------------------------------------------------- the proof itself ---- */

test("a version published before the challenge cannot carry the proof", async () => {
  /* Otherwise an attacker who found an old version containing any string
     could replay it. Only versions published after the nonce existed count. */
  const issued = new Date().toISOString();
  const result = await verify.checkPublishProof(
    {
      name: "x",
      releases: [
        { version: "1.0.0", present: true, publishedAt: "2020-01-01T00:00:00.000Z" },
      ],
    },
    "deadbeefdeadbeefdeadbeef",
    issued
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_version_published_since_challenge");
});

test("a near-miss nonce does not pass", async () => {
  const nonce = "a".repeat(24);
  assert.equal(verify.timingSafeEqual(nonce, nonce), true);
  // One character different, and lengths differing, both fail.
  assert.equal(verify.timingSafeEqual(nonce, "b" + "a".repeat(23)), false);
  assert.equal(verify.timingSafeEqual(nonce, "a".repeat(23)), false);
  assert.equal(verify.timingSafeEqual(nonce, nonce + " "), false);
});

/* ========================================= ownership and transfers ====== */

test("one package cannot have two verified owners", async () => {
  const first = await makeUser("owner-one");
  const second = await makeUser("owner-two");
  const pkg = `fixture-two-owners-${RUN}`;

  const claimA = await makeClaim(pkg, first.id);
  await verify.applyClaimUpdate(claimA, { publish_proof: true, publish_proof_version: "1" });

  const claimB = await makeClaim(pkg, second.id);
  await assert.rejects(
    verify.applyClaimUpdate(claimB, { publish_proof: true, publish_proof_version: "1" }),
    (e) => e.code === "already_verified"
  );
});

test("a transfer is a revocation then a new proof, and the history keeps both", async () => {
  /* Package ownership changes in the real world. The new owner must prove
     for themselves, and the record must still show the previous owner held
     it, so the history is not rewritten by the transfer. */
  const previous = await makeUser("transfer-old");
  const next = await makeUser("transfer-new");
  const pkg = `fixture-transfer-${RUN}`;

  const oldClaim = await makeClaim(pkg, previous.id);
  await verify.applyClaimUpdate(oldClaim, { publish_proof: true, publish_proof_version: "1" });

  await verify.revokeVerification({
    packageName: pkg,
    userId: previous.id,
    actorLogin: previous.github_login,
    reason: "package_transferred",
  });

  const newClaim = await makeClaim(pkg, next.id);
  const verified = await verify.applyClaimUpdate(newClaim, {
    publish_proof: true,
    publish_proof_version: "2",
  });
  assert.equal(verified.status, "verified");

  const owner = await db.one("select verified_owner_id from packages where name = $1", [pkg]);
  assert.equal(owner.verified_owner_id, next.id);

  // Both the original verification and its revocation are still on record.
  const history = await store.verificationHistory(pkg, 20);
  const actors = new Set(history.map((h) => h.actor));
  assert.ok(actors.has(previous.github_login), "the previous owner must remain in the record");
  assert.ok(
    history.some((h) => h.kind === "revoked" && h.reason === "package_transferred"),
    "the transfer must be recorded as what it was"
  );
});

test("revoking does not erase the evidence that was gathered", async () => {
  const user = await makeUser("revoke-history");
  const pkg = `fixture-revoke-hist-${RUN}`;
  const claim = await makeClaim(pkg, user.id);

  await store.recordVerificationEvent({
    claimId: claim.id,
    packageName: pkg,
    userId: user.id,
    kind: "publish_proof",
    passed: true,
    reason: "manifest_field",
  });
  await verify.applyClaimUpdate(claim, { publish_proof: true, publish_proof_version: "1" });
  await verify.revokeVerification({ packageName: pkg, userId: user.id, reason: "owner_withdrew" });

  const history = await store.verificationHistory(pkg, 20);
  assert.ok(history.some((h) => h.kind === "publish_proof" && h.passed));
  assert.ok(history.some((h) => h.kind === "revoked"));
});

/* ================================ names, case and encoding ============== */

test("case differences are rejected rather than folded", async () => {
  /* Folding would let "Left-Pad" and "left-pad" be treated as one package by
     one surface and two by another. npm names are lowercase; anything else
     is refused at the door. */
  const validate = require("../_lib/validate");
  assert.throws(() => validate.packageName("Left-Pad"));
  assert.throws(() => validate.packageName("LEFT-PAD"));
  assert.equal(validate.packageName("left-pad"), "left-pad");
});

test("a scoped name cannot be confused with its unscoped form", () => {
  const validate = require("../_lib/validate");
  const solana = require("../_lib/solana");

  assert.equal(validate.packageName("@scope/name"), "@scope/name");
  // These are two different packages and must never share an address.
  assert.notDeepEqual(
    solana.identitySeeds("@scope/name")[1],
    solana.identitySeeds("scope/name")[1]
  );
});

test("encoded separators cannot smuggle a second path segment", () => {
  const validate = require("../_lib/validate");
  for (const attempt of [
    "@scope%2Fname",
    "@scope/name/extra",
    "@scope%2f..%2fetc",
    "scope/name",
  ]) {
    assert.throws(() => validate.packageName(attempt), `${attempt} must be refused`);
  }
});

test("a repository url the publisher controls cannot redirect verification elsewhere", () => {
  /* The repository field is attacker-controlled. Anything that is not a
     github.com url must not parse into one. */
  const validate = require("../_lib/validate");
  for (const hostile of [
    "https://evil.example/github.com/owner/repo",
    "https://github.com.evil.example/owner/repo",
    "javascript:alert(1)",
    "https://gitlab.com/owner/repo",
  ]) {
    const parsed = validate.parseGithubRepo(hostile);
    if (parsed) {
      assert.match(
        parsed.url,
        /^https:\/\/github\.com\//,
        `${hostile} produced ${parsed.url}`
      );
      assert.ok(!parsed.owner.includes("."), `${hostile} produced owner ${parsed.owner}`);
    }
  }
});

/* ===================================== the rule itself, exhaustively ==== */

test("every combination of the four signals maps to the right status", () => {
  /* Exhaustive, because this is the rule the product rests on and a table is
     cheaper to read than four separate tests. */
  const cases = [];
  for (const repo of [false, true]) {
    for (const trusted of [false, true]) {
      for (const proof of [false, true]) {
        for (const email of [false, true]) {
          cases.push({ repo, trusted, proof, email });
        }
      }
    }
  }

  for (const c of cases) {
    const status = verify.statusFor({
      repo_control: c.repo,
      trusted_publisher: c.trusted,
      publish_proof: c.proof,
      maintainer_email_match: c.email,
    });

    const expected = c.proof
      ? "verified"
      : c.repo && c.trusted
      ? "verified"
      : c.repo
      ? "repo_linked"
      : "pending";

    assert.equal(status, expected, `for ${JSON.stringify(c)}`);

    // And the email signal never changes the answer.
    const withoutEmail = verify.statusFor({
      repo_control: c.repo,
      trusted_publisher: c.trusted,
      publish_proof: c.proof,
      maintainer_email_match: false,
    });
    assert.equal(status, withoutEmail, "the email signal must never affect the status");
  }
});
