/* GitHub sign-in, sign-out and "who am I".

   The OAuth state parameter is kept in a short-lived HttpOnly cookie and
   compared on the way back. Without that check, anyone could hand a victim a
   crafted callback url and sign them into an account the attacker controls. */

"use strict";

const crypto = require("crypto");
const { config } = require("../_lib/env");
const { send, redirect, badRequest, HttpError, readJson } = require("../_lib/http");
const session = require("../_lib/session");
const github = require("../_lib/github");
const privy = require("../_lib/privy");
const store = require("../_lib/store");
const present = require("../_lib/present");
const lifecycle = require("../_lib/lifecycle");

const STATE_COOKIE = "packages_oauth_state";

function stateCookie(value, maxAge) {
  const secure = config.siteOrigin.startsWith("https://");
  return [
    `${STATE_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    `Max-Age=${maxAge}`,
    secure ? "SameSite=None" : "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

async function start(req, res) {
  if (!config.githubConfigured) {
    throw new HttpError(
      503,
      "github_not_configured",
      "GitHub linking is not configured on this server: GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are unset"
    );
  }

  /* Refused before the round trip rather than after it. Sending someone to
     GitHub and only then finding they have no session wastes a consent
     screen and lands them on an error they did not cause. */
  const current = await session.read(req);
  if (!current) {
    throw new HttpError(
      401,
      "signin_first",
      "sign in first: GitHub proves authority over a repository, it does not sign you in"
    );
  }

  const state = github.newState();
  res.writeHead(302, {
    location: github.authorizeUrl(state),
    "set-cookie": stateCookie(state, 600),
    "cache-control": "no-store",
  });
  res.end();
}

async function callback(req, res, ctx) {
  if (!config.githubConfigured) {
    throw new HttpError(503, "github_not_configured", "GitHub sign-in is not configured");
  }

  const error = ctx.url.searchParams.get("error");
  if (error) {
    // The user pressed "cancel" on GitHub's consent screen. That is a normal
    // outcome, so it returns them to the page they started from with a
    // readable reason rather than showing a server error.
    return redirect(
      req,
      res,
      `${config.siteOrigin}/connect.html?auth=declined&reason=${encodeURIComponent(error)}`
    );
  }

  const code = ctx.url.searchParams.get("code");
  const state = ctx.url.searchParams.get("state");
  const expected = session.parseCookies(req)[STATE_COOKIE];

  if (!code || !state) throw badRequest("oauth_incomplete", "github returned no code");
  if (!expected) {
    throw badRequest(
      "oauth_state_missing",
      "the sign-in could not be matched to this browser; start again"
    );
  }
  const a = Buffer.from(state);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw badRequest("oauth_state_mismatch", "sign-in state did not match; start again");
  }

  /* GitHub is no longer a way in. It attaches repository authority to an
     account Privy has already signed in, so a session must exist here
     already. Without this check a GitHub round trip would quietly mint an
     account with no Privy identity, which is the model we moved away from. */
  const current = await session.read(req);
  if (!current) {
    return redirect(req, res, `${config.siteOrigin}/connect.html?github=signin_first`);
  }

  const { token } = await github.exchangeCode(code);
  const profile = await github.viewer(token);

  const linked = await store.linkGithub(current.user.id, profile);
  if (linked.conflict) {
    // That GitHub account already carries authority for a different Packages
    // account. Moving it would move whatever that account had proved.
    return redirect(req, res, `${config.siteOrigin}/connect.html?github=already_linked`);
  }

  /* The GitHub token lives on the session row, encrypted, and that row is
     written once at creation. Rather than add a mutable token column, the
     session is replaced: same user, same cookie mechanics, now carrying the
     token the repository checks need. */
  await session.destroy(current.sessionId);
  const created = await session.create(current.user.id, token);

  res.writeHead(302, {
    location: `${config.siteOrigin}/dashboard.html?github=linked`,
    "set-cookie": [created.setCookie, stateCookie("", 0)],
    "cache-control": "no-store",
  });
  res.end();
}

/* Signing in. The browser completes a Privy login and sends the token it was
   issued; this verifies it against Privy's published keys and exchanges it
   for the session cookie the rest of the api already uses.

   This establishes only that a Privy login happened and which account it
   was. It grants no authority over any package: every publisher rule still
   has to be satisfied separately, and nothing here touches them. */
async function privyLogin(req, res) {
  if (!config.privyConfigured) {
    throw new HttpError(503, "privy_not_configured", "sign-in is not configured");
  }
  const body = await readJson(req);
  const token = String(body.token || "").trim();
  if (!token) throw badRequest("token_missing", "no sign-in token was sent");

  const claims = await privy.verifyToken(token);
  const identity = privy.describe(claims);

  const user = await store.upsertPrivyUser(identity);
  const created = await session.create(user.id, null);

  send(
    req,
    res,
    200,
    {
      signedIn: true,
      user: {
        id: user.id,
        displayName: user.display_name,
        githubLogin: user.github_login || null,
        githubLinked: Boolean(user.github_id),
      },
    },
    { "set-cookie": created.setCookie }
  );
}

async function logout(req, res) {
  const current = await session.read(req);
  if (current) await session.destroy(current.sessionId);
  send(req, res, 200, { signedOut: true }, { "set-cookie": session.clearCookieHeader() });
}

async function me(req, res) {
  const current = await session.read(req);
  if (!current) {
    return send(req, res, 200, {
      signedIn: false,
      githubConfigured: config.githubConfigured,
      signInConfigured: config.privyConfigured,
    });
  }
  const [packages, wallets] = await Promise.all([
    store.packagesForUser(current.user.id),
    store.walletsFor(current.user.id),
  ]);

  /* Release history per claimed package, so the dashboard shows what has
     actually been published rather than only the claim state. Read from the
     local record, which is what an onchain release record would commit to. */
  const solana = require("../_lib/solana");
  const clusterState = await solana.clusterStatus();
  const registrations = {};
  for (const pkg of packages) {
    registrations[pkg.name] = await store.latestRegistration(pkg.name);
  }

  const releases = {};
  for (const pkg of packages) {
    releases[pkg.name] = (await store.releasesFor(pkg.name, 5)).map((r) => ({
      version: r.version,
      publishedAt: r.published_at,
      recordHash: r.record_hash,
      onchainTx: r.onchain_tx,
    }));
  }
  send(req, res, 200, {
    signedIn: true,
    githubConfigured: config.githubConfigured,
    signInConfigured: config.privyConfigured,
    // The OAuth token is never part of this, or any, response.
    releases,
    user: present.userProfile(
      {
        github_login: current.user.login,
        display_name: current.user.name,
        avatar_url: current.user.avatarUrl,
        profile_url: current.user.profileUrl,
        created_at: null,
      },
      packages.map((row) =>
        claimRow(row, {
          wallets,
          registration: registrations[row.name],
          registrationAvailable: clusterState.canRegister,
        })
      ),
      wallets
    ),
  });
}

/* A claim row as the dashboard wants it: the four proofs, the status computed
   by the one rule in verify.js, and what to do next. */
function claimRow(row, context) {
  const verify = require("../_lib/verify");
  const ctx = context || {};
  return {
    name: row.name,
    description: row.description,
    latestVersion: row.latest_version,
    repo:
      row.repo_owner && row.repo_name
        ? { owner: row.repo_owner, repo: row.repo_name, url: `https://github.com/${row.repo_owner}/${row.repo_name}` }
        : null,
    status: verify.statusFor(row),
    verified: verify.statusFor(row) === "verified",
    verifiedAt: row.verified_at,
    importedAt: row.created_at,
    launchedAt: row.launched_at,
    identityAddress: row.identity_pda,
    evidence: verify.evidenceFor(row),
    nextStep: verify.nextStepFor(row),
    /* The derived lifecycle state, so the dashboard and the package page agree
       about where this package has got to. */
    lifecycle: (() => {
      const state = lifecycle.stateFor(
        lifecycle.factsFrom({
          claim: row,
          pkg: row,
          wallets: ctx.wallets || [],
          registration: ctx.registration || null,
          registrationAvailable: Boolean(ctx.registrationAvailable),
        })
      );
      return {
        state,
        description: lifecycle.DESCRIPTIONS[state] || null,
        next: lifecycle.nextActionFor(state),
      };
    })(),
  };
}

