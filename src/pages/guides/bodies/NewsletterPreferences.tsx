import { Link } from 'react-router-dom'

export default function NewsletterPreferences() {
  return (
    <>
      <p>
        Almost everyone signs up for the newsletter and then never opens the
        preference center. That is a shame, because the default email is a
        general interest email, and the tuned one is closer to a personal
        assistant who knows you hate networking events and love the Falls.
      </p>
      <p>
        Get there from <Link to="/subscribe">the subscribe page</Link>, or from
        the link at the bottom of any email we send you. Here is what each
        control does and which ones are worth your time.
      </p>

      <h2>The two that matter most</h2>
      <ol>
        <li>
          <strong>Keyword alerts.</strong> Type a word, press enter. Anything
          with that word in it comes to you, and this is the one control that
          jumps the queue: a keyword match reaches your email even when it does
          not fit your categories, your price cap or your distance. That is how
          you catch a specific band, a book club, a run, a food truck you like.
          There is a match title only switch if a broad word is dragging in too
          much.
        </li>
        <li>
          <strong>Favorite venues and organizations.</strong> Read the direction
          on this one carefully, because people get it backwards. Leaving it
          empty means all of them. Adding two venues does not mean those two get
          priority, it means your email is now only those two. It is a narrowing
          tool, and a good one, but use it when you genuinely want a short list
          rather than as a way to say you like a place.
        </li>
      </ol>

      <h2>Then the shaping controls</h2>
      <ul>
        <li>
          <strong>Categories.</strong> Start with All Events and fine tune from
          there. Same logic as the site filters: cutting two categories you
          never attend does more good than picking three you like.
        </li>
        <li>
          <strong>Which days.</strong> If you only go out on weekends, say so.
          The email stops spending its space on Tuesday.
        </li>
        <li>
          <strong>Location.</strong> Set a zip and a distance. This is the
          difference between an email you skim and an email where every item is
          drivable.
        </li>
        <li>
          <strong>Price and age.</strong> Cap the price if free and cheap is the
          point. The age setting does one job, which is keeping the email to all
          ages events. Use it if you are planning around kids.
        </li>
      </ul>

      <h2>Delivery</h2>
      <p>
        Set the frequency, how far ahead you want to look, and which day it
        lands. Most people are best served by one email that arrives Thursday
        and covers the weekend. If you plan further out than that, widen the
        window and take it less often.
      </p>

      <h2>A rule of thumb</h2>
      <p>
        If two emails in a row have nothing in them you would go to, the problem
        is the settings, not the calendar. Go back in, add a couple of keywords
        for things you actually care about, and cut a category. It is a five
        minute fix and it usually works.
      </p>
      <p>
        Unsubscribing is one click and we are not going to make it hard. I would
        rather you tune it than leave, but I would rather you leave than sit
        there deleting us every week.
      </p>
    </>
  )
}
