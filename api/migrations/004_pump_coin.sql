-- The coin a verified package was launched as.
--
-- Separate from identity_pda on purpose: the identity is a record this
-- service makes and pays for, while the coin is created by the publisher's
-- own wallet. One can exist without the other, and the page has to be able
-- to say which.

alter table packages add column if not exists coin_mint text;
alter table packages add column if not exists coin_tx text;
alter table packages add column if not exists coin_creator text;
alter table packages add column if not exists coin_launched_at timestamptz;

-- One coin per package. A unique index rather than a check in code, so a
-- retry or two tabs cannot produce two coins for one package.
create unique index if not exists packages_coin_mint_idx on packages (coin_mint)
  where coin_mint is not null;
