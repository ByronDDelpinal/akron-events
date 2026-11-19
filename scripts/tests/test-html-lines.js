/** test-html-lines.js — visible lines from hand-built HTML. */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { htmlLines } from '../lib/html-lines.js'

describe('htmlLines', () => {
  it('ends a line at <br> and at the end of a block, and nowhere else', () => {
    assert.deepEqual(htmlLines('<div><p>One <strong>bold</strong> line</p><p>Two<br>Three<br/>Four</p><ul><li>Five</li></ul></div>'),
      ['One bold line', 'Two', 'Three', 'Four', 'Five'])
  })
  it('drops scripts, styles, comments and empty lines', () => {
    assert.deepEqual(htmlLines('<style>p{}</style><script>var a="<p>x</p>"</script><!-- <p>hidden</p> --><p> </p><p>Shown</p>'), ['Shown'])
  })
  it('decodes entities and collapses no-break and zero-width spaces', () => {
    assert.deepEqual(htmlLines('<p>Jan&nbsp;9th &amp;&nbsp;&nbsp; 10th\u200b</p>'), ['Jan 9th & 10th'])
  })
  it('returns nothing for nothing', () => {
    assert.deepEqual(htmlLines(''), [])
    assert.deepEqual(htmlLines(undefined), [])
  })
})
