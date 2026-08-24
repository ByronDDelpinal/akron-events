import { Link } from 'react-router-dom'

export default function WriteAListingThatGetsClicked() {
  return (
    <>
      <p>
        Two events on the same night, same category, same part of town. One gets
        opened four times as often as the other. It is almost never because the
        event is better. It is the title, the time, and whether there is a
        photo. Here is what we have learned from watching a lot of listings go
        by.
      </p>

      <h2>The title</h2>
      <p>
        A title has one job, which is to tell somebody scrolling on a phone
        whether this is for them. Say the thing.
      </p>
      <ul>
        <li>
          <strong>Do not put the venue name in it.</strong> The venue is already
          on the card, right under the title, on every surface we render. Live
          Music at The Rialto wastes half your title repeating something the
          reader can already see. Just say who is playing.
        </li>
        <li>
          <strong>Skip the dates.</strong> Same reason. The date is on the card.
        </li>
        <li>
          <strong>No all caps and no HTML.</strong> If you are copying out of a
          web page or a design tool, paste it into a plain text editor first.
          Stray tags in a title are the single most common thing we clean up by
          hand.
        </li>
        <li>
          <strong>Be specific over clever.</strong> Third Thursday beats Come
          Join Us. A name only your regulars know is fine as long as it is
          paired with what it actually is.
        </li>
      </ul>

      <h2>The start time</h2>
      <p>
        Give us the real one. This sounds obvious and it is the field we correct
        most often.
      </p>
      <p>
        What happens is that a system somewhere defaults to midnight or noon
        when nobody fills the time in, and then an event that is really a 7pm
        show goes out with a time nobody believes. Readers filter by evening and
        miss you. It also breaks the sort, so a midnight event sits at the top
        of the wrong day.
      </p>
      <p>
        If doors and show time are different, use the time people should arrive
        and put the rest in the description. If it truly runs all day, say so
        with a real start and end rather than leaving it blank.
      </p>

      <h2>The image</h2>
      <p>
        Include one. I want to be blunt about why, because it is not a design
        preference.
      </p>
      <p>
        An event with no image anywhere in its chain can never become a large
        card in the newsletter. That is a hard gate, not a scoring nudge. It
        shows up as a line of text under a heading while the event next to it
        gets a picture, a description and three times the space.
      </p>
      <p>
        The chain matters, because it is your safety net. We look at the event's
        own image first, then the venue's, then the organization's. So if you{' '}
        <Link to="/organizations/submit">register your org</Link> with a decent
        logo or photo, every event you ever list has something to fall back on,
        even the ones you throw together in a hurry. That is a one time job and
        it is the highest return ten minutes on this page.
      </p>
      <p>
        The submit form does not have an image field, which surprises people.
        Attach the photo to an email to{' '}
        <a href="mailto:intake@akronpulse.com">intake@akronpulse.com</a>{' '}
        instead, or send the flyer that way to begin with and skip the form.
      </p>
      <p>
        It does not need to be designed. A clear photo of the band, the room,
        the food, or last year's crowd beats a flyer with the details in tiny
        text every time, because we show it at card size and nobody can read a
        flyer at card size. Landscape crops better than portrait.
      </p>

      <h2>The first sentence of the description</h2>
      <p>
        Write the description so the first sentence can stand alone, because
        often it has to. Say what happens and who it is for. Save the parking
        instructions, the sponsor list and the history of the organization for
        later in the paragraph.
      </p>
      <p>
        A good first sentence sounds like: Six local bands, outdoors, free, kids
        welcome until dark. A bad one sounds like: We are excited to announce
        the return of our annual event.
      </p>

      <h2>Categories and audience</h2>
      <p>
        Pick up to two categories and pick them honestly. Categories are what
        the filters run on, so this is the difference between reaching people
        who want your thing and reaching everybody, which in practice means
        reaching nobody. A concert that is also a fundraiser should be tagged as
        both. A networking mixer is not a party.
      </p>
      <p>
        Set the age restriction if there is one. Plenty of people filter on all
        ages, and a 21 and up show that forgets to say so gets opened by the
        wrong crowd and skipped by the right one.
      </p>

      <h2>The venue and the address</h2>
      <p>
        Name the venue, then give the street address anyway. We match venues by
        name and geocode new ones by address, and we do not accept a bare
        address as a venue name. So The Well, 647 E Market St puts you on the
        map in the right neighborhood, and 647 E Market St alone gets held up
        for a person to sort out.
      </p>

      <h2>Quick pass before you send</h2>
      <ol>
        <li>Does the title say what it is without naming the venue or the date?</li>
        <li>Is the start time the time a person should show up?</li>
        <li>Is there an image somewhere, on the event, the venue or the org, and does it read at thumbnail size?</li>
        <li>Does sentence one stand on its own?</li>
        <li>Are the categories the ones a stranger would guess?</li>
        <li>Venue name and street address both present?</li>
      </ol>
      <p>
        That is about ninety seconds of work and it is most of the gap between
        the listings that do well and the ones that do not. If your event runs
        on a schedule rather than once, read{' '}
        <Link to="/guides/series-recurrence-and-cancellations">the one on recurring events</Link> next.
      </p>
    </>
  )
}
