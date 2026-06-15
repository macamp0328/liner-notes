// Unit tests for the pure drift logic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SchemaSnapshot } from './snapshot.js';
import {
  buildDriftReport,
  diffCodeDb,
  diffModel,
  driftSummaryLine,
  extractDeclaredSchemaNames,
  renderDriftMarkdown,
} from './drift.js';

function snap(over: Partial<SchemaSnapshot> = {}): SchemaSnapshot {
  return {
    schemaVersion: 1,
    labels: [],
    relationships: [],
    constraints: [],
    indexes: [],
    ...over,
  };
}

test('diffModel: null previous is a baseline (no drift)', () => {
  const m = diffModel(null, snap({ labels: [{ label: 'Release', properties: [] }] }));
  assert.deepEqual(m.addedLabels, []);
  assert.deepEqual(m.removedLabels, []);
});

test('diffModel: detects added/removed labels, properties, relationships', () => {
  const prev = snap({
    labels: [
      {
        label: 'Release',
        properties: [
          { name: 'title', types: ['String'], mandatory: true, unique: false, indexed: false },
          { name: 'year', types: ['String'], mandatory: false, unique: false, indexed: false },
        ],
      },
      { label: 'Work', properties: [] },
    ],
    relationships: [{ type: 'RECORDING_OF', from: 'Track', to: 'Work' }],
  });
  const curr = snap({
    labels: [
      {
        label: 'Release',
        properties: [
          { name: 'title', types: ['String'], mandatory: true, unique: false, indexed: false },
          { name: 'barcode', types: ['String'], mandatory: false, unique: false, indexed: false },
          { name: 'year', types: ['Long'], mandatory: false, unique: false, indexed: false },
        ],
      },
    ],
    relationships: [{ type: 'HAS_TRACK', from: 'Release', to: 'Track' }],
  });
  const m = diffModel(prev, curr);
  assert.deepEqual(m.removedLabels, ['Work']);
  assert.deepEqual(m.addedLabels, []);
  assert.deepEqual(m.addedProperties, [
    { label: 'Release', property: 'barcode', types: ['String'] },
  ]);
  assert.deepEqual(m.removedProperties, []);
  // year: String → Long is a type change, not add/remove
  assert.deepEqual(m.changedProperties, [
    { label: 'Release', property: 'year', from: ['String'], to: ['Long'] },
  ]);
  assert.deepEqual(m.addedRelationships, [{ type: 'HAS_TRACK', from: 'Release', to: 'Track' }]);
  assert.deepEqual(m.removedRelationships, [{ type: 'RECORDING_OF', from: 'Track', to: 'Work' }]);
});

test('extractDeclaredSchemaNames: classifies CREATE, ignores DROP/MATCH', () => {
  const src = [
    "'CREATE CONSTRAINT release_discogs_id IF NOT EXISTS FOR (r:Release) REQUIRE r.discogsId IS UNIQUE',",
    "'CREATE FULLTEXT INDEX lyricsSearch IF NOT EXISTS FOR (t:Track) ON EACH [t.lyrics]',",
    "'CREATE INDEX release_pressing_year IF NOT EXISTS FOR (r:Release) ON (r.pressingYear)',",
    "'CREATE TEXT INDEX rel_text_idx IF NOT EXISTS FOR (r:Release) ON (r.notes)',",
    "'CREATE VECTOR INDEX track_embedding IF NOT EXISTS FOR (t:Track) ON (t.embedding)',",
    "'DROP INDEX track_normalized_title IF EXISTS',",
    "'MATCH (r:Release) WHERE r.year IS NOT NULL SET r.pressingYear = r.year',",
  ].join('\n');
  const out = extractDeclaredSchemaNames(src);
  assert.deepEqual(out.constraints, ['release_discogs_id']);
  // FULLTEXT, plain, TEXT, and VECTOR index modifiers are all captured
  assert.deepEqual(out.indexes, [
    'lyricsSearch',
    'rel_text_idx',
    'release_pressing_year',
    'track_embedding',
  ]);
  assert.ok(!out.indexes.includes('track_normalized_title'), 'DROP lines ignored');
});

test('diffCodeDb: de-noises constraint-backed + LOOKUP indexes', () => {
  const current = snap({
    constraints: [
      {
        name: 'release_discogs_id',
        type: 'UNIQUENESS',
        entityType: 'NODE',
        labelsOrTypes: ['Release'],
        properties: ['discogsId'],
      },
    ],
    indexes: [
      // constraint-backed — must be ignored (owningConstraint set)
      {
        name: 'release_discogs_id',
        indexType: 'RANGE',
        entityType: 'NODE',
        labelsOrTypes: ['Release'],
        properties: ['discogsId'],
        owningConstraint: 'release_discogs_id',
      },
      // LOOKUP token — must be ignored
      {
        name: 'index_abc',
        indexType: 'LOOKUP',
        entityType: 'NODE',
        labelsOrTypes: [],
        properties: [],
        owningConstraint: null,
      },
      // a real, declared range index
      {
        name: 'release_pressing_year',
        indexType: 'RANGE',
        entityType: 'NODE',
        labelsOrTypes: ['Release'],
        properties: ['pressingYear'],
        owningConstraint: null,
      },
      // a real index NOT in code (stray)
      {
        name: 'manual_stray_index',
        indexType: 'RANGE',
        entityType: 'NODE',
        labelsOrTypes: ['Release'],
        properties: ['notes'],
        owningConstraint: null,
      },
    ],
  });
  const declared = {
    constraints: ['release_discogs_id', 'work_mbid'], // work_mbid not in DB
    indexes: ['release_pressing_year', 'track_works_fetched_at'], // latter not in DB
  };
  const d = diffCodeDb(declared, current);
  assert.deepEqual(d.inCodeNotInDb.constraints, ['work_mbid']);
  assert.deepEqual(d.inCodeNotInDb.indexes, ['track_works_fetched_at']);
  assert.deepEqual(d.inDbNotInCode.constraints, []);
  // the constraint-backed + LOOKUP indexes are NOT flagged; only the genuine stray is
  assert.deepEqual(d.inDbNotInCode.indexes, ['manual_stray_index']);
});

test('buildDriftReport + summary: flags both kinds, and "in sync" when clean', () => {
  const clean = buildDriftReport(snap(), snap(), { constraints: [], indexes: [] });
  assert.equal(clean.hasModelDrift, false);
  assert.equal(clean.hasCodeDbDrift, false);
  assert.match(driftSummaryLine(clean), /In sync/);

  const drifted = buildDriftReport(snap({ labels: [{ label: 'Work', properties: [] }] }), snap(), {
    constraints: ['work_mbid'],
    indexes: [],
  });
  assert.equal(drifted.hasModelDrift, true); // Work removed
  assert.equal(drifted.hasCodeDbDrift, true); // work_mbid declared, absent
  assert.match(driftSummaryLine(drifted), /⚠️/);
  assert.match(renderDriftMarkdown(drifted), /# Schema drift report/);
});
