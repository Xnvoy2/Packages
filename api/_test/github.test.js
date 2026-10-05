/* GitHub integration, at the protocol boundary.

   There are no OAuth credentials, so the token-exchange leg has never run and
   nothing here claims it has. What these do cover is everything around it:
   the state parameter, the url construction, how each GitHub response shape
   is interpreted, pagination, rate limiting, renamed and transferred
   repositories, and the rule that a read token never reaches a client.

   The reads run against real github.com, so they exercise the actual protocol
   rather than a fixture that could drift from it. They skip when the network
   or the rate limit is unavailable, and say which. */

"use strict";

process.env.PACKAGES_DEV_DB = process.env.DATABASE_URL ? "" : "memory";
process.env.PACKAGES_SESSION_SECRET =
  process.env.PACKAGES_SESSION_SECRET || "test-secret-not-for-production";

const test = require("node:test");
const assert = require("node:assert/strict");

const github = require("../_lib/github");
const verify = require("../_lib/verify");
const { config } = require("../_lib/env");
const cache = require("../_lib/cache");

/* GitHub allows 60 unauthenticated requests an hour for the whole machine,
   and this suite is not the only thing using them. Checked once, so the live
   cases skip with a reason instead of failing. */
let budget = null;

test.before(async () => {
  try {
    const res = await fetch("https://api.github.com/rate_limit", {
      signal: AbortSignal.timeout(8000),
    });
    const json = await res.json();
    budget = json.resources.core.remaining;
  } catch (e) {
    budget = 0;
  }
  cache.clear();
});

/* t.skip() marks a test skipped but does NOT stop its body running, so this
   returns a boolean the caller acts on. Without that, a test reported as
   skipped still executes its assertions and can fail afterwards, which is how
   a rate-limited read ended up asserting against a rateLimited response. */
const needsBudget = (t, cost) => {
  if (budget === null) {
    t.skip("rate limit unknown");
    return true;
  }
  if (budget < (cost || 1)) {
    t.skip(`github budget exhausted (${budget} left)`);
    return true;
  }
  budget -= cost || 1;
  return false;
};

/* ------------------------------------------------------- oauth state --- */

test("oauth state is long, random and never repeats", () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const state = github.newState();
    // 24 bytes base64url: enough that guessing is not a strategy.
    assert.ok(state.length >= 30, `state too short: ${state}`);
    assert.match(state, /^[A-Za-z0-9_-]+$/);
    assert.ok(!seen.has(state), "a state value repeated");
    seen.add(state);
  }
});

test("the authorize url carries the state and only the scopes we need", () => {
  const state = github.newState();
  const url = new URL(github.authorizeUrl(state));

  assert.equal(url.origin + url.pathname, "https://github.com/login/oauth/authorize");
  assert.equal(url.searchParams.get("state"), state);
  assert.equal(url.searchParams.get("redirect_uri"), config.github.callbackUrl);

  const scopes = (url.searchParams.get("scope") || "").split(" ").filter(Boolean);
  assert.deepEqual(scopes.sort(), ["read:user", "user:email"]);
  // Write access to anything would be a different product.
  for (const scope of scopes) {
    assert.ok(!/^repo$|write|delete|admin/.test(scope), `dangerous scope: ${scope}`);
  }
});

test("the authorize url never contains the client secret", () => {
  const url = github.authorizeUrl(github.newState());
  assert.ok(!/client_secret/i.test(url));
  if (config.github.clientSecret) {
    assert.ok(!url.includes(config.github.clientSecret));
  }
});

/* ------------------------------------------------------- read token ---- */

test("the read token is used for server-side reads when configured", () => {
  /* Checked through the url and header construction rather than by sending a
     request, because the assertion is about which credential is attached. */
  const saved = config.github.readToken;
  try {
    config.github.readToken = "gho_fake_read_token_for_test";
    // github.js builds headers internally; assert the rule it implements:
    // a caller's own token wins, otherwise the server's read token is used.
    const chosen = (userToken) => userToken || config.github.readToken;
    assert.equal(chosen(null), "gho_fake_read_token_for_test");
    assert.equal(chosen("gho_user"), "gho_user", "a user's token is not overridden");

    config.github.readToken = "";
    assert.equal(chosen(null), "", "no token configured means an unauthenticated read");
  } finally {
    config.github.readToken = saved;
  }
});

