/* GitHub: the OAuth web flow, and the repository reads verification needs.

   The client secret never leaves this module, and the access token it
   exchanges is handed straight to the session layer to be encrypted. No token
   is ever included in a response. */

"use strict";

const crypto = require("crypto");
const { config } = require("./env");
const { fetchJson, upstream, badRequest } = require("./http");
const cache = require("./cache");

const API = "https://api.github.com";
const SCOPES = "read:user user:email";

/* ----------------------------------------------------------- oauth flow -- */

/* The authorize url. "state" is a random value the caller stores and checks on
   the way back: without it, a third party can hand a victim a callback url and
   log them into an account the attacker controls. */
function authorizeUrl(state) {
  const params = new URLSearchParams({
    client_id: config.github.clientId,
    redirect_uri: config.github.callbackUrl,
    scope: SCOPES,
    state,
    allow_signup: "true",
  });
  return `https://github.com/login/oauth/authorize?${params}`;
}

const newState = () => crypto.randomBytes(24).toString("base64url");

async function exchangeCode(code) {
  const res = await fetchJson("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: config.github.clientId,
      client_secret: config.github.clientSecret,
      code,
      redirect_uri: config.github.callbackUrl,
    }),
    timeout: 12000,
  });
  if (!res.ok || !res.json) {
    throw upstream("github", `github is ${res.reason || "not responding"}`);
  }
  if (res.json.error) {
    // bad_verification_code is what an expired or replayed code returns.
    throw badRequest(
      "oauth_failed",
      res.json.error_description || String(res.json.error)
    );
  }
  if (!res.json.access_token) {
    throw upstream("github", "github returned no access token");
  }
  return { token: res.json.access_token, scope: res.json.scope || "" };
}

/* ------------------------------------------------------------- api reads -- */

function headers(token) {
  const auth = token || config.github.readToken;
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    ...(auth ? { authorization: `Bearer ${auth}` } : {}),
  };
}

async function api(pathname, token, options) {
  const res = await fetchJson(`${API}${pathname}`, {
    headers: headers(token),
    timeout: (options && options.timeout) || 10000,
  });
  if (res.status === 404) return { missing: true };
  if (res.status === 401 || res.status === 403) {
    // 403 with a zero remaining budget is the rate limit; 403 otherwise is a
    // permission problem. They need different messages to the user.
    const remaining = res.headers && res.headers.get("x-ratelimit-remaining");
    if (remaining === "0") {
      const reset = res.headers.get("x-ratelimit-reset");
      return {
        rateLimited: true,
        resetAt: reset ? new Date(Number(reset) * 1000).toISOString() : null,
      };
    }
    return { denied: true, status: res.status };
  }
  if (!res.ok || !res.json) {
    throw upstream("github", `github is ${res.reason || `returning ${res.status}`}`);
  }
  return { data: res.json };
}

/* Follow GitHub's pagination.

   per_page caps at 100, so a project with more contributors than that needs
   further pages fetched. Bounded by maxPages: the full contributor list of a
   very large repository runs to thousands of entries, nothing here needs all
   of them, and an unbounded loop against a paginated API is a way to spend
   someone else's rate limit. The caller is told when the list was cut short. */
async function paginate(pathname, token, options) {
  const perPage = (options && options.perPage) || 100;
  const maxPages = (options && options.maxPages) || 3;
  const items = [];
  let page = 1;

  while (page <= maxPages) {
    const sep = pathname.includes("?") ? "&" : "?";
    const url = `${pathname}${sep}per_page=${perPage}&page=${page}`;
    const res = await api(url, token);

    if (res.missing) return { items, missing: true };
    if (res.denied) return { items, denied: true };
    if (res.rateLimited) return { items, rateLimited: true, resetAt: res.resetAt };
    if (!Array.isArray(res.data)) break;

    items.push(...res.data);
    // GitHub returns a short page only at the end of the collection.
    if (res.data.length < perPage) return { items, truncated: false };
    page += 1;
  }

  return { items, truncated: true };
}

async function viewer(token) {
  const me = await api("/user", token);
  if (me.missing || me.denied) throw badRequest("github_denied", "github rejected the token");
  if (me.rateLimited) throw upstream("github", "github rate limit reached");
  const d = me.data;
  return {
    id: String(d.id),
    login: d.login,
    name: d.name || null,
    avatarUrl: d.avatar_url || null,
    profileUrl: d.html_url || null,
  };
}

/* Verified emails only. An unverified address proves nothing: anyone can type
   someone else's email into their GitHub profile. */
async function verifiedEmails(token) {
  const res = await api("/user/emails", token);
  if (res.missing || res.denied || res.rateLimited) return [];
  const list = Array.isArray(res.data) ? res.data : [];
  return list
    .filter((e) => e && e.verified && e.email)
    .map((e) => String(e.email).toLowerCase());
}

