/**
 * guideBodies.ts — slug to prose component.
 *
 * The registry in src/lib/guidesData.js holds a guide's metadata; the actual
 * written walkthrough is a hand-authored component in ./bodies so it can be
 * edited like writing rather than like data (real paragraphs, real lists, real
 * links, no escaped strings and no markdown dependency).
 *
 * Statically imported on purpose. GuidePage is already its own lazy route
 * chunk and these are a few KB of prose each, so a second layer of lazy
 * loading would buy nothing and cost a Suspense boundary. If the bodies ever
 * grow large enough to matter, switch this map to lazy() and wrap the render
 * site in GuidePage.
 *
 * scripts/tests/test-guides-page-guards.js asserts this map and the registry
 * agree in both directions: no guide without a body, no body without a guide.
 */

import type { ComponentType } from 'react'
import FindEventsFast from './bodies/FindEventsFast'
import BuildAndShareADayPlan from './bodies/BuildAndShareADayPlan'
import NeighborhoodAndPersonalFilters from './bodies/NeighborhoodAndPersonalFilters'
import NewsletterPreferences from './bodies/NewsletterPreferences'
import InstallTheApp from './bodies/InstallTheApp'
import HowToGetOnTheCalendar from './bodies/HowToGetOnTheCalendar'
import WriteAListingThatGetsClicked from './bodies/WriteAListingThatGetsClicked'
import MakeYourWebsiteMachineReadable from './bodies/MakeYourWebsiteMachineReadable'
import SeriesRecurrenceAndCancellations from './bodies/SeriesRecurrenceAndCancellations'
import EmbedAndPartnerPortal from './bodies/EmbedAndPartnerPortal'

export const GUIDE_BODIES: Record<string, ComponentType> = {
  'find-events-fast': FindEventsFast,
  'build-and-share-a-day-plan': BuildAndShareADayPlan,
  'neighborhood-and-personal-filters': NeighborhoodAndPersonalFilters,
  'newsletter-preferences': NewsletterPreferences,
  'install-the-app': InstallTheApp,
  'how-to-get-on-the-calendar': HowToGetOnTheCalendar,
  'write-a-listing-that-gets-clicked': WriteAListingThatGetsClicked,
  'make-your-website-machine-readable': MakeYourWebsiteMachineReadable,
  'series-recurrence-and-cancellations': SeriesRecurrenceAndCancellations,
  'embed-and-partner-portal': EmbedAndPartnerPortal,
}
