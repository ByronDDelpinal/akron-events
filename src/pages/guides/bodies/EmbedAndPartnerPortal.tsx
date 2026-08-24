import { Link } from 'react-router-dom'

export default function EmbedAndPartnerPortal() {
  return (
    <>
      <p>
        Two things here, for two different kinds of partner. The embed puts our
        calendar on your website. The portal lets you manage your own events
        yourself. Plenty of organizations want one and not the other, and both
        are free.
      </p>

      <h2>The embed, in one paragraph</h2>
      <p>
        It is a live Akron Pulse calendar running inside a page on your own
        site, themed to fit, showing only the events you want it to show. Your
        visitors never leave your domain. It updates itself, because it is
        reading the same data the main site reads, so it is never the stale
        calendar page that every organization's website eventually has.
      </p>

      <h2>What you get to control</h2>
      <ul>
        <li><strong>Theme</strong>, so it sits on your page without looking like somebody else's widget.</li>
        <li><strong>Categories</strong>, so a music venue can show music and a library can show family programming.</li>
        <li><strong>Geography</strong>, so a neighborhood group can show its neighborhood.</li>
        <li><strong>Layout</strong>, list, calendar or map, plus a compact density option for when space is tight.</li>
      </ul>
      <p>
        Open <Link to="/embed-builder">the embed builder</Link> and change the
        settings around. The preview is live, so you can see the actual thing
        before you talk to anybody. When it looks right, send it to us from that
        page.
      </p>

      <h2>Why we set them up by hand</h2>
      <p>
        There is no copy this code snippet button, on purpose. Every embed gets
        configured with us, which takes one short email exchange, and there are
        two reasons for that.
      </p>
      <p>
        The first is that we want to know who is running one so we can tell you
        before anything changes. The second is that an embed that is filtered
        slightly wrong is worse than no embed, and five minutes of a person
        looking at it prevents that. It is not a sales call. Nobody is going to
        follow up with a quote.
      </p>

      <h2>The partner portal</h2>
      <p>
        For organizations that post often, we can set up an account that lets
        you create and edit your own events directly, without emailing us at
        all. This is newer, and we onboard people one at a time. If that sounds
        like you, email{' '}
        <a href="mailto:byron@akronpulse.com">byron@akronpulse.com</a> and we
        will get you set up.
      </p>
      <p>
        Once you are in, you see your organization's events and nothing else.
        You can create, edit and cancel. A few rules are worth knowing before
        you start, because they surprise people.
      </p>
      <ul>
        <li>
          <strong>New events go into review first.</strong> They are not live
          the second you save. This is the same queue everything else goes
          through and it usually moves same day. Once we have worked with you a
          while we can turn that off for your account.
        </li>
        <li>
          <strong>You cannot feature your own event.</strong> Featured slots are
          picked by hand, they are not for sale, and there is no button for it
          anywhere. That rule is what makes featured mean anything.
        </li>
        <li>
          <strong>Cancelling is final.</strong> If you cancel an event you
          cannot un-cancel it yourself. It is deliberately a one way door,
          because a listing that flips between cancelled and live teaches people
          not to trust the calendar. Email us if you cancelled something by
          mistake and we will sort it out.
        </li>
        <li>
          <strong>Editing an event that is still in review keeps it there.</strong>{' '}
          Changing the title or the start time on a pending event resets the
          clock rather than sneaking it through, which is the behavior you would
          want if you were on our side of it.
        </li>
      </ul>

      <h2>Which one do you want</h2>
      <ol>
        <li>You want a calendar on your site: the embed.</li>
        <li>You post a few events a month and email is fine: keep emailing, honestly, it works.</li>
        <li>You post weekly and want to control your own copy: the portal.</li>
        <li>You have a website that could publish a feed: read{' '}
          <Link to="/guides/make-your-website-machine-readable">the machine readable guide</Link>{' '}
          first, because that beats all three.</li>
      </ol>
    </>
  )
}
