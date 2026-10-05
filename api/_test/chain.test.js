/* The registration state machine.

   Every branch of reconciliation, driven by injecting the two chain reads
   rather than by talking to a cluster. The rule these exist to protect is the
   one the product cannot afford to get wrong: a package is marked onchain
   only when the chain says so, and "the chain says so" means three
   independent facts agreeing.

   These do not replace running against a deployed program. They test the
   decision logic, which is the part that can be wrong in a way nobody
   notices. The transaction-building half does not exist yet and is not
   pretended to exist. */

"use strict";

process.env.PACKAGES_DEV_DB = process.env.DATABASE_URL ? "" : "memory";
process.env.PACKAGES_SESSION_SECRET =
  process.env.PACKAGES_SESSION_SECRET || "test-secret-not-for-production";
process.env.PACKAGES_PROGRAM_ID = "PkgAcoAFUaVhzP4Ux5GFeMDGsZFNNRvcRnEFmjbVeEa";

const test = require("node:test");
const assert = require("node:assert/strict");

const chain = require("../_lib/chain");

const OURS = process.env.PACKAGES_PROGRAM_ID;
const ADDRESS = "GkoTSW9X1hTb4QYCDWEYC9n6BpnWwpgL8rfmTQGUFa5A";
const SIGNATURE = "5".repeat(88);

/* reconcileRegistration takes its two reads as dependencies, so every branch
   is reachable without a cluster and no module state is touched. */
const reconcile = ({ account, tx, signature }) =>
  chain.reconcileRegistration({
    signature: signature === undefined ? SIGNATURE : signature,
    identityAddress: ADDRESS,
    readers: {
      accountState: async () => account,
      transactionState: async () => tx,
    },
  });

const ownedAccount = {
  ok: true,
  exists: true,
  owner: OURS,
  ownedByProgram: true,
  lamports: 2000000,
};
const foreignAccount = {
  ok: true,
  exists: true,
  owner: "11111111111111111111111111111111",
  ownedByProgram: false,
};
const noAccount = { ok: true, exists: false };

const confirmedTx = { ok: true, found: true, status: "confirmed", slot: 1234 };

/* ---------------------------------------------------- the happy branch -- */

test("confirmed only when signature, account and owner all agree", async () => {
  const r = await reconcile({ account: ownedAccount, tx: confirmedTx });
  assert.equal(r.status, "confirmed");
  assert.equal(r.slot, 1234);
});

/* --------------------------------------------- everything that is not -- */

test("a confirmed transaction with no account is inconsistent, not success", async () => {
  const r = await reconcile({ account: noAccount, tx: confirmedTx });
  assert.equal(r.status, "inconsistent");
  assert.match(r.reason, /no account exists/i);
});

test("an account owned by another program is never accepted", async () => {
  /* The attack this exists for: anyone can create an account at a derived
     address through a different program. Existence alone must not read as a
     registration. */
  const r = await reconcile({ account: foreignAccount, tx: confirmedTx });
  assert.equal(r.status, "inconsistent");
  assert.match(r.reason, /owned by/i);
});

test("a failed transaction is failed, and carries its error", async () => {
  const r = await reconcile({
    account: noAccount,
    tx: {
      ok: true,
      found: true,
      status: "failed",
      error: '{"InstructionError":[0,{"Custom":1}]}',
    },
  });
  assert.equal(r.status, "failed");
  assert.match(r.reason, /InstructionError/);
});

test("a dropped transaction is not_found, not failed and not confirmed", async () => {
  // Dropped and failed need different advice, so they must not collapse.
  const r = await reconcile({
    account: noAccount,
    tx: { ok: true, found: false, status: "unknown" },
  });
  assert.equal(r.status, "not_found");
  assert.match(r.reason, /dropped/i);
});

test("a transaction still landing is pending, so polling can continue", async () => {
  const r = await reconcile({
    account: noAccount,
    tx: { ok: true, found: true, status: "pending" },
  });
  assert.equal(r.status, "pending");
});

