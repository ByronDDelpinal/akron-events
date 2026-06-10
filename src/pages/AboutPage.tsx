import { useState, useRef, useEffect, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { SEO, buildGraph, faqPageSchema, breadcrumbSchema } from '@/lib/seo'
import { INTENTS } from '@/lib/intents'
import { DATA_SOURCES } from '@/pages/TechnicalPage'
import './AboutPage.css'

const GITHUB_URL = 'https://github.com/byronddelpinal/akron-events'

interface Faq {
  question: string
  answer: string
  answerNode?: ReactNode
}

// FAQ content pulled into structured data. Keep answers under ~300 chars so
// they read well as LLM citations.
const FAQS: Faq[] = [
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
      'Anyone can submit an event through the Submit page, or simply email it to intake@akronpulse.com and it will be processed and live within 24 hours. Submissions are reviewed before being published. We also aggregate events from venue websites and partner organizations – so please check to make sure yours isn\'t already listed.',
    answerNode: (
      <>
        Anyone can submit an event through the{' '}
        <Link to="/submit">Submit page</Link>, or simply email it to{' '}
        <a href="mailto:intake@akronpulse.com">intake@akronpulse.com</a> and it
        will be processed and live within 24 hours. Submissions are reviewed
        before being published. We also aggregate events from venue websites and
        partner organizations – so please check to make sure yours isn&apos;t
        already listed.
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

// Discovery "vibes" derived from the canonical intent registry so they never
// drift from the homepage Filter & Sort presets.
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

        <div className="about-mission">
          <div className="about-mission-block">
            <p className="about-mission-label">Our Mission</p>
            <p className="about-mission-text">
              Every event in Summit County, in one place, free forever and
              available to all, so nobody finds out about the good stuff after
              it happened.
            </p>
          </div>
          <div className="about-mission-block">
            <p className="about-mission-label">Our Vision</p>
            <p className="about-mission-text">
              A city where showing up is easy: fuller venues, louder blocks,
              neighbors who actually know each other.
            </p>
          </div>
        </div>

        <div className="about-divider" />

        <p className="about-p">
          Akron Pulse will make sure you learn about an event a week early, not a day late.
          We pull data from local websites, venue calendars, ticketing platforms, community
          mailers, and user submissions – updated daily, no duplicates, no noise – to give
          you the most comprehensive and reliable events calendar in Summit County. The best
          part – you can tailor it to the cadence that works best for you. Check it out!
        </p>

        <div className="about-divider" />

        <h2 className="about-section-title">Find Your Reason to Go Out</h2>
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
            <h3 className="about-submit-banner__title">Have an Event to Share?</h3>
            <p className="about-submit-banner__desc">
              If you're an organizer, venue, or community member with something
              happening in Akron, we'd love to feature it. Submit a form, email
              it in, or put our whole calendar on your website.
            </p>
          </div>
          <Link to="/organizers" className="about-submit-banner__btn">See all the ways →</Link>
        </div>

        <div className="about-divider" />

        <h2 className="about-section-title">Frequently Asked</h2>
        <div className="about-faqs">
          {FAQS.map(({ question, answer, answerNode }) => (
            <div key={question} className="about-faq">
              <h4 className="about-faq-q">{question}</h4>
              <p className="about-faq-a">{answerNode ?? answer}</p>
            </div>
          ))}
        </div>

        <h3 className="about-section-title">See Something Missing?</h3>
        <p className="about-p">
          Wrong info, duplicate listing, new venue in town – reach out. We read
          everything:{' '}
          <a href="mailto:byron@akronpulse.com">byron@akronpulse.com</a> and{' '}
          <a href="mailto:mac@akronpulse.com">mac@akronpulse.com</a>
        </p>

        <div className="about-divider" />

        <TransparencySection />
      </div>
    </>
  )
}

// ── Transparency / open-source section ───────────────────────────────────────
function TransparencySection() {
  const [query, setQuery]     = useState('')
  const [open,  setOpen]      = useState(false)
  const wrapRef               = useRef<HTMLDivElement>(null)

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const q = query.trim().toLowerCase()
  const results = q.length < 2 ? [] : DATA_SOURCES.filter((s) =>
    s.label.toLowerCase().includes(q) ||
    s.methodDetail.toLowerCase().includes(q) ||
    s.venue.toLowerCase().includes(q)
  )

  return (
    <>
      <h2 className="about-section-title">Technical Transparency</h2>

      <h3 className="about-section-title">Built in the Open</h3>
      <p className="about-p">
        Akron Pulse is fully open source — every scraper, data pipeline, and line
        of this frontend is public on GitHub. No black boxes, no hidden logic.
      </p>
      <p className="about-p">
        Live somewhere else? The whole stack is designed to be forked. Swap the
        data sources, point it at your city's venues and parks departments, and
        you've got a community events calendar for Cleveland, Columbus, Pittsburgh,
        or wherever you call home.
      </p>

      <a
        href={GITHUB_URL}
        className="about-oss-btn"
        target="_blank"
        rel="noopener noreferrer"
      >
        <GitHubIcon /> View on GitHub →
      </a>

      <div className="about-divider" />

      <h3 className="about-section-title">What We&rsquo;re Watching</h3>
      <p className="about-p" style={{ marginBottom: 'var(--space-lg)' }}>
        We pull from {DATA_SOURCES.length} sources — venues, parks departments,
        university calendars, city feeds, and more. Search by name or URL
        fragment to find a specific one.
      </p>

      <div className="about-source-search-wrap" ref={wrapRef}>
        <input
          className="about-source-search"
          type="search"
          placeholder={'e.g. “Akron Zoo” or “tribe/events”'}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
          onFocus={() => { if (query.trim().length >= 2) setOpen(true) }}
          aria-label="Search data sources"
          aria-autocomplete="list"
          aria-expanded={open && results.length > 0}
        />

        {open && results.length > 0 && (
          <ul className="about-source-results" role="listbox">
            {results.map((s) => (
              <li key={s.key} className="about-source-result" role="option">
                <span className="about-source-result__label">{s.label}</span>
                <span className="about-source-result__meta">{s.method} · {s.venue}</span>
              </li>
            ))}
          </ul>
        )}

        {open && q.length >= 2 && results.length === 0 && (
          <ul className="about-source-results" role="listbox">
            <li className="about-source-result about-source-result--empty">No sources matched "{query}"</li>
          </ul>
        )}
      </div>

      <p className="about-transparency-note">
        Want to go deeper?{' '}
        <Link to="/technical">The Technical Details page</Link>{' '}
        shows live event counts, scraper health, and exactly how each source is ingested.
      </p>
    </>
  )
}

function GitHubIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2z"/>
    </svg>
  )
}
