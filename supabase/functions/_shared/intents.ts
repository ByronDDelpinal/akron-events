/**
 * _shared/intents.ts — the single canonical registry of curated intent
 * {id,label} pairs, shared by every Deno edge function that needs it.
 *
 * Split out of _shared/slack.ts (code-reviewer re-review, MINOR 1,
 * 2026-07-27): subscribe/validate.ts imported INTENT_LABELS from
 * _shared/slack.ts to build its closed-registry write-side allowlist
 * (INTENT_IDS) — but slack.ts reads four Slack env vars at module scope and
 * logs on import (see the cold-start console.log in that file). validate.ts's
 * own header claims "no env reads, no client construction," specifically so
 * subscribe/index.ts (a public, unauthenticated, user-facing WRITE endpoint)
 * can import it without side effects — but that claim was false the moment
 * it transitively pulled in slack.ts's module-scope env reads. Nothing is
 * broken by this today (Deno.env.get on a missing var returns undefined
 * rather than throwing, and there is no top-level await anywhere in
 * slack.ts), but it meant `subscribe` hard-depended on the Slack module
 * booting cleanly at load time for no functional reason: one future
 * top-level `await` added to slack.ts (e.g. an async secret fetch) would
 * have stopped signups from booting too, entirely unrelated to whether Slack
 * itself is up or configured.
 *
 * This file has zero dependencies and zero side effects — no Deno.env, no
 * imports, nothing evaluated at module scope beyond the array literal below
 * — so both _shared/slack.ts (renderSignup's "Interests: " bullet) and
 * subscribe/validate.ts (the write-side allowlist) can import it without
 * either pulling in anything the other needs. One registry, no cycle.
 *
 * Mirrors the {id,label} pairs from src/lib/categories.js INTENTS (Deno
 * can't import that frontend/Node-shared module). Update both together —
 * scripts/tests/test-slack-intent-labels.js fails CI when they drift (that
 * test reads THIS file now, not _shared/slack.ts — see its own header).
 */
export const INTENT_LABELS: { id: string; label: string }[] = [
  { id: 'date-night',      label: 'Date Night' },
  { id: 'family',          label: 'Family' },
  { id: 'arts-stage',      label: 'Arts & Stage' },
  { id: 'give-back',       label: 'Give Back' },
  { id: 'outdoors-active', label: 'Outdoors & Active' },
]