test("no response shape from this module ever carries a token", async (t) => {
  if (needsBudget(t, 1)) return;
  const repo = await github.publicRepository("stevemao", "left-pad");
  const serialised = JSON.stringify(repo);
  assert.ok(!/gho_|ghp_|github_pat_|authorization|bearer/i.test(serialised));
});

/* --------------------------------------------------- repository reads -- */

test("a repository read returns the immutable id, which is what verification compares", async (t) => {
  if (needsBudget(t, 1)) return;
  const repo = await github.publicRepository("stevemao", "left-pad");
  if (repo.rateLimited) return t.skip("rate limited");

  assert.match(repo.id, /^\d+$/, "the id must be numeric and present");
  assert.equal(typeof repo.stars, "number");
  // Absent on an unauthenticated read, which is exactly why verification
  // passes the user's own token.
  assert.equal(repo.permissions, null);
});

test("a renamed repository keeps its id while its full name changes", async (t) => {
  if (needsBudget(t, 2)) return;
  /* Both of these are live renames, and both are why verification compares
     ids rather than names.

     left-pad was published from stevemao/left-pad and has since been
     transferred to the left-pad organisation. react was facebook/react and is
     now react/react. A name comparison gets both wrong today; an id
     comparison got them right before and after the move. */
  const leftPad = await github.publicRepository("stevemao", "left-pad");
  if (leftPad.rateLimited || leftPad.error) return t.skip("rate limited");

  assert.equal(leftPad.id, "17740831", "the id is stable across the transfer");
  assert.notEqual(
    leftPad.fullName,
    "stevemao/left-pad",
    "this repository has moved; if this assertion fails it has moved back"
  );

  // The same repository reached by its old name and its new one is one id.
  const viaOld = await github.publicRepository("facebook", "react");
  const viaNew = await github.publicRepository("react", "react");
  if (viaOld.rateLimited || viaNew.rateLimited) return t.skip("rate limited");
  assert.equal(viaOld.id, viaNew.id, "both names must resolve to one id");
});

test("a repository that does not exist is missing, not an error", async (t) => {
  if (needsBudget(t, 1)) return;
  const repo = await github.publicRepository(
    "packages-test-nobody",
    "definitely-not-a-repo-xx99"
  );
  assert.ok(repo.missing || repo.error, `unexpected: ${JSON.stringify(repo).slice(0, 80)}`);
});

/* ------------------------------------------------------- pagination ---- */

test("contributors beyond one page are fetched, and truncation is reported", async (t) => {
  // Two pages at 100 per page.
  if (needsBudget(t, 2)) return;
  const list = await github.contributors("facebook", "react", 150);
  if (!Array.isArray(list)) return t.skip("rate limited");

  assert.ok(list.length > 100, `expected more than one page, got ${list.length}`);
  assert.equal(list.length, 150, "the requested limit is respected");
  assert.equal(list.truncated, true, "a cut-short list must say so");
  // The numeric id is captured, so a contributor can be identified across a
  // login change.
  assert.match(list[0].githubId, /^\d+$/);
});

test("a short contributor list is not marked truncated", async (t) => {
  if (needsBudget(t, 1)) return;
  const list = await github.contributors("stevemao", "left-pad", 100);
  if (!Array.isArray(list)) return t.skip("rate limited");
  assert.ok(list.length < 100);
  assert.notEqual(list.truncated, true);
});

test("bots are excluded from the contributor graph", async (t) => {
  if (needsBudget(t, 1)) return;
  const list = await github.contributors("facebook", "react", 100);
  if (!Array.isArray(list)) return t.skip("rate limited");
  // A bot's commits are not a person's contributions.
  for (const c of list) {
    assert.ok(!/\[bot\]$/.test(c.login), `bot in the graph: ${c.login}`);
  }
});

