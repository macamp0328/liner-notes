import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassThrough } from 'node:stream';

const uploadDone = vi.fn().mockResolvedValue(undefined);
// `new`-able mocks: vi.fn with an arrow implementation is not a constructor.
const uploadCtor = vi.fn(function (this: { done: typeof uploadDone }, _options: unknown) {
  this.done = uploadDone;
});
const s3ClientCtor = vi.fn(function (this: { mocked: boolean }, _config: unknown) {
  this.mocked = true;
});

vi.mock('@aws-sdk/lib-storage', () => ({ Upload: uploadCtor }));
vi.mock('@aws-sdk/client-s3', () => ({ S3Client: s3ClientCtor }));

const { backupKey, uploadBackup, BACKUP_KEY_PREFIX } = await import('../../../src/backup/s3.js');

describe('backupKey', () => {
  it('builds a prefix-scoped, colon-free, second-precision key', () => {
    const key = backupKey(new Date('2026-07-16T14:00:03.123Z'));
    expect(key).toBe('graph-backups/graph-2026-07-16T14-00-03Z.jsonl.gz');
    expect(key.startsWith(BACKUP_KEY_PREFIX)).toBe(true);
    expect(key).not.toContain(':');
  });
});

describe('uploadBackup', () => {
  beforeEach(() => {
    uploadCtor.mockClear();
    uploadDone.mockClear();
    s3ClientCtor.mockClear();
  });

  it('wires bucket/key/body/content-type into a bounded-memory multipart Upload', async () => {
    const body = new PassThrough();
    await uploadBackup({
      bucket: 'my-bucket',
      key: 'graph-backups/x.jsonl.gz',
      body,
      region: 'us-east-1',
    });

    expect(s3ClientCtor).toHaveBeenCalledWith({ region: 'us-east-1' });
    expect(uploadCtor).toHaveBeenCalledTimes(1);
    const args = uploadCtor.mock.calls[0]![0] as {
      params: { Bucket: string; Key: string; Body: unknown; ContentType: string };
      queueSize: number;
      partSize: number;
    };
    expect(args.params.Bucket).toBe('my-bucket');
    expect(args.params.Key).toBe('graph-backups/x.jsonl.gz');
    expect(args.params.Body).toBe(body);
    expect(args.params.ContentType).toBe('application/gzip');
    expect(args.queueSize).toBe(1);
    expect(args.partSize).toBe(5 * 1024 * 1024);
    expect(uploadDone).toHaveBeenCalledTimes(1);
  });

  it('uses an injected client and default-chain region when none given', async () => {
    const client = { injected: true };
    await uploadBackup({
      bucket: 'b',
      key: 'k',
      body: new PassThrough(),
      client: client as never,
    });
    expect(s3ClientCtor).not.toHaveBeenCalled();
    const args = uploadCtor.mock.calls[0]![0] as { client: unknown };
    expect(args.client).toBe(client);
  });

  it('propagates upload failure', async () => {
    uploadDone.mockRejectedValueOnce(new Error('AccessDenied'));
    await expect(uploadBackup({ bucket: 'b', key: 'k', body: new PassThrough() })).rejects.toThrow(
      'AccessDenied',
    );
  });
});
