module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    // Type-aware linting: every linted file must belong to a tsconfig.
    // `project: true` auto-discovers the nearest tsconfig.json per file — which
    // works for src/ (tsconfig.json) and scripts/ (scripts/tsconfig.json), but
    // NOT for graph-service tests/scripts/config files, whose nearest
    // tsconfig.json (the service's) *excludes* them. Those are mapped explicitly
    // in `overrides` below. `tsconfigRootDir` pins the project paths to this
    // config's directory so they resolve the same whether eslint runs from the
    // repo root (CI/verify) or the service dir.
    project: true,
    tsconfigRootDir: __dirname,
  },
  plugins: ['@typescript-eslint', 'security'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:@typescript-eslint/recommended-requiring-type-checking',
    'plugin:security/recommended-legacy',
  ],
  rules: {
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/explicit-function-return-type': 'warn',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'no-console': 'off',
    'prefer-const': 'error',
  },
  overrides: [
    {
      // graph-service tests, service scripts, and root config files live outside
      // tsconfig.json's `include` — point the type-aware parser at the test
      // tsconfig (which includes src + tests + scripts + *.config.ts) so they
      // can be linted at all.
      files: [
        'services/graph-service/tests/**/*.ts',
        'services/graph-service/scripts/**/*.ts',
        'services/graph-service/*.config.ts',
      ],
      parserOptions: {
        project: ['services/graph-service/tsconfig.test.json'],
      },
    },
    {
      // Test and config files: relax the type-strictness/style rules they
      // legitimately trip (mocks use `any`; callbacks omit return types), while
      // KEEPING correctness + security rules — notably no-unused-vars and
      // no-floating-promises (a missing `await` in a test is a silent false-green).
      files: ['**/*.test.ts', 'services/graph-service/tests/**/*.ts', '**/*.config.ts'],
      rules: {
        '@typescript-eslint/explicit-function-return-type': 'off',
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-unsafe-argument': 'off',
        '@typescript-eslint/no-unsafe-assignment': 'off',
        '@typescript-eslint/no-unsafe-call': 'off',
        '@typescript-eslint/no-unsafe-member-access': 'off',
        '@typescript-eslint/no-unsafe-return': 'off',
        '@typescript-eslint/no-non-null-assertion': 'off',
      },
    },
    {
      // Build/ops tooling (diagram + changelog + insomnia generators, admin
      // probes): their whole job is reading/writing KNOWN repo paths and indexing
      // into parsed structures with controlled keys. detect-non-literal-fs-filename
      // and detect-object-injection target untrusted-input *web-handler* patterns —
      // every hit here is a false positive on trusted, bounded input. Scope just
      // those two out for the scripts; ALL other security rules stay on (notably
      // detect-child-process and detect-unsafe-regex), as do the type-checking
      // correctness rules.
      files: ['scripts/**/*.ts', 'services/graph-service/scripts/**/*.ts'],
      rules: {
        'security/detect-non-literal-fs-filename': 'off',
        'security/detect-object-injection': 'off',
      },
    },
  ],
  env: {
    node: true,
    es2022: true,
  },
};
