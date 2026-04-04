import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import './FeedbackPage.css'

/* ── Category config ─────────────────────────────────────────────────── */
const CATEGORIES = [
  { id: 'bug',       label: 'Bug',           icon: '🐛' },
  { id: 'love',      label: 'Love It',       icon: '🔥' },
  { id: 'wish',      label: 'Wish List',     icon: '✨' },
  { id: 'confusing', label: 'Confusing',     icon: '🤔' },
  { id: 'idea',      label: 'Roadmap Idea',  icon: '💡' },
  { id: 'datasource',label: 'Data Source',   icon: '📡' },
  { id: 'general',   label: 'General',       icon: '💬' },
]
const CAT_MAP = Object.fromEntries(CATEGORIES.map(c => [c.id, c]))

/* ── Voter ID (simple fingerprint so one upvote per browser) ─────── */
function getVoterId() {
  let id = sessionStorage.getItem('feedback_voter')
  if (!id) {
    id = crypto.randomUUID()
    sessionStorage.setItem('feedback_voter', id)
  }
  return id
}

/* ── Sort options ────────────────────────────────────────────────────── */
const SORTS = [
  { id: 'popular', label: 'Top' },
  { id: 'recent',  label: 'New' },
]

/* ═══════════════════════════════════════════════════════════════════════ */
export default function FeedbackPage() {
  const [posts,       setPosts]       = useState([])
  const [myVotes,     setMyVotes]     = useState(new Set())   // post IDs I voted on
  const [loading,     setLoading]     = useState(true)
  const [filter,      setFilter]      = useState('all')
  const [sort,        setSort]        = useState('popular')
  const [search,      setSearch]      = useState('')

  // New-post form
  const [showForm,    setShowForm]    = useState(false)
  const [formCat,     setFormCat]     = useState('general')
  const [formBody,    setFormBody]    = useState('')
  const [formAuthor,  setFormAuthor]  = useState('')
  const [formPrivate, setFormPrivate] = useState(false)
  const [submitting,  setSubmitting]  = useState(false)
  const textareaRef = useRef(null)

  // Persist author name across submissions
  const savedAuthor = useRef('')

  /* ── Fetch posts + my votes ─────────────────────────────────────── */
  const fetchPosts = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('feedback_posts')
        .select('*')
        .eq('is_private', false)
        .order(sort === 'popular' ? 'votes' : 'created_at', { ascending: false })

      if (!error && data) setPosts(data)

      const voterId = getVoterId()
      const { data: votes } = await supabase
        .from('feedback_votes')
        .select('post_id')
        .eq('voter_id', voterId)

      if (votes) setMyVotes(new Set(votes.map(v => v.post_id)))
    } finally {
      setLoading(false)
    }
  }, [sort])

  // Only fetch on mount and when sort changes
  useEffect(() => { fetchPosts() }, [fetchPosts])

  /* ── Open form — sync category from active filter ────────────────── */
  const openForm = () => {
    setFormCat(filter !== 'all' ? filter : 'general')
    setFormBody('')
    setFormPrivate(false)
    setFormAuthor(savedAuthor.current)
    setShowForm(true)
    setTimeout(() => textareaRef.current?.focus(), 80)
  }

  /* ── Submit a new post ──────────────────────────────────────────── */
  const handleSubmit = async (e) => {
    e.preventDefault()
    const body = formBody.trim()
    if (!body || submitting) return
    setSubmitting(true)

    // Capture current form values before any state changes
    const payload = {
      category:    formCat,
      body,
      author_name: formAuthor.trim() || 'Anonymous',
      is_private:  formPrivate,
    }

    try {
      const { data, error } = await supabase
        .from('feedback_posts')
        .insert(payload)
        .select()
        .single()

      if (error) {
        console.error('Feedback submit error:', error)
        return
      }

      // Remember author for next submission
      savedAuthor.current = formAuthor.trim()

      // Close form and reset
      setShowForm(false)
      setFormBody('')
      setFormPrivate(false)

      // Re-fetch to get clean data from the database
      const { data: fresh } = await supabase
        .from('feedback_posts')
        .select('*')
        .eq('is_private', false)
        .order(sort === 'popular' ? 'votes' : 'created_at', { ascending: false })

      if (fresh) setPosts(fresh)
    } finally {
      setSubmitting(false)
    }
  }

  /* ── Toggle vote ────────────────────────────────────────────────── */
  const toggleVote = async (postId) => {
    const voterId = getVoterId()
    const alreadyVoted = myVotes.has(postId)

    if (alreadyVoted) {
      // Remove vote
      await supabase
        .from('feedback_votes')
        .delete()
        .eq('post_id', postId)
        .eq('voter_id', voterId)

      setMyVotes(prev => { const s = new Set(prev); s.delete(postId); return s })
      setPosts(prev => prev.map(p => p.id === postId ? { ...p, votes: p.votes - 1 } : p))
    } else {
      // Add vote
      await supabase
        .from('feedback_votes')
        .insert({ post_id: postId, voter_id: voterId })

      setMyVotes(prev => new Set(prev).add(postId))
      setPosts(prev => prev.map(p => p.id === postId ? { ...p, votes: p.votes + 1 } : p))
    }
  }

  /* ── Filter + sort + search ──────────────────────────────────────── */
  const q = search.toLowerCase().trim()
  const visible = posts
    .filter(p => filter === 'all' || p.category === filter)
    .filter(p => !q || p.body.toLowerCase().includes(q) || p.author_name.toLowerCase().includes(q))

  const timeAgo = (dateStr) => {
    const diff = Date.now() - new Date(dateStr).getTime()
    const mins  = Math.floor(diff / 60000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    const days = Math.floor(hrs / 24)
    return `${days}d ago`
  }

  return (
    <>
      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <div className="fb-hero">
        <h2>Town <span>Square</span></h2>
        <p>
          Turnout is shaped by the people who use it.
          Share what's working, what's not, and where we should go next.
        </p>
      </div>

      <div className="fb-wrap">
        <div className="fb-bar" />

        <p className="fb-intro">
          The ideas with the most votes help us decide what to build next.
          See something you agree with? Give it an upvote.
          Got something new? Post it. Vote responsibly.
        </p>

        {/* ── Toolbar: filters + sort + post button (hidden when form open) */}
        {!showForm && (
          <div className="fb-toolbar">
            <div className="fb-filters">
              <button
                className={`fb-chip ${filter === 'all' ? 'fb-chip--active' : ''}`}
                onClick={() => setFilter('all')}
              >All</button>
              {CATEGORIES.map(c => (
                <button
                  key={c.id}
                  className={`fb-chip ${filter === c.id ? 'fb-chip--active' : ''}`}
                  onClick={() => setFilter(c.id)}
                >
                  <span className="fb-chip-icon">{c.icon}</span>
                  {c.label}
                </button>
              ))}
            </div>

            <div className="fb-toolbar-right">
              <div className="fb-sort">
                {SORTS.map(s => (
                  <button
                    key={s.id}
                    className={`fb-sort-btn ${sort === s.id ? 'fb-sort-btn--active' : ''}`}
                    onClick={() => setSort(s.id)}
                  >{s.label}</button>
                ))}
              </div>
              <button className="fb-add-btn" onClick={openForm}>
                Add Feedback
              </button>
            </div>
          </div>
        )}

        {/* ── Search (secondary, below toolbar) ──────────────────────── */}
        <div className="fb-search-row">
          <p className="fb-search-hint">
            Try searching to see if your item has already been reported.
            Give it a vote if so, or add it if you can't find it quickly.
          </p>
          <input
            type="text"
            className="fb-search"
            placeholder="Search existing feedback..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        {/* ── New post form (inline, not modal) ─────────────────────── */}
        {showForm && (
          <form className="fb-form" onSubmit={handleSubmit}>
            <div className="fb-form-cats">
              {CATEGORIES.map(c => (
                <button
                  key={c.id}
                  type="button"
                  className={`fb-chip fb-chip--sm ${formCat === c.id ? 'fb-chip--active' : ''}`}
                  onClick={() => setFormCat(c.id)}
                >
                  <span className="fb-chip-icon">{c.icon}</span>
                  {c.label}
                </button>
              ))}
            </div>

            <textarea
              ref={textareaRef}
              className="fb-textarea"
              placeholder="What's on your mind?"
              value={formBody}
              onChange={e => setFormBody(e.target.value)}
              rows={3}
            />

            <div
              className="fb-private-toggle"
              role="switch"
              aria-checked={formPrivate}
              tabIndex={0}
              onClick={() => setFormPrivate(p => !p)}
              onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setFormPrivate(p => !p) } }}
            >
              <span className={`fb-toggle ${formPrivate ? 'fb-toggle--on' : ''}`}>
                <span className="fb-toggle-thumb" />
              </span>
              <span className="fb-private-label">
                <span className="fb-private-title">Keep this on the down low</span>
                <span className="fb-private-hint">Only visible to the Turnout team</span>
              </span>
            </div>

            <div className="fb-form-footer">
              <input
                type="text"
                className="fb-author-input"
                placeholder="Your name (optional)"
                value={formAuthor}
                onChange={e => setFormAuthor(e.target.value)}
              />
              <div className="fb-form-actions">
                <button type="button" className="fb-cancel-btn" onClick={() => setShowForm(false)}>Cancel</button>
                <button type="submit" className="fb-submit-btn" disabled={!formBody.trim() || submitting}>
                  {submitting ? 'Submitting...' : 'Submit Feedback'}
                </button>
              </div>
            </div>
          </form>
        )}

        {/* ── Feed ───────────────────────────────────────────────────── */}
        {loading ? (
          <div className="fb-loading">Loading...</div>
        ) : visible.length === 0 ? (
          <div className="fb-empty">
            <p>No feedback yet{filter !== 'all' ? ' in this category' : ''}.</p>
            <button className="fb-empty-cta" onClick={openForm}>Be the first →</button>
          </div>
        ) : (
          <div className="fb-feed">
            {visible.map(post => {
              const cat = CAT_MAP[post.category] || CAT_MAP.general
              const voted = myVotes.has(post.id)
              return (
                <div key={post.id} className="fb-post">
                  {/* Vote column */}
                  <button
                    className={`fb-vote ${voted ? 'fb-vote--active' : ''}`}
                    onClick={() => toggleVote(post.id)}
                    aria-label={voted ? 'Remove vote' : 'Upvote'}
                  >
                    <svg width="14" height="10" viewBox="0 0 14 10" fill="none"><path d="M7 0L13.5 9.5H0.5L7 0Z" fill="currentColor"/></svg>
                    <span>{post.votes}</span>
                  </button>

                  {/* Content */}
                  <div className="fb-post-body">
                    <span className={`fb-tag fb-tag--${post.category}`}>
                      {cat.icon} {cat.label}
                    </span>
                    <p className="fb-post-text">{post.body}</p>
                    <div className="fb-post-meta">
                      <span>{post.author_name}</span>
                      <span className="fb-meta-dot">·</span>
                      <span>{timeAgo(post.created_at)}</span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}
