/* Onchain package identity: what it will be, what it is, and what it is not.

   The address is deterministic, so it can be shown before anything exists at
   it. Registration is a three-call lifecycle, because a browser cannot be
   trusted to report the outcome of its own transaction:

     prepare   the server derives the address, records a "prepared" row, and
               hands back a blockhash and the exact parameters. Nothing is
               signed and nothing is sent.
     submitted the client reports a signature. The server records it and
               believes nothing further.
     reconcile the server asks an RPC node itself: did that signature succeed,
               does an account exist at the derived address, and is it owned
               by our program. Only all three move the row to confirmed.

   Nothing in this file builds, signs or broadcasts a transaction. Registering
   needs the Anchor program deployed to devnet, which is an explicit, approved
   step; until then prepare refuses with the blocker named. */

"use strict";

const crypto = require("crypto");
const {
  send,
  forbidden,
  badRequest,
  readJson,
  notFound,
  conflict,
} = require("../_lib/http");
const { config } = require("../_lib/env");
const validate = require("../_lib/validate");
const session = require("../_lib/session");
const solana = require("../_lib/solana");
const chain = require("../_lib/chain");
const store = require("../_lib/store");
const db = require("../_lib/db");
const registrar = require("../_lib/registrar");

/* The two rules the program accepts, matching VerificationKind in the
   program source. Kept here rather than imported so a change on either side
   is a visible mismatch rather than a silent one. */
const VERIFICATION_PUBLISH_PROOF = 1;
const VERIFICATION_REPO_AND_ATTESTATION = 2;

async function status(req, res) {
  const cluster = await solana.clusterStatus();
  send(req, res, 200, {
    ...cluster,
    state: cluster.canRegister ? "ready" : "awaiting_deployment",
    capabilities: {
      walletProof: true,
      identityDerivation: Boolean(config.solana.programId),
      identityRegistration: cluster.canRegister,
      releaseRecording: cluster.canRegister,
      // The reader works whether or not our program exists, and says so.
      chainReads: cluster.rpcReachable,
    },
  });
}

async function forPackage(req, res, ctx) {
  const name = validate.packageName(ctx.params.name);
  const row = await store.getPackage(name);
  const releases = row ? await store.releasesFor(name, 20) : [];
  const cluster = await solana.clusterStatus();
  const registrations = row ? await store.registrationsFor(name) : [];

  send(req, res, 200, {
    name,
    derived: solana.identityAddress(name),
    registered:
      row && row.identity_pda
        ? { address: row.identity_pda, tx: row.identity_tx, at: row.launched_at }
        : null,
    // Append-only: every attempt, not just the one that worked.
    attempts: registrations.map((r) => ({
      status: r.status,
      signature: r.tx_signature,
      cluster: r.cluster,
      preparedAt: r.prepared_at,
      confirmedAt: r.confirmed_at,
      reconciledAt: r.reconciled_at,
      error: r.error,
    })),
    cluster: {
      cluster: cluster.cluster,
      programId: cluster.programId,
      programDeployed: cluster.programDeployed,
      blocker: cluster.blocker,
    },
    releaseRecords: releases.map((r) => ({
      version: r.version,
      publishedAt: r.published_at,
      recordHash: r.record_hash,
      onchainTx: r.onchain_tx,
      derivedAddress: solana.releaseAddress(name, r.version),
    })),
    note: cluster.canRegister
      ? null
      : "the identity program is not deployed, so no account exists at the derived address yet",
  });
}

/* Everything the owner must have before a transaction could be built. Shared
   by prepare and by the review step in the interface, so the two cannot
   disagree about what is missing. */
async function registrationPreconditions(name, user) {
  const row = await store.getPackage(name);
  if (!row) throw notFound("import that package first");
  if (row.verified_owner_id !== user.id) {
    throw forbidden("only the developer who verified a package can register its identity");
  }

  const wallets = await store.walletsFor(user.id);
  if (!wallets.length) {
    throw badRequest(
      "no_wallet",
      "prove a wallet first: the identity account records who registered it"
    );
  }

  const derived = solana.identityAddress(name);
  const cluster = await solana.clusterStatus();
  return { row, wallets, derived, cluster };
}

