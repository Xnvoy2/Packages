/* Configuration, read once from the environment.

   Every secret lives here and nowhere else. Nothing in this object is ever
   serialised to a response: the routes read what they need and return only
   derived, public values. The static front end has no access to any of it. */

"use strict";

const pick = (name, fallback) => {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
};

const config = {
  port: Number(pick("PORT", 4790)),
  host: pick("HOST", "127.0.0.1"),

  // The static site's origin. Used for CORS and for the post-OAuth redirect.
  siteOrigin: pick("PACKAGES_SITE_ORIGIN", "http://127.0.0.1:4789"),

  // Postgres. When unset the server refuses to start unless DEV_DB=memory.
  databaseUrl: pick("DATABASE_URL", pick("POSTGRES_URL", "")),
  // "memory" runs the same SQL against pg-mem, for local development and the
  // test suite. Never set it in production: the data is gone on restart.
  devDb: pick("PACKAGES_DEV_DB", ""),

  // Signing key for session cookies. A fixed development default would mean
  // every install shares a forgeable key, so there is none: the server
  // generates an ephemeral key and warns, which logs every user out on
  // restart rather than silently accepting forged cookies.
  sessionSecret: pick("PACKAGES_SESSION_SECRET", ""),
  sessionTtlDays: Number(pick("PACKAGES_SESSION_TTL_DAYS", 14)),

  github: {
    clientId: pick("GITHUB_CLIENT_ID", ""),
    clientSecret: pick("GITHUB_CLIENT_SECRET", ""),
    // Must match the callback registered on the OAuth app exactly.
    callbackUrl: pick(
      "GITHUB_CALLBACK_URL",
      "http://127.0.0.1:4790/api/auth/github/callback"
    ),
    // A token for unauthenticated reads lifts the GitHub rate limit from 60
    // to 5000 requests an hour. Optional.
    readToken: pick("GITHUB_READ_TOKEN", ""),
  },

  /* Privy owns signing in. Only the app id is needed, and it is public: the
     token is verified against Privy's published key set, so no Privy secret
     ever has to exist on this server. */
  privy: {
    appId: pick("PRIVY_APP_ID", ""),
  },

  solana: {
    cluster: "devnet",
    rpcUrl: pick("SOLANA_RPC_URL", "https://api.devnet.solana.com"),
    // The identity program's address, once it is deployed to devnet. Empty
    // means "not deployed", which every onchain surface reports honestly.
    programId: pick("PACKAGES_PROGRAM_ID", ""),
    /* The key this server signs registrations with. A path to a Solana
       keypair file, or the secret key array itself. Server side only: it is
       never sent to a browser and never appears in any response. */
    registrarKey: pick("PACKAGES_REGISTRAR_KEY", ""),
  },

  userAgent:
    "packages-identity/1.0 (+https://github.com/packages-identity) node-fetch",
};

config.privyConfigured = Boolean(config.privy.appId);

config.githubConfigured = Boolean(
  config.github.clientId && config.github.clientSecret
);
config.solanaProgramDeployed = Boolean(config.solana.programId);
config.isProduction = pick("NODE_ENV", "development") === "production";

/* What must be true before this process may serve production traffic.

   Returned rather than thrown so the caller decides, and so the test suite
   can assert the rule without starting a server. Each entry is a thing that
   would otherwise fail silently and badly: an in-memory database that loses
   every account on deploy, or an ephemeral session key that logs everyone out
   and makes stored GitHub tokens undecryptable on every restart. */
function productionProblems() {
  const problems = [];
  if (!config.isProduction) return problems;

  if (!config.databaseUrl) {
    problems.push(
      "DATABASE_URL is not set. Production must use PostgreSQL."
    );
  }
  if (config.devDb === "memory") {
    problems.push(
      "PACKAGES_DEV_DB=memory is set. That database is lost on every restart " +
        "and must never be used in production."
    );
  }
  if (!config.sessionSecret) {
    problems.push(
      "PACKAGES_SESSION_SECRET is not set. Without it the server generates an " +
        "ephemeral key, so every restart signs all users out and makes stored " +
        "GitHub tokens undecryptable."
    );
  } else if (config.sessionSecret.length < 32) {
    problems.push(
      "PACKAGES_SESSION_SECRET is shorter than 32 characters. Generate one " +
        "with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  if (config.siteOrigin.startsWith("http://") && !config.siteOrigin.includes("127.0.0.1")) {
    problems.push(
      `PACKAGES_SITE_ORIGIN is ${config.siteOrigin}. A production origin must ` +
        "be https, or the session cookie cannot be marked Secure."
    );
  }
  return problems;
}

/* Things that are allowed in production but reduce what the product can do.
   Reported at startup so they are a decision rather than a surprise. */
function productionWarnings() {
  const warnings = [];
  if (!config.githubConfigured) {
    warnings.push(
      "GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET are unset: sign-in is disabled " +
        "and the site says so. Browsing and package pages still work."
    );
  }
  if (!config.github.readToken) {
    warnings.push(
      "GITHUB_READ_TOKEN is unset: unauthenticated GitHub reads are limited to " +
        "60 an hour for the whole server, which real traffic exhausts almost " +
        "immediately. A fine-grained token with no scopes raises it to 5000."
    );
  }
  if (!config.solana.programId) {
    warnings.push(
      "PACKAGES_PROGRAM_ID is unset: wallet proof works, and identity " +
        "registration reports that it is awaiting deployment."
    );
  }
  return warnings;
}

config.productionProblems = productionProblems;
config.productionWarnings = productionWarnings;

module.exports = { config };
