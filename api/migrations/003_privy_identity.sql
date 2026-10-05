-- Privy becomes the identity a session is built on, and GitHub becomes a
-- connection a user may or may not have made yet.
--
-- The users table was keyed on GitHub: github_id was not null and unique, so
-- a user could not exist without one. That is exactly backwards once signing
-- in is a Privy email or wallet login and GitHub is only produced later, to
-- prove authority over a particular repository.
--
-- Nothing is dropped and nothing is rewritten. Existing rows keep their
-- github_id and simply have no privy_did until that account signs in through
-- Privy and the two are linked.

alter table users add column if not exists privy_did text;

-- The new identity. Unique where present; Postgres allows many nulls in a
-- unique index, which is what lets the existing GitHub-only rows stand.
create unique index if not exists users_privy_did_idx on users (privy_did);

-- GitHub is now optional. The unique constraint on github_id stays, so two
-- accounts still cannot claim the same GitHub identity; it just no longer
-- has to be present.
alter table users alter column github_id drop not null;
alter table users alter column github_login drop not null;

-- How the account was created, so the interface can tell a Privy user who has
-- not linked GitHub from a legacy GitHub user who has never seen Privy.
alter table users add column if not exists privy_linked_at timestamptz;
alter table users add column if not exists github_linked_at timestamptz;

-- Backfill: every row that exists today arrived through GitHub.
update users set github_linked_at = created_at where github_id is not null and github_linked_at is null;
