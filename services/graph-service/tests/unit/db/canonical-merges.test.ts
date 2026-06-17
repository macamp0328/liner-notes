import { describe, it, expect } from 'vitest';
import { mergeCountryClause, mergeStudioClause } from '../../../src/db/canonical-merges.js';

// The canonical write-path chokepoints (ADR 0005, law 6) are pure clause builders. These tests pin
// their exact output — that string is interpolated verbatim into every Country/Studio writer's
// Cypher, so a change here is a change to every write site. Both the defaulted-`nodeVar` and the
// explicit-`nodeVar` arms are exercised (every real call site uses the default, so the explicit arm
// is covered only here).
describe('mergeCountryClause', () => {
  it('builds the canonical Country node MERGE from a query parameter', () => {
    expect(mergeCountryClause('$countryCode')).toBe('MERGE (c:Country {name: $countryCode})');
  });

  it('builds the canonical Country node MERGE from an UNWIND field', () => {
    expect(mergeCountryClause('item.country')).toBe('MERGE (c:Country {name: item.country})');
  });

  it('honours an explicit node variable', () => {
    expect(mergeCountryClause('$name', 'country')).toBe('MERGE (country:Country {name: $name})');
  });
});

describe('mergeStudioClause', () => {
  it('builds the canonical Studio node MERGE from a query parameter', () => {
    expect(mergeStudioClause('$name')).toBe('MERGE (s:Studio {name: $name})');
  });

  it('builds the canonical Studio node MERGE from an UNWIND field', () => {
    expect(mergeStudioClause('p.name')).toBe('MERGE (s:Studio {name: p.name})');
  });

  it('honours an explicit node variable', () => {
    expect(mergeStudioClause('$name', 'studio')).toBe('MERGE (studio:Studio {name: $name})');
  });
});