async function publicProfile(req, res, ctx) {
  const login = String(ctx.params.login || "").trim();
  if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) {
    throw badRequest("bad_login", "not a valid GitHub login");
  }
  const user = await store.userByLogin(login);
  if (!user) {
    throw new HttpError(404, "not_found", "no developer with that login has signed in here");
  }
  const claims = await store.packagesForUser(user.id);
  // A public profile lists only what has been verified. A claim in progress is
  // the claimant's business, not a public statement about a package.
  const verified = claims
    .map(claimRow)
    .filter((c) => c.verified)
    .map((c) => ({ ...c, evidence: c.evidence.filter((e) => e.passed) }));

  /* The contribution graph, as GitHub reported it. Kept separate from the
     verified packages above and labelled as such: a contributor login and a
     signed-in account may well be the same person, but nothing here proves
     it, and saying so would be inventing a fact. */
  const contributed = await store.packagesForContributor(user.github_login);

  send(req, res, 200, {
    developer: {
      login: user.github_login,
      name: user.display_name,
      avatarUrl: user.avatar_url,
      profileUrl: user.profile_url,
      joinedAt: user.created_at,
    },
    packages: verified,
    claimedCount: claims.length,
    contributions: contributed.map((c) => ({
      package: c.package_name,
      description: c.description,
      latestVersion: c.latest_version,
      commits: c.contributions,
      source: "github_api",
      retrievedAt: c.retrieved_at,
    })),
  });
}

module.exports = { start, callback, logout, me, privyLogin, publicProfile, claimRow, STATE_COOKIE };
