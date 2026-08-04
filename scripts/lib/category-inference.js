/**
 * category-inference.js — text → taxonomy classifier (Option 6 / faceted).
 *
 * Scored classifier (not first-match-wins). Every signal contributes a weight
 * to its category; the highest total wins. Emits the 14 content categories and
 * returns UP TO 2 (multi-category), plus the cross-cutting facet flags
 * { family, fundraiser } scored independently of content.
 *
 * Pure & dependency-light (imports only the canonical slug list). Contract:
 *   inferCategories(title, desc) -> { categories: string[1..2], family, fundraiser, familyVeto }
 *   inferFacets(title, desc)     -> { family, fundraiser, familyVeto }
 *   inferCategory(title, desc)   -> string   (primary content category; back-compat)
 *
 * `family` is HIGH-BAR on purpose: explicit kid/family PROGRAMMING language
 * only (not "all ages", not beneficiary words like "supporting local youth").
 *
 * `familyVeto` is `null | { rule: 'child-harm'|'serious-harm', terms: string[],
 * suppressed: boolean }` — see "Family safety veto" below. IMPORTANT:
 * `familyVeto != null` on its own only means the text is harm-bearing; it does
 * NOT mean a family flag was struck down. Check `familyVeto.suppressed` for
 * that. The veto is evaluated on every call, regardless of whether a family
 * signal fired, so `normalize.js` can log a source-declared conflict even when
 * inference itself never proposed `family: true`.
 */

import { CATEGORY_SLUGS } from '../../src/lib/categories.js'

const DECISIVE = 100
const STRONG = 70
const SOFT = 40
const WEAK = 25

const PRIORITY = [
  'music', 'comedy', 'theater', 'film', 'visual-art', 'sports', 'fitness',
  'food', 'learning', 'outdoors', 'festival', 'market', 'games', 'civic', 'other',
]

// A secondary category is kept when it's at least SECONDARY_MIN_SCORE on its own
// AND at least SECONDARY_MIN_RATIO of the primary's score. The ratio guard is
// what prevents over-tagging: a soft (40) secondary only rides along when the
// primary is itself modest (e.g. a "Learn Soccer" clinic → sports 70 + learning
// 40), never when the primary is a decisive 100 (e.g. jazz brunch stays food).
const SECONDARY_MIN_SCORE = 40
const SECONDARY_MIN_RATIO = 0.5

