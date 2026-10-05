/* Wallet ownership proof.

   A signature, not a transaction. The server issues a nonce, the browser has
   the wallet sign a message containing it, and the signature is checked
   against the public key here. No transaction is built, nothing is sent to a
   cluster and no key ever reaches the server. */

"use strict";

const { send, readJson, badRequest } = require("../lib/http");
const { config } = require("../lib/env");
const validate = require("../lib/validate");
const session = require("../lib/session");
const verify = require("../lib/verify");
const solana = require("../lib/solana");
const store = require("../lib/store");

async function challenge(req, res) {
  const current = await session.require(req);
  const issued = await verify.issueChallenge("wallet", current.user.id, null);
  const issuedAt = new Date().toISOString();
  send(req, res, 201, {
    nonce: issued.nonce,
    expiresAt: issued.expiresAt,
    cluster: config.solana.cluster,
    // The exact bytes to sign, so the browser never composes the message
    // itself and the two sides cannot disagree about what was signed.
    message: solana.walletProofMessage({
      nonce: issued.nonce,
      login: current.user.login,
      issuedAt,
    }),
    issuedAt,
  });
}

async function confirm(req, res) {
  const current = await session.require(req);
  const body = await readJson(req);
  const pubkey = validate.solanaPubkey(body.pubkey);
  const signature = validate.base64Signature(body.signature);
  const message = String(body.message || "");

  const stored = await verify.readChallenge("wallet", current.user.id, null);

  // The message must be the one that was issued, not merely contain the
  // nonce: accepting any text with the nonce in it would let a site have the
  // wallet sign something else entirely and present it here.
  if (!message.includes(`nonce: ${stored.nonce}`)) {
    throw badRequest("nonce_mismatch", "that message does not carry the issued nonce");
  }
  if (!message.startsWith("Packages: prove wallet ownership")) {
    throw badRequest("message_mismatch", "that is not the message this server issued");
  }
  if (!message.includes(`account: ${current.user.login}`)) {
    throw badRequest("message_mismatch", "that message was issued for a different account");
  }

  const ok = solana.verifySignature(pubkey, message, signature.bytes);
  if (!ok) {
    // Deliberately not consumed: a failed signature is usually a wallet
    // mishap, and making the user request a new nonce for it adds nothing.
    throw badRequest("bad_signature", "that signature does not match this wallet");
  }

  await verify.consumeChallenge(stored.id);
  await store.addWallet(current.user.id, pubkey, config.solana.cluster);
  await store.recordEvent("wallet.verified", {
    actorLogin: current.user.login,
    payload: { cluster: config.solana.cluster },
  });

  send(req, res, 200, {
    verified: true,
    pubkey,
    cluster: config.solana.cluster,
    wallets: (await store.walletsFor(current.user.id)).map((w) => ({
      pubkey: w.pubkey,
      cluster: w.cluster,
      verifiedAt: w.verified_at,
    })),
  });
}

async function remove(req, res) {
  const current = await session.require(req);
  const body = await readJson(req);
  const pubkey = validate.solanaPubkey(body.pubkey);
  const db = require("../lib/db");
  await db.query("delete from wallets where user_id = $1 and pubkey = $2", [
    current.user.id,
    pubkey,
  ]);
  send(req, res, 200, { removed: true, pubkey });
}

module.exports = { challenge, confirm, remove };
