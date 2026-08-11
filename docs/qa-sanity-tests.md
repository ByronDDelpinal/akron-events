# Akron Pulse — Sanity Test Suite

Manual regression tests to run after **every** site change, no matter how small. Public-facing scope only (admin tested separately). Each test ships with multiple variants so the tester exercises the feature from different angles instead of running the same path twice.

**Conventions**
- "Confirm no console errors" means open DevTools → Console and check for **red** errors. Yellow warnings are OK.
- "Hard refresh" = Cmd/Ctrl + Shift + R.
- Mobile viewport = DevTools device toolbar set to iPhone 14 Pro (or 390×844).
- Any failure should be filed with: test ID, variant, browser, steps to reproduce, screenshot, and console log.

---

## Test 1 — Homepage loads and renders events

**Goal:** Confirm the core event feed is alive and renders without errors.

**Variant A — cold load**
1. Open an incognito/private window.
2. Navigate to the site root (`/`).
3. Confirm the header, footer, filter bar, and at least one event card appear within 5 seconds.
4. Confirm no error toast, blank state, or "Something went wrong" message is visible.
5. Open DevTools → Console; confirm no red errors.

**Variant B — warm load + scroll**
1. From an already-loaded homepage, hard refresh.
2. Scroll to the bottom of the event list.
3. Confirm dates progress chronologically (today → future), with no obvious duplicates back-to-back.
4. Confirm each card shows a title, date, and source/venue.

**Variant C — mobile viewport**
1. Open DevTools → device toolbar → iPhone 14 Pro.
2. Reload `/`.
3. Confirm header collapses to logo + hamburger, filter tray opens via its button, and event cards stack in a single column.

---

## Test 2 — Event detail page

**Goal:** Confirm a single event renders fully and canonical URL behavior works.

**Variant A — click-through**
1. From the homepage, click the first event card.
2. Confirm the URL becomes `/events/<slug>/<id>`.
3. Confirm the page shows title, full date/time, venue, description, source link, and share buttons.
4. Click the back button; confirm you return to the homepage at the same scroll position.

**Variant B — legacy URL canonicalization**
1. Copy an event's UUID from any event card link.
2. Paste `/events/<uuid>` (no slug) directly into the address bar.
3. Confirm the URL silently rewrites to `/events/<slug>/<uuid>` and the page renders normally.

**Variant C — invalid event**
1. Navigate to `/events/this-is-not-real/00000000-0000-0000-0000-000000000000`.
2. Confirm a clean not-found or empty state appears — not a stack trace or blank page.

---

## Test 3 — Filter & Sort tray

**Goal:** Confirm filters narrow results, persist in the URL, and clear correctly.

**Variant A — single category filter**
1. From `/`, click **Filter & Sort**.
2. Pick one category (e.g. Music). Close the tray.
3. Confirm the URL gains `?categories=music` (or equivalent).
4. Confirm every visible card's category badge matches the selected category.
5. Confirm an active-filter chip appears below the filter bar with an ✕ to remove it.

**Variant B — intent + price combo**
1. Open Filter & Sort, pick an intent (e.g. Date Night) and a price filter (e.g. Free only).
2. Apply.
3. Confirm both active-filter chips appear.
4. Confirm result count drops vs. unfiltered.
5. Click ✕ on the price chip; confirm only the intent remains active and results re-expand.

**Variant C — URL share + clear**
1. Apply 2+ filters, copy the full URL, paste into a new incognito window.
2. Confirm filters pre-apply and the result list matches the original window.
3. Back in the original window, clear all filters from the tray.
4. Confirm chips disappear, URL drops the query params, and scroll position does not jump to top.

---

## Test 4 — Search

**Goal:** Confirm header search filters events and survives reload/share.

**Variant A — basic query**
1. From `/`, focus the search input in the filter bar.
2. Type a keyword likely to match (e.g. "music"), press Enter.
3. Confirm the URL gains `?q=music`.
4. Confirm visible cards' titles/descriptions contain the term.

**Variant B — no-results**
1. Search for a clearly absent string (e.g. "zzqq-not-an-event-xyz").
2. Confirm a clean empty state appears (no results) — not a crash.
3. Clear the input and blur; confirm `?q=` drops from the URL and full results return.

**Variant C — search + filter combo**
1. Apply a category filter, then search a keyword.
2. Confirm both `?categories=` and `?q=` appear in the URL.
3. Confirm the result list satisfies both constraints.

---

## Test 5 — Card view mode toggle

**Goal:** Confirm the Comfortable/Compact toggle changes layout without breaking content.

