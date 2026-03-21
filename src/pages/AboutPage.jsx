import './AboutPage.css'

export default function AboutPage() {
  return (
    <>
      <div className="about-hero">
        <h2>Built for <span>Akron</span></h2>
        <p>A community-first events platform for the 330 — because your city deserves better than scrolling through five different websites to find out what's happening this weekend.</p>
      </div>

      <div className="about-body-wrap">
        <div className="about-bar" />

        <p className="about-p">
          The 330 is an independent, community-maintained events guide for Akron, OH and Summit County. It pulls together concerts, art openings, galas, fundraisers, farmers markets, and local happenings into one clean, browsable place.
        </p>

        <p className="about-p">
          Events are sourced from ticketing platforms, local venue calendars, and direct submissions from organizers. If something is missing, you can <a href="/submit">submit it here</a> — we review and publish within 24 hours.
        </p>

        <p className="about-p">
          This project is a passion project, not a business. There are no ads, no paywalls, and no tracking. Just Akron events.
        </p>

        <div className="about-divider" />

        <h3 className="about-section-title">Have an event to share?</h3>
        <p className="about-p">
          If you're an organizer, venue, or community member with an event happening in the 330, we'd love to feature it. <a href="/submit">Submit your event →</a>
        </p>

        <h3 className="about-section-title">Something wrong?</h3>
        <p className="about-p">
          If you spot an event with incorrect info, a duplicate, or something that shouldn't be listed, reach out and we'll get it fixed quickly.
        </p>
      </div>
    </>
  )
}
