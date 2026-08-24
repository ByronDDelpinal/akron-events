import { Link } from 'react-router-dom'

export default function NeighborhoodAndPersonalFilters() {
  return (
    <>
      <p>
        Akron Pulse covers Summit County, which is more ground than any one
        person cares about. The settings in this guide are how you cut that down
        to the version of the calendar you would actually keep open. They take
        about two minutes and then you never think about them again.
      </p>

      <h2>Set your community</h2>
      <p>
        This one comes with a catch worth knowing up front: My Community lives
        in the installed app, not the website. If you have not{' '}
        <Link to="/guides/install-the-app">added Akron Pulse to your home
        screen</Link> yet, do that first and the picker shows up in the nav. It
        asks you once on your first launch.
      </p>
      <p>
        Pick the neighborhood or the city you actually live in. Highland Square,
        North Hill, Downtown, Cuyahoga Falls, Kenmore, and so on down the list.
        From then on the app remembers it. The nav carries a My Community button
        that goes straight to that community's page, and a long press on the app
        icon has a shortcut to it, so you are one tap from your own neighborhood
        without setting it again.
      </p>
      <p>
        Worth knowing how this works, because it is different from most sites.
        We do not use zip codes. Zip codes cut through neighborhoods in ways
        that make no sense to anybody who lives here, and a zip radius will
        happily tell you a bar on the other side of a highway is your local
        spot. We use actual neighborhood boundaries and the venue's real
        coordinates. When the site says an event is in North Hill, it means it
        is in North Hill.
      </p>
      <p>
        Be clear about what it does though. A community page is a filter, not a
        preference. While you are on it you are seeing that neighborhood and
        nothing else. That is usually what you want on a Tuesday, and it is
        exactly what you do not want when you are looking for something big
        happening across town, so head back to the full list when the question
        changes.
      </p>

      <h2>Set the audience toggle</h2>
      <p>
        In the filter tray there is a control with two settings, Everyone and
        Hide kids and family. It exists because the calendar serves two people
        who want opposite things.
      </p>
      <ul>
        <li>
          If you do not have kids, story hours and school carnivals are noise.
          Turn them off and a surprising amount of clutter goes away, especially
          on weekend mornings.
        </li>
        <li>
          If you do have kids, you want the opposite, and the family category
          filter is the fastest way to get a list where everything on it is
          something you could bring a six year old to.
        </li>
      </ul>

      <h2>Exclude the categories you are never going to</h2>
      <p>
        Category chips cycle. First tap includes, second tap excludes, third tap
        clears. Exclusion is the one people never find, and it is the more
        useful half.
      </p>
      <p>
        Be honest with yourself here. If you have never once gone to a
        networking event, exclude it. If sports are not your thing, exclude
        them. Two or three exclusions is usually enough to make the feed feel
        like it was built for you, and unlike including a category, excluding
        one does not narrow you into a corner. You still get everything else,
        including the stuff you would not have thought to search for.
      </p>

      <h2>Save it, do not redo it</h2>
      <p>
        The community setting sticks on its own once you pick it. The filters
        are a different mechanism: they live in the URL, which is better than it
        sounds, because it means a set of filters is a thing you can save.
      </p>
      <ol>
        <li>Set the audience toggle.</li>
        <li>Exclude your two or three dead categories.</li>
        <li>Add whatever else fits, a price cap, a date range.</li>
        <li>Bookmark the page. The bookmark holds every one of those settings.</li>
      </ol>
      <p>
        That bookmark is a better front page than our front page. If you want
        the same treatment for your inbox, the{' '}
        <Link to="/guides/newsletter-preferences">newsletter preferences</Link>{' '}
        go quite a bit deeper than this.
      </p>
    </>
  )
}