**Variant A — Comfortable → Compact**
1. From `/`, in the filter bar click the second view-mode icon (3×3 grid = Compact).
2. Confirm cards visibly shrink/densify.
3. Confirm each card still shows title, date, and source.

**Variant B — persistence across navigation**
1. Switch to Compact, click into an event, then click back.
2. Confirm the homepage returns in Compact view (toggle remains where you left it).

**Variant C — mobile**
1. In mobile viewport, toggle between Comfortable and Compact.
2. Confirm layout reflows cleanly with no horizontal scroll.

---

## Test 6 — Category / hub pages

**Goal:** Confirm `/events/<slug>` hub pages render and act as a locked filtered view.

**Variant A — known hub**
1. Navigate to a known category hub (e.g. `/events/music`).
2. Confirm the page shows a hub title/intro and a filtered event list.
3. Confirm the active-filter strip does **not** show a removable Category pill for the hub's locked dimension.

**Variant B — combine hub + extra filter**
1. On a hub page, open Filter & Sort and add a non-conflicting filter (e.g. price = Free).
2. Confirm results narrow further and the price chip is removable (the hub category remains locked).

**Variant C — unknown slug**
1. Navigate to `/events/not-a-real-hub-xyz`.
2. Confirm the page degrades gracefully (404, empty state, or redirect to home) — no crash.

---

## Test 7 — Venues list and detail

**Goal:** Confirm venues directory and individual venue pages render.

**Variant A — list page**
1. Navigate to `/venues`.
2. Confirm a paginated/scrollable list of venue cards appears with name, location, and (optionally) image.
3. Click any venue card.

**Variant B — venue detail**
1. On a venue detail page, confirm the page shows venue name, address, an embedded map, and a list of upcoming events at that venue.
2. Confirm the map renders without console errors and a marker is visible.

**Variant C — venue with no upcoming events**
1. Find or navigate to a venue with no upcoming events.
2. Confirm a friendly empty state appears (e.g. "No upcoming events") instead of a blank section.

---

## Test 8 — Organizations list and detail

**Goal:** Confirm organizations directory and individual org pages render.

**Variant A — list page**
1. Navigate to `/organizations`.
2. Confirm a list of organization cards appears with name and (optionally) logo/description.
3. Click any org card.

**Variant B — organization detail**
1. On an organization detail page, confirm name, description, links, and a list of associated events appear.
2. Confirm clicking an associated event navigates to that event's detail page.

**Variant C — search / filter org list (if present)**
1. If the org list has search or filtering, exercise one query and confirm results update.
2. Clear; confirm the full list returns.

---

## Test 9 — Submit Event form

**Goal:** Confirm public event submission works end-to-end.

**Variant A — happy path**
1. Navigate to `/submit`.
2. Fill in all required fields with realistic test data (title prefixed `QA TEST —`, date in the next 7 days, venue, description, contact email).
3. Submit.
4. Confirm a success state/message appears.
5. Confirm no red console errors.

**Variant B — required-field validation**
1. On a fresh `/submit`, leave one required field blank and try to submit.
2. Confirm inline validation flags the missing field and the form does not submit.

**Variant C — review queue arrival**
1. After Variant A, log into `/admin/review` (separately, by a teammate with admin access if needed).
2. Confirm the `QA TEST —` submission appears in the review queue with all submitted fields intact.

---

## Test 10 — Submit Venue form

**Goal:** Confirm public venue submission works end-to-end.

**Variant A — happy path**
1. Navigate to `/venues/submit`.
2. Fill in all required fields (name prefixed `QA TEST —`, address, etc.).
3. Submit; confirm a success state appears.

**Variant B — validation**
1. Submit with one required field blank; confirm inline validation.

**Variant C — admin queue**
1. Confirm the submission appears in the appropriate admin review/list view.

---

## Test 11 — Submit Organization form

**Goal:** Confirm public organization submission works end-to-end.

**Variant A — happy path**
1. Navigate to `/organizations/submit`.
2. Fill in all required fields (name prefixed `QA TEST —`, description, etc.).
3. Submit; confirm a success state appears.

**Variant B — validation**
1. Submit with one required field blank; confirm inline validation.

**Variant C — admin queue**
1. Confirm the submission appears in the appropriate admin review/list view.

---

## Test 12 — Subscribe → Preferences → Unsubscribe (email round-trip)

**Goal:** Confirm the full subscription lifecycle works including a real email send.

**Variant A — subscribe + confirmation email**
1. Navigate to `/subscribe`.
2. Enter a real test inbox address (e.g. `qa+<date>@yourdomain`).
3. Submit; confirm a success/confirmation state appears.
4. Within 5 minutes, confirm a welcome/confirmation email arrives at the inbox.
5. Confirm the email renders correctly in Gmail web and at least one mobile client; all links work.

