import {
  createRateLimitedFetch,
  type Logger,
  type RateLimitedFetch,
} from './rate-limited-fetch.js';
import {
  buildCircuitBreaker,
  closedSnapshot,
  CircuitBreakerOpenError,
  type CircuitBreaker,
  type CircuitBreakerSnapshot,
} from './circuit-breaker.js';
import { BULK_OUTBOUND_TIMEOUT_MS, resolveOutboundTimeoutMs } from './outbound-timeout.js';

export interface MbReleaseEvent {
  mbReleaseId: string;
  countryCode: string | null;
  date: string | null;
  formats: string[];
}

/** A single track of a MusicBrainz release, carrying its recording MBID and ISRC. */
export interface MbRecordingTrack {
  /** 1-based ordinal position across the entire release tracklist (all media flattened). */
  position: number;
  title: string;
  /** Track length in whole seconds; null when MusicBrainz has no length on file. */
  lengthSeconds: number | null;
  recordingMbid: string;
  /** First registered ISRC for the recording; null when none is registered. */
  isrc: string | null;
}

/** A MusicBrainz recording identified by the fallback recording search. */
export interface MbRecordingMatch {
  recordingMbid: string;
  isrc: string | null;
}

/**
 * A MusicBrainz Work (composition) reached from a recording's `performance` relationship.
 * The composition is the song as written; many recordings (covers, live takes, remasters)
 * are performances of the same Work — that shared `mbid` is the ground truth for versions (#336).
 */
export interface MbWork {
  mbid: string;
  title: string;
  type: string | null;
}

/** A writer of a MusicBrainz Work (composer / lyricist / writer), with their MB artist MBID. */
export interface MbWorkWriter {
  mbid: string;
  name: string;
  role: string;
}

/**
 * A track-attributable credit on a MusicBrainz recording, with the person's MB artist MBID. Covers
 * both **performance** credits (#335: `performer`/`instrument`/`vocal`) and **production** credits
 * (#339: producer + engineer family, mapped to a canonical role string — see
 * `RECORDING_PRODUCTION_ROLE_MAP`). The MBID is what lets the credit be reconciled to our
 * Discogs-keyed Musician nodes deterministically (the `mb-artist-id` join, #380) — never name-matching.
 */
export interface MbRecordingArtist {
  mbid: string;
  name: string;
  /**
   * The role token. For performance relations this is the raw MB relation type
   * (`performer` | `instrument` | `vocal`); for production relations it is the canonical role string
   * the MB type maps to (e.g. `producer`, `recording engineer`).
   */
  role: string;
  /**
   * Performance: instrument name(s) for `instrument`, vocal type(s) for `vocal`, empty for
   * `performer`. Production: always empty — MB production attributes are qualifiers
   * (`additional`/`co`/`executive`/…), not credit tokens, so they are dropped to keep the grouping's
   * `attributes ?? [role]` tokenization on the canonical role (#339).
   */
  attributes: string[];
}

/**
 * A studio a MusicBrainz recording was made at, from its `place-rels` (#339, slice 2). MusicBrainz
 * links a recording to a `Place` with a `recorded at` / `mixed at` relationship — a deterministic,
 * per-track studio attribution that Discogs (which only credits studios at the album level) cannot
 * give. The `name` is the join key onto our existing name-keyed `Studio` nodes; the Place's
 * `coordinates` + `area` ride along as clean location data (feeds the recording-location map, #342),
 * and `placeMbid` records provenance even though `name` stays the merge key.
 */
export interface MbRecordingPlace {
  /** MusicBrainz Place MBID — provenance only; Studio nodes merge by `name`, not this. */
  placeMbid: string;
  name: string;
  /** The MB relation type, `recorded at` or `mixed at` — kept on the edge for provenance. */
  relation: string;
  /** Decimal degrees; null when the Place carries no coordinates. */
  latitude: number | null;
  longitude: number | null;
  /** The Place's area name (city/region), e.g. "St John's Wood"; null when absent. */
  area: string | null;
}

