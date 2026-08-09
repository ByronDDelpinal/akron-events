/**
 * embedRequest.ts
 *
 * Pure, DOM-free helpers for the "request an embed" form
 * (EmbedRequestForm.tsx) at the bottom of /embed-builder. Mirrors
 * src/lib/feedback.ts's shape (cooldown key/window, guarded storage
 * access) — kept as its own small module rather than folding into a
 * shared keyed cooldown helper, deliberately: that generalization is
 * arguably cleaner, but it means touching feedback.ts's working, shipped
 * cooldown path for ~20 lines of savings. Noted as a possible follow-up in
 * docs/embed-request-capture.md §5.5, out of scope here.
 *
 * All storage reads/writes are wrapped in try/catch (private-mode safe),
 * matching feedback.ts / InstallPrompt.tsx.
 */

export const COOLDOWN_KEY = 'akronpulse_embed_request_cooldown_until'
// 10 minutes, not feedback's 45 seconds: nobody legitimately submits two
// embed requests in a row.
export const COOLDOWN_MS = 10 * 60 * 1000

/** Epoch ms the post-send cooldown ends, or null when there isn't one active. */
export function readCooldownUntil(): number | null {
  try {
    const stored = parseInt(localStorage.getItem(COOLDOWN_KEY) ?? '', 10)
    return Number.isFinite(stored) ? stored : null
  } catch {
    return null
  }
}

export function writeCooldownUntil(untilMs: number): void {
  try {
    localStorage.setItem(COOLDOWN_KEY, String(untilMs))
  } catch { /* ignore — private mode / storage disabled */ }
}

// ── Field validation (client-side; the server — migration 051's CHECK
// constraints — is the real boundary) ─────────────────────────────────────

export const NAME_MAX_LEN = 120
export const ORGANIZATION_MAX_LEN = 160
export const WEBSITE_MAX_LEN = 300
export const NOTE_MAX_LEN = 1000

// Deliberately identical, character-for-character, to
// supabase/functions/subscribe/validate.ts's EMAIL_RE + MAX_EMAIL_LEN. That
// module can't be imported from the frontend (different runtime — Deno vs
// Vite/browser) so this is a KNOWING duplication, not an oversight. Keep
// the regex in sync by hand if it ever changes there.
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const MAX_EMAIL_LEN = 254

export function isValidEmail(email: string): boolean {
  return email.length > 0 && email.length <= MAX_EMAIL_LEN && EMAIL_RE.test(email)
}

/**
 * Normalize + validate a website URL. If the input has no `://`, `https://`
 * is prefixed first (so "example.org" and "https://example.org" both work).
 * Returns the normalized string only when it parses as an absolute URL
 * whose protocol is http: or https: AND carries no userinfo component —
 * this mirrors (but does not replace) the server-side check in
 * notify-embed-request/email.ts's linkifyWebsite; THIS check is advisory
 * only, same as every other client-side validation here. Returns null for
 * empty input (website is optional, D3) or anything that doesn't
 * parse/qualify.
 *
 * The userinfo rejection closes the same `trusted@evil-host` phishing gap
 * linkifyWebsite's docstring describes: a bare `akronpulse.com@evil.com`
 * (no scheme typed) gets `https://` prefixed above into
 * `https://akronpulse.com@evil.com`, which parses as host `evil.com` with
 * `username` `akronpulse.com` — reject it here too, not just server-side,
 * so the builder's own preview never shows it as a "valid" link either.
 */
export function normalizeWebsite(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const candidate = trimmed.includes('://') ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(candidate)
    const isHttpish = url.protocol === 'http:' || url.protocol === 'https:'
    const hasUserinfo = url.username !== '' || url.password !== ''
    if (isHttpish && !hasUserinfo) {
      return candidate
    }
  } catch {
    // malformed — falls through to null
  }
  return null
}
