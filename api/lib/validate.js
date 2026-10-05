/* Input validation. Every value that reaches a query, a file path or an
   outbound url passes through here first.

   The rules are the real ones, not approximations: npm's own name grammar,
   GitHub's owner and repository grammar, and base58 for a Solana key. A value
   that does not match is rejected rather than coerced, so nothing downstream
   has to wonder whether it was cleaned. */

"use strict";

const { badRequest } = require("./http");

// npm's rules: at most 214 characters, lowercase, url-safe, optionally scoped,
// and a name may not begin with a dot or an underscore.
const UNSCOPED = /^[a-z0-9][a-z0-9._-]*$/;
const SCOPED = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;

function packageName(raw, field) {
  const name = String(raw == null ? "" : raw).trim();
  const label = field || "package name";
  if (!name) throw badRequest("missing_field", `${label} is required`);
  if (name.length > 214) throw badRequest("bad_package_name", `${label} is too long`);
  // npm accepts mixed case only for legacy names; new lookups are lowercase
  // and the registry is case-sensitive, so a differing case is a different
  // package and must not be silently folded.
  if (name !== name.toLowerCase()) {
    throw badRequest("bad_package_name", "npm package names are lowercase");
  }
  if (!UNSCOPED.test(name) && !SCOPED.test(name)) {
    throw badRequest("bad_package_name", `${label} is not a valid npm package name`);
  }
  return name;
}

// Semver, loosely: three numeric parts with an optional prerelease and build.
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function version(raw) {
  const v = String(raw == null ? "" : raw).trim();
  if (!v) throw badRequest("missing_field", "version is required");
  if (v.length > 64 || !VERSION.test(v)) {
    throw badRequest("bad_version", "not a valid semver version");
  }
  return v;
}

// GitHub: owners are alphanumeric with single hyphens, repositories allow dots
// and underscores too.
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

function githubOwner(raw) {
  const v = String(raw == null ? "" : raw).trim();
  if (!OWNER.test(v)) throw badRequest("bad_owner", "not a valid GitHub owner");
  return v;
}

function githubRepo(raw) {
  const v = String(raw == null ? "" : raw).trim();
  if (!REPO.test(v) || v === "." || v === "..") {
    throw badRequest("bad_repo", "not a valid GitHub repository name");
  }
  return v;
}

/* Pull owner/repo out of whatever npm has in the repository field. The
   registry holds every shape of it: git+ssh, git+https, a bare slug, a
   subdirectory monorepo url, sometimes with ".git" and sometimes not. A url
   that is not GitHub returns null rather than a guess. */
function parseGithubRepo(raw) {
  if (!raw) return null;
  const url = String(typeof raw === "object" ? raw.url || "" : raw).trim();
  if (!url) return null;

  const cleaned = url
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/^git@([^:]+):/, "https://$1/");

  let match = cleaned.match(
    /^https?:\/\/(?:www\.)?github\.com\/([^/#?]+)\/([^/#?]+?)(?:\.git)?(?:[/#?].*)?$/i
  );
  if (!match) {
    // A bare "owner/repo", which npm also accepts in the repository field.
    match = cleaned.match(/^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?$/);
  }
  if (!match) return null;

  const owner = match[1];
  const repo = match[2];
  if (!OWNER.test(owner) || !REPO.test(repo)) return null;
  return { owner, repo, url: `https://github.com/${owner}/${repo}` };
}

// Solana addresses are base58-encoded 32-byte keys: 32 to 44 characters from
// the bitcoin alphabet, which excludes 0, O, I and l.
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function solanaPubkey(raw) {
  const v = String(raw == null ? "" : raw).trim();
  if (!BASE58.test(v)) throw badRequest("bad_pubkey", "not a valid Solana address");
  return v;
}

function base64Signature(raw) {
  const v = String(raw == null ? "" : raw).trim();
  if (!v) throw badRequest("missing_field", "signature is required");
  if (v.length > 256 || !/^[A-Za-z0-9+/=]+$/.test(v)) {
    throw badRequest("bad_signature", "signature must be base64");
  }
  const bytes = Buffer.from(v, "base64");
  if (bytes.length !== 64) {
    throw badRequest("bad_signature", "an ed25519 signature is 64 bytes");
  }
  return { value: v, bytes };
}

/* A Solana transaction signature: 64 bytes, base58, so 86 to 88 characters. */
function transactionSignature(raw) {
  const v = String(raw == null ? "" : raw).trim();
  if (!v) throw badRequest("missing_field", "a transaction signature is required");
  if (!/^[1-9A-HJ-NP-Za-km-z]{86,90}$/.test(v)) {
    throw badRequest("bad_signature", "not a valid Solana transaction signature");
  }
  return v;
}

function searchQuery(raw) {
  const q = String(raw == null ? "" : raw).trim();
  if (!q) throw badRequest("missing_field", "a search term is required");
  if (q.length > 120) throw badRequest("bad_query", "search term is too long");
  // The registry's search endpoint takes free text; strip control characters
  // so nothing odd ends up in the outbound url.
  return q.replace(/[\u0000-\u001f\u007f]/g, "");
}

function limit(raw, fallback, max) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw badRequest("bad_limit", "limit must be a positive integer");
  }
  return Math.min(n, max);
}

module.exports = {
  packageName,
  version,
  githubOwner,
  githubRepo,
  parseGithubRepo,
  solanaPubkey,
  base64Signature,
  transactionSignature,
  searchQuery,
  limit,
};
