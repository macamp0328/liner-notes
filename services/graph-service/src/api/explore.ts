import { FastifyInstance } from 'fastify';
import { getDriver } from '../db/client.js';
import {
  getReleasesByMusician,
  getReleasesByCredit,
  getReleasesByInstrument,
  getArtistsByPersonLevelInstrument,
  getRecordingsByWork,
  getWorksBySongwriter,
  getReleasesByStudio,
  getReleasesByLabel,
  getReleasesByGenre,
  getReleasesByStyle,
  getReleasesByCountry,
  getReleasesByDecade,
  getReleasesByYear,
  getConnections,
  getSharedMusicians,
  getMostInternationalTracks,
  getMostPressedReleases,
  getTracksByAudioFeatures,
  type ExploreRelease,
  type MusicianRelease,
  type InstrumentCredit,
  type InstrumentPlayer,
  type WorkRecording,
  type SongwriterWork,
  type ConnectionNode,
  type SharedMusiciansResult,
  type InternationalTrack,
  type MostPressedRelease,
  type AudioFeatureFilters,
  type AudioFeatureTrack,
} from '../db/repositories/explore-repository.js';
import { errorResponseRef } from './schemas.js';

// ---------------------------------------------------------------------------
// Shared schema fragments
// ---------------------------------------------------------------------------

const exploreReleaseSchema = {
  type: 'object',
  required: ['discogsId', 'title'],
  properties: {
    discogsId: { type: 'integer' },
    title: { type: 'string' },
    artist: { type: 'string', nullable: true },
    pressingYear: { type: 'integer', nullable: true },
    format: { type: 'string', nullable: true },
    thumbUrl: { type: 'string', nullable: true },
  },
} as const;

const musicianReleaseSchema = {
  type: 'object',
  required: ['discogsId', 'title'],
  properties: {
    discogsId: { type: 'integer' },
    title: { type: 'string' },
    artist: { type: 'string', nullable: true },
    pressingYear: { type: 'integer', nullable: true },
    format: { type: 'string', nullable: true },
    thumbUrl: { type: 'string', nullable: true },
    instrument: { type: 'string', nullable: true },
    role: { type: 'string', nullable: true },
  },
} as const;

const instrumentCreditSchema = {
  type: 'object',
  required: ['discogsId', 'title', 'musician'],
  properties: {
    discogsId: { type: 'integer' },
    title: { type: 'string' },
    artist: { type: 'string', nullable: true },
    pressingYear: { type: 'integer', nullable: true },
    format: { type: 'string', nullable: true },
    thumbUrl: { type: 'string', nullable: true },
    musician: { type: 'string' },
    instrument: { type: 'string', nullable: true },
    displayRole: { type: 'string', nullable: true },
    scope: { type: 'string', nullable: true },
  },
} as const;

// A person-level player of an instrument (#393): an Artist whose Wikidata P1303 set (normalized onto
// the #333 vocabulary) includes the queried family. `playsInstrument` is the artist's full list.
const instrumentPlayerSchema = {
  type: 'object',
  required: ['discogsId', 'name', 'playsInstrument'],
  properties: {
    discogsId: { type: 'integer' },
    name: { type: 'string' },
    playsInstrument: { type: 'array', items: { type: 'string' } },
  },
} as const;

// /explore/instrument/:name returns both axes (#393): `credits` is the per-credit axis (who is
// credited playing it, and on which release); `players` is the person-level axis (artists Wikidata
// documents as playing it). The one /explore route besides /connections that is not a bare array.
const instrumentExplorationSchema = {
  type: 'object',
  required: ['credits', 'players'],
  properties: {
    credits: { type: 'array', items: instrumentCreditSchema },
    players: { type: 'array', items: instrumentPlayerSchema },
  },
} as const;

