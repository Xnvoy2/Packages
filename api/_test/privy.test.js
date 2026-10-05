/* Privy sign-in verification.

   A real Privy token cannot be minted here, so these tests stand up a local
   key pair, serve a JWKS from it, and point the verifier at that. What is
   being tested is this server's half of the exchange: that a well-formed
   token verifies, and that each way of tampering with one is refused.

   The forgery cases matter more than the happy path. A JWT verifier that
   accepts the token's own choice of algorithm, or skips the audience, is the
   usual way these are broken, and both would hand anyone an account here. */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const http = require("http");

const APP_ID = "test-app-id";
process.env.PRIVY_APP_ID = APP_ID;
process.env.PACKAGES_DEV_DB = process.env.PACKAGES_DEV_DB || "memory";

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = publicKey.export({ format: "jwk" });
jwk.kid = "test-key";
jwk.alg = "ES256";
jwk.use = "sig";

let server = null;
let privy = null;

function sign(claims, { alg = "ES256", kid = "test-key", key = privateKey } = {}) {
  const header = b64url(JSON.stringify({ alg, kid, typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  const signed = Buffer.from(`${header}.${payload}`, "utf8");
  if (alg === "none") return `${header}.${payload}.`;
  if (alg === "HS256") {
    // The classic confusion attack: sign with the public key as an HMAC
    // secret and hope the verifier trusts the header.
    const mac = crypto.createHmac("sha256", publicKey.export({ type: "spki", format: "pem" })).update(signed).digest();
    return `${header}.${payload}.${b64url(mac)}`;
  }
  const sig = crypto.sign("sha256", signed, { key, dsaEncoding: "ieee-p1363" });
  return `${header}.${payload}.${b64url(sig)}`;
}

const base = (over) => ({
  sub: "did:privy:abc123",
  iss: "privy.io",
  aud: APP_ID,
  iat: Math.floor(Date.now() / 1000) - 10,
  exp: Math.floor(Date.now() / 1000) + 600,
  ...over,
});

test.before(async () => {
  await new Promise((resolve) => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    server.listen(0, "127.0.0.1", resolve);
  });

  /* The verifier builds the JWKS url from Privy's host. Point fetch at the
     local server for that one url instead, so no network is involved and the
     test cannot pass because of something Privy did. */
  const realFetch = global.fetch;
  const port = server.address().port;
  global.fetch = (url, init) => {
    if (String(url).includes("auth.privy.io")) {
      return realFetch(`http://127.0.0.1:${port}/jwks.json`, init);
    }
    return realFetch(url, init);
  };

  privy = require("../_lib/privy.js");
});

test.after(() => { if (server) server.close(); });

test("a correctly signed token verifies and yields the account", async () => {
  const claims = await privy.verifyToken(sign(base()));
  assert.equal(claims.sub, "did:privy:abc123");
  const who = privy.describe(claims);
  assert.equal(who.did, "did:privy:abc123");
});

test("a token signed by a different key is refused", async () => {
  const other = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  await assert.rejects(() => privy.verifyToken(sign(base(), { key: other })), /did not verify/i);
});

test("alg: none is refused", async () => {
  await assert.rejects(() => privy.verifyToken(sign(base(), { alg: "none" })), /signed the way/i);
});

test("an HMAC token using the public key as its secret is refused", async () => {
  await assert.rejects(() => privy.verifyToken(sign(base(), { alg: "HS256" })), /signed the way/i);
});

test("a token for another application is refused", async () => {
  await assert.rejects(() => privy.verifyToken(sign(base({ aud: "someone-elses-app" }))), /different application/i);
});

test("a token from another issuer is refused", async () => {
  await assert.rejects(() => privy.verifyToken(sign(base({ iss: "evil.example" }))), /not issued by privy/i);
});

test("an expired token is refused", async () => {
  const past = Math.floor(Date.now() / 1000) - 3600;
  await assert.rejects(() => privy.verifyToken(sign(base({ iat: past, exp: past + 60 }))), /expired/i);
});

test("a token naming no account is refused", async () => {
  await assert.rejects(() => privy.verifyToken(sign(base({ sub: undefined }))), /names no account/i);
});

test("a token signed by an unknown key id is refused", async () => {
  await assert.rejects(() => privy.verifyToken(sign(base(), { kid: "not-a-key" })), /unknown key/i);
});

test("garbage is refused rather than throwing something unhelpful", async () => {
  await assert.rejects(() => privy.verifyToken("not.a.token"), /not readable|not a sign-in token/i);
  await assert.rejects(() => privy.verifyToken(""), /not a sign-in token/i);
});

test("a wallet address inside the token is a hint, never a proof", async () => {
  const claims = await privy.verifyToken(
    sign(base({ linked_accounts: JSON.stringify([{ type: "wallet", chain_type: "solana", address: "SoMeAddress" }]) }))
  );
  const who = privy.describe(claims);
  // Named as a hint deliberately: ownership is established by signing the
  // server's challenge, never by what an identity token claims.
  assert.equal(who.walletHint, "SoMeAddress");
  assert.ok(!("walletProved" in who));
});
