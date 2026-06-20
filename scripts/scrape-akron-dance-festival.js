/**
 * scrape-akron-dance-festival.js
 *
 * The Heinz Poll Summer Dance Festival (akrondancefestival.org) — Akron's
 * 52-year tradition of FREE professional dance performances in city parks, run
 * by the City of Akron. Its headline performances are not ticketed (no
 * Eventbrite/registration) and live only on a small hand-built static HTML page,
 * so rather than maintain a fragile text-parser for ~6 events a year, we enter
 * the season's performances directly from the official schedule and run them
 * through the normal ingestion path (so slug, categories, search-normalisation,
 * and venue linking all happen correctly).
 *
 * This is a CURATED source: update PERFORMANCES once a year from
 * akrondancefestival.org/index.html (the "Schedule" section). The script is
 * idempotent (stable source_id per company+date) and skips past dates, so it's
 * safe to leave in the twice-daily run.
 *
 * Already covered elsewhere (do NOT duplicate here): the June 18 Preview at the
 * Akron Art Museum (akron_art_museum), and the Saturday yoga + master classes
 * (Eventbrite). The Akron Symphony Ensemble Sunday concerts come via the
 * symphony source.
 *
 * Usage:   node scripts/scrape-akron-dance-festival.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, easternToIso, enrichWithImageDimensions,
  upsertEventSafe, linkEventVenue, linkEventOrganization, ensureVenue, ensureOrganization,
} from './lib/normalize.js'

export const SOURCE_KEY = 'akron_dance_festival'
const SITE = 'http://akrondancefestival.org'
const SHOW_TIME = '8:45 PM'          // all evening performances
const ORG_NAME = 'Heinz Poll Summer Dance Festival'

const CHILDRENS_NOTE =
  ' Free admission — bring a blanket or chair. Before the performance, the Dance Institute of The University of Akron presents an interactive children\'s program at 7:45 p.m.'

// 2026 (52nd) season — update yearly from akrondancefestival.org.
export const PERFORMANCES = [
  {
    company: 'Ohio Contemporary Ballet',
    key:     'ohio-contemporary-ballet',
    dates:   ['2026-07-24', '2026-07-25'],
    venue:   'Forest Lodge Park',
    website: 'https://ocballet.org/',
    description:
      'Celebrating its 40th anniversary season, Ohio Contemporary Ballet is a professional contemporary ballet company and pillar of the Northeast Ohio dance scene, led by Producing Artistic Director Dr. Margaret Carlson. Its style bridges the elegance of classical ballet with the dynamism of contemporary dance, spanning iconic masterworks to newly commissioned premieres. Presented free as part of the Heinz Poll Summer Dance Festival at Forest Lodge Park (by the ball-field on Jefferson Ave.).',
  },
  {
    company: 'Dayton Contemporary Dance Company',
    key:     'dayton-contemporary-dance-company',
    dates:   ['2026-07-31', '2026-08-01'],
    venue:   'Goodyear Heights Metro Park',
    website: 'https://dcdc.org/',
    description:
      'One of the nation\'s premier modern dance institutions and recognized among the top 10 contemporary dance companies in the country. Founded in 1968 by Dayton native Jeraldyne Blunden to uplift the voices of African American dance, DCDC is known for athleticism, emotional depth, and expressive storytelling rooted in the African American experience. Presented free as part of the Heinz Poll Summer Dance Festival at Goodyear Heights Metro Park.',
  },
  {
    company: 'Inlet Dance Theatre',
    key:     'inlet-dance-theatre',
    dates:   ['2026-08-07', '2026-08-08'],
    venue:   'Firestone Park',
    website: 'https://www.inletdance.org/',
    description:
      'Celebrating its 25th anniversary season, Inlet Dance Theatre is one of the region\'s leading contemporary dance companies, rooted in American Modern Dance and founded by Executive/Artistic Director Bill Wade. Its signature athletic partnering and eclectic repertoire range from playful works to visually stunning storytelling. Presented free as part of the Heinz Poll Summer Dance Festival at Firestone Park.',
  },
]

/** The Akron parks that host performances, keyed by the name used above. */
const VENUES = {
  'Forest Lodge Park':            { city: 'Akron', state: 'OH' },
  'Goodyear Heights Metro Park':  { city: 'Akron', state: 'OH' },
  'Firestone Park':               { city: 'Akron', state: 'OH' },
}

/**
 * Expand PERFORMANCES into one event row per company+date. Skips dates already
 * in the past (1-day grace). Pure — exported for tests.
 */
export function buildEvents(performances = PERFORMANCES, now = new Date()) {
  const cutoff = now.getTime() - 86_400_000
  const out = []
  for (const p of performances) {
    for (const date of p.dates) {
      const start_at = easternToIso(date, SHOW_TIME)
      if (!start_at || Date.parse(start_at) < cutoff) continue
      out.push({
        venue: p.venue,
        row: {
          title:           `${p.company} — Heinz Poll Summer Dance Festival`,
          description:     `${p.description}${CHILDRENS_NOTE}`,
          start_at,
          end_at:          null,
          category:        'theater',   // taxonomy maps dance → theater
          tags:            ['dance', 'heinz-poll-festival', 'free', 'outdoor', 'family', 'performing-arts'],
          price_min:       0,           // explicitly free public performances
          price_max:       0,
          age_restriction: 'all_ages',
          image_url:       null,
          ticket_url:      `${SITE}/index.html`,
          source:          SOURCE_KEY,
          source_id:       `${p.key}-${date}`,
          status:          'published',
          featured:        false,
        },
      })
    }
  }
  return out
}

async function main() {
  console.log('💃  Starting Heinz Poll Summer Dance Festival ingestion…')
  const start = Date.now()
  try {
    const organizerId = await ensureOrganization(ORG_NAME, {
      website: SITE,
      description: 'The Heinz Poll Summer Dance Festival is the City of Akron\'s long-running series of free professional dance performances in public parks, honoring Heinz Poll, founding Artistic Director of Ohio Ballet.',
    })

    const events = buildEvents()
    console.log(`  ${events.length} upcoming performance(s) to ingest`)

    const venueCache = new Map()
    let inserted = 0, skipped = 0
    for (const { row, venue } of events) {
      try {
        let venueId = venueCache.get(venue)
        if (venueId === undefined) {
          venueId = await ensureVenue(venue, VENUES[venue] || { city: 'Akron', state: 'OH' })
          venueCache.set(venue, venueId)
        }
        const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
        if (error) { console.warn(`  ⚠ Upsert failed "${row.title}":`, error.message); skipped++; continue }
        if (venueId)     await linkEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        inserted++
      } catch (err) {
        console.warn(`  ⚠ Error on "${row.title}":`, err.message)
        skipped++
      }
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, { eventsFound: events.length, durationMs: Date.now() - start })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} upserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
