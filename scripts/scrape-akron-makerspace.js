/**
 * scrape-akron-makerspace.js
 *
 * Akron Makerspace — a volunteer-run 501(c)(3) makerspace in downtown Akron
 * (540 S Main St, Canal Place). Hosts classes and maker/community events.
 *
 * Platform: WordPress with the "Simple Calendar" plugin (Google-Calendar
 * backed). No REST API, but the homepage server-renders a
 * <dl class="simcal-events-list-container"> where each <li class="simcal-event">
 * carries a data-start epoch plus .simcal-event-{title,end-time,address,
 * description} fields. We parse those.
 *
 * We keep the Makerspace's PUBLIC programming and drop members-only/internal
 * items (Weekly Open Workshop Hours, board meetings, Make-Your-Makerspace work
 * nights) and any "around town" events the shared calendar includes at OTHER
 * venues — those belong to their own sources.
 *
 * Price is left null (never assume free).
 *
 * Usage:   node scripts/scrape-akron-makerspace.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, stripHtml, inferCategory, enrichWithImageDimensions,
  upsertEventSafe, linkEventVenue, linkEventOrganization, ensureVenue, ensureOrganization,
  linkOrganizationVenue, easternToIso,
} from './lib/normalize.js'

const SOURCE_KEY   = 'akron_makerspace'
const HOME_URL     = 'https://akronmakerspace.org/'
const USER_AGENT   = 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)'
const MAX_DAYS_AHEAD = 120

const VENUE_INFO = {
  name:    'Akron Makerspace',
  address: '540 S Main St',
  city:    'Akron',
  state:   'OH',
  zip:     '44311',
  lat:     41.0701,
  lng:     -81.5272,
  neighborhood_slug: 'downtown-akron',
  website: HOME_URL,
  parking_type: 'garage',
}

// Members-only / internal items that aren't public events.
const NON_PUBLIC_RE = /\b(open workshop hours|board meeting|make your makerspace|members[- ]only)\b/i
const MEMBERS_DESC_RE = /\b(only for members|members only|for members who)\b/i

// ── Parsing ──────────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' }, redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

/** Text content of a simcal field within an event block (handles nested <a>). */
function fieldText(block, cls) {
  const m = new RegExp(`class="[^"]*${cls}[^"]*"[^>]*>`, 'i').exec(block)
  if (!m) return null
  let rest = block.slice(m.index + m[0].length)
  const liEnd = rest.search(/<\/li>/i)
  if (liEnd >= 0) rest = rest.slice(0, liEnd)
  // stop before the next simcal field's element (cut at its opening "<", not
  // mid-tag, so we don't leave a dangling "<span" in the captured text)
  const cut = rest.search(/<[a-z][^>]*class="[^"]*simcal-event-(?:title|start-date|start-time|end-time|address|description|details)\b/i)
  const chunk = cut >= 0 ? rest.slice(0, cut) : rest
  return stripHtml(chunk).replace(/\s+/g, ' ').trim() || null
}

/**
 * Parse the Simple Calendar event list out of the homepage HTML.
 * Returns [{ startEpoch, title, endTime, address, description }].
 */
export function parseSimcalEvents(html) {
  const out = []
  const blocks = String(html || '').split(/<li class="simcal-event/i).slice(1)
  for (const b of blocks) {
    const epoch = b.match(/data-start="(\d+)"/)?.[1]
    if (!epoch) continue
    out.push({
      startEpoch:  Number(epoch),
      title:       fieldText(b, 'simcal-event-title'),
      endTime:     fieldText(b, 'simcal-event-end-time'),
      address:     fieldText(b, 'simcal-event-address'),
      description: fieldText(b, 'simcal-event-description'),
    })
  }
  return out
}

/** Strip the venue suffix WordPress appends ("Title @ Akron Makerspace"). */
export function cleanTitle(title) {
  return String(title || '').replace(/\s*@\s*Akron Makerspace\s*$/i, '').trim()
}

/** "9:00 pm" → "21:00:00" | null. */
export function to24h(str) {
  const m = String(str || '').trim().match(/^(\d{1,2}):(\d{2})\s*([ap])m$/i)
  if (!m) return null
  let h = parseInt(m[1], 10)
  const pm = /p/i.test(m[3])
  if (h === 12) h = pm ? 12 : 0
  else if (pm) h += 12
  return `${String(h).padStart(2, '0')}:${m[2]}:00`
}

/** Is this a public event held at the Makerspace itself? */
export function isPublicMakerspaceEvent(ev) {
  if (!ev?.title) return false
  if (NON_PUBLIC_RE.test(ev.title)) return false
  if (ev.description && MEMBERS_DESC_RE.test(ev.description)) return false
  // Address must be empty (assumed Makerspace) or the Makerspace itself —
  // skip "around town" events at other venues (other sources own those).
  const addr = (ev.address || '').toLowerCase()
  if (addr && !/akron makerspace|540 s main/.test(addr)) return false
  return true
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🛠️  Starting Akron Makerspace ingestion…')
  const start = Date.now()
  try {
    const organizerId = await ensureOrganization('Akron Makerspace', {
      website:     HOME_URL,
      description: 'Akron Makerspace is a volunteer-run 501(c)(3) makerspace in downtown Akron offering tools, classes, and maker community events.',
    })
    const venueId = await ensureVenue(VENUE_INFO.name, {
      address: VENUE_INFO.address, city: VENUE_INFO.city, state: VENUE_INFO.state, zip: VENUE_INFO.zip,
      lat: VENUE_INFO.lat, lng: VENUE_INFO.lng, neighborhood_slug: VENUE_INFO.neighborhood_slug,
      website: VENUE_INFO.website, parking_type: VENUE_INFO.parking_type,
    })
    if (organizerId && venueId) await linkOrganizationVenue(organizerId, venueId)

    const events = parseSimcalEvents(await fetchHtml(HOME_URL))
    const now = Date.now()
    const cutoff = now + MAX_DAYS_AHEAD * 86_400_000
    let inserted = 0, skipped = 0

    for (const ev of events) {
      try {
        if (!isPublicMakerspaceEvent(ev)) { skipped++; continue }
        const startMs = ev.startEpoch * 1000
        if (startMs < now - 86_400_000 || startMs > cutoff) { skipped++; continue }

        const startAt = new Date(startMs).toISOString()
        const easternYmd = new Date(startMs).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
        const end24 = to24h(ev.endTime)
        const endAt = end24 ? easternToIso(`${easternYmd} ${end24}`) : null

        const title = cleanTitle(ev.title)
        const row = {
          title,
          description:     ev.description || null,
          start_at:        startAt,
          end_at:          endAt,
          category:        inferCategory(title, ev.description || ''),
          tags:            ['akron-makerspace', 'maker', 'downtown-akron', 'akron'],
          price_min:       null, // never assume free
          price_max:       null,
          age_restriction: 'all_ages',
          image_url:       null,
          ticket_url:      HOME_URL,
          source:          SOURCE_KEY,
          source_id:       `${SOURCE_KEY}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${easternYmd}`,
          status:          'published',
          featured:        false,
        }

        const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
        if (error) { console.warn(`  ⚠ Upsert failed "${title}": ${error.message}`); skipped++; continue }
        if (venueId) await linkEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        inserted++
      } catch (err) {
        console.warn(`  ⚠ Error on "${ev.title}": ${err.message}`)
        skipped++
      }
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, { eventsFound: events.length, durationMs: Date.now() - start })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} upserted, ${skipped} skipped (of ${events.length} feed items)`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