**Variant B — manage preferences**
1. From the welcome email (or `/subscribe/preferences?…` link), open the preferences page.
2. Change at least one preference (e.g. toggle a category, change frequency).
3. Save; confirm a success state appears.
4. Reload the preferences page; confirm the change persisted.

**Variant C — unsubscribe**
1. Click the Unsubscribe link in the welcome email (or navigate to `/unsubscribe?…`).
2. Confirm a clear confirmation that the address is unsubscribed.
3. Re-visit `/subscribe/preferences` for that address; confirm it reflects the unsubscribed state.

---

## Test 13 — Feedback form

**Goal:** Confirm the feedback form submits and lands in the admin feedback queue.

**Variant A — happy path**
1. Navigate to `/feedback` (also reachable from the header **Feedback Beta** link).
2. Fill in all fields with `QA TEST — feedback <timestamp>`.
3. Submit; confirm a success state.

**Variant B — validation**
1. Submit with required fields blank; confirm inline validation.

**Variant C — admin arrival**
1. Confirm the entry appears at `/admin/feedback` with all submitted fields.

---

## Test 14 — Header navigation and mobile menu

**Goal:** Confirm primary nav and the mobile hamburger work everywhere they appear.

**Variant A — desktop nav**
1. From `/`, click **About**, then **Feedback**, then **+ Submit Event**, then **Subscribe** in turn.
2. Confirm each navigates to the right route and the active link styling tracks the current page.
3. Click the **Akron Pulse** logo; confirm you return to `/`.

**Variant B — mobile menu**
1. In mobile viewport, click the hamburger.
2. Confirm the menu opens, body scroll is locked (try scrolling the page behind it), and each menu item navigates correctly.
3. After navigating, confirm the menu closes automatically.

**Variant C — scroll behavior on home**
1. From `/`, scroll past 20px.
2. Confirm the header shifts to its "scrolled" (solid) state.
3. Scroll back to top; confirm it returns to the transparent/hero state.

---

## Test 15 — Footer theme picker and reset

**Goal:** Confirm the theme switcher applies a theme, persists it, and resets cleanly.

**Variant A — pick a theme**
1. Scroll to the footer on any non-admin page.
2. From the theme dropdown, pick a non-default theme.
3. Confirm site colors/fonts visibly change without a full reload.

**Variant B — persistence**
1. After Variant A, hard refresh.
2. Confirm the chosen theme is still applied.
3. Open a new tab to `/`; confirm the theme also applies there (same browser).

**Variant C — reset**
1. Click the footer's reset-theme button.
2. Confirm the theme returns to the default and the card view mode resets to its default.
3. Confirm `localStorage` (DevTools → Application → Local Storage) no longer holds a custom theme value.

---

## Test 16 — 404 / unknown route

**Goal:** Confirm unknown routes render a clean not-found page.

**Variant A — random path**
1. Navigate to `/this-route-does-not-exist`.
2. Confirm the "Page not found" message appears with a working "Back to events" link.
3. Confirm no console errors.

**Variant B — sub-route under known section**
1. Navigate to `/venues/not-a-real-id`.
2. Confirm the page degrades gracefully (clean empty/not-found state, not a crash).

**Variant C — query string survives**
1. Navigate to `/nope?foo=bar`.
2. Confirm 404 still renders and the "Back to events" link strips the bad path.

---

## Test 17 — About page

**Goal:** Confirm the About page renders without missing assets.

**Variant A — render**
1. Navigate to `/about`.
2. Confirm the page renders with intro copy, images (if any), and no broken links.
3. Confirm no console errors.

**Variant B — anchor links**
1. If the page has in-page anchors (e.g. `/about#faq`), click each and confirm smooth-jump to the right section.

**Variant C — mobile**
1. In mobile viewport, confirm content reflows with no horizontal scroll.

---

## Test 18 — Technical page reflects current scrapers

**Goal:** Confirm `/technical` lists every active data source the homepage is ingesting from. (This is a known regression risk — every scraper change must touch this page.)

**Variant A — render**
1. Navigate to `/technical`.
2. Confirm the page renders a list/table of data sources grouped by platform.

**Variant B — coverage vs. scrapers**
1. Compare the source list on `/technical` against the `scripts/` folder in the repo (or the latest scraper-runs page).
2. Confirm every active scraper has a corresponding entry on `/technical`.
3. Flag any scraper that exists in code but is missing from the page (or vice versa).

**Variant C — links**
1. Click 3 source links; confirm each opens the source's real website in a new tab.

---