export interface MusicBrainzClientConfig {
  userAgent: string;
  /** Milliseconds to sleep after every successful request. 1100ms keeps us safely under 1 req/sec. */
  delayMs: number;
  /** Minimum backoff on 429/503. Defaults to 2000ms. Set to 0 in tests to keep them fast. */
  backoffBaseMs?: number;
  /** Per-request timeout in ms (#357). Falls back to the shared fetch default when omitted. */
  timeoutMs?: number;
  /** Injectable RNG in [0,1) for deterministic backoff jitter in tests; defaults to Math.random. */
  random?: () => number;
  logger?: Logger;
  /** Disable the per-source circuit breaker (#242); on by default. */
  disableCircuitBreaker?: boolean;
}

interface MbUrlResponse {
  id: string;
  resource: string;
  relations: Array<{
    type: string;
    direction: string;
    artist?: { id: string; name: string };
    release_group?: { id: string };
    release?: { id: string };
  }>;
}

interface MbReleaseWithRecordingsResponse {
  id: string;
  media?: Array<{
    tracks?: Array<{
      id: string;
      title: string;
      length?: number | null;
      recording: {
        id: string;
        title: string;
        length?: number | null;
        isrcs?: string[];
      };
    }>;
  }>;
}

interface MbRecordingSearchResponse {
  recordings?: Array<{
    id: string;
    score: number;
    title: string;
    length?: number | null;
    isrcs?: string[];
  }>;
}

interface MbRecordingWorkRelsResponse {
  id: string;
  relations?: Array<{
    type: string;
    'target-type'?: string;
    work?: { id: string; title: string; type?: string | null };
  }>;
}

interface MbWorkArtistRelsResponse {
  id: string;
  relations?: Array<{
    type: string;
    'target-type'?: string;
    artist?: { id: string; name: string };
  }>;
}

interface MbRecordingArtistRelsResponse {
  id: string;
  relations?: Array<{
    type: string;
    'target-type'?: string;
    attributes?: string[];
    artist?: { id: string; name: string };
  }>;
}

interface MbRecordingPlaceRelsResponse {
  id: string;
  relations?: Array<{
    type: string;
    'target-type'?: string;
    // MusicBrainz returns coordinates as strings (e.g. "51.53192"), so parse defensively.
    place?: {
      id: string;
      name: string;
      coordinates?: { latitude?: string; longitude?: string };
      area?: { name?: string };
    };
  }>;
}

interface MbReleaseListResponse {
  'release-count': number;
  releases: Array<{
    id: string;
    'release-events'?: Array<{
      date?: string;
      area?: {
        'iso-3166-1-codes'?: string[];
      };
    }>;
    media?: Array<{ format?: string }>;
  }>;
}

interface MbArtistResponse {
  id: string;
  name: string;
  country?: string;
  area?: {
    'iso-3166-1-codes'?: string[];
  };
}

interface MbSearchResponse {
  artists: Array<{
    id: string;
    name: string;
    score: number;
    country?: string;
  }>;
}

const BASE_URL = 'https://musicbrainz.org/ws/2';
const MAX_RETRIES = 3;
const DEFAULT_BACKOFF_BASE_MS = 2_000;
/** Minimum MusicBrainz search score to accept a fallback recording match. */
const MIN_RECORDING_SEARCH_SCORE = 90;
/** Work artist-relation types we treat as authorship (#336). */
const WORK_WRITER_ROLES = new Set(['composer', 'lyricist', 'writer']);
/**
 * Recording artist-relation types we treat as track-attributable performance credits (#335).
 */
const RECORDING_PERFORMANCE_ROLES = new Set(['performer', 'instrument', 'vocal']);

