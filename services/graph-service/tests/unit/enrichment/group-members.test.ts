import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { enrichGroupMembers } from '../../../src/enrichment/group-members.js';

const mockGetGroupCandidates = vi.hoisted(() => vi.fn());
const mockSetGroupMembers = vi.hoisted(() => vi.fn());
const mockMarkNotAGroup = vi.hoisted(() => vi.fn());

vi.mock('../../../src/db/group-members-repository.js', () => ({
  getGroupCandidates: mockGetGroupCandidates,
  setGroupMembers: mockSetGroupMembers,
  markNotAGroup: mockMarkNotAGroup,
}));

const fakeDriver = {} as Driver;

type ProfileMembers = Array<{ id: number; name: string; active: boolean; resource_url: string }>;

function makeClient(
  getArtistImpl?: (id: number) => Promise<{ id: number; members?: ProfileMembers }>,
) {
  return {
    getArtist: getArtistImpl
      ? vi.fn().mockImplementation(getArtistImpl)
      : vi.fn().mockResolvedValue({ id: 1 }),
  } as unknown as import('../../../src/ingestion/discogs-client.js').DiscogsClient;
}

const member = (id: number, active = true): ProfileMembers[number] => ({
  id,
  name: `Member ${id}`,
  active,
  resource_url: `https://api.discogs.com/artists/${id}`,
});

describe('enrichGroupMembers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGroupCandidates.mockResolvedValue([]);
    mockSetGroupMembers.mockResolvedValue(undefined);
    mockMarkNotAGroup.mockResolvedValue(undefined);
  });

  it('returns zero counts when no candidates need checking', async () => {
    const client = makeClient();
    const summary = await enrichGroupMembers(client, fakeDriver);
    expect(summary.enriched).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
    expect(client.getArtist).not.toHaveBeenCalled();
  });

  it('links members for a group and counts it enriched', async () => {
    mockGetGroupCandidates.mockResolvedValue([{ discogsId: 900 }]);
    const client = makeClient(async () => ({ id: 900, members: [member(11), member(22, false)] }));

    const summary = await enrichGroupMembers(client, fakeDriver);

    expect(client.getArtist).toHaveBeenCalledWith(900);
    expect(mockSetGroupMembers).toHaveBeenCalledWith(fakeDriver, 900, [
      { id: 11, active: true },
      { id: 22, active: false },
    ]);
    expect(mockMarkNotAGroup).not.toHaveBeenCalled();
    expect(summary.enriched).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(summary.exhausted).toBe(0);
  });

  it('exhausts (marks non-group) a musician with no members', async () => {
    mockGetGroupCandidates.mockResolvedValue([{ discogsId: 42 }]);
    const client = makeClient(async () => ({ id: 42 }));

    const summary = await enrichGroupMembers(client, fakeDriver);

    expect(mockMarkNotAGroup).toHaveBeenCalledWith(fakeDriver, 42);
    expect(mockSetGroupMembers).not.toHaveBeenCalled();
    expect(summary.exhausted).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(summary.enriched).toBe(0);
  });

  it('filters out id===0 members (uncatalogued, unlinkable)', async () => {
    mockGetGroupCandidates.mockResolvedValue([{ discogsId: 900 }]);
    const client = makeClient(async () => ({ id: 900, members: [member(0), member(33)] }));

    const summary = await enrichGroupMembers(client, fakeDriver);

    expect(mockSetGroupMembers).toHaveBeenCalledWith(fakeDriver, 900, [{ id: 33, active: true }]);
    expect(summary.enriched).toBe(1);
  });

  it('exhausts a group whose every member is id===0 (no linkable members)', async () => {
    mockGetGroupCandidates.mockResolvedValue([{ discogsId: 900 }]);
    const client = makeClient(async () => ({ id: 900, members: [member(0), member(0)] }));

    const summary = await enrichGroupMembers(client, fakeDriver);

    expect(mockSetGroupMembers).not.toHaveBeenCalled();
    expect(mockMarkNotAGroup).toHaveBeenCalledWith(fakeDriver, 900);
    expect(summary.exhausted).toBe(1);
    expect(summary.skipped).toBe(0);
  });

  it('counts a fetch failure and continues', async () => {
    mockGetGroupCandidates.mockResolvedValue([{ discogsId: 1 }, { discogsId: 2 }]);
    const client = {
      getArtist: vi
        .fn()
        .mockRejectedValueOnce(new Error('Discogs 503'))
        .mockResolvedValueOnce({ id: 2, members: [member(7)] }),
    } as unknown as import('../../../src/ingestion/discogs-client.js').DiscogsClient;

    const summary = await enrichGroupMembers(client, fakeDriver);

    expect(summary.failed).toBe(1);
    expect(summary.enriched).toBe(1);
    expect(mockSetGroupMembers).toHaveBeenCalledTimes(1);
    expect(mockSetGroupMembers).toHaveBeenCalledWith(fakeDriver, 2, [{ id: 7, active: true }]);
  });

  it('returns failed=1 when candidate selection throws', async () => {
    mockGetGroupCandidates.mockRejectedValue(new Error('Neo4j down'));
    const client = makeClient();
    const summary = await enrichGroupMembers(client, fakeDriver);
    expect(summary.failed).toBe(1);
    expect(client.getArtist).not.toHaveBeenCalled();
  });
});
