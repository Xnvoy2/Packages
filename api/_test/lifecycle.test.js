/* The launch state machine.

   Two properties are worth testing and one is not. Worth testing: that the
   state derived from a set of facts is the right one, and that no illegal
   move is accepted. Not worth testing: that the transition table contains
   what the transition table contains.

   So these drive the derivation with real fact combinations, including the
   ones that would be wrong in a dangerous way. */

"use strict";

process.env.PACKAGES_DEV_DB = process.env.DATABASE_URL ? "" : "memory";
process.env.PACKAGES_SESSION_SECRET =
  process.env.PACKAGES_SESSION_SECRET || "test-secret-not-for-production";

const test = require("node:test");
const assert = require("node:assert/strict");

const lifecycle = require("../_lib/lifecycle");
const { STATES } = lifecycle;

/* Facts for a package at each stage, built by adding one thing at a time, so
   each test states exactly what is true rather than inheriting a blob. */
const base = {
  claimed: false,
  githubConnected: false,
  repoControl: false,
  trustedPublisher: false,
  publishProof: false,
  walletVerified: false,
  registrationAvailable: false,
  onchainConfirmed: false,
  transactionPending: false,
  transactionFailed: false,
  revoked: false,
};

const facts = (over) => ({ ...base, ...over });

/* ------------------------------------------------------- derivation ---- */

test("an unclaimed package is DISCOVERED", () => {
  assert.equal(lifecycle.stateFor(facts({})), STATES.DISCOVERED);
});

test("a claim without proof is GITHUB_CONNECTED", () => {
  // A claim only exists for a signed-in account, so the two arrive together.
  assert.equal(
    lifecycle.stateFor(facts({ claimed: true, githubConnected: true })),
    STATES.GITHUB_CONNECTED
  );
});

test("repository control alone is REPOSITORY_VERIFIED, never further", () => {
  const state = lifecycle.stateFor(
    facts({ claimed: true, githubConnected: true, repoControl: true })
  );
  assert.equal(state, STATES.REPOSITORY_VERIFIED);
  assert.notEqual(state, STATES.PUBLISHER_VERIFIED);
});

test("publish proof alone reaches PUBLISHER_VERIFIED without a repository", () => {
  /* The second route exists precisely so a package with no repository, or a
     publisher who cannot prove repository control, is not locked out. */
  assert.equal(
    lifecycle.stateFor(
      facts({ claimed: true, githubConnected: true, publishProof: true })
    ),
    STATES.PUBLISHER_VERIFIED
  );
});

test("repository control plus npm attestation reaches PUBLISHER_VERIFIED", () => {
  assert.equal(
    lifecycle.stateFor(
      facts({
        claimed: true,
        githubConnected: true,
        repoControl: true,
        trustedPublisher: true,
      })
    ),
    STATES.PUBLISHER_VERIFIED
  );
});

test("an attestation without repository control does not verify the publisher", () => {
  // npm attesting that some repository built a release says nothing about
  // whether this claimant controls it.
  assert.equal(
    lifecycle.stateFor(
      facts({ claimed: true, githubConnected: true, trustedPublisher: true })
    ),
    STATES.GITHUB_CONNECTED
  );
});

test("a wallet without publisher verification does not advance anything", () => {
  /* The dangerous inversion: proving a wallet is easy and proving publish
     authority is not, so a wallet must never stand in for it. */
  const state = lifecycle.stateFor(
    facts({ claimed: true, githubConnected: true, walletVerified: true })
  );
  assert.equal(state, STATES.GITHUB_CONNECTED);
  assert.notEqual(state, STATES.WALLET_VERIFIED);
  assert.notEqual(state, STATES.READY_TO_LAUNCH);
});

test("a verified publisher with a wallet waits on the deployment", () => {
  assert.equal(
    lifecycle.stateFor(
      facts({ claimed: true, githubConnected: true, publishProof: true, walletVerified: true })
    ),
    STATES.WALLET_VERIFIED,
    "without a deployed program there is nothing to register against"
  );
});

test("READY_TO_LAUNCH needs the publisher, the wallet and the program", () => {
  assert.equal(
    lifecycle.stateFor(
      facts({
        claimed: true,
        githubConnected: true,
        publishProof: true,
        walletVerified: true,
        registrationAvailable: true,
      })
    ),
    STATES.READY_TO_LAUNCH
  );
});

