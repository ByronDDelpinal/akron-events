import { Link } from 'react-router-dom'
import { SEO, buildGraph, faqPageSchema, breadcrumbSchema } from '@/lib/seo'
import { INTENTS } from '@/lib/intents'
import './AboutPage.css'

// FAQ content pulled into structured data. Each question/answer is also
// visible elsewhere on the site (homepage hero, footer, About body). Keep
// answers under ~300 chars so they read well as LLM citations.
const FAQS = [
  {
    question: 'What is Akron Pulse?',
    answer:
      'Akron Pulse is a free directory of local events in Akron (OH) and Summit County. We track concerts, shows, gatherings, fundraisers, markets, games, classes, excursions, and more — so more people can plan, find community, and live the life they dream of.',
  },
  {
    question: 'How much does Akron Pulse cost?',
    answer:
      'Akron Pulse will never cost anything nor will it allow advertisements on the site. It exists to serve every Akron resident without compromise.',
  },
  {
    question: 'How do I submit an event to Akron Pulse?',
    answer:
      'Anyone can submit an event through the Submit page. Submissions are reviewed before being published. We also aggregate events from venue websites and partner organizations – so please check to make sure yours isn\'t already listed.',
    answerNode: (
      <>
        Anyone can submit an event through the{' '}
        <Link to="/submit">Submit page</Link>. Submissions are reviewed before
        being published. We also aggregate events from venue websites and partner
        organizations – so please check to make sure yours isn&apos;t already listed.
      </>
    ),
  },
  {
    question: 'Why should I use Akron Pulse?',
    answer:
      'We\'ve lived in Summit County for more than 10 years and the most common complaint we hear from residents is that they only ever hear about events after they happen. Akron Pulse is designed to change that – it features more local event listings than any other resource in Summit County.',
  },
  {
    question: 'How should I use Akron Pulse?',
    answer:
      'We love the website, but we recommend subscribing to our newsletter. You can choose the cadence and focus of your Akron Pulse to explore, find community, discover local gems, and live the life you want here.',
    answerNode: (
      <>
        We love the website, but we recommend{' '}
        <Link to="/subscribe">subscribing to our newsletter</Link>. You can
        choose the cadence and focus of your Akron Pulse to explore, find
        community, discover local gems, and live the life you want here.
      </>
    ),
  },
  {
    question: 'Who created Akron Pulse?',
    answer:
      'Akron Pulse is a collaboration between Byron Delpinal and Mac Love, two Summit County residents who are tired of hearing people say "there\'s nothing going on" or "nothing to do here." Get the Akron Pulse – you\'ll know better.',
  },
]

// Discovery "vibes" are derived straight from the canonical intent
// registry (src/lib/categories.js) so they never drift from the
// homepage Filter & Sort presets again. Each card links to the
// homepage with that intent pre-applied via ?intent=<id> (see
// HomePage.jsx, which reads the param on load).
const PERSONAS = INTENTS.map((intent) => ({
  label:       intent.label,
  description: intent.tagline,
  href:        `/?intent=${intent.id}`,
  icon:        intent.emoji,
}))

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
        title="About — How Akron Pulse Works"
        description="Akron Pulse is a free directory of local events in Akron and Summit County. Learn what we cover, how often we update, and how to submit your own event."
        path="/about"
        jsonLd={seoGraph}
      />
      <div className="about-hero">
        <h1>Never miss <span>a beat</span></h1>
        <p>
          Amazing concerts, exhibitions, games, gatherings, and experiences
          are happening every week. Akron Pulse has them all.
        </p>
      </div>

      <div className="about-body-wrap">
        <div className="about-bar" />

        <p className="about-p">
          Akron Pulse will make sure you learn about an event a week early, not a day late.
          We pull data from local websites, venue calendars, ticketing platforms, community
          mailers, and user submissions – updated daily, no duplicates, no noise – to give
          you the most comprehensive and reliable events calendar in Summit County. The best
          part – you can tailor it to the cadence that works best for you. Check it out!
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

        <div className="about-submit-banner">
          <div className="about-submit-banner__text">
            <h3 className="about-submit-banner__title">Have an event to share?</h3>
            <p className="about-submit-banner__desc">
              If you're an organizer, venue, or community member with something
              happening in Akron, we'd love to feature it.
            </p>
          </div>
          <Link to="/submit" className="about-submit-banner__btn">Submit your event →</Link>
        </div>

        <div className="about-divider" />

        <h3 className="about-section-title">Frequently asked</h3>
        <div className="about-faqs">
          {FAQS.map(({ question, answer, answerNode }) => (
            <div key={question} className="about-faq">
              <h4 className="about-faq-q">{question}</h4>
              <p className="about-faq-a">{answerNode ?? answer}</p>
            </div>
          ))}
        </div>

        <h3 className="about-section-title">See something missing?</h3>
        <p className="about-p">
          Wrong info, duplicate listing, new venue in town – reach out. We read
          everything:{' '}
          <a href="mailto:byron@akronpulse.com">byron@akronpulse.com</a> and{' '}
          <a href="mailto:mac@akronpulse.com">mac@akronpulse.com</a>
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
