// Unit tests for the diagrams generator's pure functions (issue #350). Run via
// `pnpm scripts:test` (node's built-in runner through tsx — no extra dep, like
// changelog:test). scripts/ is outside the graph-service coverage gate, so these
// add rigor without touching service thresholds.
//
// generate.ts guards main() behind an is-main check, so importing it here runs
// no I/O (no inframap/docker, no file writes) — only the pure functions below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPerFileMermaid,
  categorize,
  extractCaption,
  findReferences,
  parseBlocks,
  postProcessDot,
  splitAddress,
  stripComments,
  type Block,
} from './generate.js';

test('splitAddress: plain resource address splits into type + name', () => {
  assert.deepEqual(splitAddress('aws_instance.k3s'), { type: 'aws_instance', name: 'k3s' });
});

test('splitAddress: the data. prefix is dropped before the type', () => {
  assert.deepEqual(splitAddress('data.aws_ami.al2023'), { type: 'aws_ami', name: 'al2023' });
});

test('splitAddress: a single segment falls back to the whole address', () => {
  assert.deepEqual(splitAddress('weird'), { type: 'weird', name: 'weird' });
});

test('stripComments: removes line (//, #) and block comments', () => {
  const src = 'a = 1 // line\nb = 2 # hash\n/* block\ncomment */c = 3';
  const out = stripComments(src);
  assert.ok(out.includes('a = 1'));
  assert.ok(out.includes('c = 3'));
  assert.ok(!out.includes('line'));
  assert.ok(!out.includes('hash'));
  assert.ok(!out.includes('block'));
});

test('stripComments: preserves :// in URLs (the [^:] guard)', () => {
  const src = 'url = "https://example.com/x"';
  assert.equal(stripComments(src), src);
});

test('parseBlocks: extracts resource + data blocks, ignoring braces inside string literals', () => {
  const src = [
    'resource "aws_instance" "k3s" {',
    '  ami = "ami-123"',
    '  tags = {',
    '    Name = "has a } brace in a string"',
    '  }',
    '  user_data = "${var.x}"',
    '}',
    '',
    'data "aws_ami" "al2023" {',
    '  most_recent = true',
    '}',
  ].join('\n');

  const blocks = parseBlocks(src, 'ec2.tf');
  assert.equal(blocks.length, 2);

  const [resourceBlock, dataBlock] = blocks;
  assert.ok(resourceBlock);
  assert.ok(dataBlock);
  assert.deepEqual(resourceBlock.decl, {
    kind: 'resource',
    type: 'aws_instance',
    name: 'k3s',
    file: 'ec2.tf',
  });
  assert.deepEqual(dataBlock.decl, {
    kind: 'data',
    type: 'aws_ami',
    name: 'al2023',
    file: 'ec2.tf',
  });
  // The `}` inside the string did not prematurely close the block, and the body
  // is the inner content (outer braces excluded).
  assert.ok(resourceBlock.body.includes('has a } brace in a string'));
  assert.ok(resourceBlock.body.includes('user_data = "${var.x}"'));
  assert.ok(!resourceBlock.body.includes('most_recent'));
});

test('findReferences: returns only addresses present in the known set', () => {
  const known = new Set(['aws_vpc.main', 'data.aws_ami.al2023']);
  const body = [
    'vpc_id = aws_vpc.main.id',
    'ami = data.aws_ami.al2023.id',
    'other = aws_subnet.private.id', // not in `known` → must be ignored
  ].join('\n');
  const refs = findReferences(body, known);
  assert.deepEqual([...refs].sort(), ['aws_vpc.main', 'data.aws_ami.al2023']);
});

test('categorize: maps each resource family to its cluster category', () => {
  assert.equal(categorize('aws_iam_role'), 'iam');
  assert.equal(categorize('aws_instance'), 'compute');
  assert.equal(categorize('aws_vpc'), 'networking');
  assert.equal(categorize('aws_cloudwatch_metric_alarm'), 'observability');
  // route53_health is observability; other route53_* are edge — verify the split.
  assert.equal(categorize('aws_route53_health_check'), 'observability');
  assert.equal(categorize('aws_route53_zone'), 'edge');
  assert.equal(categorize('aws_s3_bucket'), 'storage');
  assert.equal(categorize('aws_secretsmanager_secret'), 'secrets');
  assert.equal(categorize('aws_cloudfront_distribution'), 'edge');
  assert.equal(categorize('aws_glue_job'), 'other');
});

test('extractCaption: pulls the leading # comment, stripped of #/quotes/angle-brackets', () => {
  assert.equal(
    extractCaption('# EC2 host & "k3s" <node>\nresource "x" "y" {}'),
    'EC2 host & k3s node',
  );
  assert.equal(extractCaption('resource "x" "y" {}'), null);
  assert.equal(extractCaption('#   \nfoo'), null);
});

test('postProcessDot: clusters nodes by category and preserves the sorted edge', () => {
  const dot = [
    'digraph {',
    '  "aws_instance.k3s" [shape=box];',
    '  "aws_vpc.main" [shape=box];',
    '  "aws_instance.k3s" -> "aws_vpc.main";',
    '}',
  ].join('\n');
  const out = postProcessDot(dot);
  assert.ok(out.startsWith('digraph G {'));
  assert.ok(out.includes('subgraph cluster_compute'));
  assert.ok(out.includes('subgraph cluster_networking'));
  assert.ok(out.includes('"aws_instance.k3s" -> "aws_vpc.main";'));
});

test('postProcessDot: throws when inframap output has edges but parses 0 nodes (format drift)', () => {
  // Trailing edge attributes make both edgeRE and nodeRE fail to match, so 0
  // nodes parse while the raw `"a" -> "b"` still matches the drift probe.
  const dot = 'digraph G {\n  "aws_instance.k3s" -> "aws_vpc.main" [style=dashed];\n}';
  assert.throws(() => postProcessDot(dot), /parsed 0 nodes/);
});

test('buildPerFileMermaid: solid intra-file edge, dashed cross-file edge, LR direction', () => {
  const blocksInFile: Block[] = [
    { decl: { kind: 'resource', type: 'aws_instance', name: 'k3s', file: 'ec2.tf' }, body: '' },
    { decl: { kind: 'resource', type: 'aws_vpc', name: 'main', file: 'ec2.tf' }, body: '' },
  ];
  const edges = [
    { from: 'aws_instance.k3s', to: 'aws_vpc.main' }, // both declared here → solid
    { from: 'aws_instance.k3s', to: 'aws_s3_bucket.logs' }, // external → dashed
  ];
  const declToFile = new Map([['aws_s3_bucket.logs', 'storage.tf']]);

  const out = buildPerFileMermaid('ec2.tf', 'compute host', blocksInFile, edges, declToFile);
  assert.ok(out.includes('flowchart LR'));
  assert.ok(out.includes('aws_instance_k3s --> aws_vpc_main'));
  assert.ok(out.includes('aws_instance_k3s -.-> aws_s3_bucket_logs'));
});
