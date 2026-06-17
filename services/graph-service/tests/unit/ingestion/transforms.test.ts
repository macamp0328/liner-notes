import { describe, it, expect } from 'vitest';
import {
  parsePosition,
  parseDisplayRole,
  parseRoleCategory,
  parseInstrument,
  normalizeInstrumentFamilies,
  filterTracks,
  extractStudios,
  extractBarcode,
  extractThumbUrl,
  parseDurationSeconds,
  isInstrumental,
  normalizeCountry,
} from '../../../src/ingestion/transforms.js';
import type {
  DiscogsCompany,
  DiscogsImage,
  DiscogsIdentifier,
  DiscogsTracklistEntry,
} from '../../../src/ingestion/types.js';

// ---------------------------------------------------------------------------
// parsePosition
// ---------------------------------------------------------------------------
describe('parsePosition', () => {
  it('splits side-prefixed vinyl positions into prefix and number', () => {
    expect(parsePosition('A1')).toEqual({ prefix: 'A', num: 1 });
    expect(parsePosition('B3')).toEqual({ prefix: 'B', num: 3 });
    expect(parsePosition('B12')).toEqual({ prefix: 'B', num: 12 });
  });

  it('splits multi-disc positions into a disc prefix and number', () => {
    expect(parsePosition('2-3')).toEqual({ prefix: '2-', num: 3 });
    expect(parsePosition('1-10')).toEqual({ prefix: '1-', num: 10 });
  });

  it('treats numeric-only positions as an empty prefix', () => {
    expect(parsePosition('5')).toEqual({ prefix: '', num: 5 });
    expect(parsePosition('10')).toEqual({ prefix: '', num: 10 });
  });

  it('handles positions with no numeric portion', () => {
    expect(parsePosition('A')).toEqual({ prefix: 'A', num: 0 });
    expect(parsePosition('')).toEqual({ prefix: '', num: 0 });
  });

  it('sorts into album order: sides in sequence, numbers within a side', () => {
    const positions = ['B1', 'A2', 'A1', 'B2', 'A10'];
    const sorted = [...positions].sort((a, b) => {
      const pa = parsePosition(a);
      const pb = parsePosition(b);
      return pa.prefix.localeCompare(pb.prefix) || pa.num - pb.num;
    });
    expect(sorted).toEqual(['A1', 'A2', 'A10', 'B1', 'B2']);
  });
});

// ---------------------------------------------------------------------------
// parseDisplayRole
// ---------------------------------------------------------------------------
describe('parseDisplayRole', () => {
  it('returns the first comma-delimited token', () => {
    expect(parseDisplayRole('Acoustic Guitar, Electric Guitar, Vocals')).toBe('Acoustic Guitar');
    expect(parseDisplayRole('Bass, Drone [Bass Drone]')).toBe('Bass');
  });

  it('trims whitespace from the result', () => {
    expect(parseDisplayRole('  Drums , Percussion')).toBe('Drums');
  });

  it('returns the full string when there is no comma', () => {
    expect(parseDisplayRole('Producer')).toBe('Producer');
    expect(parseDisplayRole('Technician [Studio Brain]')).toBe('Technician [Studio Brain]');
  });

  it('splits on the first comma even when role text contains bracket annotations', () => {
    // The plain split(',') implementation works here because bracket annotations in
    // real Discogs role strings do not themselves contain commas.
    expect(parseDisplayRole('Technician [Studio Brain], Engineer [Assistant Engineer]')).toBe(
      'Technician [Studio Brain]',
    );
  });
});

