# Reconstruction report — Packages

Session of 2026-10-05. Updated as work proceeded.

---

## 0. The thing to read first: two backends in one directory

**A second session was writing into `NPM Pad/` at the same time as this one.**

File timestamps show two independent backends being written into `server/`
between 02:25 and 02:42:

| Backend | Entry point | Stack | Product |
|---|---|---|---|
| Packages (this session) | `server/index.js` | node http, `pg`, raw SQL in `server/lib/schema.sql` | npm package identity |
| PatronPad (other session) | `server/app.js` | Express 5, Prisma, `prisma/schema.prisma` | Patreon creator pages |

They share a directory and, in two cases, a filename. **`server/routes/auth.js`
and `server/routes/wallet.js` were written by both.** This session wrote them
last (02:35:18 and 02:36:52), so the Express app's versions of those two files
were overwritten and are not recoverable — the directory was untracked, so
there is no earlier copy in git.

Consequences:

- `server/app.js` requires `./routes/auth` and `./routes/wallet` and will throw
  on start: the files there now export the Packages handlers, not Express
  routers.
- `server/routes/packages.js` is this session's file.
- Everything else of the other session's is intact and untouched:
  `server/{app,db,env,middleware,serialise,sessions,validate}.js`,
  `server/security/*`, `server/routes/{patreon,creators,follows,profile}.js`,
  `prisma/`, `prisma.config.mjs`, `test/`, `tools/db-local.js`, `.env.example`.

**Decision required from the repository owner.** Two products cannot both be
the product. Either:

1. Keep Packages (npm identity, what this session was asked for). Then
   `server/app.js`, `prisma/`, `server/security/`, `server/{db,env,middleware,
   serialise,sessions,validate}.js`, `server/routes/{patreon,creators,follows,
   profile}.js`, `test/` and `tools/db-local.js` are dead and can be deleted,
   along with the `express`, `prisma`, `@prisma/*` and `dotenv` dependencies.
2. Keep PatronPad. Then this session's `server/index.js`, `server/lib/*`,
   `server/routes/{packages,claims,identity,activity}.js` and `server/test/`
   go, and `routes/auth.js` and `routes/wallet.js` must be rewritten, because
   this session destroyed them.

Nothing was deleted pending that decision. `package.json` lists both sets of
dependencies so either stack still installs.

**Recovery point: commit `b115e49`**, which contains the whole directory as it
stood after both sessions.

---

## 1. Starting state

`NPM Pad/` was a static front-end study: hand-written HTML, CSS and vanilla JS
modelled on gitpad.cc's layout and motion system, with no framework and no
dependencies. Three problems were found on inspection:

1. **The generated root HTML was two generations stale.** `tools/build.js` and
   `src/pages/*` had been rewritten for a Patreon product, but the root
   `*.html` files were still the earlier npm-package-launch build: `npmpad`
   wordmark, a `$NPMPAD` contract-address bar, a markets grid. `connect.html`,
   `dashboard.html` and `creator.html` did not exist at the root at all.
2. **`assets/js/app.js` was from that same older generation.** It rendered
   `[data-markets]`, a token ledger and a repo composer; nothing rendered
   `[data-creators]`, so those grids were permanently empty. Its ticker
   renderer read `t.ticker`/`t.repo` from what had become an array of strings,
   so it would have printed `undefined`.
3. A third claim made during inspection — that the stylesheet lacked rules for
   the newer components — **was wrong**. `.panel`, `.notice`, `.creator`,
   `.verified`, `.status-chip`, `.scopes`, `.profile` and `.tiers` were all
   present from line 1292 onward. The grep that reported zero matches was
   malformed. Corrected before any CSS was written.

---

## 2. What was built

### Product

Packages: existing npm packages get a verified public identity on Solana,
linking publisher, source, release history and contributors. No token, no
market, no price, nothing for sale.

### Verification — the part that matters

The rule, enforced in one place (`server/lib/verify.js`) and asserted by tests:

```
verified  <=  publish_proof
          OR  (repo_control AND trusted_publisher)
```

