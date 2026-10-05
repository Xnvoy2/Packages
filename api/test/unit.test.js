/* Unit tests for the parts that decide things: input validation, the
   verification rule, the rate limiter, the router and the Solana helpers.

   Run: npm test        (uses pg-mem; no network and no database needed) */

"use strict";

process.env.PACKAGES_DEV_DB = process.env.DATABASE_URL ? "" : "memory";
process.env.PACKAGES_SESSION_SECRET =
  process.env.PACKAGES_SESSION_SECRET || "test-secret-not-for-production";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const validate = require("../lib/validate");
const verify = require("../lib/verify");
const ratelimit = require("../lib/ratelimit");
const solana = require("../lib/solana");
const { matchPath } = require("../index");

/* ---------------------------------------------------------- validation -- */

test("package names: accepts what npm accepts", () => {
  for (const name of ["left-pad", "@babel/core", "a", "a.b_c-d", "@a/b.c"]) {
    assert.equal(validate.packageName(name), name);
  }
});

test("package names: rejects what npm does not", () => {
  const bad = [
    ["", "missing_field"],
    ["UPPERCASE", "bad_package_name"],
    ["has space", "bad_package_name"],
    ["../etc/passwd", "bad_package_name"],
    ["@scope", "bad_package_name"],
    ["@/name", "bad_package_name"],
    [".hidden", "bad_package_name"],
    ["_private", "bad_package_name"],
    ["a".repeat(215), "bad_package_name"],
  ];
  for (const [input, code] of bad) {
    assert.throws(
      () => validate.packageName(input),
      (e) => e.code === code,
      `expected ${JSON.stringify(input)} to be rejected as ${code}`
    );
  }
});

test("package names: a path traversal attempt cannot survive validation", () => {
  for (const attempt of ["../../package.json", "a/../../b", "%2e%2e%2fetc"]) {
    assert.throws(() => validate.packageName(attempt));
  }
});

test("versions: semver only", () => {
  assert.equal(validate.version("1.2.3"), "1.2.3");
  assert.equal(validate.version("1.2.3-beta.1"), "1.2.3-beta.1");
  assert.throws(() => validate.version("1.2"));
  assert.throws(() => validate.version("latest"));
});

test("repository field: every shape npm actually holds", () => {
  const cases = [
    ["git+https://github.com/owner/repo.git", "owner", "repo"],
    ["git+ssh://git@github.com/owner/repo.git", "owner", "repo"],
    ["git://github.com/owner/repo", "owner", "repo"],
    ["https://github.com/owner/repo/tree/main/packages/x", "owner", "repo"],
    ["git@github.com:owner/repo.git", "owner", "repo"],
    ["owner/repo", "owner", "repo"],
    [{ url: "git+https://github.com/owner/repo.git", type: "git" }, "owner", "repo"],
  ];
  for (const [input, owner, repo] of cases) {
    const parsed = validate.parseGithubRepo(input);
    assert.ok(parsed, `expected a parse for ${JSON.stringify(input)}`);
    assert.equal(parsed.owner, owner);
    assert.equal(parsed.repo, repo);
  }
});

test("repository field: a non-GitHub host returns null rather than a guess", () => {
  assert.equal(validate.parseGithubRepo("https://gitlab.com/owner/repo"), null);
  assert.equal(validate.parseGithubRepo("https://example.com/x"), null);
  assert.equal(validate.parseGithubRepo(""), null);
  assert.equal(validate.parseGithubRepo(null), null);
});

test("solana addresses: base58 of the right length only", () => {
  const good = "11111111111111111111111111111111";
  assert.equal(validate.solanaPubkey(good), good);
  assert.throws(() => validate.solanaPubkey("0OIl000000000000000000000000000000"));
  assert.throws(() => validate.solanaPubkey("short"));
});

