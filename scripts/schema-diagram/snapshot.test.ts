// Unit tests for the pure snapshot builders. Run with `pnpm scripts:test`
// (node's built-in test runner via tsx — no DB, no extra dependency).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type IntrospectionRaw, buildSnapshot, serializeSnapshot } from './snapshot.js';

function raw(overrides: Partial<IntrospectionRaw> = {}): IntrospectionRaw {
  return {
    nodeTypeRows: [],
    relRows: [],
    constraintRows: [],
    indexRows: [],
    ...overrides,
  };
}

test('labels and their properties are sorted by name', () => {
  const snapshot = buildSnapshot(
    raw({
      nodeTypeRows: [
        {
          nodeLabels: ['Release'],
          propertyName: 'title',
          propertyTypes: ['String'],
          mandatory: true,
        },
        {
          nodeLabels: ['Release'],
          propertyName: 'discogsId',
          propertyTypes: ['Long'],
          mandatory: true,
        },
        {
          nodeLabels: ['Artist'],
          propertyName: 'name',
          propertyTypes: ['String'],
          mandatory: true,
        },
      ],
    }),
  );
  assert.deepEqual(
    snapshot.labels.map((l) => l.label),
    ['Artist', 'Release'],
  );
  assert.deepEqual(
    snapshot.labels[1]?.properties.map((p) => p.name),
    ['discogsId', 'title'],
  );
});

test('multi-type property arrays are sorted (determinism)', () => {
  const snapshot = buildSnapshot(
    raw({
      nodeTypeRows: [
        {
          nodeLabels: ['Track'],
          propertyName: 'year',
          propertyTypes: ['String', 'Long'],
          mandatory: false,
        },
      ],
    }),
  );
  assert.deepEqual(snapshot.labels[0]?.properties[0]?.types, ['Long', 'String']);
});

test('unique/indexed are derived from constraints/indexes; LOOKUP is ignored', () => {
  const snapshot = buildSnapshot(
    raw({
      nodeTypeRows: [
        {
          nodeLabels: ['Release'],
          propertyName: 'discogsId',
          propertyTypes: ['Long'],
          mandatory: true,
        },
        {
          nodeLabels: ['Release'],
          propertyName: 'pressingYear',
          propertyTypes: ['Long'],
          mandatory: false,
        },
        {
          nodeLabels: ['Release'],
          propertyName: 'title',
          propertyTypes: ['String'],
          mandatory: true,
        },
      ],
      constraintRows: [
        {
          name: 'release_discogs_id',
          type: 'UNIQUENESS',
          entityType: 'NODE',
          labelsOrTypes: ['Release'],
          properties: ['discogsId'],
        },
      ],
      indexRows: [
        // the backing index Neo4j auto-creates for the uniqueness constraint
        {
          name: 'release_discogs_id',
          type: 'RANGE',
          entityType: 'NODE',
          labelsOrTypes: ['Release'],
          properties: ['discogsId'],
          owningConstraint: 'release_discogs_id',
        },
        {
          name: 'release_pressing_year',
          type: 'RANGE',
          entityType: 'NODE',
          labelsOrTypes: ['Release'],
          properties: ['pressingYear'],
          owningConstraint: null,
        },
        // implicit token index — must NOT mark any property indexed
        {
          name: 'index_343aff4e',
          type: 'LOOKUP',
          entityType: 'NODE',
          labelsOrTypes: null,
          properties: null,
          owningConstraint: null,
        },
      ],
    }),
  );
  const props = Object.fromEntries((snapshot.labels[0]?.properties ?? []).map((p) => [p.name, p]));
  assert.equal(props['discogsId']?.unique, true);
  assert.equal(props['discogsId']?.indexed, true); // constraint-backed index covers it
  assert.equal(props['pressingYear']?.unique, false);
  assert.equal(props['pressingYear']?.indexed, true);
  assert.equal(props['title']?.unique, false);
  assert.equal(props['title']?.indexed, false);
});

test('relationships are deduped, sorted, and pull in label-only entities', () => {
  const snapshot = buildSnapshot(
    raw({
      relRows: [
        { from: ['Release'], rel: 'HAS_TRACK', to: ['Track'] },
        { from: ['Release'], rel: 'HAS_TRACK', to: ['Track'] }, // duplicate
        { from: ['Musician'], rel: 'CREDITED_ON', to: ['Track'] },
      ],
    }),
  );
  assert.deepEqual(snapshot.relationships, [
    { type: 'CREDITED_ON', from: 'Musician', to: 'Track' },
    { type: 'HAS_TRACK', from: 'Release', to: 'Track' },
  ]);
  // Track/Release/Musician appear as entities even with no properties.
  assert.deepEqual(
    snapshot.labels.map((l) => l.label),
    ['Musician', 'Release', 'Track'],
  );
});

test('self-referential relationships are preserved', () => {
  const snapshot = buildSnapshot(
    raw({ relRows: [{ from: ['Label'], rel: 'PARENT_LABEL', to: ['Label'] }] }),
  );
  assert.deepEqual(snapshot.relationships, [{ type: 'PARENT_LABEL', from: 'Label', to: 'Label' }]);
});

test('serialized snapshot never leaks neo4j Integer {low,high} blobs', () => {
  const snapshot = buildSnapshot(
    raw({
      nodeTypeRows: [
        {
          nodeLabels: ['Release'],
          propertyName: 'discogsId',
          propertyTypes: ['Long'],
          mandatory: true,
        },
      ],
    }),
  );
  const json = serializeSnapshot(snapshot);
  assert.ok(!json.includes('"low"'), 'snapshot must not contain Integer .low');
  assert.ok(!json.includes('"high"'), 'snapshot must not contain Integer .high');
  assert.ok(json.endsWith('\n'), 'snapshot ends with a trailing newline');
});

test('byte-identical output across two builds of the same data', () => {
  const input = raw({
    nodeTypeRows: [
      {
        nodeLabels: ['Release'],
        propertyName: 'title',
        propertyTypes: ['String'],
        mandatory: true,
      },
      {
        nodeLabels: ['Release'],
        propertyName: 'discogsId',
        propertyTypes: ['Long'],
        mandatory: true,
      },
    ],
    relRows: [{ from: ['Release'], rel: 'RELEASED_BY', to: ['Artist'] }],
  });
  assert.equal(serializeSnapshot(buildSnapshot(input)), serializeSnapshot(buildSnapshot(input)));
});
