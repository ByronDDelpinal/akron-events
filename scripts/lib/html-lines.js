/**
 * html-lines.js — turn a hand-built page into the lines a reader sees.
 *
 * Small organizations publish schedules as paragraphs and line breaks, not as
 * data. The scrapers for those pages work on visible lines, so the one thing
 * that has to be right is where a line ends: at a <br> and at the end of a
 * block element, and nowhere else.
 *
 * Scripts, styles and SVG are dropped. Entities are decoded. Inside a line,
 * runs of whitespace (including no-break and zero-width spaces) collapse to
 * one space. Empty lines are removed.
 */
import { decodeEntities } from './normalize.js'

const BLOCK_END = /<br\b[^>]*>|<\/(?:p|div|h[1-6]|li|ul|ol|tr|td|th|section|article|header|footer|blockquote)>/gi

export function htmlLines(html = '') {
  const text = String(html)
    .replace(/<(script|style|svg|noscript)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(BLOCK_END, '\n')
    .replace(/<[^>]*>/g, '')
  return decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/[\u00a0\u200b\ufeff]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}
