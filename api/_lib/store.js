/* Reads and writes that more than one route needs: the package row, the
   release log and the event feed. Keeping them here means the shape of a
   package in the database is defined once. */

"use strict";

const crypto = require("crypto");
const db = require("./db");

/* Mirror what npm reported into the packages row. Called whenever a packument
   is fetched for a package the product knows about, so the local copy does not
   drift. The identity columns are never touched here: they belong to
   verification and registration, not to a registry read. */
async function upsertPackage(pkg) {
  const row = await db.one(
    `insert into packages
       (name, description, latest_version, license, homepage,
        repo_url, repo_owner, repo_name, keywords, maintainers,
        npm_created_at, npm_modified_at, version_count, fetched_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
     on conflict (name) do update set
       description = $2, latest_version = $3, license = $4, homepage = $5,
       repo_url = $6, repo_owner = $7, repo_name = $8,
       keywords = $9, maintainers = $10,
       npm_created_at = $11, npm_modified_at = $12, version_count = $13,
       fetched_at = now()
     returning *`,
    [
      pkg.name,
      pkg.description,
      pkg.latestVersion,
      pkg.license,
      pkg.homepage,
      pkg.repo ? pkg.repo.url : null,
      pkg.repo ? pkg.repo.owner : null,
      pkg.repo ? pkg.repo.repo : null,
      JSON.stringify(pkg.keywords || []),
      JSON.stringify(pkg.maintainers || []),
      pkg.createdAt,
      pkg.modifiedAt,
      pkg.versionCount,
    ]
  );
  return row;
}

const getPackage = (name) =>
  db.one("select * from packages where name = $1", [name]);

/* Packages that have completed verification, newest first. This is the list
   the explore page and the homepage show as "verified", and it is empty until
   somebody actually verifies one. */
async function verifiedPackages(limit) {
  return db.many(
    `select p.*, u.github_login as owner_login, u.avatar_url as owner_avatar
       from packages p
       join users u on u.id = p.verified_owner_id
      where p.verified_owner_id is not null
      order by p.verified_at desc
      limit $1`,
    [limit]
  );
}

const CLAIM_VIEW = `select p.name, p.description, p.latest_version, p.repo_owner, p.repo_name,
            p.verified_owner_id, p.launched_at, p.identity_pda,
            c.status, c.repo_control, c.repo_permission, c.trusted_publisher,
            c.trusted_publisher_repo, c.publish_proof, c.publish_proof_version,
            c.maintainer_email_match, c.matched_maintainer, c.created_at, c.verified_at
       from claims c
       join packages p on p.name = c.package_name`;

/* One claim in the same shape the dashboard list uses, so the single-claim
   responses and the list cannot drift apart. */
const claimView = (packageName, userId) =>
  db.one(`${CLAIM_VIEW} where c.package_name = $1 and c.user_id = $2`, [
    packageName,
    userId,
  ]);

async function packagesForUser(userId) {
  return db.many(
    `select p.name, p.description, p.latest_version, p.repo_owner, p.repo_name,
            p.verified_owner_id, p.launched_at, p.identity_pda,
            c.status, c.repo_control, c.repo_permission, c.trusted_publisher,
            c.trusted_publisher_repo, c.publish_proof, c.publish_proof_version,
            c.maintainer_email_match, c.matched_maintainer, c.created_at, c.verified_at
       from claims c
       join packages p on p.name = c.package_name
      where c.user_id = $1
      order by c.created_at desc`,
    [userId]
  );
}

/* Append-only release log. A version already recorded is left exactly as it
   was: a published version is immutable, so a second sighting carries no new
   information and must not overwrite the first record of it. */
async function recordReleases(packageName, releases, hashFor) {
  let inserted = 0;
  for (const release of releases) {
    const result = await db.query(
      `insert into releases (id, package_name, version, published_at, record_hash)
       values ($1, $2, $3, $4, $5)
       on conflict (package_name, version) do nothing`,
      [
        crypto.randomUUID(),
        packageName,
        release.version,
        release.publishedAt,
        hashFor ? hashFor(release) : null,
      ]
    );
    inserted += result.rowCount || 0;
  }
  return inserted;
}

const releasesFor = (packageName, limit) =>
  db.many(
    `select version, published_at, record_hash, onchain_tx
       from releases where package_name = $1
      order by published_at desc nulls last
      limit $2`,
    [packageName, limit]
  );

/* The product's own events. Nothing is written here that the product did not
   cause: npm release activity is read live from the registry instead of being
   copied in, so the feed cannot show a stale event as current. */
