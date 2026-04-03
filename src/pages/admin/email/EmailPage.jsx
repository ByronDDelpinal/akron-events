import { useState, useEffect, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { format } from 'date-fns'

export default function EmailPage() {
  // ── Subscriber stats ──
  const [stats, setStats] = useState(null)
  const [loadingStats, setLoadingStats] = useState(true)

  // ── Send digest ──
  const [sending, setSending] = useState(false)
  const [sendResult, setSendResult] = useState(null)

  // ── Recent sends ──
  const [recentSends, setRecentSends] = useState([])
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
      .select('id, subscriber_id, sent_at, event_count, status, error_message, created_at')
      .order('created_at', { ascending: false })
      .limit(50)
    setRecentSends(data ?? [])
    setLoadingSends(false)
  }, [])

  useEffect(() => {
    fetchStats()
    fetchSends()
  }, [fetchStats, fetchSends])

  // ── Manual send ──
  const handleSendDigest = async () => {
    if (!confirm('This will send digest emails to all subscribers who are due today. Continue?')) return

    setSending(true)
    setSendResult(null)

    try {
      const { data, error } = await supabase.functions.invoke('send-digest', {
        method: 'POST',
        body: {},
      })

      if (error) throw error

      setSendResult({
        ok: true,
        message: `Sent ${data?.sent ?? 0} emails, skipped ${data?.skipped ?? 0}`,
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
        message: `Failed: ${err.message || 'Unknown error'}`,
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
          Trigger a digest send for all subscribers who are due today.
          This is the same logic that pg_cron will run once automated —
          daily subscribers always, weekly on their chosen day, monthly on the 1st.
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

        {!loadingSends && recentSends.length === 0 && (
          <p className="email-empty">No emails sent yet.</p>
        )}

        {!loadingSends && recentSends.length > 0 && (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Events</th>
                  <th>Subscriber</th>
                  <th>Sent At</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {recentSends.map(send => (
                  <tr key={send.id}>
                    <td>
                      <span className={`email-status-badge status-${send.status}`}>
                        {send.status}
                      </span>
                    </td>
                    <td>{send.event_count}</td>
                    <td className="email-subscriber-id">{send.subscriber_id?.slice(0, 8)}…</td>
                    <td>{send.sent_at ? format(new Date(send.sent_at), 'MMM d, h:mm a') : '—'}</td>
                    <td className="email-error-cell">{send.error_message || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