/* ------------------------------------------------------- rpc failures -- */

test("an unreachable RPC is unknown, never a verdict", async () => {
  /* The important half: an RPC failure must not read as "no account", or a
     network blip would look like a dropped registration. */
  const r = await reconcile({
    account: { ok: false, reason: "timed out" },
    tx: confirmedTx,
  });
  assert.equal(r.status, "unknown");
  assert.match(r.reason, /could not read the account/i);
});

test("an RPC that answers for the account but not the transaction is unknown", async () => {
  const r = await reconcile({
    account: ownedAccount,
    tx: { ok: false, reason: "rpc http 503" },
  });
  assert.equal(r.status, "unknown");
  assert.match(r.reason, /could not read the transaction/i);
});

/* ------------------------------------------------- before a signature -- */

test("with no signature, an existing owned account is reported as already there", async () => {
  // The duplicate-submission case: somebody got there first.
  const r = await reconcile({ account: ownedAccount, tx: null, signature: null });
  assert.equal(r.status, "exists");
});

test("with no signature and no account, the address is simply absent", async () => {
  const r = await reconcile({ account: noAccount, tx: null, signature: null });
  assert.equal(r.status, "absent");
});

test("with no signature, a foreign account is not reported as ours", async () => {
  const r = await reconcile({ account: foreignAccount, tx: null, signature: null });
  assert.equal(r.status, "absent", "an account we do not own is not our identity");
});

/* ------------------------------------------------------ repeatability -- */

test("reconciliation is a pure read, so repeating it is safe", async () => {
  /* "Refresh during confirmation" and "server restart during confirmation"
     are the same operation: ask again. The answer must not depend on how many
     times it has been asked. */
  const answers = [];
  for (let i = 0; i < 3; i++) {
    answers.push((await reconcile({ account: ownedAccount, tx: confirmedTx })).status);
  }
  assert.deepEqual(answers, ["confirmed", "confirmed", "confirmed"]);
});

/* ----------------------------------------------------- not configured -- */

test("no program configured blocks reconciliation entirely", async () => {
  const saved = process.env.PACKAGES_PROGRAM_ID;
  delete process.env.PACKAGES_PROGRAM_ID;
  // The config is read at load, so this one case needs a fresh module graph.
  const chainPath = require.resolve("../_lib/chain");
  const envPath = require.resolve("../_lib/env");
  delete require.cache[chainPath];
  delete require.cache[envPath];
  const fresh = require("../_lib/chain");
  try {
    const r = await fresh.reconcileRegistration({
      signature: SIGNATURE,
      identityAddress: ADDRESS,
      readers: {
        accountState: async () => ownedAccount,
        transactionState: async () => confirmedTx,
      },
    });
    assert.equal(r.status, "blocked");
    assert.match(r.reason, /no program id/i);
  } finally {
    process.env.PACKAGES_PROGRAM_ID = saved;
    delete require.cache[chainPath];
    delete require.cache[envPath];
  }
});

/* ------------------------------------------------------- live devnet --- */

test("a blockhash comes back with the height after which it expires", async (t) => {
  // Real devnet. Without the expiry height a client cannot tell a slow
  // transaction from a dropped one.
  const result = await chain.latestBlockhash().catch(() => null);
  if (!result || !result.ok) return t.skip("devnet rpc unreachable");

  assert.match(result.blockhash, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  assert.ok(Number.isInteger(result.lastValidBlockHeight));
  assert.ok(result.lastValidBlockHeight > 0);
});

test("an unknown signature on real devnet is not found, not an error", async (t) => {
  const result = await chain.transactionState("5".repeat(88)).catch(() => null);
  if (!result || !result.ok) return t.skip("devnet rpc unreachable");
  assert.equal(result.found, false);
  assert.equal(result.status, "unknown");
});
