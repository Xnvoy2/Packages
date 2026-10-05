/* Data integrity: transactions, the one-owner invariant, and revocation.

   **These require real PostgreSQL.** pg-mem accepts BEGIN/ROLLBACK and then
   keeps the rows anyway, so a transaction test passing against it would prove
   nothing at all — which is worse than not running. The transactional cases
   therefore skip, loudly, unless DATABASE_URL points at a real server:

     node tools/pg-dev.js                 (prints a url)
     DATABASE_URL=<that url> npm test
*/

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
const verify = require("../lib/verify");

const RUN = crypto.randomBytes(4).toString("hex");
const realPostgres = Boolean(process.env.DATABASE_URL);

/* t.skip() does not stop the body, so this returns a boolean the caller
   acts on. Otherwise a skipped test runs anyway and proves the opposite of
   what the skip was protecting against. */
const needsPostgres = (t) => {
  if (realPostgres) return false;
  t.skip("needs real PostgreSQL: pg-mem does not roll back, so this would prove nothing");
  return true;
};

async function makeUser(label) {
  return store.upsertUser({
    id: String(Math.floor(Math.random() * 1e9)),
    login: `${label}-${RUN}`,
    name: null,
    avatarUrl: null,
    profileUrl: null,
  });
}

async function makePackage(name) {
  await db.query("insert into packages (name) values ($1) on conflict (name) do nothing", [
    name,
  ]);
}

async function makeClaim(packageName, userId) {
  return db.one(
    "insert into claims (id, package_name, user_id) values ($1,$2,$3) returning *",
    [crypto.randomUUID(), packageName, userId]
  );
}

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
    await db.query("delete from claims where package_name like $1", [`fixture-%${RUN}`]);
    await db.query(
      "update packages set verified_owner_id = null where name like $1",
      [`fixture-%${RUN}`]
    );
    await db.query("delete from packages where name like $1", [`fixture-%${RUN}`]);
    await db.query(
      "delete from sessions where user_id in (select id from users where github_login like $1)",
      [like]
    );
    await db.query("delete from users where github_login like $1", [like]);
  } catch (e) {
    console.warn("[test] cleanup:", e.message);
  }
  await db.close();
});

/* ------------------------------------------------------ transactions --- */

test("a transaction commits all of its statements", async (t) => {
  if (needsPostgres(t)) return;
  const name = `fixture-tx-commit-${RUN}`;
  await db.transaction(async (tx) => {
    await tx.query("insert into packages (name, description) values ($1, $2)", [
      name,
      "first",
    ]);
    await tx.query("update packages set description = $2 where name = $1", [
      name,
      "second",
    ]);
  });
  const row = await db.one("select description from packages where name = $1", [name]);
  assert.equal(row.description, "second");
});

test("a transaction that throws leaves nothing behind", async (t) => {
  if (needsPostgres(t)) return;
  const name = `fixture-tx-rollback-${RUN}`;
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.query("insert into packages (name) values ($1)", [name]);
      // The row exists inside the transaction...
      const inside = await tx.one("select name from packages where name = $1", [name]);
      assert.equal(inside.name, name);
      throw new Error("deliberate");
    })
  );
  // ...and not outside it.
  const after = await db.one("select name from packages where name = $1", [name]);
  assert.equal(after, null, "a rolled-back insert must not survive");
});

test("verification and ownership are written together or not at all", async (t) => {
  if (needsPostgres(t)) return;
  const user = await makeUser("tx-owner");
  const name = `fixture-tx-claim-${RUN}`;
  await makePackage(name);
  const claim = await makeClaim(name, user.id);

  const updated = await verify.applyClaimUpdate(claim, {
    publish_proof: true,
    publish_proof_version: "1.0.0",
  });

  assert.equal(updated.status, "verified");
  const pkg = await db.one("select verified_owner_id from packages where name = $1", [name]);
  assert.equal(
    pkg.verified_owner_id,
    user.id,
    "a verified claim and its package ownership must agree"
  );
});

test("a second account cannot take a package already verified", async (t) => {
  if (needsPostgres(t)) return;
  const first = await makeUser("tx-first");
  const second = await makeUser("tx-second");
  const name = `fixture-tx-race-${RUN}`;
  await makePackage(name);

  const claimA = await makeClaim(name, first.id);
  await verify.applyClaimUpdate(claimA, { publish_proof: true, publish_proof_version: "1" });

  const claimB = await makeClaim(name, second.id);
  await assert.rejects(
    verify.applyClaimUpdate(claimB, { publish_proof: true, publish_proof_version: "1" }),
    (e) => e.code === "already_verified"
  );

  // And the first owner is untouched by the failed attempt.
  const pkg = await db.one("select verified_owner_id from packages where name = $1", [name]);
  assert.equal(pkg.verified_owner_id, first.id);
});

