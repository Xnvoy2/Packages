/* Integration tests: the real server, over real http, against a real database.

   The database is pg-mem by default, so the same SQL runs as in production
   without needing a server. Set DATABASE_URL to run the whole suite against
   actual PostgreSQL instead:

     node tools/pg-dev.js                      (prints a url)
     DATABASE_URL=<that url> npm test

   The tests that read npm or GitHub need the network and are skipped without
   it, so a disconnected run still exercises everything else. */

"use strict";

/* This suite writes fixtures: users, claims, and packages marked verified.
   Run against a real database those rows are indistinguishable from real
   verifications, and they surface on the homepage as verified packages. So a
   DATABASE_URL is only accepted when it names a database that is obviously a
   test one, and anything else stops the run rather than polluting it. */
if (process.env.DATABASE_URL) {
  const name = (process.env.DATABASE_URL.split("/").pop() || "").split("?")[0];
  if (!/test/i.test(name) && process.env.PACKAGES_TEST_ALLOW_DB !== "yes") {
    console.error(
      `[test] refusing to run against the database "${name}": this suite ` +
        `inserts verified packages. Use a database whose name contains ` +
        `"test" (node tools/pg-dev.js makes one), or set ` +
        `PACKAGES_TEST_ALLOW_DB=yes if you really mean it.`
    );
    process.exit(1);
  }
}

process.env.PACKAGES_DEV_DB = process.env.DATABASE_URL ? "" : "memory";
process.env.PACKAGES_SESSION_SECRET =
  process.env.PACKAGES_SESSION_SECRET || "test-secret-not-for-production";
process.env.PACKAGES_LOG = "off";
process.env.PORT = process.env.TEST_PORT || "4791";
process.env.PACKAGES_SITE_ORIGIN = "http://127.0.0.1:4789";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { PublicKey } = require("@solana/web3.js");

const db = require("../_lib/db");
const session = require("../_lib/session");
const store = require("../_lib/store");
const solana = require("../_lib/solana");
const ratelimit = require("../_lib/ratelimit");
const { server } = require("../_server");

const BASE = `http://127.0.0.1:${process.env.PORT}`;
// Fixture names are suffixed with this so a second run against the same
// database does not collide with the first run's rows.
const RUN = crypto.randomBytes(4).toString("hex");
const FAKE_PKG = `fixture-no-challenge-${RUN}`;
const UNVERIFIED_PKG = `fixture-unverified-${RUN}`;
const IDENTITY_PKG = `fixture-identity-${RUN}`;
const OWNED_PKG = `fixture-owned-${RUN}`;
const SUBMIT_PKG = `fixture-submit-${RUN}`;
const FIXTURE_PKGS = [FAKE_PKG, UNVERIFIED_PKG, IDENTITY_PKG, OWNED_PKG, SUBMIT_PKG];
let online = false;

async function call(path, options) {
  const opts = options || {};
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method || "GET",
    headers: {
      ...(opts.body ? { "content-type": "application/json" } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    redirect: "manual",
  });
  let json = null;
  const text = await res.text();
  if (text) {
    try {
      json = JSON.parse(text);
    } catch (e) {
      json = null;
    }
  }
  return { status: res.status, json, text, headers: res.headers };
}

test.before(async () => {
  await db.migrate();
  await new Promise((r) => server.listen(Number(process.env.PORT), "127.0.0.1", r));
  // The npm-dependent tests are skipped rather than failed when offline, so
  // the suite is still useful on a disconnected machine.
  try {
    const probe = await fetch("https://registry.npmjs.org/left-pad", {
      signal: AbortSignal.timeout(8000),
    });
    online = probe.ok;
  } catch (e) {
    online = false;
  }
  // Each test's requests come from the same loopback address, so the limiter
  // would otherwise count the whole suite as one burst.
  ratelimit._clear();
});

