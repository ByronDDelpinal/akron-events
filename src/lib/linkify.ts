/**
 * linkify.ts — turn bare http(s) URLs inside plain-text event descriptions
 * into external anchor elements.
 *
 * Structured as a pure text layer (splitUrls) plus a thin React layer
 * (linkify) so the URL-splitting logic is unit-testable under node --test
 * without rendering anything (scripts/tests/test-linkify.js).
 *
 * The regex is scheme-anchored (https?://) — bare domains like
 * "example.com" are deliberately NOT linked. Trailing punctuation that is
 * almost certainly sentence punctuation rather than part of the URL is
 * trimmed back into the surrounding text, with one ')' retained per
 * unmatched '(' inside the URL (Wikipedia-style "..._(band)" paths).
 */
import { createElement, type ReactNode } from 'react'

export interface UrlSegment {
  type: 'text' | 'url'
  value: string
}

const URL_RE = /https?:\/\/[^\s<>"']+/g
const TRAILING_PUNCT_RE = /[.,;:!?'"»›)\]}]+$/

/** Trim trailing punctuation off a raw regex match, keeping one ')' per
 *  unmatched '(' inside the URL. Exported for tests. */
export function trimUrl(raw: string): string {
  const trailing = TRAILING_PUNCT_RE.exec(raw)?.[0] ?? ''
  if (!trailing) return raw
  let url = raw.slice(0, raw.length - trailing.length)
  let unmatchedOpens = 0
  for (const ch of url) {
    if (ch === '(') unmatchedOpens++
    else if (ch === ')' && unmatchedOpens > 0) unmatchedOpens--
  }
  for (const ch of trailing) {
    if (ch !== ')' || unmatchedOpens === 0) break
    url += ')'
    unmatchedOpens--
  }
  return url
}

/** Pure splitter: text → ordered segments of plain text and URLs.
 *  Concatenating every segment's value reproduces the input exactly. */
export function splitUrls(text: string): UrlSegment[] {
  const segments: UrlSegment[] = []
  let last = 0
  for (const match of text.matchAll(URL_RE)) {
    const start = match.index ?? 0
    const url = trimUrl(match[0])
    if (start > last) segments.push({ type: 'text', value: text.slice(last, start) })
    segments.push({ type: 'url', value: url })
    last = start + url.length
  }
  if (last < text.length) segments.push({ type: 'text', value: text.slice(last) })
  return segments
}

/** React layer: interleave plain text with safe external anchors. */
export function linkify(text: string): ReactNode[] {
  return splitUrls(text).map((seg, i) =>
    seg.type === 'url'
      ? createElement(
          'a',
          { key: i, href: seg.value, target: '_blank', rel: 'noopener noreferrer nofollow' },
          seg.value,
        )
      : seg.value,
  )
}
