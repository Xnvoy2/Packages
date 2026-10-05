# Packages

Existing npm packages get a verified public identity on Solana, linking the
package to its publisher, its source, its release history and its
contributors.

No token, no market, no price. An identity is a record of who publishes a
package and what they have released.

> **Two backends live in this directory.** A second session built a Patreon
> product (`server/app.js`, `prisma/`) here in parallel. Read section 0 of
> [RECONSTRUCTION_REPORT.md](RECONSTRUCTION_REPORT.md) before running anything;
> its README is preserved as [README.patronpad.md](README.patronpad.md).

## Run

```
npm install
npm run dev        # build + site + api   ->  http://127.0.0.1:4789/
```

`npm run dev` starts both processes. Without a `DATABASE_URL` the api uses an
in-memory database and says so; everything in it is lost on restart.

Separately:

```
npm run build      # regenerate the root html from src/pages
npm run serve      # the static site only, on :4789
npm run api        # the api only, on :4790
npm test           # 67 tests
node tools/pg-dev.js   # a throwaway PostgreSQL, prints its url
```

To run the suite against real PostgreSQL rather than pg-mem:

```
node tools/pg-dev.js                       # prints a connection string
DATABASE_URL=<that url> npm test
```

## How verification works

The rule the product exists to enforce, in `server/lib/verify.js`:

```
verified  <=  publish_proof
          OR  (repo_control AND trusted_publisher)
```

**Controlling a repository is not authority to publish a package.** Anyone can
put any repository url in a `package.json` and the npm registry does not check
it. So four facts are collected independently and only two combinations verify:

| Fact | Established by | Enough alone? |
|---|---|---|
| `repo_control` | GitHub reports push, maintain or admin for the signed-in user on the repository the package declares | **No** — yields the status `repo_linked` |
| `trusted_publisher` | npm's own SLSA provenance for a released version names that repository, compared by GitHub's **immutable numeric repository id** | No |
| `publish_proof` | a single-use string this server issued appears in a version manifest on the registry | **Yes** |
| `maintainer_email_match` | an npm maintainer email matches a *verified* GitHub email | **Never** — shown as "signal only" |

The id comparison matters: a repository can be renamed and its old full name
claimed by somebody else, so a name match is not a safe equality test.

## Layout

```
src/pages/*.html      page bodies, the only files edited for content
tools/build.js        injects the shared chrome, writes the root *.html
tools/serve.js        static server + /api proxy for development
tools/dev.js          runs both processes
tools/pg-dev.js       a throwaway PostgreSQL for tests
assets/css/style.css  the whole design system
assets/js/api.js      the one seam to the api; nothing else calls fetch
assets/js/ui.js       formatting and shared fragments
assets/js/app.js      motion system + one controller per page
server/index.js       the api: router, rate limiting, migrations
server/lib/           npm, github, verification, sessions, db, solana
solana/               the Anchor program (not deployed, not compiled)
*.html                generated - do not edit by hand
```

## What is real, and what is not

Working end to end today:

- npm registry search, packuments, download counts and series, all live
- GitHub repository, contributor, release and commit reads
- the full verification rule, including npm provenance parsing
- GitHub OAuth, sessions, claims, publish-proof challenges
- wallet ownership proof: a real ed25519 signature, verified server-side

Not working, and labelled as such on every surface that mentions it:

- **the Solana identity program is not deployed.** It has also never been
  compiled: there is no Rust toolchain on the development machine. Identity
  registration returns 503 with the blocker named, and nothing is ever sent to
  a cluster.
- GitHub sign-in needs `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`. Until they
  are set the site disables the control and explains why rather than offering
  a button that fails.

Nothing on the site invents a figure. Where npm or GitHub reports no value the
page renders an em dash.

## Design system

Colours are authored in `oklch` as custom properties on `:root`: a near-white
`--background`, near-black `--ink`, a violet accent, a coral for negatives, and
two shadow tokens. Type is Geist and Geist Mono, weight 500 for headings with
tight negative tracking. Breakpoints are 640 / 768 / 1024.

Text colours were lifted to a minimum alpha of 0.6 over the background, which
puts every piece of reading text at or above 4.5:1. The decorative `.world`
layer behind the hero is deliberately below that and is `aria-hidden`.

## Motion

CSS plus about 200 lines of vanilla JS. No animation library.

- the headline is split into per-word masks and rises into them, each word
  rotated a few degrees and straightening as it lands
- the floating panels assemble in sequence, animating `clip-path` and `filter`
  only, then hand over to the long `drift` loop, which owns `transform`
- the activity ticker is a `translate3d(-50%)` marquee over a duplicated track
- sections fade and rise in via `IntersectionObserver`, siblings staggered by
  document order
- the lifecycle strip is scroll-driven: a gradient rail fills, a bead tracks
  the progress, each step activates as the bead passes
- `prefers-reduced-motion` disables all of it, and the reduced-motion rules
  restate the end state rather than relying on a collapsed duration

## Security

The static server sends a CSP with no `script-src 'unsafe-inline'` — the
runtime config is written to `assets/config.js` by the build for exactly that
reason — plus `nosniff`, `frame-ancestors 'none'` and a referrer policy. A
production host must send the same headers.

The api keeps every credential server-side, stores only a sha256 of each
session token, encrypts the GitHub access token at rest with AES-256-GCM,
validates every input before it reaches a query or an outbound url, and rate
limits per client per route group.
