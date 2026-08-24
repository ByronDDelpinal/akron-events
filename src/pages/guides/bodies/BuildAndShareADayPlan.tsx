import { Link } from 'react-router-dom'

export default function BuildAndShareADayPlan() {
  return (
    <>
      <p>
        Most event sites stop at the listing. You find something, you copy the
        link, you paste it into a group text, somebody asks what time, somebody
        else sends a different event, and now there are nine messages and no
        plan. The day planner is the fix for that. You build the night once and
        send one link.
      </p>

      <h2>Adding things</h2>
      <p>
        Every event card and every event page has a plus button. Tap it and the
        event goes into your plan. Tap it again to take it out. There is no
        account and no sign up, and the plan lives on your device until you
        decide to share it.
      </p>
      <p>
        Add more than you expect to do. The plan is a shortlist, not a
        commitment, and it is much easier to cut two things later than to go
        find them again.
      </p>

      <h2>Putting it in order</h2>
      <ol>
        <li>Open <Link to="/day">your plan</Link>. Everything you added is there, grouped by day.</li>
        <li>Drag the cards into the order you want to do them in. Times are shown on each one, so overlaps are obvious.</li>
        <li>Open the map. This is the step that changes plans. Two events that sound fine on paper are sometimes twenty minutes apart in opposite directions, and you can only see that on a map.</li>
        <li>Cut whatever the map just told you to cut.</li>
      </ol>
      <p>
        A plan holds up to 30 events. Nobody needs 30. If you are near the cap
        you are probably using it as a wishlist, which is fine, just start a new
        one for the actual night.
      </p>

      <h2>Sharing it</h2>
      <p>
        Hit share and you get a short link. Send that instead of five event
        links. Whoever opens it sees the same plan you built, in order, with the
        map, and they do not need the app or an account to look at it.
      </p>
      <p>
        The link is a plan, not an invitation, so there is no RSVP and nothing
        to accept. Think of it as a nicer version of pasting a list into a text
        message. You can also print it, which sounds old fashioned until you are
        running a group of people around a festival and half of them have dead
        phones.
      </p>

      <h2>Where this actually earns its keep</h2>
      <ul>
        <li>Somebody visiting town for a weekend. Build them a plan instead of a paragraph of suggestions.</li>
        <li>A first date where you want a backup two blocks away.</li>
        <li>Festival days, where the whole point is going from one thing to the next without thinking about it.</li>
      </ul>
      <p>
        If you are going to be out with it, put the{' '}
        <Link to="/guides/install-the-app">app on your phone</Link> first. Plans
        are much better one tap away than four.
      </p>
    </>
  )
}
