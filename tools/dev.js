/* Builds the site, then runs the static server and the API together.

   Run: npm run dev

   The two are separate processes on separate ports in production too, so this
   only saves opening two terminals; it does not change how either one works.
   Without a DATABASE_URL the API is given the in-memory database, which is
   what a local run wants and what it loudly says it is doing.             */

"use strict";

const { spawn } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const children = [];

function run(name, args, env) {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, ...(env || {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const prefix = `[${name}]`;
  const pipe = (stream, to) => {
    stream.setEncoding("utf8");
    let buffered = "";
    stream.on("data", (chunk) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      // The last element is whatever came after the final newline, so it is
      // held back rather than printed as a line of its own.
      buffered = lines.pop();
      for (const line of lines) if (line.trim()) to(`${prefix} ${line}`);
    });
  };
  pipe(child.stdout, (l) => console.log(l));
  pipe(child.stderr, (l) => console.error(l));
  child.on("exit", (code) => {
    console.log(`${prefix} exited with ${code}`);
    shutdown(code || 0);
  });
  children.push(child);
  return child;
}

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// Build first: the root html files are generated, and serving a stale one
// would show the previous version of every page.
const build = spawn(process.execPath, ["tools/build.js"], {
  cwd: ROOT,
  stdio: "inherit",
});

build.on("exit", (code) => {
  if (code !== 0) {
    console.error("[dev] build failed");
    process.exit(code || 1);
  }
  run("site", ["tools/serve.js"]);
  run("api", ["api/index.js"], {
    PACKAGES_DEV_DB: process.env.DATABASE_URL ? "" : "memory",
  });
});
