/* Shared render helpers: escaping, formatting and the fragments more than one
   page draws.

   The formatting rules are the product's honesty rules in code form:

     dash(v)    a value the upstream did not report renders as an em dash. It
                is never a zero, and never an estimate.
     count(n)   a real number, grouped. Only called with a number.
     ago(iso)   relative time from a real timestamp.

   Nothing here invents a value. A helper handed null returns the dash. */

(function () {
  "use strict";

  const DASH = "—";

  const esc = (s) =>
    String(s == null ? "" : s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c]
    );

  // An attribute value for a url. Only http(s) survives: a "javascript:" url
  // in a field read from an upstream api must never become a live link.
  const safeUrl = (raw) => {
    const value = String(raw == null ? "" : raw).trim();
    if (!/^https?:\/\//i.test(value)) return "";
    return esc(value);
  };

  const dash = (value) =>
    value === null || value === undefined || value === "" ? DASH : esc(value);

  const count = (n) =>
    typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US") : DASH;

  // Download figures get the compact form, because 4,010,223 beside a label is
  // noise where 4.0M is the fact. The exact number goes in the title.
  const compact = (n) => {
    if (typeof n !== "number" || !Number.isFinite(n)) return DASH;
    if (n < 1000) return String(n);
    if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
    if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;
    return `${(n / 1e9).toFixed(1)}B`;
  };

  const bytes = (n) => {
    if (typeof n !== "number" || !Number.isFinite(n)) return DASH;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  };

  const date = (iso) => {
    if (!iso) return DASH;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return DASH;
    return new Date(t).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  };

  const ago = (iso) => {
    if (!iso) return DASH;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return DASH;
    const seconds = Math.round((Date.now() - t) / 1000);
    if (seconds < 0) return "just now";
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    if (days < 31) return `${days}d ago`;
    const months = Math.round(days / 30.44);
    if (months < 12) return `${months}mo ago`;
    return `${Math.round(days / 365.25)}y ago`;
  };

  /* A hue from a string, so a package without an avatar gets a stable colour
     rather than a random one on every render. */
  const hueFor = (text) => {
    let h = 0;
    const s = String(text || "");
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
  };

  const initial = (text) => {
    const s = String(text || "").replace(/^@/, "");
    return (s[0] || "?").toUpperCase();
  };

  /* --------------------------------------------------------- fragments -- */

  const avatar = (name, imageUrl, extraClass) => {
    const url = safeUrl(imageUrl);
    if (url) {
      return `<img class="avatar-img ${extraClass || ""}" src="${url}" alt="" loading="lazy" width="34" height="34">`;
    }
    return `<span class="repo__avatar" style="--h:${hueFor(name)}">${esc(initial(name))}</span>`;
  };

  /* The verification chip. Three states, worded so none of them can be read
     as a stronger claim than it is. */
  const statusChip = (status) => {
    if (status === "verified") {
      return '<span class="status-chip status-chip--ok">verified</span>';
    }
    if (status === "repo_linked") {
      return '<span class="status-chip status-chip--part">repo linked</span>';
    }
    if (status === "pending") {
      return '<span class="status-chip">claim started</span>';
    }
    return '<span class="status-chip status-chip--off">unclaimed</span>';
  };

  /* The badge set.

     One badge per fact that was actually established, each worded as the
     specific thing it is. There is deliberately no generic "verified" badge:
     collapsing "this GitHub account controls the repository" and "this
     account can publish this package" into one word is the exact
     misrepresentation this product exists to avoid.

     Pass the verification block from the api, plus the package and identity
     so the provenance and onchain facts can be included. */
  const badges = (verification, pkg, identity) => {
    const v = verification || {};
    const evidence = Object.fromEntries(
      (v.evidence || []).map((e) => [e.key, e])
    );
    const out = [];

    const add = (label, tone, title) =>
      out.push(
        `<span class="badge badge--${tone}" title="${esc(title)}">` +
          `<span class="badge__dot"></span>${esc(label)}</span>`
      );

    // The strongest claim first, and only when a proof actually passed.
    if (evidence.publish_proof && evidence.publish_proof.passed) {
      add(
        "npm publisher verified",
        "ok",
        "a one-time string issued by this server appeared in a version published to npm, which only an account with publish rights for this package could do"
      );
    } else if (
      evidence.trusted_publisher &&
      evidence.trusted_publisher.passed &&
      evidence.repo_control &&
      evidence.repo_control.passed
    ) {
      add(
        "npm publisher verified",
        "ok",
        "npm's own build attestation names a repository this account controls as the source of a published release"
      );
    }

    if (evidence.repo_control && evidence.repo_control.passed) {
      add(
        "GitHub repository control verified",
        "ok",
        "GitHub reports this account has push access to the repository the package declares"
      );
    } else if (pkg && pkg.declaredRepo) {
      // Declared is not the same as checked, and the badge says which.
      add(
        "GitHub repository linked",
        "muted",
        "the package declares this repository in its package.json. npm does not check that field, so this is a claim by the publisher rather than something proved"
      );
    }

    if (pkg && pkg.hasProvenance) {
      add(
        "provenance available",
        "info",
        "npm published a signed build attestation for the latest version, naming the repository and workflow that built it"
      );
    }

    if (v.walletVerified) {
      add(
        "wallet verified",
        "ok",
        "the owner signed a one-time message with this wallet's key. A signature, not a transaction"
      );
    }

    if (identity && identity.registeredAddress) {
      add(
        "onchain registered",
        "ok",
        "an identity account for this package exists on Solana devnet"
      );
    }

    if (!out.length) {
      add(
        "unclaimed",
        "off",
        "nobody has proved authority over this package here yet"
      );
    }
    return `<div class="badges">${out.join("")}</div>`;
  };

  const verifiedBadge = (verified) =>
    verified
      ? '<span class="verified" title="publish authority for this package was proved">' +
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="m5 13 4 4L19 7"/></svg>' +
        "verified</span>"
      : "";

  /* The package card, used by the homepage grid, explore and search results.
     Every figure on it is either a real number from npm or a dash. */
  const packageCard = (pkg) => {
    const repo = pkg.repo;
    const href = `/package.html?p=${encodeURIComponent(pkg.name)}`;
    return `<article class="pkg" data-reveal>
      <a class="repo" href="${href}">
        <div class="repo__top">
          ${avatar(pkg.name, null)}
          <div class="repo__id">
            <div class="repo__name"><b>${esc(pkg.name)}</b></div>
            <div class="repo__url">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 8l9-5 9 5v8l-9 5-9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>
              </svg>
              <span>${repo ? esc(`github.com/${repo.owner}/${repo.repo}`) : "no repository declared"}</span>
            </div>
          </div>
          ${pkg.latestVersion ? `<span class="chip-tag">${esc(pkg.latestVersion)}</span>` : ""}
        </div>
        <p class="repo__desc">${pkg.description ? esc(pkg.description) : "no description on npm"}</p>
        <div class="repo__meta">
          <span title="${typeof pkg.downloadsWeekly === "number" ? count(pkg.downloadsWeekly) + " downloads last week" : "npm reports no download figure"}">
            &darr; ${compact(pkg.downloadsWeekly)} / wk
          </span>
          <span>${pkg.versionCount === null || pkg.versionCount === undefined ? DASH : count(pkg.versionCount)} versions</span>
          ${pkg.license ? `<span>${esc(pkg.license)}</span>` : ""}
          ${pkg.publishedAt ? `<span>updated ${esc(ago(pkg.publishedAt))}</span>` : ""}
        </div>
      </a>

      <div class="pkg__head">
        <h3 class="pkg__name">${esc(pkg.name)}</h3>
        ${statusChip(
          pkg.verified ? "verified" : pkg.claimed ? "pending" : "unclaimed"
        )}
      </div>

      <div class="stats">
        <div>
          <div class="stat__label">downloads / week</div>
          <div class="stat__value">${compact(pkg.downloadsWeekly)}</div>
        </div>
        <div>
          <div class="stat__label">dependents</div>
          <div class="stat__value">${compact(pkg.dependents)}</div>
        </div>
        <div class="stat--right">
          <div class="stat__label">identity</div>
          <div class="stat__value stat__value--sm">${
            pkg.verified ? "verified" : "open"
          }</div>
        </div>
      </div>

      <div class="pkg__foot">
        <a class="btn btn--sm btn--ink" href="${href}">open package
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M7 17 17 7M9 7h8v8"/></svg>
        </a>
        <span class="pkg__ago">${
          pkg.owner
            ? `claimed by ${esc(pkg.owner.login)}`
            : "not claimed here"
        }</span>
      </div>
    </article>`;
  };

  /* One of the four proofs. The flag beside the label is the important part:
     it says whether passing this alone would be enough. */
  const evidenceRow = (item) => {
    const mark = item.passed
      ? '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2"><path d="m5 13 4 4L19 7"/></svg>'
      : '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    let flag = "";
    if (item.sufficientAlone) {
      flag = '<span class="ev__flag ev__flag--enough">proof on its own</span>';
    } else if (item.signalOnly) {
      flag = '<span class="ev__flag ev__flag--signal">signal only</span>';
    } else {
      flag = '<span class="ev__flag">not sufficient alone</span>';
    }
    return `<div class="ev ${item.passed ? "ev--pass" : ""}">
      <span class="ev__mark">${mark}</span>
      <div>
        <div class="ev__label">${esc(item.label)}${flag}</div>
        <p class="ev__detail">${esc(item.detail)}</p>
      </div>
    </div>`;
  };

  /* A sparkline from real daily counts. Returns an empty string when there is
     no series, so the caller renders nothing rather than a flat line. */
  const sparkline = (series) => {
    if (!Array.isArray(series) || series.length < 3) return "";
    const values = series.map((p) => p.downloads);
    const max = Math.max(...values);
    const min = Math.min(...values);
    const span = max - min || 1;
    const w = 300;
    const h = 58;
    const step = w / (values.length - 1);
    const points = values.map((v, i) => [
      (i * step).toFixed(2),
      (h - 4 - ((v - min) / span) * (h - 10)).toFixed(2),
    ]);
    const line = points.map((p, i) => `${i ? "L" : "M"}${p[0]} ${p[1]}`).join(" ");
    const area = `${line} L${w} ${h} L0 ${h} Z`;
    const first = series[0].day;
    const last = series[series.length - 1].day;
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img"
      aria-label="daily downloads from ${esc(first)} to ${esc(last)}, between ${count(min)} and ${count(max)}">
      <path class="spark__area" d="${area}"/>
      <path class="spark__line" d="${line}"/>
    </svg>`;
  };

  const empty = (title, copy, action) =>
    `<div class="empty" data-reveal>
      <h2 class="empty__title">${esc(title)}</h2>
      <p class="empty__copy">${esc(copy)}</p>
      ${action || ""}
    </div>`;

  /* The message shown when a request failed. An unreachable API and a server
     that answered with an error are different problems, and saying which one
     it was is the difference between a user who can act and one who cannot. */
  const errorBox = (err, what) => {
    /* Unreachable covers both shapes: the fetch never completed (status 0),
       and the dev proxy answering 502 because nothing is listening behind it.
       They are the same situation to a reader. */
    const offline =
      err && (err.offline || err.code === "api_unreachable" || err.status === 502);
    const title = offline ? "the API is not running" : `could not load ${what}`;
    const copy = offline
      ? (err && err.message) ||
        "this page reads live data from the Packages API, and nothing is answering. Start it with npm run api."
      : (err && err.message) || "something went wrong";
    return `<div class="empty" data-reveal>
      <h2 class="empty__title">${esc(title)}</h2>
      <p class="empty__copy">${esc(copy)}</p>
    </div>`;
  };

  const skeletonCards = (n) =>
    Array.from({ length: n || 2 }, () => '<div class="skeleton skeleton--card"></div>').join("");

  /* ------------------------------------------------------------ toast --- */

  let toastEl = null;
  let toastTimer = null;

  function toast(message, kind) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "toast";
      toastEl.setAttribute("role", "status");
      toastEl.setAttribute("aria-live", "polite");
      document.body.appendChild(toastEl);
    }
    toastEl.className = `toast${kind === "bad" ? " toast--bad" : ""}`;
    toastEl.innerHTML = `<span class="toast__dot"></span><span>${esc(message)}</span>`;
    // The class has to land on a later frame than the content, or the
    // transition has nothing to animate from.
    requestAnimationFrame(() => toastEl.classList.add("is-in"));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("is-in"), 4200);
  }

  /* ----------------------------------------------------------- copying -- */

  /* Wires every copy button inside a scope. Falls back to selecting the text
     when the clipboard is blocked, so the string is still obtainable. */
  function wireCopy(scope) {
    (scope || document).querySelectorAll("[data-copy-target]").forEach((btn) => {
      if (btn.dataset.copyWired) return;
      btn.dataset.copyWired = "1";
      btn.addEventListener("click", async () => {
        const target = document.getElementById(btn.dataset.copyTarget);
        if (!target) return;
        const text = target.textContent.trim();
        try {
          await navigator.clipboard.writeText(text);
          btn.classList.add("is-done");
          setTimeout(() => btn.classList.remove("is-done"), 1500);
          toast("copied");
        } catch (e) {
          const range = document.createRange();
          range.selectNodeContents(target);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          toast("clipboard blocked, text selected instead", "bad");
        }
      });
    });
  }

  const codeblock = (id, text) =>
    `<div class="codeblock">
      <code class="codeblock__code" id="${esc(id)}">${esc(text)}</code>
      <button class="codeblock__copy" type="button" data-copy-target="${esc(id)}" aria-label="copy">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>
        </svg>
      </button>
    </div>`;

  const param = (key) => new URLSearchParams(window.location.search).get(key);

  window.UI = {
    DASH,
    esc,
    safeUrl,
    dash,
    count,
    compact,
    bytes,
    date,
    ago,
    hueFor,
    initial,
    avatar,
    statusChip,
    badges,
    verifiedBadge,
    packageCard,
    evidenceRow,
    sparkline,
    empty,
    errorBox,
    skeletonCards,
    toast,
    wireCopy,
    codeblock,
    param,
  };
})();
