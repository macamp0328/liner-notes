import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver, Session, Result } from 'neo4j-driver';
import {
  getMastersForReleaseEventEnrichment,
  mergeMbReleaseEvents,
  setMbReleaseEventsFetched,
  resetMbReleaseEventsEnrichment,
} from '../../../src/db/mb-release-events-repository.js';
import type { MbReleaseEvent } from '../../../src/ingestion/musicbrainz-client.js';

vi.mock('neo4j-driver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('neo4j-driver')>();
  return {
    ...actual,
    default: {
      ...actual.default,
      int: (n: number) => ({ toNumber: () => n, low: n, high: 0 }),
    },
  };
});

function makeMockSession(runResult: unknown = { records: [] }): {
  session: Session;
  runSpy: ReturnType<typeof vi.fn>;
} {
  const runSpy = vi.fn().mockResolvedValue(runResult);
  const session = {
    run: runSpy,
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as Session;
  return { session, runSpy };
}

function makeMockDriver(session: Session): Driver {
  return {
    session: vi.fn().mockReturnValue(session),
  } as unknown as Driver;
}

describe('getMastersForReleaseEventEnrichment', () => {
  it('returns masters mapped from records', async () => {
    const fakeRecord = {
      get: vi.fn().mockReturnValue({ toNumber: () => 12345 }),
    };
    const result = { records: [fakeRecord] } as unknown as Result;
    const { session } = makeMockSession(result);
    const driver = makeMockDriver(session);

    const masters = await getMastersForReleaseEventEnrichment(driver);

    expect(masters).toEqual([{ masterDiscogsId: 12345 }]);
    expect(session.run).toHaveBeenCalledOnce();
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('returns empty array when no unenriched masters exist', async () => {
    const result = { records: [] } as unknown as Result;
    const { session } = makeMockSession(result);
    const driver = makeMockDriver(session);

    const masters = await getMastersForReleaseEventEnrichment(driver);

    expect(masters).toEqual([]);
  });

  it('selects masters with no MB_RELEASED_IN, gated by the staleness window', async () => {
    const { session, runSpy } = makeMockSession({ records: [] } as unknown as Result);

    await getMastersForReleaseEventEnrichment(makeMockDriver(session));

    const [query, params] = runSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(query).toContain('NOT EXISTS { (m)-[:MB_RELEASED_IN]->() }');
    expect(query).toContain('m.mbReleaseEventsFetchedAt IS NULL');
    expect(query).toContain('duration({ days: $stalenessDays })');
    expect(params).toHaveProperty('stalenessDays');
  });

  it('closes the session even when run throws', async () => {
    const { session } = makeMockSession();
    (session.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));
    const driver = makeMockDriver(session);

    await expect(getMastersForReleaseEventEnrichment(driver)).rejects.toThrow('DB error');
    expect(session.close).toHaveBeenCalledOnce();
  });
});

describe('mergeMbReleaseEvents', () => {
  const events: MbReleaseEvent[] = [
    { mbReleaseId: 'rel-001', countryCode: 'GB', date: '1969-09-26', formats: ['Vinyl'] },
    { mbReleaseId: 'rel-002', countryCode: 'US', date: '1969-10-01', formats: ['Vinyl'] },
  ];

  it('runs the MERGE query with events that have a countryCode', async () => {
    const { session, runSpy } = makeMockSession();
    const driver = makeMockDriver(session);

    await mergeMbReleaseEvents(driver, 1234, events);

    expect(runSpy).toHaveBeenCalledOnce();
    const [query] = runSpy.mock.calls[0] as [string, unknown];
    expect(query).toContain('MB_RELEASED_IN');
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('skips the query entirely when all events have no countryCode', async () => {
    const noCountryEvents: MbReleaseEvent[] = [
      { mbReleaseId: 'rel-003', countryCode: null, date: '2009', formats: [] },
    ];
    const { session, runSpy } = makeMockSession();
    const driver = makeMockDriver(session);

    await mergeMbReleaseEvents(driver, 1234, noCountryEvents);

    expect(runSpy).not.toHaveBeenCalled();
    expect(session.close).not.toHaveBeenCalled();
  });

  it('passes only events with countryCode to the query', async () => {
    const mixed: MbReleaseEvent[] = [
      { mbReleaseId: 'rel-001', countryCode: 'GB', date: '1969', formats: [] },
      { mbReleaseId: 'rel-002', countryCode: null, date: '2009', formats: [] },
    ];
    const { session, runSpy } = makeMockSession();
    const driver = makeMockDriver(session);

    await mergeMbReleaseEvents(driver, 1234, mixed);

    const [, params] = runSpy.mock.calls[0] as [string, { events: unknown[] }];
    expect(params.events).toHaveLength(1);
    expect((params.events[0] as { countryCode: string }).countryCode).toBe('GB');
  });

  it('closes the session even when run throws', async () => {
    const { session } = makeMockSession();
    (session.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('write error'));
    const driver = makeMockDriver(session);

    await expect(mergeMbReleaseEvents(driver, 1, events)).rejects.toThrow('write error');
    expect(session.close).toHaveBeenCalledOnce();
  });
});

describe('setMbReleaseEventsFetched', () => {
  it('runs the SET query for the given masterDiscogsId', async () => {
    const { session, runSpy } = makeMockSession();
    const driver = makeMockDriver(session);

    await setMbReleaseEventsFetched(driver, 999);

    expect(runSpy).toHaveBeenCalledOnce();
    const [query] = runSpy.mock.calls[0] as [string, unknown];
    expect(query).toContain('mbReleaseEventsFetchedAt = datetime()');
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('closes the session even when run throws', async () => {
    const { session } = makeMockSession();
    (session.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('timeout'));
    const driver = makeMockDriver(session);

    await expect(setMbReleaseEventsFetched(driver, 1)).rejects.toThrow('timeout');
    expect(session.close).toHaveBeenCalledOnce();
  });
});

describe('resetMbReleaseEventsEnrichment', () => {
  it('returns the count of reset masters and deletes MB_RELEASED_IN relationships', async () => {
    const resetRecord = { get: vi.fn().mockReturnValue({ toNumber: () => 5 }) };
    const runSpy = vi
      .fn()
      .mockResolvedValueOnce({ records: [resetRecord] })
      .mockResolvedValueOnce({ records: [] });
    const session = {
      run: runSpy,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Session;
    const driver = makeMockDriver(session);

    const reset = await resetMbReleaseEventsEnrichment(driver);

    expect(reset).toBe(5);
    expect(runSpy).toHaveBeenCalledTimes(2);
    const [deleteQuery] = runSpy.mock.calls[1] as [string, unknown];
    expect(deleteQuery).toContain('MB_RELEASED_IN');
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('returns 0 when no masters had the marker', async () => {
    const resetRecord = { get: vi.fn().mockReturnValue(undefined) };
    const runSpy = vi
      .fn()
      .mockResolvedValueOnce({ records: [resetRecord] })
      .mockResolvedValueOnce({ records: [] });
    const session = {
      run: runSpy,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Session;
    const driver = makeMockDriver(session);

    const reset = await resetMbReleaseEventsEnrichment(driver);

    expect(reset).toBe(0);
  });

  it('closes the session even when run throws', async () => {
    const { session } = makeMockSession();
    (session.run as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('reset failed'));
    const driver = makeMockDriver(session);

    await expect(resetMbReleaseEventsEnrichment(driver)).rejects.toThrow('reset failed');
    expect(session.close).toHaveBeenCalledOnce();
  });
});