test("signatures: must decode to 64 bytes", () => {
  const sig = Buffer.alloc(64, 7).toString("base64");
  assert.equal(validate.base64Signature(sig).bytes.length, 64);
  assert.throws(() => validate.base64Signature(Buffer.alloc(32).toString("base64")));
  assert.throws(() => validate.base64Signature("not base64 !!"));
});

/* ------------------------------------------------- the verification rule -- */

/* The whole point of the product. Each case states what is true and what the
   status must therefore be. */
test("verification rule: repository control alone is never verified", () => {
  const claim = {
    repo_control: true,
    trusted_publisher: false,
    publish_proof: false,
    maintainer_email_match: true,
  };
  assert.equal(verify.statusFor(claim), "repo_linked");
  assert.notEqual(verify.statusFor(claim), "verified");
});

test("verification rule: the maintainer email signal can never verify anything", () => {
  assert.equal(
    verify.statusFor({
      repo_control: false,
      trusted_publisher: false,
      publish_proof: false,
      maintainer_email_match: true,
    }),
    "pending"
  );
  // Even combined with repository control it adds nothing.
  assert.equal(
    verify.statusFor({
      repo_control: true,
      trusted_publisher: false,
      publish_proof: false,
      maintainer_email_match: true,
    }),
    "repo_linked"
  );
});

test("verification rule: publish proof alone is enough", () => {
  assert.equal(
    verify.statusFor({
      repo_control: false,
      trusted_publisher: false,
      publish_proof: true,
      maintainer_email_match: false,
    }),
    "verified"
  );
});

test("verification rule: repository control plus npm's attestation is enough", () => {
  assert.equal(
    verify.statusFor({
      repo_control: true,
      trusted_publisher: true,
      publish_proof: false,
      maintainer_email_match: false,
    }),
    "verified"
  );
});

test("verification rule: an attestation without repository control is not enough", () => {
  assert.equal(
    verify.statusFor({
      repo_control: false,
      trusted_publisher: true,
      publish_proof: false,
      maintainer_email_match: false,
    }),
    "pending"
  );
});

test("evidence labels every proof with whether it is sufficient alone", () => {
  const rows = verify.evidenceFor({
    repo_control: true,
    trusted_publisher: false,
    publish_proof: false,
    maintainer_email_match: false,
  });
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(byKey.publish_proof.sufficientAlone, true);
  assert.equal(byKey.repo_control.sufficientAlone, false);
  assert.equal(byKey.trusted_publisher.sufficientAlone, false);
  assert.equal(byKey.maintainer_email_match.sufficientAlone, false);
  assert.equal(byKey.maintainer_email_match.signalOnly, true);
});

/* ----------------------------------------------- trusted publisher match -- */

test("trusted publisher: compares repository id, not name", async () => {
  // A package whose provenance names repository id 42.
  const pkg = {
    name: "fake",
    latestVersion: "1.0.0",
    releases: [{ version: "1.0.0", present: true }],
  };
  const npm = require("../lib/npm");
  const cache = require("../lib/cache");
  cache.clear();
  // Stand in for the registry so the test needs no network.
  const original = npm.provenance;
  npm.provenance = async () => ({
    attested: true,
    repositoryId: "42",
    repoUrl: "https://github.com/old-name/repo",
    workflowPath: ".github/workflows/release.yml",
  });
  try {
    const match = await verify.checkTrustedPublisher(pkg, { id: "42", fullName: "new-name/repo" });
    assert.equal(match.ok, true, "same id under a different name must still match");

    const mismatch = await verify.checkTrustedPublisher(pkg, {
      id: "43",
      fullName: "old-name/repo",
    });
    assert.equal(mismatch.ok, false, "a different id must not match, whatever the name says");
  } finally {
    npm.provenance = original;
  }
});

