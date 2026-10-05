/* Static server for the site, plus a development proxy for /api.
   Run: npm run serve      (or npm start, which builds first)

   The proxy is what makes the session cookie work locally. The cookie is
   HttpOnly and SameSite=Lax over plain http, and a Lax cookie is not sent on a
   cross-origin fetch, so a site on :4789 calling an api on :4790 would never
   be signed in. Production serves both from one domain; this makes the
   development setup match that rather than diverge from it.              */

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.PORT) || 4789;
const API_PORT = Number(process.env.PACKAGES_API_PORT) || 4790;

/* The headers a production host must also send. They are set here so the
   policy is exercised during development rather than discovered to be broken
   after a deploy.

   script-src carries no 'unsafe-inline': the build writes the runtime config
   to assets/config.js precisely so that it does not have to. style-src does
   allow it, because the avatar hue is passed as a style attribute per card
   and there is no way to hash those. */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  // Contributor and account avatars come from GitHub's own cdn.
  "img-src 'self' data: https://avatars.githubusercontent.com",
  "connect-src 'self' https://auth.privy.io https://api.privy.io",
  // The embedded wallet runs in an iframe Privy hosts.
  "frame-src https://auth.privy.io",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

const SECURITY_HEADERS = {
  "content-security-policy": CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "permissions-policy": "geolocation=(), microphone=(), camera=(), payment=()",
};

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

/* The api, running inside this process when PACKAGES_EMBED_API is set.
   Required at startup rather than lazily so a misconfiguration fails
   immediately instead of on the first request. */
let embeddedApi = null;
if (process.env.PACKAGES_EMBED_API === "1") {
  const api = require("../api/_server.js");
  embeddedApi = api.handleRequest;
  api
    .migrate()
    .then(() => console.log("[site] api embedded, migrations applied"))
    .catch((e) => {
      console.error("[fatal] api migrations failed:", e.message);
      process.exit(1);
    });
}

/* Forward /api to the api process untouched, including the session cookie in
   both directions. Nothing is rewritten: the api sets the cookie on this
   origin, which is the whole point. */
function proxyApi(req, res) {
  const upstream = http.request(
    {
      host: "127.0.0.1",
      port: API_PORT,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `127.0.0.1:${API_PORT}` },
    },
    (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    }
  );
  upstream.on("error", () => {
    // The api not running is the common case during development, and the
    // front end words that differently from a server error, so it has to
    // reach the browser as a failure rather than as an empty 200.
    res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        error: {
          code: "api_unreachable",
          message: `nothing is answering on 127.0.0.1:${API_PORT}. Start it with npm run api.`,
        },
      })
    );
  });
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  /* Two ways to reach the api, and they are chosen by configuration rather
     than by code paths that drift apart:

       PACKAGES_EMBED_API=1   the api runs inside this process. One service to
                              deploy, one port, and no proxy hop. The handler
                              is the same function the standalone server uses.

       otherwise              proxy to the api process, which is what local
                              development does so each can be restarted alone.

     Embedding also keeps the in-memory cache and rate limiter in one place,
     which is where they are effective. */
  if ((req.url || "").startsWith("/api/")) {
    if (embeddedApi) return embeddedApi(req, res);
    return proxyApi(req, res);
  }

  let rel = decodeURIComponent((req.url || "/").split("?")[0]);
  // Collapse repeated slashes so "//" and "/explore//" behave like their
  // single-slash form rather than resolving to a directory and 403ing.
  rel = rel.replace(/\/{2,}/g, "/");

  /* A package's permanent url is /p/<name>, which serves the package page.
     The name may contain a slash (a scoped package), so everything after /p/
     belongs to the name and is not a path. A production host needs the same
     single rewrite: /p/* -> /package.html.

     Only a document request is rewritten. Every url the pages reference is
     root-absolute, so nothing under /p/ should ask for an asset; a request
     that does is a mistake, and answering it with html would surface as a
     syntax error in the console rather than as the 404 it is. */
  if (/^\/p\/.+/.test(rel) && !path.extname(rel)) rel = "/package.html";

  if (rel.endsWith("/")) rel += "index.html";

  const target = path.join(ROOT, rel);
  // Resolve symlinks and ".." before deciding the path is inside ROOT.
  let real;
  try {
    real = fs.realpathSync(target);
  } catch (e) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("not found");
  }

  const rootReal = fs.realpathSync(ROOT);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    res.writeHead(403, { "content-type": "text/plain" });
    return res.end("forbidden");
  }

  // Never serve dot-files or anything inside a dot-directory (.claude, .git,
  // .env*), whatever their extension.
  const inside = real.slice(rootReal.length);
  const segments = inside.split(/[\\/]/).filter(Boolean);
  if (segments.some((seg) => seg.startsWith("."))) {
    res.writeHead(403, { "content-type": "text/plain" });
    return res.end("forbidden");
  }

  /* Only the site's own files. The project directory also holds the api, its
     tests, the build tools, the page sources and node_modules, and an
     extension allowlist alone is not enough to keep them private: server
     source is .js, and the page sources are .html. The site is the generated
     html at the root plus the assets directory, and nothing else is served.

     A production static host serves a build directory and so never faces
     this; the one here serves the project in place. */
  const SITE_FILES = new Set(["site.webmanifest", "robots.txt", "sitemap.xml"]);
  const topLevel = segments[0] || "";
  const isRootPage = segments.length === 1 && topLevel.endsWith(".html");
  const isSiteFile = segments.length === 1 && SITE_FILES.has(topLevel);
  const isAsset = topLevel === "assets";
  if (!isRootPage && !isSiteFile && !isAsset) {
    res.writeHead(403, { "content-type": "text/plain" });
    return res.end("forbidden");
  }

  const ext = path.extname(real).toLowerCase();
  if (!TYPES[ext]) {
    res.writeHead(403, { "content-type": "text/plain" });
    return res.end("forbidden");
  }

  fs.readFile(real, (err, buf) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("not found");
    }
    res.writeHead(200, {
      "content-type": TYPES[ext],
      "cache-control": "no-store",
      ...SECURITY_HEADERS,
    });
    res.end(buf);
  });
});

/* Development binds to loopback, so a dev server is never reachable from the
   network. Production has to bind every interface or the platform's proxy
   cannot reach the container at all: it connects over the internal network,
   and a process listening on 127.0.0.1 refuses that connection.

   This changes who may open a connection, not what is served. The realpath
   containment, the dot-file rule, the site allowlist and the extension check
   above are what keep the backend source and the env files private. They are
   unchanged, and they run for every request whatever interface it arrived
   on. */
const HOST =
  process.env.HOST ||
  (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");

server.listen(PORT, HOST, () => {
  const where = HOST === "0.0.0.0" ? `0.0.0.0:${PORT}` : `http://${HOST}:${PORT}/`;
  console.log(`packages site running at ${where}`);
});
