/**
 * test-embed-request-website.js — tests for normalizeWebsite in
 * src/lib/embedRequest.ts (the "request an embed" form's client-side
 * website validator).
 *
 * This is the client-side mirror of notify-embed-request/email.ts's
 * linkifyWebsite (see supabase/functions/notify-embed-request/email.test.ts
 * for the server-side tests) — the client check is advisory only, the
 * server is the real boundary, but both must reject the same shapes so the
 * builder's own preview never claims something is "valid" that the server
 * will render as plain text.
 *
 * QA REGRESSION (Finding B): `normalizeWebsite` used to accept a URL with a
 * userinfo component (`user[:pass]@host`), the classic `trusted@evil-host`
 * phishing primitive — e.g. `akronpulse.com@evil.com` (no scheme typed) gets
 * `https://` prefixed into `https://akronpulse.com@evil.com`, which parses
 * fine as protocol https: with host `evil.com`, and used to normalize and
 * return successfully.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeWebsite } from '../../src/lib/embedRequest.ts'

describe('normalizeWebsite: ALLOW cases', () => {
  it('a bare domain (no scheme) is prefixed with https:// and accepted', () => {
    assert.equal(normalizeWebsite('example.org'), 'https://example.org')
  })

  it('an explicit https:// URL is accepted unchanged', () => {
    assert.equal(normalizeWebsite('https://example.org/calendar'), 'https://example.org/calendar')
  })

  it('an explicit http:// URL is accepted unchanged', () => {
    assert.equal(normalizeWebsite('http://example.org'), 'http://example.org')
  })

  it('a benign URL with an "@" in the path still normalizes', () => {
    assert.equal(normalizeWebsite('https://example.org/team/@handle'), 'https://example.org/team/@handle')
  })

  it('a benign URL with an "@" in the query string still normalizes', () => {
    assert.equal(normalizeWebsite('https://example.org/search?q=hello@world'), 'https://example.org/search?q=hello@world')
  })
})

describe('normalizeWebsite: DENY cases', () => {
  it('empty input returns null (website is optional)', () => {
    assert.equal(normalizeWebsite(''), null)
    assert.equal(normalizeWebsite('   '), null)
  })

  it('a non-http(s) scheme (javascript:) is rejected', () => {
    assert.equal(normalizeWebsite('javascript:alert(1)'), null)
  })

  it('a malformed string is rejected', () => {
    assert.equal(normalizeWebsite('not a url at all'), null)
  })

  it('REQUIRED REGRESSION (Finding B): a userinfo-authority phishing URL is rejected, not normalized', () => {
    assert.equal(normalizeWebsite('https://akronpulse.com@evil.com/phish'), null)
  })

  it('REQUIRED REGRESSION (Finding B): userinfo with both username and password is rejected', () => {
    assert.equal(normalizeWebsite('https://user:pass@evil.com'), null)
  })

  it('REQUIRED REGRESSION (Finding B): bare userinfo (no password) is rejected', () => {
    assert.equal(normalizeWebsite('https://user@evil.com'), null)
  })

  it('REQUIRED REGRESSION (Finding B): a scheme-less trusted@evil pattern is rejected after the https:// prefix is added', () => {
    // No "://" in the input, so normalizeWebsite prefixes "https://" itself,
    // producing "https://akronpulse.com@evil.com" — the exact shape this
    // fix must catch even though the submitter never typed a scheme.
    assert.equal(normalizeWebsite('akronpulse.com@evil.com'), null)
  })

  it('REQUIRED REGRESSION (Finding B): userinfo phishing over plain http: is also rejected', () => {
    assert.equal(normalizeWebsite('http://akronpulse.com@evil.com'), null)
  })
})
