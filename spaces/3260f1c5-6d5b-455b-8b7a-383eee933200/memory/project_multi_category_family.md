---
name: project-multi-category-family
description: Two open product questions raised 2026-06 — events should support multiple categories at once, and "Family Friendly" should reframe to mean "Catered toward families/kids" rather than "kids allowed".
metadata:
  type: project
---

Parked while we work through the Akron Life dedup → direct-scraper migration. Come back to these two product questions together.

**1. Multi-category events.** Today `events.category` is a single value. Many events legitimately span multiple — a Lock 3 free outdoor concert is *music* AND *community* AND *family-suitable*. The proposal is to let an event carry more than one category so it surfaces on multiple hub pages without picking a single best fit.

**Why:** Single-category forces a wrong choice on edge cases (jazz brunch → food or music? art opening reception → art or food?). Discovery suffers either way.

**How to apply:** When picking it back up, the design decisions to make are: schema (separate join table vs. JSONB array column on events), filter semantics (any-match vs. all-match on a multi-pick), backfill strategy for existing rows, and how the inferCategory rule should evolve (return an ordered list rather than a single winner).

**2. Family Friendly framing change.** Today "Family Friendly" / "Family Fun" essentially means "kids allowed". Byron wants to flip this to "catered toward families and children" (active family programming), and add a separate, lower-bar secondary signal that just means "appropriate for kids to attend".

Proposed shape (rough): rename the existing tag "Kid's Event" → something cleaner (Byron explicitly said "rename that, but you get the idea"), and add a secondary "kid-friendly" toggle. Hub page semantics, filter chips, and the homepage intent ("Family Fun") all need updating to match.

Resume after the Akron Life dedup → direct-scraper effort is far enough along that we're no longer fighting categorization noise.
