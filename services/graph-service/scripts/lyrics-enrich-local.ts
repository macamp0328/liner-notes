/**
 * lyrics-enrich-local.ts — operator-run, residential-IP Genius lyrics harvest (issue #258).
 *
 * WHY THIS EXISTS
 * Genius's Cloudflare edge 403s the prod EC2 datacenter IP (#240), so prod runs LRCLIB-only
 * and GENIUS_TOKEN is intentionally UNSET in prod. This standalone script runs the SAME
 * production enrichLyrics pipeline from an operator's home connection — a non-blocked egress —
 * to backfill the Genius lyrics LRCLIB missed (#241 sized this at ~87 genuine), writing them
 * straight to the prod graph. Re-run occasionally as the collection grows.
 *
 * It is deliberately NOT the Fastify server: no schema apply, no reload-resume, no keep-warm
 * timer — just load env -> build driver -> enrichLyrics -> log summary -> exit. enrichLyrics is
 * reused verbatim (no copy-paste drift): it does LRCLIB-first, the #253 Genius header strip, and
 * setTrackLyrics(..., 'genius').
 *
 * USAGE
 *   pnpm lyrics:enrich:prod
 *     — the common case: defaults --env to services/graph-service/.env.prod.local.
 *
 *   pnpm --filter graph-service exec tsx scripts/lyrics-enrich-local.ts --env <path>
 *     — an explicit env file. NOTE: --env resolves relative to CWD, and under the filtered
 *       `pnpm exec` the CWD is services/graph-service/, NOT the repo root — so prefer an ABSOLUTE
 *       path. An explicitly-passed --env that doesn't resolve now hard-errors; it no longer soft-
 *       falls back to process.env (which used to surface later as a confusing "Missing NEO4J_URI"
 *       that hid the real bad-path cause — #373).
 *
 *   pnpm lyrics:enrich:local
 *     — uses the default services/graph-service/.env.local, for a local target.
 *
 *   Flags: --env <path> (env file; default services/graph-service/.env.local). --allow-local
 *   permits a localhost/loopback NEO4J_URI; without it the script refuses one as a likely wrong
 *   --env, since the harvest is meant for the prod graph.
 *
 * The --env file must hold the read-WRITE PROD creds plus GENIUS_TOKEN:
 *   NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD, GENIUS_TOKEN   (optional GENIUS_USER_AGENT)
 * Keep it SEPARATE from your dev .env.local so the harvest can't accidentally target localhost —
 * the script prints the resolved Neo4j host before it writes, so confirm it's the prod host.
 * Prod already ran LRCLIB, so the remaining lyrics-null candidates ARE the LRCLIB misses ->
 * Genius fires for them from the residential IP (200, not 403).
 *
 * STALENESS — the difference between "works" and "silently no-ops":
 * prod stamped lyricsFetchedAt on every miss, so within the default 30-day window
 * getUnenrichedTracks would exclude them all and this run would find nothing. The script forces
 * ENRICHMENT_STALENESS_DAYS=0 (re-include every lyrics-IS-NULL track regardless of last attempt)
 * unless the operator already set it in the env file.
 *
 * DATA QUALITY — like prod fetchGenius, this writes whatever passes isValidGeniusLyrics with no
 * length floor, so a few editorial-prose / wrong-song rows land too (#241's findings: ~18 of the
 * ~105 stored). That is the accepted "reuse the pipeline as-is" tradeoff; a stricter filter is a
 * separate data-quality follow-up. The summary's `enriched` count is the real per-run yield.
 */
import neo4j from 'neo4j-driver';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { enrichLyrics } from '../src/enrichment/lyrics.js';

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

