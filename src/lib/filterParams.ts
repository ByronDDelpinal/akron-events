/**
 * filterParams.ts — the filter-owned query key list, and nothing else.
 *
 * Split out of useEventFilters.ts so DOM-free, React-free modules can read it.
 * lib/categoryHref.ts is unit-tested under `node --test` (which imports the .ts
 * file directly via type stripping), so it can neither import a React hook nor
 * resolve the `@/` alias — hence ZERO imports here, same rule as eventHref.ts.
 * useEventFilters.ts re-exports FILTER_PARAM_KEYS so its export surface is
 * unchanged for every existing importer.
 */

// All filter-owned query keys. clearFilters only ever touches these, so
// non-filter params (embed theme/features/target/view/density) survive a
// "Clear filters" untouched. `tod` (time of day) was added alongside the
// "When" section — omitting it here would leave a stale bucket filter behind
// after "Clear filters".
export const FILTER_PARAM_KEYS = ['intent', 'date', 'from', 'to', 'categories', 'exclude', 'price', 'sort', 'q', 'audience', 'tod']
