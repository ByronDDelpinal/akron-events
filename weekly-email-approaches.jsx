import { useState } from "react";

const approaches = [
  {
    id: "A",
    name: "Progressive Wizard",
    tagline: "Start simple, go deep over time",
    philosophy:
      "Optimized for subscriber growth. Get people in the door with just an email address, then progressively reveal the full power of your preference system. Research shows multi-step forms increase conversion by up to 300% vs. single long forms, and reducing initial fields from 4 to 3 boosts completion by 50%.",
    subscriberFlow: [
      {
        step: "1. Quick Signup",
        detail:
          'Homepage footer or dedicated /subscribe page shows a single field: email address + one big question: "What are you into?" with the 5 intent shortcuts as visual cards (Date Night, Free Fun, Give Back, Family Fun, Get Active). User picks 1-3 intents and submits.',
      },
      {
        step: "2. Confirmation Email",
        detail:
          'Double opt-in email with a "Confirm & Customize" button. Clicking confirms subscription AND opens the full preference center.',
      },
      {
        step: "3. Preference Center (Post-Confirm)",
        detail:
          "Full single-page preference center accessible via magic link token. Organized into expandable sections: Intents, Categories, Venues, Price & Age, Delivery Day & Time Window. Smart defaults pre-filled based on their initial intent selection.",
      },
      {
        step: "4. Ongoing Refinement",
        detail:
          'Every weekly email includes a "Refine your picks" link back to the preference center. Preferences evolve over time without friction.',
      },
    ],
    preferenceModel: {
      description:
        "Preferences stored in a single subscribers table with a JSONB preferences column. Intents map to predefined category/price combinations under the hood.",
      fields: [
        "email (unique, indexed)",
        "confirmed (boolean — double opt-in)",
        "token (UUID — for magic link access)",
        "preferences (JSONB):",
        "  → intents: ['date_night', 'free_fun', ...]",
        "  → categories: ['music', 'art', ...]",
        "  → venues: [venue_id, venue_id, ...]",
        "  → price_max: number | null",
        "  → age_restriction: 'all_ages' | '18_plus' | '21_plus' | null",
        "  → send_day: 'monday' | 'tuesday' | ... | 'thursday'",
        "  → event_window_days: 7 | 14",
        "unsubscribed_at (timestamp, nullable)",
      ],
    },
    emailDesign: {
      description:
        "Clean, scannable digest with a hero event + categorized sections.",
      structure: [
        "Hero Event — one standout event matching their top intent, full-width with image",
        "Your [Intent] Picks — 3-4 events per subscribed intent, shown as compact cards",
        "Don't Miss — 1-2 featured events regardless of preferences (community highlights)",
        "Footer — Manage preferences link, unsubscribe, social links",
      ],
      eventCount: "8-15 events total, depending on preference breadth",
    },
    techStack: {
      emailService: "Resend (3,000 emails/mo free, React Email templates, great DX)",
      sending: "Supabase Edge Function triggered by cron (pg_cron or external scheduler)",
      templates: "React Email — write email templates in JSX, same language as your app",
      preferences: "Supabase table with RLS — anon can INSERT, token-holder can UPDATE",
    },
    pros: [
      "Highest signup conversion — minimal friction to start",
      "Intent shortcuts provide instant personalization without overwhelming choices",
      "Progressive disclosure matches UX research best practices",
      "JSONB preferences column is flexible and schema-less — easy to add new preference types later",
      "React Email templates match your existing tech stack",
    ],
    cons: [
      "Initial emails may feel generic until user customizes further",
      "Intent-to-category mapping is an abstraction layer to maintain",
      "Magic link tokens need expiration/rotation logic",
      "JSONB is flexible but harder to query aggregate preference stats",
    ],
    effort: "Medium",
    timeEstimate: "2-3 weeks",
  },
  {
    id: "B",
    name: "Full Control Center",
    tagline: "Every preference, one powerful page",
    philosophy:
      "Optimized for power users and long-term retention. Show subscribers the full depth of personalization upfront. Research from Stack Overflow's email preference redesign found that a well-organized single page outperforms multi-page flows for engaged users. Sections with clear descriptions prevent overwhelm.",
    subscriberFlow: [
      {
        step: "1. Dedicated /subscribe Page",
        detail:
          "A rich, single-page preference center that doubles as the signup form. Organized into clearly labeled sections with horizontal dividers. All options visible but not overwhelming — each section has a header, 1-line description, and smart defaults.",
      },
      {
        step: "2. Section-by-Section Layout",
        detail:
          'Top: Email + Send Day/Time. Then: "I\'m interested in..." (intent cards). Then: Fine-tune Categories (checkboxes). Then: Favorite Venues (searchable multi-select from your 50+ venues). Then: Price & Age preferences. Then: Event Window (next 7 days, 7-14 days, weekend focus + preview).',
      },
      {
        step: "3. Confirmation Email",
        detail:
          "Double opt-in with a summary of their selected preferences. One-click confirm button.",
      },
      {
        step: "4. Preference Management",
        detail:
          "Every email links back to the same /subscribe page, pre-populated via a secure token in the URL. Subscriber can edit anything at any time.",
      },
    ],
    preferenceModel: {
      description:
        "Normalized relational model with dedicated tables for subscriber preferences. More structured, easier to query and analyze at scale.",
      fields: [
        "subscribers table: id, email, confirmed, token, send_day, event_window, price_max, age_restriction, unsubscribed_at, created_at",
        "subscriber_intents table: subscriber_id → intent_key (junction)",
        "subscriber_categories table: subscriber_id → category (junction)",
        "subscriber_venues table: subscriber_id → venue_id (junction, FK to venues)",
        "Indexes on all junction tables for fast preference lookups",
        "RLS policies: anon INSERT on subscribers, token-authenticated UPDATE/SELECT",
      ],
    },
    emailDesign: {
      description:
        "Highly personalized, section-rich digest that mirrors the preference categories.",
      structure: [
        "Personalized Subject Line — 'Your Week in Akron: 3 concerts, 2 art shows & more'",
        "Hero Section — Top featured event from their preferred venues/categories",
        "By Category — Collapsible sections for each subscribed category with 2-4 events each",
        "Your Venues — Dedicated section for events at followed venues",
        "Weekend Spotlight vs. Next Week Preview — Structured by their chosen event window",
        "Community Picks — 1-2 editor's choice events outside their preferences",
        "Footer — Manage preferences, unsubscribe, share with a friend link",
      ],
      eventCount: "10-20 events, organized by preference groupings",
    },
    techStack: {
      emailService: "Resend (free tier) or Brevo (300/day free, more transactional features)",
      sending: "Supabase Edge Function with pg_cron — groups subscribers by send_day",
      templates: "React Email with dynamic section rendering based on preference joins",
      preferences: "Normalized Supabase tables with junction tables — matches your existing data model pattern",
    },
    pros: [
      "Maximum personalization depth from day one",
      "Normalized data model makes it easy to answer 'how many subscribers follow venue X?' or 'what's the most popular category?'",
      "Matches your existing junction table pattern (event_venues, event_organizations)",
      "Venue-following creates a natural bridge to future org/venue host accounts",
      "Email content can be extremely targeted per subscriber",
    ],
    cons: [
      "Higher initial signup friction — more fields may reduce conversion rate",
      "More complex database schema (4+ new tables)",
      "More complex email generation logic — joins across multiple tables per subscriber",
      "Longer build time due to relational complexity",
      "Risk of overwhelming less tech-savvy users with too many options upfront",
    ],
    effort: "High",
    timeEstimate: "3-4 weeks",
  },
  {
    id: "C",
    name: "Follow & Subscribe",
    tagline: "Social-inspired, action-driven personalization",
    philosophy:
      "Optimized for engagement and intuitiveness. Instead of a separate preference form, embed 'Follow' buttons directly into the browsing experience — on venues, categories, and intent cards. Subscribers build their email preferences organically by interacting with the app they're already using. Inspired by how Eventbrite, Meetup, and Spotify handle preference building through actions rather than forms.",
    subscriberFlow: [
      {
        step: '1. "Follow" Buttons Everywhere',
        detail:
          "Add subtle Follow/Subscribe buttons to venue cards, category headers, and intent shortcut cards throughout the existing UI. First click prompts for email (stored in localStorage after). Subsequent follows are instant.",
      },
      {
        step: "2. Floating Subscription Bar",
        detail:
          'A persistent but unobtrusive bar at the bottom of the page: "Get a weekly email with events you follow" — shows count of followed items. Clicking opens a lightweight modal to set email + delivery day.',
      },
      {
        step: "3. /my-events Preference Hub",
        detail:
          'A dedicated page showing everything the subscriber follows, organized visually: "Your Venues" (cards), "Your Interests" (intent/category chips), delivery settings. Can add/remove follows here too.',
      },
      {
        step: "4. Confirmation & Magic Link",
        detail:
          "Double opt-in email. Future preference edits accessible via magic link to /my-events, or by re-entering their email in the floating bar (sends a fresh magic link).",
      },
    ],
    preferenceModel: {
      description:
        "A follows-based model where each follow is a discrete record. Simple, event-sourced, and naturally extensible.",
      fields: [
        "subscribers table: id, email, confirmed, token, send_day, event_window, price_max, age_restriction, unsubscribed_at",
        "subscriber_follows table:",
        "  → subscriber_id (FK)",
        "  → follow_type ENUM: 'intent', 'category', 'venue'",
        "  → follow_value: text (intent key, category name, or venue UUID)",
        "  → created_at (timestamp — track when follows were added)",
        "Compound index on (subscriber_id, follow_type, follow_value)",
        "RLS: anon INSERT on subscribers, token-auth for follows CRUD",
      ],
    },
    emailDesign: {
      description:
        "Activity-feed style digest organized around what you follow, with discovery sprinkled in.",
      structure: [
        "Subject Line — 'This week at [top venue] + 12 more events you'll love'",
        "What's Happening at Your Venues — Events grouped by followed venue, 2-3 each",
        "Your Interests — Events matching followed intents/categories not already shown",
        "Discover Something New — 2-3 events outside follows to encourage exploration",
        "Quick Follow — 'You might also like [Venue X]' CTA based on overlap with similar subscribers",
        "Footer — Manage follows link, unsubscribe, 'Forward to a friend'",
      ],
      eventCount: "8-15 events, weighted toward followed venues",
    },
    techStack: {
      emailService: "Resend (free tier, React Email)",
      sending: "Supabase Edge Function + cron, grouped by send_day",
      templates: "React Email with dynamic sections based on follow_type groupings",
      preferences: "Supabase tables — 2 new tables (subscribers + subscriber_follows), simple polymorphic follow model",
    },
    pros: [
      "Most intuitive UX — users build preferences through natural browsing behavior",
      "Lowest cognitive load — no long form to fill out, just click Follow on things you like",
      "Follow data doubles as engagement analytics — see which venues/categories are most popular",
      "Polymorphic follows table is simple to extend (add 'organization' follow_type later)",
      "Natural path to future features: 'Follow this org' for host accounts, event recommendations",
      "The /my-events page becomes a personalized dashboard — value beyond just email",
    ],
    cons: [
      "Requires UI changes across multiple existing pages (venue cards, category headers, etc.)",
      "localStorage dependency for remembering email before confirmation is fragile across devices",
      "Less immediately obvious that a weekly email exists — users need to discover Follow buttons",
      "Harder to set granular price/age preferences without a dedicated form section",
      "Email signup is a side effect of following, which may confuse some users",
    ],
    effort: "Medium-High",
    timeEstimate: "3-4 weeks",
  },
];

