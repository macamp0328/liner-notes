/**
 * s3.ts — thin S3 upload wrapper for the backup CronJob (issue #104).
 *
 * Uses @aws-sdk/lib-storage's `Upload` (streaming multipart) rather than plain PutObject: the
 * gzip stream has unknown length, and PutObject requires Content-Length. `queueSize: 1` +
 * `partSize: 5MB` keeps at most ~10MB buffered, so memory stays bounded even if the graph grows.
 *
 * Credentials come from the SDK's default provider chain — in the CronJob pod that resolves via
 * IMDS to the `ec2_k3s` instance role (the same path ESO and the ecr-pull-secret-refresher use);
 * no keys are ever configured in code or manifests.
 */
import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { Readable } from 'node:stream';

export const BACKUP_KEY_PREFIX = 'graph-backups/';

/** `graph-backups/graph-2026-07-16T14-00-03Z.jsonl.gz` — colons dashed for CLI/URL friendliness. */
export function backupKey(now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replaceAll(':', '-');
  return `${BACKUP_KEY_PREFIX}graph-${stamp}.jsonl.gz`;
}

export interface UploadBackupOptions {
  bucket: string;
  key: string;
  body: Readable;
  region?: string;
  /** Injection seam for tests; defaults to a real client. */
  client?: S3Client;
}

export async function uploadBackup(options: UploadBackupOptions): Promise<void> {
  const client = options.client ?? new S3Client(options.region ? { region: options.region } : {});
  const upload = new Upload({
    client,
    params: {
      Bucket: options.bucket,
      Key: options.key,
      Body: options.body,
      ContentType: 'application/gzip',
    },
    queueSize: 1,
    partSize: 5 * 1024 * 1024,
  });
  await upload.done();
}
