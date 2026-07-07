/**
 * faith-events.js
 *
 * Church / place-of-worship calendars are dominated by INTERNAL congregational
 * activity — Sunday worship, Mass, Bible study, prayer groups, small groups,
 * youth ministry, choir rehearsal, board meetings — none of which belong on a
 * public community events calendar. Rather than blocklist that endless long
 * tail, we take the opposite (allowlist) stance Byron chose: a faith event is
 * ingested ONLY when it carries a clear PUBLIC-community signal (a concert, a
 * festival, a fundraiser, a rummage sale, a community meal, a blood drive, VBS,
 * a seasonal public event, etc.). Everything else is skipped.
 *
 * Usage in a faith-source scraper (HTML/Tribe/iCal): gate each event with
 *   if (!isPublicFaithEvent(title, description)) { skipped++; continue }
 * For runIcsScraper, pass it via the includeEvent hook.
 *
 * Tradeoff (accepted): a genuinely public church event with a generic title
 * (e.g. bare "Community Gathering") is missed. That's the price of a clean,
 * noise-free calendar. Widen PUBLIC_FAITH_EVENT_SIGNALS if a real one slips
 * through — keep additions specific so internal events don't leak back in.
 */

// Strong, specific public-community signals. Deliberately does NOT include bare
// words like "dinner", "breakfast", "meeting", "night", "class" or "group",
// which are overwhelmingly internal on a church calendar (e.g. "Men's Prayer
// Breakfast", "Small Group Meeting", "Youth Movie Night").
export const PUBLIC_FAITH_EVENT_SIGNALS = new RegExp([
  // Performance / music
  'concert', 'recital', 'symphony', 'orchestra', 'open mic', 'coffee house concert',
  // Festivals / fairs
  '\\bfest\\b', 'festival', '\\bfair\\b', 'bazaar', 'carnival', 'jubilee', 'block party',
  // Fundraisers
  'fundrais', 'benefit', '\\bgala\\b', 'auction', 'golf outing', '\\b5k\\b', '\\b10k\\b',
  'fun run', 'walk-?a-?thon', 'car wash',
  // Sales / markets
  'rummage', 'flea market', 'garage sale', 'yard sale', 'estate sale',
  'craft (?:show|sale|fair)', 'bake sale', 'book sale', 'plant sale',
  'vendor (?:fair|market|show)', 'holiday (?:market|bazaar|shoppe|shop)',
  'christmas (?:market|bazaar)', 'farmers?[ -]?market',
  // Community meals (specific, not bare "dinner"/"breakfast")
  'fish fry', 'pancake breakfast', 'spaghetti dinner', 'pasta dinner',
  'chicken (?:dinner|bbq|barbecue|paprikash)', 'pierog', 'clam ?bake', 'food truck',
  'community (?:meal|dinner|breakfast|lunch|supper|picnic|cookout)',
  'free (?:community )?(?:meal|dinner|lunch|breakfast)', 'soup supper',
  // Service / outreach open to the public
  'blood drive', 'food (?:pantry|distribution|giveaway|drive)', 'free store',
  'clothing (?:drive|giveaway)', 'coat drive', 'community garden', 'health fair',
  'resource fair', 'job fair',
  // Kids / camps that are community-facing
  'vacation bible school', '\\bvbs\\b', 'day camp',
  // Seasonal / holiday public events
  'trunk[ -]?or[ -]?treat', 'egg hunt', 'easter egg', 'breakfast with santa',
  'photos with santa', 'tree lighting', 'live nativity', '\\bnativity\\b',
  'harvest (?:fest|festival|party)', 'fall (?:fest|festival)', 'pumpkin',
  'hayride', 'petting zoo', 'trick or treat',
  // Arts / shows
  'art (?:show|exhibit|walk|fair)', 'gallery', 'quilt show', 'car show',
  // Openings / public gatherings
  'open house', 'grand opening', 'public (?:lecture|forum|talk)',
].join('|'), 'i')

/** True when a faith event carries a clear public-community signal (allowlist). */
export function isPublicFaithEvent(title, description = '') {
  const text = `${title || ''} ${description || ''}`
  return PUBLIC_FAITH_EVENT_SIGNALS.test(text)
}

// Detects church / place-of-worship orgs & venues, so the allowlist can be
// applied by an event's faith signal regardless of which scraper produced it
// (e.g. a church event surfaced by an aggregator).
const FAITH_ORG = new RegExp([
  '\\bchurch\\b', '\\bparish\\b', 'cathedral', '\\bchapel\\b', 'congregation',
  'synagogue', '\\btemple\\b', '\\bmosque\\b', '\\bmasjid\\b', 'diocese',
  'ministr(?:y|ies)', '\\bucc\\b', 'lutheran', 'methodist', 'baptist',
  'presbyterian', 'episcopal', 'catholic', 'orthodox', 'evangel',
  'foursquare', 'assembly of god', 'worship center', 'fellowship church',
].join('|'), 'i')

/** True when an org/venue name looks like a place of worship. */
export function looksLikeFaithOrg(name) {
  return FAITH_ORG.test(String(name || ''))
}
