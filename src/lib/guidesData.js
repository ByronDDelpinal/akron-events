/**
 * guidesData.js — the GUIDES registry DATA, and nothing else.
 *
 * Same split as festivalsData.js: plain JS, ZERO imports, DOM-free, so
 * api/sitemap.xml.js and scripts/prerender.js (both run unbundled by Node and
 * cannot import TypeScript) read the exact same array the app renders. One
 * edit here adds a guide to the hub, the router, the sitemap and the
 * prerender list at once, with no hand-synced second list to drift.
 *
 * NOT named guides.js on purpose: Vite/Rollup resolves a bare `@/lib/guides`
 * import to `.js` before `.ts`, so a plain-JS guides.js sitting next to
 * guides.ts would silently hijack every typed import. Same trap
 * festivalsData.js documents; same fix.
 *
 * ── Adding the video later ────────────────────────────────────────────────
 * Every entry ships with youtubeId/posterSrc/uploadDate/durationIso set to
 * null, and that is the whole swap. Fill those four fields in THIS file and
 * the page renders a real click-to-load player and emits VideoObject JSON-LD.
 * No page component, no CSS and no schema code has to change. Until then the
 * written walkthrough is the guide, and it has to stand on its own.
 *
 * Slugs are canonical URLs. Renaming one after it ships costs a redirect
 * rule, so treat them as frozen.
 */

