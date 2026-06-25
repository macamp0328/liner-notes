import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../../src/server.js';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockVerifyConnectivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockGetReleasesByMusician = vi.hoisted(() => vi.fn());
const mockGetArtistMembership = vi.hoisted(() => vi.fn());
const mockGetReleasesByCredit = vi.hoisted(() => vi.fn());
const mockGetReleasesByInstrument = vi.hoisted(() => vi.fn());
const mockGetArtistsByPersonLevelInstrument = vi.hoisted(() => vi.fn());
const mockGetRecordingsByWork = vi.hoisted(() => vi.fn());
const mockGetWorksBySongwriter = vi.hoisted(() => vi.fn());
const mockGetReleasesByStudio = vi.hoisted(() => vi.fn());
const mockGetRecordingLocations = vi.hoisted(() => vi.fn());
const mockGetReleasesByLabel = vi.hoisted(() => vi.fn());
const mockGetReleasesByGenre = vi.hoisted(() => vi.fn());
const mockGetReleasesByStyle = vi.hoisted(() => vi.fn());
const mockGetReleasesByCountry = vi.hoisted(() => vi.fn());
const mockGetReleasesByDecade = vi.hoisted(() => vi.fn());
const mockGetReleasesByYear = vi.hoisted(() => vi.fn());
const mockGetConnections = vi.hoisted(() => vi.fn());
const mockGetRelatedReleases = vi.hoisted(() => vi.fn());
const mockGetPath = vi.hoisted(() => vi.fn());
const mockGetSharedMusicians = vi.hoisted(() => vi.fn());
const mockGetMostInternationalTracks = vi.hoisted(() => vi.fn());
const mockGetMostPressedReleases = vi.hoisted(() => vi.fn());
const mockGetTracksByAudioFeatures = vi.hoisted(() => vi.fn());

vi.mock('../../../src/db/client.js', () => ({
  initDriver: vi.fn().mockReturnValue({ verifyConnectivity: mockVerifyConnectivity }),
  getDriver: vi.fn().mockReturnValue({ verifyConnectivity: mockVerifyConnectivity }),
  closeDriver: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/db/schema.js', () => ({
  applySchema: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/db/job-repository.js', () => ({
  findResumableReloadJob: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../src/db/ingestion-repository.js', () => ({
  hasReleases: vi.fn().mockResolvedValue(true),
  mergeReleaseGraph: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/db/repositories/explore-repository.js', () => ({
  getReleasesByMusician: mockGetReleasesByMusician,
  getArtistMembership: mockGetArtistMembership,
  getReleasesByCredit: mockGetReleasesByCredit,
  getReleasesByInstrument: mockGetReleasesByInstrument,
  getArtistsByPersonLevelInstrument: mockGetArtistsByPersonLevelInstrument,
  getRecordingsByWork: mockGetRecordingsByWork,
  getWorksBySongwriter: mockGetWorksBySongwriter,
  getReleasesByStudio: mockGetReleasesByStudio,
  getRecordingLocations: mockGetRecordingLocations,
  getReleasesByLabel: mockGetReleasesByLabel,
  getReleasesByGenre: mockGetReleasesByGenre,
  getReleasesByStyle: mockGetReleasesByStyle,
  getReleasesByCountry: mockGetReleasesByCountry,
  getReleasesByDecade: mockGetReleasesByDecade,
  getReleasesByYear: mockGetReleasesByYear,
  getConnections: mockGetConnections,
  getRelatedReleases: mockGetRelatedReleases,
  getPath: mockGetPath,
  getSharedMusicians: mockGetSharedMusicians,
  getMostInternationalTracks: mockGetMostInternationalTracks,
  getMostPressedReleases: mockGetMostPressedReleases,
  getTracksByAudioFeatures: mockGetTracksByAudioFeatures,
}));

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const sampleRelease = {
  discogsId: 13570466,
  title: 'U.F.O.F.',
  artist: 'Big Thief',
  pressingYear: 2019,
  format: 'Vinyl',
  thumbUrl: null,
};

