/* Solana: wallet-ownership proof, and the derivation of a package identity.

   Two things happen here and one does not. Wallet proof is complete and runs
   today: the browser signs a message this server issued and the signature is
   checked against the public key. Identity derivation is also complete and
   deterministic, so every surface can show the address a package's identity
   account will have.

   What does not happen here is a transaction. Nothing in this file builds,
   signs or sends one, and no instruction reaches a cluster. Registering an
   identity onchain needs the program in ../solana/programs to be deployed to
   devnet, which is an explicit, approved step. Until config.solana.programId
   is set, every function that would touch the chain reports that plainly
   rather than pretending. */

"use strict";

const crypto = require("crypto");
const { PublicKey } = require("@solana/web3.js");
const { config } = require("./env");
const { fetchJson } = require("./http");
const cache = require("./cache");

/* --------------------------------------------------- signature checking -- */

// Node's ed25519 verify wants a key object. A raw 32-byte Solana address
// becomes one by wrapping it in the fixed SPKI prefix for Ed25519.
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function publicKeyFromAddress(address) {
  const raw = new PublicKey(address).toBytes();
  return crypto.createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, Buffer.from(raw)]),
    format: "der",
    type: "spki",
  });
}

/* Verify that `address` signed `message`.

   createPublicKey does not validate that the bytes are a point on the curve,
   so a successful import proves nothing on its own. The verify call below is
   the test that matters, and a malformed key simply fails it. */
function verifySignature(address, message, signatureBytes) {
  try {
    const key = publicKeyFromAddress(address);
    return crypto.verify(
      null,
      Buffer.from(message, "utf8"),
      key,
      Buffer.from(signatureBytes)
    );
  } catch (e) {
    return false;
  }
}

/* The exact text the wallet is asked to sign. One line per fact so a person
   reading the Phantom prompt can see what they are agreeing to, and the nonce
   makes a captured signature useless anywhere else. */
function walletProofMessage({ nonce, login, issuedAt }) {
  return [
    "Packages: prove wallet ownership",
    "",
    `account: ${login}`,
    `cluster: ${config.solana.cluster}`,
    `nonce: ${nonce}`,
    `issued: ${issuedAt}`,
    "",
    "Signing this proves you hold this wallet's key.",
    "It is not a transaction. No funds move and nothing is sent.",
  ].join("\n");
}

/* ----------------------------------------------------- identity accounts -- */

/* A package's identity address is derived from its name, so it is the same
   address on every machine, before and after registration, and nobody has to
   be told what it is.

   The name is always hashed into the seed, never used literally. A Solana
   seed is capped at 32 bytes and npm allows 214 characters, so a literal seed
   could not address most of the namespace. Hashing every name makes each one
   reachable and leaves exactly one scheme, so there is nothing to collide
   with. The full name is stored in the account, so nothing is lost.

   This must stay identical to `package_hash` in the Anchor program; the
   parity test in api/test/solana.test.js asserts it against the same vectors
   the Rust tests use. */
const IDENTITY_SEED = Buffer.from("package");
const RELEASE_SEED = Buffer.from("release");

const nameHash = (packageName) =>
  crypto.createHash("sha256").update(Buffer.from(packageName, "utf8")).digest();

function identitySeeds(packageName) {
  return [IDENTITY_SEED, nameHash(packageName)];
}

/* The seed set for one release record, under its identity account. The
   version is hashed for the same reason the name is: a prerelease version
   can exceed 32 bytes. */
function releaseSeeds(identityAddress, version) {
  return [
    RELEASE_SEED,
    new PublicKey(identityAddress).toBytes(),
    crypto.createHash("sha256").update(Buffer.from(version, "utf8")).digest(),
  ];
}

/* Returns null when no program id is configured: an address derived from a
   program that does not exist would be a number with no meaning behind it. */
function identityAddress(packageName) {
  if (!config.solana.programId) return null;
  try {
    const programId = new PublicKey(config.solana.programId);
    const [pda, bump] = PublicKey.findProgramAddressSync(
      identitySeeds(packageName),
      programId
    );
    return {
      address: pda.toBase58(),
      bump,
      programId: config.solana.programId,
      cluster: config.solana.cluster,
      seedScheme: "sha256",
    };
  } catch (e) {
    return null;
  }
}

/* The deterministic address of one release record. Null when no program is
   configured, for the same reason identityAddress() is. */
function releaseAddress(packageName, version) {
  if (!config.solana.programId) return null;
  const identity = identityAddress(packageName);
  if (!identity) return null;
  try {
    const [pda, bump] = PublicKey.findProgramAddressSync(
      releaseSeeds(identity.address, version),
      new PublicKey(config.solana.programId)
    );
    return { address: pda.toBase58(), bump, identity: identity.address };
  } catch (e) {
    return null;
  }
}

/* The hash that an onchain release record commits to. Computed the same way
   here and in the program, over a canonical string rather than over a JSON
   encoding, because two JSON encoders do not have to agree on key order and
   this has to be reproducible by anyone checking it. */
function releaseRecordHash({ packageName, version, publishedAt, tarballIntegrity }) {
  const canonical = [
    "packages.release.v1",
    packageName,
    version,
    publishedAt || "",
    tarballIntegrity || "",
  ].join("\n");
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

/* ---------------------------------------------------------------- status -- */

/* Whether the chain side is usable, and if not, exactly what is missing. Every
   onchain surface in the product reads this rather than deciding for itself. */
/* Cached: every page load asks /api/config, which asks this, which would
   otherwise make two live RPC calls to devnet per visitor. Whether a program
   is deployed changes about once, so a minute of staleness costs nothing and
   takes ~60ms off every page load. */
async function clusterStatus() {
  return cache.through("solana:cluster-status", 60000, clusterStatusFresh);
}

async function clusterStatusFresh() {
  const base = {
    cluster: config.solana.cluster,
    rpcUrl: config.solana.rpcUrl,
    programId: config.solana.programId || null,
    programDeployed: false,
    rpcReachable: false,
    canRegister: false,
    blocker: null,
  };

  if (!config.solana.programId) {
    base.blocker =
      "the package identity program has not been deployed to devnet, so no identity can be registered yet";
  }

  const res = await fetchJson(config.solana.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getVersion" }),
    timeout: 6000,
  });
  base.rpcReachable = Boolean(res.ok && res.json && res.json.result);
  if (base.rpcReachable) {
    base.rpcVersion = res.json.result["solana-core"] || null;
  }

  if (config.solana.programId && base.rpcReachable) {
    // A deployed program has an executable account at its address.
    const account = await fetchJson(config.solana.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAccountInfo",
        params: [config.solana.programId, { encoding: "base64" }],
      }),
      timeout: 8000,
    });
    const value = account.json && account.json.result && account.json.result.value;
    base.programDeployed = Boolean(value && value.executable);
    if (!base.programDeployed) {
      base.blocker = `no executable program at ${config.solana.programId} on ${config.solana.cluster}`;
    }
  }

  base.canRegister = base.programDeployed && base.rpcReachable;
  return base;
}

module.exports = {
  verifySignature,
  publicKeyFromAddress,
  walletProofMessage,
  identityAddress,
  identitySeeds,
  releaseSeeds,
  releaseAddress,
  nameHash,
  releaseRecordHash,
  clusterStatus,
};
