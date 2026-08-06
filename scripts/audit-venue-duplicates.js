/**
 * audit-venue-duplicates.js
 *
 * One check in the nightly data-quality audit: venues that collapse to the SAME
 * normalized street address but exist as separate rows. These arise when one
 * source mints a venue from a scraper (often without coordinates) and another
 * source/geocoder mints a second row for the same building (e.g. KillBox Comedy
 * Club had its 53 events on a coord-less record while a stray duplicate held the
 * lat/lng — so it never drew a map pin). The shared address canonicalizer is the
 * project SSOT `normalizeStreetAddress` (lib/normalize.js) — including the
 * directional folding (East↔E) — so this audit and ingest agree by construction.
 *
 * This module is PURE + offline: it takes venue rows (id, name, address, coords,
 * event counts) and returns a plan. It does NOT touch the database — the nightly
 * runner pulls venue rows via the Supabase connector, pipes them in, applies the
 * emitted SQL for the "clear" merges, and surfaces the "ambiguous" groups for
 * review. Run standalone:  cat venues.json | node scripts/audit-venue-duplicates.js
 *
 * RUNNER CONTRACT (both requirements are load-bearing):
 *   • Each input venue row MUST include `is_alias` (true when the venue already
 *     has a venue_aliases row pointing away from it) — e.g. select an EXISTS
 *     against venue_aliases when pulling rows. Omitting it silently disables the
 *     never-crown-an-aliased-row rule in pickCanonical.
 *   • Apply each merge group's emitted SQL in ONE transaction. Statement order
 *     within a group is deliberate (inbound alias re-point BEFORE alias inserts,
 *     per the 050 chain-guard trigger); a mid-group failure without a
 *     transaction would leave event links re-pointed but the merge unrecorded.
 *
 * Classification:
 *   • clear     — every other row in the group is the SAME venue as the canonical
 *                 (name equal, one name contains the other, one is a bare
 *                 address-named junk row, or high token overlap). Auto-merged.
 *   • ambiguous — same address but a genuinely different venue name (two
 *                 businesses sharing a building). Flagged, never auto-merged.
 *
 * Canonical pick: most upcoming events, then most total events, then has-coords
 * (rows that are already venue_aliases entries are never crowned canonical).
 * The canonical keeps its id; dupes' event links are re-pointed to it, each dupe
 * is recorded in venue_aliases (so ensureVenue resolves the old row to the
 * canonical forever) and UNLISTED — never deleted, so nothing dangling breaks;
 * missing coords / neighborhood_slug are copied from a dupe.
 */

import { normalizeStreetAddress, looksLikeStreetAddress, decodeEntities, easternTodayIso } from './lib/normalize.js'

/**
 * CONSERVATIVE "same place" test for the AUTO-merge bucket. Only fires on cases
 * that are safe to merge unattended:
 *   • one row's name is a bare street address (junk address-as-name), or
 *   • names are equal after normalizing case/punctuation/HTML entities, or
 *   • one normalized name fully contains the other ("The KillBox" ⊂ "The
 *     KillBox Comedy Club", "Weathervane Playhouse" ⊂ "Weathervane Playhouse,
 *     Akron").
 * Deliberately NOT fuzzy: token-overlap matches (e.g. "Guzzetta Recital Hall"
 * vs "Guzzetta Hall Lawn", "Firestone Library" vs "Firestone Park Branch
 * Library") are distinct or borderline spaces and must go to the review bucket,
 * not auto-merge.
 */
