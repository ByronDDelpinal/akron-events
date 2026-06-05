/**
 * category-inference.js — text → taxonomy classifier (Option 6 / faceted).
 *
 * Scored classifier (not first-match-wins). Every signal contributes a weight
 * to its category; the highest total wins. Emits the 14 content categories and
 * returns UP TO 2 (multi-category), plus the cross-cutting facet flags
 * { family, fundraiser } scored independently of content.
 *
 * Pure & dependency-light (imports only the canonical slug list). Contract:
 *   inferCategories(title, desc) -> { categories: string[1..2], family, fundraiser }
 *   inferCategory(title, desc)   -> string   (primary content category; back-compat)
 *
 * `family` is HIGH-BAR on purpose: explicit kid/family PROGRAMMING language
 * only (not "all ages", not beneficiary words like "supporting local youth").
 */

import { CATEGORY_SLUGS } from '../../src/lib/categories.js'

const DECISIVE = 100
const STRONG = 70
const SOFT = 40
const WEAK = 25

const PRIORITY = [
  'music', 'comedy', 'theater', 'film', 'visual-art', 'sports', 'fitness',
  'food', 'learning', 'outdoors', 'festival', 'market', 'civic', 'other',
]

const SECONDARY_MIN_SCORE = 70
const SECONDARY_MIN_RATIO = 0.5