async function recordEvent(kind, { packageName, actorLogin, payload }) {
  await db.query(
    `insert into events (id, kind, package_name, actor_login, payload)
     values ($1, $2, $3, $4, $5)`,
    [
      crypto.randomUUID(),
      kind,
      packageName || null,
      actorLogin || null,
      JSON.stringify(payload || {}),
    ]
  );
}

const recentEvents = (limit) =>
  db.many(
    `select kind, package_name, actor_login, payload, created_at
       from events order by created_at desc limit $1`,
    [limit]
  );

/* A Privy account, which is now what a session is built on.

   Looked up by the Privy DID, never by email: an email can be changed or
   reused, and matching on it would let one account be mistaken for another.
   A user created this way has no GitHub identity at all until they link one,
   which is the point of the change. */
async function upsertPrivyUser(identity) {
  const existing = await db.one("select id from users where privy_did = $1", [identity.did]);
  if (existing) {
    return db.one(
      `update users set last_seen_at = now(),
              display_name = coalesce(display_name, $2)
         where id = $1 returning *`,
      [existing.id, identity.email || null]
    );
  }
  return db.one(
    `insert into users (id, privy_did, display_name, privy_linked_at)
     values ($1, $2, $3, now()) returning *`,
    [crypto.randomUUID(), identity.did, identity.email || null]
  );
}

/* Attach a GitHub identity to an account that already exists. This is the
   authority connection, not a sign-in: it is only ever reached from inside a
   session Privy has already established. A GitHub identity already bound to
   another account is refused rather than moved, because moving it would
   transfer whatever authority that account had proved. */
async function linkGithub(userId, profile) {
  const taken = await db.one(
    "select id from users where github_id = $1 and id <> $2",
    [profile.id, userId]
  );
  if (taken) return { conflict: true };
  const row = await db.one(
    `update users set github_id = $2, github_login = $3,
            display_name = coalesce(display_name, $4),
            avatar_url = $5, profile_url = $6,
            github_linked_at = now(), last_seen_at = now()
       where id = $1 returning *`,
    [userId, profile.id, profile.login, profile.name, profile.avatarUrl, profile.profileUrl]
  );
  return { user: row };
}

async function upsertUser(profile) {
  const existing = await db.one("select id from users where github_id = $1", [
    profile.id,
  ]);
  if (existing) {
    const row = await db.one(
      `update users set github_login = $2, display_name = $3, avatar_url = $4,
              profile_url = $5, last_seen_at = now()
         where id = $1 returning *`,
      [existing.id, profile.login, profile.name, profile.avatarUrl, profile.profileUrl]
    );
    return row;
  }
  return db.one(
    `insert into users (id, github_id, github_login, display_name, avatar_url, profile_url)
     values ($1,$2,$3,$4,$5,$6) returning *`,
    [
      crypto.randomUUID(),
      profile.id,
      profile.login,
      profile.name,
      profile.avatarUrl,
      profile.profileUrl,
    ]
  );
}

const userByLogin = (login) =>
  db.one(
    // Case-insensitive because GitHub logins are, and a profile url typed in
    // the wrong case should still resolve.
    "select * from users where lower(github_login) = lower($1)",
    [login]
  );

const walletsFor = (userId) =>
  db.many(
    "select pubkey, cluster, verified_at from wallets where user_id = $1 order by verified_at desc",
    [userId]
  );

async function addWallet(userId, pubkey, cluster) {
  await db.query(
    `insert into wallets (id, user_id, pubkey, cluster)
     values ($1,$2,$3,$4)
     on conflict (user_id, pubkey) do update set verified_at = now()`,
    [crypto.randomUUID(), userId, pubkey, cluster]
  );
}

module.exports = {
  upsertPrivyUser,
  linkGithub,
  upsertPackage,
  getPackage,
  claimView,
  verifiedPackages,
  packagesForUser,
  recordReleases,
  releasesFor,
  recordEvent,
  recentEvents,
  upsertUser,
  userByLogin,
  walletsFor,
  addWallet,
};

/* ===================================================== imported facts ==== */

/* Everything below records something an external service said, together with
   where it came from and when it was read. Those two columns are the line
   between an imported fact and a fact this product verified; without them a
   contributor list and a proved publish authority would look alike in the
   database. */

