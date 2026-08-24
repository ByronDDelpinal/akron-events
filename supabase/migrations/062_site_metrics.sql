-- ════════════════════════════════════════════════════════════════════════════
-- 062_site_metrics.sql
--
-- Storage for GA4 traffic, so the Slack bot can answer "how many people
-- visited", "traffic this week vs last", "top pages", "outbound clicks",
-- "embed traffic" and "installs" from Postgres instead of refusing.
--
-- MIGRATION NUMBER: 062. 061_partner_accounts.sql is the highest applied. 047
-- is missing from the sequence and stays missing (057's header records it as
-- reserved by an unlanded branch); nothing here fills it. NOTE for whoever
-- lands the Slack queue next: the Tier 3 ADR planned 062 and 063 for the queue
-- tables. This migration takes 062, so those shift to 063 and 064.
--
-- ── WHAT THIS IS ────────────────────────────────────────────────────────────
-- Three write-only-by-a-nightly-job fact tables at three grains. They are
-- filled by scripts/ga-to-db.js, which runs the same reports six existing
-- scripts already run (ga-snapshot, ga-top-pages, ga-outbound-by-event,
-- ga-embeds-snapshot, ga-install-snapshot, ga-impact) and upserts instead of
-- printing to stdout. No GA4 credential goes anywhere near an edge function:
-- the bot reads these tables with the service role and never calls Google.
--
-- ── THE CONTRACT, AND THE ONE THING EVERY READER MUST KNOW ──────────────────
--
--   GA IS A FLOOR, NOT A COUNT.
--
-- Every number in these three tables comes from Google Analytics 4 (property
-- 538991588) and is therefore an UNDER-COUNT of reality, by an unknown and
-- non-constant margin:
--   * ad blockers, Firefox/Safari tracking protection and DNS blocklists drop
--     the beacon entirely. The maintainer's own browser network-blocks
--     google-analytics.com, so his own visits are not in here at all.
--   * GA4 applies thresholding and (at higher volume) sampling.
--   * a visit with JavaScript off, or a bot that renders nothing, is invisible.
-- Nothing downstream may present these as exact. Anything that renders them
-- must carry a visible floor marker ("~", "at least", "GA-measured"). The
-- correct reading of `page_views = 412` is "at least 412", never "412".
--
-- SECOND CAVEAT, EQUALLY LOAD-BEARING: user counts are NOT ADDITIVE ACROSS
-- ROWS. `total_users` is GA4's distinct-user count FOR THAT DAY. Summing seven
-- days of it counts a person who came back on Tuesday twice. That sum is a
-- real quantity and a useful one, but it is "visitor-days", not visitors, and
-- must be labelled as such. Page views, sessions and event counts ARE additive
-- and may be summed freely. The two rolling distinct-user columns on
-- site_metrics_daily (pwa_users_7d / pwa_users_28d) exist precisely because a
-- true distinct-user figure over a window can only come from GA4 itself.
--
-- THIRD CAVEAT: GA4 REVISES RECENT DATA. Figures for the last ~48 hours keep
-- moving as late hits, session stitching and identity resolution land. That is
-- why the loader re-writes a trailing window rather than writing yesterday
-- once, and why every row carries `fetched_at`: a row whose fetched_at is
-- within two days of its metric_date is provisional.
--
-- ── GRAIN, AND WHY THESE THREE TABLES ───────────────────────────────────────
--
--   site_metrics_daily    one row per Eastern calendar date. The site-wide
--                         headline: visitors, page views, sessions, outbound
--                         clicks, PWA launches.
--   page_metrics_daily    one row per (date, page path). Serves BOTH "top
--                         pages" and the per-event questions, because a
--                         separate per-event table would be this table with a
--                         WHERE clause and would then have to be kept
--                         consistent with it. `event_id` is populated for
--                         event detail pages only (NULL for /, /events,
--                         /submit, ...), so "per event" is
--                         `where event_id is not null` and the join is
--                         `join events on events.id = event_id`. This is the
--                         highest-value table in the migration: per-event
--                         outbound clicks are the only measurement of what the
--                         site actually does for an organiser.
--
--                         THE JOIN KEY IS events.id, NOT events.slug, AND THIS
--                         IS NOT A STYLE CHOICE. An event detail URL is
--                         /events/{url-slug}/{uuid}, and the url-slug in the
--                         path is a DATE-suffixed display slug
--                         ("ales-on-rails-aug-21") while events.slug is
--                         YEAR-suffixed ("ales-on-rails-2026"). Verified
--                         against production: 11,318 of 11,321 published rows
--                         are year-suffixed, and four url-slugs sampled from
--                         live GA4 data matched ZERO rows on events.slug while
--                         all four uuids matched events.id exactly. Joining on
--                         the path slug returns nothing, silently. The
--                         url-slug is still stored, as `url_slug`, because it
--                         is the readable label a reply shows; it is a label,
--                         never a key.
--   embed_metrics_daily   one row per (date, embed host). Partner-site reach.
--
-- Every grain is a NATURAL primary key over the dimensions, so the loader's
-- `insert ... on conflict do update` is idempotent: re-running yesterday, or
-- backfilling from 2026-05-27 twice, overwrites in place and can never
-- duplicate a day. There is no surrogate id anywhere, deliberately -- a
-- serial id would make a duplicate day insertable.
--
-- Amounts are `integer`: GA4 returns whole counts and the largest plausible
-- daily value here is five digits.
--
-- ── ACCESS: NO ANON POLICY, AND NO BARE `authenticated` EITHER ──────────────
--
-- Two separate mistakes are being avoided here, and the second one is the
-- easier to make.
--
-- NO ANON. 004_anon_scraper_health.sql granted anon SELECT on scraper_runs and
-- scraper_health so a public "Technical Details" page could read ops data
-- without auth. That is a known smell and is not repeated. Reasons:
--   1. Nothing in the frontend reads these tables. The only consumer is the
--      Slack bot, which uses the SERVICE ROLE and bypasses RLS entirely. An
--      anon grant would buy exactly nothing today.
--   2. Business metrics are not community transparency. Traffic, install
--      counts and partner-embed volumes are the maintainer's numbers, and
--      once a table is publicly readable it is publicly readable forever --
--      un-granting it later breaks whoever started depending on it.
--   3. page_metrics_daily.page_path is a URL path. Any future page that puts a
--      token, an email or a preview id in a path would publish it here, and
--      the person adding that page would have no reason to think about this
--      table. Keeping anon out means that class of leak cannot happen.
--
-- NO `using (true)` FOR `authenticated`. ⚠️  This is the trap. Migrations 038
-- and 051 did write "Authenticated can read email_sends" / "Authenticated can
-- read embed_requests" with `using (true)`, and THOSE POLICIES NO LONGER
-- EXIST: 059_admin_boundary.sql rewrote fifteen of them to replace "is there a
-- session" with `is_admin()`. Production today carries `Admin can read
-- email_sends`, `Admin can read embed_requests` and `Admin full access
-- partner_orgs`. Copying the pre-059 pattern into a new table would re-open
-- exactly the hole 059 exists to close, and 059's own header states it:
-- creating ANY Supabase Auth user would otherwise produce another full
-- administrator. `subscribers.auth_user_id` exists, so ordinary subscribers
-- can and do hold auth accounts; `using (true)` would hand every one of them
-- the site's traffic figures, every page path the site has ever served, and
-- partner embed volumes. All three policies below are gated on `is_admin()`.
--
-- So: RLS enabled, service-role writes and reads, admin-only SELECT, anon
-- explicitly revoked. If a public traffic widget is ever wanted, it should get
-- its own narrow VIEW with its own grant, not a blanket grant on these tables.
-- ════════════════════════════════════════════════════════════════════════════

begin;

-- ── 1. Site-wide daily ──────────────────────────────────────────────────────
--
-- metric_date is the Eastern calendar date, because that is what the GA4
-- property's own timezone is (America/New_York -- ga-impact.js reads it from
-- the property metadata rather than assuming) and what every other date in
-- this codebase means. It is a `date`, not a timestamptz: the grain is a day
-- and storing an instant would invite someone to compare it against now().
create table site_metrics_daily (
  metric_date            date primary key,

  -- Audience. active_users and total_users differ in GA4 (engagement-gated vs
  -- not) and both are kept: the briefing scripts read totalUsers, ga-impact
  -- reads activeUsers, and silently picking one would make the bot disagree
  -- with whichever script the reader looked at last.
  -- NOT ADDITIVE ACROSS ROWS. See the header.
  active_users           integer not null default 0 check (active_users        >= 0),
  total_users            integer not null default 0 check (total_users         >= 0),
  new_users              integer not null default 0 check (new_users           >= 0),

  -- Additive. Sum these freely over a date range.
  sessions               integer not null default 0 check (sessions            >= 0),
  engaged_sessions       integer not null default 0 check (engaged_sessions    >= 0),
  page_views             integer not null default 0 check (page_views          >= 0),

  -- Handoffs: the `outbound_click` event (src/lib/analyticsEvents.ts). Clicks
  -- are additive; clickers are a per-day distinct count and are not.
  outbound_clicks        integer not null default 0 check (outbound_clicks     >= 0),
  outbound_users         integer not null default 0 check (outbound_users      >= 0),

  -- Reading depth: the `view_event` event.
  view_event_fires       integer not null default 0 check (view_event_fires    >= 0),
  view_event_users       integer not null default 0 check (view_event_users    >= 0),

  -- PWA. `pwa_launches` is an event count (additive). `pwa_launch_users` is
  -- that day's distinct standalone users (not additive).
  -- `pwa_install_accepted` is the Android/desktop install prompt only: iOS
  -- "Add to Home Screen" fires NOTHING, so this column is a floor on a subset
  -- of installs and must never be presented as "installs".
  pwa_launches           integer not null default 0 check (pwa_launches        >= 0),
  pwa_launch_users       integer not null default 0 check (pwa_launch_users    >= 0),
  pwa_install_accepted   integer not null default 0 check (pwa_install_accepted >= 0),

  -- THE ONLY HONEST INSTALL SIGNAL, and the reason these two columns are here
  -- rather than being derived by summing the column above.
  --
  -- There is no true install count. An uninstall fires no event, and iOS
  -- "Add to Home Screen" fires no event at all, so `pwa_install_accepted`
  -- summed over all time is neither a total nor a floor on the installed base
  -- -- it is a floor on Android/desktop prompt acceptances, a different thing.
  -- The only defensible figure is DISTINCT USERS who fired
  -- pwa_standalone_launch over a trailing window, which reads as "people who
  -- opened the installed app recently": a floor on the actively-installed
  -- base. GA4 must compute that distinct count itself (it cannot be recovered
  -- by summing pwa_launch_users, for the same non-additivity reason as
  -- total_users), so the loader asks for it as its own report and stores the
  -- answer as of this metric_date.
  --
  -- These are ROLLING SNAPSHOTS, not day facts: the value on 2026-08-20 is the
  -- distinct-user count for the 28 days ENDING 2026-08-20. Never sum them,
  -- never average them; read the single most recent NON-NULL row.
  --
  -- NULLABLE, and the nullability is load-bearing. Each one costs its own GA4
  -- report per date (a distinct count cannot be assembled from day rows), so
  -- `ga-to-db.js --no-rolling` skips them. NULL means "not computed for this
  -- date", which is a different fact from 0 ("nobody opened the app"), and 0
  -- is the one that would be believed. A reader must skip NULLs, not treat
  -- them as zero.
  --
  -- KNOWN AND ACCEPTED: with rolling ON, these columns ARE in the payload, so
  -- a backfilled date from before the PWA shipped stores 0 rather than NULL.
  -- That spends the NULL-versus-zero distinction on a row where 0 is simply
  -- true (nobody had the app installed yet), so it costs nothing real. The
  -- distinction still does its job where it matters: `--no-rolling` omits the
  -- columns from the payload entirely, and PostgREST derives one column list
  -- for the whole request, so an omitted column is in neither the INSERT list
  -- nor the DO UPDATE SET and a previously-computed value survives untouched.
  pwa_users_7d           integer check (pwa_users_7d  is null or pwa_users_7d  >= 0),
  pwa_users_28d          integer check (pwa_users_28d is null or pwa_users_28d >= 0),

  -- When this row was last written from GA4. A row whose fetched_at is less
  -- than ~48h after its metric_date is PROVISIONAL: GA4 was still revising.
  fetched_at             timestamptz not null default now()
);

comment on table site_metrics_daily is
  'GA4 site-wide daily facts (property 538991588), loaded by scripts/ga-to-db.js. Every figure is a FLOOR, not a count: ad blockers and tracking protection drop the beacon. User columns are per-day distinct counts and are NOT additive across rows; page_views/sessions/clicks are. pwa_users_7d/28d are rolling distinct-user snapshots as of metric_date, not day facts.';

comment on column site_metrics_daily.pwa_users_28d is
  'Distinct users who fired pwa_standalone_launch in the 28 days ending metric_date. The only honest install signal: a floor on the actively-installed base. There is no true install count (uninstalls and iOS Add to Home Screen fire nothing). Never sum. NULL means not computed for this date, which is NOT zero.';

-- No secondary index: the primary key on metric_date is exactly the btree a
-- date-range scan wants, and the table gains one row a day (365/year).

-- ── 2. Per page, per day ────────────────────────────────────────────────────
--
-- page_path is the natural key alongside the date. It is stored raw as GA4
-- reports it (path only, no origin, no query string -- GA4's `pagePath`
-- dimension already excludes both).
create table page_metrics_daily (
  metric_date            date not null,
  page_path              text not null check (char_length(page_path) between 1 and 512),

  -- THE join key: events.id, pulled out of the uuid segment of an event
  -- detail path (/events/{url-slug}/{uuid}) and NULL for every other page.
  -- See the header for why this is the uuid and not the slug in the path.
  --
  -- Stored rather than derived in SQL on read because (a) the derivation is a
  -- regex the loader already owns and duplicating it in a view would let the
  -- two drift, and (b) a stored column can carry an index, which a
  -- regexp_replace on read cannot use.
  --
  -- Deliberately NOT a foreign key to events. GA4 reports paths for events
  -- that have since been merged into an alias (event_aliases) or deleted, and
  -- an FK would make the loader fail on exactly the historical days that are
  -- most annoying to backfill. A dangling id is a fact about what people read,
  -- and losing it would be worse than carrying it. Join with a plain join and
  -- expect misses.
  event_id               uuid,

  -- The readable half of the path, for labelling a row in a reply. A LABEL,
  -- NEVER A KEY: it does not equal events.slug and must not be joined on.
  url_slug               text check (url_slug is null
                                     or char_length(url_slug) between 1 and 300),

  page_views             integer not null default 0 check (page_views       >= 0),
  users                  integer not null default 0 check (users            >= 0),

  -- outbound_click on this page. tickets/source come from the `link_type`
  -- custom event dimension and are 0 when that dimension is not registered in
  -- GA4 Admin (ga-outbound-by-event.js treats that as a soft miss, not a
  -- failure); outbound_clicks stays correct either way, so the split may be
  -- less than the total and that is expected, not a bug.
  outbound_clicks        integer not null default 0 check (outbound_clicks   >= 0),
  outbound_users         integer not null default 0 check (outbound_users    >= 0),
  outbound_tickets       integer not null default 0 check (outbound_tickets  >= 0),
  outbound_source        integer not null default 0 check (outbound_source   >= 0),

  fetched_at             timestamptz not null default now(),

  primary key (metric_date, page_path)
);

comment on table page_metrics_daily is
  'GA4 per-page daily facts. Serves top-pages and per-event questions from one grain; event_id is non-null only for event detail pages and joins to events.id (no FK, on purpose: merged and deleted events still have history). url_slug is the date-suffixed display slug from the URL and does NOT equal events.slug -- label only, never a join key. Floor, not a count. users is per-day distinct and not additive; views and clicks are.';

-- Indexes. Three queries, three indexes, and nothing speculative.
--
-- (a) "how did event X do" -- an event lookup over a date range. Partial,
--     because a good share of rows on a busy day are browse pages with a NULL
--     event_id and they only bloat the index.
create index page_metrics_event_id_idx
  on page_metrics_daily (event_id, metric_date desc)
  where event_id is not null;

-- (b) "top pages last week" -- a date range, then an ordered aggregate. The PK
--     already gives the range; leading with metric_date and carrying
--     page_views lets the planner walk the range in views order per day and
--     stops it from reading the heap for the ranking pass.
create index page_metrics_views_idx
  on page_metrics_daily (metric_date desc, page_views desc);

-- (c) "which events sent the most people out" -- the same shape on the other
--     metric, partial because on a typical day fewer than one page in ten has
--     an outbound click at all.
create index page_metrics_outbound_idx
  on page_metrics_daily (metric_date desc, outbound_clicks desc)
  where outbound_clicks > 0;

-- ── 3. Per embedding host, per day ──────────────────────────────────────────
--
-- Fed from the `embed_host` / `surface` custom event dimensions. Those only
-- become queryable once registered in GA4 Admin; until then the loader writes
-- nothing here and the table is legitimately empty (ga-embeds-snapshot.js
-- already treats an unregistered dimension as NOT_CONFIGURED rather than a
-- failure, and the loader keeps that contract). An empty table therefore means
-- "not registered yet or no embed traffic", never "the loader is broken".
create table embed_metrics_daily (
  metric_date            date not null,
  -- '(unknown)' is a real, storable value: ga-embeds-snapshot.js maps GA4's
  -- '(not set)' to it rather than dropping the row, and dropping it here would
  -- silently shrink the embed total.
  embed_host             text not null check (char_length(embed_host) between 1 and 253),

  page_views             integer not null default 0 check (page_views >= 0),
  users                  integer not null default 0 check (users      >= 0),

  fetched_at             timestamptz not null default now(),

  primary key (metric_date, embed_host)
);

comment on table embed_metrics_daily is
  'GA4 embed reach by partner host, per day. Empty until the embed_host/surface custom dimensions are registered in GA4 Admin -- empty is a valid state, not a failure. Floor, not a count.';

-- "how is everydayakron.com doing over time": host first, date second. The PK
-- covers the other direction (all hosts on a date range).
create index embed_metrics_host_idx on embed_metrics_daily (embed_host, metric_date desc);

-- ── 4. RLS and grants ───────────────────────────────────────────────────────
--
-- RLS on all three. The service role bypasses RLS in Supabase, which is how
-- both the loader (writes) and the Slack bot (reads) get in; the policies
-- below exist for `authenticated` only, and the absence of an anon policy is
-- the point. See the ACCESS section of the header for why 004's anon grant is
-- not copied.
alter table site_metrics_daily  enable row level security;
alter table page_metrics_daily  enable row level security;
alter table embed_metrics_daily enable row level security;

-- Admin read, matching the CURRENT boundary (059), not the pre-059 one. No
-- INSERT, UPDATE or DELETE policy for anyone: these tables have exactly one
-- writer, the nightly loader, running as the service role. A hand-edited
-- traffic figure is a lie that would outlive whoever typed it.
create policy "Admin can read site_metrics_daily"
  on site_metrics_daily for select to authenticated using (is_admin());
create policy "Admin can read page_metrics_daily"
  on page_metrics_daily for select to authenticated using (is_admin());
create policy "Admin can read embed_metrics_daily"
  on embed_metrics_daily for select to authenticated using (is_admin());

-- PostgREST needs the GRANT as well as the policy (004's own comment makes
-- this point). The grant is to the ROLE and the policy is what narrows it to
-- an admin, so both are required and neither is sufficient. Being explicit
-- about the write grant too, rather than relying on whatever default
-- privileges happen to be in force for new tables.
grant select on site_metrics_daily, page_metrics_daily, embed_metrics_daily
  to authenticated;
grant select, insert, update, delete
  on site_metrics_daily, page_metrics_daily, embed_metrics_daily
  to service_role;

-- Belt and braces against a default-privilege surprise: anon gets nothing on
-- any of the three, and cannot be given anything by accident later in this
-- transaction.
revoke all on site_metrics_daily  from anon;
revoke all on page_metrics_daily  from anon;
revoke all on embed_metrics_daily from anon;

commit;

-- ── VERIFY AFTER APPLYING ───────────────────────────────────────────────────
--
--   -- three tables, RLS on, no anon policy anywhere
--   select tablename, rowsecurity from pg_tables
--    where tablename in ('site_metrics_daily','page_metrics_daily','embed_metrics_daily');
--   select tablename, policyname, roles, cmd, qual from pg_policies
--    where tablename in ('site_metrics_daily','page_metrics_daily','embed_metrics_daily');
--   -- expected: three SELECT policies, all {authenticated}, every `qual`
--   -- reading is_admin(), and NO row with anon in roles. A `qual` of `true`
--   -- means the 059 boundary was lost: stop and fix it before anyone signs up.
--
--   -- anon holds no privilege on any of the three
--   select grantee, table_name, privilege_type from information_schema.role_table_grants
--    where table_name in ('site_metrics_daily','page_metrics_daily','embed_metrics_daily')
--      and grantee = 'anon';
--   -- expected: zero rows.
--
-- Then backfill:
--   node scripts/ga-to-db.js --from 2026-05-27 --dry-run   # inspect first
--   node scripts/ga-to-db.js --from 2026-05-27
-- and add the nightly trailing-window run:
--   node scripts/ga-to-db.js                               # last 3 days
