-- ============================================================
-- Index-backed event search: search_events() over a full-text index
--
-- Problem (2026-11-12): a public search for "the local honeys" returned
-- "Couldn't load events" -- PostgREST 500, Postgres 57014 (anon's 3s
-- statement_timeout). The search was a word-boundary regex on
-- title_normalized / description_normalized, filtered straight on the
-- events table. Under RLS that can never use an index: `~` is not
-- leakproof, so the planner must apply the policy qual first and then
-- run the regex over EVERY upcoming published row (~4,800), detoasting
-- each description -- ~4,000+ buffers per search no matter how rare the
-- term. Warm that is ~40ms; when those pages have gone cold on this
-- small instance it is 1-3s, and the request times out. The trigram
-- indexes from migration 024 are unusable from the anon/authenticated
-- roles for the same reason.
--
-- Fix: search through a SECURITY DEFINER function that is index-driven.
--   * event_search_tsv()  -- the one definition of "searchable words":
--     the normalized title + description (tags are already folded into
--     description_normalized by the 031/072 trigger) with every run of
--     non-alphanumerics collapsed to a space, parsed with the 'simple'
--     config (no stemming, no stop words).
--   * a GIN expression index on it (no new column, so `select *` and
--     the generated types are untouched).
--   * search_events(term, floor, neighborhood, cities) -- phrase match
--     against that index.
--
-- Semantics are the old ones, minus punctuation sensitivity: the term
-- must appear as a run of whole, adjacent words. "improv" still does not
-- match "improve". Checked against prod for 26 real terms: every row the
-- regex found is still found; the only differences are additions where
-- punctuation used to block a match ("live music" now finds the
-- `live-music` tag; a quoted "the local honeys" now matches).
--
-- Security: the function bypasses RLS, so it hard-codes the same rule as
-- the "Public can read published events" policy (status = 'published').
-- anon already holds SELECT on every events column, so this exposes
-- nothing the table does not. If a column is ever hidden from anon,
-- this function must stop returning it.
-- ============================================================

CREATE OR REPLACE FUNCTION public.event_search_tsv(
  p_title_normalized text,
  p_description_normalized text
)
RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT to_tsvector(
    'pg_catalog.simple'::regconfig,
    regexp_replace(
      coalesce(p_title_normalized, '') || ' ' || coalesce(p_description_normalized, ''),
      '[^[:alnum:]]+', ' ', 'g'
    )
  );
$$;

COMMENT ON FUNCTION public.event_search_tsv(text, text) IS
  'Searchable words for an event (normalized title + description/tags, punctuation collapsed). Indexed by events_search_tsv_idx; search_events() must call it with the same arguments.';

CREATE INDEX IF NOT EXISTS events_search_tsv_idx
  ON public.events
  USING gin (public.event_search_tsv(title_normalized, description_normalized));

-- p_floor is the caller's start_at floor ("now", pinned per result set by
-- the client). Applying it here keeps past events out of the function's
-- result instead of materializing them for the outer query to discard.
--
-- p_neighborhood / p_cities are the venue scope (hub pages, the city
-- picker). On the table these are PostgREST embedded-resource filters
-- (event_venues.venues.city=in.(...)); PostgREST rejects embedded filters
-- on an RPC result ("column pgrst_call.city does not exist"), so the
-- scope is applied here instead. Same rule as the inner join it replaces:
-- the event needs at least one venue matching every scope given.
-- venues / event_venues are world-readable, so nothing is bypassed.
DROP FUNCTION IF EXISTS public.search_events(text, timestamptz);

CREATE OR REPLACE FUNCTION public.search_events(
  p_term text,
  p_floor timestamptz DEFAULT now(),
  p_neighborhood text DEFAULT NULL,
  p_cities text[] DEFAULT NULL
)
RETURNS SETOF public.events
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.*
  FROM events e
  WHERE e.status = 'published'
    AND e.start_at >= p_floor
    AND event_search_tsv(e.title_normalized, e.description_normalized)
        @@ phraseto_tsquery(
             'pg_catalog.simple'::regconfig,
             regexp_replace(search_normalize(p_term), '[^[:alnum:]]+', ' ', 'g')
           )
    AND (
      (p_neighborhood IS NULL AND p_cities IS NULL)
      OR EXISTS (
        SELECT 1
        FROM event_venues ev
        JOIN venues v ON v.id = ev.venue_id
        WHERE ev.event_id = e.id
          AND (p_neighborhood IS NULL OR v.neighborhood_slug = p_neighborhood)
          AND (p_cities IS NULL OR v.city = ANY (p_cities))
      )
    );
$$;

COMMENT ON FUNCTION public.search_events(text, timestamptz, text, text[]) IS
  'Public event search: published events starting at/after p_floor whose title, description or tags contain p_term as a phrase of whole words, optionally limited to events with a venue in p_neighborhood / p_cities. SECURITY DEFINER so the full-text index is usable (RLS blocks index use for non-leakproof operators); returns SETOF events so PostgREST can filter, order, embed and count on top.';

REVOKE ALL ON FUNCTION public.search_events(text, timestamptz, text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_events(text, timestamptz, text, text[]) TO anon, authenticated, service_role;

-- Give the planner statistics for the new expression index.
ANALYZE public.events;