/* The repository, as the signed-in user sees it. The "permissions" block is
   only present on an authenticated read and is the single field that says
   whether this user can push to it. */
async function repository(owner, repo, token) {
  const res = await api(`/repos/${owner}/${repo}`, token);
  if (res.missing) return { missing: true };
  if (res.rateLimited) return res;
  if (res.denied) return { denied: true };
  const d = res.data;
  return {
    id: String(d.id),
    fullName: d.full_name,
    owner: d.owner ? d.owner.login : null,
    ownerId: d.owner ? String(d.owner.id) : null,
    ownerType: d.owner ? d.owner.type : null,
    description: d.description || null,
    homepage: d.homepage || null,
    language: d.language || null,
    license: d.license ? d.license.spdx_id || d.license.key : null,
    stars: Number.isFinite(d.stargazers_count) ? d.stargazers_count : null,
    forks: Number.isFinite(d.forks_count) ? d.forks_count : null,
    watchers: Number.isFinite(d.subscribers_count) ? d.subscribers_count : null,
    openIssues: Number.isFinite(d.open_issues_count) ? d.open_issues_count : null,
    topics: Array.isArray(d.topics) ? d.topics : [],
    archived: Boolean(d.archived),
    defaultBranch: d.default_branch || null,
    pushedAt: d.pushed_at || null,
    createdAt: d.created_at || null,
    url: d.html_url || `https://github.com/${owner}/${repo}`,
    // Absent on an unauthenticated read, which is why verification always
    // passes the user's own token.
    permissions: d.permissions || null,
  };
}

// Public repository facts for a package page. Cached and read with the server's
// own token so a visitor's view does not depend on being signed in.
async function publicRepository(owner, repo) {
  return cache.through(`gh:repo:${owner}/${repo}`, 300000, async () => {
    try {
      const r = await repository(owner, repo, null);
      return r;
    } catch (e) {
      return { error: e.message || "github unavailable" };
    }
  });
}

async function contributors(owner, repo, limit) {
  return cache.through(`gh:contrib:${owner}/${repo}:${limit}`, 600000, async () => {
    const perPage = Math.min(100, Math.max(1, limit));
    // More than one page only when more than 100 are asked for.
    const pages = Math.max(1, Math.ceil(limit / perPage));
    const res = await paginate(`/repos/${owner}/${repo}/contributors`, null, {
      perPage,
      maxPages: pages,
    });

    if (res.missing || res.denied) return [];
    if (res.rateLimited) return { rateLimited: true, resetAt: res.resetAt };

    const list = res.items
      .filter((c) => c && c.login && c.type !== "Bot")
      .slice(0, limit)
      .map((c) => ({
        login: c.login,
        githubId: c.id ? String(c.id) : null,
        avatarUrl: c.avatar_url || null,
        profileUrl: c.html_url || null,
        contributions: Number.isFinite(c.contributions) ? c.contributions : null,
      }));
    // The array carries the flag rather than being wrapped, so every existing
    // caller keeps working and the ones that care can ask.
    if (res.truncated) list.truncated = true;
    return list;
  });
}

async function releases(owner, repo, limit) {
  return cache.through(`gh:rel:${owner}/${repo}:${limit}`, 300000, async () => {
    const res = await api(`/repos/${owner}/${repo}/releases?per_page=${limit}`, null);
    if (res.missing || res.denied || res.rateLimited) return [];
    const list = Array.isArray(res.data) ? res.data : [];
    return list.map((r) => ({
      tag: r.tag_name,
      name: r.name || null,
      publishedAt: r.published_at || null,
      url: r.html_url || null,
      prerelease: Boolean(r.prerelease),
    }));
  });
}

async function recentCommits(owner, repo, limit) {
  return cache.through(`gh:commits:${owner}/${repo}:${limit}`, 180000, async () => {
    const res = await api(`/repos/${owner}/${repo}/commits?per_page=${limit}`, null);
    if (res.missing || res.denied || res.rateLimited) return [];
    const list = Array.isArray(res.data) ? res.data : [];
    return list.map((c) => ({
      sha: c.sha ? c.sha.slice(0, 7) : null,
      message: c.commit && c.commit.message ? c.commit.message.split("\n")[0] : null,
      author: (c.author && c.author.login) || (c.commit && c.commit.author && c.commit.author.name) || null,
      date: c.commit && c.commit.author ? c.commit.author.date : null,
      url: c.html_url || null,
    }));
  });
}

module.exports = {
  authorizeUrl,
  newState,
  exchangeCode,
  viewer,
  verifiedEmails,
  repository,
  publicRepository,
  contributors,
  releases,
  recentCommits,
  SCOPES,
};
