/**
 * partnerShared.ts
 *
 * Pure logic behind the partner-facing side of Pulse Control: role
 * resolution, the client twin of the partner patch allowlist, the all-of
 * write predicate, and the copy helpers the partner surfaces share.
 *
 * EVERYTHING in this file is UX, never security. The 061 RPCs and RLS
 * policies are the enforcement; these twins exist so the UI can be honest
 * about what a save will do before the server says so, and so the pinned
 * behavior is testable without a browser (scripts/tests/test-partner-ui.js,
 * the test-review-reasons.js precedent).
 *
 * No runtime imports: this module must stay loadable by the node:test
 * harness, which cannot resolve the `@/` alias (type-only alias imports are
 * fine, they strip).
 */

/** One row of `partner_org_context()` -- the 061 read RPC's frozen shape. */
export interface PartnerOrg {
  organization_id: string
  name: string
  slug: string
  auto_publish: boolean
}

export type AdminRole = 'admin' | 'partner' | 'none'

export interface RoleResolution {
  role: AdminRole | null
  orgs: PartnerOrg[]
  /** Set when the probe could not answer; role is null in that case. */
  error: string | null
}

interface ProbeResult<T> {
  data: T | null
  error: { message: string } | null
}

/**
 * Resolve the shell role from the two probe calls (design §4.2).
 *
 *   is_admin === true            -> admin (context ignored; an admin with
 *                                   zero memberships gets zero rows anyway)
 *   context has rows             -> partner
 *   both answered, both empty    -> none (the honest NobodyPage state)
 *   either call failed otherwise -> error, role null. NEVER a fallback to
 *   "show everything" and never a false "no access" claim off a network
 *   failure -- "we could not ask" and "you have nothing" are opposite facts.
 */
export function resolveRole(
  isAdminRes: ProbeResult<boolean>,
  contextRes: ProbeResult<PartnerOrg[]>,
): RoleResolution {
  if (!isAdminRes.error && isAdminRes.data === true) {
    return { role: 'admin', orgs: [], error: null }
  }
  const orgs = !contextRes.error && Array.isArray(contextRes.data) ? contextRes.data : null
  if (orgs && orgs.length > 0) {
    return { role: 'partner', orgs, error: null }
  }
  const failure = isAdminRes.error ?? contextRes.error
  if (failure) {
    return { role: null, orgs: [], error: failure.message || 'The role check failed.' }
  }
  return { role: 'none', orgs: [], error: null }
}

/**
 * The column allowlist of `partner_upsert_event` (061 §3.3), client twin.
 * The RPC is the enforcement point; this list only decides which inputs the
 * drawer and create form render, and the sync test pins it so the two
 * cannot drift silently. `featured`, `status`, `source`, `source_id`,
 * `needs_review`, `reviewed_*`, `manual_overrides` and friends are NEVER
 * writable through any partner path.
 */
export const PARTNER_PATCH_KEYS = [
  'title',
  'description',
  'start_at',
  'end_at',
  'price_min',
  'price_max',
  'age_restriction',
  'ticket_url',
  'source_url',
  'image_url',
] as const

export type PartnerPatchKey = (typeof PARTNER_PATCH_KEYS)[number]

export type PartnerPatch = Partial<Record<PartnerPatchKey, string | number | null>>

/**
 * Normalize a raw event row into the patch-comparable shape: allowlisted
 * keys only, empty strings folded to null (the RPC's own nullif-trim
 * behavior), price_min defaulted to 0 the way the column does.
 */
export function rowToPatchBase(row: Record<string, unknown>): PartnerPatch {
  const out: PartnerPatch = {}
  for (const key of PARTNER_PATCH_KEYS) {
    const value = row[key]
    if (key === 'price_min') {
      out[key] = typeof value === 'number' ? value : 0
    } else if (key === 'price_max') {
      out[key] = typeof value === 'number' ? value : null
    } else if (typeof value === 'string') {
      const trimmed = value.trim()
      out[key] = trimmed === '' ? null : trimmed
    } else {
      out[key] = value == null ? null : (value as string | number)
    }
  }
  return out
}

/**
 * The keys of `next` that differ from `base`, as the p_patch object to send.
 * Returns {} when nothing changed -- the caller skips the RPC then, because
 * an empty patch is a client bug the server refuses loudly.
 */
export function diffPartnerPatch(base: PartnerPatch, next: PartnerPatch): PartnerPatch {
  const out: PartnerPatch = {}
  for (const key of PARTNER_PATCH_KEYS) {
    if (!(key in next)) continue
    const a = base[key] ?? null
    const b = next[key] ?? null
    if (a !== b) out[key] = b
  }
  return out
}

