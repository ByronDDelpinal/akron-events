import { Link } from 'react-router-dom'

export default function HowToGetOnTheCalendar() {
  return (
    <>
      <p>
        Getting listed is free and it always will be. There are four ways in and
        they are good at different things. Pick the one that matches how much
        you post, not the one that sounds the most official.
      </p>

      <h2>1. Email it to us</h2>
      <p>
        Send whatever you already made to{' '}
        <a href="mailto:intake@akronpulse.com">intake@akronpulse.com</a>. A
        flyer, a press release, the newsletter you were sending anyway, a
        forwarded email from your marketing person. Our pipeline reads it and
        the event is usually live inside 24 hours.
      </p>
      <p>
        This is the one to use if you are busy, which you are. There is no form
        and nothing to learn. If you already have a mailing list, add us to it
        and you are done forever.
      </p>

      <h2>2. Fill out the form</h2>
      <p>
        <Link to="/submit">The submit form</Link> takes about five minutes and
        gives you the most control over how the listing reads. Use it when the
        event is a big deal for you and you want the details exactly right.
        Everything on it except the name, the category and the start time is
        optional, but the optional fields are what make the listing good, and
        the next guide is about that.
      </p>

      <h2>3. Register your organization</h2>
      <p>
        <Link to="/organizations/submit">Register your org</Link> and you get a
        page in the public directory with your description and every upcoming
        event you have on the calendar. There is nothing to log into and nothing
        to maintain. It also links your events together, so somebody who liked
        one thing you did can see the rest of it in one place.
      </p>

      <h2>4. Register your venue</h2>
      <p>
        If you run a space, <Link to="/venues/submit">register the venue</Link>{' '}
        as well as the org. Venues get their own page and their own map pin, and
        every event held there points back at it. Do both if you are a space
        that also hosts its own programming, because they are separate things to
        us. The org is who is putting the event on. The venue is the building.
      </p>

      <h2>What happens after you hit send</h2>
      <p>
        A person reads it. Not a filter, not a queue that nobody watches. That
        is worth explaining because it is the part people are most suspicious
        of, and because it means we sometimes change what you sent.
      </p>
      <ul>
        <li>
          <strong>We check the location is real.</strong> Venue names get
          matched against places we already know, and a new one gets geocoded
          from the address. This is why an address is worth including even when
          the venue is famous.
        </li>
        <li>
          <strong>We fix obvious data problems.</strong> Titles with HTML in
          them, a start time of midnight that clearly means the doors are at
          seven, a venue field that is just a street address with no name.
        </li>
        <li>
          <strong>We check it is not already on there.</strong> Your event may
          already have reached us from a ticketing platform or a partner site.
          When there are two, we keep the version that came from you and drop
          the copy.
        </li>
        <li>
          <strong>We categorize it.</strong> Sometimes differently than you did,
          because categories drive filters and a slightly wrong one puts you in
          front of the wrong people.
        </li>
      </ul>
      <p>
        Turnaround is usually same day and effectively never longer than 24
        hours. If something you sent is not up after that, email us and say so.
        It is a bug and we want to know.
      </p>

      <h2>The one thing we cannot do for you</h2>
      <p>
        Featured placement is not for sale and it is not self serve. We choose
        those by hand, based on what we think the city should not miss, and
        nobody can request it. Everything else about how your event performs
        comes down to the listing itself, which is the{' '}
        <Link to="/guides/write-a-listing-that-gets-clicked">next guide</Link>.
      </p>
    </>
  )
}
