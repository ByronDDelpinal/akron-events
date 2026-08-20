/**
 * test-feedback-draft.js
 *
 * Unit tests for src/lib/feedback.ts's draft + email contracts.
 *
 * feedback.ts's own header says it is "kept separate from
 * FeedbackDialog.tsx so the cooldown and draft contracts are independently
 * testable without a DOM" -- this file is what makes that claim true, and
 * puts the draft contract behind CI gate 6 (`npm test`) rather than behind
 * a manual click-through.
 *
 * Follows scripts/tests/test-plan-map.js's precedent of importing the .ts
 * module directly and shimming the browser storage global it depends on.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  DRAFT_KEY,
  DRAFT_TTL_MS,
  EMAIL_MAX_LEN,
  readDraft,
  writeDraft,
  clearDraft,
  hasDraftContent,
  isPlausibleEmail,
} from '../../src/lib/feedback.ts'

/** Minimal in-memory localStorage shim -- see test-plan-map.js's note: this
 *  environment has no global localStorage, and feedback.ts's try/catch
 *  swallows the ReferenceError, which would make every assertion below pass
 *  for the wrong reason (a null draft, not a parsed one). */
function makeMemoryStorage() {
  const store = new Map()
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: (k) => { store.delete(k) },
    clear: () => store.clear(),
  }
}

