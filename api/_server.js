/* The Packages API.

   A separate process from the static site, on its own port, so the front end
   stays a set of files that any static host can serve. Everything it needs is
   behind /api.

   Run: npm run api        (PACKAGES_DEV_DB=memory for a throwaway database)
        npm run dev        (site + api together)                           */

"use strict";

const http = require("http");
const { config } = require("./_lib/env");
const {
  send,
  sendError,
  notFound,
  corsHeaders,
  HttpError,
} = require("./_lib/http");
const ratelimit = require("./_lib/ratelimit");
const db = require("./_lib/db");
const session = require("./_lib/session");

const packages = require("./_routes/packages");
const auth = require("./_routes/auth");
const claims = require("./_routes/claims");
const wallet = require("./_routes/wallet");
const activity = require("./_routes/activity");
const identity = require("./_routes/identity");
const solana = require("./_lib/solana");
const refresh = require("./_lib/refresh");

/* ---------------------------------------------------------------- routes -- */

/* A path pattern with ":name" segments. The package name segment is special:
   npm names are scoped ("@scope/name"), so that one segment may contain an
   encoded slash and is matched greedily to the end of the known suffix. */
const ROUTES = [
  ["GET", "/api/health", health, null],
  ["GET", "/api/config", publicConfig, null],

  ["GET", "/api/packages/search", packages.search, "search"],
  ["GET", "/api/packages/featured", packages.featured, "read"],
  ["GET", "/api/packages/discover", packages.discover, "read"],
  ["GET", "/api/packages/:name/versions", packages.versions, "read"],
  ["GET", "/api/packages/:name/contributors", packages.contributors, "read"],
  ["GET", "/api/packages/:name/identity", identity.forPackage, "read"],
  ["GET", "/api/packages/:name", packages.detail, "read"],

  ["GET", "/api/activity", activity.feed, "read"],

  ["GET", "/api/auth/github/start", auth.start, "auth"],
  ["GET", "/api/auth/github/callback", auth.callback, "auth"],
  ["POST", "/api/auth/logout", auth.logout, "write"],
  ["POST", "/api/auth/privy", auth.privyLogin, "auth"],
  ["GET", "/api/me", auth.me, "read"],
  ["GET", "/api/developers/:login", auth.publicProfile, "read"],

  ["POST", "/api/claims/import", claims.importPackage, "write"],
  ["DELETE", "/api/claims/:name", claims.removeClaim, "write"],
  ["POST", "/api/verify/repo", claims.checkRepo, "verify"],
  ["POST", "/api/verify/publish/challenge", claims.publishChallenge, "verify"],
  ["POST", "/api/verify/publish/check", claims.checkPublishProof, "verify"],

  ["POST", "/api/wallet/challenge", wallet.challenge, "write"],
  ["POST", "/api/wallet/confirm", wallet.confirm, "verify"],
  ["POST", "/api/wallet/remove", wallet.remove, "write"],

  ["GET", "/api/identity/status", identity.status, "read"],
  ["POST", "/api/identity/register", identity.register, "write"],
  ["POST", "/api/identity/prepare", identity.prepare, "write"],
  ["POST", "/api/identity/submitted", identity.submitted, "write"],
  ["POST", "/api/identity/reconcile", identity.reconcile, "read"],
  ["POST", "/api/packages/:name/refresh", packages.refreshOne, "verify"],
];

async function health(req, res) {
  let database = "down";
  try {
    await db.query("select 1 as ok");
    database = db.driver === "pg-mem" ? "in-memory (development)" : "up";
  } catch (e) {
    database = `error: ${e.message}`;
  }
  send(req, res, 200, {
    ok: true,
    service: "packages-api",
    database,
    githubConfigured: config.githubConfigured,
    solanaProgramConfigured: Boolean(config.solana.programId),
    uptimeSeconds: Math.round(process.uptime()),
  });
}

/* What the browser may know: feature switches and public addresses, never a
   secret. The front end reads this once and hides the controls that cannot
   work rather than offering them and failing. */
async function publicConfig(req, res) {
  const cluster = await solana.clusterStatus();
  send(req, res, 200, {
    product: "Packages",
    githubLinking: config.githubConfigured,
    signIn: config.privyConfigured,
    solana: {
      cluster: cluster.cluster,
      programId: cluster.programId,
      programDeployed: cluster.programDeployed,
      walletProof: true,
      identityRegistration: cluster.canRegister,
      blocker: cluster.blocker,
    },
    proof: {
      field: require("./_lib/verify").PROOF_FIELD,
      keywordPrefix: require("./_lib/verify").PROOF_KEYWORD_PREFIX,
    },
  });
}

/* --------------------------------------------------------------- matcher -- */

function match(method, pathname) {
  for (const [routeMethod, pattern, handler, bucket] of ROUTES) {
    if (routeMethod !== method) continue;
    const params = matchPath(pattern, pathname);
    if (params) return { handler, params, bucket, pattern };
  }
  return null;
}

