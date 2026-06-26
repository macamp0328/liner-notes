import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  STAGE_DEFINITIONS,
  CLIENT_REGISTRY,
  toStageDescriptor,
  type EnrichmentStageName,
  type ResolvedClients,
} from '../../../src/ingestion/stage-definitions.js';
import { RELOAD_STAGES } from '../../../src/ingestion/stages.js';
import type { ReloadContext } from '../../../src/ingestion/stages.js';
import { toPipelineEntry } from '../../../src/api/admin.js';
import type { Logger } from '../../../src/ingestion/discogs-client.js';
import { snapshotEnv } from '../../helpers/env.js';

// #477 — STAGE_DEFINITIONS is the single source of truth; RELOAD_STAGES and the admin PIPELINES route
// table both DERIVE from it. These tests are the build/test-time catch the issue asks for: a stage
// missing from the registry, or whose reload/admin facts drift, fails here rather than silently at
// runtime (a stage that never runs, or a route that 503s when it shouldn't).

const ENRICHMENT_STAGE_NAMES = [
  'lyrics',
  'nationality',
  'master-data',
  'mb-release-events',
  'track-musicbrainz',
  'track-works',
  'track-recording-artists',
  'track-recording-places',
  'track-acousticbrainz',
  'track-deezer',
  'artist-profiles',
  'artist-genres',
  'label-hierarchy',
  'group-members',
  'person-reconciliation',
  'mb-artist-id',
  'songwriter-reconciliation',
  'artist-wikidata',
  'artist-influences',
  'band-membership',
] as const;

// Compile-time exhaustiveness: TS errors here if a `ReloadStageName` enrichment member is missing
// from the list above, or a non-member is added (the issue's "caught at build time" guarantee).
const _exhaustive: Record<EnrichmentStageName, true> = {
  lyrics: true,
  nationality: true,
  'master-data': true,
  'mb-release-events': true,
  'track-musicbrainz': true,
  'track-works': true,
  'track-recording-artists': true,
  'track-recording-places': true,
  'track-acousticbrainz': true,
  'track-deezer': true,
  'artist-profiles': true,
  'artist-genres': true,
  'label-hierarchy': true,
  'group-members': true,
  'person-reconciliation': true,
  'mb-artist-id': true,
  'songwriter-reconciliation': true,
  'artist-wikidata': true,
  'artist-influences': true,
  'band-membership': true,
};
void _exhaustive;

// The required-client / 503 / client-check-precedence facts, per stage — the discriminators most
// prone to silent drift. Verified verbatim against the original admin.ts PIPELINES literal.
const REQUIRES: Record<EnrichmentStageName, 'discogs' | 'musicbrainz' | 'wikidata' | undefined> = {
  lyrics: undefined,
  nationality: 'musicbrainz',
  'master-data': 'discogs',
  'mb-release-events': 'musicbrainz',
  'track-musicbrainz': 'musicbrainz',
  'track-works': 'musicbrainz',
  'track-recording-artists': 'musicbrainz',
  'track-recording-places': 'musicbrainz',
  'track-acousticbrainz': undefined,
  'track-deezer': undefined,
  'artist-profiles': 'discogs',
  'artist-genres': undefined,
  'label-hierarchy': 'discogs',
  'group-members': 'discogs',
  'person-reconciliation': undefined,
  'mb-artist-id': 'musicbrainz',
  'songwriter-reconciliation': undefined,
  'artist-wikidata': 'wikidata',
  'artist-influences': undefined,
  'band-membership': undefined,
};

const CLIENT_CHECK_FIRST = new Set<EnrichmentStageName>([
  'master-data',
  'artist-profiles',
  'label-hierarchy',
  'group-members',
]);

const SCHEMA_HAS_503_FALSE = new Set<EnrichmentStageName>([
  'track-acousticbrainz',
  'track-deezer',
  'artist-genres',
  'person-reconciliation',
  'songwriter-reconciliation',
  'artist-influences',
  'band-membership',
]);

// The 7 stages WITHOUT a reset route (the other 13 have one).
const NO_RESET = new Set<EnrichmentStageName>([
  'lyrics',
  'master-data',
  'artist-genres',
  'person-reconciliation',
  'songwriter-reconciliation',
  'artist-influences',
  'band-membership',
]);