/** Runs fn with a fresh in-memory localStorage, restoring the global after. */
function withStorage(fn, storage = makeMemoryStorage()) {
  const previous = globalThis.localStorage
  globalThis.localStorage = storage
  try {
    return fn(storage)
  } finally {
    if (previous === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previous
  }
}

describe('feedback draft: round-trip', () => {
  it('carries body, email and the origin pagePath', () => {
    withStorage(() => {
      writeDraft('the map is wrong', 'a@b.co', '/events/some-event')
      const draft = readDraft()
      assert.equal(draft.body, 'the map is wrong')
      assert.equal(draft.email, 'a@b.co')
      assert.equal(draft.pagePath, '/events/some-event')
      assert.equal(typeof draft.savedAt, 'number')
    })
  })

  it('a draft with only an email (no body yet) still persists', () => {
    withStorage(() => {
      writeDraft('', 'a@b.co', '/about')
      assert.equal(readDraft().email, 'a@b.co')
    })
  })
})

describe('feedback draft: pagePath is sticky (the reason it is stored at all)', () => {
  it('a later write from a DIFFERENT page keeps the page the note was started on', () => {
    withStorage(() => {
      writeDraft('started here', '', '/events/lock-3-concert')
      // Visitor navigates, reopens the dialog on another page, keeps typing.
      writeDraft('started here and continued', '', '/')
      assert.equal(
        readDraft().pagePath,
        '/events/lock-3-concert',
        'restoring a draft elsewhere must not relabel where it came from',
      )
    })
  })

  it('a brand-new draft after a clear takes the CURRENT page', () => {
    withStorage(() => {
      writeDraft('first note', '', '/events/a')
      clearDraft()
      writeDraft('unrelated second note', '', '/calendar')
      assert.equal(readDraft().pagePath, '/calendar')
    })
  })

  it('erasing the note and starting over on a new page re-stamps the page', () => {
    withStorage(() => {
      writeDraft('first note', '', '/events/a')
      writeDraft('', '', '/events/a')            // visitor erases it
      writeDraft('different note', '', '/venues') // ...and types a new one elsewhere
      assert.equal(readDraft().pagePath, '/venues')
    })
  })
})

describe('feedback draft: nothing worth saving is not saved', () => {
  it('open-then-close with an untouched form leaves NO storage entry', () => {
    withStorage((storage) => {
      writeDraft('', '', '/')
      assert.equal(storage.getItem(DRAFT_KEY), null)
      assert.equal(readDraft(), null)
    })
  })

  it('whitespace-only input is not content', () => {
    withStorage((storage) => {
      writeDraft('   \n\t ', '  ', '/')
      assert.equal(storage.getItem(DRAFT_KEY), null)
    })
  })

  it('erasing an existing draft REMOVES it rather than storing a blank one', () => {
    withStorage((storage) => {
      writeDraft('something', '', '/')
      assert.notEqual(storage.getItem(DRAFT_KEY), null)
      writeDraft('', '', '/')
      assert.equal(storage.getItem(DRAFT_KEY), null, 'erasing must be a real "never mind"')
    })
  })

  it('hasDraftContent agrees with that rule', () => {
    assert.equal(hasDraftContent('', ''), false)
    assert.equal(hasDraftContent('  ', ' '), false)
    assert.equal(hasDraftContent('x', ''), true)
    assert.equal(hasDraftContent('', 'a@b.co'), true)
  })
})

describe('feedback draft: TTL actually bounds how long a note sits on disk', () => {
  it('a draft one millisecond past the TTL is not returned AND is deleted', () => {
    withStorage((storage) => {
      storage.setItem(DRAFT_KEY, JSON.stringify({
        body: 'stale note on a shared library machine',
        email: 'someone@example.com',
        pagePath: '/',
        savedAt: Date.now() - DRAFT_TTL_MS - 1,
      }))
      assert.equal(readDraft(), null)
      assert.equal(
        storage.getItem(DRAFT_KEY),
        null,
        'an expired draft must be cleared, not just hidden -- it is the whole point of the TTL',
      )
    })
  })

  it('a draft just inside the TTL still restores', () => {
    withStorage((storage) => {
      storage.setItem(DRAFT_KEY, JSON.stringify({
        body: 'recent', email: '', pagePath: '/x', savedAt: Date.now() - DRAFT_TTL_MS + 60_000,
      }))
      assert.equal(readDraft().body, 'recent')
    })
  })
})

describe('feedback draft: hostile / legacy storage never throws', () => {
  it('malformed JSON degrades to null', () => {
    withStorage((storage) => {
      storage.setItem(DRAFT_KEY, '{not json at all')
      assert.equal(readDraft(), null)
    })
  })

  it('a draft missing savedAt is rejected', () => {
    withStorage((storage) => {
      storage.setItem(DRAFT_KEY, JSON.stringify({ body: 'x', email: '' }))
      assert.equal(readDraft(), null)
    })
  })

  it('a PRE-pagePath draft still restores, with pagePath falling back to empty', () => {
    // Exactly what a draft written by the build before pagePath existed
    // looks like on disk. It must not be thrown away.
    withStorage((storage) => {
      storage.setItem(DRAFT_KEY, `{"body":"written before pagePath shipped","email":"a@b.co","savedAt":${Date.now()}}`)
      const draft = readDraft()
      assert.equal(draft.body, 'written before pagePath shipped')
      assert.equal(draft.pagePath, '')
    })
  })

  it('a non-string email degrades to empty rather than poisoning the input', () => {
    withStorage((storage) => {
      storage.setItem(DRAFT_KEY, JSON.stringify({ body: 'x', email: { evil: true }, savedAt: Date.now() }))
      assert.equal(readDraft().email, '')
    })
  })

  it('storage that throws on every call (private mode) is survivable', () => {
    const throwing = {
      getItem: () => { throw new Error('SecurityError') },
      setItem: () => { throw new Error('QuotaExceededError') },
      removeItem: () => { throw new Error('SecurityError') },
    }
    withStorage(() => {
      assert.equal(readDraft(), null)
      assert.doesNotThrow(() => writeDraft('x', '', '/'))
      assert.doesNotThrow(() => clearDraft())
    }, throwing)
  })
})

describe('isPlausibleEmail', () => {
  it('accepts ordinary addresses', () => {
    for (const ok of ['a@b.co', 'first.last@sub.domain.org', 'x+tag@example.com']) {
      assert.equal(isPlausibleEmail(ok), true, ok)
    }
  })

  it('rejects the shapes a typo actually produces', () => {
    for (const bad of ['', 'plainstring', 'no@tld', '@nolocal.com', 'no domain@x.com', 'two@@at.com']) {
      assert.equal(isPlausibleEmail(bad), false, bad)
    }
  })

  it('rejects anything containing CR/LF, so a header-injection string can never reach replyTo', () => {
    // notify-feedback/index.ts gates the Resend replyTo header on this same
    // shape check; \s covers CR and LF, which is the property it relies on.
    for (const bad of ['a@b.co\r\nBcc: victim@x.com', 'a@b.co\nSubject: x', 'a\r@b.co']) {
      assert.equal(isPlausibleEmail(bad), false, JSON.stringify(bad))
    }
  })

  it('cannot match a string carrying a second full address (mailto recipient injection)', () => {
    assert.equal(isPlausibleEmail('victim@x.co,attacker@evil.com'), false)
  })

  it('rejects the address-list separators , and ; outright', () => {
    // Not merely an injection concern: Resend 422s a replyTo containing one,
    // and notify-feedback's send is fire-and-forget, so that 422 silently
    // drops the ENTIRE operator notification rather than just the header.
    // notify-feedback/index.ts carries a byte-identical copy of this regex.
    for (const bad of ['a@b.co,c', 'a,b@c.co', 'a@b.co;c', 'a;b@c.co']) {
      assert.equal(isPlausibleEmail(bad), false, bad)
    }
  })

  it('EMAIL_MAX_LEN matches the DB bound in migration 058', () => {
    assert.equal(EMAIL_MAX_LEN, 254)
  })
})