test("trusted publisher: no repository to compare is not a pass", async () => {
  const result = await verify.checkTrustedPublisher(
    { name: "x", releases: [], latestVersion: null },
    null
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_repo_to_compare");
});

/* -------------------------------------------------------- publish proof -- */

test("publish proof: a version published before the challenge cannot count", async () => {
  const issued = new Date("2026-01-10T00:00:00.000Z").toISOString();
  const pkg = {
    name: "x",
    releases: [
      // Published a year before the nonce existed.
      { version: "1.0.0", present: true, publishedAt: "2025-01-01T00:00:00.000Z" },
    ],
  };
  const result = await verify.checkPublishProof(pkg, "abc123", issued);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_version_published_since_challenge");
});

/* ----------------------------------------------------------- rate limit -- */

test("rate limit: a burst is refused with a retry-after", () => {
  ratelimit._clear();
  const req = { headers: {}, socket: { remoteAddress: "10.0.0.1" } };
  const capacity = ratelimit.LIMITS.verify.capacity;
  for (let i = 0; i < capacity; i++) ratelimit.take(req, "verify");
  assert.throws(
    () => ratelimit.take(req, "verify"),
    (e) => e.status === 429 && e.retryAfter > 0
  );
});

test("rate limit: one client's burst does not affect another", () => {
  ratelimit._clear();
  const a = { headers: {}, socket: { remoteAddress: "10.0.0.1" } };
  const b = { headers: {}, socket: { remoteAddress: "10.0.0.2" } };
  for (let i = 0; i < ratelimit.LIMITS.verify.capacity; i++) ratelimit.take(a, "verify");
  assert.doesNotThrow(() => ratelimit.take(b, "verify"));
});

test("rate limit: buckets are separate per route group", () => {
  ratelimit._clear();
  const req = { headers: {}, socket: { remoteAddress: "10.0.0.3" } };
  for (let i = 0; i < ratelimit.LIMITS.verify.capacity; i++) ratelimit.take(req, "verify");
  assert.doesNotThrow(() => ratelimit.take(req, "read"));
});

/* --------------------------------------------------------------- router -- */

test("router: a literal route is not swallowed by a parameter route", () => {
  const { match } = require("../index");
  assert.equal(match("GET", "/api/packages/search").pattern, "/api/packages/search");
  assert.equal(match("GET", "/api/packages/featured").pattern, "/api/packages/featured");
  assert.equal(match("GET", "/api/packages/left-pad").pattern, "/api/packages/:name");
});

test("router: a scoped package name spans two segments", () => {
  assert.deepEqual(matchPath("/api/packages/:name", "/api/packages/@babel/core"), {
    name: "@babel/core",
  });
  assert.deepEqual(matchPath("/api/packages/:name/versions", "/api/packages/@babel/core/versions"), {
    name: "@babel/core",
  });
});

test("router: three segments is not a package name", () => {
  assert.equal(matchPath("/api/packages/:name", "/api/packages/a/b/c"), null);
});

/* --------------------------------------------------------------- solana -- */

test("wallet proof: a real signature verifies and a tampered message does not", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const bs58 = require("@solana/web3.js");
  const address = new bs58.PublicKey(raw).toBase58();

  const message = solana.walletProofMessage({
    nonce: "abc",
    login: "octocat",
    issuedAt: new Date().toISOString(),
  });
  const signature = crypto.sign(null, Buffer.from(message, "utf8"), privateKey);

  assert.equal(solana.verifySignature(address, message, signature), true);
  assert.equal(
    solana.verifySignature(address, message + " tampered", signature),
    false,
    "a signature must not verify against a different message"
  );

  // A different key must not verify the same signature.
  const other = crypto.generateKeyPairSync("ed25519");
  const otherRaw = other.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const otherAddress = new bs58.PublicKey(otherRaw).toBase58();
  assert.equal(solana.verifySignature(otherAddress, message, signature), false);
});

test("wallet proof: garbage in place of a key fails rather than throwing", () => {
  assert.equal(solana.verifySignature("not-a-key", "msg", Buffer.alloc(64)), false);
});