/**
 * Recording place-relation types we treat as "this track was made at this studio" (#339, slice 2).
 * Mirrors the Discogs Studio path, which collapses `entity_type` 23 (*Recorded At*) + 27 (*Mixed At*)
 * into one `RECORDED_AT` edge — so both map to a single `(:Track)-[:RECORDED_AT]->(:Studio)`, with the
 * specific MB type kept on the edge's `relation` property. Other recording↔place types (if any) are
 * not pushed down to a track in this slice; add to this set to broaden.
 */
const RECORDING_PLACE_RELATIONS = new Set(['recorded at', 'mixed at']);

/**
 * Recording-level production/engineering artist-relation types we now push down to track scope (#339),
 * each mapped to a canonical role string. MusicBrainz models these at the recording level — genuinely
 * track-attributable, unlike Discogs's album-level production credits. The mapping is chosen so the
 * existing `parseRoleCategory` buckets each as `producer`/`engineer` (every engineer-family value
 * contains the substring `engineer`) and `parseDisplayRole` reads well. The bare `engineer` umbrella
 * is included on purpose — many recordings credit a generic engineer with no sub-role, and omitting it
 * would silently drop real data.
 *
 * Deliberately EXCLUDED (kept release-scoped or out of this slice): `mastering`/lacquer/cover-art
 * (inherently whole-release; `mastering` is also deprecated at recording level in MB), `remixer` (a
 * derivative recording — the lineage epic), and the niche `programming`/`editor`/`sound effects`. The
 * `arranger` family IS pushed down — recording-level arranging is track-attributable — via the separate
 * `RECORDING_ARRANGER_ROLE_MAP` below. MB production attributes (`additional`/`co`/`executive`/…) are
 * qualifiers, not credit tokens, and are dropped (see `getArtistsByRecordingMbid`).
 */
const RECORDING_PRODUCTION_ROLE_MAP: ReadonlyMap<string, string> = new Map([
  ['producer', 'producer'],
  ['engineer', 'engineer'],
  ['recording', 'recording engineer'],
  ['mix', 'mixing engineer'],
  ['audio', 'audio engineer'],
  ['sound', 'sound engineer'],
  ['balance', 'balance engineer'],
]);

/**
 * Recording-level arranging artist-relation types, also pushed down to track scope (#339). MusicBrainz
 * models arranging at the recording level — the person who arranged THIS recording — so it is genuinely
 * track-attributable, exactly like the production credits above (and unlike a whole-composition writing
 * credit, which the #336/#380 Work axis owns). Each maps to a canonical role string chosen so
 * `parseRoleCategory` buckets it `composer`: the three `*arranger` slugs match the existing
 * `arranger`/`arranged by` keyword, and `orchestrator` is covered by the `orchestrat` keyword added to
 * the composer bucket in `transforms.ts`. Qualifier attributes are dropped, same as production.
 */
const RECORDING_ARRANGER_ROLE_MAP: ReadonlyMap<string, string> = new Map([
  ['arranger', 'arranger'],
  ['instrument arranger', 'instrument arranger'],
  ['vocal arranger', 'vocal arranger'],
  ['orchestrator', 'orchestrator'],
]);

/** Convert a MusicBrainz millisecond length to whole seconds; null for missing or non-positive values. */
function msToSeconds(ms: number | null | undefined): number | null {
  if (ms === null || ms === undefined || ms <= 0) return null;
  return Math.round(ms / 1_000);
}