const sampleMusicianRelease = {
  ...sampleRelease,
  instrument: 'Guitar',
  role: 'performer',
};

const sampleInstrumentCredit = {
  ...sampleRelease,
  musician: 'Ron Carter',
  instrument: 'bass',
  displayRole: 'Upright Bass',
  scope: 'release',
};

const sampleInstrumentPlayer = {
  discogsId: 12345,
  name: 'Paul McCartney',
  playsInstrument: ['bass', 'guitar', 'piano'],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('explore routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env['NEO4J_URI'] = 'bolt://localhost:7687';
    process.env['NEO4J_USER'] = 'neo4j';
    process.env['NEO4J_PASSWORD'] = 'test';
    app = await buildServer();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  // GET /api/v1/explore/musician/:name
  describe('GET /api/v1/explore/musician/:name', () => {
    it('returns 200 with musician releases', async () => {
      mockGetReleasesByMusician.mockResolvedValue([sampleMusicianRelease]);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/musician/John+Coltrane',
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as (typeof sampleMusicianRelease)[];
      expect(body).toHaveLength(1);
      expect(body[0]!.instrument).toBe('Guitar');
      expect(body[0]!.role).toBe('performer');
    });

    it('returns 200 with empty array when no results', async () => {
      mockGetReleasesByMusician.mockResolvedValue([]);
      const response = await app.inject({ method: 'GET', url: '/api/v1/explore/musician/Unknown' });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload)).toEqual([]);
    });
  });

  // GET /api/v1/explore/membership/:name
  describe('GET /api/v1/explore/membership/:name', () => {
    const sampleMembership = {
      bands: [
        { discogsId: 980002, name: 'The Band', wikidataQid: 'Q-band', since: 1970, until: 1975 },
      ],
      bandmates: [{ discogsId: 980003, name: 'Other Member', wikidataQid: 'Q-mate' }],
    };

    it('returns 200 with { bands, bandmates }', async () => {
      mockGetArtistMembership.mockResolvedValue(sampleMembership);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/membership/Member%20One',
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as typeof sampleMembership;
      expect(body.bands).toEqual(sampleMembership.bands);
      expect(body.bandmates).toEqual(sampleMembership.bandmates);
      expect(mockGetArtistMembership).toHaveBeenCalledWith(expect.anything(), 'Member One');
    });

    it('returns 200 with empty arrays when the artist has no membership edges', async () => {
      mockGetArtistMembership.mockResolvedValue({ bands: [], bandmates: [] });
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/membership/Nobody',
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload)).toEqual({ bands: [], bandmates: [] });
    });
  });

  // GET /api/v1/explore/producer/:name
  describe('GET /api/v1/explore/producer/:name', () => {
    it('returns 200 and queries the producer role category', async () => {
      mockGetReleasesByCredit.mockResolvedValue([{ ...sampleMusicianRelease, role: 'producer' }]);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/producer/Andrew%20Sarlo',
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as (typeof sampleMusicianRelease)[];
      expect(body).toHaveLength(1);
      expect(body[0]!.role).toBe('producer');
      expect(mockGetReleasesByCredit).toHaveBeenCalledWith(
        expect.anything(),
        'Andrew Sarlo',
        'producer',
      );
    });
  });

  // GET /api/v1/explore/engineer/:name
  describe('GET /api/v1/explore/engineer/:name', () => {
    it('returns 200 and queries the engineer role category', async () => {
      mockGetReleasesByCredit.mockResolvedValue([]);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/engineer/Dominic%20Monks',
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload)).toEqual([]);
      expect(mockGetReleasesByCredit).toHaveBeenCalledWith(
        expect.anything(),
        'Dominic Monks',
        'engineer',
      );
    });
  });

  // GET /api/v1/explore/instrument/:name
  describe('GET /api/v1/explore/instrument/:name', () => {
    type InstrumentExploration = {
      credits: (typeof sampleInstrumentCredit)[];
      players: (typeof sampleInstrumentPlayer)[];
    };

    it('returns 200 with both axes (credits + players) and passes the name through to each', async () => {
      mockGetReleasesByInstrument.mockResolvedValue([sampleInstrumentCredit]);
      mockGetArtistsByPersonLevelInstrument.mockResolvedValue([sampleInstrumentPlayer]);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/instrument/bass',
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as InstrumentExploration;
      expect(body.credits).toHaveLength(1);
      expect(body.credits[0]!.musician).toBe('Ron Carter');
      expect(body.credits[0]!.displayRole).toBe('Upright Bass');
      expect(body.players).toHaveLength(1);
      expect(body.players[0]!.name).toBe('Paul McCartney');
      expect(body.players[0]!.playsInstrument).toContain('bass');
      expect(mockGetReleasesByInstrument).toHaveBeenCalledWith(expect.anything(), 'bass');
      expect(mockGetArtistsByPersonLevelInstrument).toHaveBeenCalledWith(expect.anything(), 'bass');
    });

    it('returns 200 with empty credits and players when nothing matches', async () => {
      mockGetReleasesByInstrument.mockResolvedValue([]);
      mockGetArtistsByPersonLevelInstrument.mockResolvedValue([]);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/instrument/harp',
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload)).toEqual({ credits: [], players: [] });
    });
  });

  // GET /api/v1/explore/work/:mbid
  describe('GET /api/v1/explore/work/:mbid', () => {
    const sampleRecording = {
      workTitle: 'Who Do You Love?',
      recordingMbid: 'a32adae6-6229-4f8e-8f75-f065b8073c35',
      trackTitle: 'Who Do You Love',
      position: 'A1',
      discogsId: 7000001,
      releaseTitle: 'La Bamba',
      artist: 'Bo Diddley',
      year: 1987,
      thumbUrl: null,
    };

    it('returns 200 with the work recordings and passes the mbid through', async () => {
      mockGetRecordingsByWork.mockResolvedValue([sampleRecording]);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/work/4f19a475-4607-31cc-aba9-390f5a007352',
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as (typeof sampleRecording)[];
      expect(body).toHaveLength(1);
      expect(body[0]!.recordingMbid).toBe('a32adae6-6229-4f8e-8f75-f065b8073c35');
      expect(mockGetRecordingsByWork).toHaveBeenCalledWith(
        expect.anything(),
        '4f19a475-4607-31cc-aba9-390f5a007352',
      );
    });

    it('returns 200 with empty array for an unknown work', async () => {
      mockGetRecordingsByWork.mockResolvedValue([]);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/work/unknown-mbid',
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload)).toEqual([]);
    });
  });

  // GET /api/v1/explore/songwriter/:name (#380)
  describe('GET /api/v1/explore/songwriter/:name', () => {
    const sampleSongwriterWork = {
      workMbid: 'work-songwriter-1',
      workTitle: 'A Written Song',
      roles: ['composer', 'lyricist'],
      recordingMbid: 'rec-songwriter-1',
      trackTitle: 'A Written Song',
      position: 'A1',
      discogsId: 7060001,
      releaseTitle: 'Songwriter LP',
      artist: 'Some Performer',
      year: 1972,
      thumbUrl: null,
    };

    it('returns 200 with the works written by the person and passes the name through', async () => {
      mockGetWorksBySongwriter.mockResolvedValue([sampleSongwriterWork]);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/songwriter/Bo%20Diddley',
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as (typeof sampleSongwriterWork)[];
      expect(body).toHaveLength(1);
      expect(body[0]!.roles).toEqual(['composer', 'lyricist']);
      expect(mockGetWorksBySongwriter).toHaveBeenCalledWith(expect.anything(), 'Bo Diddley');
    });

    it('returns 200 with empty array for a name with no WROTE edges', async () => {
      mockGetWorksBySongwriter.mockResolvedValue([]);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/songwriter/__nobody__',
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload)).toEqual([]);
    });
  });

  // GET /api/v1/explore/studio/:name
  describe('GET /api/v1/explore/studio/:name', () => {
    it('returns 200 with studio releases', async () => {
      mockGetReleasesByStudio.mockResolvedValue([sampleRelease]);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/studio/Capitol+Studios',
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as (typeof sampleRelease)[];
      expect(body).toHaveLength(1);
      expect(body[0]!.title).toBe('U.F.O.F.');
    });
  });

  // GET /api/v1/explore/recording-locations
  describe('GET /api/v1/explore/recording-locations', () => {
    const sampleLocation = {
      name: 'Abbey Road Studios',
      latitude: 51.53192,
      longitude: -0.17835,
      area: "St John's Wood",
      musicbrainzPlaceId: 'place-1',
      releaseCount: 3,
      trackCount: 8,
    };

    it('returns 200 with a bare array of studios that have coordinates', async () => {
      mockGetRecordingLocations.mockResolvedValue([sampleLocation]);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/recording-locations',
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as (typeof sampleLocation)[];
      expect(body).toEqual([sampleLocation]);
      expect(mockGetRecordingLocations).toHaveBeenCalledWith(expect.anything());
    });

    it('serialises null area / musicbrainzPlaceId and returns an empty array when none', async () => {
      mockGetRecordingLocations.mockResolvedValue([]);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/recording-locations',
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload)).toEqual([]);
    });
  });

  // GET /api/v1/explore/label/:name
  describe('GET /api/v1/explore/label/:name', () => {
    it('returns 200 with label releases (exact label by default)', async () => {
      mockGetReleasesByLabel.mockResolvedValue([sampleRelease]);
      const response = await app.inject({ method: 'GET', url: '/api/v1/explore/label/4AD' });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as (typeof sampleRelease)[];
      expect(body).toHaveLength(1);
      expect(mockGetReleasesByLabel).toHaveBeenCalledWith(expect.anything(), '4AD', false);
    });

    it('passes includeSublabels=true through to the repository', async () => {
      mockGetReleasesByLabel.mockResolvedValue([sampleRelease]);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/label/Columbia?includeSublabels=true',
      });
      expect(response.statusCode).toBe(200);
      expect(mockGetReleasesByLabel).toHaveBeenCalledWith(expect.anything(), 'Columbia', true);
    });
  });

  // GET /api/v1/explore/genre/:name
  describe('GET /api/v1/explore/genre/:name', () => {
    it('returns 200 with genre releases', async () => {
      mockGetReleasesByGenre.mockResolvedValue([sampleRelease]);
      const response = await app.inject({ method: 'GET', url: '/api/v1/explore/genre/Jazz' });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as (typeof sampleRelease)[];
      expect(body).toHaveLength(1);
    });
  });

  // GET /api/v1/explore/style/:name
  describe('GET /api/v1/explore/style/:name', () => {
    it('returns 200 with style releases', async () => {
      mockGetReleasesByStyle.mockResolvedValue([sampleRelease]);
      const response = await app.inject({ method: 'GET', url: '/api/v1/explore/style/Hard+Bop' });
      expect(response.statusCode).toBe(200);
    });
  });

  // GET /api/v1/explore/country/:name
  describe('GET /api/v1/explore/country/:name', () => {
    it('returns 200 with country releases', async () => {
      mockGetReleasesByCountry.mockResolvedValue([sampleRelease]);
      const response = await app.inject({ method: 'GET', url: '/api/v1/explore/country/US' });
      expect(response.statusCode).toBe(200);
    });
  });

  // GET /api/v1/explore/decade/:decade
  describe('GET /api/v1/explore/decade/:decade', () => {
    it('returns 200 for valid decade format', async () => {
      mockGetReleasesByDecade.mockResolvedValue([sampleRelease]);
      const response = await app.inject({ method: 'GET', url: '/api/v1/explore/decade/2010s' });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as (typeof sampleRelease)[];
      expect(body).toHaveLength(1);
    });

    it('returns 400 for invalid decade format (no trailing s)', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/explore/decade/2010' });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload) as { error: { code: string } };
      expect(body.error.code).toBe('INVALID_DECADE');
    });

    it('returns 400 for invalid decade format (non-numeric)', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/explore/decade/197Xs' });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload) as { error: { code: string } };
      expect(body.error.code).toBe('INVALID_DECADE');
    });

    it('returns 400 for non-decade-boundary year (e.g. 1975s)', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/explore/decade/1975s' });
      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.payload) as { error: { code: string } };
      expect(body.error.code).toBe('INVALID_DECADE');
    });
  });

  // GET /api/v1/explore/year/:year
  describe('GET /api/v1/explore/year/:year', () => {
    it('returns 200 for valid year', async () => {
      mockGetReleasesByYear.mockResolvedValue([sampleRelease]);
      const response = await app.inject({ method: 'GET', url: '/api/v1/explore/year/2019' });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as (typeof sampleRelease)[];
      expect(body).toHaveLength(1);
    });

    it('returns 400 for non-integer year', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/explore/year/notayear' });
      expect(response.statusCode).toBe(400);
    });
  });

  // GET /api/v1/explore/connections/:discogsId
  describe('GET /api/v1/explore/connections/:discogsId', () => {
    it('returns 200 with graph connections carrying edge-specificity weight', async () => {
      mockGetConnections.mockResolvedValue({
        seed: sampleRelease,
        nodes: [
          {
            type: 'Musician',
            discogsId: null,
            name: 'John Smith',
            title: null,
            degree: 4,
            weight: 0.25,
          },
        ],
      });
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/connections/13570466',
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as {
        seed: typeof sampleRelease;
        nodes: { degree: number; weight: number }[];
      };
      expect(body.seed.discogsId).toBe(13570466);
      expect(body.nodes).toHaveLength(1);
      expect(body.nodes[0]).toMatchObject({ degree: 4, weight: 0.25 });
    });

    it('returns 200 with explicit depth param', async () => {
      mockGetConnections.mockResolvedValue({ seed: sampleRelease, nodes: [] });
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/connections/13570466?depth=1',
      });
      expect(response.statusCode).toBe(200);
      expect(mockGetConnections).toHaveBeenCalledWith(expect.anything(), 13570466, 1);
    });

    it('returns 404 when release not found', async () => {
      mockGetConnections.mockResolvedValue(null);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/connections/99999',
      });
      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.payload) as { error: { code: string } };
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('returns 400 when depth exceeds 3', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/connections/13570466?depth=4',
      });
      expect(response.statusCode).toBe(400);
    });
  });

  // GET /api/v1/explore/related/:discogsId
  describe('GET /api/v1/explore/related/:discogsId', () => {
    const sampleRelated = {
      ...sampleRelease,
      discogsId: 9999991,
      title: 'Other Album',
      score: 0.7,
      bridges: [
        { type: 'Studio', name: 'Niche Studio', weight: 0.5 },
        { type: 'Musician', name: 'Shared Player', weight: 0.2 },
      ],
    };

    it('returns 200 with ranked related releases and bridge breakdown', async () => {
      mockGetRelatedReleases.mockResolvedValue([sampleRelated]);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/related/13570466',
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as (typeof sampleRelated)[];
      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({ discogsId: 9999991, score: 0.7 });
      expect(body[0]!.bridges[0]).toEqual({ type: 'Studio', name: 'Niche Studio', weight: 0.5 });
      expect(mockGetRelatedReleases).toHaveBeenCalledWith(expect.anything(), 13570466, 25);
    });

    it('passes an explicit limit through to the repository', async () => {
      mockGetRelatedReleases.mockResolvedValue([]);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/related/13570466?limit=5',
      });
      expect(response.statusCode).toBe(200);
      expect(mockGetRelatedReleases).toHaveBeenCalledWith(expect.anything(), 13570466, 5);
    });

    it('returns 404 when the release is unknown', async () => {
      mockGetRelatedReleases.mockResolvedValue(null);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/related/99999',
      });
      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.payload) as { error: { code: string } };
      expect(body.error.code).toBe('NOT_FOUND');
    });

    it('returns 400 when limit is below the minimum', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/related/13570466?limit=0',
      });
      expect(response.statusCode).toBe(400);
    });
  });

  // GET /api/v1/explore/path
  describe('GET /api/v1/explore/path', () => {
    const releaseNode = (discogsId: number, title: string) => ({
      type: 'Release',
      discogsId,
      name: null,
      title,
    });
    const samplePath = {
      from: releaseNode(7000001, 'Maiden Voyage'),
      to: releaseNode(7000002, 'Speak No Evil'),
      found: true,
      length: 2,
      maxDepth: 6,
      steps: [
        {
          relationship: 'CREDITED_ON',
          forward: false,
          role: 'Bass',
          instrument: 'bass',
          source: null,
          node: { type: 'Musician', discogsId: 111, name: 'Ron Carter', title: null },
        },
        {
          relationship: 'CREDITED_ON',
          forward: true,
          role: 'Bass',
          instrument: 'bass',
          source: null,
          node: releaseNode(7000002, 'Speak No Evil'),
        },
      ],
    };

    it('returns 200 with the shortest path and per-hop steps', async () => {
      mockGetPath.mockResolvedValue(samplePath);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/path?from=7000001&to=7000002',
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as typeof samplePath;
      expect(body.found).toBe(true);
      expect(body.length).toBe(2);
      expect(body.steps).toHaveLength(2);
      expect(body.steps[1]!.node.title).toBe('Speak No Evil');
    });

    it('parses numeric vs name endpoints independently (mixed types)', async () => {
      mockGetPath.mockResolvedValue(samplePath);
      await app.inject({
        method: 'GET',
        url: '/api/v1/explore/path?from=Ron+Carter&to=7000002',
      });
      expect(mockGetPath).toHaveBeenCalledWith(
        expect.anything(),
        { kind: 'person', name: 'Ron Carter' },
        { kind: 'release', discogsId: 7000002 },
        6,
      );
    });

    it('passes maxDepth through to the repository', async () => {
      mockGetPath.mockResolvedValue(samplePath);
      await app.inject({
        method: 'GET',
        url: '/api/v1/explore/path?from=7000001&to=7000002&maxDepth=3',
      });
      expect(mockGetPath).toHaveBeenCalledWith(
        expect.anything(),
        { kind: 'release', discogsId: 7000001 },
        { kind: 'release', discogsId: 7000002 },
        3,
      );
    });

    it('returns 200 with found:false when no path exists within maxDepth', async () => {
      mockGetPath.mockResolvedValue({
        from: releaseNode(7000001, 'Maiden Voyage'),
        to: releaseNode(7000099, 'Unconnected'),
        found: false,
        length: null,
        maxDepth: 6,
        steps: [],
      });
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/path?from=7000001&to=7000099',
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as { found: boolean; length: number | null };
      expect(body.found).toBe(false);
      expect(body.length).toBeNull();
    });

    it('returns 404 when the from endpoint resolves to no node', async () => {
      mockGetPath.mockResolvedValue({
        from: null,
        to: releaseNode(7000002, 'Speak No Evil'),
        found: false,
        length: null,
        maxDepth: 6,
        steps: [],
      });
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/path?from=99999999&to=7000002',
      });
      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.payload) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.message).toContain('from');
    });

    it('returns 404 when the to endpoint resolves to no node', async () => {
      mockGetPath.mockResolvedValue({
        from: releaseNode(7000001, 'Maiden Voyage'),
        to: null,
        found: false,
        length: null,
        maxDepth: 6,
        steps: [],
      });
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/path?from=7000001&to=__nobody__',
      });
      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.payload) as { error: { message: string } };
      expect(body.error.message).toContain('to');
    });

    it('returns 400 when a required endpoint query param is missing', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/path?from=7000001',
      });
      expect(response.statusCode).toBe(400);
    });
  });

  // GET /api/v1/explore/shared-musicians
  describe('GET /api/v1/explore/shared-musicians', () => {
    it('returns 200 with release pairs', async () => {
      mockGetSharedMusicians.mockResolvedValue([
        {
          releaseA: { discogsId: 13570466, title: 'U.F.O.F.' },
          releaseB: { discogsId: 9999991, title: 'Other Album' },
          sharedMusicians: [{ name: 'John Smith', instrument: 'Guitar' }],
        },
      ]);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/shared-musicians',
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload) as { sharedMusicians: unknown[] }[];
      expect(body).toHaveLength(1);
      expect(body[0]!.sharedMusicians).toHaveLength(1);
    });

    it('returns 200 with empty array when no pairs', async () => {
      mockGetSharedMusicians.mockResolvedValue([]);
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/shared-musicians',
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload)).toEqual([]);
    });
  });

  // GET /api/v1/explore/tracks/most-international
  describe('GET /api/v1/explore/tracks/most-international', () => {
    it('returns 200 and uses default limit when query param is omitted', async () => {
      mockGetMostInternationalTracks.mockResolvedValue([
        {
          trackTitle: 'UFOF',
          albumTitle: 'U.F.O.F.',
          releaseDiscogsId: 13570466,
          countryCount: 3,
          countries: ['US', 'GB', 'FR'],
        },
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/tracks/most-international',
      });

      expect(response.statusCode).toBe(200);
      expect(mockGetMostInternationalTracks).toHaveBeenCalledWith(expect.anything(), 10);
    });

    it('returns 200 and forwards explicit limit', async () => {
      mockGetMostInternationalTracks.mockResolvedValue([]);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/tracks/most-international?limit=5',
      });

      expect(response.statusCode).toBe(200);
      expect(mockGetMostInternationalTracks).toHaveBeenCalledWith(expect.anything(), 5);
    });
  });

  // GET /api/v1/explore/releases/most-pressed
  describe('GET /api/v1/explore/releases/most-pressed', () => {
    it('returns 200 and uses default limit when query param is omitted', async () => {
      mockGetMostPressedReleases.mockResolvedValue([
        {
          albumTitle: 'U.F.O.F.',
          masterDiscogsId: 12345,
          countryCount: 4,
          countries: ['US', 'GB', 'FR', 'JP'],
        },
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/releases/most-pressed',
      });

      expect(response.statusCode).toBe(200);
      expect(mockGetMostPressedReleases).toHaveBeenCalledWith(expect.anything(), 10);
    });

    it('returns 200 and forwards explicit limit', async () => {
      mockGetMostPressedReleases.mockResolvedValue([]);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/releases/most-pressed?limit=7',
      });

      expect(response.statusCode).toBe(200);
      expect(mockGetMostPressedReleases).toHaveBeenCalledWith(expect.anything(), 7);
    });
  });

  // GET /api/v1/explore/tracks/by-audio-features
  describe('GET /api/v1/explore/tracks/by-audio-features', () => {
    it('returns 200 and calls repository with empty filters and default limit', async () => {
      mockGetTracksByAudioFeatures.mockResolvedValue([]);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/tracks/by-audio-features',
      });

      expect(response.statusCode).toBe(200);
      expect(mockGetTracksByAudioFeatures).toHaveBeenCalledWith(expect.anything(), {}, 20);
    });

    it('returns 200 and forwards all provided filters and custom limit', async () => {
      mockGetTracksByAudioFeatures.mockResolvedValue([]);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/explore/tracks/by-audio-features?minTempo=90&maxTempo=120&key=C&scale=major&voiceInstrumental=voice&minDanceability=0.5&limit=12',
      });

      expect(response.statusCode).toBe(200);
      expect(mockGetTracksByAudioFeatures).toHaveBeenCalledWith(
        expect.anything(),
        {
          minTempo: 90,
          maxTempo: 120,
          key: 'C',
          scale: 'major',
          voiceInstrumental: 'voice',
          minDanceability: 0.5,
        },
        12,
      );
    });
  });
});
