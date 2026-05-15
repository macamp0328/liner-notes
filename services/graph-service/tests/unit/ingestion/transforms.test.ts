import { describe, it, expect } from 'vitest';
import {
  parseTrackNumber,
  parseDisplayRole,
  parseRoleCategory,
  filterTracks,
  extractStudios,
  extractBarcode,
  extractThumbUrl,
  parseDurationSeconds,
  isInstrumental,
  normalizeCountry,
  normalizeTrackTitle,
  deriveVersionType,
} from '../../../src/ingestion/transforms.js';
import type {
  DiscogsCompany,
  DiscogsImage,
  DiscogsIdentifier,
  DiscogsTracklistEntry,
} from '../../../src/ingestion/types.js';

// ---------------------------------------------------------------------------
// parseTrackNumber
// ---------------------------------------------------------------------------
describe('parseTrackNumber', () => {
  it('parses the trailing digit from side-prefixed positions', () => {
    expect(parseTrackNumber('A1')).toBe(1);
    expect(parseTrackNumber('A2')).toBe(2);
    expect(parseTrackNumber('B1')).toBe(1);
    expect(parseTrackNumber('B3')).toBe(3);
  });

  it('parses multi-digit track numbers', () => {
    expect(parseTrackNumber('C12')).toBe(12);
    expect(parseTrackNumber('A10')).toBe(10);
  });

  it('parses numeric-only positions', () => {
    expect(parseTrackNumber('10')).toBe(10);
    expect(parseTrackNumber('1')).toBe(1);
  });

  it('returns 0 when no numeric portion is found', () => {
    expect(parseTrackNumber('')).toBe(0);
    expect(parseTrackNumber('A')).toBe(0);
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
  it('normalises US aliases to ["US"]', () => {
    expect(normalizeCountry('US')).toEqual(['US']);
    expect(normalizeCountry('USA')).toEqual(['US']);
  });

  it('normalises UK aliases to ["GB"]', () => {
    expect(normalizeCountry('UK')).toEqual(['GB']);
    expect(normalizeCountry('England')).toEqual(['GB']);
    expect(normalizeCountry('Scotland')).toEqual(['GB']);
  });

  it('normalises Europe to ["EU"]', () => {
    expect(normalizeCountry('Europe')).toEqual(['EU']);
  });

  it('normalises Worldwide to ["WW"]', () => {
    expect(normalizeCountry('Worldwide')).toEqual(['WW']);
  });

  it('expands compound values to multiple codes', () => {
    expect(normalizeCountry('USA & Canada')).toEqual(['US', 'CA']);
    expect(normalizeCountry('UK & Europe')).toEqual(['GB', 'EU']);
  });

  it('falls back to [raw] for unmapped values', () => {
    expect(normalizeCountry('Atlantis')).toEqual(['Atlantis']);
    expect(normalizeCountry('Unknown Market')).toEqual(['Unknown Market']);
  });
});

// ---------------------------------------------------------------------------
// normalizeTrackTitle
// ---------------------------------------------------------------------------
describe('normalizeTrackTitle', () => {
  it('strips trailing parentheticals', () => {
    expect(normalizeTrackTitle('Song Title (Remix)')).toBe('song title');
    expect(normalizeTrackTitle('Track (Live at Fillmore)')).toBe('track');
  });

  it('strips trailing bracketed content', () => {
    expect(normalizeTrackTitle('Song [Radio Edit]')).toBe('song');
    expect(normalizeTrackTitle('Track [Bonus Track]')).toBe('track');
  });

  it('strips double-parenthetical patterns', () => {
    expect(normalizeTrackTitle('Song (Remix) [Bonus Track]')).toBe('song');
  });

  it('strips leading prefix markers', () => {
    expect(normalizeTrackTitle('Live - Just Like That')).toBe('just like that');
    expect(normalizeTrackTitle('Acoustic - My Song')).toBe('my song');
  });

  it('lowercases the result', () => {
    expect(normalizeTrackTitle('Song Title')).toBe('song title');
  });

  it('returns empty string for a title that is entirely a descriptor', () => {
    expect(normalizeTrackTitle('(Remix)')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// deriveVersionType
// ---------------------------------------------------------------------------
describe('deriveVersionType', () => {
  it('detects remix', () => {
    expect(deriveVersionType('Song (Remix)')).toBe('remix');
    expect(deriveVersionType('Song [RMX]')).toBe('remix');
  });

  it('detects live', () => {
    expect(deriveVersionType('Song (Live)')).toBe('live');
    expect(deriveVersionType('Song [Live at Wembley]')).toBe('live');
    expect(deriveVersionType('Live - Song')).toBe('live');
  });

  it('detects acoustic', () => {
    expect(deriveVersionType('Song (Acoustic Version)')).toBe('acoustic');
  });

  it('detects demo', () => {
    expect(deriveVersionType('Song (Demo)')).toBe('demo');
  });

  it('detects alternate', () => {
    expect(deriveVersionType('Song (Alternate Take)')).toBe('alternate');
    expect(deriveVersionType('Song (Alternative Version)')).toBe('alternate');
  });

  it('detects instrumental', () => {
    expect(deriveVersionType('Song (Instrumental)')).toBe('instrumental');
  });

  it('returns unknown when no keyword matches', () => {
    expect(deriveVersionType('Song (7" Single)')).toBe('unknown');
    expect(deriveVersionType('Song')).toBe('unknown');
  });
});
