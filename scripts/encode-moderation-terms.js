/**
 * encode-moderation-terms.js
 *
 * Turns a local moderation term list (JSON) into the base64 value used by the
 * MODERATION_TERMS_B64 environment variable. The list itself is NEVER committed
 * (see .gitignore); this helper just encodes a local copy so you can paste the
 * value into .env / Vercel / Supabase secrets / CI.
 *
 * Usage:
 *   node scripts/encode-moderation-terms.js [path-to-json]
 *     # default path: data/moderation/flagged-terms.json
 *
 *   # write straight into your local .env (gitignored):
 *   echo "MODERATION_TERMS_B64=$(node scripts/encode-moderation-terms.js)" >> .env
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const inputPath = process.argv[2]
  ? resolve(process.argv[2])
  : join(HERE, '..', 'data', 'moderation', 'flagged-terms.json')

let json
try {
  json = JSON.parse(readFileSync(inputPath, 'utf8'))
} catch (err) {
  console.error(`✖ Could not read/parse ${inputPath}\n  ${err.message}`)
  process.exit(1)
}

// Re-stringify (minified) so the encoded value is compact and canonical.
const b64 = Buffer.from(JSON.stringify(json), 'utf8').toString('base64')

// Quick sanity summary to stderr; the base64 value goes to stdout so it can be
// piped/captured cleanly.
const termCount = (json.categories ?? []).reduce((n, c) => n + (c.terms?.length ?? 0), 0)
process.stderr.write(
  `✓ Encoded ${termCount} terms / ${(json.categories ?? []).length} categories ` +
  `→ ${b64.length} base64 chars (~${(Buffer.byteLength(b64) / 1024).toFixed(1)} KB)\n`,
)
process.stdout.write(b64 + '\n')
