import { Link } from 'react-router-dom'
import { SEO, buildGraph, faqPageSchema, breadcrumbSchema } from '@/lib/seo'
import './AboutPage.css'

// FAQ content pulled into structured data. Each question/answer is also
// visible elsewhere on the site (homepage hero, footer, About body). Keep
// answers under ~300 chars so they read well as LLM citations.
const FAQS = [
  {
    question: 'What is Akron Pulse?',
    answer:
      'Akron Pulse is a free directory of local events in Akron, Ohio and Summit County. We track concerts, art shows, community gatherings, fundraisers, farmers markets, sports events, and more — so locals and visitors can find everything happening in one place.',
  },
  {
    question: 'How much does Akron Pulse cost?',
    answer:
      'Akron Pulse is free to use and free to submit events to. We exist to make local events easier to discover, not to gatekeep them.',
  },
  {
    question: 'What areas does Akron Pulse cover?',
    answer:
      'Akron Pulse covers events in Akron and the broader Summit County, Ohio area, including surrounding neighborhoods like Downtown Akron, Highland Square, North Hill, Cuyahoga Falls, and beyond.',
  },
  {
    question: 'How do I submit an event to Akron Pulse?',
    answer:
      'Anyone can submit an event through the Submit page. Submissions are reviewed before being published. We also aggregate events from venue websites and partner organizations.',
  },
  {
    question: 'How often is Akron Pulse updated?',
    answer:
      'Akron Pulse is updated daily. New events from partner venues are added continuously, and community-submitted events are reviewed and published within a day or two.',
  },
]

const PERSONAS = [
  {
    label:       'Plan a Date Night',
    description: 'Evening events, live music, and good food — curated for two.',
    href:        '/?categories=music,food&dateRange=this_week&sort=date',
    icon:        '🎷',
  },
  {
    label:       'Family Weekend',
    description: 'Daytime events and free admission — something for everyone.',
    href:        '/?categories=community,education&freeOnly=true',
    icon:        '🎨',
  },
  {
    label:       'Catch Live Music',
    description: 'Local and touring acts across every venue we track.',
    href:        '/?categories=music',
    icon:        '🎸',
  },
  {
    label:       'Last-Minute Plans',
    description: "What's happening this weekend, right now.",
    href:        '/?dateRange=this_weekend',
    icon:        '⚡',
  },
]

export default function AboutPage() {
  const seoGraph = buildGraph(
    breadcrumbSchema([
      { name: 'Home',  url: '/' },
      { name: 'About', url: '/about' },
    ]),
    faqPageSchema(FAQS),
  )

  return (
    <>
      <SEO
        title="About Akron Pulse — Local Events in Akron, OH"
        description="Akron Pulse is a free directory of local events in Akron and Summit County. Learn what we cover, how often we update, and how to submit your own event."
        path="/about"
        jsonLd={seoGraph}
      />
      <div className="about-hero">
        <h1>Akron deserves <span>better</span></h1>
        <p>
          There are concerts, gallery openings, community gatherings, and
          late-night shows happening in this city every single week.
          Most people never hear about them.
        </p>
      </div>

      <div className="about-body-wrap">
        <div className="about-bar" />

        <p className="about-p">
          Akron doesn't have a noise problem. It has a signal problem.
        </p>

        <p className="about-p">
          Events get posted across a dozen different websites, buried in Facebook groups,
          or quietly announced to whoever already follows the right accounts.
          The city gets written off as sleepy by people who simply didn't know where to look.
        </p>

        <p className="about-p">
          Akron Pulse is one place to look. We pull from local venue calendars, ticketing
          platforms, and community submissions — updated daily, no duplicates, no noise.
          If it's happening in Akron, it should be here.
        </p>

        <div className="about-divider" />

        <h3 className="about-section-title">Find your reason to go out</h3>
        <p className="about-p" style={{ marginBottom: 24 }}>
          Not sure where to start? Pick a vibe.
        </p>

        <div className="about-personas">
          {PERSONAS.map(({ label, description, href, icon }) => (
            <Link key={label} to={href} className="about-persona-card">
              <span className="persona-icon">{icon}</span>
              <div className="persona-text">
                <p className="persona-label">{label}</p>
                <p className="persona-desc">{description}</p>
              </div>
              <span className="persona-arrow">→</span>
            </Link>
          ))}
        </div>

        <div className="about-divider" />

        <h3 className="about-section-title">Have an event to share?</h3>
        <p className="about-p">
          If you're an organizer, venue, or community member with something
          happening in Akron, we'd love to feature it.{' '}
          <Link to="/submit">Submit your event →</Link>
        </p>

        <div className="about-divider" />

        <h3 className="about-section-title">Frequently asked</h3>
        <div className="about-faqs">
          {FAQS.map(({ question, answer }) => (
            <div key={question} className="about-faq">
              <h4 className="about-faq-q">{question}</h4>
              <p className="about-faq-a">{answer}</p>
            </div>
          ))}
        </div>

        <h3 className="about-section-title">See something missing?</h3>
        <p className="about-p">
          Wrong info, a duplicate, a venue we're not tracking — reach out.
          I read everything.{' '}
          <a href="mailto:byronddelpinal@gmail.com">byronddelpinal@gmail.com</a>
        </p>

        <div className="about-divider" />

        <div className="about-technical-row">
          <div>
            <p className="about-p" style={{ marginBottom: 0 }}>
              Curious how the data pipeline works? See every active data source,
              scraper method, live event counts, and health status.
            </p>
          </div>
          <Link to="/technical" className="about-technical-btn">
            Technical Details →
          </Link>
        </div>
      </div>
    </>
  )
}
