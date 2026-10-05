-- Packages schema, migration 002.
--
-- Three things 001 could not express:
--
--   1. Imported facts and verified facts were indistinguishable. A
--      contributor list read from GitHub and a publish authority proved here
--      are not the same kind of statement, and the schema now says which is
--      which: every imported row carries `source` and `retrieved_at`.
--
--   2. Verification history lived in the claim row, so it was overwritten
--      every time a check ran. A claim that passes, lapses and is re-proved
--      left no trace of the first two states. verification_events is
--      append-only and keeps all of it.
--
--   3. An onchain registration was two columns on `packages`, so a second
--      submission silently overwrote the first transaction signature.
--      onchain_registrations is append-only: a replacement is a new row with
--      its own status, and the previous one remains readable.

-- --------------------------------------------------------------- the graph --

-- A GitHub repository as GitHub described it at a point in time. Keyed by
-- GitHub's numeric id, which survives renames and transfers; the full name is
-- a snapshot and may be stale, which is what retrieved_at is for.
create table if not exists repositories (
  github_id     text primary key,
  owner_login   text not null,
  name          text not null,
  full_name     text not null,
  owner_id      text,
  owner_type    text,
  description   text,
  language      text,
  license       text,
  stars         int,
  forks         int,
  watchers      int,
  open_issues   int,
  topics        jsonb not null default '[]',
  archived      boolean not null default false,
  default_branch text,
  pushed_at     timestamptz,
  created_at    timestamptz,
  source        text not null default 'github_api',
  retrieved_at  timestamptz not null default now()
);

create index if not exists repositories_full_name_idx on repositories (full_name);

-- A person as GitHub describes them. Deliberately not joined to `users`: a
-- contributor login and a signed-in account may well be the same person, but
-- nothing here proves it, and inferring it would be inventing a fact.
create table if not exists contributors (
  login         text primary key,
  github_id     text,
  avatar_url    text,
  profile_url   text,
  source        text not null default 'github_api',
  retrieved_at  timestamptz not null default now()
);

-- The contribution relationship, with its evidence. `contributions` is
-- GitHub's own commit count for that repository, copied, not computed.
create table if not exists package_contributors (
  package_name   text not null references packages (name) on delete cascade,
  contributor    text not null references contributors (login),
  repository_id  text,
  contributions  int,
  rank           int,
  source         text not null default 'github_api',
  retrieved_at   timestamptz not null default now(),
  primary key (package_name, contributor)
);

create index if not exists package_contributors_contributor_idx
  on package_contributors (contributor);

-- A download figure as npm reported it, at the moment it was read. Append
-- only: npm revises recent days, and a snapshot is a record of what was said
-- then, not a running total to be updated.
create table if not exists download_snapshots (
  id            text primary key,
  package_name  text not null references packages (name) on delete cascade,
  period        text not null,
  downloads     bigint not null,
  period_start  date,
  period_end    date,
  source        text not null default 'npm_downloads_api',
  retrieved_at  timestamptz not null default now()
);

create index if not exists download_snapshots_pkg_idx
  on download_snapshots (package_name, retrieved_at);

-- ------------------------------------------------------ verification trail --

-- Append-only. One row per check that was run, whatever its outcome, so the
-- history of a claim survives the claim's current state being overwritten.
create table if not exists verification_events (
  id            text primary key,
  claim_id      text,
  package_name  text not null,
  user_id       text not null references users (id),
  kind          text not null,
  passed        boolean not null,
  reason        text,
  detail        jsonb not null default '{}',
  created_at    timestamptz not null default now()
);

create index if not exists verification_events_pkg_idx
  on verification_events (package_name, created_at);
create index if not exists verification_events_user_idx
  on verification_events (user_id, created_at);

-- ------------------------------------------------------------- the chain ---

-- Append-only. A submission is recorded before it is sent and updated only
-- along a one-way path: submitted -> confirmed | failed | dropped. A second
-- attempt is a new row, so a replacement never erases the record of what was
-- tried first.
create table if not exists onchain_registrations (
  id              text primary key,
  package_name    text not null references packages (name),
  identity_pda    text not null,
  program_id      text not null,
  cluster         text not null default 'devnet',
  authority       text,
  tx_signature    text,
  status          text not null default 'prepared',
  slot            bigint,
  error           text,
  prepared_at     timestamptz not null default now(),
  submitted_at    timestamptz,
  confirmed_at    timestamptz,
  -- When the server last checked the chain itself, rather than believing the
  -- browser. Null means nobody has independently confirmed this.
  reconciled_at   timestamptz
);

create unique index if not exists onchain_registrations_sig_idx
  on onchain_registrations (tx_signature);
create index if not exists onchain_registrations_pkg_idx
  on onchain_registrations (package_name, prepared_at);

-- Onchain release records, separate from `releases`, which is the registry's
-- history. A row here means a release was written to the chain.
create table if not exists onchain_releases (
  id            text primary key,
  package_name  text not null references packages (name),
  version       text not null,
  release_pda   text not null,
  record_hash   text not null,
  tx_signature  text,
  status        text not null default 'prepared',
  prepared_at   timestamptz not null default now(),
  confirmed_at  timestamptz,
  reconciled_at timestamptz
);

create unique index if not exists onchain_releases_pkg_version_idx
  on onchain_releases (package_name, version);

-- ---------------------------------------------------------------- audit ----

-- Who did what. Append-only, and never written with a value a user supplied
-- as identity: actor_user_id comes from the session, not from the body.
create table if not exists audit_log (
  id            text primary key,
  actor_user_id text,
  actor_login   text,
  action        text not null,
  subject       text,
  detail        jsonb not null default '{}',
  -- A salted hash, never the address: enough to correlate abuse, not enough
  -- to be a stored location record.
  client_hash   text,
  created_at    timestamptz not null default now()
);

create index if not exists audit_log_created_idx on audit_log (created_at);
create index if not exists audit_log_actor_idx on audit_log (actor_user_id, created_at);