Four independent facts, each checked rather than assumed:

| Fact | How it is established | Sufficient alone? |
|---|---|---|
| `repo_control` | GitHub API, with the user's own token, reports push/maintain/admin on the repository the package declares | **No** → status `repo_linked` |
| `trusted_publisher` | npm's SLSA provenance attestation for a published version names that repository **by GitHub's immutable numeric id** | No |
| `publish_proof` | a single-use string this server issued appears in a version manifest on the registry | **Yes** |
| `maintainer_email_match` | an npm maintainer email equals a *verified* GitHub email | **Never** — labelled "signal only" in the UI |

Repository control is explicitly not publish authority: anyone can put any
repository url in a `package.json` and npm does not check it. Provenance is
compared by numeric repository id because a repository can be renamed and its
old name claimed by someone else. Verified live against `react`, whose declared
repo (`react/react`) differs from the repo its provenance names
(id `10270250`, facebook/react) — exactly the case the design exists for.

### Frontend

Eight pages, all generated from `src/pages/*` by `tools/build.js`:
`index`, `explore`, `package` (new), `connect`, `activity`, `how-it-works`,
`dashboard`, `creator`. The design system, hero panel composition, drift
animation, ticker, scroll reveals and lifecycle strip were preserved; the
marketplace class vocabulary (`.market*`, `.chip-ticker`) was renamed to
`.pkg*`/`.chip-tag` without changing a single property.

Permanent package pages at `/p/<name>`, scoped names included.

### Backend

`server/index.js` — node http, no framework. npm registry + downloads API,
GitHub OAuth, PostgreSQL via `pg`, server-side sessions, per-route token-bucket
rate limiting, input validation on every path, TTL cache with request
coalescing.

### Solana

`solana/programs/package_identity/src/lib.rs` — Anchor program, **not
deployed and not compiled** (no Rust toolchain on this machine). Deterministic
PDAs matching the server's derivation, registrar-authorised registration,
append-only release records with no instruction that can rewrite one.

Wallet proof is complete and works today: the server issues the message, the
wallet signs it, ed25519 is verified server-side. No transaction is ever built
or sent.

---

## 3. Bugs found and fixed during the session

| # | Bug | Fix |
|---|---|---|
| 1 | Root HTML two generations stale; three pages missing | Rebuilt all eight from source |
| 2 | `app.js` rendered a markets grid that no page had | Rewritten as per-page controllers |
| 3 | Static server served `server/lib/env.js`, `package.json`, `src/`, `node_modules/` over HTTP | Allowlist: root `*.html`, `assets/`, `site.webmanifest`, nothing else |
| 4 | `/p/<name>` broke every relative URL — scripts 404'd into HTML, producing `SyntaxError: Unexpected token '<'` | All internal URLs made root-absolute; rewrite restricted to extension-less paths |
| 5 | Session cookie could never work: `SameSite=Lax` is not sent on cross-origin fetch, and site:4789 → api:4790 is cross-origin | Dev server proxies `/api`, so dev is same-origin like production |
| 6 | npm 429 reported to users as "the registry is not responding" | `describeFailure()` distinguishes rate-limiting, 5xx and network failure |
| 7 | An orphaned dev server from a previous session held :4789, serving stale code and masking every change | Identified by PID and start time, stopped |
| 8 | Test `skip` flags evaluated at module load, before the connectivity probe ran — nine tests silently skipped | Skip from inside the test |
| 9 | Rate-limit test used a 60-token bucket it could not exhaust | Switched to a DB-only route and sized the burst from `LIMITS` |

---

## 4. Tests

`npm test` — 67 tests, **67 passing**, run twice: against pg-mem, and against a
real PostgreSQL server started by `node tools/pg-dev.js`. Identical results.

Coverage includes the verification rule table, npm name grammar and traversal
rejection, every shape of the `repository` field, the router's scoped-name
handling, rate limiting, session forgery and expiry, and the full wallet proof
with a real ed25519 keypair — including a signature from the wrong key, a
message the server did not issue, and a replayed challenge, all correctly
refused.

