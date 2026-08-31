-- 067_partner_org_editing_rollback.sql
--
-- Reverts 067. Both functions are NEW in 067 (no prior body to restore),
-- so the rollback is a clean drop; the revokes die with the functions.

drop function if exists partner_update_org(uuid, jsonb);
drop function if exists partner_org_details(uuid);
