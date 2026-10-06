/* Sessions and the encryption of the stored GitHub token.

   The cookie carries a 32-byte random token. Only its sha256 is in the
   database, so a dump of the sessions table cannot be replayed as a login.
   The OAuth access token is encrypted with AES-256-GCM under a key derived
   from the session secret, because it is a credential that can read private
   repository metadata and must not sit in plaintext next to the rows that
   reference it. */

"use strict";

const crypto = require("crypto");
const { config } = require("./env");
const db = require("./db");
const { unauthorized } = require("./http");

const COOKIE = "packages_session";

let secret = config.sessionSecret;
if (!secret) {
  // No baked-in development default: a shared fixed key is a forgeable key.
  // An ephemeral one means restarting the server logs everyone out, which is
  // an inconvenience rather than a vulnerability.
  secret = crypto.randomBytes(32).toString("hex");
  console.warn(
    "[session] PACKAGES_SESSION_SECRET is not set; using an ephemeral key. " +
      "Sessions and stored GitHub tokens will not survive a restart."
  );
}

const KEY = crypto.createHash("sha256").update(`packages:aead:${secret}`).digest();

const hashToken = (token) =>
  crypto.createHash("sha256").update(`packages:session:${token}`).digest("hex");

/* --------------------------------------------------------------- aead ---- */

function encrypt(plaintext) {
  if (!plaintext) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const body = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher
    .getAuthTag()
    .toString("base64url")}.${body.toString("base64url")}`;
}

function decrypt(packed) {
  if (!packed) return null;
  const parts = String(packed).split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      KEY,
      Buffer.from(parts[1], "base64url")
    );
    decipher.setAuthTag(Buffer.from(parts[2], "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(parts[3], "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch (e) {
    // A failed tag means the key changed (a restart without a configured
    // secret) or the row was tampered with. Either way there is no token.
    return null;
  }
}

/* ------------------------------------------------------------ cookies ---- */

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const key = part.slice(0, eq).trim();
    if (!out[key]) out[key] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function cookieHeader(token, maxAgeSeconds) {
  const secure = config.siteOrigin.startsWith("https://");
  const bits = [
    `${COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    `Max-Age=${maxAgeSeconds}`,
    // The static site and the API are different origins in development, so
    // the cookie has to survive a cross-site request. Lax would not be sent
    // on the fetch from the site to the API, and None requires Secure, so
    // over plain http in development the cookie is Lax and the OAuth
    // redirect (a top-level navigation) still establishes it.
    secure ? "SameSite=None" : "SameSite=Lax",
  ];
  if (secure) bits.push("Secure");
  return bits.join("; ");
}

const clearCookieHeader = () =>
  `${COOKIE}=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax`;

/* ----------------------------------------------------------- lifecycle --- */

async function create(userId, githubToken) {
  const token = crypto.randomBytes(32).toString("base64url");
  const ttlSeconds = config.sessionTtlDays * 86400;
  const expires = new Date(Date.now() + ttlSeconds * 1000);
  await db.query(
    `insert into sessions (id, token_hash, user_id, gh_token, expires_at)
     values ($1, $2, $3, $4, $5)`,
    [
      crypto.randomUUID(),
      hashToken(token),
      userId,
      encrypt(githubToken),
      expires.toISOString(),
    ]
  );
  return { token, setCookie: cookieHeader(token, ttlSeconds), expires };
}

// Returns { user, sessionId, githubToken } or null. Never throws for a merely
// absent or stale cookie: that is a signed-out browser, not an error.
async function read(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token || token.length < 20 || token.length > 128) return null;
  const row = await db.one(
    `select s.id as session_id, s.gh_token, s.expires_at,
            u.id, u.github_id, u.github_login, u.display_name, u.avatar_url, u.profile_url
       from sessions s
       join users u on u.id = s.user_id
      where s.token_hash = $1`,
    [hashToken(token)]
  );
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await db.query("delete from sessions where id = $1", [row.session_id]);
    return null;
  }
  return {
    sessionId: row.session_id,
    githubToken: decrypt(row.gh_token),
    user: {
      id: row.id,
      githubId: String(row.github_id),
      login: row.github_login,
      name: row.display_name,
      avatarUrl: row.avatar_url,
      profileUrl: row.profile_url,
    },
  };
}

async function require_(req) {
  const session = await read(req);
  if (!session) throw unauthorized("sign in first");
  return session;
}

async function destroy(sessionId) {
  if (sessionId) await db.query("delete from sessions where id = $1", [sessionId]);
}

async function pruneExpired() {
  const r = await db.query("delete from sessions where expires_at <= now()");
  return r.rowCount || 0;
}

module.exports = {
  COOKIE,
  create,
  read,
  require: require_,
  destroy,
  pruneExpired,
  parseCookies,
  cookieHeader,
  clearCookieHeader,
  encrypt,
  decrypt,
  hashToken,
};
