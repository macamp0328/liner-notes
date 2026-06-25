import { describe, it, expect, vi } from 'vitest';
import type { Driver } from 'neo4j-driver';
import { getStats } from '../../../src/db/stats-repository.js';

// Mimic a Neo4j Integer.
const int = (n: number) => ({ toNumber: () => n, low: n, high: 0 });

/** A nationality-query result row: applicable/covered plus the per-source split. */
const nat = (applicable: number, covered: number, mb: number, wikidata: number) => ({
  applicable: int(applicable),
  covered: int(covered),
  mb: int(mb),
  wikidata: int(wikidata),
});

function makeRecord(fields: Record<string, unknown>): unknown {
  return {
    keys: Object.keys(fields),
    get: (k: string) => fields[k],
  };
}

/**
 * Build a mock driver whose session().run(cypher) returns the record matching
 * the queried label. getStats fires ten label queries via Promise.all, each on
 * its own session, so we route by a substring of the MATCH clause. The producer/
 * engineer nationality queries scan `(p:Musician)` too (role lives on CREDITED_ON,
 * not a label), so they're routed by their `roleCategory` gate — checked before the
 * generic `(p:Musician)` and the Release/Artist/Track/Master routes.
 */
function makeDriver(byLabel: {
  release: Record<string, unknown>;
  artist: Record<string, unknown>;
  track: Record<string, unknown>;
  master: Record<string, unknown>;
  natArtist: Record<string, unknown>;
  natMusician: Record<string, unknown>;
  natProducer: Record<string, unknown>;
  natEngineer: Record<string, unknown>;
  // #330: optional so existing cases (which don't assert resolution stats) need no change.
  musician?: Record<string, unknown>;
  memberOf?: Record<string, unknown>;
  // #336: optional so existing cases need no change.
  work?: Record<string, unknown>;
  // #380: optional so existing cases need no change.
  wrote?: Record<string, unknown>;
  // #391: optional so existing cases need no change.
  influencedBy?: Record<string, unknown>;
  // #419: optional so existing cases need no change.
  influencedByCand?: Record<string, unknown>;
  // #392: optional so existing cases need no change.
  membership?: Record<string, unknown>;
  // #342: optional so existing cases need no change.
  studio?: Record<string, unknown>;
}): Driver {
  const musician = byLabel.musician ?? { total: int(0), groupsWithMembers: int(0) };
  const memberOf = byLabel.memberOf ?? { memberOfEdges: int(0) };
  const work = byLabel.work ?? { total: int(0), multiRecording: int(0) };
  const wrote = byLabel.wrote ?? { wroteEdges: int(0) };
  const influencedBy = byLabel.influencedBy ?? { influencedByEdges: int(0) };
  const influencedByCand = byLabel.influencedByCand ?? { influencedByCandidates: int(0) };
  const membership = byLabel.membership ?? { membershipEdges: int(0) };
  const studio = byLabel.studio ?? { total: int(0), withCoordinates: int(0) };
  const run = vi.fn(async (cypher: string) => {
    let fields: Record<string, unknown>;
    if (cypher.includes('(p:Artist)')) fields = byLabel.natArtist;
    else if (cypher.includes("roleCategory = 'producer'")) fields = byLabel.natProducer;
    else if (cypher.includes("roleCategory = 'engineer'")) fields = byLabel.natEngineer;
    else if (cypher.includes('(p:Musician)')) fields = byLabel.natMusician;
    // #392: the wikidata MEMBER_OF scan carries a {source} predicate, so the bare [r:MEMBER_OF]
    // substring below misses it — route it first by the distinguishing predicate.
    else if (cypher.includes("MEMBER_OF {source: 'wikidata'}")) fields = membership;
    else if (cypher.includes('[r:MEMBER_OF]')) fields = memberOf;
    // #380: WROTE edge scan references (:Work) but not (w:Work) — route it before the work check.
    else if (cypher.includes('[r:WROTE]')) fields = wrote;
    // #391: INFLUENCED_BY edge scan references (:Artist) but not (a:Artist) — route it explicitly.
    else if (cypher.includes('[r:INFLUENCED_BY]')) fields = influencedBy;
    else if (cypher.includes('(m:Musician)')) fields = musician;
    else if (cypher.includes('(r:Release)')) fields = byLabel.release;
    // #419: the candidate-denominator scan references (a:Artist) too — route by its unique
    // influencedByQids property gate before the generic (a:Artist) ARTIST_QUERY branch.
    else if (cypher.includes('influencedByQids')) fields = influencedByCand;
    else if (cypher.includes('(a:Artist)')) fields = byLabel.artist;
    // #336: WORK_QUERY also references (t:Track), so it must be routed before the Track route.
    else if (cypher.includes('(w:Work)')) fields = work;
    else if (cypher.includes('(t:Track)')) fields = byLabel.track;
    // #342: STUDIO_QUERY — route before the master default fallthrough.
    else if (cypher.includes('(s:Studio)')) fields = studio;
    else fields = byLabel.master;
    return { records: [makeRecord(fields)] };
  });
  const session = { run, close: vi.fn().mockResolvedValue(undefined) };
  return { session: vi.fn().mockReturnValue(session) } as unknown as Driver;
}

