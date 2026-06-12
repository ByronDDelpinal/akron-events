/**
 * ESLint 9 flat config for Akron Pulse.
 *
 * Replaces .eslintrc.cjs (ESLint 8). Two lint surfaces, two scripts:
 *   npm run lint      — scripts/ (Node scrapers + tooling)
 *   npm run lint:src  — src/ (React + TypeScript)
 *
 * Both run with --max-warnings 0: the codebase is warning-clean, so any new
 * warning fails CI. Deliberate exceptions are inline eslint-disable comments
 * with a justification (grep for eslint-disable to audit them), plus the
 * sanctioned LooseRow/LooseQuery aliases in src/types/index.ts.
 *
 * Rule parity notes vs the old config:
 *   - no-extra-semi dropped (deprecated formatting rule in ESLint 9)
 *   - TypeScript rules now actually run via typescript-eslint
 */
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

// Shared base rules (parity with the old .eslintrc.cjs)
const baseRules = {
  'no-debugger': 'error',
  // ignoreRestSiblings: a `const { drop, ...rest } = obj` that omits keys via
  // rest spread must not flag the extracted-then-discarded siblings (their names
  // document what's being omitted).
  'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
  'prefer-const': 'warn',
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  // Empty catch is an established pattern here: best-effort cleanup and
  // optional parsing where failure is expected (see scripts/lib/puppeteer.js).
  'no-empty': ['warn', { allowEmptyCatch: true }],
  'no-useless-escape': 'warn',
  'no-constant-condition': 'warn',
  'no-irregular-whitespace': 'warn',
}

export default tseslint.config(
  // ── Global ignores ──────────────────────────────────────────────────────
  {
    ignores: [
      'dist/',
      'dist-verify/',
      'dist-check-*/',
      'node_modules/',
      'public/',
      'data/',
      'supabase/functions/', // Deno runtime — different globals, lint separately if ever needed
      'vite.config.js.timestamp-*',
    ],
  },

  { linterOptions: { reportUnusedDisableDirectives: 'warn' } },

  // ── Node scripts: scrapers, tooling, Vercel functions, config files ─────
  {
    files: ['scripts/**/*.js', 'api/**/*.js', 'middleware.js', '*.config.js', '_tn.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      ...baseRules,
      'no-console': 'off',
    },
  },

  // Puppeteer scripts run page.evaluate() callbacks in browser context —
  // navigator, document, etc. are valid inside those arrow functions.
  {
    files: [
      'scripts/lib/puppeteer.js',
      'scripts/scrape-nightlight.js',
      'scripts/scrape-killbox-comedy.js',
    ],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },

  // ── Frontend: React + TypeScript ────────────────────────────────────────
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      react.configs.flat.recommended,
      react.configs.flat['jsx-runtime'], // React 17+ — no "React must be in scope"
    ],
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      ...baseRules,
      // Core no-unused-vars must be off in TS files; the TS version handles it
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/no-explicit-any': 'warn', // ratchet toward error

      // ── React ──
      'react/prop-types': 'off', // TypeScript covers this
      'react/display-name': 'warn',
      'react/no-unknown-property': 'error',
      // Allow literal apostrophes/quotes in JSX copy; still catch the real
      // typo hazards (stray `>` from a malformed tag, `}` from a broken expr).
      'react/no-unescaped-entities': ['error', { forbid: ['>', '}'] }],

      // ── Hooks ──
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // ── Vite HMR ──
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
    },
  },
)
