import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { enrichLabelHierarchy } from '../../../src/enrichment/label-hierarchy.js';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
const mockGetUnenrichedLabels = vi.hoisted(() => vi.fn());
const mockSetLabelParent = vi.hoisted(() => vi.fn());
const mockSetLabelHierarchyFetched = vi.hoisted(() => vi.fn());

vi.mock('../../../src/db/label-hierarchy-repository.js', () => ({
  getUnenrichedLabels: mockGetUnenrichedLabels,
  setLabelParent: mockSetLabelParent,
  setLabelHierarchyFetched: mockSetLabelHierarchyFetched,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const fakeDriver = {} as Driver;

type LabelDetail = { id: number; name: string; parent_label?: { id: number | null; name: string } };

function makeClient(getLabelImpl?: (id: number) => Promise<LabelDetail>) {
  return {
    getLabel: getLabelImpl
      ? vi.fn().mockImplementation(getLabelImpl)
      : vi.fn().mockResolvedValue({
          id: 634,
          name: '4AD',
          parent_label: { id: 123, name: 'Beggars Group' },
        }),
  } as unknown as import('../../../src/ingestion/discogs-client.js').DiscogsClient;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('enrichLabelHierarchy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUnenrichedLabels.mockResolvedValue([]);
    mockSetLabelParent.mockResolvedValue(undefined);
    mockSetLabelHierarchyFetched.mockResolvedValue(undefined);
  });

  it('returns zero counts when no labels need enrichment', async () => {
    const client = makeClient();

    const summary = await enrichLabelHierarchy(client, fakeDriver);

    expect(summary.enriched).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    expect(client.getLabel).not.toHaveBeenCalled();
  });

  it('records the parent edge for a label with a parent', async () => {
    mockGetUnenrichedLabels.mockResolvedValue([{ discogsId: 634 }]);
    const client = makeClient();

    const summary = await enrichLabelHierarchy(client, fakeDriver);

    expect(client.getLabel).toHaveBeenCalledWith(634);
    expect(mockSetLabelParent).toHaveBeenCalledWith(fakeDriver, 634, {
      discogsId: 123,
      name: 'Beggars Group',
    });
    expect(mockSetLabelHierarchyFetched).not.toHaveBeenCalled();
    expect(summary.enriched).toBe(1);
    expect(summary.skipped).toBe(0);
  });

  it('marks attempted (stamp only) when the label has no parent', async () => {
    mockGetUnenrichedLabels.mockResolvedValue([{ discogsId: 999 }]);
    const client = makeClient(async () => ({ id: 999, name: 'Independent' }));

    const summary = await enrichLabelHierarchy(client, fakeDriver);

    expect(mockSetLabelHierarchyFetched).toHaveBeenCalledWith(fakeDriver, 999);
    expect(mockSetLabelParent).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(1);
    expect(summary.enriched).toBe(0);
  });

  it('marks attempted for an unkeyable (id 0/null) parent', async () => {
    mockGetUnenrichedLabels.mockResolvedValue([{ discogsId: 1 }, { discogsId: 2 }]);
    const client = makeClient(async (id) =>
      id === 1
        ? { id: 1, name: 'A', parent_label: { id: 0, name: 'Bad' } }
        : { id: 2, name: 'B', parent_label: { id: null, name: 'AlsoBad' } },
    );

    const summary = await enrichLabelHierarchy(client, fakeDriver);

    expect(mockSetLabelParent).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(2);
  });

  it('marks attempted for a self-referential parent', async () => {
    mockGetUnenrichedLabels.mockResolvedValue([{ discogsId: 50 }]);
    const client = makeClient(async () => ({
      id: 50,
      name: 'Loop',
      parent_label: { id: 50, name: 'Loop' },
    }));

    const summary = await enrichLabelHierarchy(client, fakeDriver);

    expect(mockSetLabelParent).not.toHaveBeenCalled();
    expect(mockSetLabelHierarchyFetched).toHaveBeenCalledWith(fakeDriver, 50);
    expect(summary.skipped).toBe(1);
  });

  it('counts failures per label and continues processing', async () => {
    mockGetUnenrichedLabels.mockResolvedValue([{ discogsId: 1 }, { discogsId: 2 }]);
    const client = {
      getLabel: vi
        .fn()
        .mockRejectedValueOnce(new Error('Discogs API error 503'))
        .mockResolvedValueOnce({ id: 2, name: 'B', parent_label: { id: 9, name: 'Parent' } }),
    } as unknown as import('../../../src/ingestion/discogs-client.js').DiscogsClient;

    const summary = await enrichLabelHierarchy(client, fakeDriver);

    expect(summary.failed).toBe(1);
    expect(summary.enriched).toBe(1);
    expect(mockSetLabelParent).toHaveBeenCalledTimes(1);
    expect(mockSetLabelParent).toHaveBeenCalledWith(fakeDriver, 2, {
      discogsId: 9,
      name: 'Parent',
    });
  });

  it('returns failed=1 when getUnenrichedLabels throws', async () => {
    mockGetUnenrichedLabels.mockRejectedValue(new Error('Neo4j session failed'));
    const client = makeClient();

    const summary = await enrichLabelHierarchy(client, fakeDriver);

    expect(summary.failed).toBe(1);
    expect(client.getLabel).not.toHaveBeenCalled();
  });
});