Browser testing: headless Chrome over CDP, all eight routes, desktop and
mobile, with console errors, failed requests and layout overflow captured.

---

## 5. Decisions taken without asking

- **No GSAP.** The brief lists it as an option "where appropriate". This site
  is dependency-free, hand-written, and its motion system is already CSS plus
  ~60 lines of JS. Adding a ~70 kB CDN library to deliver the requested
  techniques would cost more in load time than it buys. The preferred
  techniques were implemented natively instead.
- **pg-mem for local development and tests**, running the same SQL as
  production rather than a second implementation.
- **No npm credentials are accepted anywhere.** The publish proof asks the user
  to publish; that is why it proves something.
- Package pages are canonical at `/p/<name>`.

---

## 6. Reconstruction mode — second pass

### Motion (Phase 4)

Added, all on the first screen, none of it looping:

- **Masked word-by-word headline reveal.** `app.js` splits the headline into
  per-word spans inside `overflow: hidden` masks; each rises from below rotated
  4° and straightens as it lands, 55 ms apart. The markup is only ever added,
  so without script the headline is plain legible text.
- **Sequential panel assembly.** The six hero panels build in order from the
  headline outward, then hand over to the existing 18 s `drift` loop. The
  entrance animates `clip-path` and `filter` only — `drift` owns `transform`
  and each panel's class owns `opacity`, so the three never contend for a
  property. Both animations are declared together with per-slot delays as
  custom properties, because a second `animation` declaration would replace
  the first.
- **Restrained supporting pop-ins** for the sub-head, CTAs, status and graph.

No GSAP: see decisions. No font-size animation, no parallax, no particles.
`prefers-reduced-motion` disables all of it, and the reduced-motion block
restates the end state directly rather than relying on a collapsed duration.

### Accessibility (Phases 3, 10)

Contrast was measured in-browser by painting each computed colour onto a
canvas and reading the pixel back — necessary because Chrome returns `oklch()`
verbatim from `getComputedStyle`, and parsing those numbers as RGB (the first
attempt) produced nonsense like 1.00:1 for black on white.

Measured failures against WCAG AA: 14 on the package page, 18 on the homepage,
12 on connect. Every muted text token sat between 2.56:1 and 4.40:1.

Fixed by lifting the ink alpha floor to 0.6 across 43 declarations, which puts
all reading text at or above 4.5:1 while keeping the hue and the airy feel.
Re-measured: **0 failures** on package and connect; the homepage's remaining
three are the decorative `.world` layer, which is inside `aria-hidden="true"`
and deliberately below the floor — darkening it would turn background texture
into content competing with the headline.

Also added: a skip link as the first tab stop, a visible `:focus-visible` ring
on every interactive element, `.sr-only` restored as a real utility, and
`scroll-margin-top` so a focused target does not land under the fixed nav.

### Security (Phase 7)

- CSP with **no `script-src 'unsafe-inline'`**. The build now writes the
  runtime config to `assets/config.js` specifically so the inline `<script>`
  could be removed. Plus `nosniff`, `frame-ancestors 'none'`,
  `x-frame-options`, a referrer policy and a permissions policy. Verified in
  the browser: no CSP violations on any page.
- `npm audit`: 8 advisories. Four (`prisma`, `@prisma/config`, `mysql2`,
  `deepmerge-ts`) belong to the other session's stack. Three moderate ones
  reach `@solana/web3.js` through `jayson`, its JSON-RPC client — this code
  imports `PublicKey` and nothing else, so that client is never invoked.
  Clearing them needs web3.js v2, a major upgrade, which is not done without
  approval.

### Launch preparation (Phase 10)

- `robots.txt` always written; `sitemap.xml`, canonical URLs and Open Graph
  tags only when `PACKAGES_SITE_URL` is set. **The build refuses to invent an
  origin** and warns instead — a canonical pointing at 127.0.0.1 would be
  worse than none.
- `assets/og.png`, 1200×630, rendered locally from `tools/og-card.html` using
  the site's own tokens and mark, so it cannot drift from the design.
