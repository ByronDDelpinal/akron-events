-- ============================================================
-- Rollback for 076_search_names_tiers_suggest.sql
--
-- Restores search exactly as migration 074 left it: search_events()
-- as a phrase match over an expression index on events, with no venue
-- or organizer names, no acronym handling and no suggestions.
--
-- NOT a migration. Never move this file into supabase/migrations/ --
-- `supabase db push` applies everything there.
--
-- Safe to run with the 076 client deployed: the client treats a missing
-- search_suggest() as "no suggestion".
-- ============================================================

BEGIN;

-- 1. 074's index and helper.
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

CREATE INDEX IF NOT EXISTS events_search_tsv_idx
  ON public.events
  USING gin (public.event_search_tsv(title_normalized, description_normalized));

-- 2. 074's search_events (same signature, so this replaces 076's in place).
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

-- CREATE OR REPLACE keeps 076's per-function settings; clear the one 074 never had.
ALTER FUNCTION public.search_events(text, timestamptz, text, text[]) RESET plan_cache_mode;

COMMENT ON FUNCTION public.search_events(text, timestamptz, text, text[]) IS
  'Public event search: published events starting at/after p_floor whose title, description or tags contain p_term as a phrase of whole words, optionally limited to events with a venue in p_neighborhood / p_cities. SECURITY DEFINER so the full-text index is usable (RLS blocks index use for non-leakproof operators); returns SETOF events so PostgREST can filter, order, embed and count on top.';

REVOKE ALL ON FUNCTION public.search_events(text, timestamptz, text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_events(text, timestamptz, text, text[]) TO anon, authenticated, service_role;

-- 3. Everything 076 added.
DO $cron$
BEGIN
  -- EXECUTE: the cron schema must not be referenced at all where pg_cron
  -- is absent (the local SQL harness).
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    EXECUTE $q$SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'prune-event-search-docs'$q$;
  END IF;
END
$cron$;

DROP TRIGGER IF EXISTS event_search_docs_event_insert       ON public.events;
DROP TRIGGER IF EXISTS event_search_docs_event_update       ON public.events;
DROP TRIGGER IF EXISTS event_search_docs_venue_link         ON public.event_venues;
DROP TRIGGER IF EXISTS event_search_docs_venue_link_update  ON public.event_venues;
DROP TRIGGER IF EXISTS event_search_docs_org_link           ON public.event_organizations;
DROP TRIGGER IF EXISTS event_search_docs_org_link_update    ON public.event_organizations;
DROP TRIGGER IF EXISTS event_search_docs_venue_rename       ON public.venues;
DROP TRIGGER IF EXISTS event_search_docs_org_rename         ON public.organizations;

DROP FUNCTION IF EXISTS public.search_suggest(text, timestamptz);
DROP FUNCTION IF EXISTS public.search_typo_cost(text, text);
DROP FUNCTION IF EXISTS public.search_first_matching_query(text, timestamptz);
DROP FUNCTION IF EXISTS public.search_tier_queries(text);
DROP FUNCTION IF EXISTS public.event_search_docs_on_event();
DROP FUNCTION IF EXISTS public.event_search_docs_on_link();
DROP FUNCTION IF EXISTS public.event_search_docs_on_venue_rename();
DROP FUNCTION IF EXISTS public.event_search_docs_on_org_rename();
DROP FUNCTION IF EXISTS public.refresh_event_search_docs(uuid[]);
DROP TABLE    IF EXISTS public.event_search_docs;
DROP FUNCTION IF EXISTS public.search_name_tsv(text, text);
DROP FUNCTION IF EXISTS public.search_doc_tsv(text, text, text);
DROP FUNCTION IF EXISTS public.search_joined_forms(text);
DROP FUNCTION IF EXISTS public.search_canon(text);
DROP FUNCTION IF EXISTS public.search_canon_text(text);

-- fuzzystrmatch is left installed: it is inert, and another object may
-- have come to depend on it.

ANALYZE public.events;

COMMIT;
