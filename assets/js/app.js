/* Behaviour for Packages.

   Two halves. The first is the motion system, unchanged from the original
   build: nav state, the ticker marquee, scroll reveals, the bars that fill
   once seen and the scroll-driven lifecycle strip. The second is one
   controller per page, each of which asks the API for real data and renders
   what came back, or says plainly why it could not.

   No page invents a figure. Where npm or GitHub reports nothing, the dash
   from ui.js is what appears. */

(function () {
  "use strict";

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const API = window.PackagesAPI;
  const CONFIG = window.PACKAGES_CONFIG || {};

  // Declared before the controllers run, because a controller that renders
  // cards calls observeReveals() on them straight away.
  let revealObserver = null;

  /* ====================================================== motion system == */

  /* The hero entrance, the headline split and the panel assembly all live in
     motion.js, which owns everything that moves. */

  /* -------------------------------------------------------- nav state -- */

  const nav = $("#nav");
  if (nav) {
    const onScroll = () => nav.classList.toggle("is-stuck", window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  /* ----------------------------------------------------- scroll reveal -- */

  // How many revealable siblings precede this one, so the cascade follows
  // document order rather than however the observer batched the entries.
  function revealIndex(el) {
    let i = 0;
    let prev = el.previousElementSibling;
    while (prev) {
      if (prev.hasAttribute("data-reveal")) i++;
      prev = prev.previousElementSibling;
    }
    return i;
  }

  /* Content rendered after load is handed to the motion system, which owns
     every reveal on the page. The IntersectionObserver below is the fallback
     for when that file did not load. */
  function observeReveals(scope) {
    if (window.Motion) {
      window.Motion.register(scope || document);
      return;
    }
    if (!("IntersectionObserver" in window)) {
      $("[data-reveal]", scope).forEach((e) => e.classList.add("is-in"));
      return;
    }
    if (!revealObserver) {
      revealObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            const el = entry.target;
            const delay =
              Number(el.dataset.revealDelay || 0) + revealIndex(el) * 60;
            setTimeout(() => el.classList.add("is-in"), delay);
            revealObserver.unobserve(el);
          });
        },
        { rootMargin: "0px 0px -12% 0px", threshold: 0.12 }
      );
    }
    $("[data-reveal]", scope).forEach((el) => revealObserver.observe(el));
  }

  observeReveals(document);

  /* --------------------------------------- bars that fill once in view -- */

  const barObserver =
    "IntersectionObserver" in window
      ? new IntersectionObserver(
          (entries) => {
            entries.forEach((e) => {
              if (!e.isIntersecting) return;
              e.target.style.width = e.target.dataset.fill;
              barObserver.unobserve(e.target);
            });
          },
          { threshold: 0.4 }
        )
      : null;

  function observeBars(scope) {
    $$("[data-fill]", scope).forEach((el) => {
      if (barObserver) barObserver.observe(el);
      else el.style.width = el.dataset.fill;
    });
  }

  observeBars(document);

  /* -------------------------------------------- scroll lifecycle strip -- */

  /* The pinned, scroll-scrubbed version of this strip lives in motion.js.
     This bespoke handler is the fallback for when that file did not load, or
     when reduced motion is on, and the selector below is what switches
     between them. */
  const lifecycleSelector =
    window.Motion && window.Motion.available && !window.Motion.reduced
      ? "[data-lifecycle-legacy]"
      : "[data-lifecycle]";

  $$(lifecycleSelector).forEach((strip) => {
    const fill = $(".lifecycle__fill", strip);
    const bead = $(".lifecycle__bead", strip);
    const steps = $$(".lifecycle__step", strip);
    if (!fill || !bead || !steps.length) return;
    let ticking = false;

    const update = () => {
      ticking = false;
      const rect = strip.getBoundingClientRect();
      const vh = window.innerHeight;
      // 0 when the strip's top reaches 78% of the viewport, 1 once it has
      // travelled a further 70% of the viewport height.
      const raw = (vh * 0.78 - rect.top) / (vh * 0.7);
      const p = Math.min(1, Math.max(0, raw));

      fill.style.width = (p * 100).toFixed(2) + "%";
      bead.style.left = (p * 100).toFixed(2) + "%";
      bead.style.opacity = p > 0.01 ? "1" : "0";

      steps.forEach((s, i) => {
        s.classList.toggle("is-active", p >= (i + 0.55) / steps.length);
      });
    };

    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
  });

  /* ----------------------------------------------------------- ticker -- */

  /* The marquee carries real release lines when the API has any, and
     statements about the product when it does not. It never carries an
     invented event: a fabricated "x just verified" would be a fabricated
     verification. */
  const TICKER_FALLBACK = [
    "a package identity is derived from the package name",
    "repository control is not publish authority",
    "every figure here is read from npm, or shown as a dash",
    "verification needs a proof npm itself can vouch for",
    "wallet proof is a signature, not a transaction",
    "Solana devnet while the program is undeployed",
  ];

  async function fillTicker() {
    const track = $("[data-ticker]");
    if (!track) return;

    const render = (text, mono) =>
      `<span class="ticker__item"><span class="ticker__dot"></span>` +
      `${mono ? `<b>${UI.esc(mono)}</b> ` : ""}${UI.esc(text)}</span>`;

    let items = TICKER_FALLBACK.map((t) => render(t));
    try {
      const feed = await API.activity(10);
      const releases = (feed.entries || []).filter(
        (e) => e.kind === "release.published"
      );
      if (releases.length >= 3) {
        items = releases.map((e) =>
          render(
            `${e.version} published ${UI.ago(e.at)}`,
            e.packageName
          )
        );
      }
    } catch (e) {
      // The fallback lines are already in place.
    }
    // Duplicated once so the -50% marquee wraps seamlessly.
    const half = items.join("");
    track.innerHTML = half + half;
  }

  /* ======================================================= chrome state == */

  /* The nav reflects whether anyone is signed in: the dashboard link appears
     and the call to action stops inviting a sign-in that already happened. */
  async function paintChrome() {
    const me = await API.me();
    const dashLink = $("[data-auth-only]");
    const cta = $("[data-nav-cta]");
    if (me && me.signedIn) {
      if (dashLink) dashLink.hidden = false;
      if (cta) {
        cta.textContent = "launch a package";
        cta.setAttribute("href", "/connect.html");
      }
    } else if (cta && me && me.githubConfigured === false) {
      // Sign-in cannot work, so the button says what it can do instead of
      // leading somewhere that will fail.
      cta.textContent = "browse packages";
      cta.setAttribute("href", "/explore.html");
    }
  }

  /* ========================================================== page: index */

  async function pageIndex() {
    fillTicker();
    wireSearch($("[data-search]"), { navigateOnPick: true });

    const grid = $("[data-featured]");
    if (!grid) return;
    grid.innerHTML = UI.skeletonCards(2);
    try {
      const data = await API.featured();
      const note = $("[data-featured-note]");
      const list = data.verified.length ? data.verified : data.sample;

      if (!list.length) {
        grid.innerHTML = UI.empty(
          "nothing to show yet",
          "no package has been verified here, and npm could not be reached for a live sample."
        );
      } else {
        grid.innerHTML = list.map(UI.packageCard).join("");
      }

      if (note) {
        note.hidden = false;
        note.innerHTML = data.verified.length
          ? `<span class="notice__tag">verified</span> ${UI.esc(
              `${data.verified.length} package${data.verified.length === 1 ? "" : "s"} with proved publish authority.`
            )}`
          : `<span class="notice__tag">live from npm</span> ${UI.esc(
              data.sampleNote || ""
            )}`;
      }
      grid.classList.add("is-loaded");
      if (window.Motion) window.Motion.organiseGrid(grid);
      observeReveals(grid);
    } catch (err) {
      grid.innerHTML = UI.errorBox(err, "the package grid");
      grid.classList.add("is-loaded");
      observeReveals(grid);
    }
  }

  /* ======================================================== page: explore */

  async function pageExplore() {
    const grid = $("[data-results]");
    const search = $("[data-search]");
    wireSearch(search, { target: grid });

    // A query in the url is rendered immediately, so a search result is a
    // shareable link rather than a state only this tab has.
    const initial = UI.param("q");
    if (initial) {
      const input = $("input", search);
      if (input) input.value = initial;
      runSearch(initial, grid);
      return;
    }

    // The view comes from the url, so a browse state is shareable too.
    await showDiscovery(UI.param("view") || "verified", grid);
  }

  /* Discovery. The view list comes from the server rather than being written
     here, so the two cannot drift apart. */
  async function showDiscovery(view, grid) {
    const note = $("[data-results-note]");
    const tabs = $("[data-views]");
    grid.innerHTML = UI.skeletonCards(2);

    try {
      const data = await API.discover(view, 18);

      if (tabs) {
        tabs.innerHTML = data.views
          .map(
            (v) => `<button class="filters__chip" type="button" data-view="${UI.esc(v.key)}"
              aria-pressed="${v.key === data.view}" title="${UI.esc(v.description)}">${UI.esc(v.label)}</button>`
          )
          .join("");
        $$("[data-view]", tabs).forEach((btn) =>
          btn.addEventListener("click", () => {
            const chosen = btn.dataset.view;
            // Replace rather than push: browsing views is not a history trail.
            window.history.replaceState({}, "", `/explore.html?view=${encodeURIComponent(chosen)}`);
            showDiscovery(chosen, grid);
          })
        );
      }

      if (note) {
        note.hidden = false;
        /* The scope, said plainly. This indexes what people connected, not
           the registry, and an empty view should read as that rather than as
           something being broken. */
        note.innerHTML =
          `<span class="notice__tag">${UI.esc(data.label)}</span> ${UI.esc(data.description)}. ` +
          `${UI.esc(data.scope.note)} ` +
          `<b>${UI.count(data.scope.indexedPackages)}</b> connected, ` +
          `<b>${UI.count(data.scope.verifiedPackages)}</b> verified.`;
      }

      grid.innerHTML = data.results.length
        ? data.results.map(UI.packageCard).join("")
        : UI.empty(
            "nothing in this view yet",
            "Packages indexes only what has been connected here. Search above to open any package on npm."
          );
      grid.classList.add("is-loaded");
      if (window.Motion) window.Motion.organiseGrid(grid);
      observeReveals(grid);
    } catch (err) {
      grid.innerHTML = UI.errorBox(err, "packages");
      grid.classList.add("is-loaded");
      observeReveals(grid);
    }
  }

  /* The search box. Debounced, and it cancels a slower earlier response so a
     fast typist does not see results for a query they have moved past. */
  let searchSeq = 0;

  function wireSearch(scope, options) {
    if (!scope) return;
    const opts = options || {};
    const input = $("input", scope);
    const state = $("[data-search-state]", scope);
    const form = scope.tagName === "FORM" ? scope : $("form", scope);
    if (!input) return;

    let timer = null;
    const target = opts.target || $("[data-results]");

    const go = (value) => {
      if (!value || value.length < 2) {
        if (state) state.textContent = "";
        return;
      }
      if (opts.navigateOnPick) {
        window.location.href = `/explore.html?q=${encodeURIComponent(value)}`;
        return;
      }
      runSearch(value, target, state);
    };

    if (form) {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        clearTimeout(timer);
        go(input.value.trim());
      });
    }

    input.addEventListener("input", () => {
      if (opts.navigateOnPick) return;
      clearTimeout(timer);
      const value = input.value.trim();
      if (state && value.length >= 2) {
        state.innerHTML = '<span class="spinner"></span> searching npm';
      }
      timer = setTimeout(() => go(value), 320);
    });
  }

  async function runSearch(query, target, state) {
    if (!target) return;
    const seq = ++searchSeq;
    target.innerHTML = UI.skeletonCards(2);
    const note = $("[data-results-note]");
    if (note) note.hidden = true;
    try {
      const data = await API.search(query, 18);
      if (seq !== searchSeq) return;
      if (state) {
        state.textContent = `${data.count} result${data.count === 1 ? "" : "s"} from the npm registry for "${query}"`;
      }
      target.innerHTML = data.results.length
        ? data.results.map(UI.packageCard).join("")
        : UI.empty(
            "nothing matched",
            `the npm registry returned no packages for "${query}".`
          );
      target.classList.add("is-loaded");
      if (window.Motion) window.Motion.organiseGrid(target);
      observeReveals(target);
    } catch (err) {
      if (seq !== searchSeq) return;
      if (state) state.textContent = "";
      target.innerHTML = UI.errorBox(err, "search results");
      target.classList.add("is-loaded");
      observeReveals(target);
    }
  }

  /* ======================================================== page: package */

  /* The package name comes from the query string, or from the path when the
     server rewrote /p/<name>. Both resolve to the same page. */
  function packageNameFromUrl() {
    const q = UI.param("p");
    if (q) return q;
    const m = window.location.pathname.match(/^\/p\/(.+)$/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  async function pagePackage() {
    const root = $("[data-package]");
    if (!root) return;
    const name = packageNameFromUrl();

    if (!name) {
      root.innerHTML = UI.empty(
        "no package named",
        "open a package from the packages page, or search for one.",
        '<a class="btn btn--sm btn--ink" href="/explore.html">browse packages</a>'
      );
      root.classList.add("is-loaded");
      observeReveals(root);
      return;
    }

    document.title = `${name} — Packages`;
    root.innerHTML = `<div class="skeleton skeleton--card"></div>`;

    let data;
    try {
      data = await API.package(name);
    } catch (err) {
      root.innerHTML =
        err.status === 404
          ? UI.empty(
              "no such package",
              `the npm registry has no package named "${name}".`,
              '<a class="btn btn--sm btn--ink" href="/explore.html">browse packages</a>'
            )
          : UI.errorBox(err, `the page for ${name}`);
      root.classList.add("is-loaded");
      observeReveals(root);
      return;
    }

    const p = data.package;
    const v = p.verification;
    const repo = p.repository;

    // A canonical link, so the shareable url for a package is one url.
    const canonical = document.querySelector("link[rel=canonical]") || document.createElement("link");
    canonical.rel = "canonical";
    canonical.href = `${window.location.origin}/p/${encodeURIComponent(p.name)}`;
    document.head.appendChild(canonical);

    const spark = UI.sparkline(p.downloads.series);

    root.innerHTML = `
      <div class="pkg__title" data-reveal>
        <h1 class="pkg__name-lg">${UI.esc(p.name)}</h1>
        ${p.latestVersion ? `<span class="chip-tag">${UI.esc(p.latestVersion)}</span>` : ""}
      </div>
      ${UI.badges(v, p, p.identity)}
      <p class="lede" data-reveal>${p.description ? UI.esc(p.description) : "this package has no description on npm."}</p>
      ${
        p.deprecated
          ? `<p class="notice notice--warn" data-reveal style="margin-top:18px">
               <span class="notice__tag notice__tag--warn">deprecated</span>
               npm reports this package as deprecated: ${UI.esc(p.deprecated)}
             </p>`
          : ""
      }
      <div class="meta-row" data-reveal>
        <span>${p.license ? UI.esc(p.license) : "no license field"}</span>
        <span>${UI.dash(p.versionCount)} versions</span>
        <span>first published ${UI.date(p.createdAt)}</span>
        <span>last published ${UI.ago(p.modifiedAt)}</span>
        <span><a href="${UI.safeUrl(p.npmUrl)}" rel="noopener noreferrer nofollow" target="_blank">view on npm &nearr;</a></span>
      </div>

      ${UI.codeblock("install-cmd", `npm install ${p.name}`)}

      <div class="profile-grid" style="margin-top:36px">
        <div>
          <div class="panel" data-reveal>
            <div class="panel__head">
              <div>
                <div class="eyebrow">identity</div>
                <h2 class="panel__title">verification</h2>
              </div>
              ${UI.statusChip(v.status)}
            </div>
            <p class="panel__copy">${UI.esc(v.explanation)}</p>
            ${
              v.owner
                ? `<div class="contribs">
                     <a class="contrib" href="/creator.html?u=${encodeURIComponent(v.owner.login)}">
                       ${UI.avatar(v.owner.login, v.owner.avatarUrl, "avatar-img--sm")}
                       <span>${UI.esc(v.owner.login)}</span>
                       <span class="contrib__n">verified ${UI.ago(v.verifiedAt)}</span>
                     </a>
                   </div>`
                : ""
            }
            ${
              v.evidence.length
                ? `<div class="evidence">${v.evidence.map(UI.evidenceRow).join("")}</div>`
                : `<p class="panel__note">no proof has been attempted for this package. Anyone who can publish it can claim it.</p>`
            }
            ${v.nextStep ? `<p class="panel__note">next: ${UI.esc(v.nextStep)}</p>` : ""}
            ${
              p.verificationHistory && p.verificationHistory.length
                ? `<h3 class="panel__title" style="margin-top:24px;font-size:15px">what was checked, and when</h3>
                   <p class="panel__note" style="margin-top:6px">
                     every check run against this package, passed or failed, in
                     the order they happened. Append-only: a check is never
                     removed, so a verification that was later withdrawn still
                     shows here.
                   </p>
                   <div class="vlist">${p.verificationHistory
                     .map(
                       (h) => `<div class="vrow">
                           <span class="vrow__v">
                             <span class="ev__mark ${h.passed ? "" : "ev__mark--fail"}" style="display:inline-grid;vertical-align:-4px">${
                         h.passed
                           ? '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4"><path d="m5 13 4 4L19 7"/></svg>'
                           : '<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4"><path d="M6 6l12 12M18 6 6 18"/></svg>'
                       }</span>
                             ${UI.esc(h.kind.replace(/_/g, " "))}
                           </span>
                           <span class="vrow__when" title="${UI.esc(h.at || "")}">${UI.ago(h.at)}</span>
                           <span class="vrow__hash">${UI.esc(h.reason || "")}${
                         h.actor ? ` &middot; ${UI.esc(h.actor)}` : ""
                       }</span>
                         </div>`
                     )
                     .join("")}</div>`
                : ""
            }
          </div>

          <div class="panel" data-reveal>
            <h2 class="panel__title">version history</h2>
            <p class="panel__copy">
              every published version, with the publish time npm recorded. A
              published version cannot change, so these records are never
              rewritten.
            </p>
            <div class="vlist">
              <div class="vrow vrow--head"><span>version</span><span class="vrow__when">published</span></div>
              ${
                p.releases.length
                  ? p.releases
                      .slice(0, 25)
                      .map(
                        (r) => `<div class="vrow">
                          <span class="vrow__v"><b>${UI.esc(r.version)}</b>${
                          r.version === p.latestVersion
                            ? '<span class="vrow__tag">latest</span>'
                            : ""
                        }${
                          !r.present
                            ? '<span class="vrow__tag vrow__tag--muted">unpublished</span>'
                            : ""
                        }${
                          r.deprecated
                            ? '<span class="vrow__tag vrow__tag--warn">deprecated</span>'
                            : ""
                        }</span>
                          <span class="vrow__when" title="${UI.esc(r.publishedAt || "")}">${UI.ago(r.publishedAt)}</span>
                        </div>`
                      )
                      .join("")
                  : '<div class="vrow"><span class="vrow__v">npm reported no version history</span><span class="vrow__when"></span></div>'
              }
            </div>
            ${
              p.releases.length > 25
                ? `<p class="panel__note">showing the 25 most recent of ${UI.count(p.releases.length)}.</p>`
                : ""
            }
          </div>

          <div class="panel" data-reveal>
            <div class="panel__head">
              <div>
                <div class="eyebrow">source</div>
                <h2 class="panel__title">repository</h2>
              </div>
            </div>
            ${
              p.declaredRepo
                ? `<p class="panel__copy">
                     the package declares
                     <a href="${UI.safeUrl(p.declaredRepo.url)}" rel="noopener noreferrer nofollow" target="_blank">${UI.esc(
                       `${p.declaredRepo.owner}/${p.declaredRepo.repo}`
                     )}</a>${p.repoDirectory ? ` (in <code>${UI.esc(p.repoDirectory)}</code>)` : ""}.
                     npm does not check this field, so it is what the publisher
                     wrote rather than something proved.
                   </p>`
                : '<p class="panel__copy">this package declares no repository.</p>'
            }
            ${
              repo
                ? `<div class="repo__meta">
                     ${repo.language ? `<span><i class="lang-dot" style="background:#7C4DFF"></i>${UI.esc(repo.language)}</span>` : ""}
                     <span>&#9734; ${UI.count(repo.stars)}</span>
                     <span>&#8694; ${UI.count(repo.forks)}</span>
                     <span>${UI.count(repo.openIssues)} open issues</span>
                     <span>pushed ${UI.ago(repo.pushedAt)}</span>
                     ${repo.archived ? '<span class="tag-archived">archived</span>' : ""}
                   </div>
                   ${
                     repo.topics && repo.topics.length
                       ? `<div class="repo__topics">${repo.topics
                           .slice(0, 10)
                           .map((t) => `<span class="topic">${UI.esc(t)}</span>`)
                           .join("")}</div>`
                       : ""
                   }`
                : p.declaredRepo
                ? `<p class="panel__note">${UI.esc(p.repositoryError || "GitHub did not return this repository.")}</p>`
                : ""
            }
            ${
              p.contributors.length
                ? `<h3 class="panel__title" style="margin-top:24px;font-size:15px">contributors</h3>
                   <div class="contribs">${p.contributors
                     .map(
                       (c) => `<a class="contrib" href="${UI.safeUrl(c.profileUrl)}" rel="noopener noreferrer nofollow" target="_blank">
                         ${UI.avatar(c.login, c.avatarUrl, "avatar-img--sm")}
                         <span>${UI.esc(c.login)}</span>
                         <span class="contrib__n">${UI.count(c.contributions)}</span>
                       </a>`
                     )
                     .join("")}</div>`
                : p.contributorsRateLimited
                ? '<p class="panel__note">GitHub rate-limited the contributor list for this server. It will return shortly.</p>'
                : ""
            }
            ${
              p.commits.length
                ? `<h3 class="panel__title" style="margin-top:24px;font-size:15px">recent commits</h3>
                   <div class="vlist">${p.commits
                     .map(
                       (c) => `<div class="vrow">
                         <span class="vrow__v">${UI.esc(c.message || "")}</span>
                         <span class="vrow__when">${UI.ago(c.date)}</span>
                         <span class="vrow__hash">${UI.esc(c.sha || "")} &middot; ${UI.esc(c.author || "unknown author")}</span>
                       </div>`
                     )
                     .join("")}</div>`
                : ""
            }
          </div>
        </div>

        <aside>
          <div class="panel panel--quiet" data-reveal>
            <h2 class="panel__title">downloads</h2>
            ${spark || '<p class="panel__note">npm reports no download series for this package.</p>'}
            <div class="kv-grid kv-grid--stack">
              <div class="kv">
                <div class="kv__k">last week</div>
                <div class="kv__v" title="${UI.count(p.downloads.lastWeek)}">${UI.compact(p.downloads.lastWeek)}</div>
              </div>
              <div class="kv">
                <div class="kv__k">last month</div>
                <div class="kv__v" title="${UI.count(p.downloads.lastMonth)}">${UI.compact(p.downloads.lastMonth)}</div>
              </div>
            </div>
            <p class="panel__note">read from npm's downloads api. A dash means npm reports no figure.</p>
          </div>

          <div class="panel panel--quiet" data-reveal>
            <h2 class="panel__title">publisher</h2>
            ${
              p.publisher
                ? `<div class="kv-grid kv-grid--stack">
                     <div class="kv"><div class="kv__k">last published by</div><div class="kv__v">${UI.dash(p.publisher.name)}</div></div>
                     <div class="kv"><div class="kv__k">trusted publisher</div><div class="kv__v">${
                       p.publisher.trustedPublisher
                         ? UI.esc(p.publisher.trustedPublisher)
                         : "no"
                     }</div></div>
                   </div>`
                : '<p class="panel__note">npm reports no publisher for the latest version.</p>'
            }
            <p class="panel__note">${
              p.hasProvenance
                ? "npm published a build attestation for the latest version, which names the repository the tarball was built from."
                : "npm published no build attestation for the latest version."
            }</p>
            ${
              p.maintainers.length
                ? `<h3 class="panel__title" style="margin-top:20px;font-size:15px">npm maintainers</h3>
                   <ul class="tiers">${p.maintainers
                     .map(
                       (m) => `<li class="tier"><span class="tier__dot"></span>
                         <span class="tier__name">${UI.esc(m.username)}</span></li>`
                     )
                     .join("")}</ul>`
                : ""
            }
          </div>

          <div class="panel panel--quiet" data-reveal>
            <h2 class="panel__title">the published artifact</h2>
            <div class="kv-grid kv-grid--stack">
              <div class="kv">
                <div class="kv__k">unpacked size</div>
                <div class="kv__v">${UI.bytes(p.unpackedSize)}</div>
              </div>
              <div class="kv">
                <div class="kv__k">files</div>
                <div class="kv__v">${UI.count(p.fileCount)}</div>
              </div>
            </div>
            ${
              p.integrity
                ? `<div class="kv" style="margin-top:12px">
                     <div class="kv__k">integrity, latest version</div>
                     <div class="kv__v kv__v--mono" title="${UI.esc(p.integrity)}">${UI.esc(p.integrity)}</div>
                   </div>`
                : ""
            }
            ${
              p.engines && p.engines.node
                ? `<div class="kv" style="margin-top:12px">
                     <div class="kv__k">node</div>
                     <div class="kv__v">${UI.esc(p.engines.node)}</div>
                   </div>`
                : ""
            }
            <p class="panel__note">
              read from the registry exactly as published. The integrity hash
              is what an onchain release record commits to, so it is the
              registry's value rather than anything recomputed here.
            </p>
          </div>

          <div class="panel panel--quiet" data-reveal>
            <h2 class="panel__title">onchain identity</h2>
            ${renderIdentity(p.identity, p.name)}
          </div>

          ${
            p.keywords.length
              ? `<div class="panel panel--quiet" data-reveal>
                   <h2 class="panel__title">keywords</h2>
                   <div class="repo__topics">${p.keywords
                     .slice(0, 16)
                     .map((k) => `<span class="topic">${UI.esc(k)}</span>`)
                     .join("")}</div>
                 </div>`
              : ""
          }
        </aside>
      </div>`;

    UI.wireCopy(root);
    root.classList.add("is-loaded");
    observeReveals(root);
    /* The badge row is the result of everything this page just established,
       so it arrives as a result rather than fading in with the furniture. */
    if (window.Motion) {
      window.Motion.pop(root.querySelectorAll(".badge"), { delay: 0.2 });
    }
  }

  /* The identity panel. When the program is not deployed it says so and shows
     nothing that would imply an account exists. */
  function renderIdentity(identity, name) {
    if (!identity) return '<p class="panel__note">no identity information.</p>';
    if (identity.registeredAddress) {
      return `<div class="kv-grid kv-grid--stack">
        <div class="kv"><div class="kv__k">identity account</div><div class="kv__v kv__v--mono">${UI.esc(identity.registeredAddress)}</div></div>
        <div class="kv"><div class="kv__k">registered</div><div class="kv__v">${UI.ago(identity.launchedAt)}</div></div>
      </div>`;
    }
    if (identity.derived) {
      return `<div class="kv-grid kv-grid--stack">
          <div class="kv"><div class="kv__k">derived address</div><div class="kv__v kv__v--mono">${UI.esc(identity.derived.address)}</div></div>
          <div class="kv"><div class="kv__k">cluster</div><div class="kv__v">${UI.esc(identity.derived.cluster)}</div></div>
        </div>
        <p class="panel__note">this address is derived from the package name, so it is the same everywhere. No account exists at it until an identity is registered.</p>`;
    }
    return `<p class="panel__copy">
        an identity for <b>${UI.esc(name)}</b> would be derived from its name, at a fixed
        address on Solana devnet.
      </p>
      <p class="panel__note">the identity program is not deployed yet, so there is no address to show and nothing has been registered.</p>`;
  }

  /* ======================================================= page: activity */

  async function pageActivity() {
    const root = $("[data-feed]");
    if (!root) return;
    root.innerHTML = '<div class="skeleton skeleton--row"></div><div class="skeleton skeleton--row"></div>';
    try {
      const data = await API.activity(40);
      if (!data.entries.length) {
        root.innerHTML = UI.empty(
          "nothing has happened yet",
          data.note ||
            "release activity appears here for packages that have been imported.",
          '<a class="btn btn--sm btn--ink" href="/connect.html">launch a package</a>'
        );
        root.classList.add("is-loaded");
        observeReveals(root);
        return;
      }
      root.innerHTML = `<div class="feed">${data.entries
        .map(
          (e) => `<div class="feed__row">
            <span class="feed__src">${UI.esc(e.source)}</span>
            <span class="feed__what">${
              e.packageName ? `<b>${UI.esc(e.packageName)}</b> ` : ""
            }${
            e.url
              ? `<a href="${UI.safeUrl(e.url)}" rel="noopener noreferrer nofollow" target="_blank">${UI.esc(e.detail || e.kind)}</a>`
              : UI.esc(e.detail || e.kind)
          }</span>
            <span class="feed__when" title="${UI.esc(e.at || "")}">${UI.ago(e.at)}</span>
          </div>`
        )
        .join("")}</div>`;
      const note = $("[data-feed-note]");
      if (note) {
        note.hidden = false;
        note.innerHTML =
          '<span class="notice__tag">live</span> release lines are read from the npm registry and commit lines from the GitHub API each time this page loads. Nothing here is a stored copy.';
      }
      root.classList.add("is-loaded");
      observeReveals(root);
    } catch (err) {
      root.innerHTML = UI.errorBox(err, "the activity feed");
      root.classList.add("is-loaded");
      observeReveals(root);
    }
  }

  /* ======================================================== page: creator */

  async function pageCreator() {
    const root = $("[data-developer]");
    if (!root) return;
    const login = UI.param("u");
    if (!login) {
      root.innerHTML = UI.empty(
        "no developer named",
        "open a developer from a verified package page.",
        '<a class="btn btn--sm btn--ink" href="/explore.html">browse packages</a>'
      );
      root.classList.add("is-loaded");
      observeReveals(root);
      return;
    }

    document.title = `${login} — Packages`;
    root.innerHTML = '<div class="skeleton skeleton--card"></div>';

    try {
      const data = await API.developer(login);
      const d = data.developer;
      root.innerHTML = `
        <div class="profile" data-reveal>
          ${UI.avatar(d.login, d.avatarUrl, "avatar-img--lg")}
          <div class="profile__id">
            <h1 class="profile__name">${UI.esc(d.name || d.login)}
              ${UI.verifiedBadge(data.packages.length > 0)}
            </h1>
            <p class="profile__handle">@${UI.esc(d.login)}</p>
            <p class="profile__line">${
              data.packages.length
                ? `maintains ${UI.count(data.packages.length)} verified package${data.packages.length === 1 ? "" : "s"}`
                : "no verified packages yet"
            }</p>
          </div>
          <div class="profile__actions">
            <a class="btn btn--sm btn--glass" href="${UI.safeUrl(d.profileUrl)}" rel="noopener noreferrer nofollow" target="_blank">github profile</a>
          </div>
        </div>

        <div class="panel panel--quiet" data-reveal style="margin-top:32px">
          <h2 class="panel__title">what the check mark means</h2>
          <p class="panel__copy">
            this developer signed in with GitHub and, for each package below,
            proved authority to publish it: either a proof string issued here
            appeared in a version they published, or npm's own build
            attestation names a repository they control. Nothing on this page
            is a statement about code quality.
          </p>
        </div>

        ${
          data.packages.length
            ? `<div class="pkgs" style="margin-top:32px">${data.packages
                .map((c) =>
                  UI.packageCard({
                    name: c.name,
                    description: c.description,
                    latestVersion: c.latestVersion,
                    repo: c.repo,
                    verified: true,
                    claimed: true,
                    owner: { login: d.login, avatarUrl: d.avatarUrl },
                    downloadsWeekly: null,
                    dependents: null,
                    versionCount: null,
                    license: null,
                    publishedAt: null,
                  })
                )
                .join("")}</div>`
            : UI.empty(
                "no verified packages",
                "this developer has signed in but has not completed verification for a package yet."
              )
        }

        ${
          data.contributions && data.contributions.length
            ? `<div class="panel panel--quiet" data-reveal style="margin-top:32px">
                 <h2 class="panel__title">contributions</h2>
                 <p class="panel__copy">
                   packages this login appears on as a contributor, as the
                   GitHub api reported it. An imported fact, not a claim made
                   by this developer, and not evidence that the npm and GitHub
                   accounts belong to the same person.
                 </p>
                 <div class="vlist">
                   ${data.contributions
                     .map(
                       (c) => `<div class="vrow">
                           <span class="vrow__v"><a href="/package.html?p=${encodeURIComponent(
                             c.package
                           )}">${UI.esc(c.package)}</a></span>
                           <span class="vrow__when">${UI.count(c.commits)} commits</span>
                           <span class="vrow__hash">read from the GitHub api ${UI.ago(
                             c.retrievedAt
                           )}</span>
                         </div>`
                     )
                     .join("")}
                 </div>
               </div>`
            : ""
        }`;
      root.classList.add("is-loaded");
      observeReveals(root);
    } catch (err) {
      root.innerHTML =
        err.status === 404
          ? UI.empty(
              "no such developer here",
              `nobody with the GitHub login "${login}" has signed in to Packages.`
            )
          : UI.errorBox(err, `the profile for ${login}`);
      root.classList.add("is-loaded");
      observeReveals(root);
    }
  }

  /* ======================================================== page: connect */

  /* The six-step launch flow. Each step reports its own state from the server
     rather than from anything held in the browser, so a reload never shows a
     step as done when it is not. */
  async function pageConnect() {
    const root = $("[data-connect]");
    if (!root) return;

    const name = UI.param("p") || "";
    const [me, cfg] = await Promise.all([API.me({ fresh: true }), API.config()]);
    renderConnect(root, me, cfg, name);
  }

  async function renderConnect(root, me, cfg, presetName) {
    const signedIn = Boolean(me && me.signedIn);
    const githubOff = me && me.githubConfigured === false;
    const claims = signedIn ? me.user.packages : [];
    const selectedName = presetName || (claims[0] && claims[0].name) || "";
    const claim = claims.find((c) => c.name === selectedName) || null;
    const wallets = signedIn ? me.user.wallets : [];
    const solanaCfg = (cfg && cfg.solana) || {};

    const step = (n, title, status, body, done) => `
      <div class="panel ${done ? "panel--done" : ""} ${
      status === "locked" ? "panel--locked" : ""
    }" data-reveal>
        <div class="panel__head">
          <div>
            <h2 class="panel__title"><span class="panel__step">${n}</span>${UI.esc(title)}</h2>
          </div>
          ${
            done
              ? '<span class="status-chip status-chip--ok">done</span>'
              : status === "locked"
              ? '<span class="status-chip status-chip--off">waiting</span>'
              : status === "optional"
              ? '<span class="status-chip">optional</span>'
              : '<span class="status-chip status-chip--part">now</span>'
          }
        </div>
        ${body}
      </div>`;

    // A claim exists for the selected package: the package is connected.
    const imported = Boolean(claim);

    const parts = [];

    /* 1 — connect package.
       Search, select and import are one stage, because importing needs a
       signed-in account and splitting them stranded the user mid-stage. */
    parts.push(
      step(
        1,
        "connect package",
        imported ? "done" : "now",
        `<p class="panel__copy">
           find the package you publish on npm. Importing records what the
           registry reports about it and proves nothing on its own.
         </p>
         ${
           imported
             ? `<div class="kv-grid kv-grid--stack">
                  <div class="kv">
                    <div class="kv__k">connected package</div>
                    <div class="kv__v kv__v--mono">${UI.esc(claim.name)}</div>
                  </div>
                  <div class="kv">
                    <div class="kv__k">latest version on npm</div>
                    <div class="kv__v">${UI.dash(claim.latestVersion)}</div>
                  </div>
                </div>
                <div class="panel__foot">
                  <a class="btn btn--sm btn--glass" href="/package.html?p=${encodeURIComponent(claim.name)}">view its page</a>
                  <button class="btn btn--sm btn--glass" type="button" data-unimport="${UI.esc(claim.name)}">disconnect</button>
                </div>`
             : `<div class="searchbar" data-search>
                  <form class="searchbar__row">
                    <input class="field" type="search" name="q" placeholder="express, @scope/name"
                      autocomplete="off" aria-label="search npm" value="${UI.esc(selectedName)}">
                    <button class="btn btn--lg btn--ink" type="submit">search npm</button>
                    <span class="searchbar__hint">the registry is searched live. Nothing is connected until you choose.</span>
                  </form>
                  <div class="searchbar__state" data-search-state></div>
                </div>
                <div class="pkgs" data-results style="margin-top:20px"></div>
                ${
                  signedIn
                    ? `<div class="panel__foot">
                         <button class="btn btn--lg btn--ink" type="button" data-import ${selectedName ? "" : "disabled"}>
                           connect ${selectedName ? UI.esc(selectedName) : "a package"}
                         </button>
                         <span class="panel__hint" data-import-hint>${
                           selectedName ? "" : "choose a package above"
                         }</span>
                       </div>`
                    : githubOff
                    ? `<p class="panel__note">
                         GitHub sign-in is not configured on this server, so a
                         package cannot be connected. Searching and every public
                         package page still work.
                       </p>`
                    : `<div class="panel__foot">
                         <button class="btn btn--lg btn--ink" type="button" data-signin>sign in to connect it</button>
                         <span class="panel__hint">email or a Solana wallet</span>
                       </div>`
                }`
         }`,
        imported
      )
    );

    /* 2 — verify publisher. The GitHub half: who you are, and whether you
       control the repository the package declares. */
    const repoDone = Boolean(
      claim && claim.evidence.find((e) => e.key === "repo_control" && e.passed)
    );
    parts.push(
      step(
        2,
        "verify publisher",
        !imported ? "locked" : repoDone ? "done" : "now",
        !imported
          ? '<p class="panel__copy">connect a package first.</p>'
          : `<p class="panel__copy">
               ${
                 signedIn
                   ? `signed in as <b>${UI.esc(me.user.login)}</b>. `
                   : ""
               }we read your permission on the repository the package declares,
               using your own GitHub token. ${
                 claim.repo
                   ? `that repository is <b>${UI.esc(claim.repo.owner + "/" + claim.repo.repo)}</b>.`
                   : "this package declares no repository, so this stage has nothing to check: go straight to proving the package."
               }
             </p>
             <p class="panel__note">
               controlling the repository is not permission to publish the
               package, because npm never checks the repository a package
               declares. This stage is half of one route to verification, and
               can be skipped entirely by proving the package directly.
             </p>
             ${
               claim.repo
                 ? `<div class="panel__foot">
                      <button class="btn btn--lg btn--ink" type="button" data-verify-repo="${UI.esc(claim.name)}">check my permission</button>
                      <button class="btn btn--sm btn--glass" type="button" data-signout>sign out</button>
                      <span class="panel__hint" data-repo-hint></span>
                    </div>`
                 : `<div class="panel__foot">
                      <button class="btn btn--sm btn--glass" type="button" data-signout>sign out</button>
                    </div>`
             }`,
        repoDone
      )
    );

    /* 3 — prove the package. The stage that actually establishes authority. */
    const proofDone = Boolean(
      claim && claim.evidence.find((e) => e.key === "publish_proof" && e.passed)
    );
    const trustedDone = Boolean(
      claim && claim.evidence.find((e) => e.key === "trusted_publisher" && e.passed)
    );
    const verified = Boolean(claim && claim.verified);
    parts.push(
      step(
        3,
        "prove the package",
        !imported ? "locked" : verified ? "done" : "now",
        !imported
          ? '<p class="panel__copy">connect a package first.</p>'
          : verified
          ? `<p class="panel__copy">
               <b>${UI.esc(claim.name)}</b> is verified${
              trustedDone && !proofDone
                ? ": npm's own build attestation names the repository you control as the source of a published release"
                : ": a proof string issued here appeared in a version you published"
            }.
             </p>
             <div class="evidence">${claim.evidence.map(UI.evidenceRow).join("")}</div>`
          : `<p class="panel__copy">
               the direct proof: put a string we issue into a version you
               publish. Only an account that can run npm publish for this
               package can do that, which is exactly why it proves something.
             </p>
             <p class="panel__note">
               this asks you to publish a real version to npm, which is public
               and permanent. We never ask for npm credentials and could not
               publish on your behalf.
             </p>
             <div class="panel__foot">
               <button class="btn btn--lg btn--ink" type="button" data-proof-start="${UI.esc(claim.name)}">get my proof string</button>
               <span class="panel__hint" data-proof-hint></span>
             </div>
             <div data-proof-area></div>
             <div class="evidence">${claim.evidence.map(UI.evidenceRow).join("")}</div>
             ${claim.nextStep ? `<p class="panel__note">next: ${UI.esc(claim.nextStep)}</p>` : ""}`,
        verified
      )
    );

    /* 4 — connect wallet */
    const walletDone = wallets.length > 0;
    parts.push(
      step(
        4,
        "connect wallet",
        !verified ? "locked" : walletDone ? "done" : "now",
        !verified
          ? '<p class="panel__copy">prove the package first.</p>'
          : `<p class="panel__copy">
               sign a short message to prove the wallet is yours. It is a
               signature, not a transaction: nothing is sent and no funds move.
               This wallet becomes the identity's authority onchain.
             </p>
             ${
               walletDone
                 ? `<div class="kv-grid kv-grid--stack">${wallets
                     .map(
                       (w) => `<div class="kv">
                           <div class="kv__k">${UI.esc(w.cluster)} wallet, proved ${UI.ago(w.verifiedAt)}</div>
                           <div class="kv__v kv__v--mono">${UI.esc(w.pubkey)}</div>
                         </div>`
                     )
                     .join("")}</div>`
                 : `<div class="panel__foot">
                      <button class="btn btn--lg btn--ink" type="button" data-wallet-connect>connect a wallet</button>
                      <span class="panel__hint" data-wallet-hint>Phantom, Solflare or any wallet that signs a message</span>
                    </div>`
             }`,
        walletDone
      )
    );

    /* 5 — review. Everything that would be written, before anything is. */
    const reviewReady = verified && walletDone;
    parts.push(
      step(
        5,
        "review",
        !reviewReady ? "locked" : "now",
        !reviewReady
          ? '<p class="panel__copy">prove the package and connect a wallet first.</p>'
          : `<p class="panel__copy">
               exactly what would be written to Solana devnet. Nothing has been
               signed or sent, and nothing will be until you launch.
             </p>
             <div class="kv-grid kv-grid--stack">
               <div class="kv">
                 <div class="kv__k">package</div>
                 <div class="kv__v kv__v--mono">${UI.esc(claim.name)}</div>
               </div>
               <div class="kv">
                 <div class="kv__k">authority, your proved wallet</div>
                 <div class="kv__v kv__v--mono">${UI.esc(wallets[0].pubkey)}</div>
               </div>
               <div class="kv">
                 <div class="kv__k">cluster</div>
                 <div class="kv__v">${UI.esc(solanaCfg.cluster || "devnet")}</div>
               </div>
               <div class="kv">
                 <div class="kv__k">verified by</div>
                 <div class="kv__v">${UI.esc(
                   claim.evidence.find((e) => e.key === "publish_proof" && e.passed)
                     ? "a proof string in a version you published"
                     : "npm's build attestation for a repository you control"
                 )}</div>
               </div>
             </div>
             <div data-review-detail></div>
             <div class="panel__foot">
               <button class="btn btn--sm btn--glass" type="button" data-review="${UI.esc(claim.name)}">show the derived address</button>
               <span class="panel__hint" data-review-hint></span>
             </div>`,
        false
      )
    );

    /* 6 — launch on Solana */
    parts.push(
      step(
        6,
        "launch on Solana",
        !reviewReady ? "locked" : "now",
        !reviewReady
          ? '<p class="panel__copy">complete the review first.</p>'
          : `<p class="panel__copy">
               registering writes one account: the package name, the verified
               publisher, the repository that was proved, and a hash of each
               release. It holds no funds and mints nothing.
             </p>
             ${
               solanaCfg.identityRegistration
                 ? `<div class="panel__foot">
                      <button class="btn btn--lg btn--ink" type="button" data-launch="${UI.esc(claim.name)}">launch on devnet</button>
                      <span class="panel__hint" data-launch-hint>your wallet will ask you to sign</span>
                    </div>
                    <p class="panel__note">
                      after you sign, this server checks the cluster itself
                      before the package is shown as onchain. The browser
                      reporting success is not enough.
                    </p>`
                 : `<div class="panel__foot">
                      <button class="btn btn--lg btn--ink" type="button" disabled>launch on devnet</button>
                      <span class="panel__hint">unavailable</span>
                    </div>
                    <p class="panel__note">
                      ${UI.esc(
                        solanaCfg.blocker ||
                          "the identity program has not been deployed to devnet"
                      )}. The button is disabled rather than failing when
                      pressed, and nothing has been sent to any cluster.
                    </p>`
             }`,
        false
      )
    );


    root.innerHTML = parts.join("");
    wireSearch($("[data-search]", root), { target: $("[data-results]", root), pick: true });
    wireConnectActions(root, me, cfg);
    root.classList.add("is-loaded");
    observeReveals(root);
    UI.wireCopy(root);
  }

  /* Clicking a result on the connect page selects that package rather than
     navigating away, so the flow is not lost. */
  document.addEventListener("click", (e) => {
    const card = e.target.closest("[data-connect] .pkg a[href^='/package.html']");
    if (!card) return;
    e.preventDefault();
    const url = new URL(card.getAttribute("href"), window.location.href);
    const picked = url.searchParams.get("p");
    if (picked) {
      window.location.href = `/connect.html?p=${encodeURIComponent(picked)}`;
    }
  });

  function wireConnectActions(root, me, cfg) {
    const reload = async () => {
      const fresh = await API.me({ fresh: true });
      renderConnect(root, fresh, cfg, UI.param("p") || "");
    };

    const signout = $("[data-signout]", root);
    if (signout) {
      signout.addEventListener("click", async () => {
        await API.signOut();
        UI.toast("signed out");
        window.location.href = "/connect.html";
      });
    }

    const importBtn = $("[data-import]", root);
    if (importBtn) {
      importBtn.addEventListener("click", async () => {
        const name = UI.param("p");
        if (!name) return;
        importBtn.disabled = true;
        const hint = $("[data-import-hint]", root);
        if (hint) hint.innerHTML = '<span class="spinner"></span> asking npm';
        try {
          await API.importPackage(name);
          UI.toast(`${name} imported`);
          await reload();
        } catch (err) {
          importBtn.disabled = false;
          if (hint) hint.textContent = err.message;
          UI.toast(err.message, "bad");
        }
      });
    }

    const unimport = $("[data-unimport]", root);
    if (unimport) {
      unimport.addEventListener("click", async () => {
        const name = unimport.dataset.unimport;
        unimport.disabled = true;
        try {
          await API.removeClaim(name);
          UI.toast("claim withdrawn");
          window.location.href = "/connect.html";
        } catch (err) {
          unimport.disabled = false;
          UI.toast(err.message, "bad");
        }
      });
    }

    const repoBtn = $("[data-verify-repo]", root);
    if (repoBtn) {
      repoBtn.addEventListener("click", async () => {
        const name = repoBtn.dataset.verifyRepo;
        const hint = $("[data-repo-hint]", root);
        repoBtn.disabled = true;
        if (hint) hint.innerHTML = '<span class="spinner"></span> asking GitHub and npm';
        try {
          const r = await API.verifyRepo(name);
          if (r.repoControl.ok) {
            UI.toast(
              r.trustedPublisher.ok
                ? "repository confirmed, and npm attests it published this package"
                : "repository confirmed. That alone is not publish authority."
            );
          } else {
            UI.toast(r.repoControl.hint || "GitHub does not report push access", "bad");
          }
          await reload();
        } catch (err) {
          repoBtn.disabled = false;
          if (hint) hint.textContent = err.message;
          UI.toast(err.message, "bad");
        }
      });
    }

    const proofBtn = $("[data-proof-start]", root);
    if (proofBtn) {
      proofBtn.addEventListener("click", async () => {
        const name = proofBtn.dataset.proofStart;
        const area = $("[data-proof-area]", root);
        proofBtn.disabled = true;
        try {
          const c = await API.publishChallenge(name);
          area.innerHTML = `
            <p class="panel__note" style="margin-top:18px">
              add either line to your package.json, publish a new version, then check.
              The string expires ${UI.esc(UI.ago(c.expiresAt).replace(" ago", " from now"))}.
            </p>
            ${UI.codeblock("proof-field", `"${c.field}": "${c.nonce}"`)}
            ${UI.codeblock("proof-keyword", `"keywords": ["${c.keyword}"]`)}
            <div class="panel__foot">
              <button class="btn btn--lg btn--ink" type="button" data-proof-check="${UI.esc(name)}">check the registry</button>
              <span class="panel__hint" data-proof-check-hint>only versions published after now are considered</span>
            </div>`;
          UI.wireCopy(area);
          const checkBtn = $("[data-proof-check]", area);
          checkBtn.addEventListener("click", async () => {
            const h = $("[data-proof-check-hint]", area);
            checkBtn.disabled = true;
            h.innerHTML = '<span class="spinner"></span> reading the registry';
            try {
              const r = await API.checkPublishProof(name);
              if (r.verified) {
                UI.toast(`verified: the proof string is in ${r.proof.version}`);
                await reload();
              } else {
                checkBtn.disabled = false;
                h.textContent = r.hint || "not found yet";
                UI.toast(r.hint || "the proof string is not published yet", "bad");
              }
            } catch (err) {
              checkBtn.disabled = false;
              h.textContent = err.message;
              UI.toast(err.message, "bad");
            }
          });
        } catch (err) {
          proofBtn.disabled = false;
          UI.toast(err.message, "bad");
        }
      });
    }

    const walletBtn = $("[data-wallet-connect]", root);
    if (walletBtn) walletBtn.addEventListener("click", () => connectWallet(walletBtn, reload));

    /* The review step asks the server what it would write. Deriving the
       address in the browser would be a second implementation of the seed
       scheme, and two implementations drift. */
    const reviewBtn = $("[data-review]", root);
    if (reviewBtn) {
      reviewBtn.addEventListener("click", async () => {
        const name = reviewBtn.dataset.review;
        const area = $("[data-review-detail]", root);
        const hint = $("[data-review-hint]", root);
        reviewBtn.disabled = true;
        if (hint) hint.innerHTML = '<span class="spinner"></span> deriving';
        try {
          const info = await API.identityFor(name);
          if (hint) hint.textContent = "";
          const derived = info.derived;
          const records = info.releaseRecords || [];
          area.innerHTML =
            (derived
              ? `<div class="kv" style="margin-top:12px">
                   <div class="kv__k">identity account, derived from the package name</div>
                   <div class="kv__v kv__v--mono">${UI.esc(derived.address)}</div>
                 </div>
                 <p class="panel__note">
                   the same address on every machine, computed from the name
                   alone. Nothing exists at it yet.
                 </p>`
              : `<p class="panel__note">
                   no address can be derived while the program is undeployed:
                   ${UI.esc(info.cluster.blocker || "the program id is not configured")}.
                 </p>`) +
            (records.length
              ? `<p class="panel__note">
                   ${UI.count(records.length)} release record${
                  records.length === 1 ? "" : "s"
                } would be committed, each a hash of the package name, version
                   and publish time.
                 </p>`
              : "");
        } catch (err) {
          reviewBtn.disabled = false;
          if (hint) hint.textContent = err.message;
          UI.toast(err.message, "bad");
        }
      });
    }

    /* Launch is only wired when the program is deployed; until then the
       button is rendered disabled rather than present and failing. */
    const launchBtn = $("[data-launch]", root);
    if (launchBtn) {
      launchBtn.addEventListener("click", () => launchIdentity(launchBtn, reload));
    }
  }

  /* ---------------------------------------------------------- launching -- */

  /* The three-call lifecycle, client side.

     prepare -> sign in the wallet -> report the signature -> ask the server
     to reconcile. The last step is the one that matters: this function never
     tells the user the package is onchain, it asks the server, which asks the
     cluster. */
  async function launchIdentity(button, afterwards) {
    button.disabled = true;
    const hint = $("[data-launch-hint]");
    const say = (text) => {
      if (hint) hint.innerHTML = `<span class="spinner"></span> ${UI.esc(text)}`;
    };

    try {
      const name = button.dataset.launch;
      say("preparing");
      const prepared = await API.prepareIdentity(name);

      if (!prepared.prepared) {
        // The server refused, and its reason is the useful part.
        const blocker = prepared.blocker || "registration is not available";
        if (hint) hint.textContent = blocker;
        UI.toast(blocker, "bad");
        button.disabled = false;
        return;
      }

      /* Building and signing the transaction needs the program's instruction
         layout, which only exists once it is deployed. The server only
         returns prepared: true when the program is live, so reaching here
         without a builder is a configuration error rather than a user error,
         and it says so instead of pretending to send something. */
      if (typeof window.PackagesTransaction !== "function") {
        const message =
          "the transaction builder is not bundled in this build, so nothing was sent";
        if (hint) hint.textContent = message;
        UI.toast(message, "bad");
        button.disabled = false;
        return;
      }

      say("waiting for your wallet");
      const signature = await window.PackagesTransaction(prepared);

      say("recording the signature");
      await API.reportSubmitted(name, signature);

      say("checking the cluster");
      const result = await API.reconcileIdentity(name);

      if (result.onchain) {
        UI.toast("identity registered, and confirmed on devnet");
        if (afterwards) await afterwards();
      } else {
        const message = `not confirmed: ${result.reason || result.status}`;
        if (hint) hint.textContent = message;
        UI.toast(message, "bad");
        button.disabled = false;
      }
    } catch (err) {
      button.disabled = false;
      const message =
        err && /reject|denied|cancel/i.test(err.message || "")
          ? "wallet request declined, nothing was sent"
          : (err && err.message) || "could not register the identity";
      if (hint) hint.textContent = message;
      UI.toast(message, "bad");
    }
  }

  /* ----------------------------------------------------- wallet signing -- */

  /* Finds an injected wallet, asks it to sign the exact message the server
     issued, and sends the signature back. No transaction is built and the
     wallet is never asked to approve one. */
  async function connectWallet(button, afterwards) {
    const provider =
      (window.solana && window.solana.isPhantom && window.solana) ||
      window.solflare ||
      window.backpack ||
      window.solana;

    if (!provider || typeof provider.connect !== "function") {
      UI.toast("no Solana wallet found in this browser", "bad");
      return;
    }

    button.disabled = true;
    try {
      const connection = await provider.connect();
      const pubkey = String(
        (connection && connection.publicKey) || provider.publicKey || ""
      );
      if (!pubkey) throw new Error("the wallet did not return a public key");

      const challenge = await API.walletChallenge();
      if (typeof provider.signMessage !== "function") {
        throw new Error("this wallet cannot sign a message");
      }
      const encoded = new TextEncoder().encode(challenge.message);
      const signed = await provider.signMessage(encoded, "utf8");
      const raw = signed && signed.signature ? signed.signature : signed;
      const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      let binary = "";
      bytes.forEach((b) => {
        binary += String.fromCharCode(b);
      });

      await API.confirmWallet({
        pubkey,
        signature: window.btoa(binary),
        message: challenge.message,
      });
      UI.toast("wallet proved. No transaction was sent.");
      if (afterwards) await afterwards();
    } catch (err) {
      button.disabled = false;
      // A user closing the wallet prompt is a decision, not a failure.
      const message =
        err && /reject|denied|cancel/i.test(err.message || "")
          ? "wallet request declined"
          : (err && err.message) || "could not prove the wallet";
      UI.toast(message, "bad");
    }
  }

  /* ====================================================== page: dashboard */

  // Release history arrives with the dashboard payload and is read by the
  // disclosure handler below rather than fetched again.
  let dashboardReleases = {};

  async function pageDashboard() {
    const root = $("[data-dashboard]");
    if (!root) return;
    root.innerHTML = '<div class="skeleton skeleton--card"></div>';

    const [me, cfg, identity] = await Promise.all([
      API.me({ fresh: true }),
      API.config(),
      API.identityStatus().catch(() => null),
    ]);

    if (!me || !me.signedIn) {
      root.innerHTML = UI.empty(
        "you are not signed in",
        me && me.signInConfigured === false
          ? "GitHub sign-in is not configured on this server, so there is no dashboard to show."
          : "sign in to see the packages you have claimed.",
        me && me.signInConfigured === false
          ? '<a class="btn btn--sm btn--glass" href="/explore.html">browse packages</a>'
          : `<button class="btn btn--sm btn--ink" type="button" data-signin>sign in</button>`
      );
      root.classList.add("is-loaded");
      observeReveals(root);
      return;
    }

    dashboardReleases = me.releases || {};
    const u = me.user;
    const verified = u.packages.filter((p) => p.verified);
    const solanaCfg = (cfg && cfg.solana) || {};

    root.innerHTML = `
      <div class="profile" data-reveal>
        ${UI.avatar(u.login, u.avatarUrl, "avatar-img--lg")}
        <div class="profile__id">
          <h1 class="profile__name">${UI.esc(u.name || u.login)}</h1>
          <p class="profile__handle">@${UI.esc(u.login)}</p>
          <p class="profile__line">${UI.count(u.packages.length)} claimed &middot; ${UI.count(verified.length)} verified</p>
        </div>
        <div class="profile__actions">
          <a class="btn btn--sm btn--ink" href="/connect.html">launch a package</a>
          <button class="btn btn--sm btn--glass" type="button" data-signout>sign out</button>
        </div>
      </div>

      <div class="stat-grid" data-reveal>
        <div class="stat-card">
          <div class="stat-card__k">github</div>
          <div class="stat-card__v stat-card__v--sm">connected</div>
          <div class="stat-card__n">read-only, revocable in your GitHub settings</div>
        </div>
        <div class="stat-card">
          <div class="stat-card__k">packages claimed</div>
          <div class="stat-card__v">${UI.count(u.packages.length)}</div>
          <div class="stat-card__n">a claim is not a verification</div>
        </div>
        <div class="stat-card">
          <div class="stat-card__k">verified</div>
          <div class="stat-card__v">${UI.count(verified.length)}</div>
          <div class="stat-card__n">publish authority proved</div>
        </div>
        <div class="stat-card">
          <div class="stat-card__k">wallets</div>
          <div class="stat-card__v">${UI.count(u.wallets.length)}</div>
          <div class="stat-card__n">${UI.esc(solanaCfg.cluster || "devnet")}, signature only</div>
        </div>
      </div>

      ${
        u.packages.length
          ? u.packages
              .map(
                (c) => `<div class="panel" data-reveal>
            <div class="panel__head">
              <div>
                <div class="eyebrow">${UI.esc(c.repo ? `${c.repo.owner}/${c.repo.repo}` : "no repository declared")}</div>
                <h2 class="panel__title">${UI.esc(c.name)}</h2>
              </div>
              ${UI.statusChip(c.status)}
            </div>
            <p class="panel__copy">${UI.esc(c.description || "no description on npm")}</p>
            ${
              c.lifecycle
                ? `<p class="panel__note">
                     <b>${UI.esc(c.lifecycle.state.toLowerCase().replace(/_/g, " "))}</b>:
                     ${UI.esc(c.lifecycle.description)}${
                    c.lifecycle.next ? ` Next: ${UI.esc(c.lifecycle.next.label)}.` : ""
                  }
                   </p>`
                : ""
            }
            <div class="evidence">${c.evidence.map(UI.evidenceRow).join("")}</div>
            ${c.nextStep ? `<p class="panel__note">next: ${UI.esc(c.nextStep)}</p>` : ""}
            <div class="panel__foot">
              <a class="btn btn--sm btn--glass" href="/package.html?p=${encodeURIComponent(c.name)}">public page</a>
              <button class="btn btn--sm btn--glass" type="button" data-refresh="${UI.esc(c.name)}">refresh data</button>
              ${
                c.verified
                  ? `<button class="btn btn--sm btn--glass" type="button" data-revoke="${UI.esc(c.name)}">revoke verification</button>`
                  : ""
              }
              ${
                (me.releases && me.releases[c.name] && me.releases[c.name].length) || 0
                  ? `<button class="btn btn--sm btn--glass" type="button" data-releases="${UI.esc(c.name)}">
                       ${UI.count(me.releases[c.name].length)} release${
                      me.releases[c.name].length === 1 ? "" : "s"
                    }
                     </button>`
                  : ""
              }
              <a class="btn btn--sm btn--ink" href="/connect.html?p=${encodeURIComponent(c.name)}">continue</a>
              ${
                c.verified
                  ? `<button class="btn btn--sm btn--glass" type="button" data-register="${UI.esc(c.name)}">register identity</button>`
                  : ""
              }
              <span class="panel__hint" data-register-hint="${UI.esc(c.name)}">${
                  c.verified && !solanaCfg.identityRegistration
                    ? "identity registration is awaiting the devnet deployment"
                    : ""
                }</span>
            </div>
            <div data-release-list="${UI.esc(c.name)}" hidden></div>
          </div>`
              )
              .join("")
          : UI.empty(
              "no packages claimed",
              "import a package you publish, then prove you can publish it.",
              '<a class="btn btn--sm btn--ink" href="/connect.html">launch a package</a>'
            )
      }

      <div class="panel" data-reveal>
        <div class="panel__head">
          <div>
            <div class="eyebrow">optional</div>
            <h2 class="panel__title">Solana wallet</h2>
          </div>
          ${
            u.wallets.length
              ? '<span class="status-chip status-chip--ok">proved</span>'
              : '<span class="status-chip status-chip--off">not connected</span>'
          }
        </div>
        <p class="panel__copy">
          prove a wallet is yours by signing a short message. It is a signature,
          not a transaction: nothing is sent and no funds move.
        </p>
        ${
          u.wallets.length
            ? `<div class="kv-grid kv-grid--stack">${u.wallets
                .map(
                  (w) => `<div class="kv">
                    <div class="kv__k">${UI.esc(w.cluster)} &middot; proved ${UI.ago(w.verifiedAt)}</div>
                    <div class="kv__v kv__v--mono">${UI.esc(w.pubkey)}</div>
                  </div>`
                )
                .join("")}</div>
               <div class="panel__foot">
                 <button class="btn btn--sm btn--glass" type="button" data-wallet-remove="${UI.esc(u.wallets[0].pubkey)}">remove</button>
               </div>`
            : `<div class="panel__foot">
                 <button class="btn btn--sm btn--ink" type="button" data-wallet-connect>connect a wallet</button>
                 <span class="panel__hint" data-wallet-hint>Phantom, Solflare or any wallet that signs a message</span>
               </div>`
        }
      </div>

      <div class="panel panel--quiet" data-reveal>
        <h2 class="panel__title">onchain state</h2>
        <div class="kv-grid kv-grid--stack">
          <div class="kv"><div class="kv__k">cluster</div><div class="kv__v">${UI.esc(solanaCfg.cluster || "devnet")}</div></div>
          <div class="kv"><div class="kv__k">identity program</div><div class="kv__v">${
            solanaCfg.programDeployed ? "deployed" : "not deployed"
          }</div></div>
          <div class="kv"><div class="kv__k">wallet proof</div><div class="kv__v">working</div></div>
          <div class="kv"><div class="kv__k">identity registration</div><div class="kv__v">${
            solanaCfg.identityRegistration ? "available" : "awaiting deployment"
          }</div></div>
        </div>
        ${
          identity && identity.blocker
            ? `<p class="panel__note">${UI.esc(identity.blocker)}</p>`
            : ""
        }
      </div>

      <div class="panel panel--quiet" data-reveal>
        <div class="panel__head">
          <div>
            <div class="eyebrow">your data</div>
            <h2 class="panel__title">disconnect</h2>
          </div>
        </div>
        <p class="panel__copy">
          signing out ends this session on this server. Revoking the
          authorisation in your GitHub settings stops us receiving anything at
          all, immediately.
        </p>
        <div class="panel__foot">
          <button class="btn btn--sm btn--glass" type="button" data-signout>sign out</button>
          <a class="btn btn--sm btn--glass" href="https://github.com/settings/applications" rel="noopener noreferrer" target="_blank">revoke on GitHub</a>
        </div>
      </div>`;

    wireDashboard(root);
    root.classList.add("is-loaded");
    observeReveals(root);
  }

  function wireDashboard(root) {
    /* Refresh re-reads npm and GitHub for one package. Owner only, and the
       result says what was refreshed and what failed rather than claiming
       success either way. */
    $$("[data-refresh]", root).forEach((btn) =>
      btn.addEventListener("click", async () => {
        const name = btn.dataset.refresh;
        const original = btn.textContent;
        btn.disabled = true;
        btn.textContent = "refreshing";
        try {
          const result = await API.refreshPackage(name);
          const did = (result.refreshed || []).length;
          const failed = (result.failed || []).length;
          if (did && !failed) {
            UI.toast(`${name}: refreshed ${result.refreshed.join(", ")}`);
          } else if (did) {
            UI.toast(`${name}: refreshed ${did}, ${failed} unavailable`, "bad");
          } else {
            // A failure leaves the old data in place, and says so.
            UI.toast(result.reason || `${name}: nothing could be refreshed`, "bad");
          }
          await pageDashboard();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = original;
          UI.toast(err.message, "bad");
        }
      })
    );

    /* Revoking is destructive to a claim and keeps the history, so it asks
       first and says exactly what will happen. */
    $$("[data-revoke]", root).forEach((btn) =>
      btn.addEventListener("click", async () => {
        const name = btn.dataset.revoke;
        const sure = window.confirm(
          `Revoke your verification of ${name}?\n\n` +
            "The package is released for anyone else to prove. Your proof stays " +
            "in the public record: revoking is recorded, not erased.\n\n" +
            "If the package is already registered onchain, that account is not " +
            "removed; nothing here can un-write the chain."
        );
        if (!sure) return;
        btn.disabled = true;
        try {
          await API.removeClaim(name);
          UI.toast(`${name}: verification revoked`);
          await pageDashboard();
        } catch (err) {
          btn.disabled = false;
          UI.toast(err.message, "bad");
        }
      })
    );

    /* Release history, expanded in place. The data already arrived with the
       dashboard, so this is a disclosure rather than another request. */
    $$("[data-releases]", root).forEach((btn) => {
      btn.addEventListener("click", () => {
        const name = btn.dataset.releases;
        const list = $(`[data-release-list="${CSS.escape(name)}"]`, root);
        if (!list) return;
        if (!list.hidden) {
          list.hidden = true;
          return;
        }
        const rows = (dashboardReleases[name] || []).map(
          (r) => `<div class="vrow">
              <span class="vrow__v"><b>${UI.esc(r.version)}</b></span>
              <span class="vrow__when" title="${UI.esc(r.publishedAt || "")}">${UI.ago(r.publishedAt)}</span>
              <span class="vrow__hash">${
                r.onchainTx
                  ? `onchain ${UI.esc(r.onchainTx)}`
                  : `record ${UI.esc((r.recordHash || "").slice(0, 32))} &middot; not yet onchain`
              }</span>
            </div>`
        );
        list.innerHTML = rows.length
          ? `<div class="vlist">${rows.join("")}</div>
             <p class="panel__note">
               the five most recent published versions. Each hash commits to the
               package name, version and publish time, and is what an onchain
               release record would store.
             </p>`
          : '<p class="panel__note">no releases recorded yet.</p>';
        list.hidden = false;
      });
    });

    $$("[data-signout]", root).forEach((btn) =>
      btn.addEventListener("click", async () => {
        await API.signOut();
        window.location.href = "/index.html";
      })
    );

    const walletBtn = $("[data-wallet-connect]", root);
    if (walletBtn) {
      walletBtn.addEventListener("click", () => connectWallet(walletBtn, pageDashboard));
    }

    const removeBtn = $("[data-wallet-remove]", root);
    if (removeBtn) {
      removeBtn.addEventListener("click", async () => {
        removeBtn.disabled = true;
        try {
          await API.removeWallet(removeBtn.dataset.walletRemove);
          UI.toast("wallet removed");
          pageDashboard();
        } catch (err) {
          removeBtn.disabled = false;
          UI.toast(err.message, "bad");
        }
      });
    }

    $$("[data-register]", root).forEach((btn) =>
      btn.addEventListener("click", async () => {
        const name = btn.dataset.register;
        const hint = $(`[data-register-hint="${name}"]`, root);
        btn.disabled = true;
        try {
          await API.registerIdentity(name);
          UI.toast("identity registered");
          pageDashboard();
        } catch (err) {
          btn.disabled = false;
          // The server returns the blocker in the body for a deliberate
          // "not yet", and that is the sentence worth showing.
          const blocker =
            (err.payload && err.payload.blocker) || err.message || "not available";
          if (hint) hint.textContent = blocker;
          UI.toast(blocker, "bad");
        }
      })
    );
  }

  /* ======================================================= page: how it   */

  async function pageHow() {
    const cfg = await API.config();
    const slot = $("[data-proof-example]");
    if (slot && cfg && cfg.proof) {
      slot.innerHTML = UI.codeblock(
        "how-proof",
        `"${cfg.proof.field}": "a1b2c3d4e5f6"`
      );
      UI.wireCopy(slot);
    }
    const state = $("[data-onchain-state]");
    if (state && cfg && cfg.solana) {
      state.textContent = cfg.solana.identityRegistration
        ? `the identity program is deployed to ${cfg.solana.cluster}.`
        : cfg.solana.blocker || "the identity program is not deployed yet.";
    }
  }

  /* ============================================================== router */

  const PAGES = {
    index: pageIndex,
    explore: pageExplore,
    package: pagePackage,
    connect: pageConnect,
    activity: pageActivity,
    dashboard: pageDashboard,
    creator: pageCreator,
    "how-it-works": pageHow,
  };

  function currentPage() {
    // /p/<name> is the canonical package url and is rewritten to package.html
    // by the server, so the path says "p" rather than the file name.
    if (/^\/p\//.test(window.location.pathname)) return "package";
    const file = window.location.pathname.split("/").pop() || "index.html";
    return file.replace(/\.html$/, "") || "index";
  }

  const page = currentPage();

  paintChrome().catch(() => {
    /* the chrome stays in its signed-out state, which is correct */
  });

  const controller = PAGES[page];
  if (controller) {
    controller().catch((err) => {
      // A controller that throws must not leave a page full of skeletons.
      console.error("[packages]", err);
      $$("[data-featured],[data-results],[data-package],[data-feed],[data-dashboard],[data-developer],[data-connect]").forEach(
        (el) => {
          if (el.querySelector(".skeleton")) {
            el.innerHTML = UI.errorBox(err, "this page");
            observeReveals(el);
          }
        }
      );
    });
  }
})();
