/* Rate limiting: a token bucket per client per bucket name.

   In memory on purpose. This protects the upstream npm and GitHub quotas and
   the verification endpoints from a single noisy client, which is a per-process
   concern; it is not a distributed quota and does not pretend to be. Behind
   more than one instance each process enforces its own share, so the limits
   below are set per process rather than as a global budget. */

"use strict";

const { tooMany } = require("./http");

const buckets = new Map();

// capacity = burst, refill = tokens per second.
const LIMITS = {
  search: { capacity: 20, refill: 0.5 },      // npm search, 30/min sustained
  read: { capacity: 60, refill: 2 },          // package and activity reads
  auth: { capacity: 10, refill: 0.1 },        // sign-in attempts
  verify: { capacity: 8, refill: 0.05 },      // proof checks, 3/min sustained
  write: { capacity: 20, refill: 0.2 },
};

function clientKey(req) {
  // Behind a proxy the socket address is the proxy, so the first hop in
  // x-forwarded-for is used when present. It is client-controlled and so is
  // only ever a rate-limit key, never an identity or an authorisation input.
  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  return forwarded || (req.socket && req.socket.remoteAddress) || "unknown";
}

function take(req, name, cost) {
  const limit = LIMITS[name] || LIMITS.read;
  const key = `${name}:${clientKey(req)}`;
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: limit.capacity, at: now };
    buckets.set(key, bucket);
  }
  const elapsed = (now - bucket.at) / 1000;
  bucket.tokens = Math.min(limit.capacity, bucket.tokens + elapsed * limit.refill);
  bucket.at = now;

  const price = cost || 1;
  if (bucket.tokens < price) {
    const wait = Math.ceil((price - bucket.tokens) / limit.refill);
    throw tooMany(Math.max(1, wait));
  }
  bucket.tokens -= price;
  return { remaining: Math.floor(bucket.tokens) };
}

// Buckets at full capacity hold no information, so they are dropped. Without
// this the map grows once per address seen and never shrinks.
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    const name = key.slice(0, key.indexOf(":"));
    const limit = LIMITS[name] || LIMITS.read;
    const restored = bucket.tokens + ((now - bucket.at) / 1000) * limit.refill;
    if (restored >= limit.capacity) buckets.delete(key);
  }
}, 60000);
sweep.unref();

function _clear() {
  buckets.clear();
}

module.exports = { take, clientKey, LIMITS, _clear };
