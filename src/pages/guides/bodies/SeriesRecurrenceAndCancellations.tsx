import { Link } from 'react-router-dom'

export default function SeriesRecurrenceAndCancellations() {
  return (
    <>
      <p>
        Weekly trivia, monthly markets, a class that runs eight Tuesdays in a
        row. Recurring events are most of what happens in a city and they are
        also where calendars fall apart. Same for the day something moves or
        gets rained out. None of this is hard, it just has a right way and a
        wrong way.
      </p>

      <h2>Sending a recurring series</h2>
      <p>
        If you have a feed, use the recurrence rule your calendar software
        already supports. An ICS feed can say every Tuesday at 7pm until
        December in one entry, and we expand that into individual nights on our
        side. That is the cleanest version by a mile, and it means changing the
        series later is one edit for you.
      </p>
      <p>
        If you are submitting by hand, do not send us fifty separate
        submissions. The submit form has a repeat option right under the start
        date: pick weekly, every other week, or monthly on the same weekday,
        then say how many dates it runs for or when it ends. We create the whole
        run in one go and review it as a batch. If one date in the middle needs
        to come out, a holiday most often, email{' '}
        <a href="mailto:intake@akronpulse.com">intake@akronpulse.com</a> and we
        will take it off. The skipping part matters, because a series that
        quietly does not happen on a holiday is worse than no listing.
      </p>
      <p>
        One thing to decide up front: is this one event that repeats, or a
        series of different events. Trivia night every Tuesday is the first.
        A concert series where each night is a different band is the second, and
        those should be listed individually with the artist in each title, or
        nobody can tell them apart.
      </p>

      <h2>Changing something that is already up</h2>
      <p>
        Edit, do not resubmit. Resubmitting is the number one way duplicates get
        created, and once there are two versions of your event on the calendar
        the wrong one will get the clicks about half the time.
      </p>
      <ul>
        <li>
          <strong>If it came from your feed:</strong> change it on your site,
          keeping the same event ID and URL, and we will pick the change up on
          the next nightly pull. Do not delete the entry and make a new one for
          the new date. That reads as a cancellation plus a brand new event.
        </li>
        <li>
          <strong>If you submitted it by hand:</strong> email{' '}
          <a href="mailto:intake@akronpulse.com">intake@akronpulse.com</a> with
          the link to the listing and what changed. One line is enough.
        </li>
      </ul>

      <h2>Cancellations</h2>
      <p>
        Tell us. Please. A cancelled event that still shows as happening is the
        thing that does the most damage, both to you and to us, because somebody
        drove there.
      </p>
      <p>
        Email us. Right now that is the path that works, including for
        organizations we pull from a feed. Subject line CANCELLED plus the event
        name is plenty, sent to{' '}
        <a href="mailto:intake@akronpulse.com">intake@akronpulse.com</a>. If it
        is same day, say so in the subject and we will move it to the front.
      </p>
      <p>
        Being straight with you about why: our feed reader does not yet act on a
        cancelled status inside an ICS file, so marking it there and assuming we
        caught it is a real risk. Keep marking it in your own calendar, because
        that is right for everyone else reading your feed, and send us the email
        anyway. When we do support reading it we will say so here.
      </p>
      <p>
        Also, do not just delete the entry. Deleting is ambiguous. A feed that
        stops mentioning an event could mean it was cancelled or could mean your
        site had a bad night, and we deliberately do not treat a missing entry
        as a cancellation for that reason.
      </p>
      <p>
        Weather calls are the common case. If you cancel at 4pm for a 6pm
        outdoor event, email us at 4pm. It is a two minute job on our end and it
        is the difference between a mild disappointment and somebody standing in
        a parking lot in the rain.
      </p>

      <h2>Postponed is not cancelled</h2>
      <p>
        Say which one it is. Postponed means the same event on a new date, and
        we can move the existing listing so it keeps whatever attention it has
        already collected. Cancelled means it is not happening. If you tell us
        cancelled and then rebook it, that becomes a new listing starting from
        zero, so use the right word.
      </p>

      <h2>Sold out</h2>
      <p>
        Worth telling us as well, though it is lower stakes. We would rather
        show people that a thing is full than have them click through to a
        ticket page that has been closed for a week.
      </p>

      <h2>The short version</h2>
      <ol>
        <li>Recurrence belongs in your feed as a rule, or in the repeat picker, not as fifty entries.</li>
        <li>Edit in place, keep the same ID, never resubmit.</li>
        <li>Email us the cancellation. Do not just delete the row.</li>
        <li>Postponed and cancelled are different words with different outcomes.</li>
        <li>Same day changes get same day attention if you say it is same day.</li>
      </ol>
      <p>
        If you post often enough that this is a weekly chore, the{' '}
        <Link to="/guides/embed-and-partner-portal">partner portal</Link> may be
        a better fit than emailing us.
      </p>
    </>
  )
}