const effortColors = {
  Medium: { bg: "#FEF3C7", text: "#92400E", border: "#F59E0B" },
  High: { bg: "#FEE2E2", text: "#991B1B", border: "#EF4444" },
  "Medium-High": { bg: "#FFF7ED", text: "#9A3412", border: "#F97316" },
};

export default function WeeklyEmailApproaches() {
  const [selected, setSelected] = useState(null);
  const [expandedSections, setExpandedSections] = useState({});

  const toggleSection = (approachId, section) => {
    const key = `${approachId}-${section}`;
    setExpandedSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const isExpanded = (approachId, section) =>
    expandedSections[`${approachId}-${section}`] ?? false;

  return (
    <div
      style={{
        fontFamily: "'DM Sans', system-ui, -apple-system, sans-serif",
        maxWidth: 1100,
        margin: "0 auto",
        padding: "32px 20px",
        background: "#FAFAF9",
        minHeight: "100vh",
      }}
    >
      {/* Header */}
      <div style={{ marginBottom: 40 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "#78716C",
            marginBottom: 8,
          }}
        >
          The 330 · Weekly Email Feature
        </div>
        <h1
          style={{
            fontSize: 32,
            fontWeight: 700,
            color: "#1C1917",
            margin: "0 0 12px 0",
            fontFamily: "'Space Grotesk', system-ui, sans-serif",
          }}
        >
          Three Approaches for Weekly Email Digests
        </h1>
        <p
          style={{
            fontSize: 16,
            color: "#57534E",
            margin: 0,
            lineHeight: 1.6,
            maxWidth: 720,
          }}
        >
          Each approach offers a different philosophy for how subscribers
          discover, configure, and receive personalized event emails. All three
          support the full depth of your data model — categories, venues,
          intents, pricing, age restrictions, and subscriber-chosen delivery
          schedules.
        </p>
      </div>

      {/* Quick Comparison */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 16,
          marginBottom: 40,
        }}
      >
        {approaches.map((a) => (
          <button
            key={a.id}
            onClick={() => setSelected(selected === a.id ? null : a.id)}
            style={{
              background: selected === a.id ? "#1C1917" : "#FFFFFF",
              color: selected === a.id ? "#FFFFFF" : "#1C1917",
              border:
                selected === a.id
                  ? "2px solid #1C1917"
                  : "2px solid #E7E5E4",
              borderRadius: 12,
              padding: "20px 16px",
              cursor: "pointer",
              textAlign: "left",
              transition: "all 0.2s ease",
            }}
          >
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                opacity: 0.5,
                marginBottom: 4,
              }}
            >
              Option {a.id}
            </div>
            <div
              style={{
                fontSize: 20,
                fontWeight: 700,
                marginBottom: 4,
                fontFamily: "'Space Grotesk', system-ui, sans-serif",
              }}
            >
              {a.name}
            </div>
            <div style={{ fontSize: 14, opacity: 0.7 }}>{a.tagline}</div>
            <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  padding: "3px 8px",
                  borderRadius: 6,
                  background:
                    selected === a.id
                      ? "rgba(255,255,255,0.15)"
                      : effortColors[a.effort].bg,
                  color:
                    selected === a.id ? "#FFF" : effortColors[a.effort].text,
                }}
              >
                {a.effort} effort
              </span>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  padding: "3px 8px",
                  borderRadius: 6,
                  background:
                    selected === a.id
                      ? "rgba(255,255,255,0.15)"
                      : "#EDE9FE",
                  color: selected === a.id ? "#FFF" : "#5B21B6",
                }}
              >
                {a.timeEstimate}
              </span>
            </div>
          </button>
        ))}
      </div>

      {/* Detailed Cards */}
      {approaches.map((a) => {
        const show = selected === null || selected === a.id;
        if (!show) return null;

        return (
          <div
            key={a.id}
            style={{
              background: "#FFFFFF",
              border: "1px solid #E7E5E4",
              borderRadius: 16,
              marginBottom: 24,
              overflow: "hidden",
            }}
          >
            {/* Card Header */}
            <div
              style={{
                padding: "24px 28px",
                borderBottom: "1px solid #F5F5F4",
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
                <span
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: "#A8A29E",
                  }}
                >
                  {a.id}
                </span>
                <h2
                  style={{
                    fontSize: 24,
                    fontWeight: 700,
                    margin: 0,
                    color: "#1C1917",
                    fontFamily: "'Space Grotesk', system-ui, sans-serif",
                  }}
                >
                  {a.name}
                </h2>
              </div>
              <p
                style={{
                  fontSize: 15,
                  color: "#57534E",
                  margin: "8px 0 0 0",
                  lineHeight: 1.6,
                }}
              >
                {a.philosophy}
              </p>
            </div>

            {/* Subscriber Flow */}
            <SectionToggle
              label="Subscriber Flow"
              isOpen={isExpanded(a.id, "flow")}
              onToggle={() => toggleSection(a.id, "flow")}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {a.subscriberFlow.map((s, i) => (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      gap: 14,
                      alignItems: "flex-start",
                    }}
                  >
                    <div
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: "50%",
                        background: "#F5F5F4",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 13,
                        fontWeight: 700,
                        color: "#78716C",
                        flexShrink: 0,
                        marginTop: 2,
                      }}
                    >
                      {i + 1}
                    </div>
                    <div>
                      <div
                        style={{
                          fontSize: 14,
                          fontWeight: 600,
                          color: "#1C1917",
                          marginBottom: 4,
                        }}
                      >
                        {s.step.replace(/^\d+\.\s*/, "")}
                      </div>
                      <div
                        style={{
                          fontSize: 14,
                          color: "#57534E",
                          lineHeight: 1.6,
                        }}
                      >
                        {s.detail}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </SectionToggle>

            {/* Data Model */}
            <SectionToggle
              label="Data Model"
              isOpen={isExpanded(a.id, "data")}
              onToggle={() => toggleSection(a.id, "data")}
            >
              <p
                style={{
                  fontSize: 14,
                  color: "#57534E",
                  margin: "0 0 12px 0",
                  lineHeight: 1.6,
                }}
              >
                {a.preferenceModel.description}
              </p>
              <div
                style={{
                  background: "#1C1917",
                  borderRadius: 8,
                  padding: "16px 20px",
                  fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                  fontSize: 13,
                  color: "#D6D3D1",
                  lineHeight: 1.7,
                  overflowX: "auto",
                }}
              >
                {a.preferenceModel.fields.map((f, i) => (
                  <div key={i} style={{ color: f.startsWith("  ") ? "#A8A29E" : "#D6D3D1" }}>
                    {f}
                  </div>
                ))}
              </div>
            </SectionToggle>

            {/* Email Design */}
            <SectionToggle
              label="Email Design"
              isOpen={isExpanded(a.id, "email")}
              onToggle={() => toggleSection(a.id, "email")}
            >
              <p
                style={{
                  fontSize: 14,
                  color: "#57534E",
                  margin: "0 0 12px 0",
                  lineHeight: 1.6,
                }}
              >
                {a.emailDesign.description}
              </p>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                {a.emailDesign.structure.map((s, i) => {
                  const [title, ...rest] = s.split(" — ");
                  return (
                    <div
                      key={i}
                      style={{
                        display: "flex",
                        gap: 10,
                        fontSize: 14,
                        lineHeight: 1.5,
                      }}
                    >
                      <span
                        style={{
                          color: "#78716C",
                          flexShrink: 0,
                          fontWeight: 600,
                        }}
                      >
                        {title}
                      </span>
                      {rest.length > 0 && (
                        <span style={{ color: "#57534E" }}>
                          — {rest.join(" — ")}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
              <div
                style={{
                  marginTop: 12,
                  fontSize: 13,
                  color: "#78716C",
                  fontStyle: "italic",
                }}
              >
                {a.emailDesign.eventCount}
              </div>
            </SectionToggle>

            {/* Tech Stack */}
            <SectionToggle
              label="Technical Stack"
              isOpen={isExpanded(a.id, "tech")}
              onToggle={() => toggleSection(a.id, "tech")}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(2, 1fr)",
                  gap: 12,
                }}
              >
                {Object.entries(a.techStack).map(([key, val]) => (
                  <div
                    key={key}
                    style={{
                      background: "#FAFAF9",
                      borderRadius: 8,
                      padding: "12px 14px",
                    }}
                  >
                    <div
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        textTransform: "uppercase",
                        letterSpacing: "0.06em",
                        color: "#A8A29E",
                        marginBottom: 4,
                      }}
                    >
                      {key.replace(/([A-Z])/g, " $1").trim()}
                    </div>
                    <div
                      style={{ fontSize: 14, color: "#44403C", lineHeight: 1.5 }}
                    >
                      {val}
                    </div>
                  </div>
                ))}
              </div>
            </SectionToggle>

            {/* Pros & Cons */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                borderTop: "1px solid #F5F5F4",
              }}
            >
              <div style={{ padding: "20px 28px", borderRight: "1px solid #F5F5F4" }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: "#16A34A",
                    marginBottom: 10,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  Strengths
                </div>
                {a.pros.map((p, i) => (
                  <div
                    key={i}
                    style={{
                      fontSize: 14,
                      color: "#44403C",
                      lineHeight: 1.5,
                      marginBottom: 8,
                      paddingLeft: 16,
                      position: "relative",
                    }}
                  >
                    <span
                      style={{
                        position: "absolute",
                        left: 0,
                        color: "#16A34A",
                        fontWeight: 700,
                      }}
                    >
                      +
                    </span>
                    {p}
                  </div>
                ))}
              </div>
              <div style={{ padding: "20px 28px" }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: "#DC2626",
                    marginBottom: 10,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  Trade-offs
                </div>
                {a.cons.map((c, i) => (
                  <div
                    key={i}
                    style={{
                      fontSize: 14,
                      color: "#44403C",
                      lineHeight: 1.5,
                      marginBottom: 8,
                      paddingLeft: 16,
                      position: "relative",
                    }}
                  >
                    <span
                      style={{
                        position: "absolute",
                        left: 0,
                        color: "#DC2626",
                        fontWeight: 700,
                      }}
                    >
                      -
                    </span>
                    {c}
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })}

      {/* Shared Foundations */}
      <div
        style={{
          background: "#F5F5F4",
          borderRadius: 16,
          padding: "24px 28px",
          marginTop: 16,
        }}
      >
        <h3
          style={{
            fontSize: 18,
            fontWeight: 700,
            margin: "0 0 12px 0",
            color: "#1C1917",
            fontFamily: "'Space Grotesk', system-ui, sans-serif",
          }}
        >
          Shared Across All Approaches
        </h3>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, 1fr)",
            gap: 16,
            fontSize: 14,
            color: "#44403C",
            lineHeight: 1.6,
          }}
        >
          <div>
            <strong style={{ color: "#1C1917" }}>Double opt-in</strong> — required for
            deliverability and CAN-SPAM compliance. Confirmation email before any
            digests are sent.
          </div>
          <div>
            <strong style={{ color: "#1C1917" }}>Magic link tokens</strong> — secure,
            expiring tokens for preference management without requiring passwords
            or accounts.
          </div>
          <div>
            <strong style={{ color: "#1C1917" }}>Subscriber-chosen send day</strong> —
            each subscriber picks their preferred delivery day (research
            recommends Tue-Thu as defaults).
          </div>
          <div>
            <strong style={{ color: "#1C1917" }}>One-click unsubscribe</strong> —
            prominent in footer, no friction. With a "reduce frequency" option
            offered before full unsubscribe.
          </div>
          <div>
            <strong style={{ color: "#1C1917" }}>Resend free tier</strong> — 3,000
            emails/month, React Email templates, excellent developer experience.
            Scales to paid if needed.
          </div>
          <div>
            <strong style={{ color: "#1C1917" }}>Future-proofed for host accounts</strong>{" "}
            — subscriber table design leaves room for linking to future
            org/venue/event host accounts.
          </div>
        </div>
      </div>

      {/* My Recommendation */}
      <div
        style={{
          background: "#1C1917",
          borderRadius: 16,
          padding: "24px 28px",
          marginTop: 24,
          color: "#FFFFFF",
        }}
      >
        <h3
          style={{
            fontSize: 18,
            fontWeight: 700,
            margin: "0 0 8px 0",
            fontFamily: "'Space Grotesk', system-ui, sans-serif",
          }}
        >
          My Recommendation
        </h3>
        <p style={{ fontSize: 15, lineHeight: 1.7, margin: 0, color: "#D6D3D1" }}>
          <strong style={{ color: "#FFF" }}>Approach A (Progressive Wizard)</strong> gives
          you the best balance of subscriber growth and personalization depth. It
          matches UX research on form completion, gets people signed up fast, and
          still opens the door to full granularity for those who want it. The JSONB
          preference model is simple to build and flexible to extend. If you find
          that power users want more upfront control later, you can evolve toward
          B's single-page layout — the underlying data model supports both UIs.
          {" "}
          <strong style={{ color: "#FFF" }}>Approach C</strong> is the most innovative
          and would create the most engaging experience long-term, but it requires
          more frontend changes to your existing pages and has a higher risk of
          users not discovering the email feature organically.
        </p>
      </div>
    </div>
  );
}

function SectionToggle({ label, isOpen, onToggle, children }) {
  return (
    <div style={{ borderTop: "1px solid #F5F5F4" }}>
      <button
        onClick={onToggle}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "16px 28px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          fontSize: 15,
          fontWeight: 600,
          color: "#1C1917",
        }}
      >
        {label}
        <span
          style={{
            fontSize: 18,
            color: "#A8A29E",
            transform: isOpen ? "rotate(180deg)" : "rotate(0)",
            transition: "transform 0.2s",
          }}
        >
          ▾
        </span>
      </button>
      {isOpen && (
        <div style={{ padding: "0 28px 20px 28px" }}>{children}</div>
      )}
    </div>
  );
}