function matchPath(pattern, pathname) {
  // A literal pattern is an exact comparison; this keeps /api/packages/search
  // from being eaten by /api/packages/:name, which is listed after it.
  if (!pattern.includes(":")) {
    return pattern === pathname ? {} : null;
  }

  const pSegs = pattern.split("/");
  const uSegs = pathname.split("/");

  // A scoped package name decodes to two segments ("@scope/name"), so a
  // pattern containing :name may absorb one extra segment, and one only.
  if (uSegs.length !== pSegs.length) {
    const allowScoped = pSegs.includes(":name") && uSegs.length === pSegs.length + 1;
    if (!allowScoped) return null;
  }

  const params = {};
  let u = 0;
  for (let p = 0; p < pSegs.length; p++) {
    const seg = pSegs[p];
    if (seg.startsWith(":")) {
      const key = seg.slice(1);
      // How many url segments are left for the patterns after this one.
      const remainingPattern = pSegs.length - p - 1;
      const remainingUrl = uSegs.length - u;
      const take = remainingUrl - remainingPattern;
      if (take < 1 || take > 2) return null;
      params[key] = uSegs.slice(u, u + take).join("/");
      u += take;
      continue;
    }
    if (uSegs[u] !== seg) return null;
    u++;
  }
  if (u !== uSegs.length) return null;
  return params;
}

/* --------------------------------------------------------------- server --- */

async function handleRequest(req, res) {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  } catch (e) {
    return sendError(req, res, new HttpError(400, "bad_url", "malformed url"));
  }

  // Each segment is decoded individually: decoding the whole path first would
  // turn an encoded slash in a scoped package name into a path separator.
  let pathname;
  try {
    pathname = url.pathname
      .split("/")
      .map((s) => decodeURIComponent(s))
      .join("/");
  } catch (e) {
    return sendError(req, res, new HttpError(400, "bad_url", "malformed path encoding"));
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(req));
    return res.end();
  }

  const route = match(req.method, pathname);
  if (!route) {
    return sendError(req, res, notFound(`no route for ${req.method} ${pathname}`));
  }

  try {
    if (route.bucket) ratelimit.take(req, route.bucket);
    await route.handler(req, res, { url, params: route.params });
  } catch (err) {
    sendError(req, res, err);
  } finally {
    const ms = Date.now() - started;
    if (process.env.PACKAGES_LOG !== "off") {
      console.log(`${req.method} ${pathname} ${res.statusCode} ${ms}ms`);
    }
  }
}

/* The same handler, used two ways: a long-running server here, and
   exported below for a platform that invokes a function per request.
   Nothing differs between them but who owns the socket. */
const server = http.createServer(handleRequest);

async function main() {
  /* Refuse to start a misconfigured production process. Each of these would
     otherwise fail quietly and expensively: data lost on every deploy, or
     every session invalidated on every restart. */
  const problems = config.productionProblems();
  if (problems.length) {
    console.error(
      "[fatal] NODE_ENV=production, but this process is not configured for production:"
    );
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  for (const warning of config.productionWarnings()) {
    console.warn(`[config] ${warning}`);
  }

  const migrated = await db.migrate();
  console.log(
    `[db] ${migrated.driver}: ${migrated.statements} statements applied`
  );
  if (migrated.driver === "pg-mem") {
    console.warn(
      "[db] running on an in-memory database. Everything is lost on restart."
    );
  }
  if (!config.githubConfigured) {
    console.warn(
      "[auth] GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET are unset: sign-in is disabled and the site will say so."
    );
  }
  if (!config.solana.programId) {
    console.warn(
      "[solana] PACKAGES_PROGRAM_ID is unset: wallet proof works, identity registration reports that it is awaiting deployment."
    );
  }

  // Expired sessions are swept hourly rather than only on read, so the table
  // does not grow with abandoned logins.
  const sweeper = setInterval(() => {
    session.pruneExpired().catch((e) => console.warn("[session] prune failed", e.message));
  }, 3600000);
  sweeper.unref();

  /* Background refresh is off unless asked for: a development machine
     quietly spending someone else's rate limit is a surprise. */
  if (process.env.PACKAGES_REFRESH_INTERVAL_MS) {
    const started = refresh.start(Number(process.env.PACKAGES_REFRESH_INTERVAL_MS));
    console.log(`[refresh] background refresh every ${started.intervalMs}ms`);
  }

  server.listen(config.port, config.host, () => {
    console.log(`packages api on http://${config.host}:${config.port}/`);
    console.log(`  site origin allowed: ${config.siteOrigin}`);
  });
}

if (require.main === module) {
  main().catch((e) => {
    console.error("[fatal]", e.message);
    process.exit(1);
  });
}

/* migrate() is exported so a host embedding handleRequest can apply
   migrations before it starts serving, rather than discovering a missing
   table on the first request. */
const migrate = () => db.migrate();

module.exports = { server, handleRequest, migrate, match, matchPath, main, ROUTES };