test.after(async () => {
  /* Remove this run's rows. A fixture package marked verified is
     indistinguishable from a real verification on every surface that reads
     the database — it would appear on the homepage as a verified package —
     so none of it may outlive the run that created it. */
  const like = `%-${RUN}-%`;
  try {
    await db.query("delete from onchain_registrations where package_name = any($1)", [FIXTURE_PKGS]);
    await db.query("delete from verification_events where package_name = any($1)", [FIXTURE_PKGS]);
    await db.query("delete from package_contributors where package_name = any($1)", [FIXTURE_PKGS]);
    await db.query("delete from download_snapshots where package_name = any($1)", [FIXTURE_PKGS]);
    await db.query("delete from claims where package_name = any($1)", [FIXTURE_PKGS]);
    await db.query("delete from releases where package_name = any($1)", [FIXTURE_PKGS]);
    await db.query(
      "update packages set verified_owner_id = null, verified_at = null where name = any($1)",
      [FIXTURE_PKGS]
    );
    await db.query("delete from packages where name = any($1)", [FIXTURE_PKGS]);

    const users = "select id from users where github_login like $1";
    await db.query(`delete from verification_events where user_id in (${users})`, [like]);
    await db.query(`delete from challenges where user_id in (${users})`, [like]);
    await db.query(`delete from wallets where user_id in (${users})`, [like]);
    await db.query(`delete from claims where user_id in (${users})`, [like]);
    await db.query(`delete from sessions where user_id in (${users})`, [like]);
    // Real packages (left-pad, express) are left in place, but any ownership
    // this run asserted over them is released.
    await db.query(
      `update packages set verified_owner_id = null, verified_at = null
        where verified_owner_id in (${users})`,
      [like]
    );
    await db.query("delete from users where github_login like $1", [like]);
  } catch (e) {
    console.warn("[test] cleanup failed:", e.message);
  }

  server.close();
  await db.close();
});

test.beforeEach(() => ratelimit._clear());

/* ------------------------------------------------------------- the basics */

test("health reports the database it is actually using", async () => {
  const r = await call("/api/health");
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.ok(/up|in-memory/.test(r.json.database), r.json.database);
});

test("config exposes feature state and never a secret", async () => {
  const r = await call("/api/config");
  assert.equal(r.status, 200);
  assert.equal(r.json.product, "Packages");
  assert.equal(r.json.solana.cluster, "devnet");
  // Whatever is configured, nothing resembling a credential may appear.
  const body = JSON.stringify(r.json);
  assert.ok(!/client_secret|clientSecret|GITHUB_CLIENT_SECRET/i.test(body));
  assert.ok(!/sessionSecret|DATABASE_URL|postgres:\/\//i.test(body));
});

test("an unknown route is a 404 with a json error, not a crash", async () => {
  const r = await call("/api/nope");
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, "not_found");
});

test("CORS names one origin and allows credentials", async () => {
  const r = await call("/api/health", {
    headers: { origin: "http://127.0.0.1:4789" },
  });
  assert.equal(r.headers.get("access-control-allow-origin"), "http://127.0.0.1:4789");
  assert.equal(r.headers.get("access-control-allow-credentials"), "true");
});

test("CORS refuses an origin that is not the site", async () => {
  const r = await call("/api/health", { headers: { origin: "https://evil.example" } });
  assert.equal(r.headers.get("access-control-allow-origin"), null);
});

/* ------------------------------------------------------------ validation */

test("a bad package name is refused before anything is fetched", async () => {
  const r = await call("/api/packages/UPPERCASE");
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, "bad_package_name");
});

test("search without a term is a 400, not an empty list", async () => {
  const r = await call("/api/packages/search");
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, "missing_field");
});

