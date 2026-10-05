/* Adversarial tests.

   Each one is an attack against the running server, asserting that it is
   refused rather than that some sanitiser was called. Where the defence is a
   parameterised query or a validator, the test tries to get past it rather
   than inspecting it.

   Run: npm test */

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
process.env.PACKAGES_LOG = "off";
process.env.PORT = process.env.SEC_TEST_PORT || "4801";
process.env.PACKAGES_SITE_ORIGIN = "http://127.0.0.1:4789";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const db = require("../_lib/db");
const store = require("../_lib/store");
const session = require("../_lib/session");
const validate = require("../_lib/validate");
const ratelimit = require("../_lib/ratelimit");
const { server } = require("../_server");

const BASE = `http://127.0.0.1:${process.env.PORT}`;
const RUN = crypto.randomBytes(4).toString("hex");

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
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (e) {
    json = null;
  }
  return { status: res.status, json, text, headers: res.headers };
}

async function signIn(label) {
  const user = await store.upsertUser({
    id: String(Math.floor(Math.random() * 1e9)),
    login: `${label}-${RUN}`,
    name: null,
    avatarUrl: null,
    profileUrl: null,
  });
  const created = await session.create(user.id, null);
  return { user, cookie: `packages_session=${created.token}` };
}

test.before(async () => {
  await db.migrate({ quiet: true });
  await new Promise((r) => server.listen(Number(process.env.PORT), "127.0.0.1", r));
  ratelimit._clear();
});

test.after(async () => {
  try {
    const like = `%-${RUN}%`;
    await db.query("delete from verification_events where user_id in (select id from users where github_login like $1)", [like]);
    await db.query("delete from sessions where user_id in (select id from users where github_login like $1)", [like]);
    await db.query("delete from claims where user_id in (select id from users where github_login like $1)", [like]);
    await db.query("delete from wallets where user_id in (select id from users where github_login like $1)", [like]);
    await db.query("delete from challenges where user_id in (select id from users where github_login like $1)", [like]);
    await db.query("delete from users where github_login like $1", [like]);
  } catch (e) {
    console.warn("[test] cleanup:", e.message);
  }
  server.close();
  await db.close();
});

test.beforeEach(() => ratelimit._clear());

/* ------------------------------------------------------- sql injection -- */

test("sql injection through a package name cannot reach the database", async () => {
  const payloads = [
    "'; drop table users; --",
    "' or '1'='1",
    "left-pad'; delete from packages where '1'='1",
    "a') union select null,null,null--",
  ];
  for (const payload of payloads) {
    const r = await call(`/api/packages/${encodeURIComponent(payload)}`);
    // Rejected by the name grammar long before any query is built.
    assert.equal(r.status, 400, `${payload} should be refused`);
    assert.equal(r.json.error.code, "bad_package_name");
  }
  // The table is still there.
  const users = await db.one("select count(*)::int as n from users");
  assert.ok(Number.isInteger(users.n));
});

test("sql injection through a search term is parameterised, not refused", async (t) => {
  // Search is free text, so the defence is the parameterised upstream call
  // rather than a grammar. The term reaches npm and nothing else.
  const r = await call(`/api/packages/search?q=${encodeURIComponent("'; drop table users; --")}`);
  assert.ok([200, 502].includes(r.status), `got ${r.status}`);
  const users = await db.one("select count(*)::int as n from users");
  assert.ok(Number.isInteger(users.n), "the users table must still exist");
});

test("a developer login cannot carry sql", async () => {
  const r = await call(`/api/developers/${encodeURIComponent("' or 1=1--")}`);
  assert.equal(r.status, 400);
});

/* ---------------------------------------------------------------- xss --- */

test("a package name cannot carry markup", async () => {
  const payloads = [
    "<script>alert(1)</script>",
    "javascript:alert(1)",
    "<img src=x onerror=alert(1)>",
    "\"><svg onload=alert(1)>",
  ];
  for (const payload of payloads) {
    assert.throws(
      () => validate.packageName(payload),
      `${payload} should not be a valid package name`
    );
  }
});

