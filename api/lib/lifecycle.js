/* The launch lifecycle, as an explicit state machine.

   Before this, a package's state was inferred wherever it was needed: the
   dashboard looked at some booleans, the connect page at others, and the
   onchain surfaces at a third set. Inference in several places is how two
   surfaces come to disagree about the same package.

   There is now one state, derived from the facts, with the legal moves
   written down. Two rules make it trustworthy:

     1. **The facts are authoritative, not the state.** The state is computed
        from what has actually been proved and what the chain actually says.
        It is stored as well, but only ever as a cache of the derivation, so
        a stored state can never drift into claiming something unproved.

     2. **Illegal moves throw.** Any change that would move a package
        backwards, or skip a stage, is refused before it is written. A package
        cannot reach ONCHAIN without having been PUBLISHER_VERIFIED, whatever
        a caller passes.

   States and the order they advance in:

     DISCOVERED          the package exists on npm; nobody has claimed it
     CONNECTING          a claim row exists; nothing proved
     GITHUB_CONNECTED    the claimant has a GitHub session on the claim
     REPOSITORY_VERIFIED they control the repository the package declares
     PUBLISHER_VERIFIED  publish authority proved: the verification rule passed
     WALLET_VERIFIED     a wallet signature was checked for the owner
     READY_TO_LAUNCH     everything a registration needs is in place
     TRANSACTION_PENDING a signature has been reported, not yet reconciled
     ONCHAIN             the server read the chain and all three facts agreed

   And the two that are not a stage:

     FAILED              a submitted transaction did not confirm
     REVOKED             the verification was withdrawn

   REPOSITORY_VERIFIED is deliberately not on the only path to
   PUBLISHER_VERIFIED. The publish-proof route skips it entirely, which is the
   whole point of having two routes. */

"use strict";

const { HttpError } = require("./http");
const verify = require("./verify");

const STATES = {
  DISCOVERED: "DISCOVERED",
  CONNECTING: "CONNECTING",
  GITHUB_CONNECTED: "GITHUB_CONNECTED",
  REPOSITORY_VERIFIED: "REPOSITORY_VERIFIED",
  PUBLISHER_VERIFIED: "PUBLISHER_VERIFIED",
  WALLET_VERIFIED: "WALLET_VERIFIED",
  READY_TO_LAUNCH: "READY_TO_LAUNCH",
  TRANSACTION_PENDING: "TRANSACTION_PENDING",
  ONCHAIN: "ONCHAIN",
  FAILED: "FAILED",
  REVOKED: "REVOKED",
};

/* How far along each state is. Used to refuse a backwards move without
   enumerating every pair; the explicit table below handles the exceptions. */
const RANK = {
  DISCOVERED: 0,
  CONNECTING: 1,
  GITHUB_CONNECTED: 2,
  REPOSITORY_VERIFIED: 3,
  PUBLISHER_VERIFIED: 4,
  WALLET_VERIFIED: 5,
  READY_TO_LAUNCH: 6,
  TRANSACTION_PENDING: 7,
  ONCHAIN: 8,
  FAILED: 7,
  REVOKED: 1,
};

/* Every legal move. Anything absent is refused.

   Self-transitions are legal throughout: re-running a check that passes again
   is a no-op, and a retry must not be an error. */
const TRANSITIONS = {
  DISCOVERED: ["CONNECTING"],
  CONNECTING: ["GITHUB_CONNECTED", "REVOKED", "DISCOVERED"],
  GITHUB_CONNECTED: [
    "REPOSITORY_VERIFIED",
    // The publish-proof route reaches publisher verification directly,
    // without ever linking a repository.
    "PUBLISHER_VERIFIED",
    "REVOKED",
  ],
  REPOSITORY_VERIFIED: ["PUBLISHER_VERIFIED", "GITHUB_CONNECTED", "REVOKED"],
  PUBLISHER_VERIFIED: ["WALLET_VERIFIED", "REVOKED"],
  WALLET_VERIFIED: ["READY_TO_LAUNCH", "PUBLISHER_VERIFIED", "REVOKED"],
  READY_TO_LAUNCH: ["TRANSACTION_PENDING", "WALLET_VERIFIED", "REVOKED"],
  // A pending transaction resolves one of three ways, and may stay pending
  // across any number of reconciliation attempts.
  TRANSACTION_PENDING: ["ONCHAIN", "FAILED", "READY_TO_LAUNCH"],
  // Failure is recoverable: prepare again.
  FAILED: ["READY_TO_LAUNCH", "TRANSACTION_PENDING", "REVOKED"],
  /* ONCHAIN is terminal for the registration. An identity account exists and
     this program has no instruction that removes one, so no transition can
     honestly claim it is gone. Revoking the Packages verification does not
     un-write the chain, and must not pretend to. */
  ONCHAIN: [],
  REVOKED: ["CONNECTING"],
};

/* Derive the state from the facts.

   `facts` is deliberately flat and explicit rather than a database row, so
   the derivation can be read and tested without a schema in mind. */
