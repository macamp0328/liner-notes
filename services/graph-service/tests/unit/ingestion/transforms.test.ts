import { describe, it, expect } from 'vitest';
import {
  deriveDecade,
  parseTrackNumber,
  parseDisplayRole,
  filterTracks,
  extractStudios,
  extractBarcode,
  extractThumbUrl,
} from '../../../src/ingestion/transforms.js';
import type {
  DiscogsCompany,
  DiscogsImage,
  DiscogsIdentifier,
  DiscogsTracklistEntry,
} from '../../../src/ingestion/types.js';

// ---------------------------------------------------------------------------
// deriveDecade
// ---------------------------------------------------------------------------
describe('deriveDecade', () => {
  it('derives the correct decade for mid-decade years', () => {
    expect(deriveDecade(1972)).toBe('1970s');
    expect(deriveDecade(1957)).toBe('1950s');
    expect(deriveDecade(2023)).toBe('2020s');
  });

  it('handles exact decade boundary years', () => {
    expect(deriveDecade(1980)).toBe('1980s');
    expect(deriveDecade(2000)).toBe('2000s');
    expect(deriveDecade(1990)).toBe('1990s');
  });

  it('handles the 2010s', () => {
    expect(deriveDecade(2019)).toBe('2010s');
  });
});

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

  it('handles bracket-embedded commas correctly (only splits on top-level commas)', () => {
    // The role string "Technician [Studio Brain], Engineer [Assistant Engineer]"
    // should yield "Technician [Studio Brain]" as the display role.
    expect(parseDisplayRole('Technician [Studio Brain], Engineer [Assistant Engineer]')).toBe(
      'Technician [Studio Brain]',
    );
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
