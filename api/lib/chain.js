/* Reading the chain, and reconciling what it says with what the database
   believes.

   The rule this module exists to enforce: **the browser's word is never
   enough.** A client that reports a confirmed transaction may be mistaken,
   may be looking at a different cluster, or may be lying. So a registration
   is only ever marked confirmed after this server has asked an RPC node for
   the transaction, checked that it succeeded, and checked that the account it
   was supposed to create actually exists at the address we derived.

   Nothing here signs or sends anything. Every call is a read. */

"use strict";

const { config } = require("./env");
const { fetchJson } = require("./http");

async function rpc(method, params, timeout) {
  const res = await fetchJson(config.solana.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params || [] }),
    timeout: timeout || 10000,
  });
  if (!res.ok || !res.json) {
    return { ok: false, reason: res.reason || `rpc http ${res.status}` };
  }
  if (res.json.error) {
    return { ok: false, reason: res.json.error.message || "rpc error" };
  }
  return { ok: true, result: res.json.result };
}

/* A blockhash for the client to build a transaction with, plus the height
   after which it can no longer be included. The client needs both to tell a
   dropped transaction from a slow one. */
async function latestBlockhash() {
  const r = await rpc("getLatestBlockhash", [{ commitment: "confirmed" }]);
  if (!r.ok) return { ok: false, reason: r.reason };
  const value = r.result && r.result.value;
  if (!value || !value.blockhash) {
    return { ok: false, reason: "rpc returned no blockhash" };
  }
  return {
    ok: true,
    blockhash: value.blockhash,
    lastValidBlockHeight: value.lastValidBlockHeight,
  };
}

async function blockHeight() {
  const r = await rpc("getBlockHeight", [{ commitment: "confirmed" }]);
  return r.ok ? r.result : null;
}

/* Does an account exist at this address, and is it owned by our program?

   Both halves matter. An account existing is not enough: anyone can create an
   account at a derived address through a different program, and treating that
   as a registration would let a stranger make a package look registered. */
async function accountState(address) {
  const r = await rpc("getAccountInfo", [
    address,
    { encoding: "base64", commitment: "confirmed" },
  ]);
  if (!r.ok) return { ok: false, reason: r.reason };

  const value = r.result && r.result.value;
  if (!value) return { ok: true, exists: false };

  return {
    ok: true,
    exists: true,
    owner: value.owner,
    ownedByProgram: Boolean(
      config.solana.programId && value.owner === config.solana.programId
    ),
    lamports: value.lamports,
    executable: Boolean(value.executable),
    dataLength: Array.isArray(value.data)
      ? Buffer.from(value.data[0], "base64").length
      : 0,
  };
}

/* What the cluster says about one transaction signature. A signature that is
   unknown is not a failure: it may not have landed yet, and the caller needs
   to be able to tell those apart. */
async function transactionState(signature) {
  const statuses = await rpc("getSignatureStatuses", [
    [signature],
    { searchTransactionHistory: true },
  ]);
  if (!statuses.ok) return { ok: false, reason: statuses.reason };

  const entry =
    statuses.result && statuses.result.value && statuses.result.value[0];

  if (!entry) return { ok: true, found: false, status: "unknown" };

  // err is null on success and an object describing the failure otherwise.
  if (entry.err) {
    return {
      ok: true,
      found: true,
      status: "failed",
      slot: entry.slot,
      error: JSON.stringify(entry.err).slice(0, 200),
    };
  }

  return {
    ok: true,
    found: true,
    status:
      entry.confirmationStatus === "finalized" ||
      entry.confirmationStatus === "confirmed"
        ? "confirmed"
        : "pending",
    confirmationStatus: entry.confirmationStatus || null,
    slot: entry.slot,
  };
}

/* The whole reconciliation, in one place.

   Returns the state the database should be moved to, and never a state the
   chain did not justify. "confirmed" requires three things to agree: the
   signature succeeded, an account exists at the derived address, and that
   account is owned by our program. Any one of them missing leaves the
   registration unconfirmed with the reason recorded. */
async function reconcileRegistration({ signature, identityAddress, readers }) {
  if (!config.solana.programId) {
    return { status: "blocked", reason: "no program id is configured" };
  }

  /* The two reads are taken as dependencies so every branch below can be
     driven without a cluster. They default to the real ones, so production
     behaviour is unchanged and nothing is mocked in the running product. */
  const readAccount = (readers && readers.accountState) || accountState;
  const readTransaction = (readers && readers.transactionState) || transactionState;

  const account = await readAccount(identityAddress);
  if (!account.ok) {
    return { status: "unknown", reason: `could not read the account: ${account.reason}` };
  }

  // No signature yet: the only question is whether something is already there.
  if (!signature) {
    if (account.exists && account.ownedByProgram) {
      return {
        status: "exists",
        reason: "an identity account already exists at this address",
        account,
      };
    }
    return { status: "absent", reason: "no account at the derived address", account };
  }

  const tx = await readTransaction(signature);
  if (!tx.ok) {
    return { status: "unknown", reason: `could not read the transaction: ${tx.reason}` };
  }
  if (!tx.found) {
    return {
      status: "not_found",
      reason: "the cluster has no record of that signature; it may have been dropped",
      account,
    };
  }
  if (tx.status === "failed") {
    return { status: "failed", reason: tx.error || "the transaction failed", account, tx };
  }
  if (tx.status === "pending") {
    return { status: "pending", reason: "not yet confirmed", account, tx };
  }

  // Confirmed on chain. Now the account must actually be there, and ours.
  if (!account.exists) {
    return {
      status: "inconsistent",
      reason:
        "the transaction confirmed but no account exists at the derived address",
      tx,
    };
  }
  if (!account.ownedByProgram) {
    return {
      status: "inconsistent",
      reason: `an account exists but is owned by ${account.owner}, not the identity program`,
      account,
      tx,
    };
  }

  return { status: "confirmed", slot: tx.slot, account, tx };
}

module.exports = {
  rpc,
  latestBlockhash,
  blockHeight,
  accountState,
  transactionState,
  reconcileRegistration,
};
