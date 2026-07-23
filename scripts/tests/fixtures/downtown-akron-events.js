/**
 * Fixture data for the Downtown Akron Partnership scraper tests.
 *
 * CALENDAR_HTML mirrors the real ctycms calendar markup: each event is an
 * <a href="/event/{slug}"> whose inner elements, split on tag boundaries,
 * yield [title, time, venue, weekday, day, month]. Two cards:
 *   1. A Full Grip Games card — its venue contains "am" inside "Games", the
 *      exact case that the old venue-detection regex silently dropped, and a
 *      venue we scrape directly (so it must be suppressed).
 *   2. A card at a venue we do NOT scrape directly — venue parses and survives.
 *   3. A card with NO time div at all — timeStr must come back null (the
 *      scraper must not fabricate a clock time for timeless listings).
 */
export const CALENDAR_HTML = `
<div class="calendar">
  <a href="/event/casual-commander-days-1" class="event-card">
    <div class="title">Casual Commander Days</div>
    <div class="time">12pm - 8pm</div>
    <div class="venue">Full Grip Games</div>
    <div class="dow">Tuesday</div><div class="day">30</div><div class="mon">Jun</div>
  </a>
  <a href="/event/sketchbook-social" class="event-card">
    <div class="title">Sketchbook Social</div>
    <div class="time">6pm</div>
    <div class="venue">Akron Art Museum</div>
    <div class="dow">Saturday</div><div class="day">4</div><div class="mon">Jul</div>
  </a>
  <a href="/event/all-day-art-walk" class="event-card">
    <div class="title">All Day Art Walk</div>
    <div class="venue">Akron Soul Train</div>
    <div class="dow">Sunday</div><div class="day">5</div><div class="mon">Jul</div>
  </a>
</div>
`

// Time-parsing fixtures (exported parseTime returns HH:MM:00).
export const F1 = { time: '9:30 a.m.', exp: '09:30:00' }
export const F2 = { time: '7:00 p.m.', exp: '19:00:00' }
export const ALL = [F1, F2]
