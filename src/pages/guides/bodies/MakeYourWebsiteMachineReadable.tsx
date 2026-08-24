import { Link } from 'react-router-dom'

export default function MakeYourWebsiteMachineReadable() {
  return (
    <>
      <p>
        This is the one that pays you back. Everything else on this page is
        about sending us an event. This is about setting your own site up so you
        never have to send us anything again, and so every other calendar,
        search engine and assistant in the world can read you too.
      </p>
      <p>
        It is a one time job, usually an afternoon, often a checkbox in software
        you already pay for. Then it runs on its own.
      </p>

      <h2>Publish a calendar feed</h2>
      <p>
        An ICS feed is the calendar file format that Google Calendar, Outlook
        and Apple Calendar all speak. If you have a feed URL, we can point a
        scraper at it and pull your events every night, automatically, forever.
        You update your site and we update within a day. Nobody emails anybody.
      </p>
      <p>
        You may already have one and not know it.
      </p>
      <ul>
        <li>WordPress with The Events Calendar publishes one out of the box, usually at yoursite.com/events/?ical=1.</li>
        <li>Google Calendar will give you a public ICS address in the calendar settings, under integrations.</li>
        <li>Squarespace and Wix events, most library and parks systems, and most ticketing platforms have one somewhere in the settings.</li>
        <li>Eventbrite and similar platforms are readable to us too, so if that is where your events live, tell us and we will hook into it.</li>
      </ul>
      <p>
        Ask whoever built your site whether there is an ICS or iCal feed. It is
        a five word question and the answer is yes more often than people
        expect.
      </p>

      <h2>Or mark up your event pages</h2>
      <p>
        If a feed is not available, the other option is structured data.
        Schema.org Event markup is a small block of JSON in the page that spells
        out the name, the start time, the location and the ticket link in a
        format machines read exactly. Google uses it for event results, and so
        do we.
      </p>
      <p>
        Most site builders have a plugin for this. The important part is that
        the marked up values match what a human sees on the page. Do not put a
        different time in the markup than the one in your copy.
      </p>

      <h2>Keep your IDs stable</h2>
      <p>
        This is the technical detail that causes the most trouble, and almost
        nobody thinks about it.
      </p>
      <p>
        Every event on your site has some identifier: a UID in an ICS feed, or
        just the URL of its page. We use that to recognize an event we have seen
        before. When the identifier stays the same, an edit on your side is an
        update on ours. When it changes, we have no way to know it is the same
        event, so it comes through as a new one and now there are two of you on
        the calendar.
      </p>
      <p>
        Some systems generate a fresh ID every time the page is republished.
        That produces a duplicate every single night, which is the worst version
        of this problem. If you see your events doubling up anywhere, that is
        usually the cause and it is worth asking your developer about.
      </p>

      <h2>Have one canonical page per event</h2>
      <p>
        Pick one page that is the real listing for each event and keep it
        stable. Everything else, the Facebook event, the Instagram post, the
        ticketing page, should point at it.
      </p>
      <p>
        When four half copies of an event exist in four places, all of them
        drift. The time gets fixed in one and not the others, and eventually
        someone shows up at the wrong hour holding a screenshot. One page you
        actually maintain beats four you do not.
      </p>

      <h2>A word about Facebook only</h2>
      <p>
        If your event exists only as a Facebook event, it is close to invisible
        outside Facebook. We cannot read it, other calendars cannot read it, and
        it does not show up in search. Neither can anybody who does not have an
        account, which is a growing number of people and skews older and lower
        income, which may be exactly who you are trying to reach.
      </p>
      <p>
        Keep using Facebook. Just make it the second place the event lives
        rather than the only one. Even a plain page on your own site with the
        name, the date, the address and a paragraph is enough for the rest of
        the internet to find you.
      </p>

      <h2>What good looks like</h2>
      <ol>
        <li>Every event has a page on your own site with a stable URL.</li>
        <li>The site publishes an ICS feed, or the pages carry Event markup.</li>
        <li>IDs do not change when you edit.</li>
        <li>Times and addresses on the page are the real ones.</li>
        <li>You tell us the feed URL once and stop thinking about us entirely.</li>
      </ol>
      <p>
        Send the feed to{' '}
        <a href="mailto:intake@akronpulse.com">intake@akronpulse.com</a> and we
        will take it from there. If you are not sure whether what you have
        counts, send us the link to your events page and we will tell you what
        we can see.
      </p>
      <p>
        The other half of feed hygiene is what happens when events repeat or
        change, which is{' '}
        <Link to="/guides/series-recurrence-and-cancellations">the next guide</Link>.
      </p>
    </>
  )
}