function stateFor(facts) {
  const f = facts || {};

  if (f.onchainConfirmed) return STATES.ONCHAIN;
  if (f.transactionPending) return STATES.TRANSACTION_PENDING;
  if (f.transactionFailed) return STATES.FAILED;
  if (f.revoked) return STATES.REVOKED;

  // Publisher verification is the hinge. Everything above it needs it.
  const publisherVerified =
    Boolean(f.publishProof) || (Boolean(f.repoControl) && Boolean(f.trustedPublisher));

  if (publisherVerified) {
    if (!f.walletVerified) return STATES.PUBLISHER_VERIFIED;
    // A wallet alone is not readiness: the program has to exist to register
    // against, and that is a deployment fact rather than a user one.
    return f.registrationAvailable ? STATES.READY_TO_LAUNCH : STATES.WALLET_VERIFIED;
  }

  if (f.repoControl) return STATES.REPOSITORY_VERIFIED;
  if (f.claimed) return f.githubConnected ? STATES.GITHUB_CONNECTED : STATES.CONNECTING;
  return STATES.DISCOVERED;
}

/* The facts, read from the rows that hold them. One place that knows which
   column means what, so the derivation above stays about logic. */
function factsFrom({ claim, pkg, wallets, registration, registrationAvailable }) {
  const c = claim || {};
  const p = pkg || {};
  const r = registration || {};

  return {
    claimed: Boolean(claim),
    // A claim only exists for a signed-in account, so its existence is the
    // GitHub connection.
    githubConnected: Boolean(claim),
    repoControl: Boolean(c.repo_control),
    trustedPublisher: Boolean(c.trusted_publisher),
    publishProof: Boolean(c.publish_proof),
    revoked: c.status === "revoked",
    walletVerified: Array.isArray(wallets) && wallets.length > 0,
    registrationAvailable: Boolean(registrationAvailable),
    // Only a reconciled registration counts. A client-reported signature is
    // pending, never onchain.
    onchainConfirmed: Boolean(p.identity_pda) && r.status !== "failed",
    transactionPending: r.status === "submitted" || r.status === "prepared_submitted",
    transactionFailed: r.status === "failed" || r.status === "dropped",
  };
}

function isLegal(from, to) {
  if (from === to) return true;
  const allowed = TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/* Refuse an illegal move loudly. Callers do not get to decide whether to
   honour this: it throws. */
function assertTransition(from, to) {
  if (!STATES[from]) {
    throw new HttpError(500, "unknown_state", `unknown state ${from}`);
  }
  if (!STATES[to]) {
    throw new HttpError(500, "unknown_state", `unknown state ${to}`);
  }
  if (!isLegal(from, to)) {
    throw new HttpError(
      409,
      "illegal_transition",
      `a package cannot move from ${from} to ${to}`,
      { from, to, allowed: TRANSITIONS[from] }
    );
  }
  return to;
}

/* What the interface should offer next, in one place, so the connect page,
   the dashboard and the package page cannot disagree about it. */
function nextActionFor(state) {
  switch (state) {
    case STATES.DISCOVERED:
      return { action: "connect", label: "connect this package" };
    case STATES.CONNECTING:
      return { action: "sign_in", label: "sign in with GitHub" };
    case STATES.GITHUB_CONNECTED:
      return { action: "verify", label: "link the repository, or prove the package" };
    case STATES.REPOSITORY_VERIFIED:
      return {
        action: "prove",
        label: "prove publish authority: controlling the repository is not enough",
      };
    case STATES.PUBLISHER_VERIFIED:
      return { action: "connect_wallet", label: "connect a wallet" };
    case STATES.WALLET_VERIFIED:
      return {
        action: "wait_for_deployment",
        label: "registration is unavailable until the identity program is deployed",
      };
    case STATES.READY_TO_LAUNCH:
      return { action: "launch", label: "launch on Solana" };
    case STATES.TRANSACTION_PENDING:
      return { action: "reconcile", label: "checking the cluster" };
    case STATES.ONCHAIN:
      return null;
    case STATES.FAILED:
      return { action: "retry", label: "the transaction did not confirm; try again" };
    case STATES.REVOKED:
      return { action: "reclaim", label: "this verification was withdrawn" };
    default:
      return null;
  }
}

/* A description of the state for a human, used by the api so every surface
   explains it the same way. */
const DESCRIPTIONS = {
  DISCOVERED: "this package exists on npm and nobody has claimed it here",
  CONNECTING: "a claim has been started and nothing has been proved yet",
  GITHUB_CONNECTED: "a GitHub account is attached to this claim",
  REPOSITORY_VERIFIED:
    "the claimant controls the repository this package declares, which is not by itself authority to publish it",
  PUBLISHER_VERIFIED: "authority to publish this package has been proved",
  WALLET_VERIFIED: "a wallet has been proved, and registration is awaiting the program deployment",
  READY_TO_LAUNCH: "everything a registration needs is in place",
  TRANSACTION_PENDING: "a transaction was reported and the server has not yet confirmed it on the cluster",
  ONCHAIN: "an identity account exists on the cluster, confirmed by the server reading it",
  FAILED: "the transaction did not confirm",
  REVOKED: "the verification was withdrawn",
};

/* Guard a fact change: derive the state before and after, and refuse the
   write if the move is not legal. Used by the routes that change facts, so
   the rule is enforced at the point of writing rather than hoped for. */
function guard(beforeFacts, afterFacts) {
  const from = stateFor(beforeFacts);
  const to = stateFor(afterFacts);
  assertTransition(from, to);
  return { from, to };
}

module.exports = {
  STATES,
  RANK,
  TRANSITIONS,
  DESCRIPTIONS,
  stateFor,
  factsFrom,
  isLegal,
  assertTransition,
  nextActionFor,
  guard,
  // Re-exported so a caller never has to reach past this module for the rule
  // that decides publisher verification.
  statusFor: verify.statusFor,
};