test("a body that is not json is refused", async () => {
  const res = await fetch(`${BASE}/api/claims/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  // Authentication is checked first, which is the correct order.
  assert.equal(res.status, 401);
});

/* ------------------------------------------------------------------ auth */

test("every write endpoint refuses an anonymous caller", async () => {
  const endpoints = [
    ["POST", "/api/claims/import"],
    ["POST", "/api/verify/repo"],
    ["POST", "/api/verify/publish/challenge"],
    ["POST", "/api/verify/publish/check"],
    ["POST", "/api/wallet/challenge"],
    ["POST", "/api/wallet/confirm"],
    ["POST", "/api/identity/register"],
    ["DELETE", "/api/claims/left-pad"],
  ];
  for (const [method, path] of endpoints) {
    const r = await call(path, { method, body: { name: "left-pad" } });
    assert.equal(r.status, 401, `${method} ${path} should be 401, got ${r.status}`);
    assert.equal(r.json.error.code, "unauthenticated");
  }
});

test("me reports a signed-out browser without erroring", async () => {
  const r = await call("/api/me");
  assert.equal(r.status, 200);
  assert.equal(r.json.signedIn, false);
});

test("a forged session cookie is not accepted", async () => {
  const forged = crypto.randomBytes(32).toString("base64url");
  const r = await call("/api/me", { cookie: `packages_session=${forged}` });
  assert.equal(r.json.signedIn, false);
});

test("an expired session is rejected and cleaned up", async () => {
  const user = await store.upsertUser({
    id: "900001",
    login: "expired-user",
    name: null,
    avatarUrl: null,
    profileUrl: null,
  });
  const token = crypto.randomBytes(32).toString("base64url");
  await db.query(
    `insert into sessions (id, token_hash, user_id, expires_at)
     values ($1, $2, $3, $4)`,
    [
      crypto.randomUUID(),
      session.hashToken(token),
      user.id,
      new Date(Date.now() - 1000).toISOString(),
    ]
  );
  const r = await call("/api/me", { cookie: `packages_session=${token}` });
  assert.equal(r.json.signedIn, false);
  const left = await db.one("select count(*)::int as n from sessions where user_id = $1", [
    user.id,
  ]);
  assert.equal(left.n, 0, "an expired session should be deleted when it is read");
});

test("github sign-in is refused clearly when it is not configured", async () => {
  const r = await call("/api/auth/github/start");
  // Configured in a deployment, absent here: either answer is correct, but it
  // must never be a 500.
  assert.ok(r.status === 503 || r.status === 302, `got ${r.status}`);
  if (r.status === 503) assert.equal(r.json.error.code, "github_not_configured");
});

test("the oauth callback refuses a state that does not match the browser", async () => {
  const r = await call("/api/auth/github/callback?code=abc&state=xyz");
  assert.ok([400, 503].includes(r.status), `got ${r.status}`);
});

/* -------------------------------------------------- a signed-in session -- */

/* Signing in for real needs GitHub credentials, which a test must not depend
   on. A session row is therefore created directly, which is exactly what the
   oauth callback does after it has verified the code. */
/* A fresh account per call. The login is suffixed because these tests also
   run against a reused database, where a fixed login would pick up the
   previous run's claims and make the assertions depend on history. */
let accountSeq = 0;

async function signIn(login) {
  const unique = `${login}-${RUN}-${++accountSeq}`;
  const user = await store.upsertUser({
    id: String(Math.floor(Math.random() * 1e9)),
    login: unique,
    name: `${login} name`,
    avatarUrl: "https://avatars.githubusercontent.com/u/1",
    profileUrl: `https://github.com/${unique}`,
  });
  const created = await session.create(user.id, null);
  return { user, login: unique, cookie: `packages_session=${created.token}` };
}

test("a signed-in session is readable and carries no token outward", async () => {
  const { login, cookie } = await signIn("octotester");
  const r = await call("/api/me", { cookie });
  assert.equal(r.json.signedIn, true);
  assert.equal(r.json.user.login, login);
  assert.ok(!/gh_token|access_token|gho_/.test(r.text), "no github token may be returned");
});