export const GUIDES = [
  // ── Track: using Akron Pulse ────────────────────────────────────────────
  {
    slug: 'find-events-fast',
    track: 'using',
    order: 1,
    title: 'Find something to do in about a minute',
    seoTitle: 'How to Find Events Fast on Akron Pulse',
    metaDescription:
      'Search, filters and the three views, used together. The fastest way to go from the whole Akron calendar to the four things you would actually go to.',
    blurb:
      'Search, the Filter and Sort tray, and the List, Calendar and Map views. Start here, everything else assumes it.',
    durationLabel: '3 min',
    related: ['neighborhood-and-personal-filters', 'build-and-share-a-day-plan'],
    youtubeId: null,
    posterSrc: null,
    uploadDate: null,
    durationIso: null,
  },
  {
    slug: 'build-and-share-a-day-plan',
    track: 'using',
    order: 2,
    title: 'Build a day plan and send it to somebody',
    seoTitle: 'Build and Share a Day Plan on Akron Pulse',
    metaDescription:
      'Add events to a day plan, put them in order, check the map, then share one link instead of five. How the Akron Pulse day planner works.',
    blurb:
      'Stack a few events into a plan, see them on a map in order, then hand the whole thing to a friend as one link.',
    durationLabel: '3 min',
    related: ['find-events-fast', 'install-the-app'],
    youtubeId: null,
    posterSrc: null,
    uploadDate: null,
    durationIso: null,
  },
  {
    slug: 'neighborhood-and-personal-filters',
    track: 'using',
    order: 3,
    title: 'Make the calendar look like your life',
    seoTitle: 'Neighborhood and Audience Filters on Akron Pulse',
    metaDescription:
      'Set your community, hide the kids and family stuff or keep only that, and drop the categories you never want to see. The settings that make the feed yours.',
    blurb:
      'Pick your community, set the audience toggle, and cut the categories you never want. This is the tuning most people never find.',
    durationLabel: '3 min',
    related: ['find-events-fast', 'newsletter-preferences'],
    youtubeId: null,
    posterSrc: null,
    uploadDate: null,
    durationIso: null,
  },
  {
    slug: 'newsletter-preferences',
    track: 'using',
    order: 4,
    title: 'Get an email you actually want to open',
    seoTitle: 'Tune Your Akron Pulse Newsletter Preferences',
    metaDescription:
      'Categories, favorite venues and organizations, keyword alerts, price and age limits, delivery day. Every control in the Akron Pulse preference center.',
    blurb:
      'The preference center is deeper than most people realize. Ten minutes there and the newsletter stops being general interest.',
    durationLabel: '2 min',
    related: ['neighborhood-and-personal-filters', 'find-events-fast'],
    youtubeId: null,
    posterSrc: null,
    uploadDate: null,
    durationIso: null,
  },
  {
    slug: 'install-the-app',
    track: 'using',
    order: 5,
    title: 'Put Akron Pulse on your phone',
    seoTitle: 'Install Akron Pulse on Your Phone',
    metaDescription:
      'Install Akron Pulse as an app on iPhone or Android, then use it the way it is meant to be used: standing outside, deciding where to go next.',
    blurb:
      'Install it like an app on iPhone or Android, and use it the way it is meant to be used, which is out of the house.',
    durationLabel: '2 min',
    related: ['build-and-share-a-day-plan', 'find-events-fast'],
    youtubeId: null,
    posterSrc: null,
    uploadDate: null,
    durationIso: null,
  },

  // ── Track: organizers and partners ──────────────────────────────────────
  {
    slug: 'how-to-get-on-the-calendar',
    track: 'organizers',
    order: 1,
    title: 'Four ways onto the calendar, and what happens next',
    seoTitle: 'How to Get Your Event on Akron Pulse',
    metaDescription:
      'Email it, submit the form, or register your organization or venue. What each path is good for, and exactly what happens after you hit send.',
    blurb:
      'Email, form, organization, venue. Which one fits you, and what our review actually does to your submission.',
    durationLabel: '3 min',
    related: ['write-a-listing-that-gets-clicked', 'series-recurrence-and-cancellations'],
    youtubeId: null,
    posterSrc: null,
    uploadDate: null,
    durationIso: null,
  },
  {
    slug: 'write-a-listing-that-gets-clicked',
    track: 'organizers',
    order: 2,
    title: 'Write a listing people actually click',
    seoTitle: 'Write an Event Listing That Gets Clicked',
    metaDescription:
      'Titles, real start times, the image, the first sentence, categories and age. The details that decide whether your event gets seen or scrolled past.',
    blurb:
      'Titles, start times, the image, that first sentence. Small stuff, and it decides who shows up.',
    durationLabel: '4 min',
    related: ['how-to-get-on-the-calendar', 'series-recurrence-and-cancellations'],
    youtubeId: null,
    posterSrc: null,
    uploadDate: null,
    durationIso: null,
  },
  {
    slug: 'make-your-website-machine-readable',
    track: 'organizers',
    order: 3,
    title: 'Make your website easy for calendars to read',
    seoTitle: 'Make Your Event Website Machine Readable',
    metaDescription:
      'Publish an ICS feed or Event structured data, keep stable event IDs, pick one canonical listing. How to get pulled in automatically, by us and everyone else.',
    blurb:
      'Publish a feed once and stop submitting forever. This is the one that pays you back every month.',
    durationLabel: '5 min',
    related: ['series-recurrence-and-cancellations', 'how-to-get-on-the-calendar'],
    youtubeId: null,
    posterSrc: null,
    uploadDate: null,
    durationIso: null,
  },
  {
    slug: 'series-recurrence-and-cancellations',
    track: 'organizers',
    order: 4,
    title: 'Weekly events, changes and cancellations',
    seoTitle: 'Recurring Events, Changes and Cancellations',
    metaDescription:
      'How to send a recurring series, how to change a date without creating a duplicate, and how to tell us something is cancelled so the calendar tells the truth.',
    blurb:
      'Recurring series, moved dates, cancelled nights. Handled right, none of these turn into duplicates.',
    durationLabel: '3 min',
    related: ['write-a-listing-that-gets-clicked', 'make-your-website-machine-readable'],
    youtubeId: null,
    posterSrc: null,
    uploadDate: null,
    durationIso: null,
  },
  {
    slug: 'embed-and-partner-portal',
    track: 'organizers',
    order: 5,
    title: 'Your calendar on your site, and the partner portal',
    seoTitle: 'Embed the Calendar and Use the Partner Portal',
    metaDescription:
      'Put a live Akron Pulse calendar on your own website, themed to fit, and manage your organization events yourself through the partner portal.',
    blurb:
      'A live calendar on your own site, themed to fit, plus the portal for organizations that post often.',
    durationLabel: '4 min',
    related: ['make-your-website-machine-readable', 'how-to-get-on-the-calendar'],
    youtubeId: null,
    posterSrc: null,
    uploadDate: null,
    durationIso: null,
  },
]