- Favicon and webmanifest updated to the package mark.
- README rewritten for Packages; the PatronPad one preserved as
  `README.patronpad.md`. `.env.example` extended with a clearly separated
  Packages section rather than overwritten.

### Further bugs found and fixed in this pass

| # | Bug | Fix |
|---|---|---|
| 10 | The static allowlist I added blocked `robots.txt` and `sitemap.xml` | Added them to the allowlist with `.txt`/`.xml` types |
| 11 | **The test suite wrote fixtures into whatever `DATABASE_URL` it was given.** A run against the dev database left `owned-pkg` and `identity-test-pkg` marked *verified*, and the homepage showed them as verified packages | The suite now refuses any database whose name does not contain "test" unless explicitly overridden |
| 12 | Tests were not idempotent: fixed logins and fixed package names collided with the previous run's rows, failing 2 tests on a second run | Every account and fixture name is suffixed with a per-run id |
| 13 | The suite left its rows behind even on success | `test.after` removes this run's users, claims, sessions, wallets, challenges and fixture packages, and releases any ownership asserted over real ones |

### Tests

`npm test` — 67 tests, **67 passing**, run four times:

1. pg-mem (in-memory)
2. real PostgreSQL
3. the *same* PostgreSQL again, proving idempotency
4. again after the self-cleanup was added, leaving no rows behind

### Verified limitation

GitHub's unauthenticated limit of 60 requests an hour for the whole server was
exhausted by this session's own testing. The product degraded exactly as
designed: `/api/packages/:name/contributors` returned `rateLimited: true` with
an empty list and the page said so, rather than showing a wrong number. This
makes `GITHUB_READ_TOKEN` a launch requirement, not an optimisation.

---

## 7. Technical completion pass

### Isolation (Phase 0)

The Packages backend moved to `api/`. `server/` is now solely the Patreon
project and carries `server/README-OWNERSHIP.md` stating what each side owns,
what was destroyed, and what to delete depending on which product ships.
`npm run api`, `npm test` and `npm run dev` load only `api/`.

The two overwritten files (`routes/auth.js`, `routes/wallet.js`) moved with the
Packages code, so the Express app now fails with module-not-found rather than a
subtle type error. Still a failure, but a legible one.

### Data model (Phase 4)

A real migration runner replaced the single schema file: numbered files,
checksummed, applied once, recorded in `schema_migrations`. Editing an applied
migration is refused. Verified on a brand-new PostgreSQL database and on a
second run.

`002_graph_and_audit.sql` adds what the model was missing:

- `repositories`, `contributors`, `package_contributors`, `download_snapshots`,
  every row carrying `source` and `retrieved_at`, which is the line between an
  imported fact and a verified one
- `verification_events`, append-only, so a claim's history survives the claim
  row being overwritten
- `onchain_registrations`, `onchain_releases`, append-only, so a second
  submission cannot erase the record of the first
- `audit_log`, actor always from the session, never from the body

### Solana (Phase 5)

**The toolchain could not be installed: 2.2 GB free on a 465 GB disk.** Rust
plus Anchor plus a crate graph needs considerably more, and filling the disk is
a destructive system change. The program has still never been compiled.

Two real defects were found by reading it, and fixed:

1. **Most of npm was unregistrable.** The seed used the package name literally
   when it fitted in 32 bytes. A Solana seed is capped at 32 bytes and npm
   allows 214 characters, so any longer name had no reachable address. The name
   is now always hashed, which also removes the second seed scheme and with it
   any chance of the two colliding. `api/lib/solana.js` was changed to match,
   and a test asserts the two derivations are byte-identical.
2. **The registrar was trusted to canonicalise.** `Foo` and `foo` hash
   differently, so one package could have held two identities. The program now
   enforces npm's name grammar itself.

`solana/THREAT-MODEL.md` works through ten attacks and names what answers each,
including the ones that are not fully answered.
`solana/tests/package_identity.ts` is written and has never been run.

### The chain (Phase 6)

