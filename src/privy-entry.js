/* The Privy client, reduced to what Packages actually needs.

   Bundled into assets/vendor/privy.min.js rather than loaded from Privy's
   CDN, so script-src stays 'self'. The bundle exposes one small object on
   window; the rest of the SDK's surface is deliberately not re-exported,
   because anything reachable from app.js is something a later change can
   come to depend on.

   Three things are worth knowing about this file.

   The embedded wallet runs inside an iframe Privy hosts, and the core SDK
   does not create it. It hands out a URL and expects the page to mount the
   iframe and relay messages both ways. Without that relay every embedded
   wallet call posts into nothing: no prompt appears, no error is thrown, and
   the promise never settles. mountEmbeddedWallet() below is that relay, and
   signMessage() refuses rather than hangs when it is not ready.

   Nothing here decides who owns a package. It signs the bytes the server
   issued and hands the signature back; the server verifies it. */

import Privy, {
  LocalStorage,
  createSiwsMessage,
  getUserEmbeddedSolanaWallet,
  getEntropyDetailsFromUser,
} from "@privy-io/js-sdk-core";

const IFRAME_ID = "privy-embedded-wallet";
const SIGN_TIMEOUT_MS = 60000;

let client = null;
let iframe = null;
let iframeReady = false;

function appId() {
  const cfg = window.PACKAGES_CONFIG || {};
  return cfg.privyAppId || "";
}

/* One client, created on first use. initialize() restores an existing
   session, so a signed-in visitor stays signed in across a reload. */
async function ready() {
  if (client) return client;
  const id = appId();
  if (!id) throw new Error("sign-in is not configured");
  client = new Privy({ appId: id, storage: new LocalStorage() });
  await client.initialize();
  return client;
}

/* Mount Privy's wallet iframe and relay messages in both directions.

   The SDK posts into the iframe through the poster, and the iframe posts
   back to the page; handleMessage feeds those replies to the SDK. Messages
   are accepted only from the iframe's own window, so another frame cannot
   answer on its behalf. */
async function mountEmbeddedWallet() {
  const p = await ready();
  if (iframe && iframeReady) return true;

  const url = p.embeddedWallet.getURL();
  const origin = new URL(url).origin;

  if (!iframe) {
    iframe = document.createElement("iframe");
    iframe.id = IFRAME_ID;
    iframe.src = url;
    iframe.setAttribute("title", "Privy wallet");
    iframe.setAttribute("aria-hidden", "true");
    iframe.tabIndex = -1;
    // Present but never seen. display:none would stop it loading in some
    // browsers, so it is sized away instead.
    iframe.style.cssText =
      "position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none;left:-9999px;top:-9999px";
    document.body.appendChild(iframe);

    window.addEventListener("message", (event) => {
      if (!iframe || event.source !== iframe.contentWindow) return;
      if (event.origin !== origin) return;
      try {
        p.embeddedWallet.onMessage(event.data);
      } catch (e) {
        /* A message the SDK does not recognise is not fatal. */
      }
      if (event.data && event.data.event === "privy:iframe:ready") iframeReady = true;
    });

    p.setMessagePoster({
      postMessage: (message, targetOrigin, transfer) => {
        if (!iframe || !iframe.contentWindow) return;
        iframe.contentWindow.postMessage(message, targetOrigin || origin, transfer);
      },
      reload: () => {
        iframeReady = false;
        if (iframe) iframe.src = url;
      },
    });
  }

  // Bounded: if the frame never reports ready, say so rather than wait.
  const deadline = Date.now() + 15000;
  while (!iframeReady && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
  }
  return iframeReady;
}