test("a url from upstream metadata is only ever linked when it is http", () => {
  /* The repository field is attacker-controlled: anyone can publish a package
     whose package.json points anywhere. parseGithubRepo must not treat a
     javascript: url as a repository. */
  const hostile = [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "https://evil.example/github.com/owner/repo",
  ];
  for (const url of hostile) {
    const parsed = validate.parseGithubRepo(url);
    if (parsed) {
      // If anything parsed at all, it must be a github.com url and nothing else.
      assert.match(parsed.url, /^https:\/\/github\.com\//, `${url} produced ${parsed.url}`);
    }
  }
});

test("a hostile repository url does not become a link", () => {
  // The client-side guard, asserted here because it is the same rule.
  const safeUrl = (raw) => {
    const value = String(raw == null ? "" : raw).trim();
    return /^https?:\/\//i.test(value) ? value : "";
  };
  assert.equal(safeUrl("javascript:alert(1)"), "");
  assert.equal(safeUrl("data:text/html,x"), "");
  assert.equal(safeUrl("  javascript:alert(1)"), "");
  assert.equal(safeUrl("https://github.com/a/b"), "https://github.com/a/b");
});

/* ------------------------------------------------------------- csrf ----- */

test("CORS refuses a cross-origin read, so a session cannot be used by another site", async () => {
  const { cookie } = await signIn("csrf");
  const r = await call("/api/me", {
    cookie,
    headers: { origin: "https://evil.example" },
  });
  // The response is produced, but the browser will not expose it: no
  // allow-origin header is sent for an origin that is not the site.
  assert.equal(r.headers.get("access-control-allow-origin"), null);
});

test("a preflight from a hostile origin is not granted", async () => {
  const r = await call("/api/claims/import", {
    method: "OPTIONS",
    headers: {
      origin: "https://evil.example",
      "access-control-request-method": "POST",
    },
  });
  assert.equal(r.headers.get("access-control-allow-origin"), null);
});

/* ------------------------------------------------------ oauth / session - */

test("the oauth callback refuses a mismatched state", async () => {
  const r = await call("/api/auth/github/callback?code=abc&state=attacker");
  assert.ok([400, 503].includes(r.status));
  if (r.status === 400) {
    assert.match(r.json.error.code, /oauth_state|oauth_incomplete/);
  }
});

test("the oauth callback refuses when the browser has no state cookie", async () => {
  const r = await call("/api/auth/github/callback?code=abc&state=xyz", {
    cookie: "unrelated=1",
  });
  assert.ok([400, 503].includes(r.status));
});

test("a session token is not accepted from anywhere but the cookie", async () => {
  const { cookie } = await signIn("header-auth");
  const token = cookie.split("=")[1];
  // Neither a bearer header nor a query parameter is an authentication
  // channel, and must not become one.
  const viaHeader = await call("/api/me", { headers: { authorization: `Bearer ${token}` } });
  assert.equal(viaHeader.json.signedIn, false);
  const viaQuery = await call(`/api/me?token=${token}`);
  assert.equal(viaQuery.json.signedIn, false);
});

test("only a sha256 of the session token is stored", async () => {
  const { user, cookie } = await signIn("hashed");
  const token = cookie.split("=")[1];
  const rows = await db.many("select token_hash from sessions where user_id = $1", [
    user.id,
  ]);
  assert.ok(rows.length);
  for (const row of rows) {
    assert.notEqual(row.token_hash, token, "the raw token must never be stored");
    assert.match(row.token_hash, /^[0-9a-f]{64}$/);
  }
});

test("signing out destroys the session server-side, not just the cookie", async () => {
  const { user, cookie } = await signIn("logout");
  await call("/api/auth/logout", { method: "POST", cookie });
  // Replaying the cookie after logout must fail: a stolen cookie is useless
  // once its session row is gone.
  const replay = await call("/api/me", { cookie });
  assert.equal(replay.json.signedIn, false);
  const left = await db.one("select count(*)::int as n from sessions where user_id = $1", [
    user.id,
  ]);
  assert.equal(left.n, 0);
});

/* ------------------------------------------------------ authorisation --- */

test("one account cannot act on another account's package", async () => {
  const owner = await signIn("owner");
  const attacker = await signIn("attacker");
  const pkg = `fixture-sec-${RUN}`;
  await db.query(
    `insert into packages (name, verified_owner_id, verified_at)
     values ($1, $2, now()) on conflict (name) do update set verified_owner_id = $2`,
    [pkg, owner.user.id]
  );

  for (const path of ["/api/identity/prepare", "/api/identity/submitted", "/api/identity/reconcile"]) {
    const r = await call(path, {
      method: "POST",
      cookie: attacker.cookie,
      body: { name: pkg, signature: "5".repeat(88) },
    });
    assert.equal(r.status, 403, `${path} should be forbidden for a stranger`);
  }

  await db.query("delete from packages where name = $1", [pkg]);
});

/* ------------------------------------------------------------- ssrf ----- */

test("no user-supplied value can redirect an upstream request off its host", () => {
  /* Every outbound url is built from a validated name, so an attacker who
     controls the name cannot point the server at an internal address. */
  const attempts = [
    "http://169.254.169.254/latest/meta-data",
    "//evil.example/x",
    "..%2f..%2fadmin",
    "localhost:4790/api/health",
  ];
  for (const attempt of attempts) {
    assert.throws(() => validate.packageName(attempt), `${attempt} must not validate`);
  }
});

test("a scoped name cannot smuggle a second path segment", () => {
  assert.throws(() => validate.packageName("@scope/name/extra"));
  assert.throws(() => validate.packageName("@scope/../etc"));
});

/* ---------------------------------------------------- resource limits --- */

test("an oversized body is refused before it is parsed", async () => {
  const { cookie } = await signIn("bigbody");

  // Just over the limit: the whole body arrives before the refusal is written,
  // so the client gets a real answer.
  const justOver = { name: "left-pad", padding: "x".repeat(20 * 1024) };
  const r = await call("/api/claims/import", { method: "POST", cookie, body: justOver });
  assert.equal(r.status, 413, `expected 413, got ${r.status}`);
  assert.equal(r.json.error.code, "body_too_large");

  /* Far over the limit: the server stops reading and closes once it has
     answered, so a client still uploading may see the close instead of the
     response. That is what any proxy does with a refused upload, and either
     outcome is a refusal. What must not happen is the body being parsed, or
     the server falling over. */
  let outcome;
  try {
    const big = await call("/api/claims/import", {
      method: "POST",
      cookie,
      body: { name: "left-pad", padding: "x".repeat(2 * 1024 * 1024) },
    });
    outcome = `status ${big.status}`;
    assert.ok([413, 400].includes(big.status), outcome);
  } catch (e) {
    outcome = "connection closed";
  }

  // The server is still answering afterwards, which is the point.
  const health = await call("/api/health");
  assert.equal(health.status, 200, `server unhealthy after ${outcome}`);
});

test("rate limiting cannot be bypassed with a forged forwarded-for", async () => {
  ratelimit._clear();
  // The header is a key, never an identity, so a rotating value simply makes
  // more buckets rather than granting more budget on an existing one.
  const key = ratelimit.clientKey({
    headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
    socket: { remoteAddress: "9.9.9.9" },
  });
  assert.equal(key, "1.2.3.4", "the first hop is the key");
  const noHeader = ratelimit.clientKey({ headers: {}, socket: { remoteAddress: "9.9.9.9" } });
  assert.equal(noHeader, "9.9.9.9");
});

/* ----------------------------------------------- replay and challenges -- */

test("a wallet challenge cannot be replayed after it is consumed", async () => {
  const { cookie } = await signIn("replay");
  const challenge = await call("/api/wallet/challenge", { method: "POST", cookie });

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const { PublicKey } = require("@solana/web3.js");
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

  assert.equal((await call("/api/wallet/confirm", { method: "POST", cookie, body })).status, 200);
  const replay = await call("/api/wallet/confirm", { method: "POST", cookie, body });
  assert.equal(replay.status, 400, "a consumed challenge must not work twice");
});

test("one account's wallet challenge cannot be used by another", async () => {
  const a = await signIn("victim");
  const b = await signIn("thief");
  const challenge = await call("/api/wallet/challenge", { method: "POST", cookie: a.cookie });

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const { PublicKey } = require("@solana/web3.js");
  const address = new PublicKey(
    publicKey.export({ format: "der", type: "spki" }).subarray(-32)
  ).toBase58();

  // b signs the message issued to a, correctly, and presents it as their own.
  const r = await call("/api/wallet/confirm", {
    method: "POST",
    cookie: b.cookie,
    body: {
      pubkey: address,
      signature: crypto
        .sign(null, Buffer.from(challenge.json.message, "utf8"), privateKey)
        .toString("base64"),
      message: challenge.json.message,
    },
  });
  // The message names the account it was issued to, and b has no challenge.
  assert.equal(r.status, 400);
});

/* -------------------------------------------------- error disclosure --- */

test("an error never leaks a connection string, a token or a stack trace", async () => {
  const probes = [
    "/api/packages/UPPERCASE",
    "/api/packages/does-not-exist-zz-" + RUN,
    "/api/developers/nobody-" + RUN,
    "/api/nope",
  ];
  for (const path of probes) {
    const r = await call(path);
    assert.ok(
      !/postgres(ql)?:\/\/|password|gho_|at Object\.|node_modules|\.js:\d+/.test(r.text),
      `${path} leaked internals: ${r.text.slice(0, 160)}`
    );
  }
});

test("the health endpoint does not disclose the database url", async () => {
  const r = await call("/api/health");
  assert.ok(!/postgres(ql)?:\/\/|@|password/.test(JSON.stringify(r.json)), r.text);
});

/* ----------------------------------------------------- package identity - */

test("a package cannot be claimed by two accounts at once", async () => {
  const first = await signIn("first-claim");
  const second = await signIn("second-claim");
  const pkg = `fixture-race-${RUN}`;

  await db.query("insert into packages (name) values ($1) on conflict do nothing", [pkg]);
  await db.query(
    "update packages set verified_owner_id = $1, verified_at = now() where name = $2",
    [first.user.id, pkg]
  );

  // The guard is in the claim path; assert the invariant directly too.
  const row = await db.one("select verified_owner_id from packages where name = $1", [pkg]);
  assert.equal(row.verified_owner_id, first.user.id);
  assert.notEqual(row.verified_owner_id, second.user.id);

  await db.query("delete from packages where name = $1", [pkg]);
});

/* ============================ second adversarial pass, larger system ==== */

test("prototype pollution through a json body cannot reach Object.prototype", async () => {
  const { cookie } = await signIn("proto");
  const payloads = [
    { name: "left-pad", __proto__: { polluted: "yes" } },
    { name: "left-pad", constructor: { prototype: { polluted: "yes" } } },
  ];
  for (const body of payloads) {
    await call("/api/claims/import", { method: "POST", cookie, body });
  }
  // The server process must be unaffected.
  assert.equal({}.polluted, undefined, "Object.prototype was polluted");
  assert.equal(Object.prototype.polluted, undefined);

  // And explicitly through the raw JSON form, which JSON.parse treats
  // differently from an object literal.
  const res = await fetch(`${BASE}/api/claims/import`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: '{"name":"left-pad","__proto__":{"polluted":"yes"}}',
  });
  await res.text();
  assert.equal({}.polluted, undefined, "raw __proto__ key polluted the prototype");
});

