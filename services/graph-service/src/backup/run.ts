/**
 * run.ts — the weekly backup CronJob entrypoint (issue #104): stream the full graph out of
 * Neo4j, gzip it, and upload to S3. Runs as `node dist/backup/run.js` from the graph-service
 * image (kustomize retags the same image; only the command differs).
 *
 * Deliberately does NOT import server.ts — that would pull in the `dotenv-flow/config` side
 * effect and the onReady production ADMIN_TOKEN requirement, neither of which applies here.
 * Env comes straight from the pod (`envFrom: graph-service-secrets`); only NEO4J_URI/USER/
 * PASSWORD and BACKUP_S3_BUCKET are required (AWS_REGION is set by the CronJob manifest and
 * resolved by the SDK's default chain).
 *
 * RELOAD GATE: Neo4j is read-committed, so an export taken while an orchestrated reload is
 * writing could capture rels whose endpoints are missing from the node scan. The gate checks
 * the DB-backed `findResumableReloadJob` (the in-memory busyWith signals live in the API pod
 * and are invisible from here) and exits 0 with a clear "skipped" log — reloads are rare and
 * operator-triggered, and next week's tick catches up. In-memory `/ingest`/enrich jobs can't
 * be seen cross-pod; that residual is documented in the RUNBOOK.
 *
 * Logs are JSON lines on stdout — fluent-bit ships pod logs to CloudWatch like any other pod.
 */
import { pipeline } from 'node:stream/promises';
import { PassThrough } from 'node:stream';
import { createGzip } from 'node:zlib';
import neo4j from 'neo4j-driver';
import { findResumableReloadJob } from '../db/job-repository.js';
import { exportGraph } from './export.js';
import { backupKey, uploadBackup } from './s3.js';

function log(level: 'info' | 'warn' | 'error', msg: string, extra: object = {}): void {
  console.log(
    JSON.stringify({ level, msg: `[backup] ${msg}`, time: new Date().toISOString(), ...extra }),
  );
}

function requireEnv(name: string): string {
  // eslint-disable-next-line security/detect-object-injection -- `name` is a hardcoded env-var literal from main(), never input data
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

function hostOf(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

async function main(): Promise<void> {
  const uri = requireEnv('NEO4J_URI');
  const user = requireEnv('NEO4J_USER');
  const password = requireEnv('NEO4J_PASSWORD');
  const bucket = requireEnv('BACKUP_S3_BUCKET');
  const region = process.env['AWS_REGION'];
  const sourceHost = hostOf(uri);

  const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  try {
    const runningReload = await findResumableReloadJob(driver);
    if (runningReload !== null) {
      log('warn', 'skipped: reload in progress — a mid-reload export would not be consistent', {
        reloadJobId: runningReload.jobId,
      });
      return;
    }

    const key = backupKey(new Date());
    log('info', 'starting export', { sourceHost, bucket, key });

    // exportGraph writes JSONL into the pipeline head; gzip compresses; Upload consumes the
    // tail via streaming multipart. The upload must be started before the export fills the
    // pipe (backpressure would deadlock otherwise), so both run concurrently.
    const raw = new PassThrough();
    const gzip = createGzip();
    const gzipDone = pipeline(raw, gzip);
    const uploadDone = uploadBackup({ bucket, key, body: gzip, ...(region ? { region } : {}) });

    const manifest = await exportGraph(driver, raw, { sourceHost });
    raw.end();
    await gzipDone;
    await uploadDone;

    log('info', 'backup complete', {
      s3Uri: `s3://${bucket}/${key}`,
      nodeCount: manifest.nodeCount,
      relCount: manifest.relCount,
    });
  } finally {
    await driver.close();
  }
}

main().catch((err: unknown) => {
  log('error', 'fatal', { error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
