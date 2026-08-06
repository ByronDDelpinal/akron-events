-- 049_moderation_evasion_scoped_runs.sql
--
-- Fix a letter-spacing evasion false-positive in moderation_severity().
--
-- Bug: the evasion pass condensed the ENTIRE input (stripping every separator)
-- whenever the text looked spaced-out ANYWHERE, then substring-matched slur
-- terms against that whole condensed string. So an innocent multi-word phrase
-- collapsed into a slur substring — e.g. "Mustard Seed" → "mustardseed" contains
-- the slur "tards" — and any event/venue/submission mentioning "Mustard Seed"
-- (a real Akron market/venue) got held for review the moment any spaced pattern
-- (an "R.S.V.P.", a URL, initials) appeared elsewhere in the text.
--
-- Fix (mirrors scripts/lib/content-moderation.js, whose JS matcher was corrected
-- and unit-tested in the same change): condense and scan ONLY the actual
-- spaced-out run(s), never the whole string. "n i g g e r" is still caught (it
-- IS a spaced run); "Mustard Seed" is not a spaced run, so it is never condensed.
--
-- Scope: the moderation triggers only fire for the 'anon' role (public event/
-- venue/submission forms), so this affects public submissions only — the scraper
-- ingest path screens in JS (already fixed). No table/trigger/RLS changes here;
-- this only redefines the matching function.

create or replace function moderation_severity(input text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  base   text;
  leet   text;
  base_c text;
  leet_c text;
  runs   text[];
  run    text;
  condensed_run text;
  rec    record;
  rx     text;
  best   text := null;
  best_rank int := 0;
  this_rank int;
begin
  if input is null or btrim(input) = '' then
    return null;
  end if;

  -- Normalization variants (mirror scripts/lib/content-moderation.js):
  --   base   : lowercase + de-accent + single-spaced
  --   leet   : base with leetspeak folded to letters
  --   *_c    : runs of 3+ identical chars collapsed (catches "fuuuuck")
  base   := regexp_replace(lower(unaccent(input)), '\s+', ' ', 'g');
  leet   := translate(base, '013457@$!', 'oieastasi');
  base_c := regexp_replace(base, '(.)\1{2,}', '\1', 'g');
  leet_c := regexp_replace(leet, '(.)\1{2,}', '\1', 'g');

  -- Extract the spaced-out RUNS only (e.g. "f a g g o t", "r.s.v.p"). Each run is
  -- condensed and scanned on its own below — the whole string is NEVER condensed,
  -- so "Mustard Seed" can't collapse into a slur substring.
  runs := array(
    select m[1]
    from regexp_matches(leet, '((?:[a-z0-9][^a-z0-9]){2,}[a-z0-9])', 'g') as m
  );

  for rec in select term, severity, kind from moderation_terms loop
    -- Word-boundary regex; non-alphanumerics in the term match any separator run
    -- so "blow job" also catches "blowjob"/"blow-job" and "neo-nazi" catches "neo nazi".
    rx := '\m' || regexp_replace(rec.term, '[^a-z0-9]+', '[^a-z0-9]*', 'g') || '\M';

    if base ~ rx or base_c ~ rx or leet ~ rx or leet_c ~ rx then
      -- Allowlist: skip if the term only appears inside an allowed phrase
      -- (e.g. "negro" within "negro leagues", "cracker" within "cracker barrel").
      if not exists (
        select 1
        from moderation_allowlist a
        where strpos(base, regexp_replace(lower(unaccent(a.phrase)), '\s+', ' ', 'g')) > 0
          and strpos(regexp_replace(lower(unaccent(a.phrase)), '\s+', ' ', 'g'), rec.term) > 0
      ) then
        this_rank := case rec.severity when 'extreme' then 3 when 'high' then 2 else 1 end;
        if this_rank > best_rank then best_rank := this_rank; best := rec.severity; end if;
      end if;

    elsif rec.kind = 'word'
          and rec.severity in ('high','extreme')
          and length(rec.term) >= 5 then
      -- Letter-spacing evasion, scoped to each spaced-out run only.
      foreach run in array coalesce(runs, '{}'::text[]) loop
        condensed_run := regexp_replace(run, '[^a-z0-9]', '', 'g');
        if strpos(condensed_run, rec.term) > 0 then
          this_rank := case rec.severity when 'extreme' then 3 else 2 end;
          if this_rank > best_rank then best_rank := this_rank; best := rec.severity; end if;
          exit; -- matched in one run; no need to check the rest
        end if;
      end loop;
    end if;

    exit when best_rank = 3; -- nothing outranks 'extreme'
  end loop;

  return best;
end;
$$;

revoke all on function moderation_severity(text) from public, anon, authenticated;