test("a reported transaction is PENDING, not ONCHAIN", () => {
  /* The single most important case in this file. A client saying it sent a
     transaction must never produce the onchain state. */
  const state = lifecycle.stateFor(
    facts({
      claimed: true,
      githubConnected: true,
      publishProof: true,
      walletVerified: true,
      registrationAvailable: true,
      transactionPending: true,
    })
  );
  assert.equal(state, STATES.TRANSACTION_PENDING);
  assert.notEqual(state, STATES.ONCHAIN);
});

test("ONCHAIN requires the confirmed fact, which only reconciliation sets", () => {
  assert.equal(
    lifecycle.stateFor(facts({ claimed: true, onchainConfirmed: true })),
    STATES.ONCHAIN
  );
});

test("a failed transaction is FAILED and keeps the verification", () => {
  const state = lifecycle.stateFor(
    facts({
      claimed: true,
      githubConnected: true,
      publishProof: true,
      walletVerified: true,
      registrationAvailable: true,
      transactionFailed: true,
    })
  );
  assert.equal(state, STATES.FAILED);
});

test("revocation outranks the proofs that are still recorded", () => {
  /* The claim row keeps its evidence columns for the trail; the state must
     still say revoked. */
  assert.equal(
    lifecycle.stateFor(
      facts({ claimed: true, githubConnected: true, publishProof: true, revoked: true })
    ),
    STATES.REVOKED
  );
});

/* ------------------------------------------------------- transitions --- */

test("the forward path is legal at every step", () => {
  const path = [
    STATES.DISCOVERED,
    STATES.CONNECTING,
    STATES.GITHUB_CONNECTED,
    STATES.REPOSITORY_VERIFIED,
    STATES.PUBLISHER_VERIFIED,
    STATES.WALLET_VERIFIED,
    STATES.READY_TO_LAUNCH,
    STATES.TRANSACTION_PENDING,
    STATES.ONCHAIN,
  ];
  for (let i = 0; i < path.length - 1; i++) {
    assert.ok(
      lifecycle.isLegal(path[i], path[i + 1]),
      `${path[i]} -> ${path[i + 1]} should be legal`
    );
  }
});

test("the publish-proof route may skip the repository stage", () => {
  assert.ok(lifecycle.isLegal(STATES.GITHUB_CONNECTED, STATES.PUBLISHER_VERIFIED));
});

test("no stage can be skipped to ONCHAIN", () => {
  for (const from of [
    STATES.DISCOVERED,
    STATES.CONNECTING,
    STATES.GITHUB_CONNECTED,
    STATES.REPOSITORY_VERIFIED,
    STATES.PUBLISHER_VERIFIED,
    STATES.WALLET_VERIFIED,
    STATES.READY_TO_LAUNCH,
  ]) {
    assert.ok(
      !lifecycle.isLegal(from, STATES.ONCHAIN),
      `${from} must not jump straight to ONCHAIN`
    );
  }
  // Only a pending transaction may become onchain.
  assert.ok(lifecycle.isLegal(STATES.TRANSACTION_PENDING, STATES.ONCHAIN));
});

test("a package cannot be verified without being connected", () => {
  assert.ok(!lifecycle.isLegal(STATES.DISCOVERED, STATES.PUBLISHER_VERIFIED));
  assert.ok(!lifecycle.isLegal(STATES.DISCOVERED, STATES.REPOSITORY_VERIFIED));
  assert.ok(!lifecycle.isLegal(STATES.CONNECTING, STATES.PUBLISHER_VERIFIED));
});

test("ONCHAIN is terminal", () => {
  /* The program has no instruction that removes an identity account, so no
     transition may claim the chain state is gone. Revoking the Packages
     verification is a separate fact and does not un-write the chain. */
  for (const to of Object.values(STATES)) {
    if (to === STATES.ONCHAIN) continue;
    assert.ok(
      !lifecycle.isLegal(STATES.ONCHAIN, to),
      `ONCHAIN must not move to ${to}`
    );
  }
});

