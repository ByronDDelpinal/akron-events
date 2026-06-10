import type { LooseRow } from '@/types'
import { Fragment, useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '@/lib/supabase'
import { format } from 'date-fns'

type Row = LooseRow

interface BatchMeta {
  batchId: string
  date: string
  session: string
  trigger: string
}

interface BatchCounts {
  sent: number
  skipped: number
  failed: number
}

interface Batch {
  batchId: string
  date: string | null
  session: string
  trigger: string
  sentAt: string | null
  sends: Row[]
  counts: BatchCounts
}

interface Stats {
  total: number
  active: number
  unsubscribed: number
  daily: number
  weekly: number
  monthly: number
}

interface SendResult {
  ok: boolean
  message: string
}

/**
 * Parse the `idempotency_key` written by send-digest into the parts needed
 * for batch grouping. Format: `digest-YYYY-MM-DD/<subscriber-uuid>/<session>`.
 * Returns null for rows that predate the session tag.
 */
function parseBatchKey(idempotencyKey: string | null | undefined): BatchMeta | null {
  if (!idempotencyKey || typeof idempotencyKey !== 'string') return null
  const m = idempotencyKey.match(/^digest-(\d{4}-\d{2}-\d{2})\/[^/]+\/(.+)$/)
  if (!m) return null
  const [, date, session] = m
  return {
    batchId: `${date}::${session}`,
    date,
    session,
    trigger: session === 'scheduled' ? 'scheduled' : 'manual',
  }
}

export default function EmailPage() {
  // ── Subscriber stats ──
  const [stats, setStats] = useState<Stats | null>(null)
  const [loadingStats, setLoadingStats] = useState(true)

  // ── Send digest ──
  const [sending, setSending] = useState(false)
  const [sendResult, setSendResult] = useState<SendResult | null>(null)

  // ── Recent sends ──
  const [recentSends, setRecentSends] = useState<Row[]>([])
  const [loadingSends, setLoadingSends] = useState(true)

  // ── Load subscriber stats ──
  const fetchStats = useCallback(async () => {
    setLoadingStats(true)

    const [activeRes, unsubRes, totalRes] = await Promise.all([
      supabase
        .from('subscribers')
        .select('id', { count: 'exact', head: true })
        .eq('confirmed', true)
        .is('unsubscribed_at', null),
      supabase
        .from('subscribers')
        .select('id', { count: 'exact', head: true })
        .not('unsubscribed_at', 'is', null),
      supabase
        .from('subscribers')
        .select('id', { count: 'exact', head: true }),
    ])

    // Frequency breakdown
    const [dailyRes, weeklyRes, monthlyRes] = await Promise.all([
      supabase
        .from('subscribers')
        .select('id', { count: 'exact', head: true })
        .eq('confirmed', true)
        .is('unsubscribed_at', null)
        .eq('frequency', 'daily'),
      supabase
        .from('subscribers')
        .select('id', { count: 'exact', head: true })
        .eq('confirmed', true)
        .is('unsubscribed_at', null)
        .eq('frequency', 'weekly'),
      supabase
        .from('subscribers')
        .select('id', { count: 'exact', head: true })
        .eq('confirmed', true)
        .is('unsubscribed_at', null)
        .eq('frequency', 'monthly'),
    ])

    setStats({
      total: totalRes.count ?? 0,
      active: activeRes.count ?? 0,
      unsubscribed: unsubRes.count ?? 0,
      daily: dailyRes.count ?? 0,
      weekly: weeklyRes.count ?? 0,
      monthly: monthlyRes.count ?? 0,
    })
    setLoadingStats(false)
  }, [])

  // ── Load recent email sends ──
  const fetchSends = useCallback(async () => {
    setLoadingSends(true)
    const { data } = await supabase
      .from('email_sends')
      .select('id, subscriber_id, sent_at, event_count, status, error_message, created_at, idempotency_key, subscribers ( email )')
      .order('created_at', { ascending: false })
      .limit(500)
    setRecentSends((data ?? []) as Row[])
    setLoadingSends(false)
  }, [])

  // Batch view: collapse per-subscriber sends into one row per batch by
  // parsing the idempotency_key. Each batch is keyed on {date, session}.
  const batches = useMemo<Batch[]>(() => {
    const map = new Map<string, Batch>()
    for (const send of recentSends) {
      const meta = parseBatchKey(send.idempotency_key)
      const batchId = meta?.batchId ?? `legacy::${send.created_at?.slice(0, 10) || 'unknown'}`
      if (!map.has(batchId)) {
        map.set(batchId, {
          batchId,
          date:    meta?.date    ?? send.created_at?.slice(0, 10) ?? null,
          session: meta?.session ?? 'legacy',
          trigger: meta?.trigger ?? 'unknown',
          sentAt:  send.sent_at ?? send.created_at,
          sends:   [],
          counts:  { sent: 0, skipped: 0, failed: 0 },
        })
      }
      const batch = map.get(batchId)!
      batch.sends.push(send)
      // Bump status count
      if (send.status === 'sent' || send.status === 'skipped' || send.status === 'failed') {
        batch.counts[send.status as keyof BatchCounts] += 1
      }
      // Keep the most recent sent_at as the batch's timestamp
      const ts = send.sent_at || send.created_at
      if (ts && (!batch.sentAt || ts > batch.sentAt)) batch.sentAt = ts
    }
    // Newest first
    return [...map.values()].sort((a, b) => (b.sentAt || '').localeCompare(a.sentAt || ''))
  }, [recentSends])

  // Which batches the user has expanded to see per-subscriber detail.
  const [expandedBatches, setExpandedBatches] = useState<Set<string>>(() => new Set())
  const toggleBatch = (batchId: string) => {
    setExpandedBatches((prev) => {
      const next = new Set(prev)
      if (next.has(batchId)) next.delete(batchId)
      else next.add(batchId)
      return next
    })
  }

  useEffect(() => {
    fetchStats()
    fetchSends()
  }, [fetchStats, fetchSends])

  // ── Manual send ──
  const handleSendDigest = async () => {
    if (!confirm('This will send a digest email to ALL active subscribers right now. Continue?')) return

    setSending(true)
    setSendResult(null)

    try {
      const { data, error } = await supabase.functions.invoke('send-digest', {
        body: { force: true },
      })

      if (error) throw error

      const d = data as Row | null
      const sent    = d?.emails_sent ?? 0
      const skipped = d?.skipped ?? 0
      const failed  = d?.failed ?? 0
      const due     = d?.subscribers_due ?? 0
      setSendResult({
        ok: failed === 0,
        message: failed === 0
          ? `Sent ${sent} of ${due} subscribers (${skipped} skipped — no matching events)`
          : `Sent ${sent}, skipped ${skipped}, FAILED ${failed} of ${due} subscribers — check function logs`,
      })

      // Refresh stats and sends after a short delay
      setTimeout(() => {
        fetchStats()
        fetchSends()
      }, 1500)
    } catch (err) {
      console.error('Send digest error:', err)
      setSendResult({
        ok: false,
        message: `Failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      })
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="admin-section">
      <div className="admin-section-header">
        <h2 className="admin-section-title">Email Digests</h2>
      </div>

      {/* ── Stats cards ── */}
      <div className="email-stats-grid">
        {loadingStats ? (
          <div className="admin-loading">Loading stats…</div>
        ) : stats && (
          <>
            <div className="email-stat-card">
              <div className="email-stat-value">{stats.active}</div>
              <div className="email-stat-label">Active subscribers</div>
            </div>
            <div className="email-stat-card">
              <div className="email-stat-value">{stats.total}</div>
              <div className="email-stat-label">Total signups</div>
            </div>
            <div className="email-stat-card">
              <div className="email-stat-value">{stats.unsubscribed}</div>
              <div className="email-stat-label">Unsubscribed</div>
            </div>
            <div className="email-stat-card">
              <div className="email-stat-value">
                {stats.daily} / {stats.weekly} / {stats.monthly}
              </div>
              <div className="email-stat-label">Daily / Weekly / Monthly</div>
            </div>
          </>
        )}
      </div>

      {/* ── Manual trigger ── */}
      <div className="email-trigger-section">
        <h3 className="email-trigger-title">Manual Send</h3>
        <p className="email-trigger-desc">
          Send a digest to every active subscriber right now, regardless of
          their frequency or scheduled day. Once pg_cron is set up, scheduled
          sends will only target subscribers who are due that day.
        </p>
        <button
          className="btn-admin-primary email-send-btn"
          onClick={handleSendDigest}
          disabled={sending}
        >
          {sending ? 'Sending…' : 'Send digest now'}
        </button>
        {sendResult && (
          <p className={`email-trigger-result ${sendResult.ok ? 'result-ok' : 'result-err'}`}>
            {sendResult.message}
          </p>
        )}
      </div>

      {/* ── Recent sends log ── */}
      <div className="email-sends-section">
        <div className="admin-section-header">
          <h3 className="admin-section-title">Recent Sends</h3>
          <button className="btn-admin-ghost" onClick={fetchSends} disabled={loadingSends}>
            Refresh
          </button>
        </div>

        {loadingSends && <div className="admin-loading">Loading…</div>}

        {!loadingSends && batches.length === 0 && (
          <p className="email-empty">No email batches yet.</p>
        )}

        {!loadingSends && batches.length > 0 && (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  {/* Spacer column for the expand chevron */}
                  <th aria-label="Expand" style={{ width: 28 }}></th>
                  <th>Trigger</th>
                  <th>Sent at</th>
                  <th style={{ textAlign: 'right' }}>Subscribers</th>
                  <th style={{ textAlign: 'right' }}>Delivered</th>
                  <th style={{ textAlign: 'right' }}>Skipped</th>
                  <th style={{ textAlign: 'right' }}>Failed</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((batch) => {
                  const expanded = expandedBatches.has(batch.batchId)
                  const total = batch.sends.length
                  return (
                    <Fragment key={batch.batchId}>
                      <tr
                        className={`email-batch-row ${expanded ? 'expanded' : ''}`}
                        onClick={() => toggleBatch(batch.batchId)}
                        style={{ cursor: 'pointer' }}
                      >
                        <td style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                          {expanded ? '▾' : '▸'}
                        </td>
                        <td>
                          <span className={`email-status-badge status-${batch.trigger === 'scheduled' ? 'sent' : batch.trigger === 'manual' ? 'skipped' : 'failed'}`}>
                            {batch.trigger === 'scheduled' ? 'Scheduled' : batch.trigger === 'manual' ? 'Manual' : 'Legacy'}
                          </span>
                        </td>
                        <td>{batch.sentAt ? format(new Date(batch.sentAt), 'MMM d, yyyy · h:mm a') : '—'}</td>
                        <td style={{ textAlign: 'right' }}>{total}</td>
                        <td style={{ textAlign: 'right' }}>{batch.counts.sent}</td>
                        <td style={{ textAlign: 'right' }}>{batch.counts.skipped}</td>
                        <td style={{ textAlign: 'right', color: batch.counts.failed > 0 ? 'var(--coral)' : undefined, fontWeight: batch.counts.failed > 0 ? 600 : undefined }}>
                          {batch.counts.failed}
                        </td>
                      </tr>

                      {expanded && (
                        <tr className="email-batch-detail-row">
                          <td></td>
                          <td colSpan={6} style={{ padding: 0 }}>
                            <div className="admin-table-wrap" style={{ margin: 0 }}>
                              <table className="admin-table" style={{ marginBottom: 0 }}>
                                <thead>
                                  <tr>
                                    <th>Status</th>
                                    <th>Subscriber</th>
                                    <th style={{ textAlign: 'right' }}>Events</th>
                                    <th>Sent at</th>
                                    <th>Error</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {batch.sends.map((send) => (
                                    <tr key={send.id}>
                                      <td>
                                        <span className={`email-status-badge status-${send.status}`}>
                                          {send.status}
                                        </span>
                                      </td>
                                      <td className="email-subscriber-id">
                                        {send.subscribers?.email || `${send.subscriber_id?.slice(0, 8)}…`}
                                      </td>
                                      <td style={{ textAlign: 'right' }}>{send.event_count}</td>
                                      <td>{send.sent_at ? format(new Date(send.sent_at), 'MMM d, h:mm a') : '—'}</td>
                                      <td className="email-error-cell">{send.error_message || '—'}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