function loadEnv(): void {
  const explicitEnv = argValue('--env');
  const envPath = explicitEnv ?? fileURLToPath(new URL('../.env.local', import.meta.url));
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
    console.log(`[lyrics-enrich-local] loaded env from ${envPath}`);
    return;
  }
  // An explicitly-passed --env that doesn't resolve is almost always a wrong path — and because it
  // resolves relative to CWD (services/graph-service/ under `pnpm --filter graph-service exec`, NOT
  // the repo root), a repo-root-relative path silently misses. Hard-error here instead of soft-
  // falling back to process.env, which only surfaced later as a confusing "Missing required env var
  // NEO4J_URI" that hid the real cause (#373). Only an omitted --env falls back to process.env.
  if (explicitEnv !== undefined) {
    throw new Error(
      `--env file not found: ${envPath} (resolved relative to CWD ${process.cwd()}). ` +
        `Under \`pnpm --filter graph-service exec\` the CWD is services/graph-service/, not the repo ` +
        `root — pass an absolute path, or use \`pnpm lyrics:enrich:prod\` for the standard ` +
        `services/graph-service/.env.prod.local.`,
    );
  }
  console.log(
    `[lyrics-enrich-local] no --env given; no file at ${envPath} — relying on process.env`,
  );
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

// Host of a bolt/neo4j URI for the "writing to <host>" guard. URIs carry no password (creds
// go through auth.basic), so this leaks nothing; the try/catch keeps an odd URI from crashing
// before the driver gives a clearer connection error.
function hostOf(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

// localhost / loopback detection for the prod-write guard. `host` may carry a :port and IPv6
// brackets (e.g. "localhost:7687", "[::1]:7687"); strip both before comparing.
function isLocalHost(host: string): boolean {
  const name = host
    .replace(/:\d+$/, '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  return name === 'localhost' || name === '127.0.0.1' || name === '::1' || name === '0.0.0.0';
}

async function main(): Promise<void> {
  loadEnv();
  const uri = requireEnv('NEO4J_URI');
  const user = requireEnv('NEO4J_USER');
  const password = requireEnv('NEO4J_PASSWORD');

  if (!process.env['GENIUS_TOKEN']) {
    throw new Error(
      'GENIUS_TOKEN is required — this harvest only adds value via the Genius fallback ' +
        '(prod already ran LRCLIB). Set it in the --env file alongside the prod creds.',
    );
  }

  // Prod stamped lyricsFetchedAt on every LRCLIB miss; within the default 30-day staleness
  // window getUnenrichedTracks would exclude them and this run would silently no-op. Force a
  // 0-day window so every lyrics-IS-NULL track is re-included. Operator may override in --env.
  if (!process.env['ENRICHMENT_STALENESS_DAYS']) {
    process.env['ENRICHMENT_STALENESS_DAYS'] = '0';
  }

  // This script WRITES (SET) to whatever DB the env points at. Surface the target host (no
  // creds) so a wrong --env (e.g. a dev .env.local -> localhost) is caught before any write, and
  // hard-refuse a local target unless --allow-local is passed — the harvest's purpose is the prod
  // Aura graph, so a localhost run is almost always an accidental wrong --env.
  const targetHost = hostOf(uri);
  console.log(`[lyrics-enrich-local] target Neo4j host: ${targetHost}`);
  if (isLocalHost(targetHost) && !process.argv.includes('--allow-local')) {
    throw new Error(
      `Refusing to run against a local target (${targetHost}) — this harvest writes to the graph ` +
        `at NEO4J_URI and is meant for the prod Aura graph. Point --env at the prod creds, or pass ` +
        `--allow-local to target localhost deliberately.`,
    );
  }
  console.log(
    `[lyrics-enrich-local] ENRICHMENT_STALENESS_DAYS=${process.env['ENRICHMENT_STALENESS_DAYS']}`,
  );

  const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  try {
    const summary = await enrichLyrics(driver, console);
    console.log(
      `[lyrics-enrich-local] done: enriched=${summary.enriched}, skipped=${summary.skipped}, ` +
        `failed=${summary.failed}, duration=${summary.durationMs}ms`,
    );
  } finally {
    await driver.close();
  }
}

main().catch((err: unknown) => {
  console.error('[lyrics-enrich-local] fatal:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
