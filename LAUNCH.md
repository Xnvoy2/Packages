# Launching Packages

The shortest safe path from here to public. Everything in section 1 is done;
section 2 is yours.

**What goes live:** the whole public product. Search any npm package, package
pages with real versions, downloads, contributors, provenance and verification
state, activity, discovery, how-it-works. All on live npm and GitHub data.

**What is dark at launch, by design:** GitHub sign-in needs an OAuth app you
create; onchain registration needs a program deployed to devnet, which is a
separate approval. Both fail honestly in the interface — the controls are
disabled with the reason shown, never offered and then broken.

---

## 1. Done

- One deployable service. `PACKAGES_EMBED_API=1` runs the API inside the
  static server: one process, one port, migrations applied on boot.
- Production refuses to start misconfigured: no `DATABASE_URL`, no 32-char
  `PACKAGES_SESSION_SECRET`, an in-memory database, or a non-https origin all
  stop the boot with the reason named.
- Migrations are numbered, checksummed and idempotent. Safe on every deploy.
- OAuth is complete bar the credentials. Adding the two values is the only
  step.
- `GITHUB_READ_TOKEN` is wired server-side and never reaches the browser.
- Canonical URLs, sitemap, robots and social card are generated from
  `PACKAGES_SITE_URL` at build time.
- 213 tests passing, 40 route/width browser combinations clean.

---

## 2. Yours

### a. A PostgreSQL database

Neon, Supabase, RDS, anything. Copy the connection string.

### b. A host that runs a node process

Render, Railway, Fly, a VM. **Not Vercel without a change** — see the note at
the bottom.

Settings:

```
Build command:  npm ci && PACKAGES_SITE_URL="https://your-domain" npm run build
Start command:  npm run start:prod
Health check:   /api/health
```

### c. Environment variables

```bash
NODE_ENV=production
DATABASE_URL="postgresql://..."          # from (a)
PACKAGES_SESSION_SECRET="..."            # see below
PACKAGES_SITE_ORIGIN="https://your-domain"
PACKAGES_EMBED_API=1
PORT=3000                                # or whatever the host sets

# Strongly recommended. Without it the whole server shares 60 GitHub requests
# an hour, which real traffic exhausts in minutes.
GITHUB_READ_TOKEN="github_pat_..."
```

Generate the secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Keep it. Rotating it signs everyone out and makes stored GitHub tokens
undecryptable.

### d. The GitHub read token — 2 minutes

GitHub → Settings → Developer settings → Personal access tokens → Fine-grained.
**No scopes, no repository access.** It only lifts the public read limit from
60/hour to 5000/hour. Set it as `GITHUB_READ_TOKEN`.

### e. Deploy

That is launch. The public product is live.

---

## 3. Turning sign-in on, whenever you like

Not required for launch, and nothing breaks without it.

1. GitHub → Settings → Developer settings → OAuth Apps → New.
2. Homepage URL: `https://your-domain`
3. Callback URL: `https://your-domain/api/auth/github/callback` — must match
   exactly.
4. Set three variables and redeploy:

```bash
GITHUB_CLIENT_ID="..."
GITHUB_CLIENT_SECRET="..."
GITHUB_CALLBACK_URL="https://your-domain/api/auth/github/callback"
```

**Test immediately after:** sign in with a real account and link a repository
you own. Whether GitHub returns the `permissions` block for a `read:user`
token has never been confirmed against a live app. The code fails closed — an
absent block is recorded as `permission_unknown`, never as "you do not own
this" — but confirm the behaviour. If the block is absent, the publish-proof
route still works and is the stronger proof anyway.

---

## 4. The onchain step

Still blocked on engineering that cannot be done on this machine, and it is
**not a launch blocker**: every onchain surface already reports that
registration is awaiting deployment.

The program type-checks and 13 Rust unit tests pass. What remains is the SBF
build, which needs either WSL (administrator rights and a reboot) or Visual
Studio Build Tools. On a Linux or macOS machine:

```bash
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install 0.30.1 && avm use 0.30.1

cd solana
anchor build
anchor test          # local validator, tests/package_identity.ts
```

Only once that passes is deployment worth discussing, and it needs your
explicit approval:

```bash
anchor deploy --provider.cluster devnet
# then set PACKAGES_PROGRAM_ID to the deployed id and redeploy the app
```

The client-side transaction builder is deliberately absent until the program
is built, because it needs the instruction layout that the build produces.
`launchIdentity()` says so plainly rather than pretending to send anything.

---

## Note on Vercel

The API lives in `api/`, and Vercel turns every file under `api/` into a public
endpoint — `api/lib/db.js` would become a reachable, 500-ing URL. Deploying
there needs the directories renamed with an underscore prefix (`api/_lib`,
`api/_routes`) so Vercel ignores them, plus a rewrite of `/api/*` to the single
handler.

A process host needs none of that and runs the code exactly as it was tested,
which is why it is the recommendation for launch day.