describe('getStats', () => {
  it('assembles counts and coverage with correct percentages', async () => {
    const driver = makeDriver({
      release: { total: int(10), oyApplicable: int(8), oyCovered: int(6) },
      artist: {
        total: int(20),
        profApplicable: int(16),
        profCovered: int(12),
        genresApplicable: int(18),
        genresCovered: int(18),
        stylesApplicable: int(15),
        stylesCovered: int(9),
        // #341 Wikidata coverage, all over the profApplicable (16) denominator.
        wikidataQidCovered: int(10),
        bornYearCovered: int(8),
        imageCovered: int(5),
        awardsCovered: int(2),
        // #393 person-level instruments (P1303), same profApplicable (16) denominator.
        instrumentsCovered: int(4),
      },
      track: {
        total: int(100),
        lyricsCovered: int(80),
        lyricsLrclibCovered: int(70),
        lyricsGeniusCovered: int(8),
        mbidCovered: int(70),
        worksCovered: int(42),
        mbRecordingArtistsCovered: int(28),
        mbProductionCreditsCovered: int(14),
        mbArrangersCovered: int(21),
        mbStudioCovered: int(7),
        isrcCovered: int(60),
        tempoCovered: int(35),
        deezerCovered: int(30),
        deezerGainCovered: int(24),
      },
      master: { total: int(7), releaseEventsCovered: int(5), mbReleaseGroupCovered: int(6) },
      work: {
        total: int(50),
        multiRecording: int(4),
        writersApplicable: int(40),
        writerLinksCovered: int(30),
      },
      wrote: { wroteEdges: int(55) },
      natArtist: nat(16, 12, 7, 4),
      natMusician: nat(50, 30, 10, 5),
      natProducer: nat(8, 4, 4, 0),
      natEngineer: nat(6, 3, 1, 1),
      musician: {
        total: int(40),
        samePersonApplicable: int(25),
        samePersonCovered: int(25),
        groupsWithMembers: int(3),
      },
      memberOf: { memberOfEdges: int(9) },
      influencedBy: { influencedByEdges: int(13) },
      influencedByCand: { influencedByCandidates: int(140) },
      membership: { membershipEdges: int(6) },
      studio: { total: int(12), withCoordinates: int(5) },
    });

    const stats = await getStats(driver);

    expect(stats.counts).toEqual({
      releases: 10,
      artists: 20,
      tracks: 100,
      masters: 7,
      musicians: 40,
      works: 50,
      studios: 12,
    });
    // #342 studio coordinate coverage: 5/12 studios have lat+long → 41.7%.
    expect(stats.enrichment.studiosWithCoordinates).toEqual({
      covered: 5,
      applicable: 12,
      pct: 41.7,
    });
    // #336 Work coverage: tracksWithWork over the recordingMbid-gated denominator (42/70),
    // plus the raw count of cover/version groups (works with >1 distinct recording).
    expect(stats.enrichment.tracksWithWork).toEqual({ covered: 42, applicable: 70, pct: 60 });
    expect(stats.enrichment.worksWithMultipleRecordings).toBe(4);
    // #335 MB recording-artist credits: covered over the same recordingMbid-gated denominator (28/70).
    expect(stats.enrichment.tracksWithMbRecordingArtists).toEqual({
      covered: 28,
      applicable: 70,
      pct: 40,
    });
    // #339 MB production-credit subset: same recordingMbid-gated denominator (14/70).
    expect(stats.enrichment.tracksWithMbProductionCredits).toEqual({
      covered: 14,
      applicable: 70,
      pct: 20,
    });
    // #339 MB arranger subset (composer-bucket track credits): same recordingMbid-gated denominator (21/70).
    expect(stats.enrichment.tracksWithMbArrangers).toEqual({
      covered: 21,
      applicable: 70,
      pct: 30,
    });
    // #339 (slice 2) MB studio coverage: same recordingMbid-gated denominator (7/70).
    expect(stats.enrichment.tracksWithMbStudio).toEqual({ covered: 7, applicable: 70, pct: 10 });
    // #380 songwriter reconciliation: WROTE coverage over writer-bearing Works (30/40) + raw count.
    expect(stats.enrichment.worksWithWriterLinks).toEqual({ covered: 30, applicable: 40, pct: 75 });
    expect(stats.enrichment.wroteEdges).toBe(55);
    // #330 entity-resolution stats: reconciliation coverage + raw MEMBER_OF counts.
    expect(stats.enrichment.samePersonLinks).toEqual({ covered: 25, applicable: 25, pct: 100 });
    expect(stats.enrichment.memberOfEdges).toBe(9);
    expect(stats.enrichment.groupsWithMembers).toBe(3);
    expect(stats.enrichment.influencedByEdges).toBe(13);
    // #419 resolution denominator: raw count of captured P737 references (155 in prod; 140 here).
    expect(stats.enrichment.influencedByCandidates).toBe(140);
    // #392 Wikidata band-membership: raw count, disjoint from the Discogs memberOfEdges above.
    expect(stats.enrichment.membershipEdges).toBe(6);

    // master-gated denominator
    expect(stats.enrichment.releasesWithOriginalYear).toEqual({
      covered: 6,
      applicable: 8,
      pct: 75,
    });
    expect(stats.enrichment.artistsWithProfile).toEqual({ covered: 12, applicable: 16, pct: 75 });

    // genres/styles gated by the artist's release→genre/style path
    expect(stats.enrichment.artistsWithGenres).toEqual({ covered: 18, applicable: 18, pct: 100 });
    expect(stats.enrichment.artistsWithStyles).toEqual({ covered: 9, applicable: 15, pct: 60 });

    // #341 Wikidata coverage, all over the real-artist (profApplicable=16) denominator
    expect(stats.enrichment.artistsWithWikidataId).toEqual({
      covered: 10,
      applicable: 16,
      pct: 62.5,
    });
    expect(stats.enrichment.artistsWithBirthDate).toEqual({ covered: 8, applicable: 16, pct: 50 });
    expect(stats.enrichment.artistsWithImage).toEqual({ covered: 5, applicable: 16, pct: 31.3 });
    expect(stats.enrichment.artistsWithAwards).toEqual({ covered: 2, applicable: 16, pct: 12.5 });
    // #393 person-level instruments (P1303), same denominator.
    expect(stats.enrichment.artistsWithInstruments).toEqual({
      covered: 4,
      applicable: 16,
      pct: 25,
    });

    // lyrics split by source; untagged absorbs covered − (lrclib + genius) = 2
    expect(stats.enrichment.tracksWithLyrics).toEqual({
      covered: 80,
      applicable: 100,
      pct: 80,
      sources: {
        lrclib: { covered: 70, applicable: 100, pct: 70 },
        genius: { covered: 8, applicable: 100, pct: 8 },
        untagged: { covered: 2, applicable: 100, pct: 2 },
      },
    });

    expect(stats.enrichment.tracksWithRecordingMbid).toEqual({
      covered: 70,
      applicable: 100,
      pct: 70,
    });
    expect(stats.enrichment.tracksWithIsrc).toEqual({ covered: 60, applicable: 100, pct: 60 });
    // tempo applicable = tracks with a recordingMbid (70); 35/70 = 50%
    expect(stats.enrichment.tracksWithTempo).toEqual({ covered: 35, applicable: 70, pct: 50 });
    // deezerBpm/deezerGain applicable = tracks with an isrc (60)
    expect(stats.enrichment.tracksWithDeezerBpm).toEqual({ covered: 30, applicable: 60, pct: 50 });
    expect(stats.enrichment.tracksWithDeezerGain).toEqual({ covered: 24, applicable: 60, pct: 40 });

    // 5/7 = 71.42857… → 71.4
    expect(stats.enrichment.mastersWithReleaseEvents).toEqual({
      covered: 5,
      applicable: 7,
      pct: 71.4,
    });

    // MB release-group link coverage (#385): 6/7 ≈ 85.7. Distinct from (and ≥) release-events
    // coverage — a Master can resolve a link yet write zero edges if all its events were digital.
    expect(stats.enrichment.mastersWithMbReleaseGroup).toEqual({
      covered: 6,
      applicable: 7,
      pct: 85.7,
    });

    // nationality, per-label, split by source; untagged = covered − Σ sources
    expect(stats.enrichment.artistsWithNationality).toEqual({
      covered: 12,
      applicable: 16,
      pct: 75,
      sources: {
        musicbrainz: { covered: 7, applicable: 16, pct: 43.8 },
        wikidata: { covered: 4, applicable: 16, pct: 25 },
        // covered (12) exceeds tagged sources (7+4) → untagged absorbs the remaining 1
        untagged: { covered: 1, applicable: 16, pct: 6.3 },
      },
    });
    expect(stats.enrichment.musiciansWithNationality.sources.untagged).toEqual({
      covered: 15,
      applicable: 50,
      pct: 30,
    });
    // dead source: producers have zero wikidata coverage → pct 0, obvious at a glance
    expect(stats.enrichment.producersWithNationality.sources.wikidata!.pct).toBe(0);
    // legacy edges: engineer covered (3) exceeds tagged sources (1+1) → untagged 1
    expect(stats.enrichment.engineersWithNationality.sources.untagged).toEqual({
      covered: 1,
      applicable: 6,
      pct: 16.7,
    });
  });

  it('reports the lyrics funnel and a non-instrumental coverage denominator (#246, #248)', async () => {
    // 100 tracks: 80 resolved (incl. legacy null-status, since covered keys on lyrics IS
    // NOT NULL), 6 instrumental, 4 probable-instrumental, 5 low-confidence → 5 not-found remainder.
    const driver = makeDriver({
      release: { total: int(0), oyApplicable: int(0), oyCovered: int(0) },
      artist: { total: int(0), profApplicable: int(0), profCovered: int(0) },
      track: {
        total: int(100),
        lyricsCovered: int(80),
        lyricsLrclibCovered: int(70),
        lyricsGeniusCovered: int(8),
        lyricsInstrumental: int(6),
        lyricsProbableInstrumental: int(4),
        lyricsLowConfidence: int(5),
        mbidCovered: int(0),
        isrcCovered: int(0),
        tempoCovered: int(0),
        deezerCovered: int(0),
        deezerGainCovered: int(0),
      },
      master: { total: int(0), releaseEventsCovered: int(0), mbReleaseGroupCovered: int(0) },
      natArtist: {},
      natMusician: {},
      natProducer: {},
      natEngineer: {},
    });

    const stats = await getStats(driver);

    // denominator excludes ONLY the two instrumental classes (low-confidence stays in): 100 − 6 − 4
    // = 90; 80/90 = 88.9%
    expect(stats.enrichment.tracksWithLyrics.covered).toBe(80);
    expect(stats.enrichment.tracksWithLyrics.applicable).toBe(90);
    expect(stats.enrichment.tracksWithLyrics.pct).toBe(88.9);

    expect(stats.enrichment.lyricsFunnel).toEqual({
      resolved: 80,
      instrumental: 6,
      probableInstrumental: 4,
      lowConfidence: 5,
      notFound: 5,
      total: 100,
    });
    // the five buckets partition total exactly
    const f = stats.enrichment.lyricsFunnel;
    expect(
      f.resolved + f.instrumental + f.probableInstrumental + f.lowConfidence + f.notFound,
    ).toBe(f.total);
  });

  it('rounds percentages to one decimal place', async () => {
    const driver = makeDriver({
      release: { total: int(3), oyApplicable: int(3), oyCovered: int(1) }, // 33.333 → 33.3
      artist: { total: int(0), profApplicable: int(0), profCovered: int(0) },
      track: { total: int(0) },
      master: { total: int(0) },
      natArtist: {},
      natMusician: {},
      natProducer: {},
      natEngineer: {},
    });

    const stats = await getStats(driver);
    expect(stats.enrichment.releasesWithOriginalYear.pct).toBe(33.3);
  });

  it('reports pct null (not 0) when nothing is applicable — empty graph', async () => {
    const driver = makeDriver({
      release: { total: int(0), oyApplicable: int(0), oyCovered: int(0) },
      artist: { total: int(0) },
      track: { total: int(0) },
      master: { total: int(0) },
      natArtist: {},
      natMusician: {},
      natProducer: {},
      natEngineer: {},
    });

    const stats = await getStats(driver);

    expect(stats.counts).toEqual({
      releases: 0,
      artists: 0,
      tracks: 0,
      masters: 0,
      musicians: 0,
      works: 0,
      studios: 0,
    });
    expect(stats.enrichment.releasesWithOriginalYear.pct).toBeNull();
    expect(stats.enrichment.artistsWithGenres.pct).toBeNull();
    expect(stats.enrichment.tracksWithLyrics.pct).toBeNull();
    expect(stats.enrichment.mastersWithReleaseEvents.pct).toBeNull();
    expect(stats.enrichment.tracksWithDeezerGain).toEqual({ covered: 0, applicable: 0, pct: null });
    // #342: no studios → coverage applicable 0, pct null (not 0).
    expect(stats.enrichment.studiosWithCoordinates).toEqual({
      covered: 0,
      applicable: 0,
      pct: null,
    });
    // a sourced metric still has every bucket, each with pct null on an empty graph
    expect(stats.enrichment.artistsWithNationality.sources.musicbrainz!.pct).toBeNull();
    expect(stats.enrichment.artistsWithNationality.sources.untagged!.pct).toBeNull();
  });
});
