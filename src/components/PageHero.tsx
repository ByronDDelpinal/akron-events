import type { ReactNode } from 'react'
import './PageHero.css'

interface PageHeroProps {
  /** Small uppercase kicker above the title (optional). */
  eyebrow?: ReactNode
  /** The h1. May include a <span> to highlight part of it. */
  title: ReactNode
  /** Subtitle / description (optional). May include links. */
  children?: ReactNode
}

/**
 * PageHero — the one standardized page header.
 *
 * A full-bleed dark band with a centered eyebrow / title / subtitle, used by
 * every content page (Organizers, Embed Builder, Venues, About, Organizations,
 * Technical) so headers sit in the same place with the same treatment instead
 * of each page rolling its own slightly-different hero.
 */
export default function PageHero({ eyebrow, title, children }: PageHeroProps) {
  return (
    <header className="page-hero">
      <div className="page-hero-inner">
        {eyebrow && <p className="page-hero-eyebrow">{eyebrow}</p>}
        <h1 className="page-hero-title">{title}</h1>
        {children && <p className="page-hero-sub">{children}</p>}
      </div>
    </header>
  )
}
