-- 067_partner_org_editing.sql
--
-- Let a partner edit their OWN organization's public details, directly, with
-- no review step (organizations carry no moderation/publish workflow -- the
-- 059 gate is events-only). Mirrors the 061 partner-write discipline exactly:
-- SECURITY DEFINER, search_path pinned, the org is a CLAIM verified against
-- partner_scope() inside the body (never trusted from the client), and the
-- writable surface is a hard ALLOWLIST. status, manual_overrides, slug, id and
-- venue ownership are NOT reachable here -- those stay admin-only.
--
-- Two functions: a scope-checked read to seed the form, and the write.

-- 1. partner_org_details() -- the editable fields for ONE org in scope.
--    Returns zero rows for an org the caller has no membership on (the
--    where-clause fails closed), so the UI cannot seed a form it cannot save.
create or replace function partner_org_details(p_org uuid)
returns table (
  organization_id uuid,
  name          text,
  description   text,
  website       text,
  contact_email text,
  image_url     text,
  address       text,
  city          text,
  state         text,
  zip           text,
  photos        text[]
)
language sql stable security definer set search_path = public
as $$
  select o.id, o.name, o.description, o.website, o.contact_email,
         o.image_url, o.address, o.city, o.state, o.zip, o.photos
  from organizations o
  where o.id = p_org
    and p_org = any (partner_scope())
$$;

-- 2. partner_update_org() -- the write. Presence-checked patch: an omitted key
--    leaves the column untouched, a present key sets (or clears) it. name is
--    NOT NULL in the table, so a present-but-blank name is refused rather than
--    written.
create or replace function partner_update_org(p_org uuid, p_patch jsonb)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_name   text;
  v_photos text[];
begin
  if p_org is null then
    raise exception 'missing argument p_org' using errcode = 'null_value_not_allowed';
  end if;
  if p_patch is null then
    raise exception 'missing argument p_patch' using errcode = 'null_value_not_allowed';
  end if;

  -- Scope gate: identical rule to create (partner_may_create_for_org checks
  -- p_org = any(partner_scope()), i.e. an active membership on an active
  -- tenant). A partner can edit ONLY an org they belong to.
  if not partner_may_create_for_org(p_org) then
    raise exception 'you cannot edit this organization'
      using errcode = 'insufficient_privilege',
            hint = 'partner_scope refusal; see ADR 6.8';
  end if;

  if p_patch ? 'name' then
    v_name := partner_fold_whitespace(btrim(coalesce(p_patch->>'name', '')));
    if v_name = '' then
      raise exception 'organization name cannot be empty'
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  if p_patch ? 'photos' then
    -- jsonb array -> text[], trimmed, blanks dropped, capped at 12
    -- (organizations.photos is documented "up to 12 URLs", migration 006).
    select coalesce(array_agg(t), '{}')
      from (
        select btrim(value) as t
        from jsonb_array_elements_text(p_patch->'photos')
        where btrim(value) <> ''
        limit 12
      ) s
      into v_photos;
  end if;

  update organizations o set
    name          = case when p_patch ? 'name'          then v_name else o.name end,
    description   = case when p_patch ? 'description'   then nullif(btrim(p_patch->>'description'),   '') else o.description end,
    website       = case when p_patch ? 'website'       then nullif(btrim(p_patch->>'website'),       '') else o.website end,
    contact_email = case when p_patch ? 'contact_email' then nullif(btrim(p_patch->>'contact_email'), '') else o.contact_email end,
    image_url     = case when p_patch ? 'image_url'     then nullif(btrim(p_patch->>'image_url'),     '') else o.image_url end,
    address       = case when p_patch ? 'address'       then nullif(btrim(p_patch->>'address'),       '') else o.address end,
    city          = case when p_patch ? 'city'          then nullif(btrim(p_patch->>'city'),          '') else o.city end,
    state         = case when p_patch ? 'state'         then nullif(btrim(p_patch->>'state'),         '') else o.state end,
    zip           = case when p_patch ? 'zip'           then nullif(btrim(p_patch->>'zip'),           '') else o.zip end,
    photos        = case when p_patch ? 'photos'        then v_photos else o.photos end
  where o.id = p_org;

  return jsonb_build_object('id', p_org, 'ok', true);
end;
$$;

-- Grants: revoke the default PUBLIC/anon EXECUTE, hand it only to authenticated
-- (the 061 discipline -- Supabase grants EXECUTE to anon/authenticated directly
-- by default, so revoke first).
revoke all on function partner_org_details(uuid)      from public, anon;
grant  execute on function partner_org_details(uuid)      to authenticated;
revoke all on function partner_update_org(uuid, jsonb) from public, anon;
grant  execute on function partner_update_org(uuid, jsonb) to authenticated;