async function upsertRepository(repo) {
  if (!repo || !repo.id) return null;
  return db.one(
    `insert into repositories
       (github_id, owner_login, name, full_name, owner_id, owner_type,
        description, language, license, stars, forks, watchers, open_issues,
        topics, archived, default_branch, pushed_at, created_at, retrieved_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, now())
     on conflict (github_id) do update set
       owner_login = $2, name = $3, full_name = $4, owner_id = $5,
       owner_type = $6, description = $7, language = $8, license = $9,
       stars = $10, forks = $11, watchers = $12, open_issues = $13,
       topics = $14, archived = $15, default_branch = $16, pushed_at = $17,
       retrieved_at = now()
     returning *`,
    [
      repo.id,
      repo.owner,
      repo.fullName ? repo.fullName.split("/")[1] : null,
      repo.fullName,
      repo.ownerId,
      repo.ownerType,
      repo.description,
      repo.language,
      repo.license,
      repo.stars,
      repo.forks,
      repo.watchers,
      repo.openIssues,
      JSON.stringify(repo.topics || []),
      Boolean(repo.archived),
      repo.defaultBranch,
      repo.pushedAt,
      repo.createdAt,
    ]
  );
}

/* The contributor graph for one package. Replaces the previous snapshot for
   that package rather than accumulating: GitHub's list is the current truth,
   and a contributor who has been removed from it should not linger. */
async function recordContributors(packageName, repositoryId, contributors) {
  if (!Array.isArray(contributors) || !contributors.length) return 0;

  for (const c of contributors) {
    await db.query(
      `insert into contributors (login, github_id, avatar_url, profile_url, retrieved_at)
       values ($1,$2,$3,$4, now())
       on conflict (login) do update set
         avatar_url = $3, profile_url = $4, retrieved_at = now()`,
      [c.login, c.githubId || null, c.avatarUrl || null, c.profileUrl || null]
    );
  }

  await db.query("delete from package_contributors where package_name = $1", [
    packageName,
  ]);

  let rank = 0;
  for (const c of contributors) {
    rank += 1;
    await db.query(
      `insert into package_contributors
         (package_name, contributor, repository_id, contributions, rank, retrieved_at)
       values ($1,$2,$3,$4,$5, now())
       on conflict (package_name, contributor) do update set
         contributions = $4, rank = $5, retrieved_at = now()`,
      [packageName, c.login, repositoryId || null, c.contributions ?? null, rank]
    );
  }
  return contributors.length;
}

const contributorsFor = (packageName) =>
  db.many(
    `select pc.contributor as login, pc.contributions, pc.rank, pc.retrieved_at,
            c.avatar_url, c.profile_url
       from package_contributors pc
       join contributors c on c.login = pc.contributor
      where pc.package_name = $1
      order by pc.rank
      limit 50`,
    [packageName]
  );

/* Every package a contributor appears on, which is the graph read the other
   way round. The basis for a future reputation model; no score is computed
   here, and none should be until there is one worth defending. */
const packagesForContributor = (login) =>
  db.many(
    `select pc.package_name, pc.contributions, pc.retrieved_at,
            p.description, p.latest_version, p.verified_owner_id
       from package_contributors pc
       join packages p on p.name = pc.package_name
      where lower(pc.contributor) = lower($1)
      order by pc.contributions desc nulls last
      limit 50`,
    [login]
  );

/* A download figure as npm reported it when it was read. Append-only: npm
   revises recent days, so a snapshot is a record of what was said then. */
async function recordDownloads(packageName, period, point) {
  if (!point || !Number.isFinite(point.downloads)) return null;
  return db.one(
    `insert into download_snapshots
       (id, package_name, period, downloads, period_start, period_end)
     values ($1,$2,$3,$4,$5,$6)
     returning *`,
    [
      crypto.randomUUID(),
      packageName,
      period,
      point.downloads,
      point.start || null,
      point.end || null,
    ]
  );
}

const downloadHistory = (packageName, limit) =>
  db.many(
    `select period, downloads, period_start, period_end, retrieved_at
       from download_snapshots where package_name = $1
      order by retrieved_at desc limit $2`,
    [packageName, limit]
  );

/* ================================================== verification trail === */

/* Append-only. Written for every check, pass or fail, so the history of a
   claim outlives whatever its current row happens to say. */
async function recordVerificationEvent(event) {
  await db.query(
    `insert into verification_events
       (id, claim_id, package_name, user_id, kind, passed, reason, detail)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      crypto.randomUUID(),
      event.claimId || null,
      event.packageName,
      event.userId,
      event.kind,
      Boolean(event.passed),
      event.reason || null,
      JSON.stringify(event.detail || {}),
    ]
  );
}

const verificationHistory = (packageName, limit) =>
  db.many(
    `select ve.kind, ve.passed, ve.reason, ve.detail, ve.created_at,
            u.github_login as actor
       from verification_events ve
       join users u on u.id = ve.user_id
      where ve.package_name = $1
      order by ve.created_at desc
      limit $2`,
    [packageName, limit || 20]
  );

/* ============================================================== audit ==== */

/* The actor always comes from the session, never from the request body. */
async function audit(action, { userId, login, subject, detail, clientHash }) {
  await db.query(
    `insert into audit_log
       (id, actor_user_id, actor_login, action, subject, detail, client_hash)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [
      crypto.randomUUID(),
      userId || null,
      login || null,
      action,
      subject || null,
      JSON.stringify(detail || {}),
      clientHash || null,
    ]
  );
}

