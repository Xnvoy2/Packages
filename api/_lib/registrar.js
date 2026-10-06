/* The registrar: the key this server signs registrations with.

   The program will not record an identity unless a registrar it knows
   co-signs the transaction. Verification happens off chain, so that
   signature is what tells the program the off-chain rules were satisfied.
   This server holds that key, pays the fees and the rent, and submits the
   transaction. The user's wallet is recorded as the owner and signs nothing
   here: it proved itself earlier, against a nonce, and that proof is a
   precondition the caller checks before anything in this file runs.

   The key is read from the filesystem or the environment, server side only.
   Nothing here is reachable from the browser, and no part of it is ever
   returned to a client. */

"use strict";

const fs = require("fs");
const crypto = require("crypto");
const {
  Connection, Keypair, PublicKey, SystemProgram,
  Transaction, TransactionInstruction, sendAndConfirmTransaction,
} = require("@solana/web3.js");

const { config } = require("./env");
const solana = require("./solana");
const { upstream, conflict, badRequest } = require("./http");

const CONFIG_SEED = Buffer.from("config");

/* Anchor's instruction discriminator: the first eight bytes of
   sha256("global:<name>"). The program is Anchor-generated, so this is how it
   tells its instructions apart. */
const discriminator = (name) =>
  crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

/* Borsh, only as much as this one instruction needs: a string is a u32
   length then its utf8 bytes, a u64 is eight little-endian bytes. */
const borshString = (s) => {
  const bytes = Buffer.from(String(s), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length);
  return Buffer.concat([len, bytes]);
};

const borshU64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n || 0));
  return b;
};

let cached = null;

/* The signing key. Either a path to a Solana keypair file or the array
   itself, so a host that offers files and one that offers only environment
   variables are both served without a second mechanism. */
function keypair() {
  if (cached) return cached;
  const raw = config.solana.registrarKey;
  if (!raw) {
    throw upstream("registrar", "no registrar key is configured, so nothing can be registered");
  }
  let secret;
  try {
    secret = raw.trim().startsWith("[")
      ? JSON.parse(raw)
      : JSON.parse(fs.readFileSync(raw.trim(), "utf8"));
  } catch (e) {
    throw upstream("registrar", "the registrar key could not be read");
  }
  try {
    cached = Keypair.fromSecretKey(Uint8Array.from(secret));
  } catch (e) {
    throw upstream("registrar", "the registrar key is not a valid Solana keypair");
  }
  return cached;
}

const publicKey = () => keypair().publicKey.toBase58();

const connection = () => new Connection(config.solana.rpcUrl, "confirmed");

/* The program's config account, which names the registrar it will accept.
   Checked before signing so a key mismatch is reported as the configuration
   error it is, rather than as an opaque failed transaction. */
async function readProgramConfig() {
  const programId = new PublicKey(config.solana.programId);
  const [address] = PublicKey.findProgramAddressSync([CONFIG_SEED], programId);
  const info = await connection().getAccountInfo(address);
  if (!info) return { address: address.toBase58(), initialised: false };
  const data = info.data;
  return {
    address: address.toBase58(),
    initialised: true,
    admin: new PublicKey(data.subarray(8, 40)).toBase58(),
    registrar: new PublicKey(data.subarray(40, 72)).toBase58(),
    identityCount: Number(data.readBigUInt64LE(72)),
    paused: data[80] === 1,
  };
}

/* Register one package identity.

   Everything this writes to the chain comes from what was already proved and
   stored: the package name, the repository the claim was verified against,
   the publisher's GitHub id, which rule was satisfied, and the wallet the
   user proved. Nothing is taken from the request. */
async function registerIdentity({ name, owner, repoId, repoFullName, publisherGithubId, verificationKind }) {
  if (!config.solana.programId) {
    throw upstream("registrar", "no program id is configured");
  }
  const signer = keypair();
  const programId = new PublicKey(config.solana.programId);
  const conn = connection();

  const programConfig = await readProgramConfig();
  if (!programConfig.initialised) {
    throw upstream("registrar", "the program has not been initialised on this cluster");
  }
  if (programConfig.paused) {
    throw upstream("registrar", "registration is paused on the program");
  }
  if (programConfig.registrar !== signer.publicKey.toBase58()) {
    throw upstream(
      "registrar",
      "this server's registrar key is not the one the program accepts"
    );
  }

  const derived = solana.identityAddress(name);
  const identity = new PublicKey(derived.address);

  /* Idempotency, decided by the chain rather than by us. The identity account
     is a PDA of the package name and is created with `init`, so a second
     registration cannot succeed. If it already exists, the work is already
     done and the existing account is reported rather than a second attempt
     made. A refresh or a retry therefore cannot produce two registrations. */
  const existing = await conn.getAccountInfo(identity);
  if (existing) {
    return {
      alreadyRegistered: true,
      identityAddress: identity.toBase58(),
      programId: programId.toBase58(),
      cluster: config.solana.cluster,
    };
  }

  const data = Buffer.concat([
    discriminator("register_identity"),
    borshString(name),
    borshU64(repoId),
    borshString(repoFullName || ""),
    borshU64(publisherGithubId),
    Buffer.from([verificationKind]),
  ]);

  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: new PublicKey(programConfig.address), isSigner: false, isWritable: true },
      { pubkey: identity, isSigner: false, isWritable: true },
      // The wallet the user proved. Recorded, never asked to sign.
      { pubkey: new PublicKey(owner), isSigner: false, isWritable: false },
      { pubkey: signer.publicKey, isSigner: true, isWritable: false },
      // This server pays the fee and the account's rent.
      { pubkey: signer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  let signature;
  try {
    signature = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [signer], {
      commitment: "confirmed",
      maxRetries: 3,
    });
  } catch (e) {
    /* A concurrent registration lands here: the account was created between
       the check above and this send. That is a success for the caller, not a
       failure, so it is reported as one. */
    const after = await conn.getAccountInfo(identity);
    if (after) {
      return {
        alreadyRegistered: true,
        identityAddress: identity.toBase58(),
        programId: programId.toBase58(),
        cluster: config.solana.cluster,
      };
    }
    throw upstream("registrar", `the registration was not accepted: ${e.message}`);
  }

  /* Confirmed is not the same as correct. The account is read back and
     checked to be owned by the program before any of this is called a
     success. */
  const account = await conn.getAccountInfo(identity);
  if (!account) {
    throw upstream("registrar", "the transaction confirmed but no identity account exists");
  }
  if (account.owner.toBase58() !== programId.toBase58()) {
    throw upstream("registrar", "an account exists at that address but the program does not own it");
  }

  return {
    alreadyRegistered: false,
    signature,
    identityAddress: identity.toBase58(),
    bump: derived.bump,
    programId: programId.toBase58(),
    cluster: config.solana.cluster,
    owner,
    registrar: signer.publicKey.toBase58(),
  };
}

module.exports = { registerIdentity, readProgramConfig, publicKey, configured: () => Boolean(config.solana.registrarKey) };
