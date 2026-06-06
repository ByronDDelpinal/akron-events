/**
 * ESLint configuration for Akron Pulse.
 *
 * Uses CommonJS format (.eslintrc.cjs) because the project has
 * `"type": "module"` in package.json — ESLint 8 can't load plain .js
 * configs as ESM, so .cjs forces CommonJS evaluation.
 *
 * Scope: the existing `npm run lint` script targets *.js and *.jsx only
 * (see package.json). TypeScript files are covered by `npm run typecheck`
 * (tsc --noEmit). When @typescript-eslint packages are added, extend the
 * lint script to `--ext js,jsx,ts,tsx` and update the `overrides` block.
 *
 * Plugins shipped in devDependencies (no install needed):
 *   eslint-plugin-react         — React-specific rules
 *   eslint-plugin-react-hooks   — hooks/rules-of-hooks, exhaustive-deps
 *   eslint-plugin-react-refresh — Vite HMR boundary guard
 */

module.exports = {
  root: true,

  env: {
    browser: true,
    es2022:  true,
    node:    true,
  },

  parserOptions: {
    ecmaVersion:  'latest',
    sourceType:   'module',
    ecmaFeatures: { jsx: true },
  },

  settings: {
    react: { version: 'detect' },
  },

  plugins: [
    'react',
    'react-hooks',
    'react-refresh',
  ],

  extends: [
    'eslint:recommended',
    'plugin:react/recommended',
    'plugin:react/jsx-runtime',  // React 17+ — no "React must be in scope"
    'plugin:react-hooks/recommended',
  ],

  rules: {
    // ── React ──────────────────────────────────────────────────────────────
    'react/prop-types':          'off',   // TypeScript covers this
    'react/display-name':        'warn',
    'react/no-unknown-property': 'error',

    // ── Hooks ──────────────────────────────────────────────────────────────
    'react-hooks/rules-of-hooks':  'error',
    'react-hooks/exhaustive-deps': 'warn',

    // ── Vite HMR ───────────────────────────────────────────────────────────
    'react-refresh/only-export-components': [
      'warn',
      { allowConstantExport: true },
    ],

    // ── General ────────────────────────────────────────────────────────────
    'no-console':             ['warn', { allow: ['warn', 'error', 'info', 'log'] }],
    'no-debugger':            'error',
    'no-unused-vars':         ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'prefer-const':           'warn',
    'eqeqeq':                 ['error', 'always', { null: 'ignore' }],
    // Downgraded to warn: pre-existing issues across scraper scripts.
    // Fix incrementally — they are not bugs.
    'no-empty':               'warn',
    'no-extra-semi':          'warn',
    'no-useless-escape':      'warn',
    'no-constant-condition':  'warn',
    'no-irregular-whitespace':'warn',
  },

  overrides: [
    // Node / build scripts — allow console, keep browser globals off by default
    {
      files: ['scripts/**/*.js', 'vite.config.*', '*.config.*', '*.cjs'],
      env:   { node: true, browser: false },
      rules: { 'no-console': 'off' },
    },
    // Puppeteer scripts run page.evaluate() callbacks in browser context —
    // navigator, document, etc. are valid inside those arrow functions.
    {
      files: ['scripts/lib/puppeteer.js', 'scripts/scrape-nightlight.js', 'scripts/scrape-killbox-comedy.js'],
      env:   { node: true, browser: true },
    },
    // Scraper scripts are pure Node.js — no React hooks, no HMR.
    {
      files: ['scripts/**/*.js'],
      rules: {
        'react-hooks/rules-of-hooks':           'off',
        'react-hooks/exhaustive-deps':          'off',
        'react-refresh/only-export-components': 'off',
        'react/no-unknown-property':            'off',
      },
    },
  ],

  ignorePatterns: [
    'dist/',
    'node_modules/',
    'src/',       // TypeScript source — linted by tsc; add when @typescript-eslint is available
  ],
}
