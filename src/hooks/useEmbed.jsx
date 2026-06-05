import { createContext, useContext } from 'react'

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
const EmbedContext = createContext(null)

export function EmbedProvider({ config, children }) {
  return <EmbedContext.Provider value={config}>{children}</EmbedContext.Provider>
}

/** Returns the embed config, or null on the normal site. */
export function useEmbed() {
  return useContext(EmbedContext)
}
