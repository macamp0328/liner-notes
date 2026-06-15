// Unit tests for the pure Mermaid renderers + the SCHEMA.md inliner.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SchemaSnapshot } from './snapshot.js';
import {
  buildPageHtml,
  buildSchemaMarkdown,
  inlineIntoMarkdown,
  renderErDiagram,
  renderGraphDiagram,
} from './render.js';

const snapshot: SchemaSnapshot = {
  schemaVersion: 1,
  labels: [
    {
      label: 'Artist',
      properties: [
        { name: 'discogsId', types: ['Long'], mandatory: true, unique: true, indexed: true },
        { name: 'name', types: ['String'], mandatory: true, unique: false, indexed: true },
      ],
    },
    {
      label: 'Release',
      properties: [
        { name: 'discogsId', types: ['Long'], mandatory: true, unique: true, indexed: true },
      ],
    },
    { label: 'Track', properties: [] },
  ],
  relationships: [
    { type: 'HAS_TRACK', from: 'Release', to: 'Track' },
    { type: 'RELEASED_BY', from: 'Release', to: 'Artist' },
  ],
  constraints: [],
  indexes: [],
};

test('ER diagram: PK on unique, comment on indexed/required, uniform cardinality', () => {
  const er = renderErDiagram(snapshot);
  assert.match(er, /^%% Auto-generated/);
  assert.match(er, /erDiagram/);
  assert.match(er, /Long discogsId PK/);
  assert.match(er, /String name "indexed, required"/);
  assert.match(er, /Release \}o--o\{ Track : "HAS_TRACK"/);
  // empty-property entity still gets a block
  assert.match(er, /Track \{\n {4}\}/);
});

test('graph diagram: every label declared, edges from relationships', () => {
  const graph = renderGraphDiagram(snapshot);
  assert.match(graph, /flowchart LR/);
  assert.match(graph, /Artist\["Artist"\]/);
  assert.match(graph, /Track\["Track"\]/);
  assert.match(graph, /Release -->\|"RELEASED_BY"\| Artist/);
});

test('inlineIntoMarkdown replaces between markers and throws when absent', () => {
  const md = 'a\n<!-- schema:er:start -->\nOLD\n<!-- schema:er:end -->\nb';
  const out = inlineIntoMarkdown('er', 'NEW', md);
  assert.match(out, /```mermaid\nNEW\n```/);
  assert.ok(!out.includes('OLD'));
  assert.throws(() => inlineIntoMarkdown('missing', 'x', md));
});

test('buildSchemaMarkdown inlines both diagrams and the drift line', () => {
  const md = buildSchemaMarkdown('ER_BODY', 'GRAPH_BODY', 'DRIFT_STATUS');
  assert.match(md, /# Data-model schema/);
  assert.match(md, /\*\*Drift:\*\* DRIFT_STATUS/);
  assert.match(md, /```mermaid\nER_BODY\n```/);
  assert.match(md, /```mermaid\nGRAPH_BODY\n```/);
});

test('renderers are deterministic across calls', () => {
  assert.equal(renderErDiagram(snapshot), renderErDiagram(snapshot));
  assert.equal(renderGraphDiagram(snapshot), renderGraphDiagram(snapshot));
});

test('buildPageHtml substitutes all placeholders ($-safe + HTML-escaped)', () => {
  const template =
    '<a>{{GRAPH_DIAGRAM}}</a><b>{{ER_DIAGRAM}}</b><c>{{LAST_UPDATED}}</c><d>{{DRIFT_STATUS}}</d>';
  const html = buildPageHtml(template, 'ER$&BODY', 'GRAPH', {
    lastUpdated: '2026-06-15',
    driftStatus: 'in sync',
  });
  // $& stays literal (function replacer); the & is HTML-escaped
  assert.equal(html, '<a>GRAPH</a><b>ER$&amp;BODY</b><c>2026-06-15</c><d>in sync</d>');
  assert.ok(!html.includes('{{'), 'no placeholder left unfilled');
});

test('buildPageHtml escapes HTML so a label cannot break out of the page', () => {
  const html = buildPageHtml(
    '<pre>{{GRAPH_DIAGRAM}}</pre>{{ER_DIAGRAM}}',
    '</pre><script>x</script>',
    'g',
    { lastUpdated: 'd', driftStatus: 's' },
  );
  assert.ok(!html.includes('<script>'), 'raw <script> must not survive');
  assert.ok(html.includes('&lt;script&gt;'), 'angle brackets are escaped');
});