const workRecordingSchema = {
  type: 'object',
  required: ['recordingMbid', 'trackTitle', 'discogsId', 'releaseTitle'],
  properties: {
    workTitle: { type: 'string' },
    recordingMbid: { type: 'string' },
    trackTitle: { type: 'string' },
    position: { type: 'string', nullable: true },
    discogsId: { type: 'integer' },
    releaseTitle: { type: 'string' },
    artist: { type: 'string', nullable: true },
    year: { type: 'integer', nullable: true },
    thumbUrl: { type: 'string', nullable: true },
  },
} as const;

const songwriterWorkSchema = {
  type: 'object',
  required: ['workMbid', 'workTitle', 'recordingMbid', 'trackTitle', 'discogsId', 'releaseTitle'],
  properties: {
    workMbid: { type: 'string' },
    workTitle: { type: 'string' },
    roles: { type: 'array', items: { type: 'string' } },
    recordingMbid: { type: 'string' },
    trackTitle: { type: 'string' },
    position: { type: 'string', nullable: true },
    discogsId: { type: 'integer' },
    releaseTitle: { type: 'string' },
    artist: { type: 'string', nullable: true },
    year: { type: 'integer', nullable: true },
    thumbUrl: { type: 'string', nullable: true },
  },
} as const;

const connectionNodeSchema = {
  type: 'object',
  required: ['type'],
  properties: {
    type: { type: 'string' },
    discogsId: { type: 'integer', nullable: true },
    name: { type: 'string', nullable: true },
    title: { type: 'string', nullable: true },
  },
} as const;

const connectionsResponseSchema = {
  type: 'object',
  required: ['seed', 'nodes'],
  properties: {
    seed: exploreReleaseSchema,
    nodes: { type: 'array', items: connectionNodeSchema },
  },
} as const;