// ---------------------------------------------------------------------------
// parseRoleCategory
// ---------------------------------------------------------------------------
describe('parseRoleCategory', () => {
  // performer
  it('categorizes single instrument roles as performer', () => {
    expect(parseRoleCategory('Bass')).toBe('performer');
    expect(parseRoleCategory('Drums')).toBe('performer');
    expect(parseRoleCategory('Piano')).toBe('performer');
  });

  it('categorizes multi-token performer roles on first match', () => {
    expect(parseRoleCategory('Acoustic Guitar, Electric Guitar, Vocals')).toBe('performer');
    expect(parseRoleCategory('Drums, Percussion, Choir, Keyboards [Sk5]')).toBe('performer');
  });

  it('matches performer via bracket content when base token is generic', () => {
    expect(parseRoleCategory('Sounds [Ambience]')).toBe('performer');
    expect(parseRoleCategory('Drone [Bass Drone]')).toBe('performer');
  });

  // composer
  it('categorizes writing credits as composer', () => {
    expect(parseRoleCategory('Written-By')).toBe('composer');
    expect(parseRoleCategory('Songwriter')).toBe('composer');
    expect(parseRoleCategory('Arranged By')).toBe('composer');
  });

  // composer — arranging family (#339): MB recording-level arranger/orchestrator and the Discogs
  // equivalents bucket here, the same axis as written-by/composed-by.
  it('categorizes the arranging family as composer', () => {
    expect(parseRoleCategory('Arranger')).toBe('composer');
    expect(parseRoleCategory('Vocal Arranger')).toBe('composer');
    expect(parseRoleCategory('Orchestrator')).toBe('composer');
    expect(parseRoleCategory('Orchestrated By')).toBe('composer');
  });

  // producer
  it('categorizes producer credits', () => {
    expect(parseRoleCategory('Producer')).toBe('producer');
    expect(parseRoleCategory('Executive Producer')).toBe('producer');
    expect(parseRoleCategory('Co-Producer')).toBe('producer');
  });

  // engineer
  it('categorizes engineering credits', () => {
    expect(parseRoleCategory('Engineer, Mixed By')).toBe('engineer');
    expect(parseRoleCategory('Mastered By')).toBe('engineer');
    expect(parseRoleCategory('Lacquer Cut By')).toBe('engineer');
    expect(parseRoleCategory('Technician [Studio Brain], Engineer [Assistant Engineer]')).toBe(
      'engineer',
    );
  });

  // visual
  it('categorizes visual / design credits', () => {
    expect(parseRoleCategory('Photography By [Cover Photography]')).toBe('visual');
    expect(parseRoleCategory('Design [Production Design]')).toBe('visual');
    expect(parseRoleCategory('Design, Layout')).toBe('visual');
  });

  // crew — bracket content is the only signal
  it('categorizes crew roles via bracket content', () => {
    expect(parseRoleCategory('Other [Catered By]')).toBe('crew');
  });

  // other / default
  it('returns "other" for unrecognized roles', () => {
    expect(parseRoleCategory('Other')).toBe('other');
    expect(parseRoleCategory('')).toBe('other');
    expect(parseRoleCategory('Flowers [Flowers]')).toBe('other');
  });

  // case-insensitive
  it('matches case-insensitively', () => {
    expect(parseRoleCategory('BASS')).toBe('performer');
    expect(parseRoleCategory('WRITTEN-BY')).toBe('composer');
    expect(parseRoleCategory('Mastered By')).toBe('engineer');
  });

  it('skips empty bracket content without throwing', () => {
    // Exercises the `if (inner.length > 0)` guard in the bracket-token loop:
    // an empty "[]" must not be pushed as a token (would otherwise match nothing
    // but waste a comparison loop iteration).
    expect(parseRoleCategory('Other []')).toBe('other');
    expect(parseRoleCategory('Bass []')).toBe('performer');
  });
});

