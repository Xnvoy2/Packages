/* Assembles the static pages from src/pages + the shared chrome below.
   Run: npm run build                                                      */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PAGES = path.join(ROOT, "src", "pages");

/* -------------------------------------------------------------- config -- */

// The product name, in one place. Changing these two lines renames every
// surface the site renders.
const PRODUCT = "Packages";
const WORDMARK = "packages";

// Where the browser should reach the API. Empty means same origin, which is
// both what production uses behind a single domain and what the development
// server provides by proxying /api. Set PACKAGES_API_BASE only for a deploy
// that really does put the api on another domain; that setup also needs the
// session cookie to be SameSite=None, which requires https.
const API_BASE = process.env.PACKAGES_API_BASE || "";

// The Solana identity program is written but not deployed, so every surface
// that would read or write it is gated. Set to true only once the program is
// live on devnet and its id is configured; until then the sections marked
// <!--devnet:start--> ... <!--devnet:end--> are stripped rather than shipped
// describing something that does not exist.
const DEVNET_SURFACES = false;

/* --------------------------------------------------------------- chrome -- */

const NAV_ITEMS = [
  { href: "explore.html", label: "packages", key: "explore" },
  { href: "activity.html", label: "activity", key: "activity" },
  { href: "connect.html", label: "launch", key: "connect" },
  { href: "how-it-works.html", label: "how it works", key: "how" },
];

const TAB_ITEMS = [
  { href: "explore.html", label: "packages", key: "explore", icon: "grid" },
  { href: "activity.html", label: "activity", key: "activity", icon: "pulse" },
  { href: "how-it-works.html", label: "how", key: "how", icon: "book" },
  { href: "dashboard.html", label: "dashboard", key: "dashboard", icon: "gauge" },
];

const ICONS = {
  grid: '<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/>',
  pulse: '<path d="M2 12h4l3-8 4 16 3-8h6"/>',
  book: '<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5z"/><path d="M4 17.5h16"/>',
  gauge: '<path d="M12 21a9 9 0 1 1 9-9"/><path d="M12 12l5-3"/><circle cx="12" cy="12" r="1.6"/>',
};

// An original mark: an open carton seen in isometric, drawn as three faces so
// it reads as a package at 18px as well as at 20px.
const mark = (size) => `<svg class="nav__mark" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect width="24" height="24" rx="7" fill="url(#mk)"/>
      <path d="M12 6.4 17.8 9.5v5.9L12 18.5 6.2 15.4V9.5z" stroke="#fff" stroke-width="1.45" stroke-linejoin="round"/>
      <path d="M6.2 9.5 12 12.6l5.8-3.1M12 12.6v5.9" stroke="#fff" stroke-width="1.45" stroke-linejoin="round"/>
      <defs><linearGradient id="mk" x1="0" y1="0" x2="24" y2="24">
        <stop stop-color="#7C4DFF"/><stop offset="1" stop-color="#C04DFF"/>
      </linearGradient></defs>
    </svg>`;

/* The canonical origin. There is no default: a canonical url or a sitemap
   pointing at 127.0.0.1 would be worse than having none, so when this is
   unset those tags are left out entirely and the build says so. */
const SITE_URL = (process.env.PACKAGES_SITE_URL || "").replace(/\/$/, "");

const social = (name, title, description) => {
  if (!SITE_URL) return "";
  const url = name === "index" ? `${SITE_URL}/` : `${SITE_URL}/${name}.html`;
  return `
<link rel="canonical" href="${url}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${PRODUCT}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE_URL}/assets/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${SITE_URL}/assets/og.png">`;
};

const head = (name, title, description) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="#111014">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="manifest" href="/site.webmanifest">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@300..700&family=Geist+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="/assets/css/style.css">${social(name, title, description)}
<script src="/assets/config.js"></script>
</head>
<body>
<a class="skip" href="#main">skip to content</a>
<div class="atmosphere">`;

const nav = (active) => `
<header class="nav" id="nav">
  <div class="nav__inner">
    <a class="nav__brand" href="/index.html">${mark(20)}<span>${WORDMARK}</span></a>
    <nav class="nav__links" aria-label="Primary">
      ${NAV_ITEMS.map(
        (i) =>
          `<a class="nav__link" href="${i.href}"${
            i.key === active ? ' aria-current="page"' : ""
          }>${i.label}</a>`
      ).join("\n      ")}
    </nav>
    <span class="nav__spacer"></span>
    <a class="nav__link nav__link--quiet" href="/dashboard.html"${
      active === "dashboard" ? ' aria-current="page"' : ""
    } data-auth-only hidden>dashboard</a>
    <a class="btn btn--sm btn--ink" href="/connect.html" data-nav-cta>launch a package</a>
  </div>
</header>`;

const footer = () => `
<footer class="footer">
  <div class="shell">
    <div class="footer__inner">
      <div class="footer__brand">${mark(18)}<span>${WORDMARK}</span>
        <span class="footer__note">package identity &middot; npm &middot; Solana devnet</span>
      </div>
      <nav class="footer__links" aria-label="Footer">
        <a href="/explore.html">packages</a>
        <a href="/activity.html">activity</a>
        <a href="/how-it-works.html">how it works</a>
        <a href="/connect.html">launch</a>
        <a href="/dashboard.html">dashboard</a>
      </nav>
    </div>
    <p class="footer__legal">
      ${PRODUCT} is an independent project. It is not affiliated with, endorsed
      by or operated by npm, GitHub or Microsoft. Package data is read from the
      public npm registry and the GitHub API and is shown as those services
      return it. ${PRODUCT} issues no token and offers nothing for sale.
    </p>
  </div>