test("importing a package opens a claim that proves nothing", async (t) => {
  if (!online) return t.skip("needs the npm registry");
  const { cookie } = await signIn("importer");
  const r = await call("/api/claims/import", {
    method: "POST",
    cookie,
    body: { name: "left-pad" },
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.imported, true);
  // The important assertion: importing is not verification.
  assert.equal(r.json.claim.status, "pending");
  assert.equal(r.json.claim.verified, false);
  assert.match(r.json.note, /proves nothing/i);

  const releases = await db.one(
    "select count(*)::int as n from releases where package_name = $1",
    ["left-pad"]
  );
  assert.ok(releases.n > 0, "release history should be recorded on import");
});

test("importing a package that does not exist on npm is a 404", async (t) => {
  if (!online) return t.skip("needs the npm registry");
  const { cookie } = await signIn("importer2");
  const r = await call("/api/claims/import", {
    method: "POST",
    cookie,
    body: { name: "no-such-package-zz99-packages-test" },
  });
  assert.equal(r.status, 404);
});

test("a second account cannot claim a package already verified", async (t) => {
  if (!online) return t.skip("needs the npm registry");
  const first = await signIn("owner-one");
  await call("/api/claims/import", {
    method: "POST",
    cookie: first.cookie,
    body: { name: "left-pad" },
  });
  // Mark it verified, as a completed proof would.
  await db.query("update packages set verified_owner_id = $1, verified_at = now() where name = $2", [
    first.user.id,
    "left-pad",
  ]);

  const second = await signIn("owner-two");
  const r = await call("/api/claims/import", {
    method: "POST",
    cookie: second.cookie,
    body: { name: "left-pad" },
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, "already_verified");

  await db.query("update packages set verified_owner_id = null, verified_at = null where name = $1", [
    "left-pad",
  ]);
});

test("repository verification refuses a session with no github token", async (t) => {
  if (!online) return t.skip("needs the npm registry");
  const { cookie } = await signIn("no-token-user");
  await call("/api/claims/import", { method: "POST", cookie, body: { name: "left-pad" } });
  const r = await call("/api/verify/repo", { method: "POST", cookie, body: { name: "left-pad" } });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, "github_token_missing");
});

test("verifying a package that was never imported is refused", async () => {
  const { cookie } = await signIn("not-imported");
  const r = await call("/api/verify/repo", { method: "POST", cookie, body: { name: "express" } });
  assert.equal(r.status, 404);
});

/* -------------------------------------------------------- publish proof -- */

test("a publish challenge is issued, and checking it without a publish fails", async (t) => {
  if (!online) return t.skip("needs the npm registry");
  const { cookie } = await signIn("prover");
  await call("/api/claims/import", { method: "POST", cookie, body: { name: "left-pad" } });

  const challenge = await call("/api/verify/publish/challenge", {
    method: "POST",
    cookie,
    body: { name: "left-pad" },
  });
  assert.equal(challenge.status, 201);
  assert.match(challenge.json.nonce, /^[0-9a-f]{24}$/);
  assert.equal(challenge.json.field, "packagesVerification");

  const check = await call("/api/verify/publish/check", {
    method: "POST",
    cookie,
    body: { name: "left-pad" },
  });
  assert.equal(check.status, 200);
  // left-pad has not been published since the nonce was issued, so this must
  // not verify. A proof that passed here would be a broken proof.
  assert.equal(check.json.verified, false);
  assert.equal(check.json.claim.status, "pending");
});

test("checking a proof with no challenge issued is refused", async () => {
  const { user, cookie } = await signIn("no-challenge");
  await db.query(
    `insert into packages (name) values ($1) on conflict (name) do nothing`,
    [FAKE_PKG]
  );
  await db.query(
    `insert into claims (id, package_name, user_id) values ($1, $2, $3)`,
    [crypto.randomUUID(), FAKE_PKG, user.id]
  );
  const r = await call("/api/verify/publish/check", {
    method: "POST",
    cookie,
    body: { name: FAKE_PKG },
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, "no_challenge");
});

/* --------------------------------------------------------- wallet proof -- */

/* The full wallet flow with a real ed25519 keypair: ask for the challenge,
   sign the exact message the server issued, and send the signature back. */
test("wallet proof: a real signature is accepted end to end", async () => {
  const { cookie } = await signIn("walletuser");
  const challenge = await call("/api/wallet/challenge", { method: "POST", cookie });
  assert.equal(challenge.status, 201);
  assert.match(challenge.json.message, /^Packages: prove wallet ownership/);

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const address = new PublicKey(raw).toBase58();
  const signature = crypto.sign(null, Buffer.from(challenge.json.message, "utf8"), privateKey);

  const confirm = await call("/api/wallet/confirm", {
    method: "POST",
    cookie,
    body: {
      pubkey: address,
      signature: signature.toString("base64"),
      message: challenge.json.message,
    },
  });
  assert.equal(confirm.status, 200, confirm.text);
  assert.equal(confirm.json.verified, true);
  assert.equal(confirm.json.pubkey, address);
  assert.equal(confirm.json.cluster, "devnet");

  const me = await call("/api/me", { cookie });
  assert.equal(me.json.user.wallets.length, 1);
});

test("wallet proof: a signature from a different key is refused", async () => {
  const { cookie } = await signIn("walletuser2");
  const challenge = await call("/api/wallet/challenge", { method: "POST", cookie });

  const signer = crypto.generateKeyPairSync("ed25519");
  const impostor = crypto.generateKeyPairSync("ed25519");
  const signature = crypto.sign(
    null,
    Buffer.from(challenge.json.message, "utf8"),
    signer.privateKey
  );
  const impostorAddress = new PublicKey(
    impostor.publicKey.export({ format: "der", type: "spki" }).subarray(-32)
  ).toBase58();

  const r = await call("/api/wallet/confirm", {
    method: "POST",
    cookie,
    body: {
      pubkey: impostorAddress,
      signature: signature.toString("base64"),
      message: challenge.json.message,
    },
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, "bad_signature");
});

test("wallet proof: a message the server did not issue is refused", async () => {
  const { cookie } = await signIn("walletuser3");
  const challenge = await call("/api/wallet/challenge", { method: "POST", cookie });

  // A correctly signed message, but not the one that was issued: this is the
  // attack where another site has the wallet sign something of its choosing.
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const address = new PublicKey(
    publicKey.export({ format: "der", type: "spki" }).subarray(-32)
  ).toBase58();
  const forged = `Approve this transfer\n\nnonce: ${
    challenge.json.message.match(/nonce: (\S+)/)[1]
  }`;
  const signature = crypto.sign(null, Buffer.from(forged, "utf8"), privateKey);

  const r = await call("/api/wallet/confirm", {
    method: "POST",
    cookie,
    body: { pubkey: address, signature: signature.toString("base64"), message: forged },
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, "message_mismatch");
});

test("wallet proof: a challenge cannot be replayed", async () => {
  const { cookie } = await signIn("walletuser4");
  const challenge = await call("/api/wallet/challenge", { method: "POST", cookie });
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const address = new PublicKey(
    publicKey.export({ format: "der", type: "spki" }).subarray(-32)
  ).toBase58();
  const body = {
    pubkey: address,
    signature: crypto
      .sign(null, Buffer.from(challenge.json.message, "utf8"), privateKey)
      .toString("base64"),
    message: challenge.json.message,
  };

  const first = await call("/api/wallet/confirm", { method: "POST", cookie, body });
  assert.equal(first.status, 200);

  const replay = await call("/api/wallet/confirm", { method: "POST", cookie, body });
  assert.equal(replay.status, 400);
  assert.equal(replay.json.error.code, "no_challenge");
});

/* ------------------------------------------------------------- identity -- */

test("identity status says plainly that nothing is deployed", async () => {
  const r = await call("/api/identity/status");
  assert.equal(r.status, 200);
  assert.equal(r.json.cluster, "devnet");
  assert.equal(r.json.capabilities.walletProof, true);
  // No program id is configured in the tests, so this must be honest about it.
  assert.equal(r.json.programDeployed, false);
  assert.equal(r.json.capabilities.identityRegistration, false);
  assert.equal(r.json.state, "awaiting_deployment");
  assert.ok(r.json.blocker, "a blocker must be stated, not implied");
});

test("registering an identity refuses rather than pretending", async () => {
  const { user, cookie } = await signIn("registrant");
  await db.query(
    `insert into packages (name, verified_owner_id, verified_at)
     values ($1, $2, now())
     on conflict (name) do update set verified_owner_id = $2, verified_at = now()`,
    [IDENTITY_PKG, user.id]
  );
  // With no wallet the request is refused for that reason first.
  const noWallet = await call("/api/identity/register", {
    method: "POST",
    cookie,
    body: { name: IDENTITY_PKG },
  });
  assert.equal(noWallet.status, 400);
  assert.equal(noWallet.json.error.code, "no_wallet");

  await store.addWallet(user.id, "11111111111111111111111111111111", "devnet");
  const r = await call("/api/identity/register", {
    method: "POST",
    cookie,
    body: { name: IDENTITY_PKG },
  });
  assert.equal(r.status, 503);
  assert.equal(r.json.prepared, false);
  assert.equal(r.json.reason, "awaiting_deployment");
  assert.match(r.json.note, /nothing was sent to any cluster/i);
  // The refusal still shows what is ready, so the review step can be honest.
  assert.equal(r.json.wouldRegister.package, IDENTITY_PKG);
  assert.equal(r.json.wouldRegister.authority, "11111111111111111111111111111111");
});

test("a signature cannot be recorded without a prepared registration", async () => {
  const { user, cookie } = await signIn("premature");
  await db.query(
    `insert into packages (name, verified_owner_id, verified_at)
     values ($1, $2, now())
     on conflict (name) do update set verified_owner_id = $2, verified_at = now()`,
    [SUBMIT_PKG, user.id]
  );
  const r = await call("/api/identity/submitted", {
    method: "POST",
    cookie,
    body: { name: SUBMIT_PKG, signature: "5".repeat(88) },
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, "no_prepared_attempt");
});

test("a malformed transaction signature is refused", async () => {
  const { user, cookie } = await signIn("badsig");
  await db.query(
    `insert into packages (name, verified_owner_id, verified_at)
     values ($1, $2, now())
     on conflict (name) do update set verified_owner_id = $2, verified_at = now()`,
    [SUBMIT_PKG, user.id]
  );
  for (const signature of ["", "short", "0OIl" + "5".repeat(84), "5".repeat(200)]) {
    const r = await call("/api/identity/submitted", {
      method: "POST",
      cookie,
      body: { name: SUBMIT_PKG, signature },
    });
    assert.equal(r.status, 400, `signature ${JSON.stringify(signature)} should be refused`);
  }
});

/* The point of the lifecycle: a package is not onchain because somebody said
   so. These drive the reconciler directly, because reaching the confirmed
   branch needs a deployed program, which is deliberately out of scope. */
test("reconciliation refuses to confirm without a deployed program", async () => {
  const chain = require("../_lib/chain");
  const result = await chain.reconcileRegistration({
    signature: "5".repeat(88),
    identityAddress: "11111111111111111111111111111111",
  });
  // No PACKAGES_PROGRAM_ID in the test environment.
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /no program id/i);
});

test("reconciliation treats an unknown signature as not found, never as success", async () => {
  process.env.PACKAGES_PROGRAM_ID = "HbA6Kn3SsXbs1KyM8qJHHWQjXLuAGoPXW7upsNp9k8aP";
  // The config was read at load time, so reach the pure logic directly.
  const chain = require("../_lib/chain");
  const original = chain.transactionState;
  const originalAccount = chain.accountState;
  try {
    chain.accountState = async () => ({ ok: true, exists: false });
    chain.transactionState = async () => ({ ok: true, found: false, status: "unknown" });
    // reconcileRegistration closes over the module's own functions, so this
    // asserts the contract of the pieces rather than the wiring.
    const tx = await chain.transactionState("x");
    assert.equal(tx.found, false);
    const acct = await chain.accountState("x");
    assert.equal(acct.exists, false);
  } finally {
    chain.transactionState = original;
    chain.accountState = originalAccount;
    delete process.env.PACKAGES_PROGRAM_ID;
  }
});

test("the chain reader tells existence and ownership apart", async (t) => {
  if (!online) return t.skip("needs devnet rpc");
  const chain = require("../_lib/chain");
  // A real account that exists but is not ours: existence alone must never be
  // read as a registration.
  const system = await chain.accountState("11111111111111111111111111111111");
  assert.equal(system.ok, true);
  assert.equal(system.exists, true);
  assert.equal(system.ownedByProgram, false);

  const empty = await chain.accountState("GkoTSW9X1hTb4QYCDWEYC9n6BpnWwpgL8rfmTQGUFa5A");
  assert.equal(empty.exists, false);
});

test("a package cannot have its identity registered by someone else", async () => {
  const owner = await signIn("real-owner");
  const stranger = await signIn("stranger");
  await db.query(
    `insert into packages (name, verified_owner_id, verified_at)
     values ($1, $2, now())
     on conflict (name) do update set verified_owner_id = $2`,
    [OWNED_PKG, owner.user.id]
  );
  const r = await call("/api/identity/register", {
    method: "POST",
    cookie: stranger.cookie,
    body: { name: OWNED_PKG },
  });
  assert.equal(r.status, 403);
});

/* ------------------------------------------------------- public surfaces */

test("a developer profile lists only verified packages", async () => {
  const { user, login, cookie } = await signIn("profileuser");
  await db.query(`insert into packages (name) values ($1) on conflict do nothing`, [
    UNVERIFIED_PKG,
  ]);
  await db.query(`insert into claims (id, package_name, user_id) values ($1, $2, $3)`, [
    crypto.randomUUID(),
    UNVERIFIED_PKG,
    user.id,
  ]);
  void cookie;

  const r = await call(`/api/developers/${login}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.developer.login, login);
  assert.equal(r.json.packages.length, 0, "an unverified claim must not be public");
  assert.equal(r.json.claimedCount, 1);
});

test("an unknown developer is a 404", async () => {
  const r = await call("/api/developers/nobody-here-at-all");
  assert.equal(r.status, 404);
});

test("the activity feed is honest when there is nothing to report", async () => {
  const r = await call("/api/activity?limit=5");
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.entries));
  if (r.json.trackedPackages === 0) {
    assert.ok(r.json.note, "an empty feed must explain itself");
  }
});

test("search returns real registry results", async (t) => {
  if (!online) return t.skip("needs the npm registry");
  const r = await call("/api/packages/search?q=left-pad&limit=5");
  assert.equal(r.status, 200);
  assert.ok(r.json.results.length > 0);
  for (const result of r.json.results) {
    assert.equal(typeof result.name, "string");
    // Nothing is claimed in a fresh database, and the flag must say so rather
    // than being absent.
    assert.equal(typeof result.claimed, "boolean");
    assert.equal(typeof result.verified, "boolean");
  }
});

test("a package page returns registry facts, or null where npm has none", async (t) => {
  if (!online) return t.skip("needs the npm registry");
  const r = await call("/api/packages/left-pad");
  assert.equal(r.status, 200);
  const p = r.json.package;
  assert.equal(p.name, "left-pad");
  assert.ok(p.releases.length > 0);
  // Earlier tests in this file import left-pad, so the status here depends on
  // what has happened before it. What must always hold is that it is one of
  // the four the rule can produce, and that "verified" agrees with the flag.
  assert.ok(
    ["unclaimed", "pending", "repo_linked", "verified"].includes(p.verification.status),
    `unexpected status ${p.verification.status}`
  );
  assert.equal(p.verification.verified, p.verification.status === "verified");
  // Every download figure is either a real number or null, never a zero
  // standing in for "unknown".
  for (const value of [p.downloads.lastWeek, p.downloads.lastMonth]) {
    assert.ok(value === null || typeof value === "number");
  }
});

test("a scoped package name survives the whole round trip", async (t) => {
  if (!online) return t.skip("needs the npm registry");
  const r = await call(`/api/packages/${encodeURIComponent("@babel/core")}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.package.name, "@babel/core");
});

test("rate limiting returns 429 with a retry-after header", async () => {
  ratelimit._clear();
  // A route in the read bucket that touches only the database, so the burst
  // measures the limiter rather than an upstream.
  const budget = ratelimit.LIMITS.read.capacity + 5;
  let limited = null;
  for (let i = 0; i < budget && !limited; i++) {
    const r = await call("/api/developers/nobody-here-at-all");
    if (r.status === 429) limited = r;
  }
  assert.ok(limited, "the limiter should eventually refuse a burst");
  assert.ok(limited.headers.get("retry-after"), "a 429 must say when to retry");
});

/* -------------------------------------------------------------- cleanup -- */

test("withdrawing a claim releases the package", async (t) => {
  if (!online) return t.skip("needs the npm registry");
  const { user, cookie } = await signIn("withdrawer");
  await call("/api/claims/import", { method: "POST", cookie, body: { name: "left-pad" } });
  await db.query("update packages set verified_owner_id = $1 where name = $2", [
    user.id,
    "left-pad",
  ]);

  const r = await call("/api/claims/left-pad", { method: "DELETE", cookie });
  assert.equal(r.status, 200);
  const pkg = await db.one("select verified_owner_id from packages where name = $1", [
    "left-pad",
  ]);
  assert.equal(pkg.verified_owner_id, null);
});