// ---------------------------------------------------------------------------
// parseInstrument
// ---------------------------------------------------------------------------
describe('parseInstrument', () => {
  it('normalizes common instrument families', () => {
    expect(parseInstrument('Bass')).toBe('bass');
    expect(parseInstrument('Guitar')).toBe('guitar');
    expect(parseInstrument('Drums')).toBe('drums');
    expect(parseInstrument('Piano')).toBe('piano');
    expect(parseInstrument('Vocals')).toBe('vocals');
    expect(parseInstrument('Trumpet')).toBe('trumpet');
    expect(parseInstrument('Trombone')).toBe('trombone');
    expect(parseInstrument('Flute')).toBe('flute');
    expect(parseInstrument('Banjo')).toBe('banjo');
    expect(parseInstrument('Mandolin')).toBe('mandolin');
    expect(parseInstrument('Accordion')).toBe('accordion');
  });

  it('collapses Discogs spelling variants onto one family', () => {
    // The whole point of the field: every spelling of an instrument answers
    // one normalized query.
    expect(parseInstrument('Electric Bass [Elec. Bass]')).toBe('bass');
    expect(parseInstrument('Double Bass')).toBe('bass');
    expect(parseInstrument('Upright Bass')).toBe('bass');
    expect(parseInstrument('Electric Guitar [Elec. Guitar]')).toBe('guitar');
    expect(parseInstrument('Acoustic Guitar')).toBe('guitar');
    expect(parseInstrument('Tenor Saxophone')).toBe('saxophone');
    expect(parseInstrument('Alto Sax')).toBe('saxophone');
    expect(parseInstrument('Backing Vocals')).toBe('vocals');
  });

  it('maps keyboard-family instruments to their canonical bucket', () => {
    expect(parseInstrument('Rhodes')).toBe('piano');
    expect(parseInstrument('Wurlitzer')).toBe('piano');
    expect(parseInstrument('Hammond B3')).toBe('organ');
    expect(parseInstrument('Organ')).toBe('organ');
    expect(parseInstrument('Moog')).toBe('synthesizer');
    expect(parseInstrument('Synthesizer')).toBe('synthesizer');
    expect(parseInstrument('Keyboards')).toBe('keyboards');
  });

  it('resolves load-bearing ordering collisions', () => {
    expect(parseInstrument('Bass Guitar')).toBe('bass'); // bass before guitar
    expect(parseInstrument('Bass Drum [Kick]')).toBe('drums'); // drums before bass
    expect(parseInstrument('Bass Clarinet')).toBe('clarinet'); // clarinet before bass
    expect(parseInstrument('String Bass')).toBe('bass'); // bass before strings
    expect(parseInstrument('Marimba')).toBe('vibraphone'); // vibraphone before percussion
    expect(parseInstrument('Harmonica')).toBe('harmonica'); // harmonica before harp
    expect(parseInstrument('Harp')).toBe('harp');
  });

  it('covers the long-tail instruments measured in the collection', () => {
    // Added from a coverage pass over the real CREDITED_ON role distribution.
    expect(parseInstrument('Oboe')).toBe('oboe');
    expect(parseInstrument('Tuba')).toBe('tuba');
    expect(parseInstrument('Sitar')).toBe('sitar');
    expect(parseInstrument('Dobro')).toBe('guitar'); // resonator guitar
    expect(parseInstrument('Maracas')).toBe('percussion');
    expect(parseInstrument('Triangle')).toBe('percussion');
    expect(parseInstrument('Chimes')).toBe('percussion');
  });

  it('does not misclassify instruments whose names contain a shorter family keyword', () => {
    // Substring matching would otherwise fold these into the wrong high-traffic
    // family ("Bassoon" -> bass, "Harpsichord" -> harp); the specific families are
    // ordered ahead of the generic keyword to keep them distinct.
    expect(parseInstrument('Bassoon')).toBe('bassoon');
    expect(parseInstrument('Contrabassoon')).toBe('bassoon');
    expect(parseInstrument('Harpsichord')).toBe('harpsichord');
    // The genuine basses still resolve to bass.
    expect(parseInstrument('Double Bass')).toBe('bass');
    expect(parseInstrument('Contrabass')).toBe('bass');
  });

  it('keeps named bowed instruments distinct from generic strings', () => {
    expect(parseInstrument('Violin')).toBe('violin');
    expect(parseInstrument('Viola')).toBe('viola');
    expect(parseInstrument('Cello')).toBe('cello');
    expect(parseInstrument('Strings')).toBe('strings');
  });

  it('returns the first family on a multi-instrument credit', () => {
    expect(parseInstrument('Acoustic Guitar, Electric Guitar, Vocals')).toBe('guitar');
    expect(parseInstrument('Drums, Bass')).toBe('drums');
  });

  it('matches via bracket content and is case-insensitive', () => {
    expect(parseInstrument('Sounds [Bass]')).toBe('bass');
    expect(parseInstrument('BASS GUITAR')).toBe('bass');
  });

  it('skips empty bracket content without throwing', () => {
    expect(parseInstrument('Bass []')).toBe('bass');
  });

  it('returns null when no instrument keyword matches', () => {
    expect(parseInstrument('Producer')).toBeNull();
    expect(parseInstrument('Mixed By')).toBeNull();
    expect(parseInstrument('Mastered By')).toBeNull();
    expect(parseInstrument('Photography By [Cover Photography]')).toBeNull();
    expect(parseInstrument('Other')).toBeNull();
    expect(parseInstrument('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// normalizeInstrumentFamilies (#393, person-level Wikidata P1303 labels)
// ---------------------------------------------------------------------------
describe('normalizeInstrumentFamilies', () => {
  it('maps Wikidata-style labels onto the #333 family vocabulary', () => {
    expect(normalizeInstrumentFamilies(['bass guitar', 'drum kit', 'piano'])).toEqual([
      'bass',
      'drums',
      'piano',
    ]);
  });

  it('dedupes families and returns them sorted', () => {
    // electric + acoustic guitar both collapse to "guitar"; output is a sorted set.
    expect(normalizeInstrumentFamilies(['electric guitar', 'acoustic guitar', 'vocals'])).toEqual([
      'guitar',
      'vocals',
    ]);
  });

  it('drops labels outside the controlled vocabulary', () => {
    // theremin/kalimba/ukulele have no #333 family — the caller keeps them verbatim elsewhere.
    expect(normalizeInstrumentFamilies(['theremin', 'kalimba', 'ukulele'])).toEqual([]);
    expect(normalizeInstrumentFamilies(['theremin', 'piano'])).toEqual(['piano']);
  });

  it('returns an empty array for empty input', () => {
    expect(normalizeInstrumentFamilies([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// filterTracks
// ---------------------------------------------------------------------------
describe('filterTracks', () => {
  const sampleTracklist: DiscogsTracklistEntry[] = [
    { position: '', type_: 'heading', title: 'Side A', duration: '' },
    { position: 'A1', type_: 'track', title: 'Song One', duration: '3:00' },
    { position: 'A2', type_: 'track', title: 'Song Two', duration: '' },
    { position: '', type_: 'index', title: 'Hidden Track', duration: '' },
    { position: 'B1', type_: 'track', title: 'Song Three', duration: '4:00' },
  ];

  it('keeps only entries with type_ === "track"', () => {
    const result = filterTracks(sampleTracklist);
    expect(result).toHaveLength(3);
    expect(result.map((t) => t.title)).toEqual(['Song One', 'Song Two', 'Song Three']);
  });

  it('removes heading entries', () => {
    const result = filterTracks(sampleTracklist);
    expect(result.some((t) => t.type_ === 'heading')).toBe(false);
  });

  it('removes index entries', () => {
    const result = filterTracks(sampleTracklist);
    expect(result.some((t) => t.type_ === 'index')).toBe(false);
  });

  it('returns an empty array for an empty tracklist', () => {
    expect(filterTracks([])).toEqual([]);
  });

  it('returns all entries when all are type "track"', () => {
    const allTracks: DiscogsTracklistEntry[] = [
      { position: 'A1', type_: 'track', title: 'One', duration: '' },
      { position: 'A2', type_: 'track', title: 'Two', duration: '' },
    ];
    expect(filterTracks(allTracks)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// extractStudios
// ---------------------------------------------------------------------------
describe('extractStudios', () => {
  const companies: DiscogsCompany[] = [
    {
      name: 'Sterling Sound',
      catno: '',
      entity_type: '30',
      entity_type_name: 'Lacquer Cut At',
      id: 264060,
      resource_url: '',
    },
    {
      name: 'Some Copyright Co',
      catno: '',
      entity_type: '13',
      entity_type_name: 'Phonographic Copyright (p)',
      id: 9001,
      resource_url: '',
    },
    {
      name: 'Bear Creek Studios',
      catno: '',
      entity_type: '23',
      entity_type_name: 'Recorded At',
      id: 274542,
      resource_url: '',
    },
    {
      name: 'Bear Creek Studios',
      catno: '',
      entity_type: '27',
      entity_type_name: 'Mixed At',
      id: 274542,
      resource_url: '',
    },
    {
      name: 'Distributor Inc.',
      catno: '',
      entity_type: '7',
      entity_type_name: 'Distributed By',
      id: 5555,
      resource_url: '',
    },
  ];

  it('includes companies with entity_type "23" (Recorded At)', () => {
    const result = extractStudios(companies);
    expect(result.some((c) => c.entity_type === '23')).toBe(true);
  });

  it('includes companies with entity_type "27" (Mixed At)', () => {
    const result = extractStudios(companies);
    expect(result.some((c) => c.entity_type === '27')).toBe(true);
  });

  it('excludes all other entity types', () => {
    const result = extractStudios(companies);
    expect(result).toHaveLength(2);
    for (const c of result) {
      expect(['23', '27']).toContain(c.entity_type);
    }
  });

  it('returns an empty array when no studio companies are present', () => {
    const noStudios = companies.filter((c) => c.entity_type !== '23' && c.entity_type !== '27');
    expect(extractStudios(noStudios)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// extractBarcode
// ---------------------------------------------------------------------------
describe('extractBarcode', () => {
  const identifiers: DiscogsIdentifier[] = [
    { type: 'Barcode', value: '191400012912' },
    { type: 'Matrix / Runout', value: '4AD0129LP-A  US  JN-H STERLING', description: 'Side A' },
  ];

  it('returns the barcode value when present', () => {
    expect(extractBarcode(identifiers)).toBe('191400012912');
  });

  it('returns null when no Barcode identifier exists', () => {
    const noBarcode = identifiers.filter((i) => i.type !== 'Barcode');
    expect(extractBarcode(noBarcode)).toBeNull();
  });

  it('returns null for an empty identifiers array', () => {
    expect(extractBarcode([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractThumbUrl
// ---------------------------------------------------------------------------
describe('extractThumbUrl', () => {
  const images: DiscogsImage[] = [
    {
      type: 'secondary',
      uri: 'https://example.com/secondary.jpeg',
      resource_url: '',
      uri150: 'https://example.com/secondary-150.jpeg',
      width: 600,
      height: 280,
    },
    {
      type: 'primary',
      uri: 'https://example.com/primary.jpeg',
      resource_url: '',
      uri150: 'https://example.com/primary-150.jpeg',
      width: 600,
      height: 595,
    },
  ];

  it('returns the uri150 of the primary image', () => {
    expect(extractThumbUrl(images)).toBe('https://example.com/primary-150.jpeg');
  });

  it('returns null when no primary image exists', () => {
    const noPrimary = images.filter((i) => i.type !== 'primary');
    expect(extractThumbUrl(noPrimary)).toBeNull();
  });

  it('returns null for an empty images array', () => {
    expect(extractThumbUrl([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseDurationSeconds
// ---------------------------------------------------------------------------
describe('parseDurationSeconds', () => {
  it('parses MM:SS format', () => {
    expect(parseDurationSeconds('3:47')).toBe(227);
    expect(parseDurationSeconds('4:33')).toBe(273);
  });

  it('parses HH:MM:SS format', () => {
    expect(parseDurationSeconds('1:02:34')).toBe(3754);
    expect(parseDurationSeconds('0:01:00')).toBe(60);
  });

  it('returns 0 for 0:00', () => {
    expect(parseDurationSeconds('0:00')).toBe(0);
  });

  it('returns null for an empty string', () => {
    expect(parseDurationSeconds('')).toBeNull();
  });

  it('returns null for an unparseable string', () => {
    expect(parseDurationSeconds('badvalue')).toBeNull();
    expect(parseDurationSeconds('abc:def')).toBeNull();
  });

  it('returns null for more than three colon-separated parts', () => {
    expect(parseDurationSeconds('4:5:6:7')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isInstrumental
// ---------------------------------------------------------------------------
describe('isInstrumental', () => {
  const track = (title: string, type_: string = 'track'): DiscogsTracklistEntry => ({
    position: 'A1',
    type_,
    title,
    duration: '',
  });

  it('returns true for titles containing "Instrumental"', () => {
    expect(isInstrumental(track('Theme (Instrumental)'))).toBe(true);
    expect(isInstrumental(track('INSTRUMENTAL'))).toBe(true);
  });

  it('returns true for titles containing "Reprise"', () => {
    expect(isInstrumental(track('Song Title (Reprise)'))).toBe(true);
  });

  it('returns true for titles that are standalone instrumental keywords', () => {
    expect(isInstrumental(track('Overture'))).toBe(true);
    expect(isInstrumental(track('Intro'))).toBe(true);
    expect(isInstrumental(track('Interlude'))).toBe(true);
    expect(isInstrumental(track('Outro'))).toBe(true);
    expect(isInstrumental(track('Theme'))).toBe(true);
    expect(isInstrumental(track('Prelude'))).toBe(true);
    expect(isInstrumental(track('Coda'))).toBe(true);
  });

  it('returns false for regular song titles', () => {
    expect(isInstrumental(track('Regular Song'))).toBe(false);
    expect(isInstrumental(track('Introduction to Nothing'))).toBe(false);
  });

  it('returns false for an empty title with type track', () => {
    expect(isInstrumental(track(''))).toBe(false);
  });

  it('returns true for type_ "index" regardless of title', () => {
    expect(isInstrumental(track('Hidden Track', 'index'))).toBe(true);
    expect(isInstrumental(track('Normal Title', 'index'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// normalizeCountry
// ---------------------------------------------------------------------------
describe('normalizeCountry', () => {
  it('normalises US/UK aliases to their ISO country code', () => {
    expect(normalizeCountry('US')).toEqual({ countries: ['US'], regions: [] });
    expect(normalizeCountry('USA')).toEqual({ countries: ['US'], regions: [] });
    expect(normalizeCountry('UK')).toEqual({ countries: ['GB'], regions: [] });
    expect(normalizeCountry('England')).toEqual({ countries: ['GB'], regions: [] });
    expect(normalizeCountry('Scotland')).toEqual({ countries: ['GB'], regions: [] });
  });

  it('maps single English country names to ISO alpha-2', () => {
    expect(normalizeCountry('Germany')).toEqual({ countries: ['DE'], regions: [] });
    expect(normalizeCountry('Japan')).toEqual({ countries: ['JP'], regions: [] });
    expect(normalizeCountry('South Korea')).toEqual({ countries: ['KR'], regions: [] });
  });

  it('passes already-ISO two-letter codes through as countries (MB/nationality emitters)', () => {
    expect(normalizeCountry('GB')).toEqual({ countries: ['GB'], regions: [] });
    expect(normalizeCountry('JP')).toEqual({ countries: ['JP'], regions: [] });
  });

  it('maps supranational market codes/names to regions, keeping :Country pure ISO', () => {
    expect(normalizeCountry('Europe')).toEqual({ countries: [], regions: ['EU'] });
    expect(normalizeCountry('XE')).toEqual({ countries: [], regions: ['EU'] });
    expect(normalizeCountry('Worldwide')).toEqual({ countries: [], regions: ['WW'] });
    expect(normalizeCountry('XW')).toEqual({ countries: [], regions: ['WW'] });
    expect(normalizeCountry('Scandinavia')).toEqual({ countries: [], regions: ['Scandinavia'] });
  });

  it('splits compound markets into concrete countries + region tokens', () => {
    expect(normalizeCountry('USA & Canada')).toEqual({ countries: ['US', 'CA'], regions: [] });
    expect(normalizeCountry('UK & Europe')).toEqual({ countries: ['GB'], regions: ['EU'] });
    expect(normalizeCountry('UK, Europe & US')).toEqual({
      countries: ['GB', 'US'],
      regions: ['EU'],
    });
    expect(normalizeCountry('France & Benelux')).toEqual({
      countries: ['FR'],
      regions: ['Benelux'],
    });
    expect(normalizeCountry('North America (inc Mexico)')).toEqual({
      countries: [],
      regions: ['North America'],
    });
  });

  it('falls back to a name-keyed country for unmapped/defunct values (never drops data)', () => {
    expect(normalizeCountry('Yugoslavia')).toEqual({ countries: ['Yugoslavia'], regions: [] });
    expect(normalizeCountry('Atlantis')).toEqual({ countries: ['Atlantis'], regions: [] });
  });
});
