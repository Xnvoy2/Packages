/* The npm registry and the npm downloads API.

   Three endpoints, all public and unauthenticated:
     registry.npmjs.org/-/v1/search          search
     registry.npmjs.org/<name>               the packument
     api.npmjs.org/downloads/...             download counts

   Nothing read here is adjusted, rounded or filled in. A field npm does not
   report comes back null and the front end renders a dash. */

"use strict";

const { fetchJson, upstream, notFound } = require("./http");
const cache = require("./cache");
const validate = require("./validate");

const REGISTRY = "https://registry.npmjs.org";
const DOWNLOADS = "https://api.npmjs.org";

// A scoped name's slash must be encoded for the packument path, but not for
// the downloads API, which wants it raw.
const encodeName = (name) => name.replace("/", "%2f");

const cacheDrop = (key) => cache.drop(key);

/* Why an upstream call failed, in words. A network failure sets `reason`; an
   http failure does not, and reporting "not responding" for a 429 would send
   someone looking for the wrong problem. */
const describeFailure = (res) => {
  if (res.reason) return res.reason;
  if (res.status === 429) return "rate-limiting this server (http 429)";
  if (res.status >= 500) return `returning http ${res.status}`;
  return `returning an unexpected http ${res.status}`;
};


/* ---------------------------------------------------------------- search -- */

async function search(text, size) {
  const key = `npm:search:${text}:${size}`;
  return cache.through(key, 120000, async () => {
    const url = `${REGISTRY}/-/v1/search?text=${encodeURIComponent(
      text
    )}&size=${size}`;
    const res = await fetchJson(url, { timeout: 9000 });
    if (!res.ok || !res.json) {
      throw upstream("npm", `the npm registry is ${describeFailure(res)}`);
    }
    const objects = Array.isArray(res.json.objects) ? res.json.objects : [];
    return objects.map((entry) => {
      const p = entry.package || {};
      const repo = validate.parseGithubRepo(p.links && p.links.repository);
      return {
        name: p.name,
        version: p.version || null,
        description: p.description || null,
        keywords: Array.isArray(p.keywords) ? p.keywords.slice(0, 8) : [],
        publishedAt: p.date || null,
        publisher: p.publisher ? p.publisher.username || null : null,
        // The search index reports these; the packument does not.
        downloadsWeekly:
          entry.downloads && Number.isFinite(entry.downloads.weekly)
            ? entry.downloads.weekly
            : null,
        dependents:
          entry.dependents === undefined || entry.dependents === null
            ? null
            : Number(entry.dependents),
        repo,
        // npm's own relevance ranking, passed through so the ordering is
        // theirs rather than something invented here.
        searchScore: Number.isFinite(entry.searchScore) ? entry.searchScore : null,
      };
    });
  });
}

/* ------------------------------------------------------------- packument -- */

/* The full package document, reduced to what the product shows. Version
   history comes from the "time" map rather than from Object.keys(versions),
   because that map is what carries the publish timestamps. */
async function packument(name, options) {
  const key = `npm:pkg:${name}`;
  // A verification check must see a version published seconds ago, so it asks
  // for a fresh read rather than clearing the cache for every other caller.
  if (options && options.fresh) cacheDrop(key);
  const value = await cache.through(key, 180000, async () => {
    const res = await fetchJson(`${REGISTRY}/${encodeName(name)}`, { timeout: 12000 });
    if (res.status === 404) return { error: "not_found" };
    if (!res.ok || !res.json) {
      return { error: "upstream", reason: describeFailure(res) };
    }
    return { doc: res.json };
  });

  if (value.error === "not_found") {
    throw notFound(`no package named "${name}" on npm`);
  }
  if (value.error) {
    throw upstream("npm", `the npm registry is ${value.reason}`);
  }
  return shapePackument(value.doc);
}

