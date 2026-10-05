# Deploying Packages

Nothing here has been deployed. This is the sequence to follow when you are
ready, and the external actions only you can perform.

> **Read [server/README-OWNERSHIP.md](server/README-OWNERSHIP.md) first.** This
> directory still contains a second, unrelated Patreon backend. Decide which
> product ships before deploying anything.

---

## 1. What runs

Two processes, and they are meant to share one origin.

| Process | Command | Serves |
|---|---|---|
| site | `npm run serve` | the generated `*.html`, `assets/`, `robots.txt` |
| api | `npm run api` | everything under `/api` |

`tools/serve.js` proxies `/api` to the api process in development. **In
production put both behind one domain** — a reverse proxy, or a static host
with a rewrite — because the session cookie is `SameSite=Lax` and a browser
will not send it on a cross-origin fetch. Splitting them across two domains
requires `SameSite=None; Secure`, which requires https on both.

`tools/serve.js` is a development server. It is loopback-only, and its
allowlist and security headers exist so the policy is exercised while
developing. In production serve `*.html`, `assets/`, `robots.txt` and
`sitemap.xml` from a real static host or CDN and send the same headers; see
section 6.

---

## 2. Build

```
npm ci
PACKAGES_SITE_URL="https://your-domain" npm run build
```

`PACKAGES_SITE_URL` is build-time only. Without it the build writes **no**
canonical urls, **no** Open Graph tags and **no** sitemap, and warns. That is
deliberate: a canonical url pointing at the wrong origin is worse than none.

Output: the eight root `*.html`, `assets/config.js`, `robots.txt`, and
`sitemap.xml`.

---

## 3. Database

PostgreSQL. Any version with `jsonb` and `timestamptz`, so 9.4 or later; 14+
is what this was developed against.

```
DATABASE_URL="postgresql://user:pass@host/db?sslmode=require" npm run migrate
```

Migrations are numbered files in `api/migrations/`, applied in order, recorded
in `schema_migrations` with a checksum. Running twice is a no-op, so this is
safe as a deploy step and safe to run on every boot. Editing an already-applied
migration is refused — add a new one.

The api also runs migrations on startup, so a deploy that forgets this step
still converges. Run it explicitly anyway, so a migration failure stops the
deploy rather than crash-looping the service.

**Backups.** Everything that cannot be re-derived lives in Postgres: accounts,
sessions, claims, the verification trail, wallets, and onchain registration
records. Package and repository data can be re-fetched from npm and GitHub, but
the verification history cannot be reconstructed from anywhere. Take a daily
`pg_dump` at minimum, and before every migration.

---

## 4. Environment

Every variable is documented in [.env.example](.env.example). The ones that
are mandatory in production:

| Variable | Why it is mandatory |
|---|---|
| `DATABASE_URL` | the only durable store |
| `PACKAGES_SESSION_SECRET` | 32+ characters. Signs sessions and encrypts stored GitHub tokens at rest. Rotating it signs everyone out and makes stored tokens undecryptable |
| `PACKAGES_SITE_ORIGIN` | must be `https://` in production, or the session cookie cannot be `Secure` |
| `NODE_ENV=production` | turns the checks below on |

With `NODE_ENV=production` the api **refuses to start** if any of those is
missing or if `PACKAGES_DEV_DB=memory` is set. It will start, with a warning,
without GitHub credentials or a Solana program id, because the product
degrades honestly without them.

Strongly recommended:

- `GITHUB_READ_TOKEN` — a fine-grained token with **no scopes**. Without it
  every server-side GitHub read shares one 60-requests-per-hour budget, which
  real traffic exhausts in minutes. With it, 5000.

Secrets go in the platform's secret store. `.env` is git-ignored; never commit
one.

---

## 5. Start

```
NODE_ENV=production npm run api      # api, default port 4790
```

**Health:** `GET /api/health` returns `{ ok, database, githubConfigured,
solanaProgramConfigured, uptimeSeconds }` and does not disclose the connection
string. `database: "up"` means a query succeeded, so it is a readiness probe
as well as a liveness one. Point the platform's health check at it.