test("two accounts proving the same package at once, only one wins", async (t) => {
  if (needsPostgres(t)) return;
  /* The race the FOR UPDATE lock exists for. Without it both transactions read
     "no owner" and both write themselves in, and the second silently wins. */
  const a = await makeUser("race-a");
  const b = await makeUser("race-b");
  const name = `fixture-tx-concurrent-${RUN}`;
  await makePackage(name);

  const claimA = await makeClaim(name, a.id);
  const claimB = await makeClaim(name, b.id);

  const results = await Promise.allSettled([
    verify.applyClaimUpdate(claimA, { publish_proof: true, publish_proof_version: "1" }),
    verify.applyClaimUpdate(claimB, { publish_proof: true, publish_proof_version: "1" }),
  ]);

  const succeeded = results.filter((r) => r.status === "fulfilled");
  assert.equal(succeeded.length >= 1, true, "at least one must succeed");

  const pkg = await db.one("select verified_owner_id from packages where name = $1", [name]);
  assert.ok(
    pkg.verified_owner_id === a.id || pkg.verified_owner_id === b.id,
    "exactly one of the two must own it"
  );

  // Whoever lost must not be recorded as verified for this package.
  const loser = pkg.verified_owner_id === a.id ? b.id : a.id;
  const loserClaim = await db.one(
    "select status from claims where package_name = $1 and user_id = $2",
    [name, loser]
  );
  if (loserClaim && loserClaim.status === "verified") {
    assert.fail("both accounts ended up verified for one package");
  }
});

/* ------------------------------------------------------- revocation ---- */

test("revoking releases the package and keeps the history", async (t) => {
  if (needsPostgres(t)) return;
  const user = await makeUser("revoke");
  const name = `fixture-revoke-${RUN}`;
  await makePackage(name);
  const claim = await makeClaim(name, user.id);

  await verify.applyClaimUpdate(claim, { publish_proof: true, publish_proof_version: "2.0.0" });
  const owned = await db.one("select verified_owner_id from packages where name = $1", [name]);
  assert.equal(owned.verified_owner_id, user.id);

  const result = await verify.revokeVerification({
    packageName: name,
    userId: user.id,
    actorLogin: user.github_login,
    reason: "owner_withdrew",
  });
  assert.equal(result.revoked, true);
  assert.equal(result.wasVerified, true);

  // The package is free for somebody else to prove.
  const released = await db.one("select verified_owner_id from packages where name = $1", [name]);
  assert.equal(released.verified_owner_id, null);

  // The claim no longer asserts anything.
  const after = await db.one("select status, publish_proof, verified_at from claims where id = $1", [
    claim.id,
  ]);
  assert.equal(after.status, "revoked");
  assert.equal(after.publish_proof, false);
  assert.equal(after.verified_at, null);

  /* And the trail still shows what happened. A verification that could be
     erased without trace would make the trail worthless: an attacker who got
     into an account could prove a package, act on it, and tidy up. */
  const history = await store.verificationHistory(name, 10);
  const kinds = history.map((h) => h.kind);
  assert.ok(kinds.includes("revoked"), "the revocation must be recorded");
  const revocation = history.find((h) => h.kind === "revoked");
  assert.equal(revocation.reason, "owner_withdrew");
  assert.equal(revocation.passed, false);
});

test("revoking a claim that does not exist is a no-op, not an error", async (t) => {
  if (needsPostgres(t)) return;
  const user = await makeUser("revoke-none");
  const result = await verify.revokeVerification({
    packageName: `fixture-missing-${RUN}`,
    userId: user.id,
    reason: "owner_withdrew",
  });
  assert.equal(result.revoked, false);
  assert.equal(result.reason, "no_claim");
});

test("revoking does not strip an owner who is not the subject", async (t) => {
  if (needsPostgres(t)) return;
  const owner = await makeUser("real-owner");
  const other = await makeUser("other-claimant");
  const name = `fixture-revoke-other-${RUN}`;
  await makePackage(name);

  const ownerClaim = await makeClaim(name, owner.id);
  await verify.applyClaimUpdate(ownerClaim, { publish_proof: true, publish_proof_version: "1" });

  // A different account has a pending claim and withdraws it.
  await makeClaim(name, other.id);
  await verify.revokeVerification({
    packageName: name,
    userId: other.id,
    reason: "owner_withdrew",
  });

  const pkg = await db.one("select verified_owner_id from packages where name = $1", [name]);
  assert.equal(pkg.verified_owner_id, owner.id, "the real owner must be untouched");
});

/* --------------------------------------------------- append-only log --- */

test("the verification trail is never rewritten", async (t) => {
  if (needsPostgres(t)) return;
  const user = await makeUser("trail");
  const name = `fixture-trail-${RUN}`;
  await makePackage(name);
  const claim = await makeClaim(name, user.id);

  for (const [kind, passed] of [
    ["repo_control", false],
    ["repo_control", true],
    ["publish_proof", true],
  ]) {
    await store.recordVerificationEvent({
      claimId: claim.id,
      packageName: name,
      userId: user.id,
      kind,
      passed,
      reason: "test",
    });
  }

  const history = await store.verificationHistory(name, 20);
  assert.equal(history.length, 3, "every check is kept, including the failures");
  // A failed check is as much a part of the record as a passing one.
  assert.equal(history.filter((h) => !h.passed).length, 1);
});

test("a release that is already recorded is not rewritten", async (t) => {
  if (needsPostgres(t)) return;
  const name = `fixture-releases-${RUN}`;
  await makePackage(name);

  const first = await store.recordReleases(
    name,
    [{ version: "1.0.0", publishedAt: "2026-01-01T00:00:00.000Z" }],
    () => "hash-one"
  );
  const second = await store.recordReleases(
    name,
    [{ version: "1.0.0", publishedAt: "2026-01-01T00:00:00.000Z" }],
    () => "hash-two"
  );

  assert.equal(first, 1);
  assert.equal(second, 0, "a second sighting must not insert");

  const rows = await store.releasesFor(name, 10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].record_hash, "hash-one", "the original record must stand");
});