const api = {
  available: true,

  configured() {
    return Boolean(appId());
  },

  async user() {
    const p = await ready();
    try {
      // user.get() answers { user }, not the user itself.
      const res = await p.user.get();
      return (res && res.user) || null;
    } catch (e) {
      return null;
    }
  },

  async identityToken() {
    const p = await ready();
    // The identity token carries the linked accounts; the access token does
    // not. The server accepts either, and prefers the richer one.
    return (await p.getIdentityToken()) || (await p.getAccessToken());
  },

  async sendEmailCode(email) {
    const p = await ready();
    return p.auth.email.sendCode(String(email).trim());
  },

  async loginWithEmailCode(email, code) {
    const p = await ready();
    return p.auth.email.loginWithCode(String(email).trim(), String(code).trim());
  },

  async logout() {
    const p = await ready();
    try { await p.auth.logout(); } catch (e) { /* already signed out */ }
    iframeReady = false;
    if (iframe && iframe.parentNode) iframe.parentNode.removeChild(iframe);
    iframe = null;
  },

  /* ----------------------------------------------------------- wallets -- */

  /* External Solana wallets, which sign in their own extension and need no
     iframe. This is the path ownership proof uses when an embedded wallet
     cannot sign. */
  injectedSolanaWallet() {
    const w =
      (window.phantom && window.phantom.solana) ||
      (window.solana && window.solana.isPhantom && window.solana) ||
      window.solflare ||
      window.solana ||
      null;
    return w && typeof w.signMessage === "function" ? w : null;
  },

  /* Sign in with a wallet the visitor already holds.

     Privy issues the nonce, the SIWS message is built from it, the wallet
     signs that exact message, and Privy verifies it. The page never invents
     the message and never sees a key. */
  async loginWithSolanaWallet(provider) {
    const p = await ready();
    const connected = await provider.connect();
    const address = String(
      (connected && connected.publicKey && connected.publicKey.toString()) ||
        (provider.publicKey && provider.publicKey.toString()) ||
        ""
    );
    if (!address) throw new Error("that wallet did not report an address");

    const { nonce } = await p.auth.siws.fetchNonce({ address });
    const message = createSiwsMessage({
      address,
      nonce,
      domain: window.location.host,
      uri: window.location.origin,
    });
    const signed = await provider.signMessage(new TextEncoder().encode(message), "utf8");
    const raw = (signed && (signed.signature || signed)) || null;
    if (!raw) throw new Error("that wallet returned no signature");

    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);

    return p.auth.siws.login({
      message,
      signature: btoa(binary),
      walletClientType: "phantom",
      connectorType: "injected",
    });
  },

  async embeddedSolanaWallet() {
    const p = await ready();
    const u = await api.user();
    if (!u) return null;
    try {
      return getUserEmbeddedSolanaWallet(u) || null;
    } catch (e) {
      return null;
    }
  },

  async createEmbeddedSolanaWallet() {
    const mounted = await mountEmbeddedWallet();
    if (!mounted) {
      throw new Error("the wallet frame did not load, so no wallet was created");
    }
    const p = await ready();
    // solanaAccount, not a chainType: this SDK names the account it is
    // creating rather than the chain it is on.
    return p.embeddedWallet.create({ solanaAccount: true });
  },

  /* Sign the exact bytes the server issued.

     Refuses rather than hangs when the frame is not ready, and gives up after
     a bounded wait if the frame accepts the request and never answers, which
     is the failure this whole file is shaped around. */
  async signMessageEmbedded(message) {
    const mounted = await mountEmbeddedWallet();
    if (!mounted) {
      throw new Error("the wallet frame never became ready, so nothing was signed");
    }
    const p = await ready();
    const wallet = await api.embeddedSolanaWallet();
    if (!wallet) throw new Error("this account has no embedded Solana wallet");

    /* getSolanaProvider needs the entropy details as well as the account.
       They identify which key the signer should use and how to verify it,
       and the call cannot be made without them. */
    const u = await api.user();
    const entropy = getEntropyDetailsFromUser(u, wallet);
    if (!entropy) throw new Error("this account has no signer for that wallet");
    const provider = await p.embeddedWallet.getSolanaProvider(
      wallet,
      entropy.entropyId,
      entropy.entropyIdVerifier
    );
    const bytes = new TextEncoder().encode(message);

    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("the wallet did not answer the signing request")),
        SIGN_TIMEOUT_MS
      );
    });
    try {
      const result = await Promise.race([
        provider.request({ method: "signMessage", params: { message: bytes } }),
        timeout,
      ]);
      const sig = (result && (result.signature || result)) || null;
      if (!sig) throw new Error("the wallet returned no signature");
      return sig;
    } finally {
      if (timer) clearTimeout(timer);
    }
  },
};

window.PackagesPrivy = api;
export default api;