**Logging:** one line per request — method, path, status, duration. Unexpected
throws log a stack trace to stderr and return a generic message to the client;
no credential or connection string is ever in a response body. Set
`PACKAGES_LOG=off` to silence the per-request line. There is no log shipping
built in: use the platform's stdout collection.

**Scaling:** the process is stateless apart from two in-memory caches, so it
scales horizontally. Note that rate limiting is per process, so N instances
means N times the configured budget; put a shared limiter at the edge if that
matters.

---

## 6. Headers the static host must send

`tools/serve.js` sends these; a production host must be configured to match.

```
content-security-policy: default-src 'self'; script-src 'self';
  style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
  font-src 'self' https://fonts.gstatic.com;
  img-src 'self' data: https://avatars.githubusercontent.com;
  connect-src 'self'; base-uri 'self'; form-action 'self';
  frame-ancestors 'none'; object-src 'none'
x-content-type-options: nosniff
referrer-policy: strict-origin-when-cross-origin
x-frame-options: DENY
permissions-policy: geolocation=(), microphone=(), camera=(), payment=()
strict-transport-security: max-age=63072000; includeSubDomains
```

`script-src` has no `'unsafe-inline'`, and the build keeps it that way by
writing the runtime config to `assets/config.js` instead of an inline script.
Do not add `'unsafe-inline'` to make something easier.

Add one rewrite: **`/p/*` → `/package.html`**. That is the permanent url for a
package page, and the only rewrite the site needs.

---

## 7. GitHub OAuth app

Only you can create this.

1. GitHub → Settings → Developer settings → OAuth Apps → New.
2. Homepage URL: your site origin.
3. Authorization callback URL: `https://your-domain/api/auth/github/callback`.
   It must match `GITHUB_CALLBACK_URL` exactly.
4. Put the client id and secret in the platform's secret store.

Scopes requested are `read:user` and `user:email` only. The product never asks
for repository write access and never asks for npm credentials.

**One caveat to test on the real app.** Repository permission is read from the
`permissions` block of `GET /repos/{owner}/{repo}`. Whether GitHub includes it
for a token holding only `read:user` has not been verified against a live OAuth
app — there were no credentials to test with. The code already handles its
absence: the result is recorded as `permission_unknown` and the user is told to
re-authorise with repository access or to prove the package directly, rather
than being told they do not own their own repository. Confirm the behaviour on
the real app and, if the block is absent, decide whether to request
`public_repo`.

---

## 8. Solana

The program in `solana/` is **not deployed and has never been compiled** —
there was no Rust toolchain available, and no disk space to install one.

Before deploying it:

1. Install Rust, Solana CLI and Anchor.
2. `cd solana && anchor build` — this is the first compile; expect to fix
   errors.
3. `anchor test` against a local validator.
4. Review `solana/THREAT-MODEL.md`.
5. Only then `anchor deploy --provider.cluster devnet`.
6. Set `PACKAGES_PROGRAM_ID` to the deployed id and restart the api.

Until step 6, wallet proof works and identity registration reports that it is
awaiting deployment. Nothing is ever sent to a cluster.

The client-side transaction builder is deliberately absent: it needs the
program's instruction layout, which only exists once the program is built.
`launchIdentity()` in `assets/js/app.js` expects a `window.PackagesTransaction`
function and says so plainly if it is missing, rather than pretending to send
anything.

---

## 9. Before you go live

- [ ] Decide which backend ships; delete the other
- [ ] `npm test` passes against the production-shaped database
- [ ] `npm run migrate` applied
- [ ] `NODE_ENV=production` and the api starts without complaint
- [ ] `GITHUB_READ_TOKEN` set
- [ ] OAuth app created and sign-in tested end to end with a real account
- [ ] `PACKAGES_SITE_URL` set at build time; canonical and sitemap verified
- [ ] Headers verified on the real host, CSP included
- [ ] `/p/*` rewrite verified
- [ ] Health check wired to `/api/health`
- [ ] Backups scheduled
- [ ] A real package verified end to end by a real developer