/* Step one. Records the intent, hands back everything a client needs to build
   the transaction, and signs nothing. */
async function prepare(req, res) {
  const current = await session.require(req);
  const body = await readJson(req);
  const name = validate.packageName(body.name);

  const { row, wallets, derived, cluster } = await registrationPreconditions(
    name,
    current.user
  );

  if (row.identity_pda) {
    throw conflict("already_registered", "this package already has an identity onchain");
  }

  if (!cluster.canRegister) {
    // Refuse rather than queue. A button that records an intention and reports
    // success would be the dishonest version of this.
    return send(req, res, 503, {
      prepared: false,
      reason: "awaiting_deployment",
      blocker:
        cluster.blocker || "the package identity program has not been deployed to devnet",
      // Everything that is ready, so the state is legible rather than a bare
      // failure, and so the interface can show the review step truthfully.
      wouldRegister: {
        package: name,
        derivedAddress: derived ? derived.address : null,
        authority: wallets[0].pubkey,
        cluster: config.solana.cluster,
        releaseRecords: (await store.releasesFor(name, 5)).map((r) => ({
          version: r.version,
          recordHash: r.record_hash,
        })),
      },
      note: "nothing was sent to any cluster. Deploying the program is a separate, approved step.",
    });
  }

  const blockhash = await chain.latestBlockhash();
  if (!blockhash.ok) {
    return send(req, res, 503, {
      prepared: false,
      reason: "rpc_unavailable",
      blocker: `could not reach ${config.solana.rpcUrl}: ${blockhash.reason}`,
    });
  }

  const attempt = await store.recordRegistrationAttempt({
    packageName: name,
    identityPda: derived.address,
    programId: config.solana.programId,
    cluster: config.solana.cluster,
    authority: wallets[0].pubkey,
  });

  await store.audit("identity.prepare", {
    userId: current.user.id,
    login: current.user.login,
    subject: name,
    detail: { attemptId: attempt.id, derived: derived.address },
  });

  send(req, res, 201, {
    prepared: true,
    attemptId: attempt.id,
    package: name,
    derivedAddress: derived.address,
    bump: derived.bump,
    programId: config.solana.programId,
    cluster: config.solana.cluster,
    authority: wallets[0].pubkey,
    blockhash: blockhash.blockhash,
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
    note: "nothing has been signed or sent. Sign in your wallet, then report the signature.",
  });
}

/* Step two. The client reports what it sent. This is recorded and nothing
   more: the signature is a claim until reconcile checks it. */
async function submitted(req, res) {
  const current = await session.require(req);
  const body = await readJson(req);
  const name = validate.packageName(body.name);
  const signature = validate.transactionSignature(body.signature);

  const row = await store.getPackage(name);
  if (!row) throw notFound("unknown package");
  if (row.verified_owner_id !== current.user.id) {
    throw forbidden("only the verified owner can report a registration");
  }

  const attempt = await store.attachSignature(name, signature);
  if (!attempt) {
    throw badRequest("no_prepared_attempt", "prepare a registration first");
  }

  await store.audit("identity.submitted", {
    userId: current.user.id,
    login: current.user.login,
    subject: name,
    detail: { signature },
  });

  send(req, res, 202, {
    recorded: true,
    signature,
    status: "submitted",
    // Said plainly, because this is the exact point where a product usually
    // starts lying.
    note:
      "recorded as submitted. This is not confirmation: the server checks the cluster itself before anything is marked onchain.",
  });
}

/* Step three. The server asks the chain and writes down what it finds. Safe
   to call repeatedly, and safe to call after a restart: the state lives in
   the database, not in a request in flight. */
