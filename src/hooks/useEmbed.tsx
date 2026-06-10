import { createContext, useContext, type ReactNode } from 'react'
import type { EmbedConfig } from '@/lib/embedConfig'

/**
 * EmbedContext — carries the parsed white-label embed config (see
 * lib/embedConfig) down to every component that needs to behave
 * differently inside the embed: EventsBrowser (feature gating, locked
 * dimensions), EventCard / MapView (click-through target, price/tags
 * visibility), and EventPage (chrome stripping).
 *
 * Value is null outside the embed, so useEmbed() returning null is the
 * canonical "we are on the normal site" signal — every consumer falls
 * back to full-site behavior in that case.
 */
const EmbedContext = createContext<EmbedConfig | null>(null)

export function EmbedProvider({
  config,
  children,
}: {
  config: EmbedConfig | null
  children: ReactNode
}) {
  return <EmbedContext.Provider value={config}>{children}</EmbedContext.Provider>
}

/** Returns the embed config, or null on the normal site. */
// Context module exports its provider + hook together by design; the HMR
// boundary warning doesn't apply meaningfully here.
// eslint-disable-next-line react-refresh/only-export-components
export function useEmbed(): EmbedConfig | null {
  return useContext(EmbedContext)
}
