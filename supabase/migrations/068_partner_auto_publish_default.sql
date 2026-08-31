-- 068_partner_auto_publish_default.sql
--
-- Policy change (Byron, 2026-08-31): partner access itself IS the trust
-- decision. Any org with a partner_orgs row publishes organizer events
-- directly -- no review step. auto_publish stays in the schema as the
-- per-tenant lever (an admin can still flip one tenant back to reviewed),
-- but the default for new tenants and every existing tenant are now true.
--
-- The 061 gates (partner_upsert_event / partner_set_event_status check
-- `not po.auto_publish` across all host orgs) and the content-moderation
-- screen are untouched; flagged text still demotes to review.

alter table partner_orgs alter column auto_publish set default true;

update partner_orgs set auto_publish = true where not auto_publish;