const _MUSIC_VENUES = /(@|\bat)\s+(the\s+)?(?:\w+\s+){0,2}(old 97|vorte[xz]|matinee|musica|jilly'?s|barmacy|blu jazz|empire concert|goodyear theat(er|re)|akron civic|knight stage|tangier|stage door|lock 4|kent stage|civic theatre)\b/i
const _GENERIC_TOUR_EXCLUSION = /(walking|guided|historical|garden|home|food|brewery|trolley|architecture|museum|self[- ]guided|virtual|haunted|farm|driving|kayak|free|weekly|exhibit|art|behind[- ]?the[- ]?scenes|members'?|public|private|holiday|cemetery|winery|wine|history|ghost)\s+tour|tour\s*:/i
const _LEARN_NOT_EDUCATIONAL = /\blearn\s+(more|why|all|about|everything|here|now|first|today|tomorrow)\b/i

// Comedy false-positive contexts, stripped from the text BEFORE the comedy
// signals score (analogous to _FAMILY_EXCLUSIONS). A comedy keyword does NOT
// mean the event IS comedy when it shows up as a SUPPORTING act, a performer's
// BIO backstory, or one item in a list of session TOPICS. All five shipped to
// production before being caught (organizer complaint, 2026-06-15): a coworking
// night, a folk concert, a country-tribute concert, a Pops-orchestra festival
// and a PGA golf championship were all mis-tagged "comedy".
//
// Each tuple is [match, replacement]; replacement keeps any non-comedy prefix
// (genre words, etc.) so a real secondary category still scores. Genuine comedy
// survives because it names a comedian or puts comedy up front, with none of
// these incidental cues ("comedian Paula Poundstone is known for…" stays).
const _COMEDY_INCIDENTAL = [
  // (1) Supporting / opening / additional act at a non-comedy event:
  //   "There will also be a comedy show" (Kaulig golf championship),
  //   "Plus, magician and comedian Michael Mage will kick off the night"
  //   (a Rock the Park concert). Additive cue + comedy term in one sentence…
  [/\b(?:plus|also|additionally|as well as|along with)\b[^.!?]*?\b(?:stand[- ]?up comedy|comedy show|comedian|comedians|improv)\b/g, ' '],
  //   …or a comedy act that "will/to kick off / open / warm up / start" a night.
  [/\b(?:comedian|comedians|comedy)\b[^.!?]{0,40}?\b(?:will|to)\s+(?:kick|open|warm|start|get)\b[^.!?]*/g, ' '],
  // (2) Performer-bio backstory — comedy listed among genres the act once
  //   enjoyed: "as a lover of jazz, pop, and standup comedy, he formed a band"
  //   (Noel Paul Stookey, a folk concert). Drop only the comedy tail so the
  //   genre words (jazz) keep scoring music.
  [/(\b(?:lover|fan)\s+of\b[^.!?]*?),?\s*(?:and|&)\s+(?:stand[- ]?up\s+)?comedy\b/g, '$1'],
  // (3) Profession list in a speaker bio — "comedian" as one of several hats:
  //   "swimmer, comedian, speaker, author and photographer" (a road-safety talk).
  [/\bcomedian,\s+\w+(?:,|\s+(?:and|&)\b)/g, ' '],
  // (4) Listed session/talk TOPIC — comedy is one item in a "topics like …"
  //   list, not the format: "mini talks on topics like mindfulness,
  //   productivity, self-care, and even some tension-relieving stand-up comedy"
  //   (a coworking night). Only strips when comedy FOLLOWS the cue, so
  //   "comedy on topics like politics" (a real set) is untouched.
  [/\btopics?\b[^.!?]*?\b(?:stand[- ]?up comedy|comedy|comedian|improv)\b/g, ' '],
  [/\beven\s+(?:some|a little|a bit of)\b[^.!?]*?\bcomedy\b/g, ' '],
  // (5) Drag show/brunch that is a scheduled component of a larger Pride or
  //   festival — an after-party or sub-event, not the event itself: "Drag Show
  //   @ The Haunted Closet | 5-7 PM. The main event wraps at 5", "Head over …
  //   for a spectacular Pride Drag Show" (Pride on Portage festival). A bare
  //   "Sunday Drag Brunch" (no festival/after-party cue) stays comedy.
  [/\bpride\s+drag (?:show|brunch|king|queen)\b/g, ' '],
  [/\b(?:after[- ]?part(?:y|ies)|head over to|main event)\b[^.!?]*?\bdrag (?:show|brunch|king|queen)\b/g, ' '],
  [/\bdrag (?:show|brunch|king|queen)\b[^.!?]*?\b(?:after[- ]?part(?:y|ies)|main event)\b/g, ' '],
]

/** Strip incidental comedy contexts before comedy signals score (input lowercase). */
function _comedySubject(text) {
  let t = text
  for (const [re, repl] of _COMEDY_INCIDENTAL) t = t.replace(re, repl)
  return t
}

const SIGNALS = [
  // Music
  { cat: 'music', w: DECISIVE, re: /\b(concert|symphony|orchestra|recital|live music|live bands?|open mic|karaoke|sing[- ]along|songwriter night|jazz night|blues night|dj set|album release|ep release|single release|musical guest|tribute (band|act|show|to)|on spotify)\b/ },
  { cat: 'music', w: STRONG,   re: /\bdj\b/, scope: 'title' },
  // Dance parties / club nights are music events. The title rarely says
  // "music" or "concert" ("Circa Pop: 80s Dance Party", "Silent Disco"), so
  // match the format words directly, and let a DJ mentioned anywhere in the
  // text (not just the title) contribute.
  { cat: 'music', w: DECISIVE, re: /\b(dance party|silent disco|disco party|sock hop|throwback (party|night)|decades? (party|night)|club night)\b/ },
  { cat: 'music', w: SOFT,     re: /\b(dj|deejay)\b/ },
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
  { cat: 'theater', w: STRONG,   re: /\b(murder mystery|immersive (theatre|theater|show|experience)|drama club|drama class)\b/ },

  // Film
  { cat: 'film', w: DECISIVE, re: /\b(film screening|screening|cinema|movie night|documentary|short films?|feature film|silent film|film festival|matinee showing|the nightlight)\b/ },
  { cat: 'film', w: STRONG,   re: /\bfilms?\b/ },

  // Comedy (110 so "comedy open mic" beats music's "open mic").
  // NOTE: bare "stand-up" is intentionally NOT a comedy signal — it collides
  // with "stand-up paddleboard" (fitness). Require explicit comedy wording.
  { cat: 'comedy', w: 110,      re: /\bcomedy (open mic|night|show|jam)\b/, scope: 'comedy' },
  { cat: 'comedy', w: DECISIVE, re: /\b(stand[- ]?up comedy|stand[- ]?up comedian|comedian|comedians|comedy jam|improv|sketch comedy|open mic comedy|drag (show|brunch|king|queen|bingo))\b/, scope: 'comedy' },

  // Visual art
  { cat: 'visual-art', w: DECISIVE, re: /\b(gallery|exhibition|exhibit opening|opening (reception|celebration)|artist reception|artist talk|sculpture|mural|art show|art walk|art fair|installation|vernissage)\b/ },
  { cat: 'visual-art', w: 90,       re: /\b(paint (and|&|n)\s*sip|puff (and|&|n)\s*paint|paint(ing)? class|art class|art workshop|pottery|ceramics|sketching workshop|drawing class)\b/ },
  // Crafts / maker programs (library + community staples). These rarely carry
  // a real description, so the title has to do the work.
  { cat: 'visual-art', w: STRONG,   re: /\b(knit|knitting|crochet|needle ?(point|craft|work)|cross[- ]stitch|quilt(ing)?|yarn|crafternoon|crafters?\b|coloring|canvas|collage|scrapbook|water ?color|calligraphy|origami|macrame|weaving|felt(ed|ing)|embroider|sewing|diy\b|make[- ]and[- ]take|open studio|glassblow(ing)?|glassblowing demonstration|natural dyeing|indigo dyeing|blacksmith(ing)?)\b/ },

  // Food
  { cat: 'food', w: DECISIVE, re: /\b(brewery|winery|wine tasting|beer tasting|cooking class|culinary|food truck|food festival|restaurant week|tap takeover|chef'?s table|tasting menu|wine dinner|whiskey tasting|cocktail (class|essentials|workshop)|brunch|luncheon|dinner show|drag brunch|sake|sushi tasting|cheese tasting|bourbon tasting|coffee tasting|chocolate tasting)\b/ },

  // Sports
  { cat: 'sports', w: DECISIVE, re: /\b(rubberducks|cleveland cavaliers|cleveland browns|cleveland guardians|cleveland indians|cavs|browns|guardians|hockey game|baseball game|basketball game|tournament championship|home game|home court|matchday|playoff|stadium)\b/ },
  // Common sport names + game vocabulary (youth leagues, rec sports, clinics).
  // Deliberately excludes bare "league" (collides with "Urban League") and bare
  // "golf" (collides with charity golf outings — those get the fundraiser flag).
  { cat: 'sports', w: STRONG,   re: /\b(soccer|football|basketball|baseball|softball|ice hockey|hockey|volleyball|lacrosse|wrestling|gymnastics|pickleball|tennis|badminton|rugby|cricket|track and field|cross[- ]country|scrimmage|little league|youth league|dribbl)\b/ },
  { cat: 'sports', w: STRONG,   re: /\b[a-z][a-z .'&]+ vs\.? [a-z][a-z .'&]+\b/, scope: 'title' },

  // Fitness
  // "marathon" is gated: a real running marathon (e.g. "Akron Marathon", "Half
  // Marathon") counts, but the common non-fitness "<X> marathon" uses do not —
  // movie/film/reading/gaming/dance/binge marathons, etc. (e.g. "Jaws-A-Thon
  // Movie Marathon" is a film event, not fitness).
  { cat: 'fitness', w: DECISIVE, re: /\b(\d+\.?\d*\s*k(?:m)?\b|half[- ]?marathon|(?<!(?:movie|film|reading|book|gaming|game|binge|tv|series|music|word|prayer|coding|hack|art|craft|holiday|study|dance)[ -])marathon|fun run|trail run|color run|yoga|pilates|crossfit|spin class|hiit|cardio|paddleboard(ing)?|kayak(ing)?|canoe|stand[- ]up paddle|cycle class|cycling class|barre class)\b/i },

  // Outdoors
  // Specific outdoors ACTIVITIES / features score STRONG.
  { cat: 'outdoors', w: STRONG, re: /\b(hiking trail|nature trail|bike trail|multi[- ]use trail|nature walk|nature center|naturalist|arboretum|wildlife|botanical|bird (walk|nerd)|birding|hike|hiking|conservation|outdoor adventure|metro park|towpath|fishing|camping|archery|kayak)\b/ },
  // Bare venue-name-prone nouns ("park", "zoo", "garden", "trail") only score
  // SOFT: they routinely show up as proper-noun VENUE/STREET names inside a
  // description ("Cuyahoga Valley National Park", "Akron Zoo", "Stan Hywet …
  // Gardens", "Portage Trail" — a downtown road) and must NOT override a
  // decisive content category as a secondary (an artist talk held in a
  // national-park gallery is visual-art, not outdoors; a Pride street festival
  // on Portage Trail is a festival, not outdoors). As a sole or primary signal
  // they still classify the event as outdoors (e.g. "Park Cleanup", "Trail Day").
  { cat: 'outdoors', w: SOFT, re: /\b(park|zoo|garden|trail)\b/ },

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
  // Pride / community celebrations are festivals. A drag show inside one is a
  // scheduled component, not the event — see the _COMEDY_INCIDENTAL drag guard.
  { cat: 'festival', w: DECISIVE, re: /\b(lgbtq\+? pride|pride (celebration|festival|fest|parade|march|picnic|block party|fair|on the )|community celebration)\b/ },
  { cat: 'festival', w: STRONG,   re: /\b(fair|holiday celebration|street fair|fest\b|community day|family fun day|fun day|field day)\b/ },

  // Market
  { cat: 'market', w: DECISIVE, re: /\b(farmers? market|makers? market|street market|night market|flea market|holiday market|artisan market|craft (market|show|fair)|vendor (market|fair)|pop[- ]?up market|plant sale|farmstand)\b/ },
  // Item swaps (clothing/book/toy/plant/…) are barter-style markets. Require an
  // item noun before "swap" so we don't catch idioms ("swap stories", "house
  // swap"); also accept explicit "swap meet"/"swap event".
  { cat: 'market', w: DECISIVE, re: /\b(clothing|clothes|book|toy|toys|plant|seed|gear|vinyl|record|costume|craft|game|puzzle|jewelry|baby|kids?|children'?s|maternity|sneaker|shoe|coat|household)\s+swaps?\b|\bswap[- ]?meet\b|\bswap (?:event|day|party|shop|sale)\b/ },

  // Civic
  // NOTE: do NOT use a bare "civic" token here — it matches venue/building
  // names like "Akron Civic Theatre" and "Civic Center", false-tagging every
  // show at those rooms as a civic event. Match genuine civic-ACTIVITY phrasing
  // instead (civic engagement/association/etc.), plus the explicit meeting words.
  { cat: 'civic', w: STRONG, re: /\b(town hall|city council|civic (engagement|association|league|forum|duty|action|commission|club)|ward meeting|neighborhood meeting|community meeting|public hearing|community gathering|senior expo|(committee|board|membership|annual|business) meeting|board of directors)\b/ },

  // Games & Hobbies — tabletop, social, and video gaming, plus pub-game nights.
  // DECISIVE terms are unambiguous game events; the STRONG single words ride a
  // little lower so a more specific signal (e.g. comedy "drag bingo") still wins
  // the tie via PRIORITY. Pairs with the family facet for kid/teen game programs.
  { cat: 'games', w: DECISIVE, re: /\b(dungeons (and|&) dragons|d ?& ?d\b|magic:? the gathering|board games?|tabletop|role[- ]?playing game|\brpg\b|mahjong|trivia night|pub quiz|games? night|game day|video game tournament|e[- ]?sports|mario kart|super smash|warhammer|euchre|bunco|cribbage|dominoes)\b/ },
  { cat: 'games', w: STRONG,   re: /\b(trivia|chess|cornhole|darts|pinball|arcade|cosplay|jigsaw|puzzles?|bingo|card games?|gaming|questing club|magic the gathering|pok[eé]mon)\b/ },
]

function conditionalContentSignals(text, tLow, comedyText) {
  const out = []
  if (/\bopen mic\b/.test(text) && /\b(?:comedy|comedians?)\b/.test(comedyText)) out.push({ cat: 'comedy', w: 110 })
  if (/\btour\b/.test(tLow) && !_GENERIC_TOUR_EXCLUSION.test(text)) out.push({ cat: 'music', w: STRONG })
  // "Learn X" anywhere in title OR description signals an instructional event.
  // The negative lookahead skips marketing CTAs ("learn more/about/why…") at the
  // match site, so "learn soccer basics" still scores even if the blurb also
  // says "learn more at our site".
  if (/\blearn\s+(?!(?:more|why|all|about|everything|here|now|first|today|tomorrow)\b)\w/i.test(text)) out.push({ cat: 'learning', w: SOFT })
  return out
}

const FAMILY_RE = /\b(story ?time|story hour|kids?|children'?s?|family[- ]friendly|toddlers?|preschool|for kids|kid[- ]friendly|children'?s museum|family game night|family day|all[- ]ages family|grade[- ]schoolers|grades? [k0-9]|ages \d+ ?(to|-|–) ?\d+|little (explorers|ones)|baby|babies)\b/

// teen/tween/youth/"family fun" added 2026-06 to catch the large block of
// library & rec youth programming ("Teen Advisory Board", "Tween Manga Club",
// "Youth Craft Day", "Family Fun Night") the original kid/preschool bar missed.
// Matters for BOTH directions: the inclusive "Family" intent AND the new "Hide
// kids' events" grid toggle, which both read is_family.
//
// TITLE-SCOPED on purpose. These words are noisy in free-text descriptions —
// "youth" doubles as a beneficiary word and "teen" shows up in adult-event copy
// ("great for teens and adults") — which would mis-flag concerts, clinical
// trainings, etc. Library/rec programs reliably put the audience in the TITLE,
// so matching the title alone keeps recall high without the description noise.
// (Library events are additionally flagged from their structured Ages field in
// scrape-akron-library.js's parseIsFamily.) The _FAMILY_EXCLUSIONS below still
// strip beneficiary/service "youth" contexts even from titles.
//
// "<theme> camp" ("summer camp", "art camp", "cooking camp", "adventure camp")
// is day-camp programming and is overwhelmingly for kids. It must be the
// "<word> camp" shape (camp preceded by a theme word) so a proper-noun venue
// ("Girl Scouts' Camp Ledgewood") — which is "camp <name>" — never matches.
// Adult/senior camps ("boot camp", "Senior Citizen Summer Camp") are stripped
// by _FAMILY_EXCLUSIONS first.
const FAMILY_TITLE_RE = /\b(teens?|tweens?|youth|family fun)\b|\b[a-z]{3,}\s+camps?\b/

// Family false-positive contexts, stripped from the text BEFORE FAMILY_RE
// runs. The first three shipped to production before being caught (2026-06-11):
//   1. Negated admission — "we regret that we cannot admit infants or
//      children under age 12" (Akron Symphony Lakes Tour) flagged an event
//      that explicitly EXCLUDES kids.
//   2. "kids of all ages" — marketing idiom meaning "everyone", not kid
//      programming ("Original Acoustifunk for kids of all ages", a band
//      tagline in the Dreadlock Dave artist bio).
//   3. Counted possessive in performer bios — "her time to their two
//      children, Johnny and Olivia" (Five for Fighting). The count is what
//      separates bio phrasing from programming copy: "parents and their
//      children" (no count) must keep matching.
//   4/5. "youth" guards (added with teen/tween/youth, 2026-06): a beneficiary
//      verb before "youth" ("supporting local youth", "empowering our youth")
//      or a service/org noun after it ("youth mentoring", "youth services")
//      marks an adults-facing benefit/volunteer event, NOT kid programming.
//      "Youth Craft Day" / "Youth Lego Heads" have neither and stay flagged.
const _FAMILY_EXCLUSIONS = [
  /\b(?:cannot|can ?not|can't|may not|do not|don't|won't|unable to|no)\s+(?:admit|allow|accommodate|permit|bring)[^.!?]{0,80}/g,
  /\b(?:for\s+)?kids of all ages\b/g,
  /\b(?:his|her|their|my|our)\s+(?:two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:young\s+)?(?:children|kids|grandchildren)\b/g,
  /\b(?:support(?:ing|s)?|benefit(?:t?ing|s)?|serv(?:e|es|ing)|empower(?:ing|ment|s)?|uplift(?:ing|s)?|sponsor(?:ing|s)?|in support of)\s+(?:the\s+|our\s+|local\s+|area\s+|disadvantaged\s+|at[- ]risk\s+)*youth\b/g,
  /\byouth\s+(?:mentoring|mentorship|services?|ministr(?:y|ies)|fund|foundation|coalition|alliance|council)\b/g,
  //   6/7. "camp" guards (added with <theme> camp): "boot camp"/"base camp" are
  //      adult fitness/figurative, and a senior/adult-qualified camp ("Senior
  //      Citizen Summer Camp") is not kid programming. Strip both before the
  //      <theme>-camp rule sees them.
  /\b(?:boot|base)\s?camps?\b/g,
  /\b(?:senior(?:s|\s+citizens?)?|adults?|grown[- ]?ups?|55\+|18\+|21\+)\b[^.!?]{0,25}?\bcamps?\b/g,
]

/** Strip known family false-positive contexts (input is already lowercase). */
function _familySubject(text) {
  let t = text
  for (const re of _FAMILY_EXCLUSIONS) t = t.replace(re, ' ')
  return t
}

// ── Family safety veto ──────────────────────────────────────────────────────
// A hard veto on the FAMILY FACET ONLY. When the text describes serious harm,
// especially harm to a child, `is_family` is never set no matter what else
// matched. Content categories are untouched: a documentary about a crime is
// still `film`.
//
// Incident 2026-08-03: "Baby Doe" (Nightlight Cinema, 5 showtimes) — a
// documentary about a woman prosecuted over her newborn's death — was flagged
// family by FAMILY_RE's bare `baby|babies` alternative ("Baby Doe" + "the baby
// was stillborn") and shown to families. `_FAMILY_EXCLUSIONS` above strips
// negated-admission, "kids of all ages", performer-bio possessives, and
// youth-beneficiary/adult-camp contexts — none of which describe a child's
// death, so nothing intervened.
//
// This is a document-level VETO, not a strip. It deliberately does NOT live
// inside `_FAMILY_EXCLUSIONS`: those are span strippers that delete a phrase
// and let the remaining text re-score, which would make the outcome depend on
// which phrase happened to survive stripping. The veto instead runs on the
// RAW text (title + description, unmodified) so its evidence can never be
// deleted by an unrelated guard, and it has its own strip list
// (`_HARM_EXCLUSIONS`) and its own fiction check — it never shares
// `_FAMILY_EXCLUSIONS`, because the two lists answer different questions
// ("is this kid programming?" vs. "does this text depict serious harm?") and
// must be independently testable.
//
// The veto DOES override a structured, source-declared `is_family: true`
// (library Ages fields, Ticketmaster's Family segment, the ~10 scrapers that
// pass `is_family` directly) — see resolveFamilyFacet in normalize.js, which
// applies this above the `sanitized.is_family ?? inferred.family` resolve.
// A structured Ages/segment field is authoritative about WHO MAY ATTEND; the
// veto answers a different question — may we advertise this under a family
// badge with no warning — and "infants welcome" is a true statement about a
// bereaved-parents remembrance event that is still the wrong thing to surface
// that way. `is_family` is also bidirectional (it powers both the inclusive
// Family intent and the "Hide kids' events" toggle), and structured fields are
// not immune to the same failure mode: `parseIsFamily` in
// scrape-akron-library.js matches a bare `bab(y|ies)` on the Ages+tags string,
// so a "Baby" tag on a perinatal-loss remembrance program reproduces this
// exact incident from the "authoritative" path. The human escape hatch is
// `manual_overrides.is_family`, which this veto never touches or overrides.
//
// KNOWN, DELIBERATE GAP (out of scope here — see the design doc's open
// question 4): this veto does not fix FAMILY_RE's bare `baby|babies` recall
// problem. A bare title "Baby Doe" with an EMPTY description still flags
// family, because the veto only fires on harm TEXT — a title alone with no
// harm-bearing description gives the detector below nothing to match. Do not
// "fix" this by editing FAMILY_RE here; it needs its own design (requiring
// baby/babies to co-occur with programming words like "storytime"/"& me"/
// "welcome") and its own tests.

// (i) Fiction framings of crime. Murder-mystery dinners, Clue nights, whodunits
//     and escape rooms are family GAME programming; their copy legitimately
//     says "murder", "killed", "the suspect was arrested". When one frames the
//     event, the generic Group B rules are skipped wholesale. Group A still
//     applies — dinner theatre does not narrate infanticide.
const _HARM_FICTION_FRAME = /\b(?:murder[- ]?myster(?:y|ies)|myster(?:y|ies)\s+(?:dinner|party|night|theat(?:re|er)|game|train)|whodunit|cluedo|escape rooms?|detective party|solve the (?:crime|case|mystery))\b/

// (ii) Prevention / awareness / education framings, stripped in BOTH word
//      orders: "Teen Suicide Prevention Night", "Youth Narcan Training",
//      "Child Abuse Prevention Family Fair", "Trafficking Awareness for Parents",
//      "Drowning Prevention for Kids". These are exactly the civic youth
//      programming Akron Pulse wants in the Family lane.
//
// QA false-positive sweep (2026-08-03) found three legitimate-programming
// texts still vetoed after this exclusion, from two independent defects:
//
//   (a) VOCABULARY GAP — abduction/kidnapping/"missing <child>" topics were
//       absent from `_HARM_SOFT_TOPIC`, so "Preventing Child Abduction" and
//       "Missing Children Awareness" got no framing-strip at all, unlike the
//       structurally identical "preventing child abuse". Fixed by adding
//       those terms below. This also gives A5's literal
//       missing/murdered/slain/abducted/kidnapped + child pattern an
//       awareness escape hatch it never had: once "missing"/"abduction"/
//       "kidnap*" strip under a nearby prevention/awareness frame, the
//       literal adjacency pattern has nothing left to match.
//   (c) REGEX-ORDERING DEFECT — independent of vocabulary. The old
//       `[^.!?]{0,60}?` bridge was free to leap PAST a nearer, correctly
//       paired topic/framing occurrence to a farther one of the same kind.
//       Concretely: "Child Abuse Awareness Walk ... raising awareness to
//       help prevent child abuse" has TWO "abuse"s and TWO "awareness"-ish
//       framing words. The framing-then-topic pass started at the first
//       "awareness" (title) and lazily bridged all the way to the SECOND
//       "abuse" near the end (still within 60 chars, still non-greedy-valid),
//       skipping right over the title's OWN adjacent "abuse" and over the
//       intervening "awareness"/"prevent" tokens the other pairs needed. That
//       single over-wide match then consumed the very framing word ("aware-
//       ness") the topic-then-framing pass needed to pair with the title's
//       "abuse" — so it survived unstripped and re-matched `_HARM_CHILD`.
//       Fixed with a tempered greedy token: the bridge may not cross ANOTHER
//       framing or topic word en route, so each occurrence can only pair
//       with its nearest, uninterrupted partner. Verified against the "Baby
//       Doe" fixture and every existing must-veto case before landing (see
//       test-family-safety-veto.js) — this narrows what a single exclusion
//       match can span; it can only strip MORE precisely, never strip text
//       it couldn't already reach.
const _HARM_SOFT_TOPIC = '(?:suicide|self[- ]harm|overdose|opioids?|fentanyl|addiction|abuse|assault|violence|traffick\\w+|bullying|drowning|firearms?|gun|abduction|abducted|kidnapp(?:ed|ing)?|missing)'
const _HARM_FRAMING    = '(?:prevention|preventing|prevent|awareness|education(?:al)?|training|workshop|hotline|helpline|resources?|support group|safety|screening|recognizing|warning signs|first aid|narcan|naloxone)'
// Either word class, used as the tempered token's "don't cross this" boundary.
const _HARM_EXCLUSION_BOUNDARY = `(?:${_HARM_FRAMING}|${_HARM_SOFT_TOPIC})`
const _HARM_EXCLUSIONS = [
  new RegExp(`\\b${_HARM_FRAMING}\\b(?:(?!\\b${_HARM_EXCLUSION_BOUNDARY}\\b)[^.!?]){0,60}\\b${_HARM_SOFT_TOPIC}\\b`, 'g'),
  new RegExp(`\\b${_HARM_SOFT_TOPIC}\\b(?:(?!\\b${_HARM_EXCLUSION_BOUNDARY}\\b)[^.!?]){0,60}\\b${_HARM_FRAMING}\\b`, 'g'),
]

// Group A — harm to a child. Unconditional: a single match vetoes.
const _HARM_CHILD = [
  // A1 perinatal death. No family PROGRAMMING uses these words; bereavement
  //    remembrance events do, and those are not family programming either.
  /\b(?:stillborn|still ?births?|miscarriage|miscarried)\b/,
  /\b(?:sudden infant death|sids)\b/,
  // A2 "<child noun> death/mortality/homicide" as a topic.
  /\b(?:infant|neonatal|child|childhood)\s+(?:deaths?|mortality|fatalit(?:y|ies)|homicide)\b/,
  // A3 the only two bounded uses of the word "loss" in the whole lexicon.
  /\b(?:pregnancy|infant)\s+loss\b/,
  /\b(?:death|loss|killing|murder|disappearance|abduction)\s+of\s+(?:(?:a|an|the|her|his|their|your|our|my)\s+)?(?:unborn\s+|newborn\s+|young\s+|little\s+)?(?:child|children|bab(?:y|ies)|infants?|newborns?|toddlers?|son|daughter|minors?)\b/,
  // A4 harm VERB + child OBJECT — the "Baby Doe" shape. Up to three
  //    determiner/qualifier words between them ("murdered her two-year-old
  //    daughter"). The object list is deliberately the same child vocabulary
  //    FAMILY_RE keys on, so the veto has exactly the reach of the flag it
  //    guards. NOTE the omissions: "beat" (→ "Beat the Kids at Chess Night")
  //    and "left/leave" (→ "parents who leave their children in our care").
  /\b(?:murder(?:ed|ing|s)?|kill(?:ed|ing|s)?|strangl(?:e|ed|es|ing)|suffocat(?:e|ed|es|ing)|drown(?:ed|ing|s)|abandon(?:ed|ing|s)?|abduct(?:ed|ing|s)?|kidnapp?(?:ed|ing|s)?|molest(?:ed|ing|s)?|traffick(?:ed|ing)|starv(?:ed|ing))\s+(?:(?:her|his|their|my|our|the|a|an|own|newborn|infant|young|little|\d+[-\s](?:year|month|week|day)[-\s]old)\s+){0,3}(?:bab(?:y|ies)|infants?|newborns?|toddlers?|child(?:ren)?|kids?|daughters?|sons?|girls?|boys?|students?)\b/,
  // A5 named child-harm topics, both word orders.
  /\b(?:child|childhood|infant|minor)\s+(?:abuse|neglect|endangerment|exploitation|abduction|traffick\w+|pornograph\w+)\b/,
  /\b(?:abuse|neglect|endangerment|exploitation|molestation|traffick\w+)\s+of\s+(?:(?:a|an|the)\s+)?(?:child|children|minors?|infants?|bab(?:y|ies))\b/,
  /\b(?:missing|murdered|slain|abducted|kidnapped)\s+(?:child|children|girl|boy|teen|bab(?:y|ies)|infant|toddler)\b/,
]

// Group B — generic serious harm. Vetoes ONLY together with a real-case cue,
// and never under a fiction frame. Both halves are required so that no single
// dramatic word can strip a family flag on its own.
const _HARM_SERIOUS = /\b(?:murder(?:ed|s|ing)?|homicide|manslaughter|killed|slain|shot (?:and killed|dead)|stabb(?:ed|ing)|raped?|sexual assault|molestation|human traffick\w+|domestic violence|mass shooting|school shooting|massacre|lynch(?:ed|ing)|serial killer)\b/
const _HARM_TRUE_CASE = /\b(?:arrest(?:ed|s)?|convict(?:ed|ion)|indict(?:ed|ment)|on trial|stood trial|sentenced to|life sentence|cold case|unsolved|true story|based on (?:a|the) true|real[- ]life case|wrongful(?:ly)?\s+convict\w+|exonerat\w+|autopsy|coroner|prosecut(?:ed|ion|or))\b/

/**
 * Serious-harm veto for the FAMILY facet. Returns null when clean, else
 * { rule, terms }. Pure; scans title + description, case-insensitive.
 *
 * Implementation landmine: `_HARM_EXCLUSIONS` carries the `g` flag and is only
 * ever used with `.replace()`. Never call `.test()` on a `g`-flagged regex —
 * `lastIndex` is stateful and a second call on the same text returns false.
 * The non-`g` regexes above are the only ones passed to `.test()`/`.match()`.
 */
export function familySafetyVeto(title = '', description = '') {
  const raw = `${title || ''} ${description || ''}`.toLowerCase()
  if (!raw.trim()) return null
  let t = raw
  for (const re of _HARM_EXCLUSIONS) t = t.replace(re, ' ')
  for (const re of _HARM_CHILD) {
    const m = t.match(re)
    if (m) return { rule: 'child-harm', terms: [m[0].trim().slice(0, 60)] }
  }
  if (_HARM_FICTION_FRAME.test(raw)) return null
  const harm = t.match(_HARM_SERIOUS)
  if (!harm) return null
  const cue = t.match(_HARM_TRUE_CASE)
  if (!cue) return null
  return { rule: 'serious-harm', terms: [harm[0].trim(), cue[0].trim()] }
}

// High-bar: the EVENT itself is a fundraiser/benefit/service event. Excludes the
// bare word "nonprofit"/"non-profit", which fires on artist/org BIOS rather than
// the event (e.g. a concert whose performer "supports artists through her
// nonprofit"). "volunteer" only counts when it names a volunteering event
// ("volunteer day/night/event…", "volunteers needed") — a bare incidental
// mention ("a volunteer will help you check in") must NOT flag the whole event,
// the way a single supporting-act mention doesn't make a show a comedy show.
// Other give-back signals (charity, cleanup, drives) are kept inclusive.
// "cleanup" is qualified the same way "volunteer" is: a bare "spring cleanup" /
// "closet cleanup" isn't a give-back event, so cleanup must name a place
// (park/river/trail…). Genuine stewardship volunteering (invasive-plant pulls,
// trail work, tree plantings, habitat restoration) is kept explicitly so those
// service events still land in Give Back without the loose bare "cleanup".
// "charity" and "in support of" used to flag concerts/comedians whose BIOS
// mention charity work ("the band has raised millions for charity", "a show in
// support of the arts"). Dropped bare "in support of"; "charity" must now name a
// charity EVENT (charity gala/run/golf…) so the event itself is the give-back.
const FUNDRAISER_RE = /\b(fundraiser|fund[- ]?raising|gala|benefit (dinner|concert|show|night|gala|auction|event|for)|silent auction|charity\s+(?:gala|event|drive|auction|dinner|luncheon|breakfast|concert|show|run|walk|ride|golf|tournament|ball|bash|benefit|fundraiser|night)|for charity|charitable\s+(?:event|cause|giving)|proceeds (benefit|support|go to|will|from)|raise (money|funds)|volunteers?\s+(?:needed|wanted)|volunteer\s+(?:day|night|event|week(?:end)?|month|opportunit(?:y|ies)|fair|drive|orientation|appreciation|meet[- ]?up|meeting|program|shift|sign[- ]?up)|day of service|service\s+(?:event|day|project)|(?:park|river|stream|creek|lake|beach|community|neighborhood|trail|highway|roadside|litter|shoreline|canal|towpath)\s+clean[- ]?up|litter\s+pick[- ]?up|invasive\s+(?:plant|species)\s+(?:removal|pull)|habitat restoration|tree planting|(?:food|blood|coat|toy|book|diaper|canned[- ]?food|school[- ]?supply)\s+drive|donation drive|golf outing)\b/

// Fundraiser incidental-mention guards, stripped before FUNDRAISER_RE scores
// (analogous to _COMEDY_INCIDENTAL / _FAMILY_EXCLUSIONS). Org-mission and
// community boilerplate that describes fundraising in GENERAL — "supports each
// other's fundraising campaigns", "our fundraising efforts", a linked
// "fundraising page" — does not make THIS event a fundraiser (caught on a
// Comeunity Project networking dinner, 2026-06-17). The event-type words
// (fundraiser, fundraising gala/dinner/event, X drive) are untouched.
const _FUNDRAISER_EXCLUSIONS = [
  /\bfundrais(?:er|ing)\s+(?:campaign|effort|page|goal|account|platform|initiative)s?\b/g,
]
function _fundraiserSubject(text) {
  let t = text
  for (const re of _FUNDRAISER_EXCLUSIONS) t = t.replace(re, ' ')
  return t
}

export function scoreCategories(title = '', description = '') {
  const text = `${title || ''} ${description || ''}`.toLowerCase()
  const tLow = (title || '').toLowerCase()
  const comedyText = _comedySubject(text)
  const scores = {}
  const add = ({ cat, w }) => { scores[cat] = (scores[cat] || 0) + w }
  for (const sig of SIGNALS) {
    const subject =
      sig.scope === 'title' ? tLow : sig.scope === 'comedy' ? comedyText : text
    if (sig.re.test(subject)) add(sig)
  }
  for (const sig of conditionalContentSignals(text, tLow, comedyText)) add(sig)
  return scores
}

export function inferFacets(title = '', description = '') {
  const text = `${title || ''} ${description || ''}`.toLowerCase()
  const titleText = (title || '').toLowerCase()

  // High-bar family words match anywhere; the noisier teen/tween/youth set is
  // title-only (see FAMILY_TITLE_RE). Both run through _familySubject so the
  // beneficiary/"youth"-service guards apply in either scope.
  const positives = FAMILY_RE.test(_familySubject(text)) ||
                     FAMILY_TITLE_RE.test(_familySubject(titleText))

  // The veto is evaluated regardless of `positives` — cheap (one extra regex
  // pass over already-lowercased text) and it lets normalize.js reuse this
  // same result to log a source-declared conflict even when text inference
  // never proposed family in the first place. It only *suppresses* the family
  // flag when a positive signal actually fired.
  const veto = familySafetyVeto(title, description)

  return {
    family: positives && !veto,
    // `suppressed` is true only when a family signal actually fired AND was
    // struck down. `familyVeto != null` alone just means the text is
    // harm-bearing (see the JSDoc at the top of this file).
    familyVeto: veto ? { ...veto, suppressed: positives } : null,
    fundraiser: FUNDRAISER_RE.test(_fundraiserSubject(text)),
  }
}

export function inferCategories(title = '', description = '') {
  const scores = scoreCategories(title, description)
  const { family, fundraiser, familyVeto } = inferFacets(title, description)

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

  return { categories, family, fundraiser, familyVeto }
}

/** Back-compat: the single highest-scoring content category. */
export function inferCategory(title = '', description = '') {
  return inferCategories(title, description).categories[0]
}