const _MUSIC_VENUES = /(@|\bat)\s+(the\s+)?(?:\w+\s+){0,2}(old 97|vorte[xz]|matinee|musica|jilly'?s|barmacy|blu jazz|empire concert|goodyear theat(er|re)|akron civic|knight stage|tangier|stage door|lock 4|kent stage|civic theatre)\b/i
const _GENERIC_TOUR_EXCLUSION = /(walking|guided|historical|garden|home|food|brewery|trolley|architecture|museum|self[- ]guided|virtual|haunted|farm|driving|kayak|free|weekly|exhibit|art|behind[- ]?the[- ]?scenes|members'?|public|private|holiday|cemetery|winery|wine|history|ghost)\s+tour|tour\s*:/i
const _LEARN_NOT_EDUCATIONAL = /\blearn\s+(more|why|all|about|everything|here|now|first|today|tomorrow)\b/i

const SIGNALS = [
  // Music
  { cat: 'music', w: DECISIVE, re: /\b(concert|symphony|orchestra|recital|live music|live bands?|open mic|karaoke|sing[- ]along|songwriter night|jazz night|blues night|dj set|album release|ep release|single release|musical guest|tribute (band|act|show|to)|on spotify)\b/ },
  { cat: 'music', w: DECISIVE, re: /\btribute\b/ },
  { cat: 'music', w: WEAK,     re: /\bmusic\b/, scope: 'title' },
  { cat: 'music', w: STRONG,   re: /\b(singer[-/ ]songwriter|guitarist|drummer|bassist|saxophonist|pianist|trumpeter|cellist|violinist|multi[- ]?instrumentalist|frontman|frontwoman)\b/ },
  { cat: 'music', w: STRONG,   re: /\b(two|three|four|five|six|seven|eight)[- ]piece band\b/ },
  { cat: 'music', w: STRONG,   re: /\b(music scene|debut (album|record|ep|single)|touring (band|artist|musician)|nationally touring|on tour\b)\b/ },
  { cat: 'music', w: STRONG,   re: _MUSIC_VENUES, scope: 'title' },
  { cat: 'music', w: SOFT,     re: /\b(blues|jazz|metalcore|nu[- ]metal|death metal|hardcore punk|grindcore|hip[- ]?hop|rap music|reggae|bluegrass|americana|alt[- ]?country|shoegaze|electronica|\bedm\b)\b/ },
  { cat: 'music', w: SOFT,     re: /\b(band\b|live performance|performer|musician|vocalist|jam session)\b/, scope: 'title' },

  // Theater
  { cat: 'theater', w: DECISIVE, re: /\b(theat(re|er)|playwright|broadway|stage production|musical (theatre|theater|production)s?|opera|ballet|dance company|one[- ]act|black box|shakespeare)\b/ },

  // Film
  { cat: 'film', w: DECISIVE, re: /\b(film screening|screening|cinema|movie night|documentary|short films?|feature film|silent film|film festival|matinee showing|the nightlight)\b/ },
  { cat: 'film', w: STRONG,   re: /\bfilms?\b/ },

  // Comedy (110 so "comedy open mic" beats music's "open mic").
  // NOTE: bare "stand-up" is intentionally NOT a comedy signal — it collides
  // with "stand-up paddleboard" (fitness). Require explicit comedy wording.
  { cat: 'comedy', w: 110,      re: /\bcomedy (open mic|night|show|jam)\b/ },
  { cat: 'comedy', w: DECISIVE, re: /\b(stand[- ]?up comedy|stand[- ]?up comedian|comedian|comedians|comedy jam|improv|sketch comedy|open mic comedy|drag (show|brunch|king|queen|bingo))\b/ },

  // Visual art
  { cat: 'visual-art', w: DECISIVE, re: /\b(gallery|exhibition|exhibit opening|opening (reception|celebration)|artist reception|artist talk|sculpture|mural|art show|art walk|art fair|installation|vernissage)\b/ },
  { cat: 'visual-art', w: 90,       re: /\b(paint (and|&|n)\s*sip|puff (and|&|n)\s*paint|paint(ing)? class|art class|art workshop|pottery|ceramics|sketching workshop|drawing class)\b/ },
  // Crafts / maker programs (library + community staples). These rarely carry
  // a real description, so the title has to do the work.
  { cat: 'visual-art', w: STRONG,   re: /\b(knit|knitting|crochet|needle ?(point|craft|work)|cross[- ]stitch|quilt(ing)?|yarn|crafternoon|crafters?\b|coloring|canvas|collage|scrapbook|water ?color|calligraphy|origami|macrame|weaving|felt(ed|ing)|embroider|sewing|diy\b|make[- ]and[- ]take|open studio)\b/ },

  // Food
  { cat: 'food', w: DECISIVE, re: /\b(brewery|winery|wine tasting|beer tasting|cooking class|culinary|food truck|food festival|restaurant week|tap takeover|chef'?s table|tasting menu|wine dinner|whiskey tasting|cocktail (class|essentials|workshop)|brunch|luncheon|dinner show|drag brunch|sake|sushi tasting|cheese tasting|bourbon tasting|coffee tasting|chocolate tasting)\b/ },

  // Sports
  { cat: 'sports', w: DECISIVE, re: /\b(rubberducks|cleveland cavaliers|cleveland browns|cleveland guardians|cleveland indians|cavs|browns|guardians|hockey game|baseball game|basketball game|tournament championship|home game|home court|matchday|playoff|stadium)\b/ },
  { cat: 'sports', w: STRONG,   re: /\b[a-z][a-z .'&]+ vs\.? [a-z][a-z .'&]+\b/, scope: 'title' },

  // Fitness
  { cat: 'fitness', w: DECISIVE, re: /\b(5k|10k|half[- ]?marathon|marathon|fun run|trail run|color run|yoga|pilates|crossfit|spin class|hiit|cardio|paddleboard(ing)?|kayak(ing)?|canoe|stand[- ]up paddle|cycle class|cycling class|barre class)\b/ },

  // Outdoors
  { cat: 'outdoors', w: STRONG, re: /\b(park|trail|nature walk|nature center|naturalist|garden|arboretum|zoo|wildlife|botanical|bird (walk|nerd)|birding|hike|hiking|conservation|outdoor adventure|metro park|towpath|fishing|camping|archery|kayak)\b/ },

  // Learning
  { cat: 'learning', w: DECISIVE, re: /\b(certification|professional development|continuing education|sat prep|gre prep|esol classes|ged classes|lean six sigma|pmp|leadership training|sales training|management training|conflict resolution training|coding bootcamp|six sigma)\b/ },
  { cat: 'learning', w: DECISIVE, re: /\b\d+[- ]day workshop\b/ },
  { cat: 'learning', w: STRONG,   re: /\b(seminar|lecture series|symposium|webinar|conference|masterclass)\b/ },
  { cat: 'learning', w: STRONG,   re: /\b(scam|scammer|fraud|phishing|identity theft|cyber(security| safety)|online safety|consumer (safety|protection|fraud)|financial (literacy|safety|fraud)|digital literacy|internet safety|outsmart|avoid (scams?|fraud)|protect yourself)\b/ },
  { cat: 'learning', w: STRONG,   re: /\b(information session|info session|orientation (session|program)?|new student orientation|open enrollment|enrollment clinic|free clinic|financial aid clinic|tax clinic|legal clinic)\b/ },
  { cat: 'learning', w: SOFT,     re: /\b(workshop|class\b|course|training session|lesson|book club|book discussion|study group|reading group)\b/ },
  // Library / job-help / STEM / civic-literacy programs — a huge slice of the
  // real calendar that the original signals missed entirely.
  { cat: 'learning', w: STRONG,   re: /\b(ged\b|esl\b|ohiomeansjobs|career coach|job (search|help|fair|readiness|club)|resume|homework help|tutoring|paws for reading|read(ing)? (to|with) (a |the )?(dog|therapy)|lego club|s\.?t\.?e\.?m\.?\b|robotics|coding|microsoft (word|excel|office)|computer (class|basics|skills)|medicare|retirement planning|financial (literacy|planning)|citizenship|english (class|conversation)|edible science|science camp|engineering camp|summer camp|maker ?space)\b/ },

  // Festival
  { cat: 'festival', w: DECISIVE, re: /\b(festival|fireworks|carnival|parade|block party)\b/ },
  { cat: 'festival', w: STRONG,   re: /\b(fair|holiday celebration|street fair|fest\b|community day|family fun day|fun day|field day)\b/ },

  // Market
  { cat: 'market', w: DECISIVE, re: /\b(farmers? market|makers? market|street market|night market|flea market|holiday market|artisan market|craft (market|show|fair)|vendor (market|fair)|pop[- ]?up market)\b/ },

  // Civic
  { cat: 'civic', w: STRONG, re: /\b(town hall|city council|civic|ward meeting|neighborhood meeting|community meeting|public hearing|community gathering|senior expo|(committee|board|membership|annual|business) meeting|board of directors)\b/ },
]

function conditionalContentSignals(text, tLow) {
  const out = []
  if (/\bopen mic\b/.test(text) && /\bcomedy|comedians?\b/.test(text)) out.push({ cat: 'comedy', w: 110 })
  if (/\btour\b/.test(tLow) && !_GENERIC_TOUR_EXCLUSION.test(text)) out.push({ cat: 'music', w: STRONG })
  if (/\blearn\s+\w/i.test(tLow) && !_LEARN_NOT_EDUCATIONAL.test(tLow)) out.push({ cat: 'learning', w: SOFT })
  return out
}

const FAMILY_RE = /\b(story ?time|story hour|kids?|children'?s?|family[- ]friendly|toddlers?|preschool|for kids|kid[- ]friendly|children'?s museum|family game night|family day|all[- ]ages family|grade[- ]schoolers|grades? [k0-9]|ages \d+ ?(to|-|–) ?\d+|little (explorers|ones)|baby|babies)\b/
const FUNDRAISER_RE = /\b(fundraiser|fund[- ]?raising|gala|benefit (dinner|concert|show|night|gala|auction)|silent auction|charity|proceeds (benefit|support|go to|will)|raise (money|funds)|volunteer(s|ing)?|service event|park cleanup|clean[- ]?up|food drive|blood drive|donation drive|nonprofit|non[- ]profit|in support of|golf outing)\b/

export function scoreCategories(title = '', description = '') {
  const text = `${title || ''} ${description || ''}`.toLowerCase()
  const tLow = (title || '').toLowerCase()
  const scores = {}
  const add = ({ cat, w }) => { scores[cat] = (scores[cat] || 0) + w }
  for (const sig of SIGNALS) {
    const subject = sig.scope === 'title' ? tLow : text
    if (sig.re.test(subject)) add(sig)
  }
  for (const sig of conditionalContentSignals(text, tLow)) add(sig)
  return scores
}

export function inferFacets(title = '', description = '') {
  const text = `${title || ''} ${description || ''}`.toLowerCase()
  return {
    family: FAMILY_RE.test(text),
    fundraiser: FUNDRAISER_RE.test(text),
  }
}

export function inferCategories(title = '', description = '') {
  const scores = scoreCategories(title, description)
  const { family, fundraiser } = inferFacets(title, description)

  const ranked = Object.keys(scores).sort((a, b) => {
    if (scores[b] !== scores[a]) return scores[b] - scores[a]
    return PRIORITY.indexOf(a) - PRIORITY.indexOf(b)
  })

  let categories
  if (ranked.length === 0) {
    categories = ['other']
  } else {
    const primary = ranked[0]
    const out = [primary]
    const second = ranked[1]
    if (
      second &&
      scores[second] >= SECONDARY_MIN_SCORE &&
      scores[second] >= SECONDARY_MIN_RATIO * scores[primary]
    ) {
      out.push(second)
    }
    categories = out
  }

  categories = categories.filter((c) => CATEGORY_SLUGS.includes(c))
  if (categories.length === 0) categories = ['other']

  return { categories, family, fundraiser }
}

/** Back-compat: the single highest-scoring content category. */
export function inferCategory(title = '', description = '') {
  return inferCategories(title, description).categories[0]
}
