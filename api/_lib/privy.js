/* Verifying a Privy login, server side.

   Privy issues the browser a JWT signed ES256 with a key published in the
   app's JWKS. Verifying it needs no Privy secret: the app id and the public
   key set are enough, which is the whole point of asymmetric signing. The
   secret is only for Privy's management API, and nothing here calls it.

   What this establishes is narrow and worth stating plainly: that the person
   holding this token completed a Privy login for this application, and which
   Privy account they are. It says nothing about npm, nothing about GitHub,
   and nothing about who publishes a package. Authority is proved elsewhere
   and is not weakened by anything in this file. */

"use strict";

const crypto = require("crypto");
const { config } = require("./env");
const { upstream, HttpError } = require("./http");

/* 401 with a specific code, so the client can tell an expired sign-in from a
   token meant for another application. rejected() flattens every case to
   one code, which is not enough to act on here. */
const rejected = (code, message) => new HttpError(401, code, message);

const JWKS_TTL_MS = 10 * 60 * 1000;
const CLOCK_SKEW_S = 60;

let jwks = { keys: [], fetchedAt: 0 };

function b64urlToBuffer(s) {
  return Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function decodeSegment(segment) {
  try {
    return JSON.parse(b64urlToBuffer(segment).toString("utf8"));
  } catch (e) {
    throw rejected("bad_token", "that sign-in token is not readable");
  }
}

/* The JWKS is cached, and refetched once when a token names a key id we have
   not seen. Privy rotates keys, and a rotation should cost one fetch rather
   than a failed sign-in. */
async function keySet(force) {
  const fresh = Date.now() - jwks.fetchedAt < JWKS_TTL_MS;
  if (!force && fresh && jwks.keys.length) return jwks.keys;

  const url = `https://auth.privy.io/api/v1/apps/${config.privy.appId}/jwks.json`;
  let res;
  try {
    res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": config.userAgent },
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    throw upstream("privy", `could not reach privy to verify the sign-in: ${e.message}`);
  }
  if (!res.ok) {
    throw upstream("privy", `privy returned ${res.status} for its key set`);
  }
  const body = await res.json();
  if (!body || !Array.isArray(body.keys)) {
    throw upstream("privy", "privy returned a key set this server cannot read");
  }
  jwks = { keys: body.keys, fetchedAt: Date.now() };
  return jwks.keys;
}

async function findKey(kid) {
  let keys = await keySet(false);
  let jwk = keys.find((k) => k.kid === kid);
  if (!jwk) {
    keys = await keySet(true);
    jwk = keys.find((k) => k.kid === kid);
  }
  if (!jwk) throw rejected("unknown_key", "that sign-in token was signed by an unknown key");
  return jwk;
}

/* Verify and return the claims.

   Checked: the signature against Privy's published key, the algorithm (so a
   token cannot talk the server into "none" or into an HMAC using the public
   key as its secret), the issuer, the audience against this app id, and both
   time bounds. A token that fails any of these is not a login. */
async function verifyToken(token) {
  if (!config.privy.appId) {
    throw upstream("privy", "PRIVY_APP_ID is not set, so no sign-in can be verified");
  }
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw rejected("bad_token", "that is not a sign-in token");

  const header = decodeSegment(parts[0]);
  const claims = decodeSegment(parts[1]);

  // Pinned, not read from the token: accepting the token's own choice of
  // algorithm is the classic JWT forgery.
  if (header.alg !== "ES256") {
    throw rejected("bad_algorithm", "that sign-in token is not signed the way privy signs");
  }

  const jwk = await findKey(header.kid);
  const key = crypto.createPublicKey({ key: jwk, format: "jwk" });

  const signed = Buffer.from(`${parts[0]}.${parts[1]}`, "utf8");
  const signature = b64urlToBuffer(parts[2]);
  // ES256 signatures are the raw r||s pair, not DER.
  const ok = crypto.verify("sha256", signed, { key, dsaEncoding: "ieee-p1363" }, signature);
  if (!ok) throw rejected("bad_signature", "that sign-in token did not verify");

  if (claims.iss !== "privy.io") {
    throw rejected("bad_issuer", "that sign-in token was not issued by privy");
  }
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(config.privy.appId)) {
    throw rejected("bad_audience", "that sign-in token was issued for a different application");
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === "number" && claims.exp + CLOCK_SKEW_S < now) {
    throw rejected("token_expired", "that sign-in has expired; sign in again");
  }
  if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_S > now) {
    throw rejected("token_early", "that sign-in token is not valid yet");
  }
  if (typeof claims.iat === "number" && claims.iat - CLOCK_SKEW_S > now) {
    throw rejected("token_early", "that sign-in token is dated in the future");
  }
  if (!claims.sub) {
    throw rejected("bad_token", "that sign-in token names no account");
  }

  return claims;
}

/* The identity token carries the linked accounts; the plain auth token does
   not. Either is accepted, and the account details are simply absent when
   they were not sent. Nothing here trusts a wallet address found in a token:
   a wallet becomes an owner only by signing the server's challenge. */
function describe(claims) {
  let linked = [];
  try {
    const raw = claims.linked_accounts;
    linked = typeof raw === "string" ? JSON.parse(raw) : Array.isArray(raw) ? raw : [];
  } catch (e) {
    linked = [];
  }
  const byType = (type) => linked.find((a) => a && a.type === type) || null;
  const email = byType("email");
  const wallet = linked.find((a) => a && a.type === "wallet" && a.chain_type === "solana") || null;

  return {
    did: String(claims.sub),
    email: (email && email.address) || null,
    // Reported for display only. It is not proof of control of this wallet.
    walletHint: (wallet && wallet.address) || null,
    sessionId: claims.sid || null,
  };
}

module.exports = { verifyToken, describe, keySet };