async function reconcile(req, res) {
  const current = await session.require(req);
  const body = await readJson(req);
  const name = validate.packageName(body.name);

  const row = await store.getPackage(name);
  if (!row) throw notFound("unknown package");
  if (row.verified_owner_id !== current.user.id) {
    throw forbidden("only the verified owner can reconcile a registration");
  }

  const attempt = await store.latestRegistration(name);
  if (!attempt) throw badRequest("nothing_to_reconcile", "no registration has been prepared");

  const derived = solana.identityAddress(name);
  const result = await chain.reconcileRegistration({
    signature: attempt.tx_signature,
    identityAddress: attempt.identity_pda || (derived && derived.address),
  });

  const outcome = await store.applyReconciliation(attempt.id, name, result);

  await store.audit("identity.reconcile", {
    userId: current.user.id,
    login: current.user.login,
    subject: name,
    detail: { status: result.status, reason: result.reason || null },
  });

  send(req, res, 200, {
    status: result.status,
    reason: result.reason || null,
    // The package is only onchain when the chain says so.
    onchain: outcome.onchain,
    identityAddress: attempt.identity_pda,
    signature: attempt.tx_signature,
    checkedAt: new Date().toISOString(),
  });
}

/* The single call the dashboard makes to put a package onchain.

   The server is the registrar and the payer: it signs the registration with
   the key the program accepts, pays the fee and the rent, and submits. The
   user's wallet is recorded as the owner and signs nothing here. It signed
   earlier, against a nonce this server issued, and that proof is one of the
   preconditions below.

   None of the verification rules are relaxed to make this work. The package
   must be imported, the signed-in user must be its verified owner, and a
   wallet must have been proved. The facts written to the chain all come from
   what was already stored, never from the request. */
async function register(req, res) {
  const current = await session.require(req);
  const body = await readJson(req);
  const name = validate.packageName(body.name);

  const { row, wallets, derived, cluster } = await registrationPreconditions(
    name,
    current.user
  );

  // Already onchain, so report that rather than attempt a second one.
  if (row.identity_pda) {
    return send(req, res, 200, {
      registered: true,
      alreadyRegistered: true,
      package: name,
      identityAddress: row.identity_pda,
      signature: row.identity_tx,
      cluster: config.solana.cluster,
    });
  }

  if (!cluster.canRegister) {
    return send(req, res, 503, {
      registered: false,
      reason: "awaiting_deployment",
      blocker: cluster.blocker || "the program is not available on this cluster",
    });
  }
  if (!registrar.configured()) {
    return send(req, res, 503, {
      registered: false,
      reason: "no_registrar",
      blocker: "this server has no registrar key, so it cannot sign a registration",
    });
  }

  /* Which rule was satisfied, taken from the stored claim rather than
     assumed. The program records it, so it has to be the truth. */
  const claim = await store.claimView(name, current.user.id);
  if (!claim || !claim.verified_at) {
    throw forbidden("that package has not been verified, so it cannot be registered");
  }
  const verificationKind = claim.publish_proof
    ? VERIFICATION_PUBLISH_PROOF
    : VERIFICATION_REPO_AND_ATTESTATION;

  const repo = await store.repositoryFor(name);
  const attempt = await store.recordRegistrationAttempt({
    packageName: name,
    identityPda: derived.address,
    programId: config.solana.programId,
    cluster: config.solana.cluster,
    authority: wallets[0].pubkey,
  });

  const result = await registrar.registerIdentity({
    name,
    owner: wallets[0].pubkey,
    repoId: repo ? repo.github_id : 0,
    repoFullName: repo ? repo.full_name : "",
    publisherGithubId: current.user.github_id || 0,
    verificationKind,
  });

  /* Persisted through the same path a reported signature would take, so one
     place decides what "onchain" means. */
  if (result.signature) await store.attachSignature(attempt.id, result.signature);
  await store.applyReconciliation(attempt.id, name, {
    status: "confirmed",
    slot: null,
  });

  await store.audit("identity.registered", {
    userId: current.user.id,
    login: current.user.github_login || current.user.id,
    subject: name,
    detail: { address: result.identityAddress, signature: result.signature || null },
  });

  send(req, res, 201, {
    registered: true,
    alreadyRegistered: Boolean(result.alreadyRegistered),
    package: name,
    identityAddress: result.identityAddress,
    signature: result.signature || null,
    programId: result.programId,
    cluster: result.cluster,
    owner: wallets[0].pubkey,
    registrar: result.registrar || registrar.publicKey(),
    explorer: result.signature
      ? `https://explorer.solana.com/tx/${result.signature}?cluster=${config.solana.cluster}`
      : null,
  });
}

module.exports = { status, forPackage, prepare, submitted, reconcile, register };