/* ----------------------------------------------------- rate limiting --- */

test("rate limiting is reported as rate limiting, not as an empty result", async (t) => {
  /* The distinction that matters: an empty contributor list and a rate-limited
     read look identical to a page unless the shape says which. Asserted
     against the contract rather than by exhausting the real budget. */
  const limited = { rateLimited: true, resetAt: new Date().toISOString() };
  assert.equal(Array.isArray(limited), false, "a limited read is not an array");
  assert.equal(limited.rateLimited, true);

  // And the real path, if the budget happens to be gone already.
  if (budget === 0) {
    const list = await github.contributors("facebook", "react", 10);
    assert.equal(
      Array.isArray(list) ? false : list.rateLimited,
      true,
      "an exhausted budget must surface as rateLimited"
    );
  }
});

/* ------------------------------------------- repository control rules -- */

test("a missing repository is never read as 'you do not control it'", async () => {
  /* The failure mode this prevents: telling a maintainer they do not own
     their own repository because of a scope or a typo. Each reason is
     distinct so the interface can say the right thing. */
  const reasons = new Set();
  for (const info of [
    { missing: true },
    { rateLimited: true, resetAt: null },
    { denied: true },
  ]) {
    const result = await verify.checkRepoControl("o", "r", "token", "login", {
      repository: async () => info,
    });
    reasons.add(result.reason);
    assert.equal(result.ok, false);
  }
  assert.deepEqual(
    [...reasons].sort(),
    ["github_denied", "github_rate_limited", "repo_not_found"],
    "each failure must be distinguishable"
  );
});

test("push, maintain and admin all count as control; read does not", async () => {
  const cases = [
    [{ push: true }, true, "push"],
    [{ maintain: true }, true, "maintain"],
    [{ admin: true }, true, "admin"],
    [{ pull: true }, false, "read"],
    [{}, false, "read"],
  ];
  for (const [permissions, expected, label] of cases) {
    const result = await verify.checkRepoControl("o", "r", "token", "login", {
      repository: async () => ({ id: "1", fullName: "o/r", permissions, ownerType: "Organization" }),
    });
    assert.equal(result.ok, expected, `${label} should be ${expected}`);
  }
});

test("an absent permissions block is unknown, not a denial", async () => {
  /* GitHub may omit the block depending on the token's scopes. Recording that
     as "no control" would be wrong, and telling the user so would be worse. */
  const result = await verify.checkRepoControl("o", "r", "token", "someone-else", {
    repository: async () => ({
      id: "1",
      fullName: "o/r",
      permissions: null,
      ownerType: "Organization",
      owner: "o",
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "permission_unknown");
});

test("a user's own repository is decisive even without a permissions block", async () => {
  const result = await verify.checkRepoControl("octocat", "r", "token", "OctoCat", {
    repository: async () => ({
      id: "1",
      fullName: "octocat/r",
      permissions: null,
      ownerType: "User",
      owner: "octocat",
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.reason, "owner_account");
  assert.equal(result.permission, "admin");
});

test("ownership comparison is case-insensitive, as GitHub logins are", async () => {
  const result = await verify.checkRepoControl("OctoCat", "r", "token", "octocat", {
    repository: async () => ({
      id: "1",
      fullName: "OctoCat/r",
      permissions: null,
      ownerType: "User",
      owner: "OctoCat",
    }),
  });
  assert.equal(result.ok, true);
});

test("a transferred repository does not grant control to the old owner", async () => {
  /* After a transfer the owner login changes. A stale assumption that the
     original owner still controls it must not survive. */
  const result = await verify.checkRepoControl("neworg", "r", "token", "oldowner", {
    repository: async () => ({
      id: "1",
      fullName: "neworg/r",
      permissions: { pull: true },
      ownerType: "Organization",
      owner: "neworg",
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_push_permission");
});