module.exports.upsertRepository = upsertRepository;
module.exports.recordContributors = recordContributors;
module.exports.contributorsFor = contributorsFor;
module.exports.packagesForContributor = packagesForContributor;
module.exports.recordDownloads = recordDownloads;
module.exports.downloadHistory = downloadHistory;
module.exports.recordVerificationEvent = recordVerificationEvent;
module.exports.verificationHistory = verificationHistory;
module.exports.audit = audit;

/* ================================================ onchain registrations == */

/* Append-only. A new attempt is a new row: a replacement never erases the
   record of what was tried before it. */
async function recordRegistrationAttempt(attempt) {
  return db.one(
    `insert into onchain_registrations
       (id, package_name, identity_pda, program_id, cluster, authority, status)
     values ($1,$2,$3,$4,$5,$6,'prepared')
     returning *`,
    [
      crypto.randomUUID(),
      attempt.packageName,
      attempt.identityPda,
      attempt.programId,
      attempt.cluster,
      attempt.authority,
    ]
  );
}

const latestRegistration = (packageName) =>
  db.one(
    `select * from onchain_registrations where package_name = $1
      order by prepared_at desc limit 1`,
    [packageName]
  );

const registrationsFor = (packageName) =>
  db.many(
    `select * from onchain_registrations where package_name = $1
      order by prepared_at desc limit 20`,
    [packageName]
  );

/* Attach a signature to the most recent prepared attempt. Returns null when
   there is nothing prepared, so a signature cannot be recorded against a
   registration nobody asked for. */
async function attachSignature(packageName, signature) {
  const attempt = await db.one(
    `select * from onchain_registrations
      where package_name = $1 and status = 'prepared'
      order by prepared_at desc limit 1`,
    [packageName]
  );
  if (!attempt) return null;
  return db.one(
    `update onchain_registrations
        set tx_signature = $2, status = 'submitted', submitted_at = now()
      where id = $1
      returning *`,
    [attempt.id, signature]
  );
}

/* Write down what the chain said.

   `packages.identity_pda` is set only on a confirmed reconciliation, and only
   when it is not already set: that column is what every public surface reads
   to decide whether a package is onchain, so it must never be written on the
   strength of a client's say-so, and never overwritten by a later attempt. */
async function applyReconciliation(attemptId, packageName, result) {
  const terminal = {
    confirmed: "confirmed",
    failed: "failed",
    not_found: "dropped",
    inconsistent: "inconsistent",
  };
  const status = terminal[result.status] || "submitted";

  await db.query(
    `update onchain_registrations
        set status = $2,
            slot = $3,
            error = $4,
            confirmed_at = case when $2 = 'confirmed' then now() else confirmed_at end,
            reconciled_at = now()
      where id = $1`,
    [attemptId, status, result.slot || null, result.reason || null]
  );

  if (result.status !== "confirmed") {
    return { onchain: false, status };
  }

  const attempt = await db.one("select * from onchain_registrations where id = $1", [
    attemptId,
  ]);

  await db.query(
    `update packages
        set identity_pda = $2,
            identity_tx = $3,
            launched_at = coalesce(launched_at, now())
      where name = $1 and identity_pda is null`,
    [packageName, attempt.identity_pda, attempt.tx_signature]
  );

  await recordEvent("identity.registered", {
    packageName,
    payload: { address: attempt.identity_pda, signature: attempt.tx_signature },
  });

  return { onchain: true, status };
}

/* The repository a package declares, as GitHub reported it. The program
   records the immutable numeric id, not the name, because a repository can be
   renamed and the id cannot. */
async function repositoryFor(packageName) {
  const pkg = await db.one("select repo_owner, repo_name from packages where name = $1", [packageName]);
  if (!pkg || !pkg.repo_owner || !pkg.repo_name) return null;
  return db.one("select github_id, full_name from repositories where full_name = $1",
    [pkg.repo_owner + "/" + pkg.repo_name]);
}

module.exports.repositoryFor = repositoryFor;
module.exports.recordRegistrationAttempt = recordRegistrationAttempt;
module.exports.latestRegistration = latestRegistration;
module.exports.registrationsFor = registrationsFor;
module.exports.attachSignature = attachSignature;
module.exports.applyReconciliation = applyReconciliation;
