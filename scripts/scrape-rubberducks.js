/**
 * scrape-rubberducks.js
 *
 * Fetches the Akron RubberDucks home game schedule for the current season
 * using the public MLB Stats API. No authentication required.
 *
 * Usage:
 *   node scripts/scrape-rubberducks.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import { supabaseAdmin } from './lib/supabase-admin.js'
import { logUpsertResult, logScraperError } from './lib/normalize.js'

const TEAM_ID     = 402     // Akron RubberDucks
const MLB_API_BASE = 'https://statsapi.mlb.com/api/v1/schedule'

// ── Venue / Organizer ──────────────────────────────────────────────────────

async function ensureVenue() {
  const { data: existing } = await supabaseAdmin
    .from('venues').select('id').eq('name', '7 17 Credit Union Park').maybeSingle()
  if (existing) return existing.id

  const { data, error } = await supabaseAdmin.from('venues').insert({
    name:          '7 17 Credit Union Park',
    address:       '300 S Main St',
    city:          'Akron',
    state:         'OH',
    zip:           '44308',
    lat:           41.0765,
    lng:           -81.5185,
    parking_type:  'lot',
    parking_notes: 'Paid parking available in lots surrounding the stadium.',
    website:       'https://www.milb.com/akron',
  }).select('id').single()

  if (error) { console.warn('  ⚠ Could not create 7 17 Credit Union Park venue:', error.message); return null }
  console.log('  ✚ Created venue: 7 17 Credit Union Park')
  return data.id
}

async function ensureOrganizer() {
  const { data: existing } = await supabaseAdmin
    .from('organizers').select('id').eq('name', 'Akron RubberDucks').maybeSingle()
  if (existing) return existing.id

  const { data, error } = await supabaseAdmin.from('organizers').insert({
    name:        'Akron RubberDucks',
    website:     'https://www.milb.com/akron',
    description: 'The Akron RubberDucks are the Double-A affiliate of the Cleveland Guardians, playing at 7 17 Credit Union Park in downtown Akron.',
  }).select('id').single()

  if (error) { console.warn('  ⚠ Could not create RubberDucks organizer:', error.message); return null }
  console.log('  ✚ Created Akron RubberDucks organizer')
  return data.id
}

// ── Fetch schedule ─────────────────────────────────────────────────────────

async function fetchSchedule() {
  const year      = new Date().getFullYear()
  const startDate = `${year}-04-01`
  const endDate   = `${year}-09-30`

  const url = new URL(MLB_API_BASE)
  url.searchParams.set('lang',          'en')
  url.searchParams.set('sportId',       '11,12,13,14,15,16,5442')
  url.searchParams.set('hydrate',       'team,venue,game(promotions)')
  url.searchParams.set('season',        year)
  url.searchParams.set('startDate',     startDate)
  url.searchParams.set('endDate',       endDate)
  url.searchParams.set('teamId',        TEAM_ID)
  url.searchParams.set('eventTypes',    'primary')
  url.searchParams.set('scheduleTypes', 'games,events,xref')

  console.log(`\n🔍  Fetching RubberDucks ${year} home schedule from MLB Stats API…`)

  const res = await fetch(url.toString(), {
    headers: {
      Accept:       'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; The330-bot/1.0)',
    },
  })

  if (!res.ok) throw new Error(`MLB Stats API error ${res.status}: ${await res.text()}`)

  const data  = await res.json()
  const dates = data.dates ?? []

  // Flatten all games into a single array
  const games = dates.flatMap(d => d.games ?? [])
  console.log(`  Found ${games.length} total games`)
  return games
}

// ── Process games ──────────────────────────────────────────────────────────

async function processGames(games, venueId, organizerId) {
  let inserted = 0, skipped = 0, homeGames = 0

  for (const game of games) {
    try {
      // Only home games
      const homeTeamId = game.teams?.home?.team?.id
      if (homeTeamId !== TEAM_ID) { skipped++; continue }

      // Skip cancelled/postponed
      const state = game.status?.detailedState ?? ''
      if (state === 'Cancelled' || state === 'Postponed') { skipped++; continue }

      homeGames++

      const awayTeam    = game.teams?.away?.team?.name ?? 'Unknown Opponent'
      const promotions  = game.promotions ?? []
      const promoNames  = promotions.map(p => p.name).filter(Boolean)

      const title = `RubberDucks vs. ${awayTeam}`
      let description = `Home game at 7 17 Credit Union Park. ${awayTeam} visits Akron.`
      if (promoNames.length) description += ` Promotions: ${promoNames.join(', ')}.`

      const imageUrl   = promotions[0]?.thumbnailUrl ?? null
      const startAt    = game.gameDate  // already UTC ISO from MLB API

      const row = {
        title,
        description,
        start_at:        startAt,
        end_at:          null,
        venue_id:        venueId,
        organizer_id:    organizerId,
        category:        'sports',
        tags:            ['baseball', 'minor-league', 'rubberducks', 'family'],
        price_min:       10,
        price_max:       null,
        age_restriction: 'all_ages',
        image_url:       imageUrl,
        ticket_url:      'https://www.milb.com/akron/tickets',
        source:          'rubberducks',
        source_id:       String(game.gamePk),
        status:          'published',
        featured:        false,
      }

      if (!row.start_at) { skipped++; continue }

      const { error } = await supabaseAdmin
        .from('events')
        .upsert(row, { onConflict: 'source,source_id', ignoreDuplicates: false })

      if (error) { console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message); skipped++ }
      else inserted++
    } catch (err) {
      console.warn(`  ⚠ Error processing game ${game.gamePk}:`, err.message)
      skipped++
    }
  }

  console.log(`  Home games found: ${homeGames}`)
  return { inserted, skipped, homeGames }
}

// ── Entry point ────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting Akron RubberDucks ingestion…')
  const start = Date.now()

  try {
    const [venueId, organizerId] = await Promise.all([ensureVenue(), ensureOrganizer()])
    const games = await fetchSchedule()
    console.log(`\n📥  Processing ${games.length} games…`)

    const { inserted, skipped, homeGames } = await processGames(games, venueId, organizerId)
    await logUpsertResult('rubberducks', inserted, 0, skipped, {
      eventsFound: homeGames,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError('rubberducks', err, start)
    process.exit(1)
  }
}

main()
