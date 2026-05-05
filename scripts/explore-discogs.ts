import * as dotenv from 'dotenv';
import { writeFileSync } from 'fs';
import { resolve } from 'path';

dotenv.config({ path: resolve(process.cwd(), '.env.local') });

const TOKEN = process.env['DISCOGS_TOKEN'];
const USERNAME = process.env['DISCOGS_USERNAME'];
const USER_AGENT =
  process.env['DISCOGS_USER_AGENT'] ??
  'liner-notes/1.0 +https://github.com/yourusername/liner-notes';
const DELAY_MS = parseInt(process.env['DISCOGS_REQUEST_DELAY_MS'] ?? '1000', 10);

if (!TOKEN) {
  console.error('❌ DISCOGS_TOKEN is not set in .env.local');
  process.exit(1);
}
if (!USERNAME) {
  console.error('❌ DISCOGS_USERNAME is not set in .env.local');
  process.exit(1);
}

const BASE_URL = 'https://api.discogs.com';
const HEADERS = {
  Authorization: `Discogs token=${TOKEN}`,
  'User-Agent': USER_AGENT,
  Accept: 'application/json',
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface DiscogsArtist {
  id: number;
  name: string;
  role: string;
  anv?: string;
  join?: string;
  resource_url?: string;
  tracks?: string;
}

interface DiscogsLabel {
  id: number;
  name: string;
  catno: string;
  resource_url?: string;
  entity_type?: string;
  entity_type_name?: string;
}

interface DiscogsFormat {
  name: string;
  qty: string;
  descriptions?: string[];
  text?: string;
}

interface DiscogsTracklistEntry {
  position: string;
  title: string;
  duration: string;
  type_?: string;
  extraartists?: DiscogsArtist[];
  sub_tracks?: DiscogsTracklistEntry[];
}

interface DiscogsImage {
  type: string;
  uri: string;
  resource_url?: string;
  uri150?: string;
  width?: number;
  height?: number;
}

interface DiscogsRelease {
  id: number;
  title: string;
  year?: number;
  country?: string;
  genres?: string[];
  styles?: string[];
  formats?: DiscogsFormat[];
  artists?: DiscogsArtist[];
  extraartists?: DiscogsArtist[];
  labels?: DiscogsLabel[];
  tracklist?: DiscogsTracklistEntry[];
  companies?: DiscogsLabel[];
  images?: DiscogsImage[];
  master_id?: number;
  master_url?: string;
  uri?: string;
  resource_url?: string;
  released?: string;
  released_formatted?: string;
  notes?: string;
  data_quality?: string;
  community?: unknown;
  lowest_price?: number;
  num_for_sale?: number;
  estimated_weight?: number;
  format_quantity?: number;
  [key: string]: unknown;
}

interface DiscogsCollectionRelease {
  id: number;
  instance_id: number;
  date_added: string;
  rating: number;
  folder_id: number;
  basic_information: {
    id: number;
    title: string;
    year: number;
    resource_url: string;
    thumb: string;
    cover_image: string;
    formats: DiscogsFormat[];
    labels: DiscogsLabel[];
    artists: DiscogsArtist[];
    genres: string[];
    styles: string[];
    master_id?: number;
    master_url?: string;
  };
}

interface DiscogsCollectionResponse {
  pagination: {
    page: number;
    pages: number;
    per_page: number;
    items: number;
    urls: { next?: string; last?: string };
  };
  releases: DiscogsCollectionRelease[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function discogsGet<T>(path: string): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`Discogs API ${res.status} for ${url}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

function separator(label: string): void {
  const line = '─'.repeat(60);
  console.log(`\n${line}`);
  console.log(`  ${label}`);
  console.log(line);
}

// ─── Spec field comparison ────────────────────────────────────────────────────

interface FieldReport {
  field: string;
  present: boolean;
  type: string;
  sample: string;
  notes: string;
}

function describeValue(val: unknown): { type: string; sample: string } {
  if (val === undefined) return { type: 'undefined', sample: '—' };
  if (val === null) return { type: 'null', sample: 'null' };
  if (Array.isArray(val)) {
    const sample = val.length > 0 ? JSON.stringify(val[0]).slice(0, 80) : '(empty array)';
    return { type: `array[${val.length}]`, sample };
  }
  const str = JSON.stringify(val);
  return { type: typeof val, sample: str.slice(0, 80) };
}

function compareFields(release: DiscogsRelease): FieldReport[] {
  // Fields from spec Section 6.4
  const specFields: Array<{ field: string; notes: string }> = [
    { field: 'title', notes: '' },
    { field: 'year', notes: '' },
    { field: 'country', notes: '' },
    { field: 'genres', notes: 'spec: genres[]' },
    { field: 'styles', notes: 'spec: styles[]' },
    { field: 'formats', notes: 'spec: formats[]' },
    { field: 'artists', notes: 'spec: artists[] → name, id, role' },
    {
      field: 'extraartists',
      notes: 'spec: extraartists[] → producers, engineers, session musicians',
    },
    { field: 'labels', notes: 'spec: labels[] → name, id, catno' },
    {
      field: 'tracklist',
      notes: 'spec: tracklist[] → position, title, duration, extraartists[]',
    },
    {
      field: 'companies',
      notes: 'spec: companies[] → name, id, entity_type_name ("Recorded At" = studio)',
    },
    { field: 'images', notes: 'spec: images[] → uri, type' },
    { field: 'master_id', notes: '' },
  ];

  return specFields.map(({ field, notes }) => {
    const val = release[field];
    const present = val !== undefined;
    const { type, sample } = describeValue(val);
    return { field, present, type, sample, notes };
  });
}

function printFieldReport(reports: FieldReport[]): void {
  separator('FIELD-BY-FIELD COMPARISON — Spec Section 6.4 vs Actual API');
  console.log();

  const colWidths = { field: 16, present: 10, type: 16, sample: 50 };

  const header = [
    'Field'.padEnd(colWidths.field),
    'Present?'.padEnd(colWidths.present),
    'Type'.padEnd(colWidths.type),
    'Sample value'.padEnd(colWidths.sample),
  ].join(' │ ');
  console.log(header);
  console.log('─'.repeat(header.length));

  for (const r of reports) {
    const row = [
      r.field.padEnd(colWidths.field),
      (r.present ? '✅ yes' : '❌ no').padEnd(colWidths.present),
      r.type.padEnd(colWidths.type),
      r.sample.slice(0, colWidths.sample).padEnd(colWidths.sample),
    ].join(' │ ');
    console.log(row);
    if (r.notes) {
      console.log(
        `${''.padEnd(colWidths.field)}   ${' '.repeat(colWidths.present + 3)}note: ${r.notes}`,
      );
    }
  }
}

function printExtraFields(release: DiscogsRelease): void {
  separator('EXTRA FIELDS — Present in API but not captured in spec Section 6.4');
  const specKeys = new Set([
    'title',
    'year',
    'country',
    'genres',
    'styles',
    'formats',
    'artists',
    'extraartists',
    'labels',
    'tracklist',
    'companies',
    'images',
    'master_id',
    'id', // expected top-level id
  ]);
  const extraKeys = Object.keys(release).filter((k) => !specKeys.has(k));
  if (extraKeys.length === 0) {
    console.log('  (none — all API fields accounted for in spec)');
    return;
  }
  for (const key of extraKeys) {
    const { type, sample } = describeValue(release[key]);
    console.log(`  ${key.padEnd(24)} ${type.padEnd(16)} ${sample.slice(0, 60)}`);
  }
}

function analyzeTracklist(tracklist: DiscogsTracklistEntry[]): void {
  separator('TRACKLIST ANALYSIS');
  console.log(`  Total entries: ${tracklist.length}`);
  const withExtraArtists = tracklist.filter((t) => t.extraartists && t.extraartists.length > 0);
  console.log(`  Tracks with extraartists: ${withExtraArtists.length}`);
  if (withExtraArtists.length > 0 && withExtraArtists[0]?.extraartists) {
    console.log(`  Sample track extraartist roles:`);
    for (const ea of withExtraArtists[0].extraartists.slice(0, 3)) {
      console.log(`    • ${ea.name} — role: "${ea.role}"`);
    }
  }
  const sample = tracklist[0];
  if (sample) {
    console.log(`\n  Sample track fields: ${Object.keys(sample).join(', ')}`);
  }
}

function analyzeCompanies(companies: DiscogsLabel[]): void {
  separator('COMPANIES ANALYSIS (studio data probe)');
  console.log(`  Total companies: ${companies.length}`);
  for (const c of companies) {
    console.log(
      `  • ${c.name} | entity_type_name: "${c.entity_type_name ?? '(missing)'}" | catno: "${c.catno}"`,
    );
  }
  const studios = companies.filter(
    (c) => c.entity_type_name === 'Recorded At' || c.entity_type_name === 'Mixed At',
  );
  console.log(`  → ${studios.length} company entries with studio-relevant entity_type_name`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('🎵 liner-notes — Discogs API Exploration');
  console.log(`   User: ${USERNAME}`);
  console.log(`   User-Agent: ${USER_AGENT}`);
  console.log(`   Request delay: ${DELAY_MS}ms\n`);

  // Step 1: Fetch collection (first 5 releases)
  separator('RAW RESPONSE — Collection (page 1, per_page=5)');
  const collectionPath = `/users/${USERNAME}/collection/folders/0/releases?page=1&per_page=5`;
  const collection = await discogsGet<DiscogsCollectionResponse>(collectionPath);
  console.log(JSON.stringify(collection, null, 2));

  const { items, pages } = collection.pagination;
  console.log(`\n📦 Collection stats: ${items} total releases across ${pages} pages`);

  if (collection.releases.length === 0) {
    console.error('❌ No releases found in collection. Check DISCOGS_USERNAME.');
    process.exit(1);
  }

  // Step 2: Pick first release and fetch full details
  const firstRelease = collection.releases[0]!;
  const releaseId = firstRelease.basic_information.id;
  console.log(
    `\n🎯 Fetching full details for: "${firstRelease.basic_information.title}" (id: ${releaseId})`,
  );

  await sleep(DELAY_MS);

  separator(`RAW RESPONSE — Full Release (id: ${releaseId})`);
  const fullRelease = await discogsGet<DiscogsRelease>(`/releases/${releaseId}`);
  console.log(JSON.stringify(fullRelease, null, 2));

  // Step 3: Field comparison
  const fieldReports = compareFields(fullRelease);
  printFieldReport(fieldReports);
  printExtraFields(fullRelease);

  // Step 4: Deep dives
  if (fullRelease.tracklist && fullRelease.tracklist.length > 0) {
    analyzeTracklist(fullRelease.tracklist);
  } else {
    console.log('\n⚠️  No tracklist data on this release.');
  }

  if (fullRelease.companies) {
    analyzeCompanies(fullRelease.companies);
  } else {
    console.log('\n⚠️  No companies data on this release.');
  }

  // Step 5: Save fixture
  const fixturePath = resolve(
    process.cwd(),
    'services/graph-service/tests/fixtures/sample-release.json',
  );
  writeFileSync(fixturePath, JSON.stringify(fullRelease, null, 2));
  console.log(`\n✅ Fixture saved → services/graph-service/tests/fixtures/sample-release.json`);

  // Step 6: Summary
  separator('SUMMARY');
  const present = fieldReports.filter((r) => r.present).length;
  const absent = fieldReports.filter((r) => !r.present).length;
  console.log(`  Spec fields present in API response: ${present}/${fieldReports.length}`);
  if (absent > 0) {
    console.log(
      `  ⚠️  Missing: ${fieldReports
        .filter((r) => !r.present)
        .map((r) => r.field)
        .join(', ')}`,
    );
  }
  console.log(`\n  Collection size: ${items} releases`);
  console.log(`  Sample release: "${fullRelease.title}" (${fullRelease.year ?? 'year unknown'})`);
  console.log(`  Genre(s): ${fullRelease.genres?.join(', ') ?? 'none'}`);
  console.log(`  Style(s): ${fullRelease.styles?.join(', ') ?? 'none'}`);
  console.log(`  Tracklist: ${fullRelease.tracklist?.length ?? 0} entries`);
  console.log(`  Companies: ${fullRelease.companies?.length ?? 0} entries`);
  console.log(`  Extraartists (top-level): ${fullRelease.extraartists?.length ?? 0} entries`);
}

main().catch((err: unknown) => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
