/**
 * test-linkify.js — unit tests for src/lib/linkify.ts, the bare-URL
 * autolinker used by EventPage's description renderer.
 *
 * The React layer (linkify) is a thin map over the pure splitter
 * (splitUrls), so these tests exercise the splitting/trimming logic
 * directly plus one light shape-check on the produced anchor elements.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { splitUrls, trimUrl, linkify } from '../../src/lib/linkify.ts'

describe('splitUrls — pure text/url segmentation', () => {
  it('text with no URL comes back as a single text segment', () => {
    assert.deepEqual(splitUrls('Free and open to all.'), [
      { type: 'text', value: 'Free and open to all.' },
    ])
  })

  it('bare domains without a scheme are NOT linked', () => {
    assert.deepEqual(splitUrls('visit example.com today'), [
      { type: 'text', value: 'visit example.com today' },
    ])
  })

  it('the PorchRokr trailing sentence: URL at end of description, no trailing punctuation', () => {
    assert.deepEqual(
      splitUrls('Free and open to all. Listen: https://adulthumanchicken.bandcamp.com/'),
      [
        { type: 'text', value: 'Free and open to all. Listen: ' },
        { type: 'url', value: 'https://adulthumanchicken.bandcamp.com/' },
      ],
    )
  })

  it('a trailing period stays in the text, not the link', () => {
    assert.deepEqual(splitUrls('See https://example.com/page.'), [
      { type: 'text', value: 'See ' },
      { type: 'url', value: 'https://example.com/page' },
      { type: 'text', value: '.' },
    ])
  })

  it('a trailing comma stays in the text', () => {
    assert.deepEqual(splitUrls('Tickets at https://example.com/buy, doors at 7'), [
      { type: 'text', value: 'Tickets at ' },
      { type: 'url', value: 'https://example.com/buy' },
      { type: 'text', value: ', doors at 7' },
    ])
  })

  it('a URL wrapped in parentheses sheds the closing paren', () => {
    assert.deepEqual(splitUrls('the site (https://example.com/a) has details'), [
      { type: 'text', value: 'the site (' },
      { type: 'url', value: 'https://example.com/a' },
      { type: 'text', value: ') has details' },
    ])
  })

  it("paren balancing: a Wikipedia-style '_(band)' path keeps its ')'", () => {
    assert.deepEqual(splitUrls('See https://en.wikipedia.org/wiki/Devo_(band).'), [
      { type: 'text', value: 'See ' },
      { type: 'url', value: 'https://en.wikipedia.org/wiki/Devo_(band)' },
      { type: 'text', value: '.' },
    ])
  })

  it('mid-sentence URL splits into text / url / text', () => {
    assert.deepEqual(splitUrls('Go to https://example.com/x then turn left'), [
      { type: 'text', value: 'Go to ' },
      { type: 'url', value: 'https://example.com/x' },
      { type: 'text', value: ' then turn left' },
    ])
  })

  it('multiple URLs in one block, http and https', () => {
    assert.deepEqual(splitUrls('A https://a.example/1, B http://b.example/2.'), [
      { type: 'text', value: 'A ' },
      { type: 'url', value: 'https://a.example/1' },
      { type: 'text', value: ', B ' },
      { type: 'url', value: 'http://b.example/2' },
      { type: 'text', value: '.' },
    ])
  })

  it('segments always concatenate back to the exact input', () => {
    const inputs = [
      'no urls at all',
      'end https://example.com/a.',
      '(https://example.com/(nested)) done',
      'https://a.example/1 and https://b.example/2!',
      'Listen: https://open.spotify.com/artist/4CzpNCRyXnqAiDCPJ1tGxj',
    ]
    for (const input of inputs) {
      const joined = splitUrls(input).map((s) => s.value).join('')
      assert.equal(joined, input)
    }
  })
})

describe('trimUrl — trailing punctuation with paren balancing', () => {
  it('strips runs of sentence punctuation', () => {
    assert.equal(trimUrl('https://example.com/a).'), 'https://example.com/a')
    assert.equal(trimUrl('https://example.com/a?!"'), 'https://example.com/a')
    assert.equal(trimUrl("https://example.com/a';"), 'https://example.com/a')
  })

  it("keeps one ')' per unmatched '(' inside the URL", () => {
    assert.equal(trimUrl('https://x.example/wiki/Foo_(bar).'), 'https://x.example/wiki/Foo_(bar)')
    assert.equal(trimUrl('https://x.example/(a)).'), 'https://x.example/(a)')
  })

  it('leaves an unpunctuated URL alone', () => {
    assert.equal(trimUrl('https://example.com/a'), 'https://example.com/a')
  })
})

describe('linkify — React layer', () => {
  it('interleaves strings with safe external anchor elements', () => {
    const nodes = linkify('Listen: https://example.com/a.')
    assert.equal(nodes.length, 3)
    assert.equal(nodes[0], 'Listen: ')
    assert.equal(nodes[2], '.')
    const anchor = nodes[1]
    assert.equal(anchor.type, 'a')
    assert.equal(anchor.props.href, 'https://example.com/a')
    assert.equal(anchor.props.target, '_blank')
    assert.equal(anchor.props.rel, 'noopener noreferrer nofollow')
    assert.equal(anchor.props.children, 'https://example.com/a')
  })

  it('plain text yields a single string node', () => {
    assert.deepEqual(linkify('nothing to link'), ['nothing to link'])
  })
})