const sharedMusiciansResponseSchema = {
  type: 'object',
  required: ['releaseA', 'releaseB', 'sharedMusicians'],
  properties: {
    releaseA: {
      type: 'object',
      required: ['discogsId', 'title'],
      properties: {
        discogsId: { type: 'integer' },
        title: { type: 'string' },
      },
    },
    releaseB: {
      type: 'object',
      required: ['discogsId', 'title'],
      properties: {
        discogsId: { type: 'integer' },
        title: { type: 'string' },
      },
    },
    sharedMusicians: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          instrument: { type: 'string', nullable: true },
        },
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Route types
// ---------------------------------------------------------------------------

interface NameParams {
  name: string;
}

interface MbidParams {
  mbid: string;
}

interface DecadeParams {
  decade: string;
}

interface YearParams {
  year: number;
}

interface DiscogsIdParams {
  discogsId: number;
}

interface DepthQuery {
  depth?: number;
}

interface ErrorReply {
  error: { code: string; message: string };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/require-await
export async function exploreRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/v1/explore/musician/:name
  fastify.get<{ Params: NameParams; Reply: MusicianRelease[] | ErrorReply }>(
    '/api/v1/explore/musician/:name',
    {
      schema: {
        tags: ['explore'],
        summary: 'Releases featuring this musician, with instrument and role on each result',
        description:
          'Resolves entity-resolution edges (#330), so results are not limited to the named credit ' +
          "node. The name is matched against Musician nodes AND, via `SAME_PERSON_AS`, an Artist's " +
          'canonical name — so querying an alias or the canonical name returns the same release set, ' +
          'over both release- and track-scoped credits. `MEMBER_OF` is expanded one way only: ' +
          "querying an individual also returns their group's records (an INFERRED, temporally-" +
          "unguarded involvement — the group's catalog, not necessarily records they personally " +
          'played on; date-qualified membership is roadmapped). Querying a group returns only the ' +
          "group's own credits — it is deliberately NOT expanded to its members' solo work, which " +
          'would over-attribute the group.',
        params: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
        response: {
          200: { type: 'array', items: musicianReleaseSchema },
          400: errorResponseRef,
        },
      },
    },
    async (request, reply): Promise<MusicianRelease[] | ErrorReply> => {
      const items = await getReleasesByMusician(getDriver(), request.params.name);
      return reply.send(items);
    },
  );

  // GET /api/v1/explore/producer/:name
  fastify.get<{ Params: NameParams; Reply: MusicianRelease[] | ErrorReply }>(
    '/api/v1/explore/producer/:name',
    {
      schema: {
        tags: ['explore'],
        summary: 'Releases this person is credited on as a producer',
        params: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
        response: {
          200: { type: 'array', items: musicianReleaseSchema },
          400: errorResponseRef,
        },
      },
    },
    async (request, reply): Promise<MusicianRelease[] | ErrorReply> => {
      const items = await getReleasesByCredit(getDriver(), request.params.name, 'producer');
      return reply.send(items);
    },
  );

  // GET /api/v1/explore/engineer/:name
  fastify.get<{ Params: NameParams; Reply: MusicianRelease[] | ErrorReply }>(
    '/api/v1/explore/engineer/:name',
    {
      schema: {
        tags: ['explore'],
        summary: 'Releases this person is credited on as an engineer',
        params: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
        response: {
          200: { type: 'array', items: musicianReleaseSchema },
          400: errorResponseRef,
        },
      },
    },
    async (request, reply): Promise<MusicianRelease[] | ErrorReply> => {
      const items = await getReleasesByCredit(getDriver(), request.params.name, 'engineer');
      return reply.send(items);
    },
  );

  // GET /api/v1/explore/instrument/:name
  fastify.get<{
    Params: NameParams;
    Reply: { credits: InstrumentCredit[]; players: InstrumentPlayer[] } | ErrorReply;
  }>(
    '/api/v1/explore/instrument/:name',
    {
      schema: {
        tags: ['explore'],
        summary: 'Who plays this instrument — per-credit (credits) and person-level (players)',
        description:
          'Returns both instrument axes (#393): `credits` are musicians credited playing the ' +
          'instrument and the releases they play it on (the #333 per-credit axis), and `players` ' +
          'are artists Wikidata (P1303) documents as playing it (the person-level axis).',
        params: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
        response: {
          200: instrumentExplorationSchema,
          400: errorResponseRef,
        },
      },
    },
    async (
      request,
      reply,
    ): Promise<{ credits: InstrumentCredit[]; players: InstrumentPlayer[] } | ErrorReply> => {
      const driver = getDriver();
      const [credits, players] = await Promise.all([
        getReleasesByInstrument(driver, request.params.name),
        getArtistsByPersonLevelInstrument(driver, request.params.name),
      ]);
      return reply.send({ credits, players });
    },
  );

  // GET /api/v1/explore/work/:mbid — every recording of a Work I own (versions/covers, #336)
  fastify.get<{ Params: MbidParams; Reply: WorkRecording[] | ErrorReply }>(
    '/api/v1/explore/work/:mbid',
    {
      schema: {
        tags: ['explore'],
        summary: 'Every recording of this MusicBrainz Work in the collection (versions/covers)',
        params: {
          type: 'object',
          required: ['mbid'],
          properties: { mbid: { type: 'string' } },
        },
        response: {
          200: { type: 'array', items: workRecordingSchema },
          400: errorResponseRef,
        },
      },
    },
    async (request, reply): Promise<WorkRecording[] | ErrorReply> => {
      const items = await getRecordingsByWork(getDriver(), request.params.mbid);
      return reply.send(items);
    },
  );

  // GET /api/v1/explore/songwriter/:name — every composition this person wrote that I own (#380)
  fastify.get<{ Params: NameParams; Reply: SongwriterWork[] | ErrorReply }>(
    '/api/v1/explore/songwriter/:name',
    {
      schema: {
        tags: ['explore'],
        summary: 'Compositions written by this person and the recordings of them in the collection',
        params: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
        response: {
          200: { type: 'array', items: songwriterWorkSchema },
          400: errorResponseRef,
        },
      },
    },
    async (request, reply): Promise<SongwriterWork[] | ErrorReply> => {
      const items = await getWorksBySongwriter(getDriver(), request.params.name);
      return reply.send(items);
    },
  );

  // GET /api/v1/explore/studio/:name
  fastify.get<{ Params: NameParams; Reply: ExploreRelease[] | ErrorReply }>(
    '/api/v1/explore/studio/:name',
    {
      schema: {
        tags: ['explore'],
        summary: 'Releases recorded at this studio',
        params: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
        response: {
          200: { type: 'array', items: exploreReleaseSchema },
        },
      },
    },
    async (request, reply): Promise<ExploreRelease[] | ErrorReply> => {
      const items = await getReleasesByStudio(getDriver(), request.params.name);
      return reply.send(items);
    },
  );

  // GET /api/v1/explore/label/:name
  fastify.get<{
    Params: NameParams;
    Querystring: { includeSublabels?: boolean };
    Reply: ExploreRelease[] | ErrorReply;
  }>(
    '/api/v1/explore/label/:name',
    {
      schema: {
        tags: ['explore'],
        summary: 'Releases on this label',
        description:
          'With `includeSublabels=true`, rolls up releases across the whole label family — the ' +
          'named label plus every label connected to it through PARENT_LABEL edges (its parent, ' +
          'ancestors, and their sublabels). Requires the label-hierarchy enrichment to have run.',
        params: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
        querystring: {
          type: 'object',
          properties: {
            includeSublabels: { type: 'boolean', default: false },
          },
        },
        response: {
          200: { type: 'array', items: exploreReleaseSchema },
        },
      },
    },
    async (request, reply): Promise<ExploreRelease[] | ErrorReply> => {
      const items = await getReleasesByLabel(
        getDriver(),
        request.params.name,
        request.query.includeSublabels ?? false,
      );
      return reply.send(items);
    },
  );

  // GET /api/v1/explore/genre/:name
  fastify.get<{ Params: NameParams; Reply: ExploreRelease[] | ErrorReply }>(
    '/api/v1/explore/genre/:name',
    {
      schema: {
        tags: ['explore'],
        summary: 'Releases in this genre',
        params: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
        response: {
          200: { type: 'array', items: exploreReleaseSchema },
        },
      },
    },
    async (request, reply): Promise<ExploreRelease[] | ErrorReply> => {
      const items = await getReleasesByGenre(getDriver(), request.params.name);
      return reply.send(items);
    },
  );

  // GET /api/v1/explore/style/:name
  fastify.get<{ Params: NameParams; Reply: ExploreRelease[] | ErrorReply }>(
    '/api/v1/explore/style/:name',
    {
      schema: {
        tags: ['explore'],
        summary: 'Releases in this style',
        params: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
        response: {
          200: { type: 'array', items: exploreReleaseSchema },
        },
      },
    },
    async (request, reply): Promise<ExploreRelease[] | ErrorReply> => {
      const items = await getReleasesByStyle(getDriver(), request.params.name);
      return reply.send(items);
    },
  );

  // GET /api/v1/explore/country/:name
  fastify.get<{ Params: NameParams; Reply: ExploreRelease[] | ErrorReply }>(
    '/api/v1/explore/country/:name',
    {
      schema: {
        tags: ['explore'],
        summary: 'Releases from this country',
        params: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
        response: {
          200: { type: 'array', items: exploreReleaseSchema },
        },
      },
    },
    async (request, reply): Promise<ExploreRelease[] | ErrorReply> => {
      const items = await getReleasesByCountry(getDriver(), request.params.name);
      return reply.send(items);
    },
  );

  // GET /api/v1/explore/decade/:decade
  fastify.get<{ Params: DecadeParams; Reply: ExploreRelease[] | ErrorReply }>(
    '/api/v1/explore/decade/:decade',
    {
      schema: {
        tags: ['explore'],
        summary: 'Releases from this decade — accepts 1970s format',
        params: {
          type: 'object',
          required: ['decade'],
          properties: { decade: { type: 'string' } },
        },
        response: {
          200: { type: 'array', items: exploreReleaseSchema },
          400: errorResponseRef,
        },
      },
    },
    async (request, reply): Promise<ExploreRelease[] | ErrorReply> => {
      if (!/^\d{3}0s$/.test(request.params.decade)) {
        return reply.code(400).send({
          error: { code: 'INVALID_DECADE', message: 'decade must be in the format 1970s' },
        });
      }
      const items = await getReleasesByDecade(getDriver(), request.params.decade);
      return reply.send(items);
    },
  );

  // GET /api/v1/explore/year/:year
  fastify.get<{ Params: YearParams; Reply: ExploreRelease[] | ErrorReply }>(
    '/api/v1/explore/year/:year',
    {
      schema: {
        tags: ['explore'],
        summary: 'Releases from this exact year',
        params: {
          type: 'object',
          required: ['year'],
          properties: { year: { type: 'integer', minimum: 1000, maximum: 9999 } },
        },
        response: {
          200: { type: 'array', items: exploreReleaseSchema },
        },
      },
    },
    async (request, reply): Promise<ExploreRelease[] | ErrorReply> => {
      const items = await getReleasesByYear(getDriver(), request.params.year);
      return reply.send(items);
    },
  );

  // GET /api/v1/explore/connections/:discogsId
  fastify.get<{
    Params: DiscogsIdParams;
    Querystring: DepthQuery;
    Reply: { seed: ExploreRelease; nodes: ConnectionNode[] } | ErrorReply;
  }>(
    '/api/v1/explore/connections/:discogsId',
    {
      schema: {
        tags: ['explore'],
        summary:
          'Graph traversal from a release — returns nodes reachable within depth hops (max 3)',
        params: {
          type: 'object',
          required: ['discogsId'],
          properties: { discogsId: { type: 'integer' } },
        },
        querystring: {
          type: 'object',
          properties: {
            depth: { type: 'integer', minimum: 1, maximum: 3, default: 2 },
          },
        },
        response: {
          200: connectionsResponseSchema,
          404: errorResponseRef,
        },
      },
    },
    async (
      request,
      reply,
    ): Promise<{ seed: ExploreRelease; nodes: ConnectionNode[] } | ErrorReply> => {
      const depth = request.query.depth ?? 2;
      const graph = await getConnections(getDriver(), request.params.discogsId, depth as 1 | 2 | 3);
      if (!graph) {
        return reply.code(404).send({
          error: { code: 'NOT_FOUND', message: 'Release not found' },
        });
      }
      return reply.send(graph);
    },
  );

  // GET /api/v1/explore/shared-musicians
  fastify.get<{ Reply: SharedMusiciansResult[] }>(
    '/api/v1/explore/shared-musicians',
    {
      schema: {
        tags: ['explore'],
        summary: 'Release pairs that share one or more session musicians',
        response: {
          200: { type: 'array', items: sharedMusiciansResponseSchema },
        },
      },
    },
    async (_request, reply): Promise<SharedMusiciansResult[]> => {
      const pairs = await getSharedMusicians(getDriver());
      return reply.send(pairs);
    },
  );

  // GET /api/v1/explore/tracks/most-international
  fastify.get<{
    Querystring: { limit?: number };
    Reply: InternationalTrack[] | ErrorReply;
  }>(
    '/api/v1/explore/tracks/most-international',
    {
      schema: {
        tags: ['explore'],
        summary:
          'Tracks with the most distinct countries of origin among their credited musicians. Requires nationality enrichment to have been run.',
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
          },
        },
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              required: [
                'trackTitle',
                'albumTitle',
                'releaseDiscogsId',
                'countryCount',
                'countries',
              ],
              properties: {
                trackTitle: { type: 'string' },
                albumTitle: { type: 'string' },
                releaseDiscogsId: { type: 'integer' },
                countryCount: { type: 'integer' },
                countries: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
    },
    async (request, reply): Promise<InternationalTrack[] | ErrorReply> => {
      const limit = request.query.limit ?? 10;
      const results = await getMostInternationalTracks(getDriver(), limit);
      return reply.send(results);
    },
  );

  // GET /api/v1/explore/releases/most-pressed
  fastify.get<{
    Querystring: { limit?: number };
    Reply: MostPressedRelease[] | ErrorReply;
  }>(
    '/api/v1/explore/releases/most-pressed',
    {
      schema: {
        tags: ['explore'],
        summary:
          'Albums in this collection with the widest global pressing reach. Requires master data enrichment to have been run.',
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
          },
        },
        response: {
          200: {
            type: 'array',
            items: {
              type: 'object',
              required: ['albumTitle', 'masterDiscogsId', 'countryCount', 'countries'],
              properties: {
                albumTitle: { type: 'string' },
                masterDiscogsId: { type: 'integer' },
                countryCount: { type: 'integer' },
                countries: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
    },
    async (request, reply): Promise<MostPressedRelease[] | ErrorReply> => {
      const limit = request.query.limit ?? 10;
      const results = await getMostPressedReleases(getDriver(), limit);
      return reply.send(results);
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/v1/explore/tracks/by-audio-features
  // ---------------------------------------------------------------------------

  const audioFeatureTrackSchema = {
    type: 'object',
    required: ['trackTitle', 'releaseTitle', 'releaseDiscogsId'],
    properties: {
      trackTitle: { type: 'string' },
      releaseTitle: { type: 'string' },
      releaseDiscogsId: { type: 'integer' },
      tempo: { type: 'number', nullable: true },
      musicalKey: { type: 'string', nullable: true },
      musicalScale: { type: 'string', nullable: true },
      loudnessDb: { type: 'number', nullable: true },
      danceabilityEstimate: { type: 'number', nullable: true },
      voiceInstrumental: { type: 'string', nullable: true },
      deezerBpm: { type: 'number', nullable: true },
      deezerGain: { type: 'number', nullable: true },
    },
  } as const;

  fastify.get<{
    Querystring: {
      minTempo?: number;
      maxTempo?: number;
      key?: string;
      scale?: string;
      voiceInstrumental?: string;
      minDanceability?: number;
      limit?: number;
    };
    Reply: AudioFeatureTrack[];
  }>(
    '/api/v1/explore/tracks/by-audio-features',
    {
      schema: {
        tags: ['explore'],
        summary: 'Find tracks by audio features',
        description:
          'Filter Track nodes by audio properties (tempo, musical key, scale, danceability, ' +
          'vocal/instrumental classifier). Returns tracks that have at least one audio feature ' +
          'populated (via AcousticBrainz or Deezer enrichment). All filter params are optional — ' +
          'omitting all returns up to `limit` enriched tracks ordered by tempo.\n\n' +
          '`minTempo`/`maxTempo` match against both `tempo` (AcousticBrainz) and `deezerBpm` ' +
          'so tracks with data from either source are included.',
        querystring: {
          type: 'object',
          properties: {
            minTempo: { type: 'number' },
            maxTempo: { type: 'number' },
            key: { type: 'string', description: 'Tonic, e.g. "C" or "A#"' },
            scale: {
              type: 'string',
              enum: ['major', 'minor'],
              description: 'Musical scale',
            },
            voiceInstrumental: {
              type: 'string',
              enum: ['voice', 'instrumental'],
              description: 'AcousticBrainz voice/instrumental classifier result',
            },
            minDanceability: {
              type: 'number',
              minimum: 0,
              maximum: 1,
              description: 'Minimum danceability probability (0–1)',
            },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
          },
        },
        response: {
          200: {
            type: 'array',
            items: audioFeatureTrackSchema,
          },
        },
      },
    },
    async (request, reply) => {
      const { minTempo, maxTempo, key, scale, voiceInstrumental, minDanceability, limit } =
        request.query;
      const filters: AudioFeatureFilters = {};
      if (minTempo !== undefined) filters.minTempo = minTempo;
      if (maxTempo !== undefined) filters.maxTempo = maxTempo;
      if (key !== undefined) filters.key = key;
      if (scale !== undefined) filters.scale = scale;
      if (voiceInstrumental !== undefined) filters.voiceInstrumental = voiceInstrumental;
      if (minDanceability !== undefined) filters.minDanceability = minDanceability;
      const results = await getTracksByAudioFeatures(getDriver(), filters, limit ?? 20);
      return reply.send(results);
    },
  );
}
