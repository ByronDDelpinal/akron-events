/**
 * useOrgMetrics.ts
 *
 * The data half of the partner analytics block. Calls one RPC
 * (partner_event_metrics, migration 063) and hands back rows plus a state.
 *
 * There is no admin branch in here, and that is deliberate. The RPC verifies
 * p_org against partner_scope() or is_admin() server side, so the hook never
 * asks who it is fetching for; the caller just says which org. That is what
 * lets one component serve both the partner home page and the admin partners
 * list without a mode flag.
 *
 * A failed call is an ERROR, never an empty result. The same rule
 * partnerShared.ts's resolveRole states: a failed probe is an error, not "no
 * access". On this surface it matters more than usual, because zero is a
 * legitimate answer and rendering a failure as zero would be a quiet lie.
 */

import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { metricWindow, type MetricRow } from '@/lib/admin/analyticsShared'

/**
 * 'idle' exists so a missing orgId cannot be mistaken for an answer. Without
 * it, no-org-selected resolved to ready + zero rows, which the UI renders as
 * "No events in this window", a fabricated factual claim about an org nobody
 * asked about yet.
 */
export type MetricsState = 'idle' | 'loading' | 'ready' | 'denied' | 'error'

export interface OrgMetrics {
  rows: MetricRow[]
  state: MetricsState
  /** The window actually asked for, so the UI can say what it is showing.
   *  Named `range`, not `window`: a module-scope `window` shadows the global
   *  one, which is the kind of thing that reads fine and breaks later. */
  range: ReturnType<typeof metricWindow>
  reload: () => void
}

/**
 * Postgres raises insufficient_privilege (SQLSTATE 42501) when p_org is not
 * the caller's. PostgREST surfaces that as its own code, so match on both
 * rather than on the message text, which is not a contract.
 */
function isDenial(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false
  // 42501 only. P0001 is plpgsql's DEFAULT raise_exception code, so matching it
  // would turn the first bare `raise exception` anyone adds to the function
  // into a "you cannot see this organization" message for what is really a bug.
  return err.code === '42501' || /insufficient_privilege|not your organization/i.test(err.message ?? '')
}

export function useOrgMetrics(orgId: string | null, days: number): OrgMetrics {
  const [rows, setRows] = useState<MetricRow[]>([])
  const [state, setState] = useState<MetricsState>('loading')
  const [nonce, setNonce] = useState(0)
  const range = metricWindow(days)
  const { from, to } = range

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    if (!orgId) {
      setRows([])
      setState('idle')
      return
    }
    let cancelled = false
    setState('loading')
    void (async () => {
      const { data, error } = await supabase.rpc('partner_event_metrics', {
        p_org: orgId,
        p_from: from,
        p_to: to,
      })
      if (cancelled) return
      if (error) {
        setRows([])
        setState(isDenial(error) ? 'denied' : 'error')
        return
      }
      setRows((data ?? []) as MetricRow[])
      setState('ready')
    })()
    return () => {
      cancelled = true
    }
    // `range` is rebuilt every render; depend on its two primitive fields.
  }, [orgId, from, to, nonce])

  return { rows, state, range, reload }
}