/**
 * Client twin of the ADR §6.8 all-of write rule: writable only when the
 * event has at least one linked org and EVERY linked org is in scope.
 * Empty scope fails closed; an orphan row (zero links) fails the
 * non-vacuity clause. The RPCs are the enforcement; this only prevents the
 * broken-save-button read (§6.10 item 4).
 */
export function partnerCanWrite(linkedOrgIds: string[], scopeIds: string[]): boolean {
  if (linkedOrgIds.length === 0 || scopeIds.length === 0) return false
  return linkedOrgIds.every((id) => scopeIds.includes(id))
}

/** Names of the row's linked orgs that sit outside the caller's scope. */
export function coHostNamesOutsideScope(
  orgs: { id: string; name: string }[],
  scopeIds: string[],
): string[] {
  return orgs.filter((o) => !scopeIds.includes(o.id)).map((o) => o.name)
}

/** First linked org id inside scope: the p_org to write as. Null when none. */
export function writeOrgId(linkedOrgIds: string[], scopeIds: string[]): string | null {
  return linkedOrgIds.find((id) => scopeIds.includes(id)) ?? null
}

/**
 * Predict (for the confirm copy only) whether publishing will resolve to
 * review: any of the row's linked orgs that appears in the caller's own
 * context with auto_publish=false. The RPC's most-restrictive scan over ALL
 * tenants is the truth -- a co-host tenant outside the caller's context can
 * still force review, which is why the post-call toast reads the RPC's
 * `review_required_by`, never this prediction.
 */
export function predictedReviewBlocker(
  linkedOrgIds: string[],
  ctxOrgs: PartnerOrg[],
): string | null {
  const blockers = ctxOrgs
    .filter((o) => linkedOrgIds.includes(o.organization_id) && !o.auto_publish)
    .map((o) => o.name)
    .sort()
  return blockers[0] ?? null
}

/**
 * The one line of copy for a write result that landed in review, naming the
 * org whose rules forced it when the RPC named one (ADR §6.9: loud, never
 * silent).
 */
export function reviewOutcomeCopy(reviewRequiredBy: string | null): string {
  return reviewRequiredBy
    ? `${reviewRequiredBy}'s rules sent this to Akron Pulse for review. It will publish once a human approves it.`
    : 'This went to Akron Pulse for review. It will publish once a human approves it.'
}

/**
 * Cancelled is FINAL for partners (fix-pass finding 5, product ruling):
 * a partner may cancel but may never move any event out of `cancelled`;
 * restoring is an Akron Pulse action. The UI offers NO republish
 * affordance on cancelled rows, and this copy pair says so plainly. The
 * RPC enforces the same rule server-side with a matching refusal.
 */
export const CANCELLED_FINAL_COPY =
  'Cancelled. Contact Akron Pulse to restore.'

export function cancelConfirmCopy(title: string): string {
  return `Cancel "${title}"? It comes off the public site and shows as cancelled. This is permanent: only Akron Pulse can restore a cancelled event.`
}

/**
 * True when the row was originally imported from a feed (neither manual nor
 * partner-created), so the drawer shows the override-trade info line
 * (design §4.5 / D5).
 */
export function isImportedSource(source: string | null | undefined): boolean {
  if (!source) return false
  return source !== 'manual' && !source.startsWith('partner:')
}

/** SQLSTATE codes the 061 RPCs raise, mapped from their errcode names. */
const RPC_SQLSTATES = new Set([
  '42501', // insufficient_privilege
  '22023', // invalid_parameter_value
  '23514', // check_violation (venue guard, multi-venue guard)
  '22004', // null_value_not_allowed
  '23503', // foreign_key_violation
  '23505', // unique_violation (venues name race)
])

/**
 * A partner-readable message for an RPC failure. The 061 error messages are
 * written for humans, so a recognized refusal shows verbatim (the review
 * drawer's RowError pattern); anything else gets honest fallback copy with
 * the raw message attached rather than a fake success or a bare "error".
 */
export function rpcFriendlyMessage(
  err: { code?: string; message?: string } | null | undefined,
  fallback: string,
): string {
  if (!err) return fallback
  if (err.code && RPC_SQLSTATES.has(err.code) && err.message) return err.message
  return err.message ? `${fallback} (${err.message})` : fallback
}

/** True for the guard-family refusals shown inline under the venue field. */
export function isGuardRefusal(err: { code?: string } | null | undefined): boolean {
  return err?.code === '23514'
}

/** Client twin of the 061 partner_orgs.slug CHECK. The slug is permanent. */
export const PARTNER_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/

export function isValidPartnerSlug(slug: string): boolean {
  return PARTNER_SLUG_RE.test(slug)
}
