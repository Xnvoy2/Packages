/* A small TTL cache for upstream responses.

   npm's registry and GitHub's API both rate-limit, and the homepage asks for
   the same handful of packages on every load. Entries are capped so a long
   run of distinct lookups cannot grow the process without bound: the oldest
   insertion is dropped first. */

"use strict";

const MAX_ENTRIES = 500;
const store = new Map();

function get(key) {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (hit.expires <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  return hit.value;
}

function set(key, value, ttlMs) {
  if (store.size >= MAX_ENTRIES) {
    // Map iterates in insertion order, so the first key is the oldest.
    const oldest = store.keys().next();
    if (!oldest.done) store.delete(oldest.value);
  }
  store.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}

/* Wrap a loader so concurrent callers for the same key share one upstream
   request. Without this, four cards asking for the same package on first load
   send four requests and spend four units of the rate limit. */
const inflight = new Map();

async function through(key, ttlMs, loader) {
  const cached = get(key);
  if (cached !== undefined) return cached;

  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    try {
      const value = await loader();
      // A failed lookup is cached briefly too, so an outage does not turn
      // into a request storm, but not for long enough to outlast it.
      set(key, value, value && value.error ? Math.min(ttlMs, 15000) : ttlMs);
      return value;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

const drop = (key) => {
  store.delete(key);
  inflight.delete(key);
};

const clear = () => {
  store.clear();
  inflight.clear();
};

module.exports = { get, set, through, drop, clear, get size() { return store.size; } };