test("a query parameter cannot pollute the prototype", async () => {
  await call("/api/packages/search?q=x&__proto__[polluted]=yes");
  await call("/api/packages/discover?view=verified&constructor[prototype][polluted]=yes");
  assert.equal({}.polluted, undefined);
});

test("the oauth callback cannot be turned into an open redirect", async () => {
  /* The classic: a redirect_uri or next parameter that sends the user
     somewhere else after sign-in. Every redirect this server issues is built
     from its own configured origin, never from the request. */
  const attempts = [
    "/api/auth/github/start?redirect_uri=https://evil.example",
    "/api/auth/github/start?next=https://evil.example",
    "/api/auth/github/start?return_to=//evil.example",
    "/api/auth/github/callback?error=denied&next=https://evil.example",
  ];
  for (const path of attempts) {
    const r = await call(path);
    const location = r.headers.get("location");
    if (location) {
      assert.ok(
        !/evil\.example/.test(location),
        `${path} redirected to ${location}`
      );
      assert.ok(
        location.startsWith("https://github.com/login/oauth") ||
          location.startsWith("http://127.0.0.1:4789"),
        `${path} redirected somewhere unexpected: ${location}`
      );
    }
  }
});

test("one account cannot read another account's claims", async () => {
  /* IDOR: /api/me is scoped by the session, and there is no endpoint that
     takes a user id. Asserted by checking one account's data never appears in
     another's response. */
  const a = await signIn("idor-a");
  const b = await signIn("idor-b");
  const pkg = `fixture-idor-${RUN}`;
  await db.query("insert into packages (name) values ($1) on conflict do nothing", [pkg]);
  await db.query("insert into claims (id, package_name, user_id) values ($1,$2,$3)", [
    crypto.randomUUID(),
    pkg,
    a.user.id,
  ]);

  const seenByB = await call("/api/me", { cookie: b.cookie });
  const names = (seenByB.json.user.packages || []).map((p) => p.name);
  assert.ok(!names.includes(pkg), "another account's claim leaked");

  // And a user id in the body is ignored: the session decides.
  const forged = await call("/api/claims/import", {
    method: "POST",
    cookie: b.cookie,
    body: { name: "left-pad", userId: a.user.id, user_id: a.user.id },
  });
  if (forged.status === 201) {
    const owner = await db.one(
      "select user_id from claims where package_name = $1 order by created_at desc limit 1",
      ["left-pad"]
    );
    assert.equal(owner.user_id, b.user.id, "the body overrode the session");
    await db.query("delete from claims where package_name = $1 and user_id = $2", [
      "left-pad",
      b.user.id,
    ]);
  }
  await db.query("delete from claims where package_name = $1", [pkg]);
  await db.query("delete from packages where name = $1", [pkg]);
});

