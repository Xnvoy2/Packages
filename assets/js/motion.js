/* The motion system.

   One owner for everything that moves. GSAP drives it, ScrollTrigger drives
   anything tied to scroll position, Flip drives the one layout resolution,
   and Lenis provides the single smooth-scroll implementation.

   Three rules this file holds to:

     1. **Motion communicates, or it does not exist.** Every effect here says
        something: a heading arriving, an interface assembling in the order a
        user would actually use it, a sequence resolving as it is explained.
        Nothing loops, nothing floats, nothing is decorative.

     2. **The design is not negotiable.** No layout changes, no font-size
        animation, no scaling typography toward the camera. Composition
        resolves; type stays the size it was set at.

     3. **It degrades to the design.** Under prefers-reduced-motion, or if
        this file never loads, every element is in its final state. The
        animated state is only ever applied by script, so there is no way to
        be left with something invisible.

   Loaded after api.js and ui.js, before app.js, so app.js can hand it newly
   rendered content. */

(function () {
  "use strict";

  const root = document.documentElement;

  /* Reduced motion is decided once and re-decided if the user changes it,
     which people do mid-session when something makes them queasy. */
  const motionQuery =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)");
  let reduced = Boolean(motionQuery && motionQuery.matches);

  const hasGsap = typeof window.gsap !== "undefined";
  const gsap = window.gsap;
  const ScrollTrigger = window.ScrollTrigger;
  const Flip = window.Flip;

  /* Without the library, or with reduced motion, everything is simply shown.
     The fallback is the finished design, not a degraded version of it. */
  function showEverything(scope) {
    const container = scope || document;
    container.querySelectorAll("[data-reveal]").forEach((el) => {
      el.classList.add("is-in");
      el.style.opacity = "";
      el.style.transform = "";
    });
    container.querySelectorAll(".word__in").forEach((el) => {
      el.style.transform = "none";
    });
    container.querySelectorAll("[data-fill]").forEach((el) => {
      el.style.width = el.dataset.fill;
    });
  }

  if (!hasGsap) {
    root.classList.add("motion-off");
    showEverything(document);
    window.Motion = {
      available: false,
      reduced,
      register: showEverything,
      refresh() {},
    };
    return;
  }

  gsap.registerPlugin(ScrollTrigger, Flip);

  /* Tells the stylesheet that script owns these properties now, so the CSS
     transitions that exist as a no-script fallback stand down rather than
     fighting GSAP for the same transform. */
  root.classList.add("motion-js");

  /* The house curve. Crisp rather than bouncy: things arrive and stop. */
  const EASE = "power4.out";
  const EASE_SOFT = "power3.out";

  gsap.defaults({ ease: EASE_SOFT, duration: 0.6 });

  /* ------------------------------------------------------ smooth scroll -- */

  /* One smooth-scroll implementation, and only on devices with a pointer.
     Touch scrolling is already smooth and momentum-driven; overriding it
     makes a phone feel worse, not better. */
  let lenis = null;

  function initSmoothScroll() {
    if (reduced) return;
    if (typeof window.Lenis !== "function") return;
    // Touch devices keep their native scrolling.
    if (!window.matchMedia("(pointer: fine)").matches) return;

    lenis = new window.Lenis({
      duration: 0.9,
      // Gentle: a long tail feels like lag rather than smoothness.
      easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      smoothWheel: true,
      // Never hijack touch.
      syncTouch: false,
    });

    // One ticker drives both, so scroll position and animation never disagree.
    lenis.on("scroll", ScrollTrigger.update);
    gsap.ticker.add((time) => lenis.raf(time * 1000));
    gsap.ticker.lagSmoothing(0);
    root.classList.add("lenis-on");
  }

  /* --------------------------------------------------- masked headlines -- */

  /* Split a heading into words, each in its own overflow-hidden box.

     Only ever applied to the elements asked for, never to every heading: the
     effect means "this is the thing to read first", and applying it
     everywhere means it says nothing. */
  function splitWords(el) {
    if (!el || el.dataset.split === "done") return [];
    const lines = Array.from(el.children).filter((c) => c.tagName === "SPAN");
    const targets = lines.length ? lines : [el];
    const inners = [];

    for (const line of targets) {
      const text = line.textContent.trim();
      if (!text) continue;
      const words = text.split(/\s+/);
      line.textContent = "";
      words.forEach((word, i) => {
        const mask = document.createElement("span");
        mask.className = "word";
        const inner = document.createElement("span");
        inner.className = "word__in";
        inner.textContent = word;
        mask.appendChild(inner);
        line.appendChild(mask);
        if (i < words.length - 1) line.appendChild(document.createTextNode(" "));
        inners.push(inner);
      });
    }
    el.dataset.split = "done";
    return inners;
  }

  /* The reveal itself: up from below the mask, with a touch of rotation that
     straightens as it lands, so it reads as paper settling rather than a
     slide. */
  function revealWords(inners, options) {
    const opts = options || {};
    return gsap.fromTo(
      inners,
      { yPercent: 110, rotate: 3 },
      {
        yPercent: 0,
        rotate: 0,
        duration: 0.7,
        stagger: 0.055,
        ease: EASE,
        delay: opts.delay || 0,
        ...(opts.scrollTrigger ? { scrollTrigger: opts.scrollTrigger } : {}),
      }
    );
  }

  /* ---------------------------------------------------------- reveals --- */

  /* The workhorse. Deliberately small: 18px and a short fade, so a section
     arriving is felt rather than watched. Siblings stagger by document order.

     This is the one effect that is applied broadly, and it is kept
     understated for exactly that reason. */
  function registerReveals(scope) {
    const container = scope || document;
    const items = Array.from(container.querySelectorAll("[data-reveal]")).filter(
      (el) => !el.dataset.revealed
    );
    if (!items.length) return;

    if (reduced) {
      showEverything(container);
      items.forEach((el) => (el.dataset.revealed = "1"));
      return;
    }

    // Group by parent so a row of cards staggers together.
    const groups = new Map();
    for (const el of items) {
      el.dataset.revealed = "1";
      const parent = el.parentElement || document.body;
      if (!groups.has(parent)) groups.set(parent, []);
      groups.get(parent).push(el);
    }

    for (const [, group] of groups) {
      gsap.set(group, { opacity: 0, y: 18 });
      gsap.to(group, {
        opacity: 1,
        y: 0,
        duration: 0.55,
        stagger: 0.06,
        ease: EASE_SOFT,
        scrollTrigger: {
          trigger: group[0],
          // Fires when the element is genuinely on screen, not before.
          start: "top 88%",
          once: true,
        },
        onComplete() {
          // Hand the element back to the stylesheet once it has arrived, so
          // nothing is left with an inline transform that could fight a
          // later layout change.
          gsap.set(group, { clearProps: "transform" });
          group.forEach((el) => el.classList.add("is-in"));
        },
      });
    }
  }

  /* ------------------------------------------------------- the UI pop --- */

  /* 0.92 -> 1.02 -> 1, fast. Used where something has just been produced by
     an action, so it reads as a result rather than as decoration. */
  function pop(elements, options) {
    if (reduced || !elements || !elements.length) return;
    const opts = options || {};
    gsap.fromTo(
      elements,
      { scale: 0.92, opacity: 0 },
      {
        keyframes: [
          { scale: 1.02, opacity: 1, duration: 0.18, ease: "power2.out" },
          { scale: 1, duration: 0.12, ease: "power2.inOut" },
        ],
        stagger: opts.stagger === undefined ? 0.035 : opts.stagger,
        delay: opts.delay || 0,
        clearProps: "transform",
      }
    );
  }

  /* -------------------------------------------- the hero: UI assembly --- */

  /* The hero's floating panels are a product preview. The container holds
     still and the interface inside it assembles, in the order someone would
     actually meet it: the package, then its versions, then the code, then
     the people, then the proof, then the chain.

     The existing drift loop keeps running underneath; this only animates
     clip-path, opacity and the rows inside, so the two never contend for a
     transform. */
  function heroAssembly() {
    const world = document.querySelector(".world");
    if (!world) return;

    const order = ["profile", "tiers", "posts", "community", "events", "wallet"];
    const panels = order
      .map((slot) => world.querySelector(`[data-slot="${slot}"]`))
      .filter(Boolean);
    const ghosts = Array.from(world.querySelectorAll(".world__ghost"));

    if (reduced) {
      gsap.set([...panels, ...ghosts], { clearProps: "all" });
      return;
    }

    // The CSS entrance is disabled under .motion-js, so this owns it.
    const tl = gsap.timeline({ delay: 0.15 });

    tl.fromTo(
      panels,
      { clipPath: "inset(0 0 100% 0)", filter: "blur(4px)" },
      {
        clipPath: "inset(0 0 0% 0)",
        filter: "blur(0px)",
        duration: 0.5,
        stagger: 0.08,
        ease: EASE_SOFT,
      }
    );

    // Then the rows inside each panel, so the interface populates rather
    // than appearing complete.
    panels.forEach((panel, i) => {
      const rows = panel.querySelectorAll(".world__row, .world__code-line");
      if (!rows.length) return;
      tl.fromTo(
        rows,
        { opacity: 0, x: -6 },
        { opacity: 1, x: 0, duration: 0.3, stagger: 0.045, ease: "power2.out", clearProps: "all" },
        0.3 + i * 0.08
      );
    });

    // The two confirmations last: they are the result of everything above.
    if (ghosts.length) {
      tl.fromTo(ghosts, { opacity: 0 }, { opacity: 1, duration: 0.5, stagger: 0.12 }, "-=0.3");
    }
  }

  /* -------------------------------------------------- the hero: entry --- */

  function heroEntrance() {
    const title = document.querySelector(".hero__title");
    const supporting = [
      ".hero__sub",
      ".hero__cta",
      ".hero__status",
      ".hero__graph",
    ]
      .map((s) => document.querySelector(s))
      .filter(Boolean);

    if (reduced) {
      if (title) title.style.visibility = "";
      gsap.set(supporting, { clearProps: "all" });
      return;
    }

    const tl = gsap.timeline();

    if (title) {
      const words = splitWords(title);
      if (words.length) {
        gsap.set(words, { yPercent: 110, rotate: 3 });
        tl.to(words, {
          yPercent: 0,
          rotate: 0,
          duration: 0.7,
          stagger: 0.055,
          ease: EASE,
        });
      }
    }

    if (supporting.length) {
      gsap.set(supporting, { opacity: 0, y: 14 });
      tl.to(
        supporting,
        { opacity: 1, y: 0, duration: 0.5, stagger: 0.07, ease: EASE_SOFT, clearProps: "transform" },
        "-=0.45"
      );
    }

    heroAssembly();
  }

  /* ------------------------------------------ scroll-scrubbed headings -- */

  /* The composition-resolving moment. A heading starts very slightly skewed,
     rotated and offset, and resolves into exact alignment as it is scrolled
     through. Font size never changes; what resolves is the composition.

     Used on at most two headings per page, both of which introduce a
     section that explains something. */
  function scrubbedHeadings() {
    if (reduced) return;

    const headings = document.querySelectorAll("[data-scrub-heading]");
    headings.forEach((heading) => {
      const words = splitWords(heading);
      const targets = words.length ? words : [heading];

      gsap.fromTo(
        targets,
        { yPercent: 40, rotate: 2.5, skewY: 2.5, opacity: 0.25 },
        {
          yPercent: 0,
          rotate: 0,
          skewY: 0,
          opacity: 1,
          ease: "none",
          stagger: 0.04,
          scrollTrigger: {
            trigger: heading,
            start: "top 85%",
            end: "top 45%",
            // Tied to scroll position, so scrolling back un-resolves it.
            scrub: 0.6,
          },
        }
      );
    });
  }

  /* ------------------------------------------- pinned scroll sequence --- */

  /* The lifecycle strip, pinned, with the sequence driven directly by scroll
     progress: setup, action, process, result, settle. Scrolling backwards
     reverses it exactly, because everything is scrubbed rather than fired.

     Only on the two pages where this strip is the main explanation, and only
     at widths where pinning does not eat the whole screen. */
  function pinnedLifecycle() {
    const strip = document.querySelector("[data-lifecycle]");
    if (!strip || reduced) return;

    const fill = strip.querySelector(".lifecycle__fill");
    const bead = strip.querySelector(".lifecycle__bead");
    const steps = Array.from(strip.querySelectorAll(".lifecycle__step"));
    if (!fill || !bead || !steps.length) return;

    /* matchMedia so the pin exists only where there is room for it, and is
       cleanly reverted at other sizes rather than left half-applied. */
    ScrollTrigger.matchMedia({
      "(min-width: 768px)": function () {
        const tl = gsap.timeline({
          scrollTrigger: {
            trigger: strip,
            start: "center 62%",
            // A restrained pin: long enough to read, not a hostage situation.
            end: "+=" + Math.min(900, steps.length * 150),
            pin: true,
            pinSpacing: true,
            scrub: 0.5,
            anticipatePin: 1,
            invalidateOnRefresh: true,
          },
        });

        tl.fromTo(fill, { width: "0%" }, { width: "100%", ease: "none" }, 0);
        tl.fromTo(bead, { left: "0%", opacity: 0 }, { opacity: 1, duration: 0.02 }, 0);
        tl.fromTo(bead, { left: "0%" }, { left: "100%", ease: "none" }, 0);

        // Each step resolves as the bead reaches it.
        steps.forEach((step, i) => {
          const at = i / steps.length;
          tl.fromTo(
            step,
            { opacity: 0.25, y: 10 },
            { opacity: 1, y: 0, duration: 0.18, ease: "power2.out" },
            at
          );
        });

        return () => {
          // matchMedia cleanup: put everything back exactly as the CSS has it.
          gsap.set([fill, bead, ...steps], { clearProps: "all" });
        };
      },

      /* Below the pin breakpoint the same sequence runs un-pinned, driven by
         the section's own scroll progress. The story is the same; it just
         does not take the viewport hostage on a phone. */
      "(max-width: 767px)": function () {
        const tl = gsap.timeline({
          scrollTrigger: {
            trigger: strip,
            start: "top 80%",
            end: "bottom 60%",
            scrub: 0.5,
          },
        });
        tl.fromTo(fill, { width: "0%" }, { width: "100%", ease: "none" }, 0);
        tl.fromTo(bead, { left: "0%", opacity: 1 }, { left: "100%", ease: "none" }, 0);
        steps.forEach((step, i) => {
          tl.fromTo(
            step,
            { opacity: 0.3, y: 8 },
            { opacity: 1, y: 0, duration: 0.2 },
            i / steps.length
          );
        });
        return () => gsap.set([fill, bead, ...steps], { clearProps: "all" });
      },
    });
  }

  /* --------------------------------------------- scatter into position -- */

  /* A card grid resolves from a loose composition into its exact layout.
     Flip measures the real final positions, so this is the true layout
     settling rather than an approximation of it.

     Displacement is small and deterministic, alternating by index, so it
     reads as designed rather than scattered at random. */
  function organiseGrid(grid) {
    if (!grid || reduced) return;
    const cards = Array.from(grid.children).filter((c) => c.nodeType === 1);
    if (cards.length < 2) return;

    /* This takes the cards over from the general reveal. Without claiming
       them, both systems animate the same elements and whichever sets the
       start state last wins, which leaves cards stuck at opacity 0. */
    cards.forEach((card) => {
      card.dataset.revealed = "1";
      gsap.killTweensOf(card);
    });

    /* Flip measures the real resting layout first, so what follows resolves
       into the positions the grid actually has, rather than into an
       approximation of them. */
    const state = Flip.getState(cards);

    /* Loose, but deterministic: alternating by index reads as composition
       rather than as scatter.

       Deliberately vertical only. Horizontal displacement on a full-width
       grid makes it momentarily wider than its container, which shows up as
       a transient horizontal scrollbar on narrow viewports. The depth comes
       from the stagger and the slight rotation instead. */
    cards.forEach((card, i) => {
      const side = i % 2 === 0 ? -1 : 1;
      gsap.set(card, {
        y: 24 + Math.abs(side) * 4,
        rotate: side * 0.5,
        transformOrigin: "50% 100%",
        opacity: 0,
      });
    });

    const settle = () => {
      Flip.from(state, { duration: 0.01, absolute: false });
      gsap.to(cards, {
        y: 0,
        rotate: 0,
        opacity: 1,
        duration: 0.65,
        stagger: 0.05,
        ease: EASE,
        // Hand every property back once it has landed, so a later resize or
        // re-render is never fighting an inline transform.
        clearProps: "transform,opacity",
        onComplete() {
          cards.forEach((card) => card.classList.add("is-in"));
        },
      });
    };

    const rect = grid.getBoundingClientRect();
    if (rect.top < window.innerHeight * 0.95) {
      // Already on screen: resolve now rather than waiting for a scroll that
      // may never come.
      settle();
      return;
    }

    ScrollTrigger.create({
      trigger: grid,
      start: "top 88%",
      once: true,
      onEnter: settle,
    });
  }

  /* ----------------------------------------------- section continuity --- */

  /* The curved seam. One real path, whose geometry is animated as the
     boundary is scrolled through, so the curve genuinely deforms rather than
     a huge ellipse sliding past.

     Used once, between the explanation and what it produces. */
  function curvedSeam() {
    const seams = document.querySelectorAll("[data-seam]");
    if (!seams.length || reduced) return;

    seams.forEach((seam) => {
      const path = seam.querySelector("path");
      if (!path) return;

      // Flat, bowed, flat. The control points are what move.
      const flat = "M0,40 C240,40 480,40 720,40 C960,40 1200,40 1440,40 L1440,80 L0,80 Z";
      const bowed = "M0,40 C240,4 480,76 720,40 C960,4 1200,76 1440,40 L1440,80 L0,80 Z";

      gsap.fromTo(
        path,
        { attr: { d: bowed } },
        {
          attr: { d: flat },
          ease: "none",
          scrollTrigger: {
            trigger: seam,
            start: "top bottom",
            end: "bottom top",
            scrub: 0.8,
          },
        }
      );
    });
  }

  /* ------------------------------------------------ micro-interactions -- */

  /* Fast and tactile, and only on the pointer: a press state that lingers on
     touch feels broken. Everything here is 120ms or less. */
  function microInteractions() {
    if (reduced) return;
    if (!window.matchMedia("(pointer: fine)").matches) return;

    // Delegated, so it covers content rendered after load.
    document.addEventListener(
      "pointerenter",
      (e) => {
        const target = e.target;
        if (!target || !target.closest) return;
        const btn = target.closest(".btn, .filters__chip, .contrib, .badge");
        if (!btn || btn.dataset.hoverBusy) return;
        gsap.to(btn, { y: -1.5, duration: 0.12, ease: "power2.out" });
      },
      true
    );

    document.addEventListener(
      "pointerleave",
      (e) => {
        const target = e.target;
        if (!target || !target.closest) return;
        const btn = target.closest(".btn, .filters__chip, .contrib, .badge");
        if (!btn) return;
        gsap.to(btn, { y: 0, duration: 0.18, ease: "power2.out" });
      },
      true
    );

    document.addEventListener("pointerdown", (e) => {
      const btn = e.target && e.target.closest && e.target.closest(".btn, .filters__chip");
      if (!btn) return;
      gsap.to(btn, { scale: 0.975, duration: 0.08, ease: "power2.out" });
    });

    document.addEventListener("pointerup", (e) => {
      const btn = e.target && e.target.closest && e.target.closest(".btn, .filters__chip");
      if (!btn) return;
      gsap.to(btn, { scale: 1, duration: 0.18, ease: "back.out(2)" });
    });
  }

  /* ------------------------------------------------------------ bars --- */

  function registerBars(scope) {
    const container = scope || document;
    container.querySelectorAll("[data-fill]").forEach((el) => {
      if (el.dataset.filled) return;
      el.dataset.filled = "1";
      if (reduced) {
        el.style.width = el.dataset.fill;
        return;
      }
      gsap.fromTo(
        el,
        { width: 0 },
        {
          width: el.dataset.fill,
          duration: 0.9,
          ease: EASE_SOFT,
          scrollTrigger: { trigger: el, start: "top 90%", once: true },
        }
      );
    });
  }

  /* ----------------------------------------------------- public shape --- */

  /* app.js renders content after load and hands it here. Each call registers
     only what has not been registered, then refreshes ScrollTrigger so
     positions account for the new height. */
  let refreshQueued = false;

  function refresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    // One refresh per frame however many times content arrives.
    requestAnimationFrame(() => {
      refreshQueued = false;
      ScrollTrigger.refresh();
    });
  }

  function register(scope) {
    if (reduced) {
      showEverything(scope);
      return;
    }
    registerReveals(scope);
    registerBars(scope);
    refresh();
  }

  window.Motion = {
    available: true,
    get reduced() {
      return reduced;
    },
    register,
    refresh,
    pop,
    organiseGrid,
    splitWords,
    revealWords,
  };

  /* --------------------------------------------------------- start up --- */

  function start() {
    initSmoothScroll();
    heroEntrance();
    scrubbedHeadings();
    pinnedLifecycle();
    curvedSeam();
    microInteractions();
    register(document);

    // Layout settles after fonts load; stale trigger positions show up as
    // animations firing at the wrong scroll position.
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => ScrollTrigger.refresh());
    }
    window.addEventListener("load", () => ScrollTrigger.refresh());
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

  /* Someone turning reduced motion on mid-session gets the static design
     immediately, rather than at the next navigation. */
  if (motionQuery && motionQuery.addEventListener) {
    motionQuery.addEventListener("change", (e) => {
      reduced = e.matches;
      if (reduced) {
        ScrollTrigger.getAll().forEach((t) => t.kill());
        gsap.globalTimeline.clear();
        if (lenis) lenis.destroy();
        showEverything(document);
        root.classList.add("motion-off");
      }
    });
  }
})();