</footer>`;

const tabbar = (active) => `
<nav class="tabbar" aria-label="Mobile">
  ${TAB_ITEMS.map(
    (i) => `<a class="tabbar__link" href="${i.href}"${
      i.key === active ? ' aria-current="page"' : ""
    }>
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[i.icon]}</svg>
    <span>${i.label}</span>
  </a>`
  ).join("\n  ")}
</nav>`;

const foot = () => `
<!-- Vendored rather than loaded from a cdn, so the content security policy
     can keep script-src to self. -->
<script src="/assets/vendor/gsap.min.js"></script>
<script src="/assets/vendor/ScrollTrigger.min.js"></script>
<script src="/assets/vendor/Flip.min.js"></script>
<script src="/assets/vendor/lenis.min.js"></script>
<script src="/assets/js/api.js"></script>
<script src="/assets/js/ui.js"></script>
<script src="/assets/js/motion.js"></script>
<script src="/assets/js/app.js"></script>
</body>
</html>`;

// -------------------------------------------------------------- assemble --

const META = {
  index: [
    `${PRODUCT} — launch your package onchain`,
    "Packages gives existing npm packages a verified public identity on Solana, connecting their publishers, source code, release history and contributors.",
  ],
  explore: [
    `packages — ${PRODUCT}`,
    "Search the npm registry and discover packages with a verified public identity.",
  ],
  connect: [
    `launch a package — ${PRODUCT}`,
    "Import an npm package, sign in with GitHub, link the repository and prove publish authority.",
  ],
  activity: [
    `activity — ${PRODUCT}`,
    "Real releases and development activity across launched packages.",
  ],
  "how-it-works": [
    `how it works — ${PRODUCT}`,
    "The six steps from an npm package to a verified onchain package identity.",
  ],
  dashboard: [
    `dashboard — ${PRODUCT}`,
    "Manage your connected packages, verification and wallet.",
  ],
  creator: [
    `developer — ${PRODUCT}`,
    "A verified developer profile and the packages they maintain.",
  ],
  package: [
    `package — ${PRODUCT}`,
    "Version history, repository, contributors and onchain identity for an npm package.",
  ],
};

const ACTIVE = {
  index: "",
  explore: "explore",
  connect: "connect",
  activity: "activity",
  "how-it-works": "how",
  dashboard: "dashboard",
  creator: "explore",
  package: "explore",
};

/* The runtime config is a file rather than an inline <script> so the content
   security policy can forbid inline script outright. */
fs.writeFileSync(
  path.join(ROOT, "assets", "config.js"),
  [
    "/* Generated by tools/build.js. Do not edit. */",
    `window.PACKAGES_CONFIG = ${JSON.stringify(
      { apiBase: API_BASE, devnetSurfaces: DEVNET_SURFACES },
      null,
      2
    )};`,
    "",
  ].join("\n")
);

let built = 0;
for (const file of fs.readdirSync(PAGES)) {
  if (!file.endsWith(".html")) continue;
  const name = file.replace(/\.html$/, "");
  let body = fs.readFileSync(path.join(PAGES, file), "utf8");
  const [title, description] = META[name] || META.index;
  const active = ACTIVE[name] ?? "";

  // Strip anything between <!--devnet:start--> and <!--devnet:end--> unless the
  // onchain surfaces are switched on, so copy describing an undeployed program
  // cannot ship by accident.
  if (!DEVNET_SURFACES) {
    body = body.replace(/<!--\s*devnet:start\s*-->[\s\S]*?<!--\s*devnet:end\s*-->/g, "");
  }

  const html = [
    head(name, title, description),
    nav(active),
    '<main id="main" tabindex="-1">',
    body.trimEnd(),
    "</main>",
    footer(),
    "</div>",
    tabbar(active),
    foot(),
  ].join("\n");

  fs.writeFileSync(path.join(ROOT, file), html);
  built++;
}

/* ------------------------------------------------------------- robots -- */

/* The package and developer pages render from the api, so a crawler that does
   not run javascript sees a shell. They are deliberately absent from the
   sitemap: their contents are whatever has been imported, which changes, and
   a sitemap full of urls that may not resolve is worse than no sitemap. */
const PUBLIC_PAGES = ["index", "explore", "activity", "how-it-works", "connect"];

if (SITE_URL) {
  const today = new Date().toISOString().slice(0, 10);
  const urls = PUBLIC_PAGES.map((name) => {
    const loc = name === "index" ? `${SITE_URL}/` : `${SITE_URL}/${name}.html`;
    return `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${today}</lastmod>\n  </url>`;
  }).join("\n");

  fs.writeFileSync(
    path.join(ROOT, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
  );

  fs.writeFileSync(
    path.join(ROOT, "robots.txt"),
    [
      "User-agent: *",
      "Allow: /",
      "",
      "# Per-account and empty to a crawler.",
      "Disallow: /dashboard.html",
      "",
      `Sitemap: ${SITE_URL}/sitemap.xml`,
      "",
    ].join("\n")
  );
} else {
  // Ship one anyway: without it a crawler's request for robots.txt 404s.
  fs.writeFileSync(
    path.join(ROOT, "robots.txt"),
    ["User-agent: *", "Allow: /", "Disallow: /dashboard.html", ""].join("\n")
  );
}

console.log(
  `built ${built} pages  (api ${API_BASE || "same-origin"}, devnet surfaces ${
    DEVNET_SURFACES ? "ON" : "off"
  })`
);
if (!SITE_URL) {
  console.warn(
    "[build] PACKAGES_SITE_URL is unset: no canonical urls, no social tags and " +
      "no sitemap were written. Set it for a production build."
  );
}