Registration is a three-call lifecycle: prepare, submitted, reconcile. The
third is the point. `api/lib/chain.js` asks an RPC node whether the signature
succeeded, whether an account exists at the derived address, **and whether that
account is owned by our program**. All three must agree before a package is
marked onchain. Existence alone is not accepted, because anyone can create an
account at a derived address through a different program.

Verified against real devnet: blockhash, block height, an account that exists
but is not ours, an empty address, an unknown signature.

### Front end (Phase 7)

- Verification is now **a set of badges**, each naming one established fact:
  "npm publisher verified", "GitHub repository control verified", "GitHub
  repository linked", "provenance available", "wallet verified", "onchain
  registered". There is no generic "verified" badge, because the facts are not
  interchangeable. A package that merely declares a repository gets "GitHub
  repository linked", which is a statement about a package.json field.
- The launch journey is the six named stages.
- npm's deprecation notice and tarball integrity are surfaced; both were being
  read and discarded.
- The contribution graph appears on a developer page, labelled an imported fact
  and explicitly not evidence that the npm and GitHub accounts are one person.

### Security (Phase 9)

`api/test/security.test.js`, 23 tests that attack the running server: SQL
injection through names, search and logins; markup and `javascript:` urls from
upstream metadata; CORS and preflight from a hostile origin; OAuth state
mismatch and absence; session tokens offered via header and query string; proof
that only a sha256 of the token is stored; that logout destroys the session
server-side; cross-account authorisation on all three identity routes; SSRF
through package names; oversized bodies; forged `x-forwarded-for`; wallet
challenge replay and cross-account reuse; and that no error leaks a connection
string, token or stack trace.

One real bug found and fixed: an oversized body destroyed the socket, so the
client saw a connection reset rather than a refusal. It now answers 413 and
closes afterwards.

### Performance (Phase 11)

Measured, not guessed. A complete page including all CSS and JS is **39 kB
gzipped** with no framework. Twelve requests, no waterfall, one API call per
page. Cache working: featured 1.28 s cold to 3 ms warm.

One regression found: `/api/config` made a live devnet RPC call on every page
load, 61 ms each. Cached for a minute: now 1.7 ms. No other optimisation was
warranted and none was made.

### Production (Phase 12)

With `NODE_ENV=production` the api now **refuses to start** without
`DATABASE_URL`, without a 32-character `PACKAGES_SESSION_SECRET`, with
`PACKAGES_DEV_DB=memory`, or with a non-https site origin, each of which would
otherwise fail quietly and expensively. Verified by running it.

`DEPLOYMENT.md` documents the whole sequence, the headers a host must send, the
`/p/*` rewrite, backups, logging, scaling, and the OAuth caveat that could not
be tested without credentials.

### Further bugs found and fixed

| # | Bug | Fix |
|---|---|---|
| 14 | Packages over 32 bytes could never be registered onchain | always hash the name into the seed |
| 15 | The program trusted the registrar to canonicalise names, so one package could hold two identities | npm grammar enforced on chain |
| 16 | `recordDownloads` called with a bare identifier, 500ing every package page | quoting lost to shell escaping; restored |
| 17 | Oversized request bodies reset the connection instead of being refused | 413, then close |
| 18 | The test suite could leave fixtures in any database it was pointed at | refuses a database not named as a test one; fixtures uniquified; self-cleanup |
| 19 | `/api/config` hit devnet RPC on every page load | cached 60 s |
| 20 | The sha512 integrity hash forced the package page grid 817 px wide at 390 px | `min-width: 0` on the grid items |
| 21 | `robots.txt` was blocked by my own static allowlist | allowlisted, with `.txt` and `.xml` types |

### Final verification

- Fresh PostgreSQL database created, migrations applied, **97 tests passing**;
  run again on the same database, 97 passing, proving idempotency and cleanup.
- 97 passing on pg-mem.
- All 8 routes at 1920, 1440, 1024, 768, 390 and 375: **48 combinations, zero
  overflow, zero console errors, zero page errors.**
- Reduced motion: headline not split, content visible, no errors.
- Keyboard: skip link is the first tab stop and reveals on focus (-52 px to 10
  px), every control has a focus ring, no positive tabindex.
