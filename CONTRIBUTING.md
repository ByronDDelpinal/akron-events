# Contributing to Akron Pulse

Thanks for your interest in improving Akron Pulse. This project aggregates events
for Akron, OH & Summit County from ~50 sources and is built to be forked and
retargeted to other cities. Contributions of all kinds are welcome — bug fixes,
new data sources, documentation, accessibility improvements, and ideas.

By participating, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

---

## Ways to contribute

- **Report a bug** or **request a feature** — open an issue using the templates.
- **Add or fix a data source** — the most common contribution. See [Adding a data source](#adding-a-data-source).
- **Improve the frontend** — React 18 + Vite app under `src/`.
- **Improve docs** — `README.md`, `docs/ADAPTING.md`, or inline comments.

If you're planning a large change, please open an issue first so we can align on
the approach before you invest time.

---

## Development setup

Follow **[Local development setup](README.md#local-development-setup)** in the
README to clone, install, configure Supabase, and run the dev server. In short:

```bash
git clone <your-fork-url>
cd akron-events
npm install          # downloads Chromium for Puppeteer scrapers via postinstall
cp .env.example .env # then fill in the values documented in the README
npm run dev          # http://localhost:5173
```

You only need real credentials for the parts you're touching: the frontend needs
`VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`; individual scrapers need
`SUPABASE_SERVICE_ROLE_KEY` and any source-specific API keys.

---

## Before you open a pull request

Run the same checks CI runs:

```bash
npm run lint       # ESLint — must pass with zero warnings
npm run typecheck  # tsc --noEmit — type-checks all .ts/.tsx files
npm test           # node --test over scripts/tests/test-*.js
npm run build      # production build must succeed
```

Please make sure:

- New logic has tests where practical. Scraper parsing logic should have a test
  in `scripts/tests/` backed by a saved fixture in `scripts/tests/fixtures/` —
  never hit the live site from a test.
- You haven't committed secrets. `.env` is gitignored; never paste a
  `service_role` key, API key, or token into code, tests, or fixtures.
- Commit messages follow the existing convention: `feat:`, `fix:`, `chore:`,
  `docs:`, `refactor:`, `test:` (e.g. `feat: add kent stage scraper`).

### PRs that touch `supabase/migrations/` or RLS policies

CI has no database, so nothing in `.github/workflows/ci.yml` exercises a real
Postgres. Any PR that changes a migration touching RLS policies, a
SECURITY DEFINER function, or a moderation trigger needs a manual pre-merge
run of the matching file(s) in `supabase/tests/` against a local
`supabase start` database or a disposable Supabase branch:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/day_plan_rls.test.sql
```

A clean run prints `ALL DAY PLAN RLS TESTS PASSED`; any failure raises and
stops the script. This is a deliberate choice over a CI database container
(day-plan-audit.md Decision 4): several of these tests exercise
Supabase-specific extension behavior (`pgcrypto`, `pg_cron`,
`safeupdate`) that a generic Postgres container would have to shim, and a
shim that diverges from the real thing would let the suite pass while
production breaks — worse than not automating it. Revisit this if the
schema starts changing often enough that a human running the file by hand
becomes the actual bottleneck.

---

## Adding a data source

Each source has a script in `scripts/scrape-*.js` (or `fetch-*.js` for pure REST
APIs) that maps the source's raw data into the common event shape defined in
`scripts/lib/normalize.js`, then upserts it. Shared machinery —
`normalize.js`, `civicplus.js`, `squarespace.js`, `category-inference.js`,
`neighborhood-resolver.js` — lives in `scripts/lib/` and should be reused rather
than reimplemented.

When you add or rename a source, keep the source registry in sync. A new scraper
must be reflected in **all** of:

- `package.json` — add a `scrape:<source>` script (and to `scrape:all`).
- `src/pages/TechnicalPage.jsx` — `DATA_SOURCES`, `SOURCE_GROUP_BY_KEY`, and
  `SCRAPER_LABELS` (and `SOURCE_GROUPS` if the source uses a new platform).
- A test in `scripts/tests/` with a fixture.

Verify your scraper logs cleanly to the `scraper_runs` table and shows up in
`npm run health`.

---

## Reporting security issues

Please do **not** open a public issue for security vulnerabilities. See
[SECURITY.md](SECURITY.md) for responsible disclosure instructions.

---

## License

By contributing, you agree that your contributions will be licensed under the
project's [MIT License](LICENSE).