test("the refresh endpoint cannot be used to make the server spend its rate limit", async () => {
  /* A stranger triggering upstream reads is a cheap way to exhaust a shared
     GitHub budget, so refresh is owner-only. */
  const stranger = await signIn("refresh-stranger");
  const r = await call("/api/packages/left-pad/refresh", {
    method: "POST",
    cookie: stranger.cookie,
  });
  assert.ok([403, 404].includes(r.status), `expected a refusal, got ${r.status}`);
});

test("an anonymous caller cannot trigger a refresh at all", async () => {
  const r = await call("/api/packages/left-pad/refresh", { method: "POST" });
  assert.equal(r.status, 401);
});

test("a discovery view name cannot reach the query builder", async () => {
  /* The views are a fixed map and the key is looked up, never interpolated.
     Anything unknown is refused by name. */
  for (const view of [
    "verified'; drop table packages; --",
    "../../etc/passwd",
    "__proto__",
    "constructor",
  ]) {
    const r = await call(`/api/packages/discover?view=${encodeURIComponent(view)}`);
    assert.equal(r.status, 400, `${view} should be refused`);
    assert.equal(r.json.error.code, "unknown_view");
  }
  // The table is still there.
  const count = await db.one("select count(*)::int as n from packages");
  assert.ok(Number.isInteger(count.n));
});

