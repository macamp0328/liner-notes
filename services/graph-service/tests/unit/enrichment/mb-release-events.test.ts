import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { enrichMbReleaseEvents } from '../../../src/enrichment/mb-release-events.js';
import type { MbReleaseEvent } from '../../../src/ingestion/musicbrainz-client.js';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const mockGetMasters = vi.hoisted(() => vi.fn());
const mockMergeEvents = vi.hoisted(() => vi.fn());
const mockSetMbid = vi.hoisted(() => vi.fn());
const mockSetFetched = vi.hoisted(() => vi.fn());

vi.mock('../../../src/db/mb-release-events-repository.js', () => ({
  getMastersForReleaseEventEnrichment: mockGetMasters,
  mergeMbReleaseEvents: mockMergeEvents,
  setMasterReleaseGroupMbid: mockSetMbid,
  setMbReleaseEventsFetched: mockSetFetched,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const fakeDriver = {} as Driver;

function makeMbClient(
  getReleaseGroupMbid: (id: number) => Promise<string | null> = async () => null,
  getReleaseEvents: (mbid: string) => Promise<MbReleaseEvent[]> = async () => [],
) {
  return {
    getReleaseGroupMbidByMasterDiscogsId: vi.fn().mockImplementation(getReleaseGroupMbid),
    getReleaseEventsByReleaseGroupMbid: vi.fn().mockImplementation(getReleaseEvents),
  } as unknown as import('../../../src/ingestion/musicbrainz-client.js').MusicBrainzClient;
}

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('enrichMbReleaseEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMasters.mockResolvedValue([]);
    mockMergeEvents.mockResolvedValue(undefined);
    mockSetMbid.mockResolvedValue(undefined);
    mockSetFetched.mockResolvedValue(undefined);
  });

  it('returns zero counts when there are no unenriched masters', async () => {
    const client = makeMbClient();
    const summary = await enrichMbReleaseEvents(client, fakeDriver, silentLogger);

    expect(summary.mastersProcessed).toBe(0);
    expect(summary.mastersSkipped).toBe(0);
    expect(summary.mastersFailed).toBe(0);
    expect(summary.eventsWritten).toBe(0);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('processes a master with a found MB link and writes events', async () => {
    mockGetMasters.mockResolvedValue([{ masterDiscogsId: 1234 }]);
    const events: MbReleaseEvent[] = [
      { mbReleaseId: 'rel-001', countryCode: 'GB', date: '1969-09-26', formats: ['Vinyl'] },
      { mbReleaseId: 'rel-001', countryCode: 'US', date: '1969-10-01', formats: ['Vinyl'] },
    ];
    const client = makeMbClient(
      async () => 'rg-mbid-abc',
      async () => events,
    );

    const summary = await enrichMbReleaseEvents(client, fakeDriver, silentLogger);

    expect(client.getReleaseGroupMbidByMasterDiscogsId).toHaveBeenCalledWith(1234);
    expect(client.getReleaseEventsByReleaseGroupMbid).toHaveBeenCalledWith('rg-mbid-abc');
    expect(mockSetMbid).toHaveBeenCalledWith(fakeDriver, 1234, 'rg-mbid-abc');
    expect(mockMergeEvents).toHaveBeenCalledWith(fakeDriver, 1234, events);
    expect(mockSetFetched).toHaveBeenCalledWith(fakeDriver, 1234);
    // Crash-safety invariant: the MBID must persist before either exclusion-causing write
    // (the MB_RELEASED_IN merge and the fetched marker), or a mid-write crash loses the crosswalk.
    const callOrder = (mock: ReturnType<typeof vi.fn>): number =>
      mock.mock.invocationCallOrder[0] ?? -1;
    expect(callOrder(mockSetMbid)).toBeLessThan(callOrder(mockMergeEvents));
    expect(callOrder(mockSetMbid)).toBeLessThan(callOrder(mockSetFetched));
    expect(summary.mastersProcessed).toBe(1);
    expect(summary.mastersSkipped).toBe(0);
    expect(summary.mastersFailed).toBe(0);
    expect(summary.eventsWritten).toBe(2);
  });

  it('skips and marks fetched when no MB link is found', async () => {
    mockGetMasters.mockResolvedValue([{ masterDiscogsId: 9999 }]);
    const client = makeMbClient(async () => null);

    const summary = await enrichMbReleaseEvents(client, fakeDriver, silentLogger);

    expect(client.getReleaseEventsByReleaseGroupMbid).not.toHaveBeenCalled();
    expect(mockMergeEvents).not.toHaveBeenCalled();
    expect(mockSetMbid).not.toHaveBeenCalled();
    expect(mockSetFetched).toHaveBeenCalledWith(fakeDriver, 9999);
    expect(summary.mastersSkipped).toBe(1);
    expect(summary.mastersProcessed).toBe(0);
    expect(summary.mastersFailed).toBe(0);
  });

  it('counts failed and does NOT set fetched when an error is thrown', async () => {
    mockGetMasters.mockResolvedValue([{ masterDiscogsId: 5555 }]);
    const client = makeMbClient(async () => {
      throw new Error('MB API timeout');
    });

    const summary = await enrichMbReleaseEvents(client, fakeDriver, silentLogger);

    expect(mockSetFetched).not.toHaveBeenCalled();
    expect(summary.mastersFailed).toBe(1);
    expect(summary.mastersProcessed).toBe(0);
    expect(summary.mastersSkipped).toBe(0);
  });

  it('counts eventsWritten only for events with a countryCode', async () => {
    mockGetMasters.mockResolvedValue([{ masterDiscogsId: 1234 }]);
    const events: MbReleaseEvent[] = [
      { mbReleaseId: 'rel-001', countryCode: 'GB', date: '1969', formats: [] },
      { mbReleaseId: 'rel-002', countryCode: null, date: '2009', formats: [] },
    ];
    const client = makeMbClient(
      async () => 'rg-mbid',
      async () => events,
    );

    const summary = await enrichMbReleaseEvents(client, fakeDriver, silentLogger);

    expect(summary.eventsWritten).toBe(1);
  });

  it('drops worldwide-digital storefront events so the country count cannot saturate (#458)', async () => {
    mockGetMasters.mockResolvedValue([{ masterDiscogsId: 74610 }]);
    // Mimic St. Vincent's "Marry Me": one worldwide digital edition enumerated as many single-date
    // ISO storefronts. Every event is digital-only → nothing is pressing reach.
    const digitalEvents: MbReleaseEvent[] = ['US', 'GB', 'DE', 'FR', 'JP'].map((cc, i) => ({
      mbReleaseId: `rel-digital-${i}`,
      countryCode: cc,
      date: '2007-07-10',
      formats: ['Digital Media'],
    }));
    const client = makeMbClient(
      async () => 'rg-marry-me',
      async () => digitalEvents,
    );

    const summary = await enrichMbReleaseEvents(client, fakeDriver, silentLogger);

    // All digital → nothing reaches the writer; the distinct-country count collapses to 0.
    expect(mockMergeEvents).toHaveBeenCalledWith(fakeDriver, 74610, []);
    expect(summary.eventsWritten).toBe(0);
    // Took the data→write path (not skipped) and is still stamped fetched, so it is excluded from
    // re-selection until the staleness window — idempotent, not re-fetched forever.
    expect(summary.mastersProcessed).toBe(1);
    expect(mockSetFetched).toHaveBeenCalledWith(fakeDriver, 74610);
    expect(silentLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('digital-only event(s) dropped'),
    );
  });

  it('keeps mixed physical+digital events, dropping only the all-digital ones (#458)', async () => {
    mockGetMasters.mockResolvedValue([{ masterDiscogsId: 42 }]);
    const vinylEvent: MbReleaseEvent = {
      mbReleaseId: 'rel-vinyl',
      countryCode: 'GB',
      date: '1975',
      formats: ['Vinyl'],
    };
    const mixedEvent: MbReleaseEvent = {
      mbReleaseId: 'rel-mixed',
      countryCode: 'US',
      date: '1975',
      formats: ['CD', 'Digital Media'],
    };
    const digitalEvent: MbReleaseEvent = {
      mbReleaseId: 'rel-digital',
      countryCode: 'JP',
      date: '2015',
      formats: ['Digital Media'],
    };
    const client = makeMbClient(
      async () => 'rg-mixed',
      async () => [vinylEvent, mixedEvent, digitalEvent],
    );

    const summary = await enrichMbReleaseEvents(client, fakeDriver, silentLogger);

    // The vinyl and the mixed (physical-bearing) events survive; the digital-only one is dropped.
    expect(mockMergeEvents).toHaveBeenCalledWith(fakeDriver, 42, [vinylEvent, mixedEvent]);
    expect(summary.eventsWritten).toBe(2);
  });

  it('continues processing remaining masters after a per-master failure', async () => {
    mockGetMasters.mockResolvedValue([{ masterDiscogsId: 1 }, { masterDiscogsId: 2 }]);
    const client = makeMbClient(
      vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce('rg-mbid-2'),
      async () => [],
    );

    const summary = await enrichMbReleaseEvents(client, fakeDriver, silentLogger);

    expect(summary.mastersFailed).toBe(1);
    expect(summary.mastersProcessed).toBe(1);
    expect(mockSetFetched).toHaveBeenCalledTimes(1);
    expect(mockSetFetched).toHaveBeenCalledWith(fakeDriver, 2);
  });

  it('warns when masters were found but no events were written (silent no-op)', async () => {
    mockGetMasters.mockResolvedValue([{ masterDiscogsId: 1 }, { masterDiscogsId: 2 }]);
    const client = makeMbClient(async () => null);

    const summary = await enrichMbReleaseEvents(client, fakeDriver, silentLogger);

    expect(summary.eventsWritten).toBe(0);
    expect(summary.mastersFailed).toBe(0);
    expect(silentLogger.warn).toHaveBeenCalledWith(expect.stringContaining('No-op'));
  });

  it('does NOT warn when events were written', async () => {
    mockGetMasters.mockResolvedValue([{ masterDiscogsId: 1 }]);
    const events: MbReleaseEvent[] = [
      { mbReleaseId: 'rel-001', countryCode: 'GB', date: '1969', formats: [] },
    ];
    const client = makeMbClient(
      async () => 'rg-mbid',
      async () => events,
    );

    await enrichMbReleaseEvents(client, fakeDriver, silentLogger);

    expect(silentLogger.warn).not.toHaveBeenCalled();
  });

  it('does NOT warn when masters failed (already surfaced as errors)', async () => {
    mockGetMasters.mockResolvedValue([{ masterDiscogsId: 1 }]);
    const client = makeMbClient(async () => {
      throw new Error('MB API timeout');
    });

    await enrichMbReleaseEvents(client, fakeDriver, silentLogger);

    expect(silentLogger.warn).not.toHaveBeenCalled();
  });

  it('returns early with failed=1 when fetching masters fails', async () => {
    mockGetMasters.mockRejectedValue(new Error('DB connection lost'));
    const client = makeMbClient();

    const summary = await enrichMbReleaseEvents(client, fakeDriver, silentLogger);

    expect(summary.mastersFailed).toBe(1);
    expect(summary.mastersProcessed).toBe(0);
    expect(client.getReleaseGroupMbidByMasterDiscogsId).not.toHaveBeenCalled();
  });
});
