/**
 * category-inference.js — text → events.category classifier.
 *
 * Replaces the previous first-match-wins regex cascade with a SCORED
 * classifier. Instead of returning the category of whichever rule happened to
 * be tested first, every signal contributes a weight to its category and the
 * highest total wins. This makes precedence explicit (a weight you can read and
 * tune) rather than implicit (the line order of a 70-line if-chain), and lets
 * an event accumulate evidence from several weak signals.
 *
 * Pure & dependency-light: imports only the canonical slug list so it can never
 * emit a category the rest of the app doesn't know about. No DB, no env — so it
 * is trivially unit-testable (see scripts/tests/test-category-inference.js).
 *
 * Output contract is UNCHANGED from the old inferCategory: returns exactly one
 * slug from CATEGORY_SLUGS, and returns 'other' when nothing matches (so the
 * caller's needs_review auto-flagging still works).
 *
 * ── Weight tiers ────────────────────────────────────────────────────
 *   DECISIVE (100) unambiguous: "concert", "gallery", "5k", "brewery"
 *   STRONG    (70) reliable but not absolute: artist-bio vocabulary, "seminar"
 *   SOFT      (40) suggestive, title-only profession words, generic "workshop"
 *   WEAK      (25) faint hints
 *   A few signals sit just above a tier (e.g. comedy = 110) to win a specific
 *   documented collision — see inline notes.
 *
 * On an exact tie, PRIORITY (below) breaks it, reproducing the old cascade's
 * section order so behavior matches the legacy classifier on overlapping text.
 */

import { CATEGORY_SLUGS } from '../../src/lib/categories.js'

const DECISIVE = 100
const STRONG = 70
const SOFT = 40
const WEAK = 25

// Tie-break order, mirroring the legacy cascade's section order. Earlier wins.
const PRIORITY = [
  'music', 'sports', 'fitness', 'education', 'art',
  'food', 'nature', 'community', 'nonprofit', 'other',
]