## Test 19 — Event detail share buttons

**Goal:** Confirm share buttons emit correct URLs/intents.

**Variant A — copy link**
1. On any event detail page, click the **Copy Link** (or equivalent) button.
2. Paste into the address bar; confirm it's the canonical `/events/<slug>/<id>` URL.

**Variant B — social share**
1. Click one social share button (e.g. Facebook or X/Twitter).
2. Confirm a share-intent popup opens with the event title and canonical URL pre-filled.
3. Close without posting.

**Variant C — calendar/ICS (if present)**
1. If an "Add to Calendar" or `.ics` download exists, trigger it.
2. Open the downloaded `.ics` in a calendar app; confirm title, start, end, location, and description are correct.

---

## Test 20 — Cross-cutting: performance, console, SEO

**Goal:** Catch silent regressions in load speed, console hygiene, and SEO meta.

**Variant A — Lighthouse (home + 1 event)**
1. In an incognito window, run Lighthouse (Performance + SEO + Accessibility + Best Practices) against `/` and one event detail page.
2. Confirm Performance ≥ 80 on desktop and ≥ 60 on mobile.
3. Confirm SEO ≥ 95 on both pages.
4. Flag any regression of more than 5 points vs. the previous run.

**Variant B — console hygiene sweep**
1. Visit `/`, an event detail page, `/venues`, a venue detail page, `/organizations`, `/about`, `/submit`, `/subscribe`, and `/feedback` in turn.
2. On each, confirm there are zero red console errors and no failed network requests in the Network tab (4xx/5xx for first-party requests).

**Variant C — SEO meta + Open Graph spot-check**
1. View page source on `/`, one event detail, and one venue detail page.
2. Confirm each page has unique `<title>`, `<meta name="description">`, and Open Graph (`og:title`, `og:description`, `og:image`, `og:url`) tags.
3. Confirm the event detail page emits a JSON-LD `Event` schema block and the venue page emits a `Place` schema block.

---

## Test 21 — Festival hub pages

**Goal:** Confirm `/festival/<slug>` renders the festival (not another event) and the festival invariants hold. Run after any festival import, umbrella edit, or scrape touching a festival source. (Regression context: on 2026-08-10 a second event tagged `festival-umbrella` hijacked the Akron Pride hub header.)

**Variant A — umbrella header shows the festival**
1. Navigate to `/festival/<slug>` for each entry in `FESTIVALS` (`src/lib/festivals.ts`), e.g. `/festival/porchrokr-2026`.
2. Confirm the header shows the festival's name, date, poster image (if the umbrella has one), and logistics text — not the title/copy/image of a 5K, kickoff party, or any other side event.
3. Confirm the "Festival details" link opens the umbrella event's own page, and the "Organizer site" link opens the organizer website in a new tab.
4. Confirm no red console errors.

**Variant B — schedule grid populated post-import**
1. On the same hub page (after the lineup import has run), confirm the time-major schedule renders: slot headings in chronological order, act cards under each slot, and a sticky jump bar with one chip per slot.
2. Click a jump-bar chip; confirm the page scrolls to that slot.
3. If the festival's lineup has NOT been imported yet, confirm the clean empty state ("The full schedule hasn't been published yet") — not a crash or a blank page.
4. Confirm venue names on cards show clean display names (importer prefix stripped, e.g. "Porch 7 - …" not "PorchRokr Porch 7 - …").

**Variant C — one-umbrella invariant (automated)**
1. Run `npm run check:festivals`.
2. Confirm it exits green: exactly one published umbrella per festival tag, umbrella on its registry dateKey, manual_overrides.tags pin present, no orphan umbrellas.
3. A WARN for a festival inside its 7-day window with no lineup rows is acceptable pre-import; any FAIL blocks sign-off.

**Variant D — banner and search shortcut**
1. If a festival's dateKey is within 7 days: load `/` and confirm the homepage banner names the festival with the right day word ("today" / "tomorrow" / weekday) and links to the hub.
2. In the homepage search box, type the festival name (e.g. "porchrokr") and confirm it jumps straight to `/festival/<slug>`.
3. Type a neighborhood name that overlaps a festival's name prefix (e.g. "highland square"); confirm it still goes to the neighborhood hub, never the festival.
4. Open the umbrella event's detail page; confirm it shows a button/link to the festival hub.

---

## Sign-off checklist (per change)

When all tests pass, the tester records:

- Build/commit SHA tested
- Date and tester name
- Browsers exercised (at minimum: latest Chrome desktop, latest Safari iOS or mobile Chrome emulation)
- Any new known issues with ticket links
- Lighthouse scores (from Test 20) vs. last run
