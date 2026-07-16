/**
 * backup-restore.ts — operator-run restore of a #104 S3 graph backup into a Neo4j target.
 *
 * WHY THIS EXISTS
 * The weekly CronJob exports the full graph to S3 (see src/backup/). This script is the other
 * half: download an export with `aws s3 cp`, then replay it into a target — the everyday case
 * is a local docker-compose Neo4j (inspecting a backup, restore drills); the rare, deliberate
 * case is prod Aura after data loss. Restore runs locally so prod credentials and AWS access
 * stay in operator hands — there is no restore HTTP endpoint by design.
 *
 * USAGE
 *   aws s3 ls s3://<bucket>/graph-backups/                       # pick a backup
 *   aws s3 cp s3://<bucket>/graph-backups/<file> /tmp/<file>     # fetch it
 *   pnpm backup:restore -- --file /tmp/<file> --yes              # restore into .env.local target
 *
 *   Flags:
 *     --file <path>      the .jsonl.gz (or plain .jsonl) backup file — required
 *     --env <path>       env file with NEO4J_URI/USER/PASSWORD (default services/graph-service/
 *                        .env.local; explicit-but-missing hard-errors — the #373 lesson; prefer
 *                        an absolute path, CWD is services/graph-service/ under pnpm exec)
 *     --yes              actually restore; without it the preflight report prints and nothing
 *                        is written (a safe dry-run)
 *     --wipe             DETACH DELETE the target first. Required when the target is non-empty:
 *                        replay is CREATE-based, so restoring on top of data would duplicate it.
 *     --allow-remote     permit a non-localhost target (prod Aura) — refused otherwise, since
 *                        the everyday target is local and a remote one deserves deliberateness.
 *
 * After the replay the script applies the real schema (constraints/indexes from src/db/schema.ts
 * — a uniqueness violation doubles as a data-integrity alarm) and diffs the restored counts
 * against the file's manifest, exiting 1 on any mismatch or dangling rel.
 */
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import neo4j from 'neo4j-driver';
import type { Driver } from 'neo4j-driver';
import { collectBackup, countGraph, restoreGraph, verifyRestore } from '../src/backup/restore.js';
import type { ParsedBackup } from '../src/backup/restore.js';
import { applySchema } from '../src/db/schema.js';
import { wipeGraph } from '../src/db/ingestion-repository.js';

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

function loadEnv(): void {
  const explicitEnv = argValue('--env');
  const envPath = explicitEnv ?? fileURLToPath(new URL('../.env.local', import.meta.url));
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
    console.log(`[backup-restore] loaded env from ${envPath}`);
    return;
  }
  if (explicitEnv !== undefined) {
    throw new Error(
      `--env file not found: ${envPath} (resolved relative to CWD ${process.cwd()}). ` +
        `Under \`pnpm --filter graph-service exec\` the CWD is services/graph-service/, not the ` +
        `repo root — pass an absolute path.`,
    );
  }
  console.log(`[backup-restore] no --env given; no file at ${envPath} — relying on process.env`);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`Missing required env var ${name}`);
  return value;
}

function hostOf(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

function isLocalHost(host: string): boolean {
  const name = host
    .replace(/:\d+$/, '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  return name === 'localhost' || name === '127.0.0.1' || name === '::1' || name === '0.0.0.0';
}

async function readBackupFile(path: string): Promise<ParsedBackup> {
  if (!existsSync(path)) throw new Error(`--file not found: ${path}`);
  const raw = createReadStream(path);
  const stream = path.endsWith('.gz') ? raw.pipe(createGunzip()) : raw;
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  return collectBackup(lines);
}

async function main(): Promise<void> {
  const file = argValue('--file');
  if (file === undefined) {
    throw new Error('--file <backup.jsonl.gz> is required (fetch one with `aws s3 cp` first)');
  }
  loadEnv();
  const uri = requireEnv('NEO4J_URI');
  const user = requireEnv('NEO4J_USER');
  const password = requireEnv('NEO4J_PASSWORD');

  console.log(`[backup-restore] reading ${file} ...`);
  const backup = await readBackupFile(file);

  const targetHost = hostOf(uri);
  const driver: Driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  try {
    const before = await countGraph(driver);

    console.log('[backup-restore] preflight:');
    console.log(`  backup source host:  ${backup.metadata.sourceHost}`);
    console.log(`  backup exported at:  ${backup.metadata.exportedAt}`);
    console.log(
      `  backup contents:     ${backup.manifest.nodeCount} nodes, ${backup.manifest.relCount} rels`,
    );
    console.log(`  restore target:      ${targetHost}`);
    console.log(`  target currently:    ${before.nodes} nodes, ${before.rels} rels`);

    if (!isLocalHost(targetHost) && !process.argv.includes('--allow-remote')) {
      throw new Error(
        `Refusing to restore to a remote target (${targetHost}) without --allow-remote — the ` +
          `everyday restore target is a local Neo4j; restoring over a remote (prod) instance ` +
          `must be deliberate.`,
      );
    }
    const wipe = process.argv.includes('--wipe');
    if (before.nodes > 0 && !wipe) {
      throw new Error(
        `Target is not empty (${before.nodes} nodes). Replay is CREATE-based — restoring on top ` +
          `of existing data would duplicate it. Pass --wipe to DETACH DELETE the target first.`,
      );
    }
    if (!process.argv.includes('--yes')) {
      console.log('[backup-restore] preview only — no changes made. Re-run with --yes to restore.');
      return;
    }

    if (wipe && before.nodes > 0) {
      console.log(`[backup-restore] wiping target (${before.nodes} nodes) ...`);
      await wipeGraph(driver);
    }

    console.log('[backup-restore] restoring ...');
    const result = await restoreGraph(driver, backup, {
      onProgress: (message) => console.log(`[backup-restore] ${message}`),
    });

    console.log('[backup-restore] applying schema (constraints + indexes) ...');
    await applySchema(driver);

    const after = await countGraph(driver);
    const problems = verifyRestore(backup.manifest, result, after);
    console.log(
      `[backup-restore] done: ${result.nodesCreated} nodes + ${result.relsCreated} rels created; ` +
        `target now has ${after.nodes} nodes, ${after.rels} rels (manifest: ` +
        `${backup.manifest.nodeCount}/${backup.manifest.relCount}).`,
    );
    if (problems.length > 0) {
      for (const problem of problems) console.error(`[backup-restore] VERIFY FAILED: ${problem}`);
      process.exitCode = 1;
    } else {
      console.log('[backup-restore] verification passed — restored graph matches the manifest.');
    }
  } finally {
    await driver.close();
  }
}

main().catch((err: unknown) => {
  console.error('[backup-restore] fatal:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
