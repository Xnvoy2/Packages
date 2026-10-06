/* Signing in.

   Privy owns authentication; this is the small amount of page that drives
   it. Two ways in, matching what the application has enabled: an email code,
   or a Solana wallet the visitor already holds. The token Privy issues is
   verified by our server, which then establishes the session the rest of the
   api already uses.

   What signing in does and does not do is worth being plain about in the
   interface as well as in the code. It establishes who is sitting there. It
   proves nothing about any npm package. Connecting GitHub and proving
   publish authority are separate steps, reached from inside the account.

   The dialog is built from the existing classes and tokens, so it inherits
   the theme rather than introducing styling of its own. */

(function () {
  "use strict";

  const Privy = window.PackagesPrivy;
  const esc = (s) => window.UI.esc(s);

  /* The stage trace is developer instrumentation, not product. Off unless
     asked for, by ?debug=1 on the url or a flag kept in this browser, so a
     visitor never sees it. */
  const DEBUG = (() => {
    try {
      if (new URLSearchParams(window.location.search).get("debug") === "1") return true;
      return window.localStorage.getItem("packages:debug") === "1";
    } catch (e) {
      return false;
    }
  })();

  let open = false;
  let busy = false;

  const stage = (name, note) => {
    const safe = String(note === undefined ? "" : note)
      .replace(/[^A-Za-z0-9 ._:+-]/g, "")
      .slice(0, 90);
    try { console.log("[signin]", name, safe); } catch (e) {}
    try {
      window.dispatchEvent(new CustomEvent("packages:stage", { detail: { name, note: safe } }));
    } catch (e) {}
  };

  /* ------------------------------------------------------------ shell --- */

  function shell() {
    const host = document.createElement("div");
    host.className = "signin";
    host.setAttribute("role", "dialog");
    host.setAttribute("aria-modal", "true");
    host.setAttribute("aria-labelledby", "signin-title");
    host.innerHTML = `
      <div class="signin__scrim" data-close></div>
      <div class="signin__panel">
        <button class="signin__close" type="button" data-close aria-label="close sign in">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18"/>
          </svg>
        </button>
        <div class="signin__head">
          <div class="signin__eyebrow">sign in</div>
          <h2 class="signin__title" id="signin-title">continue to Packages</h2>
          <p class="signin__copy">
            Signing in identifies your account. It does not claim any package:
            proving you publish one is a separate step.
          </p>
        </div>
        <div class="signin__body" data-step></div>
        ${DEBUG ? '<div class="signin__trace" data-trace hidden></div>' : ""}
      </div>`;
    return host;
  }

  function traceInto(host) {
    if (!DEBUG) return;
    const box = host.querySelector("[data-trace]");
    window.addEventListener("packages:stage", (e) => {
      const d = (e && e.detail) || {};
      box.hidden = false;
      const line = document.createElement("div");
      line.className = "signin__trace-line";
      line.textContent = d.name + (d.note && d.note !== "-" ? "  " + d.note : "");
      box.appendChild(line);
      box.scrollTop = box.scrollHeight;
    });
  }

  const render = (host, html) => { host.querySelector("[data-step]").innerHTML = html; };

  function close(host) {
    open = false;
    busy = false;
    host.remove();
    document.documentElement.classList.remove("signin-open");
  }

  /* The head carries the explanation while there is still something to
     decide. Once the wallet has been approved there is nothing to decide, so
     it goes and the panel becomes one clear statement of what is happening. */
  function setHead(host, show) {
    const head = host.querySelector(".signin__head");
    if (head) head.hidden = !show;
  }

  /* ----------------------------------------------------------- states --- */

  function loadingState(host, title, detail) {
    setHead(host, false);
    busy = true;
    render(
      host,
      `<div class="signin__state" role="status" aria-live="polite">
         <div class="signin__loader" aria-hidden="true"><span></span><span></span><span></span></div>
         <div class="signin__state-title">${esc(title)}</div>
         <p class="signin__state-copy">${esc(detail)}</p>
       </div>`
    );
  }

  function successState(host, title, detail) {
    busy = false;
    render(
      host,
      `<div class="signin__state" role="status" aria-live="polite">
         <div class="signin__tick" aria-hidden="true">
           <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
             <path d="M4 12.5l5.2 5.2L20 7"/>
           </svg>
         </div>
         <div class="signin__state-title">${esc(title)}</div>
         <p class="signin__state-copy">${esc(detail)}</p>
       </div>`
    );
  }

  /* A real error, in words, with a way out. Never an endless loader. */
  function errorState(host, message, retry) {
    busy = false;
    setHead(host, false);
    render(
      host,
      `<div class="signin__state signin__state--bad" role="alert">
         <div class="signin__state-title">that did not work</div>
         <p class="signin__state-copy signin__state-copy--error">${esc(message)}</p>
         <div class="signin__actions">
           <button class="btn btn--sm btn--ink" type="button" data-retry>try again</button>
           <button class="btn btn--sm btn--glass" type="button" data-close>close</button>
         </div>
       </div>`
    );
    const again = host.querySelector("[data-retry]");
    if (again) again.addEventListener("click", () => { setHead(host, true); retry(host); });
  }

  const readable = (err) => {
    const m = (err && err.message) || "";
    if (/reject|denied|cancel/i.test(m)) return "the request was declined in your wallet, so nothing was sent";
    return m || "something went wrong, and the reason was not reported";
  };

  /* ----------------------------------------------------------- finish --- */

  /* Everything after the signature: exchange the token for the session, then
     confirm the server really considers us signed in before saying so. */
  async function finish(host) {
    loadingState(host, "signing you in", "connecting your wallet to Packages.");

    const token = await Privy.identityToken();
    stage("token", token ? "present len " + String(token).length : "NULL");
    if (!token) throw new Error("Privy did not return a token for this session");

    await window.PackagesAPI.signInWithPrivy(token);
    stage("packages-session", "exchange ok");

    /* The claim is the server's, not ours: ask it, rather than assuming the
       exchange worked because it did not throw. */
    const me = await (await fetch("/api/me", { cache: "no-store" })).json();
    stage("me", "signedIn=" + String(me && me.signedIn));
    if (!me || !me.signedIn) {
      throw new Error("the session was not established, so you are not signed in yet");
    }

    successState(host, "you're in", "wallet connected to Packages.");
    setTimeout(() => {
      close(host);
      window.location.reload();
    }, 900);
  }

  /* ------------------------------------------------------------ steps --- */

  function emailStep(host) {
    setHead(host, true);
    render(
      host,
      `<form class="signin__form" data-email-form novalidate>
         <label class="signin__label" for="signin-email">email</label>
         <input class="field" id="signin-email" name="email" type="email" required
                autocomplete="email" placeholder="you@example.com">
         <button class="btn btn--lg btn--ink signin__submit" type="submit">send a code</button>
         <p class="signin__status" data-status></p>
       </form>
       <button class="btn btn--sm btn--glass signin__alt" type="button" data-wallet>
         use a Solana wallet instead
       </button>`
    );

    host.querySelector("[data-email-form]").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (busy) return;
      const email = host.querySelector("#signin-email").value.trim();
      const status = host.querySelector("[data-status]");
      const button = host.querySelector(".signin__submit");
      if (!email) { status.textContent = "enter an email address"; return; }
      busy = true;
      button.disabled = true;
      status.innerHTML = '<span class="spinner"></span> sending';
      try {
        await Privy.sendEmailCode(email);
        busy = false;
        codeStep(host, email);
      } catch (err) {
        busy = false;
        button.disabled = false;
        status.textContent = readable(err);
      }
    });

    host.querySelector("[data-wallet]").addEventListener("click", () => walletStep(host));
  }

  function codeStep(host, email) {
    setHead(host, true);
    render(
      host,
      `<form class="signin__form" data-code-form novalidate>
         <label class="signin__label" for="signin-code">the code sent to ${esc(email)}</label>
         <input class="field" id="signin-code" name="code" inputmode="numeric"
                autocomplete="one-time-code" required placeholder="123456">
         <button class="btn btn--lg btn--ink signin__submit" type="submit">sign in</button>
         <p class="signin__status" data-status></p>
       </form>
       <button class="btn btn--sm btn--glass signin__alt" type="button" data-back>use a different email</button>`
    );

    host.querySelector("[data-code-form]").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (busy) return;
      const code = host.querySelector("#signin-code").value.trim();
      const status = host.querySelector("[data-status]");
      const button = host.querySelector(".signin__submit");
      busy = true;
      button.disabled = true;
      status.innerHTML = '<span class="spinner"></span> checking';
      try {
        await Privy.loginWithEmailCode(email, code);
        await finish(host);
      } catch (err) {
        errorState(host, readable(err), (h) => codeStep(h, email));
      }
    });

    host.querySelector("[data-back]").addEventListener("click", () => emailStep(host));
  }

  function walletStep(host) {
    setHead(host, true);
    const injected = Privy.injectedSolanaWallet();
    render(
      host,
      injected
        ? `<p class="signin__copy signin__copy--tight">Your wallet will ask you to sign a short
             message. It is not a transaction, and nothing moves.</p>
           <button class="btn btn--lg btn--ink signin__submit" type="button" data-connect>connect wallet</button>
           <p class="signin__status" data-status></p>
           <button class="btn btn--sm btn--glass signin__alt" type="button" data-back>use email instead</button>`
        : `<p class="signin__copy signin__copy--tight">No Solana wallet was found in this browser.
             Install one, or sign in with an email code.</p>
           <button class="btn btn--sm btn--glass signin__alt" type="button" data-back>use email instead</button>`
    );

    const back = host.querySelector("[data-back]");
    if (back) back.addEventListener("click", () => emailStep(host));

    const connect = host.querySelector("[data-connect]");
    if (!connect) return;
    connect.addEventListener("click", async () => {
      if (busy) return;
      const status = host.querySelector("[data-status]");
      busy = true;
      connect.disabled = true;
      status.innerHTML = '<span class="spinner"></span> waiting for your wallet';
      try {
        await Privy.loginWithSolanaWallet(injected);
        await finish(host);
      } catch (err) {
        stage("wallet-ui-error", (err && err.message) || "unknown");
        errorState(host, readable(err), walletStep);
      }
    });
  }

  /* ------------------------------------------------------------ start --- */

  function start() {
    if (open) return;
    if (!Privy || !Privy.configured()) {
      window.UI.toast("sign-in is not configured on this server", "bad");
      return;
    }
    open = true;
    const host = shell();
    document.body.appendChild(host);
    document.documentElement.classList.add("signin-open");

    host.addEventListener("click", (e) => {
      // A click on the scrim or a close control dismisses, unless a sign-in
      // is in flight, where dismissing would strand it half done.
      if (e.target.closest("[data-close]") && !busy) close(host);
    });
    document.addEventListener("keydown", function onKey(e) {
      if (e.key === "Escape" && open && !busy) { close(host); document.removeEventListener("keydown", onKey); }
    });

    traceInto(host);
    emailStep(host);
    const field = host.querySelector("#signin-email");
    if (field) field.focus();
  }

  document.addEventListener("click", (e) => {
    const trigger = e.target && e.target.closest && e.target.closest("[data-signin]");
    if (!trigger) return;
    e.preventDefault();
    start();
  });

  window.PackagesSignIn = { start };
})();
