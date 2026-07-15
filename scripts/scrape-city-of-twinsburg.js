/**
 * scrape-city-of-twinsburg.js
 *
 * City of Twinsburg, Ohio (Summit County) — CivicPlus (CivicEngage) site at
 * mytwinsburg.com. Twinsburg splits its calendar into named categories, each
 * exposed as an RFC 5545 iCalendar feed at
 *   /common/modules/iCalendar/iCalendar.aspx?catID={id}&feed=calendar
 * (verified 2026-07-14):
 *
 *   14  Main Calendar     — the aggregate of everything on the site: the
 *       governance rows (Council/Caucus, BZA, ARB, Planning/Environmental/
 *       Civil-Service Commissions, Capital Improvements Board, Finance
 *       Committee, JEDI, public hearings — all dropped by the shared admin
 *       filter) PLUS the public lineup below. This is a superset of the
 *       public sub-calendars, so it alone carries every public event.
 *   22  Parks & Recreation — Rock the Park concert series, Sunrise Yoga,
 *       Center Valley Trail Clean-up, Adult Co-ed Softball, rec classes.
 *   24  Fitness Center     — Fitness Center programming (Sunrise Yoga).
 *   25  Community Events    — the city's public "Community Events" calendar.
 *   31  Around Town         — community-wide happenings.
 *
 * catIDs 22/24/25/31 are subsets of 14; they are included defensively (the
 * shared runner merges + dedupes by UID) so a public event posted only to a
 * Parks/Rec/Fitness calendar still flows in if it never reaches Main.
 *
 * Deliberately EXCLUDED:
 *   23  Meetings — governance-only (51 council/board/commission rows,
 *       nothing public). The shared admin filter would drop them anyway, but
 *       skipping the feed avoids fetching 51 rows we throw away every run.
 *
 * Public programming clusters at Glen Chamberlin Park / the Twinsburg
 * Community Center (both at 10260 Ravenna Road): the Rock the Park summer
 * concert series, Sunrise Yoga, seasonal trail clean-ups, adult rec sports
 * leagues, and Red Cross rec classes (Babysitter Training, CPR/AED, Pool
 * Operator). Data quirks handled by lib/civicplus.js: LOCATION arrives both
 * plain ("Twinsburg Community Center - 10260 Ravenna Road  Twinsburg OH
 * 44087") and HTML-wrapped ("<p>Glen Chamberlin Park</p> - 10260 Ravenna
 * Road ..."), and the per-VEVENT URL points back at the feed, so the real
 * detail page is reconstructed as /calendar.aspx?EID={UID} from the numeric UID.
 *
 * Twinsburg (the city) is entirely within Summit County, so every venue is a
 * fixed Summit location — no per-event geo classification is needed.
 *
 * Usage:   node scripts/scrape-city-of-twinsburg.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import { runCivicPlusScraper, defaultMapCategory } from './lib/civicplus.js'

export const SOURCE_KEY = 'city_of_twinsburg'

/**
 * Category override composed over the shared CivicPlus default. Two Twinsburg
 * recurring series aren't captured by the generic keyword map:
 *   • "Rock the Park: <band>" is the city's summer outdoor concert series, but
 *     the title carries no "concert/music/band" word, so it would fall through
 *     to text inference. Force it to `music`.
 *   • "Twinsburg Adult Co-ed Softball" (and kindred rec leagues) is a
 *     competitive team sport — `sports`, not the generic `fitness` bucket the
 *     default would leave null.
 * Everything else defers to defaultMapCategory (yoga → fitness, trail
 * clean-up → outdoors, rec classes → learning, etc.).
 */
export function mapCategory(ev) {
  const s = `${ev?.SUMMARY || ''} ${ev?.DESCRIPTION || ''}`.toLowerCase()
  if (/\brock the park\b/.test(s)) return 'music'
  if (/\b(softball|baseball|kickball|pickleball|basketball|volleyball|soccer)\b/.test(s)) return 'sports'
  return defaultMapCategory(ev)
}

const CONFIG = {
  source:    SOURCE_KEY,
  origin:    'https://www.mytwinsburg.com',
  // 14 Main (superset) + public sub-calendars; 23 Meetings excluded.
  catIDs:    [14, 22, 24, 25, 31],
  cityLabel: 'Twinsburg',
  emoji:     '🎸',
  organization: {
    name: 'City of Twinsburg',
    details: {
      website:     'https://www.mytwinsburg.com',
      description: 'City of Twinsburg (Summit County, OH) — municipal Parks & Recreation and community programming: the Rock the Park summer concert series and Sunrise Yoga at Glen Chamberlin Park, seasonal trail clean-ups, adult rec sports leagues, and community classes at the Twinsburg Community Center.',
    },
  },
  defaultVenue: {
    name:    'Twinsburg Community Center',
    address: '10260 Ravenna Road',
    zip:     '44087',
    website: 'https://www.mytwinsburg.com',
  },
  baseTags: ['city-of-twinsburg', 'twinsburg-ohio', 'summit-county'],
  mapCategory,
}

// Import-safe: the shared runner fetches feeds and writes to the DB, so it must
// only fire when this file is executed directly — importing the module (e.g.
// from the test) must never trigger a live scrape.
function main() {
  return runCivicPlusScraper(CONFIG)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
