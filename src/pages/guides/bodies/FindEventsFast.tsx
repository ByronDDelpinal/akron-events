import { Link } from 'react-router-dom'

export default function FindEventsFast() {
  return (
    <>
      <p>
        The homepage shows you everything, and everything is a lot. On a normal
        weekend there are a few hundred things happening in and around Akron.
        That is the whole point of the site, but it does mean the first screen
        you land on is not really an answer to your question. Your question is
        usually something like "what is there to do Friday night that is not a
        45 minute drive." Three controls get you there.
      </p>

      <h2>Search first when you already know the word</h2>
      <p>
        If you have a band, a festival, or even a vague word like trivia in your
        head, type it in the search box. Search reads event titles and
        descriptions, so jazz finds the jazz night at a bar that never uses the
        word concert. Typing a neighborhood or a festival name is a shortcut
        too, and it jumps you straight to that page instead of showing you a
        list of matches. Venue names are the one thing search does not run on,
        so when you want everything happening at one room, open that venue's
        page and work from there.
      </p>
      <p>
        Search is the fast path when you know what you want. Skip it entirely
        when you do not, because filtering from the full list is better at
        showing you something you were not looking for.
      </p>

      <h2>Then narrow it with Filter and Sort</h2>
      <p>
        The Filter and Sort button opens the tray where the real controls live.
        Work top down.
      </p>
      <ol>
        <li>
          <strong>When.</strong> Today, Tomorrow, This weekend, Next 7 days,
          This month, or pick your own dates. There is also a time of day
          control under it, which is the one people miss. If you work until
          five, setting evening cuts the list roughly in half and everything
          that is left is something you could actually attend.
        </li>
        <li>
          <strong>Categories.</strong> Tap once to include a category, tap
          again to exclude it, tap a third time to clear it. Excluding is
          underrated. Most people have one or two categories they will never go
          to, and turning those off permanently improves every list you look at
          after that.
        </li>
        <li>
          <strong>Everything else.</strong> Sort by, quick picks, price and
          audience. Set these once and they stick around while you browse.
        </li>
      </ol>
      <p>
        Every active filter shows up as a pill next to the search box, and each
        pill has an x on it. If the list looks wrong, look at the pills. Nine
        times out of ten there is a filter still on from twenty minutes ago.
      </p>

      <h2>Switch views depending on what you are deciding</h2>
      <p>
        The same filtered list renders three ways, and they answer different
        questions.
      </p>
      <ul>
        <li><strong>List</strong> is for scanning. It is the default and it is what you want most of the time.</li>
        <li><strong>Calendar</strong> is for planning ahead. Use it when the question is which night, not which event.</li>
        <li><strong>Map</strong> is for right now. Use it when the question is what is close to me, or when you already know the part of town you are going to be in.</li>
      </ul>
      <p>
        Switching views does not reset your filters. You can set up a search
        once, then flip between the three until one of them answers you.
      </p>

      <h2>The part that saves the most time</h2>
      <p>
        Filters live in the URL. That means the exact list you built is
        bookmarkable and shareable. Get the settings right one time, bookmark
        it, and that bookmark is your calendar from then on. I have one for
        free family stuff on weekends and one for live music after 7pm, and I
        open those instead of the homepage.
      </p>
      <p>
        Next, if you want the feed itself to remember who you are, read{' '}
        <Link to="/guides/neighborhood-and-personal-filters">make the calendar look like your life</Link>.
      </p>
    </>
  )
}
