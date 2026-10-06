/* Launching the verified package's coin on Pump.

   The split is deliberate and is the whole point of this file. Packages pays
   for and signs the identity account, because that is a record this service
   is making. The coin is created by the publisher's own proven wallet,
   because the publisher is its creator and should receive whatever Pump
   assigns to a creator. This server never signs a create: it builds the
   transaction and the browser hands it to the wallet that was already
   proved.

   Nothing here decides who is allowed to launch. That is settled before this
   file is reached, by the same publisher-authority and wallet-ownership
   checks the identity registration uses.

   The instruction layout is not guessed. It was read from the program's own
   Anchor IDL on devnet: create(name, symbol, uri, creator) over fourteen
   accounts, discriminator [24,30,200,40,5,28,7,119]. */

"use strict";

const {
  Connection, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY,
  Transaction, TransactionInstruction, Keypair,
} = require("@solana/web3.js");

const { config } = require("./env");
const { upstream, badRequest } = require("./http");

/* Pump deploys the same program id to devnet and mainnet, with different
   builds behind it. Which cluster is in use is decided by the rpc url the
   rest of the product already uses, so a coin cannot be created on a cluster
   the identity was not registered on. */
const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const MPL_TOKEN_METADATA = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const CREATE_DISCRIMINATOR = Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]);

/* Pump's limits, enforced here so a name that cannot be created is refused
   before a wallet is asked to sign it. */
const MAX_NAME = 32;
const MAX_SYMBOL = 10;
const MAX_URI = 200;

const borshString = (s) => {
  const bytes = Buffer.from(String(s), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length);
  return Buffer.concat([len, bytes]);
};

/* A package name is not a ticker. npm allows 214 characters, scopes and
   dots; Pump allows ten upper-case-ish characters. This derives one
   deterministically so the same package always produces the same symbol,
   and so the mapping back to the package is obvious to a reader. */
function symbolFor(packageName) {
  const bare = String(packageName).replace(/^@/, "").replace(/\//g, "-");
  const letters = bare.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return (letters || "PKG").slice(0, MAX_SYMBOL);
}

/* The coin's displayed name. Truncated rather than rejected, because a long
   package name is normal and should not block a launch. */
const nameFor = (packageName) => String(packageName).slice(0, MAX_NAME);

/* Metadata is served by this api from what was already verified, so the coin
   points back at the package and its Packages page rather than at an upload
   nobody can check. */
function metadataUri(packageName) {
  const base = String(config.siteOrigin || "").replace(/\/$/, "");
  return `${base}/api/packages/${encodeURIComponent(packageName)}/coin-metadata`;
}

const addresses = (mint) => {
  const [mintAuthority] = PublicKey.findProgramAddressSync([Buffer.from("mint-authority")], PUMP_PROGRAM);
  const [bondingCurve] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()], PUMP_PROGRAM
  );
  const [associatedBondingCurve] = PublicKey.findProgramAddressSync(
    [bondingCurve.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM
  );
  const [global] = PublicKey.findProgramAddressSync([Buffer.from("global")], PUMP_PROGRAM);
  const [metadata] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), MPL_TOKEN_METADATA.toBuffer(), mint.toBuffer()],
    MPL_TOKEN_METADATA
  );
  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")], PUMP_PROGRAM
  );
  return { mintAuthority, bondingCurve, associatedBondingCurve, global, metadata, eventAuthority };
};

/* Build the transaction, unsigned except for the mint.

   The creator and the fee payer are both the wallet the publisher proved.
   The caller passes that address; it is never taken from the request, so a
   client cannot substitute a different wallet after verification. */
async function buildCreateTransaction({ packageName, creatorWallet }) {
  if (!creatorWallet) throw badRequest("no_wallet", "no proven wallet to create the coin with");

  const user = new PublicKey(creatorWallet);
  const mintKeypair = Keypair.generate();
  const mint = mintKeypair.publicKey;

  const name = nameFor(packageName);
  const symbol = symbolFor(packageName);
  const uri = metadataUri(packageName);
  if (uri.length > MAX_URI) {
    throw upstream("pump", "the metadata url is longer than Pump accepts");
  }

  const a = addresses(mint);
  const data = Buffer.concat([
    CREATE_DISCRIMINATOR,
    borshString(name),
    borshString(symbol),
    borshString(uri),
    user.toBuffer(),
  ]);

  const ix = new TransactionInstruction({
    programId: PUMP_PROGRAM,
    keys: [
      { pubkey: mint, isSigner: true, isWritable: true },
      { pubkey: a.mintAuthority, isSigner: false, isWritable: false },
      { pubkey: a.bondingCurve, isSigner: false, isWritable: true },
      { pubkey: a.associatedBondingCurve, isSigner: false, isWritable: true },
      { pubkey: a.global, isSigner: false, isWritable: false },
      { pubkey: MPL_TOKEN_METADATA, isSigner: false, isWritable: false },
      { pubkey: a.metadata, isSigner: false, isWritable: true },
      // The publisher's proven wallet: creator, signer and payer.
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: a.eventAuthority, isSigner: false, isWritable: false },
      { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },
    ],
    data,
  });

  const conn = new Connection(config.solana.rpcUrl, "confirmed");
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");

  const tx = new Transaction({ feePayer: user, blockhash, lastValidBlockHeight }).add(ix);
  /* The mint is a fresh account, so its key has to sign. It is signed here
     and nowhere else: it is not a wallet, it holds nothing, and it exists
     only for this one transaction. The publisher's wallet signature is still
     required and is added in the browser. */
  tx.partialSign(mintKeypair);

  return {
    transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
    mint: mint.toBase58(),
    name,
    symbol,
    uri,
    creator: user.toBase58(),
    bondingCurve: a.bondingCurve.toBase58(),
    cluster: config.solana.cluster,
    lastValidBlockHeight,
  };
}

/* Read back what actually happened, rather than trusting the browser's word
   that it sent something. */
async function readCoin(mint) {
  const conn = new Connection(config.solana.rpcUrl, "confirmed");
  const mintKey = new PublicKey(mint);
  const [bondingCurve] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mintKey.toBuffer()], PUMP_PROGRAM
  );
  const [curve, mintAccount] = await Promise.all([
    conn.getAccountInfo(bondingCurve),
    conn.getAccountInfo(mintKey),
  ]);
  return {
    exists: Boolean(curve && mintAccount),
    bondingCurve: bondingCurve.toBase58(),
    ownedByPump: Boolean(curve && curve.owner.equals(PUMP_PROGRAM)),
  };
}

module.exports = {
  buildCreateTransaction,
  readCoin,
  symbolFor,
  nameFor,
  metadataUri,
  PUMP_PROGRAM: PUMP_PROGRAM.toBase58(),
};
