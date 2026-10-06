/* Signing and sending the Pump create transaction.

   The server builds it and the publisher's wallet signs it, because the
   publisher is the coin's creator. This file does the one thing the browser
   has to do: hand the bytes to the wallet and send what comes back.

   It never chooses the wallet. The server built the transaction with the
   proven wallet as fee payer and creator, so a different wallet simply
   cannot produce a valid signature for it. */

import { Connection, Transaction } from "@solana/web3.js";

async function launchCoin({ transaction, rpcUrl }) {
  const provider = window.PackagesPrivy && window.PackagesPrivy.injectedSolanaWallet();
  if (!provider) throw new Error("no Solana wallet is available in this browser");

  const tx = Transaction.from(Uint8Array.from(atob(transaction), (c) => c.charCodeAt(0)));

  let signed;
  if (typeof provider.signTransaction === "function") {
    signed = await provider.signTransaction(tx);
  } else {
    throw new Error("that wallet cannot sign transactions");
  }

  const conn = new Connection(rpcUrl, "confirmed");
  const signature = await conn.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await conn.confirmTransaction(signature, "confirmed");
  return signature;
}

window.PackagesPump = { launchCoin };
export default { launchCoin };
