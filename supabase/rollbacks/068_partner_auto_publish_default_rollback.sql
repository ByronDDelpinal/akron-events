-- 068_partner_auto_publish_default_rollback.sql
--
-- Restores the 061 default (new tenants reviewed until flipped). The UPDATE
-- in 068 is not blindly reversible; per-tenant state as of 2026-08-31 was:
-- north-hill-cdc true (flipped 08-31), royal-palace false. Re-apply by hand
-- if that split needs restoring.

alter table partner_orgs alter column auto_publish set default false;