describe('STAGE_DEFINITIONS registry', () => {
  it('declares exactly the 20 enrichment stages, names unique', () => {
    expect(STAGE_DEFINITIONS).toHaveLength(20);
    const names = STAGE_DEFINITIONS.map((d) => d.name);
    expect(new Set(names).size).toBe(20);
  });

  it('is in admin route-registration order (drift churns docs/openapi.json)', () => {
    expect(STAGE_DEFINITIONS.map((d) => d.name)).toEqual([...ENRICHMENT_STAGE_NAMES]);
  });
});

describe('RELOAD_STAGES derives from the registry', () => {
  it('its enrichment subset is exactly STAGE_DEFINITIONS (releases + verify are the only extras)', () => {
    const reloadNames = RELOAD_STAGES.map((s) => s.name);
    expect(reloadNames).toContain('releases');
    expect(reloadNames).toContain('verify');

    const reloadEnrichment = reloadNames.filter((n) => n !== 'releases' && n !== 'verify');
    // Same SET as the registry — reload run ORDER is a separate (priority) concern, so compare sets.
    expect(new Set(reloadEnrichment)).toEqual(new Set(STAGE_DEFINITIONS.map((d) => d.name)));
    // Each enrichment stage appears exactly once in the reload sequence.
    expect(reloadEnrichment).toHaveLength(STAGE_DEFINITIONS.length);
  });

  it('toStageDescriptor copies name/deps/resources/sources verbatim', () => {
    for (const def of STAGE_DEFINITIONS) {
      const descriptor = toStageDescriptor(def);
      expect(descriptor.name).toBe(def.name);
      expect(descriptor.deps).toEqual(def.deps);
      expect(descriptor.resources).toEqual(def.resources);
      expect(descriptor.sources).toEqual(def.sources);
      expect(typeof descriptor.run).toBe('function');
    }
  });
});

describe('per-stage admin/reload facts (regression guard)', () => {
  it('requires / clientCheckFirst / schemaHas503 / reset match the frozen expectation', () => {
    for (const def of STAGE_DEFINITIONS) {
      expect([def.name, def.requires]).toEqual([def.name, REQUIRES[def.name]]);
      expect([def.name, def.clientCheckFirst]).toEqual([
        def.name,
        CLIENT_CHECK_FIRST.has(def.name),
      ]);
      expect([def.name, def.schemaHas503]).toEqual([def.name, !SCHEMA_HAS_503_FALSE.has(def.name)]);
      expect([def.name, def.reset !== undefined]).toEqual([def.name, !NO_RESET.has(def.name)]);
    }
  });

  it('every requires names a client present in CLIENT_REGISTRY', () => {
    for (const def of STAGE_DEFINITIONS) {
      if (def.requires !== undefined) {
        expect(CLIENT_REGISTRY[def.requires].missingMessage).toMatch(/not configured$/);
      }
    }
  });
});

describe('client-gate parity — one missing-client fact drives both reload-skip and admin-503', () => {
  // Force every nullable client (discogs/musicbrainz/wikidata) to build as null; acousticbrainz and
  // deezer always build, so the no-required-client stages never skip/503.
  const env = snapshotEnv(['DISCOGS_TOKEN', 'DISCOGS_USER_AGENT', 'MUSICBRAINZ_USER_AGENT']);
  const log = console as unknown as Logger;
  // A ReloadContext with every nullable client absent. The reload gate short-circuits to `null`
  // before touching driver/enrich, so the unused fields can be stubs.
  const ctxMissing = {
    discogs: null,
    musicbrainz: null,
    wikidata: null,
    acousticbrainz: {} as ResolvedClients['acousticbrainz'],
    deezer: {} as ResolvedClients['deezer'],
  } as ReloadContext;

  beforeEach(() => env.clear());
  afterAll(() => env.restore());

  it('a required-client stage SKIPS in reload (null) and 503s in admin with the same message', async () => {
    for (const def of STAGE_DEFINITIONS) {
      if (def.requires === undefined) continue;
      const expectedMessage = CLIENT_REGISTRY[def.requires].missingMessage;

      const reload = await toStageDescriptor(def).run(ctxMissing);
      expect([def.name, reload]).toEqual([def.name, null]);

      const prepared = toPipelineEntry(def).prepare(log);
      expect([def.name, prepared]).toEqual([def.name, { ok: false, message: expectedMessage }]);
    }
  });

  it('a no-required-client stage never skips/503s even with every client unset', () => {
    for (const def of STAGE_DEFINITIONS) {
      if (def.requires !== undefined) continue;
      const prepared = toPipelineEntry(def).prepare(log);
      expect([def.name, prepared.ok]).toEqual([def.name, true]);
    }
  });
});
