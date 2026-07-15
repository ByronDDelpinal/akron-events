/**
 * Stable per-history-entry identity for the sessionStorage state we hang off a
 * navigation: scroll position (App.tsx) and list depth (useRestorablePagination).
 *
 * `location.key` alone is not enough. React Router assigns the literal key
 * "default" to whatever entry the app boots on, so every full page load in a
 * tab produces the SAME key on a potentially different URL — a hard navigation
 * to /events/downtown after one to / would inherit the homepage's saved scroll
 * and depth. Pathname disambiguates that collision.
 *
 * Search is deliberately excluded: in-page filter changes navigate with
 * `replace`, which mints a fresh key anyway, so folding search in would only
 * fragment the key without buying anything.
 */
export function historyEntryKey({ key, pathname }: { key: string; pathname: string }): string {
  return `${key}:${pathname}`
}
