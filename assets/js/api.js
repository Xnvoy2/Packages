/* The one seam between the static site and the API.

   Every network call in the product goes through here, so there is a single
   place that knows the base url, sends the session cookie, and turns a failure
   into something a page can render. Nothing else in the front end calls fetch.

   The API being unreachable is a normal state, not a crash: each page asks for
   what it needs, and renders an honest message when the answer does not
   arrive. Nothing is ever filled in with a placeholder figure. */

(function () {
  "use strict";

  const CONFIG = window.PACKAGES_CONFIG || {};
  const BASE = (CONFIG.apiBase || "").replace(/\/$/, "");

  class ApiError extends Error {
    constructor(status, code, message, details) {
      super(message || code || "request failed");
      this.status = status;
      this.code = code || "error";
      this.details = details || null;
    }
    // True when the server was never reached, as opposed to answering with an
    // error. Pages word those two cases differently.
    get offline() {
      return this.status === 0;
    }
  }

  async function request(method, path, body) {
    let res;
    try {
      res = await fetch(`${BASE}${path}`, {
        method,
        // The session cookie is set on the API origin, which is a different
        // origin in development, so it has to be sent explicitly.
        credentials: "include",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new ApiError(0, "offline", "the Packages API is not reachable");
    }

    let payload = null;
    const text = await res.text();
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (e) {
        payload = null;
      }
    }

    if (!res.ok) {
      const err = payload && payload.error ? payload.error : {};
      // A 503 that carries a body is a deliberate "not yet" from the server,
      // and the body is the useful part, so it travels with the error.
      const error = new ApiError(res.status, err.code, err.message, err.details);
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  const get = (path) => request("GET", path);
  const post = (path, body) => request("POST", path, body || {});
  const del = (path) => request("DELETE", path);

  // The package name goes in one path segment, so its slash is encoded. A
  // scoped name would otherwise read as two segments.
  const pkgPath = (name) => encodeURIComponent(name);

  /* Asked for by several pages on the same load, so the promise is shared
     rather than the request repeated. Invalidated after anything that could
     change the answer. */
  let mePromise = null;
  let configPromise = null;

  const API = {
    ApiError,
    base: BASE,

    config() {
      if (!configPromise) configPromise = get("/api/config").catch((e) => ({ error: e }));
      return configPromise;
    },

    health: () => get("/api/health"),

    me(options) {
      if (options && options.fresh) mePromise = null;
      if (!mePromise) {
        mePromise = get("/api/me").catch((e) => ({ signedIn: false, error: e }));
      }
      return mePromise;
    },

    /* GitHub is no longer a way in. This is the link that proves authority
       over a repository, and the server refuses it without a session. */
    linkGithubUrl: () => `${BASE}/api/auth/github/start`,

    /* Exchange a verified Privy token for the session cookie the rest of
       the api uses. */
    async signInWithPrivy(token) {
      const r = await post("/api/auth/privy", { token });
      mePromise = null;
      return r;
    },

    async signOut() {
      const r = await post("/api/auth/logout");
      mePromise = null;
      return r;
    },

    search: (q, limit) =>
      get(`/api/packages/search?q=${encodeURIComponent(q)}&limit=${limit || 12}`),
    featured: () => get("/api/packages/featured"),
    discover: (view, limit) =>
      get(`/api/packages/discover?view=${encodeURIComponent(view || "verified")}&limit=${limit || 12}`),
    refreshPackage: (name) => post(`/api/packages/${pkgPath(name)}/refresh`),
    package: (name) => get(`/api/packages/${pkgPath(name)}`),
    versions: (name) => get(`/api/packages/${pkgPath(name)}/versions`),
    contributors: (name) => get(`/api/packages/${pkgPath(name)}/contributors`),
    identityFor: (name) => get(`/api/packages/${pkgPath(name)}/identity`),

    activity: (limit) => get(`/api/activity?limit=${limit || 30}`),
    developer: (login) => get(`/api/developers/${encodeURIComponent(login)}`),

    async importPackage(name) {
      const r = await post("/api/claims/import", { name });
      mePromise = null;
      return r;
    },
    async removeClaim(name) {
      const r = await del(`/api/claims/${pkgPath(name)}`);
      mePromise = null;
      return r;
    },
    async verifyRepo(name) {
      const r = await post("/api/verify/repo", { name });
      mePromise = null;
      return r;
    },
    publishChallenge: (name) => post("/api/verify/publish/challenge", { name }),
    async checkPublishProof(name) {
      const r = await post("/api/verify/publish/check", { name });
      mePromise = null;
      return r;
    },

    walletChallenge: () => post("/api/wallet/challenge"),
    async confirmWallet(payload) {
      const r = await post("/api/wallet/confirm", payload);
      mePromise = null;
      return r;
    },
    async removeWallet(pubkey) {
      const r = await post("/api/wallet/remove", { pubkey });
      mePromise = null;
      return r;
    },

    identityStatus: () => get("/api/identity/status"),

    // The registration lifecycle. Three calls, because the browser reporting
    // a confirmed transaction is a claim, not a confirmation.
    prepareIdentity: (name) => post("/api/identity/prepare", { name }),
    reportSubmitted: (name, signature) =>
      post("/api/identity/submitted", { name, signature }),
    async reconcileIdentity(name) {
      const r = await post("/api/identity/reconcile", { name });
      mePromise = null;
      return r;
    },
    registerIdentity: (name) => post("/api/identity/register", { name }),
  };

  window.PackagesAPI = API;
})();