/** Strip double quotes so a value can be embedded inside a Lucene phrase query. */
function escapeLucenePhrase(value: string): string {
  return value.replace(/"/g, ' ').trim();
}

/** Parse a MusicBrainz coordinate string (e.g. "51.53192") to a number; null for absent/non-numeric. */
function parseCoordinate(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number.parseFloat(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export class MusicBrainzClient {
  private readonly userAgent: string;
  private readonly rlFetch: RateLimitedFetch;
  private readonly breaker: CircuitBreaker | undefined;

  constructor(config: MusicBrainzClientConfig) {
    this.userAgent = config.userAgent;
    this.breaker =
      config.disableCircuitBreaker === true
        ? undefined
        : buildCircuitBreaker('musicbrainz', config.logger);
    this.rlFetch = createRateLimitedFetch({
      label: 'musicbrainz-client',
      apiName: 'MusicBrainz API',
      delayMs: config.delayMs,
      maxRetries: MAX_RETRIES,
      backoffBaseMs: config.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS,
      retryStatuses: [429, 503],
      ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
      ...(config.random !== undefined ? { random: config.random } : {}),
      ...(config.logger !== undefined ? { logger: config.logger } : {}),
      ...(this.breaker !== undefined ? { breaker: this.breaker } : {}),
    });
  }

  /** Current circuit-breaker state for run-summary surfacing; closed when the breaker is off. */
  breakerSnapshot(): CircuitBreakerSnapshot {
    return this.breaker?.snapshot() ?? closedSnapshot('musicbrainz');
  }

  /**
   * Resolve a Discogs master ID to a MusicBrainz release group MBID.
   * Returns null when the master is not linked in MusicBrainz.
   */
  async getReleaseGroupMbidByMasterDiscogsId(masterDiscogsId: number): Promise<string | null> {
    const resource = `https://www.discogs.com/master/${masterDiscogsId}`;
    const endpoint = `${BASE_URL}/url?resource=${encodeURIComponent(resource)}&inc=release-group-rels&fmt=json`;

    let response: MbUrlResponse;
    try {
      response = await this.fetchWithBackoff<MbUrlResponse>(endpoint);
    } catch (err) {
      if (err instanceof CircuitBreakerOpenError) return null;
      if (err instanceof Error && err.message.includes('not found (404)')) {
        return null;
      }
      throw err;
    }

    const relation = response.relations.find(
      (r) =>
        r.type === 'discogs' && r.direction === 'backward' && r.release_group?.id !== undefined,
    );
    return relation?.release_group?.id ?? null;
  }

  /**
   * Fetch all official release events for a MusicBrainz release group MBID.
   * Paginates until all releases are collected. Filters events where both countryCode and date are null.
   */
  async getReleaseEventsByReleaseGroupMbid(mbid: string): Promise<MbReleaseEvent[]> {
    const events: MbReleaseEvent[] = [];
    const limit = 100;
    let offset = 0;
    let totalCount = Infinity;

    while (offset < totalCount) {
      // release-events are returned by default on the browse endpoint; `inc=release-events`
      // is rejected as invalid there. inc=media is only to populate per-release formats.
      const endpoint =
        `${BASE_URL}/release?release-group=${encodeURIComponent(mbid)}` +
        `&status=official&inc=media&fmt=json&limit=${limit}&offset=${offset}`;

      let page: MbReleaseListResponse;
      try {
        page = await this.fetchWithBackoff<MbReleaseListResponse>(endpoint);
      } catch (err) {
        // An open breaker ends the walk early; return whatever was collected (typically none).
        if (err instanceof CircuitBreakerOpenError) return events;
        throw err;
      }
      totalCount = page['release-count'];
      const releases = page.releases ?? [];

      for (const release of releases) {
        const formats = [
          ...new Set((release.media ?? []).map((m) => m.format).filter((f): f is string => !!f)),
        ];

        for (const event of release['release-events'] ?? []) {
          const countryCode = event.area?.['iso-3166-1-codes']?.[0] ?? null;
          const date = event.date?.trim() || null;

          if (countryCode === null && date === null) continue;

          events.push({ mbReleaseId: release.id, countryCode, date, formats });
        }
      }

      offset += releases.length;
      if (releases.length === 0) break;
    }

    return events;
  }

  /**
   * Resolve a Discogs release ID to a MusicBrainz release MBID via the Discogs URL relation.
   * Returns null when the release is not linked in MusicBrainz.
   */
  async getReleaseMbidByDiscogsReleaseId(discogsReleaseId: number): Promise<string | null> {
    const resource = `https://www.discogs.com/release/${discogsReleaseId}`;
    const endpoint = `${BASE_URL}/url?resource=${encodeURIComponent(resource)}&inc=release-rels&fmt=json`;

    let response: MbUrlResponse;
    try {
      response = await this.fetchWithBackoff<MbUrlResponse>(endpoint);
    } catch (err) {
      if (err instanceof CircuitBreakerOpenError) return null;
      if (err instanceof Error && err.message.includes('not found (404)')) {
        return null;
      }
      throw err;
    }

    const relation = response.relations.find(
      (r) => r.type === 'discogs' && r.direction === 'backward' && r.release?.id !== undefined,
    );
    return relation?.release?.id ?? null;
  }

  /**
   * Fetch the tracklist of a MusicBrainz release with recording MBIDs and ISRCs.
   * Flattens all media into a single ordinal-ordered list. Returns an empty array
   * when the release has no tracks.
   */
  async getRecordingsByReleaseMbid(mbReleaseId: string): Promise<MbRecordingTrack[]> {
    const endpoint = `${BASE_URL}/release/${encodeURIComponent(mbReleaseId)}?inc=recordings+isrcs&fmt=json`;
    let response: MbReleaseWithRecordingsResponse;
    try {
      response = await this.fetchWithBackoff<MbReleaseWithRecordingsResponse>(endpoint);
    } catch (err) {
      // An open breaker yields no tracks — the caller treats that as "no MusicBrainz match".
      if (err instanceof CircuitBreakerOpenError) return [];
      throw err;
    }

    const tracks: MbRecordingTrack[] = [];
    let position = 0;
    for (const medium of response.media ?? []) {
      for (const track of medium.tracks ?? []) {
        position++;
        tracks.push({
          position,
          title: track.title,
          lengthSeconds: msToSeconds(track.length ?? track.recording.length),
          recordingMbid: track.recording.id,
          isrc: track.recording.isrcs?.[0] ?? null,
        });
      }
    }
    return tracks;
  }

  /**
   * Resolve a recording MBID to the MusicBrainz Work(s) it is a performance of (#336).
   * Uses `inc=work-rels`; reads `relations[]` where `type === 'performance'` (the embedded
   * `work` object carries the composition's mbid/title/type). A recording can perform more
   * than one work (medleys), so all are returned. Empty array when the recording has no work
   * relationship, the breaker is open, or the recording 404s (treated as "no work" — a known
   * recordingMbid that no longer resolves is not retried until the staleness window expires).
   */
  async getWorksByRecordingMbid(recordingMbid: string): Promise<MbWork[]> {
    const endpoint = `${BASE_URL}/recording/${encodeURIComponent(recordingMbid)}?inc=work-rels&fmt=json`;

    let response: MbRecordingWorkRelsResponse;
    try {
      response = await this.fetchWithBackoff<MbRecordingWorkRelsResponse>(endpoint);
    } catch (err) {
      if (err instanceof CircuitBreakerOpenError) return [];
      if (err instanceof Error && err.message.includes('not found (404)')) return [];
      throw err;
    }

    const works: MbWork[] = [];
    for (const rel of response.relations ?? []) {
      if (
        rel.type === 'performance' &&
        rel['target-type'] === 'work' &&
        rel.work?.id !== undefined
      ) {
        works.push({ mbid: rel.work.id, title: rel.work.title, type: rel.work.type ?? null });
      }
    }
    return works;
  }

  /**
   * Fetch the writers (composer / lyricist / writer) of a MusicBrainz Work (#336), each with
   * their MB artist MBID. Uses `inc=artist-rels`; reads `relations[]` whose `type` is an
   * authorship role. The MB artist MBID is retained so a future pass can reconcile these to our
   * Discogs-keyed Musician nodes deterministically (there is no such mapping today). Empty array
   * on no writers, an open breaker, or a 404.
   */
  async getWritersByWorkMbid(workMbid: string): Promise<MbWorkWriter[]> {
    const endpoint = `${BASE_URL}/work/${encodeURIComponent(workMbid)}?inc=artist-rels&fmt=json`;

    let response: MbWorkArtistRelsResponse;
    try {
      response = await this.fetchWithBackoff<MbWorkArtistRelsResponse>(endpoint);
    } catch (err) {
      if (err instanceof CircuitBreakerOpenError) return [];
      if (err instanceof Error && err.message.includes('not found (404)')) return [];
      throw err;
    }

    const writers: MbWorkWriter[] = [];
    for (const rel of response.relations ?? []) {
      if (WORK_WRITER_ROLES.has(rel.type) && rel.artist?.id !== undefined) {
        writers.push({ mbid: rel.artist.id, name: rel.artist.name, role: rel.type });
      }
    }
    return writers;
  }

  /**
   * Fetch the track-attributable credits of a MusicBrainz recording from its artist relationships.
   * Uses `inc=artist-rels`; reads `relations[]` whose `type` is a **performance** role
   * (#335: `performer`/`instrument`/`vocal`, instrument/vocal name in `attributes`), a **production**
   * role (#339: `RECORDING_PRODUCTION_ROLE_MAP` — producer + engineer family) or an **arranging** role
   * (#339: `RECORDING_ARRANGER_ROLE_MAP` — arranger family + orchestrator); the latter two are mapped to
   * a canonical role string with attributes dropped. Roles outside all three sets (`mastering`,
   * `remixer`, …) are not pushed down to a track. Each person's MB artist MBID is retained
   * so the credit reconciles to our Discogs-keyed Musician nodes deterministically (the `mb-artist-id`
   * join, #380) — never name-matching. Empty array on no track-attributable credits, an open breaker,
   * or a 404 (a known recordingMbid that no longer resolves is not retried until the staleness window
   * expires).
   */
  async getArtistsByRecordingMbid(recordingMbid: string): Promise<MbRecordingArtist[]> {
    const endpoint = `${BASE_URL}/recording/${encodeURIComponent(recordingMbid)}?inc=artist-rels&fmt=json`;

    let response: MbRecordingArtistRelsResponse;
    try {
      response = await this.fetchWithBackoff<MbRecordingArtistRelsResponse>(endpoint);
    } catch (err) {
      if (err instanceof CircuitBreakerOpenError) return [];
      if (err instanceof Error && err.message.includes('not found (404)')) return [];
      throw err;
    }

    const artists: MbRecordingArtist[] = [];
    for (const rel of response.relations ?? []) {
      if (rel['target-type'] !== 'artist' || rel.artist?.id === undefined) continue;

      if (RECORDING_PERFORMANCE_ROLES.has(rel.type)) {
        artists.push({
          mbid: rel.artist.id,
          name: rel.artist.name,
          role: rel.type,
          attributes: rel.attributes ?? [],
        });
        continue;
      }

      const productionRole = RECORDING_PRODUCTION_ROLE_MAP.get(rel.type);
      if (productionRole !== undefined) {
        // Qualifier attributes (additional/co/executive/…) are dropped: the credit token is the
        // canonical role, so the grouping must tokenize on `role`, not on `attributes` (#339).
        artists.push({
          mbid: rel.artist.id,
          name: rel.artist.name,
          role: productionRole,
          attributes: [],
        });
        continue;
      }

      const arrangerRole = RECORDING_ARRANGER_ROLE_MAP.get(rel.type);
      if (arrangerRole !== undefined) {
        // Recording-level arranging is track-attributable (#339); like production, the credit token is
        // the canonical role and qualifier attributes are dropped.
        artists.push({
          mbid: rel.artist.id,
          name: rel.artist.name,
          role: arrangerRole,
          attributes: [],
        });
      }
    }
    return artists;
  }

  /**
   * Fetch the studios a MusicBrainz recording was made at, from its place relationships (#339, slice
   * 2). Uses `inc=place-rels`; reads `relations[]` whose `target-type` is `place` and whose `type` is
   * `recorded at` / `mixed at` (`RECORDING_PLACE_RELATIONS`). MusicBrainz models this at the recording
   * level, so it is a deterministic per-track studio attribution — unlike Discogs, which only credits
   * studios at the album level. Each Place's `name` joins onto our name-keyed `Studio` nodes; its
   * `coordinates` (strings → parsed to decimal degrees) and `area` ride along as clean location data,
   * with the Place MBID retained as provenance. Empty array on no place relations, an open breaker, or
   * a 404 (a known recordingMbid that no longer resolves is not retried until the staleness window
   * expires).
   */
  async getPlacesByRecordingMbid(recordingMbid: string): Promise<MbRecordingPlace[]> {
    const endpoint = `${BASE_URL}/recording/${encodeURIComponent(recordingMbid)}?inc=place-rels&fmt=json`;

    let response: MbRecordingPlaceRelsResponse;
    try {
      response = await this.fetchWithBackoff<MbRecordingPlaceRelsResponse>(endpoint);
    } catch (err) {
      if (err instanceof CircuitBreakerOpenError) return [];
      if (err instanceof Error && err.message.includes('not found (404)')) return [];
      throw err;
    }

    const places: MbRecordingPlace[] = [];
    for (const rel of response.relations ?? []) {
      if (rel['target-type'] !== 'place' || rel.place?.id === undefined) continue;
      if (!RECORDING_PLACE_RELATIONS.has(rel.type)) continue;

      places.push({
        placeMbid: rel.place.id,
        name: rel.place.name,
        relation: rel.type,
        latitude: parseCoordinate(rel.place.coordinates?.latitude),
        longitude: parseCoordinate(rel.place.coordinates?.longitude),
        area: rel.place.area?.name?.trim() || null,
      });
    }
    return places;
  }

  /**
   * Fallback path — search MusicBrainz directly for a recording by title and artist,
   * optionally constrained by duration. Only returns a match when the top result
   * scores at least MIN_RECORDING_SEARCH_SCORE. Returns null otherwise.
   */
  async searchRecording(
    title: string,
    artist: string,
    durationSeconds: number | null,
  ): Promise<MbRecordingMatch | null> {
    const cleanTitle = escapeLucenePhrase(title);
    const cleanArtist = escapeLucenePhrase(artist);
    if (cleanTitle === '' || cleanArtist === '') return null;

    let query = `recording:"${cleanTitle}" AND artist:"${cleanArtist}"`;
    if (durationSeconds !== null) {
      const lo = Math.max(0, durationSeconds * 1_000 - 2_000);
      const hi = durationSeconds * 1_000 + 2_000;
      query += ` AND dur:[${lo} TO ${hi}]`;
    }

    const endpoint = `${BASE_URL}/recording?query=${encodeURIComponent(query)}&limit=1&fmt=json`;

    let response: MbRecordingSearchResponse;
    try {
      response = await this.fetchWithBackoff<MbRecordingSearchResponse>(endpoint);
    } catch {
      return null;
    }

    const top = response.recordings?.[0];
    if (!top || top.score < MIN_RECORDING_SEARCH_SCORE) return null;
    return { recordingMbid: top.id, isrc: top.isrcs?.[0] ?? null };
  }

  /**
   * Resolve a Discogs artist ID to its MusicBrainz artist MBID via the Discogs-URL relation
   * (`/ws/2/url?...&inc=artist-rels`). Returns null when MusicBrainz has no Discogs link for the
   * artist (or on a transient/breaker failure). This is the identity-mapping half that #380 stores
   * as `Artist.musicbrainzId` / `Musician.musicbrainzId` so writer MBIDs can be promoted to WROTE
   * edges deterministically — and that `getCountryByDiscogsId` reuses below.
   */
  async resolveArtistMbidByDiscogsId(discogsId: number): Promise<string | null> {
    const urlResource = `https://www.discogs.com/artist/${discogsId}`;
    const urlEndpoint = `${BASE_URL}/url?resource=${encodeURIComponent(urlResource)}&inc=artist-rels&fmt=json`;

    let urlResponse: MbUrlResponse;
    try {
      urlResponse = await this.fetchWithBackoff<MbUrlResponse>(urlEndpoint);
    } catch {
      return null;
    }

    const relation = urlResponse.relations.find(
      (r) => r.type === 'discogs' && r.direction === 'backward' && r.artist?.id !== undefined,
    );
    return relation?.artist?.id ?? null;
  }

  /**
   * Look up an artist by Discogs ID and return their ISO 3166-1 alpha-2 country code.
   * Uses a two-step lookup: Discogs URL → MBID → artist country.
   * Returns null when the artist is not in MusicBrainz or has no country set.
   */
  async getCountryByDiscogsId(discogsId: number): Promise<string | null> {
    const mbid = await this.resolveArtistMbidByDiscogsId(discogsId);
    if (!mbid) return null;
    return this.getCountryByMbid(mbid);
  }

  /**
   * Search for an artist by name and return their ISO 3166-1 alpha-2 country code.
   * Only returns a result when MusicBrainz confidence score is ≥ 90.
   * Less reliable than getCountryByDiscogsId — use as fallback only.
   */
  async getCountryByName(name: string): Promise<string | null> {
    const searchEndpoint = `${BASE_URL}/artist?query=${encodeURIComponent(`artist:${name}`)}&limit=1&fmt=json`;

    let response: MbSearchResponse;
    try {
      response = await this.fetchWithBackoff<MbSearchResponse>(searchEndpoint);
    } catch {
      return null;
    }

    const topResult = response.artists[0];
    if (!topResult || topResult.score < 90) return null;
    return topResult.country?.trim() || null;
  }

  /**
   * Fetch an artist's ISO 3166-1 alpha-2 country code by MusicBrainz artist MBID. Public so
   * nationality enrichment can reuse a `musicbrainzId` already resolved by the `mb-artist-id` pass
   * (#380) and skip the `/url` lookup — net-zero MusicBrainz calls across the two stages.
   */
  async getCountryByMbid(mbid: string): Promise<string | null> {
    const artistEndpoint = `${BASE_URL}/artist/${encodeURIComponent(mbid)}?fmt=json`;

    let response: MbArtistResponse;
    try {
      response = await this.fetchWithBackoff<MbArtistResponse>(artistEndpoint);
    } catch {
      return null;
    }

    return response.country?.trim() || response.area?.['iso-3166-1-codes']?.[0]?.trim() || null;
  }

  private async fetchWithBackoff<T>(url: string): Promise<T> {
    const response = await this.rlFetch(url, {
      headers: {
        'User-Agent': this.userAgent,
        Accept: 'application/json',
      },
    });

    if (response.status === 404) {
      throw new Error(`MusicBrainz: not found (404) for ${url}`);
    }

    if (!response.ok) {
      throw new Error(`MusicBrainz API error ${response.status} ${response.statusText} for ${url}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/html')) {
      throw new Error(`MusicBrainz: received HTML response (status ${response.status}) for ${url}`);
    }

    return (await response.json()) as T;
  }
}

export function buildMusicBrainzClientFromEnv(logger?: Logger): MusicBrainzClient | null {
  const userAgent = process.env['MUSICBRAINZ_USER_AGENT'];
  if (!userAgent) return null;
  return new MusicBrainzClient({
    userAgent,
    delayMs: 1100,
    timeoutMs: resolveOutboundTimeoutMs(BULK_OUTBOUND_TIMEOUT_MS),
    ...(logger !== undefined ? { logger } : {}),
  });
}