function shapePackument(doc) {
  const distTags = doc["dist-tags"] || {};
  const latestVersion = distTags.latest || null;
  const versions = doc.versions || {};
  const latest = latestVersion ? versions[latestVersion] || {} : {};
  const time = doc.time || {};

  // "created" and "modified" are not versions; everything else in the map is.
  const releases = Object.keys(time)
    .filter((k) => k !== "created" && k !== "modified")
    .map((version) => {
      const manifest = versions[version];
      return {
        version,
        publishedAt: time[version] || null,
        // "unpublished" versions stay in the time map but leave no manifest.
        present: Boolean(manifest),
        // npm sets this to the publisher's reason string. It is a fact the
        // registry reports and belongs on the page: a deprecated version is
        // materially different from a current one.
        deprecated:
          manifest && typeof manifest.deprecated === "string"
            ? manifest.deprecated
            : manifest && manifest.deprecated
            ? "deprecated"
            : null,
      };
    })
    .sort((a, b) => {
      const ta = a.publishedAt ? Date.parse(a.publishedAt) : 0;
      const tb = b.publishedAt ? Date.parse(b.publishedAt) : 0;
      return tb - ta;
    });

  // The repository field is declared by the publisher and is not verified by
  // npm, so it is a starting point for verification and never a proof. The
  // provenance attestation below is the field that npm itself vouches for.
  const declaredRepo =
    validate.parseGithubRepo(latest.repository) ||
    validate.parseGithubRepo(doc.repository) ||
    null;

  const maintainers = (Array.isArray(doc.maintainers) ? doc.maintainers : [])
    .map((m) => ({
      // The registry uses "name" in the packument and "username" in search.
      username: m.username || m.name || null,
      email: m.email || null,
    }))
    .filter((m) => m.username);

  const publisher = latest._npmUser || null;

  return {
    name: doc.name,
    description: doc.description || null,
    latestVersion,
    distTags,
    license: typeof latest.license === "string" ? latest.license : doc.license || null,
    homepage: doc.homepage || latest.homepage || null,
    keywords: Array.isArray(doc.keywords)
      ? doc.keywords
      : Array.isArray(latest.keywords)
      ? latest.keywords
      : [],
    repo: declaredRepo,
    repoDirectory:
      (latest.repository && latest.repository.directory) || null,
    maintainers,
    createdAt: time.created || null,
    modifiedAt: time.modified || null,
    versionCount: releases.length,
    releases,
    publisher: publisher
      ? {
          name: publisher.name || null,
          email: publisher.email || null,
          // Present when the version was published by a CI workflow through
          // npm's trusted-publisher OIDC flow rather than by a user token.
          trustedPublisher: publisher.trustedPublisher
            ? publisher.trustedPublisher.id || "unknown"
            : null,
        }
      : null,
    // Whether the package as a whole is deprecated, which npm expresses by
    // deprecating its latest version.
    deprecated:
      typeof latest.deprecated === "string"
        ? latest.deprecated
        : latest.deprecated
        ? "deprecated"
        : null,

    hasProvenance: Boolean(latest.dist && latest.dist.attestations),

    /* The tarball's integrity, as published. This is what an onchain release
       record commits to, so it is read here rather than recomputed: the
       registry's value is the one everyone else checks against. */
    integrity: (latest.dist && latest.dist.integrity) || null,
    shasum: (latest.dist && latest.dist.shasum) || null,
    tarball: (latest.dist && latest.dist.tarball) || null,
    engines: latest.engines && typeof latest.engines === "object" ? latest.engines : null,
    unpackedSize:
      latest.dist && Number.isFinite(latest.dist.unpackedSize)
        ? latest.dist.unpackedSize
        : null,
    fileCount:
      latest.dist && Number.isFinite(latest.dist.fileCount)
        ? latest.dist.fileCount
        : null,
    // Kept so verification can read a specific version's manifest without a
    // second round trip.
    _versions: versions,
  };
}

/* ------------------------------------------------------------ provenance -- */

/* npm's publish attestation for one version.

   The SLSA provenance predicate names the repository the tarball was built
   from, including GitHub's immutable numeric repository id. That id is what
   verification compares against, because a repository can be renamed or its
   full name taken over by someone else, and the id cannot.

   The bundle is a signed DSSE envelope. This reads the payload, which is
   trusted because it came from the registry over TLS and the registry is the
   authority on who published. Verifying the Sigstore signature chain offline
   as well would be strictly better and is noted as a hardening step; it needs
   the Fulcio trust root, which is deployment configuration. */