// ── Reused sub-patterns (ported verbatim from the legacy cascade) ───────────
const _MUSIC_VENUES = /(@|\bat)\s+(the\s+)?(?:\w+\s+){0,2}(old 97|vortex|matinee|musica|jilly'?s|barmacy|blu jazz|empire concert|goodyear theat(er|re)|akron civic|knight stage|tangier|stage door|lock 4|kent stage|civic theatre)\b/i
const _GENERIC_TOUR_EXCLUSION = /(walking|guided|historical|garden|home|food|brewery|trolley|architecture|museum|self[- ]guided|virtual|haunted|farm|driving|kayak|free|weekly|exhibit|art|behind[- ]?the[- ]?scenes|members'?|public|private|holiday|cemetery|winery|wine|history|ghost)\s+tour|tour\s*:/i
const _LEARN_NOT_EDUCATIONAL = /\blearn\s+(more|why|all|about|everything|here|now|first|today|tomorrow)\b/i

/**
 * Signal table. Each entry adds `w` to `cat`'s score when `re` matches.
 * `scope: 'title'` tests the title only; default tests title + description.
 * Order is irrelevant to the result — only weights and matches matter — but
 * entries are grouped by category for readability.
 */
const SIGNALS = [
  // ── Music ──────────────────────────────────────────────────────────
  { cat: 'music', w: DECISIVE, re: /\b(concert|symphony|orchestra|recital|live music|live band|open mic|karaoke|sing[- ]along|songwriter night|jazz night|blues night|dj set|sound check|album release|ep release|single release|musical guest|tribute (band|act|show|to)|spotify|on spotify)\b/ },
  { cat: 'music', w: DECISIVE, re: /\btribute\b/ },
  { cat: 'music', w: STRONG,   re: /\b(singer[- ]songwriter|guitarist|drummer|bassist|saxophonist|pianist|trumpeter|cellist|violinist|multi[- ]?instrumentalist|frontman|frontwoman|frontperson)\b/ },
  { cat: 'music', w: STRONG,   re: /\b(two|three|four|five|six|seven|eight)[- ]piece band\b/ },
  { cat: 'music', w: STRONG,   re: /\b(music scene|debut (album|record|ep|single)|released (his|her|their) (debut |first |new |latest )?(album|record|ep|single)|touring (band|artist|musician)|nationally touring|on tour\b)\b/ },
  { cat: 'music', w: STRONG,   re: _MUSIC_VENUES, scope: 'title' },
  { cat: 'music', w: SOFT,     re: /\b(blues|jazz|metalcore|nu[- ]metal|death metal|hardcore punk|grindcore|hip[- ]?hop|rap music|reggae|bluegrass|americana|alt[- ]?country|shoegaze|electronica|\bedm\b)\b/ },
  { cat: 'music', w: SOFT,     re: /\b(band\b|live performance|performer|musician|vocalist|jam session|sing[- ]?along)\b/, scope: 'title' },
  { cat: 'music', w: SOFT,     re: /\b(music night|night of music|performance by|featuring [a-z]+ band)\b/ },

  // ── Sports ─────────────────────────────────────────────────────────
  { cat: 'sports', w: DECISIVE, re: /\b(rubberducks|cleveland cavaliers|cleveland browns|cleveland guardians|cleveland indians|cavs|browns|guardians|hockey game|baseball game|basketball game|tournament championship|home game|home court|matchday|playoff|stadium)\b/ },
  { cat: 'sports', w: STRONG,   re: /\b[a-z][a-z .'&]+ vs\.? [a-z][a-z .'&]+\b/, scope: 'title' },

  // ── Fitness ────────────────────────────────────────────────────────
  { cat: 'fitness', w: DECISIVE, re: /\b(5k|10k|half[- ]?marathon|marathon|fun run|trail run|color run|yoga|pilates|crossfit|spin class|hiit|cardio|paddleboard(ing)?|kayak(ing)?|canoe|stand[- ]up paddle|cycle class|cycling class|barre class)\b/ },

  // ── Education ──────────────────────────────────────────────────────
  { cat: 'education', w: DECISIVE, re: /\b(certification|professional development|continuing education|sat prep|gre prep|esol classes|ged classes|lean six sigma|pmp|leadership training|sales training|management training|conflict resolution training|coding bootcamp|reiki .* certification|six sigma)\b/ },
  { cat: 'education', w: DECISIVE, re: /\b\d+[- ]day workshop\b/ },
  { cat: 'education', w: STRONG,   re: /\b(seminar|lecture series|symposium|webinar|conference|masterclass)\b/ },
  { cat: 'education', w: STRONG,   re: /\b(scam|scammer|fraud|phishing|identity theft|cyber(security| safety)|online safety|consumer (safety|protection|fraud)|financial (literacy|safety|fraud)|digital literacy|internet safety|password safety|outsmart|avoid (scams?|fraud)|protect yourself)\b/ },
  { cat: 'education', w: STRONG,   re: /\b(information session|info session|orientation (session|program)?|new student orientation|open enrollment|enrollment clinic|free clinic|financial aid clinic|tax clinic|legal clinic|resource fair)\b/ },
  { cat: 'education', w: SOFT,     re: /\b(workshop|class\b|course|training session|lesson|book club|book discussion|study group|reading group)\b/ },

  // ── Art ────────────────────────────────────────────────────────────
  // Comedy sits at 110 so "comedy open mic" beats music's DECISIVE "open mic"
  // exactly as the legacy cascade did (it tested comedy first).
  { cat: 'art', w: 110,      re: /\bcomedy (open mic|night)\b/ },
  { cat: 'art', w: DECISIVE, re: /\b(gallery|exhibition|exhibit opening|opening (reception|celebration)|artist reception|artist talk|sculpture show|mural unveiling|art show|art fair|installation|vernissage)\b/ },
  { cat: 'art', w: DECISIVE, re: /\b(theat(re|er)|playwright|broadway|stage production|musical (theatre|theater|production)s?|opera|ballet|dance company|stand[- ]?up comedy|comedy night|comedy show|improv|drag (show|brunch|king|queen|bingo))\b/ },
  { cat: 'art', w: 90,       re: /\b(paint (and|&|n)\s*sip|puff (and|&|n)\s*paint|paint(ing)? class|pottery|ceramics|sketching workshop|drawing class)\b/ },

  // ── Food ───────────────────────────────────────────────────────────
  { cat: 'food', w: DECISIVE, re: /\b(brewery|winery|wine tasting|beer tasting|cooking class|culinary|food truck|food festival|restaurant week|tap takeover|chef'?s table|tasting menu|wine dinner|whiskey tasting|cocktail (class|essentials|workshop)|brunch|luncheon|dinner show|drag brunch|sake|sushi tasting|cheese tasting|bourbon tasting|coffee tasting|chocolate tasting|culinary class)\b/ },

  // ── Nature ─────────────────────────────────────────────────────────
  { cat: 'nature', w: STRONG, re: /\b(park|trail|nature walk|nature center|garden|arboretum|zoo|wildlife|botanical|bird walk|hike|hiking|conservation|outdoor adventure|metro park)\b/ },

  // ── Community ──────────────────────────────────────────────────────
  { cat: 'community', w: SOFT, re: /\b(festival|fair|farmers market|street market|parade|block party|community gathering|town hall|civic event|neighborhood meeting|family game night|family event|game night|trivia night|story[- ]?time|story hour|holiday celebration|seniorlinked|senior expo|family gathering)\b/ },

  // ── Nonprofit ──────────────────────────────────────────────────────
  { cat: 'nonprofit', w: STRONG, re: /\b(fundraiser|benefit dinner|silent auction|gala|service event|volunteer day|charity event|nonprofit|food drive|blood drive|donation drive|support group)\b/ },
]

/**
 * Conditional signals that can't be expressed as a single regex (they depend on
 * one pattern matching AND another NOT matching). Each returns `{ cat, w }` or
 * null. Kept separate from the SIGNALS table for clarity.
 */
function conditionalSignals(text, tLow) {
  const out = []

  // "open mic" + comedy mention (without the literal "comedy open mic") → art,
  // beating music. Mirrors the legacy first rule's second clause.
  if (/\bopen mic\b/.test(text) && /\bcomedy|comedians?\b/.test(text)) {
    out.push({ cat: 'art', w: 110 })
  }

  // Bare "Tour" in the title is usually a concert tour — UNLESS qualified by
  // walking/guided/garden/brewery/etc. Demoted from the legacy's near-top
  // precedence to STRONG so a decisive sports/food/art signal can override it
  // (the old "tour → music" rule was the classifier's most false-positive-prone
  // line; see taxonomy report §3). Plain "Spring Tour" still lands on music.
  if (/\btour\b/.test(tLow) && !_GENERIC_TOUR_EXCLUSION.test(text)) {
    out.push({ cat: 'music', w: STRONG })
  }

  // "Learn X" how-to events → education, excluding marketing CTAs like
  // "Learn more about…".
  if (/\blearn\s+\w/i.test(tLow) && !_LEARN_NOT_EDUCATIONAL.test(tLow)) {
    out.push({ cat: 'education', w: SOFT })
  }

  return out
}

/**
 * Score every category for the given text. Returns a plain object
 * { category: totalWeight, ... } containing only categories that scored > 0.
 * Exposed for tests and for future "needs_review when top two are close" logic.
 */
export function scoreCategories(title = '', description = '') {
  const text = `${title || ''} ${description || ''}`.toLowerCase()
  const tLow = (title || '').toLowerCase()

  const scores = {}
  const add = ({ cat, w }) => { scores[cat] = (scores[cat] || 0) + w }

  for (const sig of SIGNALS) {
    // Title-scoped signals test the (lower-cased) title only; everything else
    // tests title + description. All signal patterns are lower-case (or carry
    // the /i flag), so testing against the lower-cased haystack is correct.
    const subject = sig.scope === 'title' ? tLow : text
    if (sig.re.test(subject)) add(sig)
  }
  for (const sig of conditionalSignals(text, tLow)) add(sig)

  return scores
}

/**
 * Infer a single events.category value from free text.
 *
 * @param {string} title        event title
 * @param {string} description  event description (optional)
 * @returns {string}            one slug from CATEGORY_SLUGS; 'other' if nothing
 *                              scored.
 */
export function inferCategory(title = '', description = '') {
  const scores = scoreCategories(title, description)
  const cats = Object.keys(scores)
  if (cats.length === 0) return 'other'

  let best = null
  for (const cat of cats) {
    if (
      best === null ||
      scores[cat] > scores[best] ||
      (scores[cat] === scores[best] &&
        PRIORITY.indexOf(cat) < PRIORITY.indexOf(best))
    ) {
      best = cat
    }
  }

  // Defensive: never emit a slug the rest of the app doesn't recognise.
  return CATEGORY_SLUGS.includes(best) ? best : 'other'
}