test("a retry of the same state is always legal", () => {
  // Reconciling twice, or re-running a check that passes again, is a no-op
  // and must not be an error.
  for (const state of Object.values(STATES)) {
    assert.ok(lifecycle.isLegal(state, state), `${state} -> ${state}`);
  }
});

test("an illegal transition throws with both states named", () => {
  assert.throws(
    () => lifecycle.assertTransition(STATES.DISCOVERED, STATES.ONCHAIN),
    (e) =>
      e.code === "illegal_transition" &&
      e.status === 409 &&
      /DISCOVERED/.test(e.message) &&
      /ONCHAIN/.test(e.message)
  );
});

test("an unknown state is refused rather than silently allowed", () => {
  assert.throws(() => lifecycle.assertTransition("MADE_UP", STATES.ONCHAIN));
  assert.throws(() => lifecycle.assertTransition(STATES.DISCOVERED, "MADE_UP"));
});

/* ------------------------------------------------------------ guard ---- */

test("guard accepts a legal fact change", () => {
  const before = facts({ claimed: true, githubConnected: true });
  const after = facts({ claimed: true, githubConnected: true, repoControl: true });
  const moved = lifecycle.guard(before, after);
  assert.equal(moved.from, STATES.GITHUB_CONNECTED);
  assert.equal(moved.to, STATES.REPOSITORY_VERIFIED);
});

test("guard refuses a fact change that would skip verification", () => {
  /* Somebody writing onchainConfirmed on an unverified package: the facts
     would produce ONCHAIN from DISCOVERED, and that must not be written. */
  const before = facts({});
  const after = facts({ onchainConfirmed: true });
  assert.throws(() => lifecycle.guard(before, after), (e) => e.code === "illegal_transition");
});

test("guard refuses un-launching a package", () => {
  const before = facts({ claimed: true, onchainConfirmed: true });
  const after = facts({ claimed: true, githubConnected: true });
  assert.throws(() => lifecycle.guard(before, after), (e) => e.code === "illegal_transition");
});

/* ------------------------------------------------------------ facts ---- */

test("factsFrom reads the rows the database actually holds", () => {
  const derived = lifecycle.factsFrom({
    claim: { repo_control: true, trusted_publisher: true, publish_proof: false, status: "verified" },
    pkg: { identity_pda: null },
    wallets: [{ pubkey: "x" }],
    registration: null,
    registrationAvailable: false,
  });
  assert.equal(derived.repoControl, true);
  assert.equal(derived.trustedPublisher, true);
  assert.equal(derived.walletVerified, true);
  assert.equal(derived.onchainConfirmed, false);
  assert.equal(lifecycle.stateFor(derived), STATES.WALLET_VERIFIED);
});

test("a package row with an identity address is onchain, a pending one is not", () => {
  const onchain = lifecycle.factsFrom({
    claim: { publish_proof: true },
    pkg: { identity_pda: "GkoT..." },
    wallets: [{ pubkey: "x" }],
    registration: { status: "confirmed" },
  });
  assert.equal(lifecycle.stateFor(onchain), STATES.ONCHAIN);

  const pending = lifecycle.factsFrom({
    claim: { publish_proof: true },
    pkg: { identity_pda: null },
    wallets: [{ pubkey: "x" }],
    registration: { status: "submitted" },
    registrationAvailable: true,
  });
  assert.equal(lifecycle.stateFor(pending), STATES.TRANSACTION_PENDING);
});

/* ------------------------------------------------------- next action --- */

test("every state has an action or is deliberately terminal", () => {
  for (const state of Object.values(STATES)) {
    const next = lifecycle.nextActionFor(state);
    if (state === STATES.ONCHAIN) {
      assert.equal(next, null, "onchain is finished");
    } else {
      assert.ok(next && next.action && next.label, `${state} needs a next action`);
    }
  }
});

test("the repository stage tells the user it is not enough", () => {
  const next = lifecycle.nextActionFor(STATES.REPOSITORY_VERIFIED);
  assert.match(next.label, /not enough|prove/i);
});

test("every state has a description", () => {
  for (const state of Object.values(STATES)) {
    assert.ok(lifecycle.DESCRIPTIONS[state], `${state} needs a description`);
  }
});