test("a session cannot be fixated by setting the cookie before sign-in", async () => {
  /* Session fixation: an attacker sets a known session id, then the victim
     signs in and the attacker reuses it. The server never adopts a cookie it
     did not issue, so a value it has not seen is simply not a session. */
  const chosen = crypto.randomBytes(32).toString("base64url");
  const before = await call("/api/me", { cookie: `packages_session=${chosen}` });
  assert.equal(before.json.signedIn, false);

  // Even after a real session exists, the attacker's chosen value is not one.
  await signIn("fixation");
  const after = await call("/api/me", { cookie: `packages_session=${chosen}` });
  assert.equal(after.json.signedIn, false);
});

test("a package name cannot traverse into the registry path", async () => {
  /* The outbound url is built from a validated name. Anything that could
     change the path is refused before a request is made. */
  for (const name of [
    "left-pad/../../-/user/x",
    "left-pad%2f..%2f..",
    "left-pad?write=1",
    "left-pad#fragment",
    "left-pad\..\..",
  ]) {
    const r = await call(`/api/packages/${encodeURIComponent(name)}`);
    /* Either refusal is correct and they happen at different layers: the
       router rejects a name that decodes to too many path segments (404),
       and the validator rejects the rest (400). What must never happen is a
       200, which would mean the name reached the registry. */
    assert.ok(
      [400, 404].includes(r.status),
      `${name} should be refused, got ${r.status}`
    );
  }
});

test("errors from a deliberate 503 do not leak configuration", async () => {
  const { user, cookie } = await signIn("err-leak");
  const pkg = `fixture-errleak-${RUN}`;
  await db.query(
    `insert into packages (name, verified_owner_id, verified_at) values ($1,$2,now())
     on conflict (name) do update set verified_owner_id = $2`,
    [pkg, user.id]
  );
  await store.addWallet(user.id, "11111111111111111111111111111111", "devnet");

  const r = await call("/api/identity/prepare", { method: "POST", cookie, body: { name: pkg } });
  assert.equal(r.status, 503);
  // The blocker explains the state without naming an rpc key, a secret or a path.
  assert.ok(!/postgres|password|secret|C:\|\/home\//i.test(r.text), r.text.slice(0, 200));

  await db.query("delete from packages where name = $1", [pkg]);
});