export function sameVenueName(a, b) {
  if (looksLikeStreetAddress(a) || looksLikeStreetAddress(b)) return true  // junk address-named row
  // decodeEntities first so "Let&#8217;s …" equals "Let's …" (entity-only diff).
  const norm = (s) => decodeEntities(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
  const na = norm(a), nb = norm(b)
  if (!na || !nb) return false
  if (na === nb) return true
  return na.includes(` ${nb} `) || na.startsWith(`${nb} `) || na.endsWith(` ${nb}`) ||
         nb.includes(` ${na} `) || nb.startsWith(`${na} `) || nb.endsWith(` ${na}`)
}

const upcoming = (v) => Number(v.upcoming || 0)
const events   = (v) => Number(v.events || 0)
const hasCoords = (v) => v.lat != null && v.lng != null

/**
 * Choose the canonical venue. A venue that is already a venue_aliases row
 * (v.is_alias, piped in with the venue rows by the runner) is never crowned
 * canonical — the DB chain-guard trigger (migration 050) would reject any
 * alias pointing at it. Next, a bare address-as-name row (junk) is never
 * preferred over a real name; then most upcoming, most events, has coords.
 */
export function pickCanonical(group) {
  const aliasPenalty = (v) => (v.is_alias ? 1 : 0)
  const addrPenalty = (v) => (looksLikeStreetAddress(v.name) ? 1 : 0)
  return [...group].sort((a, b) =>
    (aliasPenalty(a) - aliasPenalty(b)) ||
    (addrPenalty(a) - addrPenalty(b)) ||
    (upcoming(b) - upcoming(a)) ||
    (events(b) - events(a)) ||
    ((hasCoords(b) ? 1 : 0) - (hasCoords(a) ? 1 : 0)),
  )[0]
}

const SLUG_RE = /^[a-z0-9-]+$/

/** Escape a text value for a single-quoted SQL literal (names carry apostrophes). */
const sqlText = (s) => String(s ?? '').replace(/'/g, "''")

/**
 * Build the deterministic merge SQL for one clear group (ids are uuids/safe).
 * Alias-and-unlist, never delete: each dupe becomes a venue_aliases row
 * pointing at the canonical and is set listed = false, so re-scrapes resolve
 * onto the canonical (ensureVenue's alias hop) and nothing dangles.
 *
 * Statement order is load-bearing against the venue_aliases chain-guard
 * trigger (migration 050): inbound aliases whose canonical is a dupe are
 * re-pointed to the new canonical BEFORE the dupes themselves are inserted as
 * aliases — otherwise the insert would alias away a venue that is still
 * canonical for existing aliases and the trigger raises.
 */
function buildMergeSql(canonical, dupes, copyFields) {
  const ids = dupes.map((d) => `'${d.id}'`).join(', ')
  const stmts = []
  if (copyFields.lat != null && copyFields.lng != null) {
    stmts.push(`update venues set lat = ${Number(copyFields.lat)}, lng = ${Number(copyFields.lng)} where id = '${canonical.id}' and lat is null;`)
  }
  if (copyFields.neighborhood_slug && SLUG_RE.test(copyFields.neighborhood_slug)) {
    stmts.push(`update venues set neighborhood_slug = '${copyFields.neighborhood_slug}' where id = '${canonical.id}' and neighborhood_slug is null;`)
  }
  // Re-point dupe event links to the canonical, dropping links that would collide.
  stmts.push(`delete from event_venues e1 where e1.venue_id in (${ids}) and exists (select 1 from event_venues e2 where e2.event_id = e1.event_id and e2.venue_id = '${canonical.id}');`)
  stmts.push(`update event_venues set venue_id = '${canonical.id}' where venue_id in (${ids});`)
  // (1) Re-point inbound aliases FIRST (see trigger-order note above).
  stmts.push(`update venue_aliases set canonical_venue_id = '${canonical.id}' where canonical_venue_id in (${ids});`)
  // (2) Record each dupe as an alias of the canonical. The coalesce
  // self-resolves through venue_aliases in case the canonical is itself an
  // alias row (pickCanonical avoids that, but the SQL must never create a
  // chain — the trigger would reject it).
  const reason = `audit-venue-duplicates:${easternTodayIso()}`
  for (const d of dupes) {
    stmts.push(
      `insert into venue_aliases (alias_venue_id, canonical_venue_id, alias_name, reason) ` +
      `values ('${d.id}', coalesce((select canonical_venue_id from venue_aliases where alias_venue_id = '${canonical.id}'), '${canonical.id}'), '${sqlText(d.name)}', '${reason}') ` +
      `on conflict (alias_venue_id) do update set canonical_venue_id = excluded.canonical_venue_id;`,
    )
  }
  // (3) Unlist the dupes instead of deleting them — alias rows stay resolvable
  // (and navigable from any straggler links) but leave the public venues index.
  stmts.push(`update venues set listed = false where id in (${ids});`)
  return stmts.join('\n')
}

/** What missing fields the canonical can inherit from a dupe in the group. */
function copyFieldsFor(canonical, dupes) {
  const out = {}
  if (!hasCoords(canonical)) {
    const withCoords = dupes.find(hasCoords)
    if (withCoords) { out.lat = withCoords.lat; out.lng = withCoords.lng }
  }
  if (!canonical.neighborhood_slug) {
    const withSlug = dupes.find((d) => d.neighborhood_slug)
    if (withSlug) out.neighborhood_slug = withSlug.neighborhood_slug
  }
  return out
}

/**
 * Build the audit plan from venue rows. Returns { groupsFound, clear, ambiguous }.
 * Venue row shape: { id, name, address, city, neighborhood_slug, lat, lng,
 *                    events, upcoming, is_alias? } — is_alias marks rows that
 *                    already exist in venue_aliases (never crowned canonical).
 */
export function planVenueAudit(venues) {
  const byAddr = new Map()
  for (const v of venues || []) {
    const key = normalizeStreetAddress(v.address)
    if (!key) continue
    if (!byAddr.has(key)) byAddr.set(key, [])
    byAddr.get(key).push(v)
  }

  const clear = [], ambiguous = []
  for (const [addressKey, group] of byAddr) {
    if (group.length < 2) continue
    const canonical = pickCanonical(group)
    const dupes = group.filter((v) => v.id !== canonical.id)

    if (dupes.every((d) => sameVenueName(canonical.name, d.name))) {
      const copyFields = copyFieldsFor(canonical, dupes)
      clear.push({
        addressKey,
        canonical: { id: canonical.id, name: canonical.name, upcoming: upcoming(canonical), hasCoords: hasCoords(canonical) },
        dupes: dupes.map((d) => ({ id: d.id, name: d.name, upcoming: upcoming(d), hasCoords: hasCoords(d) })),
        copyFields,
        sql: buildMergeSql(canonical, dupes, copyFields),
        summary: `Merge ${dupes.map((d) => `"${d.name}"`).join(', ')} → "${canonical.name}"` +
          (copyFields.lat != null ? ' (copied coordinates)' : '') +
          (copyFields.neighborhood_slug ? ` (copied neighborhood ${copyFields.neighborhood_slug})` : ''),
      })
    } else {
      ambiguous.push({
        addressKey,
        venues: group.map((v) => ({ id: v.id, name: v.name, city: v.city, upcoming: upcoming(v), events: events(v), hasCoords: hasCoords(v) })),
        note: 'Same normalized address but distinct venue names — review before merging.',
      })
    }
  }
  return { groupsFound: clear.length + ambiguous.length, clear, ambiguous }
}

// CLI: read venue rows as JSON on stdin, print the plan as JSON on stdout.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  let raw = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (c) => { raw += c })
  process.stdin.on('end', () => {
    let venues
    try { venues = JSON.parse(raw || '[]') } catch (e) { console.error('Invalid JSON on stdin:', e.message); process.exit(1) }
    process.stdout.write(JSON.stringify(planVenueAudit(venues), null, 2) + '\n')
  })
}
