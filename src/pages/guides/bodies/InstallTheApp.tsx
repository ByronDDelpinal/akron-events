import { Link } from 'react-router-dom'

export default function InstallTheApp() {
  return (
    <>
      <p>
        Akron Pulse installs on your phone like an app. There is no app store,
        no download, and no account. It is the same site, saved to your home
        screen, running full screen without the browser bars. Takes about ten
        seconds.
      </p>

      <h2>iPhone</h2>
      <ol>
        <li>Open akronpulse.com in Safari. It has to be Safari, this is an Apple rule and not something we control.</li>
        <li>Tap the share button, the square with the arrow coming out of the top.</li>
        <li>Scroll down the list and tap Add to Home Screen.</li>
        <li>Tap Add.</li>
      </ol>

      <h2>Android</h2>
      <ol>
        <li>Open akronpulse.com in Chrome.</li>
        <li>Either take the install prompt when it appears at the bottom, or open the three dot menu and choose Install app.</li>
        <li>Confirm.</li>
      </ol>
      <p>
        On a desktop it works too, from the install icon in the address bar,
        which is nice if you keep a browser window open all day at work.
      </p>

      <h2>What you get out of it</h2>
      <ul>
        <li>It opens straight to events. No browser, no tabs, no typing the address.</li>
        <li>It remembers your filters and your community between visits.</li>
        <li>Your <Link to="/guides/build-and-share-a-day-plan">day plan</Link> is one tap away, which matters when you are standing on a sidewalk deciding what is next.</li>
        <li>It takes up almost nothing. This is a website in a nicer wrapper, not a 200 megabyte install.</li>
      </ul>

      <h2>Using it out in the world</h2>
      <p>
        This is what it is for. You are downtown, you have an hour, you do not
        know what is around. Open it, switch to map view, and look at what is
        within walking distance in the next couple of hours.
      </p>
      <p>
        Festival days are the other one. When a festival is running we build a
        hub page for it with the full schedule and a map of the venues, and on a
        phone that is much easier to work with than a paper program or a
        Facebook event with 300 comments. Pull up the festival page, add the
        sets you want to catch to a plan, and follow it.
      </p>
      <p>
        One caveat so you are not surprised. The app needs a connection to load
        new events. Big outdoor festivals are exactly where cell service falls
        apart, so open the schedule before you walk in.
      </p>
    </>
  )
}
