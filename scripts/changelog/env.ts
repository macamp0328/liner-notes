// Side-effect import: load local env files so `pnpm changelog:*` picks up
// ANTHROPIC_API_KEY (and CHANGELOG_MODEL) without a manual `export` every time.
//
// Precedence: the real environment (CI secrets) > .env.local > .env. dotenv never
// overrides an already-set variable, so loading .env.local before .env gives local
// files that order while letting a CI-provided value win over both. Both files are
// gitignored. Imported first by the entrypoints; not used by lib.ts (kept pure).

import { config } from 'dotenv';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..', '..');
for (const file of ['.env.local', '.env']) {
  config({ path: resolve(repoRoot, file), quiet: true });
}