- `npm audit`: four moderate advisories reachable from the api, all inside
  `jayson`, the JSON-RPC client in `@solana/web3.js` that this code never
  invokes, since it imports `PublicKey` only. Clearing them needs web3.js v2, a
  major upgrade. Four high advisories belong to the other backend's Prisma
  stack.
- No secrets in the tree, no `.env` tracked, nothing stray staged.

---

## 8. Correctness and completion pass

Working through the mandate against what had actually been delivered, four
things were missing rather than merely unpolished.

### Transactions

There were none. `applyClaimUpdate` marked a claim verified and recorded the
package's owner as two separate statements; a failure between them left a claim
saying "verified" with nobody owning the package, or a package owned by an
account whose claim did not say so. Neither is detectable by a later read.

`db.transaction()` now wraps both, and the ownership read takes `FOR UPDATE`.
Without the lock, two accounts proving the same package at the same moment both
read "no owner" and the second silently won.

**pg-mem accepts `BEGIN` and `ROLLBACK` and then keeps the rows anyway.** A
transaction test passing against it would prove the opposite of what it claims,
so `api/test/integrity.test.js` skips loudly unless `DATABASE_URL` points at a
real server. Ten cases, including two accounts racing for one package.

### Revocation

Withdrawing a claim deleted the row, and the history with it. An attacker who
got into an account could prove a package, act on it, and tidy up. There is now
`revokeVerification()`: the package is released, the claim records that it was
revoked, and the append-only trail keeps both the verification and its
withdrawal, with the reason recorded verbatim.

### Pagination

GitHub contributor reads stopped at one page and said nothing about it.
`paginate()` follows further pages, bounded, and reports truncation. Verified
against facebook/react: 150 contributors across two pages, flagged truncated.

### Testability

`reconcileRegistration` and `checkRepoControl` now take their reads as injected
dependencies, defaulting to the real ones. Nothing in the running product is
mocked; every branch is reachable in a test without a cluster or credentials.
That made 15 reconciliation cases and 18 GitHub contract cases possible.

### Two findings from the live APIs

- **stevemao/left-pad has been transferred** to the `left-pad` organisation.
- **facebook/react is now react/react.**

Both kept their numeric id. These are the exact scenario the design exists for,
observed in the wild: a name comparison gets both wrong today, an id comparison
got them right before and after. The test assertions were wrong, not the code.

### Layout shift

Measured for the first time, and bad: **CLS 0.5447** on the package page and
0.1842 on explore, against a 0.1 threshold. The skeleton was 212 px where the
real card is 337 px, and the package page reserved nothing at all for roughly
2000 px of content, so everything below jumped when it arrived.

Async regions now reserve approximately what they will occupy and release it
via `.is-loaded`. Re-measured: **0.0002** on the package page, 0.0040 on
explore, no leftover gap on short pages.

### Further bugs found and fixed

| # | Bug | Fix |
|---|---|---|
| 22 | No transaction boundaries; a half-written verification was possible | `db.transaction()`, with `FOR UPDATE` on the ownership read |
| 23 | Withdrawing a claim erased that it was ever verified | `revokeVerification()` keeps the trail |
| 24 | Contributor lists silently stopped at 100 | real pagination, with truncation reported |
| 25 | `t.skip()` does not stop a test body, so skipped tests ran their assertions and failed after being reported as skipped | the helpers return a boolean the caller acts on |
| 26 | CLS 0.54 on the package page | reserve and release space around async content |
| 27 | A 502 from the dev proxy read as a generic error, not as "the API is down" | treated as unreachable, which is what it means |

### Final state

- **140 tests. 0 failures.** 123 pass on pg-mem (17 skipped: real-Postgres and
  GitHub-budget cases), 133 pass on real PostgreSQL (7 skipped: GitHub budget).
- All 8 routes at 1920, 1440, 1024, 768, 390 and 375: 48 combinations clean.
- Degraded states browser-verified: API unreachable, missing package, scoped
  package, a package with no repository and no license (`indexof`), no session.
- CLS under 0.005 on every measured page.
