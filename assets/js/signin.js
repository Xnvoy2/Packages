/* Signing in.

   Privy owns authentication; this is the small amount of page that drives
   it. Two ways in, matching what the application has enabled: an email code,
   or a Solana wallet the visitor already holds.

   What signing in does and does not do is worth being plain about in the
   interface as well as in the code. It establishes who is sitting there. It
   proves nothing about any npm package. Connecting GitHub and proving
   publish authority are separate steps, reached from inside the account,
   and neither is weakened by anything here.

   The dialog is built from the existing classes and tokens, so it inherits
   the theme rather than introducing styling of its own. */

(function () {
  "use strict";

  const Privy = window.PackagesPrivy;
  const esc = (s) => window.UI.esc(s);
  let open = false;

  function shell() {
    const host = document.createElement("div");
    host.className = "signin";
    host.setAttribute("role", "dialog");
    host.setAttribute("aria-modal", "true");
    host.setAttribute("aria-label", "sign in");
    host.innerHTML = `
      <div class="signin__scrim" data-close></div>
      <div class="signin__panel panel">
        <button class="signin__close btn btn--sm btn--glass" type="button" data-close
                aria-label="close">close</button>
        <div class="panel__eyebrow">sign in</div>
        <h2 class="signin__title">continue to Packages</h2>
        <p class="signin__copy">
          Signing in identifies your account. It does not claim any package:
          proving you publish one is a separate step.
        </p>
        <div data-step></div>
      </div>`;
    return host;
  }

  function render(host, html) {
    host.querySelector("[data-step]").innerHTML = html;
  }

  function close(host) {
    open = false;
    host.remove();
    document.documentElement.classList.remove("signin-open");
  }

  async function finish(host, label) {
    const step = host.querySelector("[data-step]");
    step.innerHTML = `<p class="signin__copy"><span class="spinner"></span> ${esc(label)}</p>`;
    const token = await Privy.identityToken();
    if (!token) throw new Error("Privy returned no token for this session");
    await window.API.signInWithPrivy(token);
    close(host);
    window.UI.toast("signed in");
    // The page decides what to show; re-running its own loader keeps every
    // state in one place rather than duplicating it here.
    window.location.reload();
  }

  function emailStep(host) {
    render(
      host,
      `<form class="signin__form" data-email-form>
         <label class="signin__label" for="signin-email">email</label>
         <input class="field" id="signin-email" name="email" type="email" required
                autocomplete="email" placeholder="you@example.com">
         <button class="btn btn--lg btn--ink" type="submit">send a code</button>
         <p class="signin__hint" data-hint></p>
       </form>
       <button class="btn btn--sm btn--glass signin__alt" type="button" data-wallet>
         use a Solana wallet instead
       </button>`
    );

    host.querySelector("[data-email-form]").addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = host.querySelector("#signin-email").value.trim();
      const hint = host.querySelector("[data-hint]");
      const button = host.querySelector("[data-email-form] button");
      if (!email) return;
      button.disabled = true;
      hint.textContent = "sending";
      try {
        await Privy.sendEmailCode(email);
        codeStep(host, email);
      } catch (err) {
        button.disabled = false;
        hint.textContent = (err && err.message) || "that code could not be sent";
      }
    });

    host.querySelector("[data-wallet]").addEventListener("click", () => walletStep(host));
  }

  function codeStep(host, email) {
    render(
      host,
      `<form class="signin__form" data-code-form>
         <label class="signin__label" for="signin-code">the code sent to ${esc(email)}</label>
         <input class="field" id="signin-code" name="code" inputmode="numeric"
                autocomplete="one-time-code" required placeholder="123456">
         <button class="btn btn--lg btn--ink" type="submit">sign in</button>
         <p class="signin__hint" data-hint></p>
       </form>
       <button class="btn btn--sm btn--glass signin__alt" type="button" data-back>use a different email</button>`
    );

    host.querySelector("[data-code-form]").addEventListener("submit", async (e) => {
      e.preventDefault();
      const code = host.querySelector("#signin-code").value.trim();
      const hint = host.querySelector("[data-hint]");
      const button = host.querySelector("[data-code-form] button");
      button.disabled = true;
      hint.textContent = "checking";
      try {
        await Privy.loginWithEmailCode(email, code);
        await finish(host, "signing you in");
      } catch (err) {
        button.disabled = false;
        hint.textContent = (err && err.message) || "that code was not accepted";
      }
    });

    host.querySelector("[data-back]").addEventListener("click", () => emailStep(host));
  }

  function walletStep(host) {
    const injected = Privy.injectedSolanaWallet();
    render(
      host,
      injected
        ? `<p class="signin__copy">Your wallet will ask you to sign a short message. It is not a
             transaction, and nothing moves.</p>
           <button class="btn btn--lg btn--ink" type="button" data-connect>connect wallet</button>
           <p class="signin__hint" data-hint></p>
           <button class="btn btn--sm btn--glass signin__alt" type="button" data-back>use email instead</button>`
        : `<p class="signin__copy">No Solana wallet was found in this browser. Install one, or sign
             in with an email code.</p>
           <button class="btn btn--sm btn--glass signin__alt" type="button" data-back>use email instead</button>`
    );

    const back = host.querySelector("[data-back]");
    if (back) back.addEventListener("click", () => emailStep(host));

    const connect = host.querySelector("[data-connect]");
    if (!connect) return;
    connect.addEventListener("click", async () => {
      const hint = host.querySelector("[data-hint]");
      connect.disabled = true;
      hint.textContent = "waiting for your wallet";
      try {
        await Privy.loginWithSolanaWallet(injected);
        await finish(host, "signing you in");
      } catch (err) {
        connect.disabled = false;
        hint.textContent = /reject|denied|cancel/i.test((err && err.message) || "")
          ? "request declined, nothing was sent"
          : (err && err.message) || "that wallet could not be used";
      }
    });
  }

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
      if (e.target.closest("[data-close]")) close(host);
    });
    document.addEventListener("keydown", function onKey(e) {
      if (e.key === "Escape" && open) { close(host); document.removeEventListener("keydown", onKey); }
    });

    emailStep(host);
    const field = host.querySelector("#signin-email");
    if (field) field.focus();
  }

  // Delegated, so it covers the buttons app.js renders after load.
  document.addEventListener("click", (e) => {
    const trigger = e.target && e.target.closest && e.target.closest("[data-signin]");
    if (!trigger) return;
    e.preventDefault();
    start();
  });

  window.PackagesSignIn = { start };
})();
