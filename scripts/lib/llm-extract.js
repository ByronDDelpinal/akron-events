/**
 * lib/llm-extract.js — RETIRED
 *
 * This module backed the Lock 3 LLM-extraction path while the Revize
 * Calendar JSON feed was dormant (July 2024 → May 2026).  The feed came
 * back online with full structured event data, so the LLM fallback was
 * retired in favour of a 200-line Revize-only scraper.
 *
 * Restore from git history (commit prior to the Revize-resume refactor)
 * if the feed ever goes dormant again.  TODO: run `git rm` on this file
 * — the sandbox that authored this stub couldn't delete the file itself.
 */

throw new Error(
  'lib/llm-extract.js was retired when the Revize feed came back online. ' +
  'No scraper imports this module anymore. If you need LLM extraction, ' +
  'restore the previous version from git history and re-wire a caller.'
)