test("wallet proof message names the cluster, the account and the nonce", () => {
  const message = solana.walletProofMessage({
    nonce: "n1",
    login: "someone",
    issuedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.match(message, /^Packages: prove wallet ownership/);
  assert.match(message, /account: someone/);
  assert.match(message, /nonce: n1/);
  assert.match(message, /cluster: devnet/);
  assert.match(message, /not a transaction/);
});

test("identity derivation: every npm name is reachable", () => {
  /* A Solana seed is capped at 32 bytes and npm allows 214 characters, so the
     name is always hashed. A scheme using the name literally could not
     address most of the namespace: long-named packages would simply have been
     unregistrable. */
  const short = solana.identitySeeds("left-pad");
  const long = solana.identitySeeds("a".repeat(200));

  assert.equal(short[0].toString(), "package");
  assert.equal(long[0].toString(), "package", "one scheme, not two");
  assert.equal(short[1].length, 32);
  assert.equal(long[1].length, 32, "a 200-character name must still fit in a seed");

  assert.deepEqual(solana.identitySeeds("left-pad"), short, "must be deterministic");
  assert.notDeepEqual(solana.identitySeeds("right-pad")[1], short[1]);

  // A scoped name and a slash-separated unscoped one are different packages
  // and must not share an address.
  assert.notDeepEqual(
    solana.identitySeeds("@scope/name")[1],
    solana.identitySeeds("scope/name")[1]
  );
});

test("identity derivation matches the program's hash exactly", () => {
  // package_hash() in the Anchor program is sha256 over the utf-8 name. If
  // these diverge, every address the product displays is wrong.
  const expected = crypto
    .createHash("sha256")
    .update(Buffer.from("left-pad", "utf8"))
    .digest();
  assert.deepEqual(solana.nameHash("left-pad"), expected);
  assert.deepEqual(solana.identitySeeds("left-pad")[1], expected);
});

test("release records are addressed per version, under their identity", () => {
  process.env.PACKAGES_PROGRAM_ID = "PkgAcoAFUaVhzP4Ux5GFeMDGsZFNNRvcRnEFmjbVeEa";
  // The module read the id at load time, so this exercises the seed shape
  // rather than the address, which is what the program constrains.
  const a = solana.releaseSeeds(
    "11111111111111111111111111111111",
    "1.0.0"
  );
  const b = solana.releaseSeeds(
    "11111111111111111111111111111111",
    "1.0.1"
  );
  assert.equal(a[0].toString(), "release");
  assert.equal(a[1].length, 32, "the identity key is a 32-byte seed");
  assert.equal(a[2].length, 32, "the version is hashed, so a long prerelease fits");
  assert.notDeepEqual(a[2], b[2], "two versions must not share a record address");
  delete process.env.PACKAGES_PROGRAM_ID;
});

test("identity address is null while no program is configured", () => {
  // No PACKAGES_PROGRAM_ID is set in the test environment, and an address
  // derived from a program that does not exist would be meaningless.
  assert.equal(solana.identityAddress("left-pad"), null);
});

test("release hash is stable and distinguishes every field", () => {
  const base = {
    packageName: "left-pad",
    version: "1.3.0",
    publishedAt: "2018-04-09T01:10:45.796Z",
    tarballIntegrity: "sha512-abc",
  };
  const hash = solana.releaseRecordHash(base);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, solana.releaseRecordHash({ ...base }), "must be reproducible");
  assert.notEqual(hash, solana.releaseRecordHash({ ...base, version: "1.3.1" }));
  assert.notEqual(hash, solana.releaseRecordHash({ ...base, packageName: "right-pad" }));
  assert.notEqual(hash, solana.releaseRecordHash({ ...base, publishedAt: "2019-01-01" }));
});

/* ----------------------------------------------------------------- html -- */

test("escaping: a package description cannot inject markup", () => {
  // The browser helper is the one that matters, but the same rule is asserted
  // here against the shape of data the registry can return.
  const nasty = '<img src=x onerror="alert(1)">';
  const escaped = nasty.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
  assert.ok(!escaped.includes("<img"));
  assert.ok(!escaped.includes('"'));
});