async function provenance(name, version) {
  const key = `npm:prov:${name}@${version}`;
  const value = await cache.through(key, 600000, async () => {
    const url = `${REGISTRY}/-/npm/v1/attestations/${encodeName(name)}@${version}`;
    const res = await fetchJson(url, { timeout: 12000 });
    if (res.status === 404) return { attested: false, reason: "no attestation published" };
    if (!res.ok || !res.json) {
      return { attested: false, reason: describeFailure(res) };
    }
    const list = Array.isArray(res.json.attestations) ? res.json.attestations : [];
    for (const item of list) {
      const payload =
        item.bundle && item.bundle.dsseEnvelope && item.bundle.dsseEnvelope.payload;
      if (!payload) continue;
      let statement;
      try {
        statement = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
      } catch (e) {
        continue;
      }
      if (!/slsa\.dev\/provenance/.test(statement.predicateType || "")) continue;
      const build = (statement.predicate && statement.predicate.buildDefinition) || {};
      const workflow =
        (build.externalParameters && build.externalParameters.workflow) || {};
      const github = (build.internalParameters && build.internalParameters.github) || {};
      const subject = (statement.subject && statement.subject[0]) || {};
      const sourceDep = (build.resolvedDependencies || [])[0] || {};
      return {
        attested: true,
        subject: subject.name || null,
        repoUrl: workflow.repository || null,
        repoRef: workflow.ref || null,
        workflowPath: workflow.path || null,
        // Strings, because GitHub ids exceed what a float holds safely in
        // other parts of the pipeline and are only ever compared.
        repositoryId:
          github.repository_id === undefined || github.repository_id === null
            ? null
            : String(github.repository_id),
        repositoryOwnerId:
          github.repository_owner_id === undefined ||
          github.repository_owner_id === null
            ? null
            : String(github.repository_owner_id),
        commit: (sourceDep.digest && sourceDep.digest.gitCommit) || null,
      };
    }
    return { attested: false, reason: "no slsa provenance in the attestation bundle" };
  });
  return value;
}

/* -------------------------------------------------------------- download -- */

async function downloadsPoint(name, period) {
  const key = `npm:dl:${period}:${name}`;
  return cache.through(key, 1800000, async () => {
    const res = await fetchJson(
      `${DOWNLOADS}/downloads/point/${period}/${name}`,
      { timeout: 9000 }
    );
    // The downloads API 404s for a package with no recorded downloads and for
    // very new packages. That is "no figure", not an error, and must render
    // as a dash rather than as a zero.
    if (!res.ok || !res.json || !Number.isFinite(res.json.downloads)) return null;
    return { downloads: res.json.downloads, start: res.json.start, end: res.json.end };
  });
}

/* A daily series, used for the download sparkline. Returns null rather than a
   flat line when npm has no data, so the chart is absent instead of wrong. */
async function downloadsRange(name, period) {
  const key = `npm:dlr:${period}:${name}`;
  return cache.through(key, 1800000, async () => {
    const res = await fetchJson(
      `${DOWNLOADS}/downloads/range/${period}/${name}`,
      { timeout: 10000 }
    );
    if (!res.ok || !res.json || !Array.isArray(res.json.downloads)) return null;
    const points = res.json.downloads
      .filter((d) => d && Number.isFinite(d.downloads))
      .map((d) => ({ day: d.day, downloads: d.downloads }));
    return points.length ? points : null;
  });
}

/* Read one published version's manifest, for the publish-authority proof.
   Asks the registry for that exact version rather than reusing a cached
   packument, so a version published seconds ago is visible immediately. */
async function versionManifest(name, version) {
  const res = await fetchJson(`${REGISTRY}/${encodeName(name)}/${version}`, {
    timeout: 10000,
  });
  if (res.status === 404) return null;
  if (!res.ok || !res.json) {
    throw upstream("npm", `the npm registry is ${describeFailure(res)}`);
  }
  return res.json;
}

module.exports = {
  search,
  packument,
  shapePackument,
  provenance,
  downloadsPoint,
  downloadsRange,
  versionManifest,
  REGISTRY,
  DOWNLOADS,
};
