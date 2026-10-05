/* Collects the static site into dist/, and nothing else.

   The project directory holds the api, its tests, the build tools, the page
   sources, the Solana program and node_modules. tools/serve.js keeps those
   private with a positive allowlist, because it serves the project in place.
   A static host serves a directory, so the allowlist has to be applied when
   that directory is assembled instead. Same rule, enforced earlier: the site
   is the generated html at the root plus assets/, and nothing else.

   Run: node tools/dist.js   (after node tools/build.js)                     */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");

/* Exactly the set tools/serve.js is willing to serve. Kept in the same shape
   so the two cannot drift apart unnoticed. */
const SITE_FILES = new Set(["site.webmanifest", "robots.txt", "sitemap.xml"]);
const ASSET_DIR = "assets";

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    // Never copy a dot-file or a dot-directory, whatever its extension.
    if (entry.name.startsWith(".")) continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) n += copyDir(src, dest);
    else {
      fs.copyFileSync(src, dest);
      n++;
    }
  }
  return n;
}

function main() {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  let pages = 0;
  let files = 0;

  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "dist") continue;
    if (entry.isDirectory()) continue;
    const isPage = entry.name.endsWith(".html");
    if (!isPage && !SITE_FILES.has(entry.name)) continue;
    fs.copyFileSync(path.join(ROOT, entry.name), path.join(DIST, entry.name));
    isPage ? pages++ : files++;
  }

  const assetsFrom = path.join(ROOT, ASSET_DIR);
  const assets = fs.existsSync(assetsFrom)
    ? copyDir(assetsFrom, path.join(DIST, ASSET_DIR))
    : 0;

  if (!pages) {
    console.error("[dist] no pages found. Run node tools/build.js first.");
    process.exit(1);
  }

  /* A loud check rather than a silent leak: if anything that is not part of
     the site has reached dist/, say so and fail rather than publish it. */
  const leaked = [];
  (function scan(dir, rel) {
    const insideAssets = rel === ASSET_DIR || rel.startsWith(ASSET_DIR + "/");
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        // Only assets/ may have directories, and it may nest freely.
        if (!insideAssets && entry.name !== ASSET_DIR) leaked.push(r + "/");
        else scan(path.join(dir, entry.name), r);
        continue;
      }
      // Anything under assets/ is a site asset by definition.
      if (insideAssets) continue;
      if (!entry.name.endsWith(".html") && !SITE_FILES.has(entry.name)) leaked.push(r);
    }
  })(DIST, "");

  if (leaked.length) {
    console.error("[dist] refusing to publish, these are not site files:");
    leaked.forEach((f) => console.error("  " + f));
    process.exit(1);
  }

  console.log(`[dist] ${pages} pages, ${files} site files, ${assets} assets -> dist/`);
}

main();
