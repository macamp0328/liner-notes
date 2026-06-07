/**
 * genius-contribution-probe.ts — measure Genius's real incremental lyric
 * contribution over LRCLIB (issue #241).
 *
 * WHY THIS EXISTS
 * In production, Genius's measured lyric contribution is 0 — but only because
 * Cloudflare blocks the EC2 egress IP, so we have never seen what Genius *would*
 * add. This probe answers the open question: of the tracks LRCLIB missed (the
 * `t.lyrics IS NULL` set), how many would Genius actually yield VALID lyrics for,
 * run from an egress that isn't blocked? Run it from a residential IP (a laptop) —
 * the prod EC2 IP gets a Cloudflare 403; a home IP gets 200.
 *
 * WHAT IT DOES
 * Pulls the candidate (artist, title) pairs from Neo4j (READ-ONLY — it never
 * MERGEs or SETs anything) and runs the production LRCLIB -> Genius fallback
 * against each, classifying the outcome. It scores Genius pages with the *exact*
 * extractor/validator production uses (imported from src/enrichment/lyrics-extract.ts),
 * so there is no copy-paste drift. Genius is hit via its unauthenticated public
 * search (same song results + URLs as the token'd API), so no GENIUS_TOKEN needed.
 *
 * USAGE
 *   pnpm --filter graph-service exec tsx scripts/genius-contribution-probe.ts \
 *     --env /absolute/path/to/.env.local
 *
 *   Flags (all optional):
 *     --env <path>          .env file with NEO4J_URI/USER/PASSWORD
 *                           (default: services/graph-service/.env.local)
 *     --limit <n>           probe only the first n candidates (smoke test)
 *     --concurrency <n>     parallel workers (default 4)
 *     --out <path>          JSONL checkpoint file (default: <tmpdir>/ln-genius-probe.jsonl)
 *     --fresh               ignore (do not resume from) an existing checkpoint
 *
 * The run checkpoints to a JSONL file in the OS temp dir and resumes on restart,
 * so a long run survives an interruption. The checkpoint holds aggregates plus a
 * redacted ~60-char head of any rejected text (for real-vs-junk triage) — it is
 * NOT committed to the repo and never stores full lyric text.
 */
import neo4j from 'neo4j-driver';
import { existsSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractLyricsFromHtml,
  isValidGeniusLyrics,
  normalizeArtistName,
} from '../src/enrichment/lyrics-extract.js';

// Same browser-like UA production sends to clear Genius's Cloudflare bot check (#195).
const GENIUS_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 4;

type Outcome =
  | 'GENIUS-WIN'
  | 'LRCLIB-NOW-HITS'
  | 'no-song-hit'
  | 'artist-mismatch'
  | 'no-lyrics-container'
  | 'invalid-lyrics'
  | 'error';

type InvalidReason = 'too-long' | 'contributor-header' | 'trailing-lyrics-title';

interface Candidate {
  releaseDiscogsId: number;
  position: string;
  artist: string | null;
  title: string;
}

interface ProbeResult extends Candidate {
  outcome: Outcome;
  lyricsLength?: number;
  invalidReason?: InvalidReason;
  head?: string; // redacted ~60-char head, only for invalid-lyrics triage
  // For invalid-lyrics: would the body validate if the "N ContributorsTitle Lyrics"
  // header the extractor leaves on the front were stripped? Distinguishes
  // real-lyrics-but-mangled (the extractor bug's hidden upside) from genuine junk.
  recoverable?: boolean;
  strippedHead?: string; // redacted ~90-char head of the header-stripped body
  geniusUrl?: string;
  geniusArtist?: string;
  error?: string;
}

interface GeniusPublicSearchResponse {
  response?: {
    sections?: Array<{
      hits?: Array<{
        type?: string;
        result?: { url?: string; primary_artist?: { name?: string } };
      }>;
    }>;
  };
}

// --- CLI -------------------------------------------------------------------

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function trackKey(c: Candidate): string {
  return `${c.releaseDiscogsId}::${c.position}`;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Vary delays by call without Math.random (jitter via a rolling counter).
let jitterTick = 0;
function jitterMs(base: number): number {
  jitterTick = (jitterTick + 137) % 251;
  return base + jitterTick;
}

// --- HTTP ------------------------------------------------------------------

// fetch with a timeout + backoff on the throttling/blocking statuses Genius's
// Cloudflare edge returns under load (429/403) and transient 5xx.
async function fetchWithRetry(url: string, init: RequestInit, label: string): Promise<Response> {
  let attempt = 0;
  for (;;) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (
        (response.status === 429 || response.status === 403 || response.status >= 500) &&
        attempt < MAX_RETRIES
      ) {
        attempt++;
        await sleep(jitterMs(1000 * 2 ** attempt));
        continue;
      }
      return response;
    } catch (err) {
      if (attempt >= MAX_RETRIES) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`${label} failed after ${attempt} retries: ${msg}`);
      }
      attempt++;
      await sleep(jitterMs(1000 * 2 ** attempt));
    }
  }
}

// Mirrors production fetchLrclib's status-code contract (src/enrichment/lyrics.ts):
// 200 -> plainLyrics, 404 -> null (LRCLIB miss), any other status -> throw. The
// transport differs deliberately — this adds retry/timeout/UA for the long offline
// run — but the lyrics/miss/error decision is identical.
async function fetchLrclib(artistName: string, title: string): Promise<string | null> {
  const url = new URL('https://lrclib.net/api/get');
  url.searchParams.set('track_name', title);
  url.searchParams.set('artist_name', artistName);

  const response = await fetchWithRetry(
    url.toString(),
    { headers: { 'User-Agent': GENIUS_USER_AGENT } },
    'LRCLIB',
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`LRCLIB returned ${response.status}`);
  const data = (await response.json()) as { plainLyrics?: string | null };
  return data.plainLyrics ?? null;
}

function invalidReasonFor(text: string): InvalidReason {
  if (text.length > 15_000) return 'too-long';
  if (/^\d+\s+Contributor/i.test(text)) return 'contributor-header';
  return 'trailing-lyrics-title';
}

// Strip the "<n> Contributor(s)[Translations…]<Title> Lyrics" header that the
// extractor currently leaves on the front of the body — the reason every
// contributor-header invalid-lyrics result is rejected. What remains is the body
// the validator would see if the sibling extractor bug were fixed.
//
// NB: no word boundary after "Lyrics" — the body frequently runs straight into it
// ("…Right On Time LyricsWell, well…"), so /\bLyrics\b/ would fail to match and
// leave the header on, under-counting recoverable lyrics. Non-greedy .*? stops at
// the first "Lyrics", which is always the header's (the body comes after it).
function stripGeniusHeader(text: string): string {
  const m = text.match(/^\s*\d+\s+Contributors?.*?Lyrics/is);
  return (m ? text.slice(m[0].length) : text).trim();
}

// Mirrors production fetchGenius's decision flow (search -> song-type gate ->
// artist fuzzy-match -> page scrape -> extract -> validate), but against Genius's
// unauthenticated public search. Returns the production-equivalent outcome and the
// diagnostics needed to triage invalid-lyrics (real-but-mangled vs genuine junk).
async function probeGenius(
  artist: string | null,
  title: string,
): Promise<
  Pick<
    ProbeResult,
    | 'outcome'
    | 'lyricsLength'
    | 'invalidReason'
    | 'head'
    | 'recoverable'
    | 'strippedHead'
    | 'geniusUrl'
    | 'geniusArtist'
  >
> {
  const searchUrl = new URL('https://genius.com/api/search/song');
  searchUrl.searchParams.set('q', `${artist ?? ''} ${title}`.trim());

  const searchResponse = await fetchWithRetry(
    searchUrl.toString(),
    {
      headers: {
        'User-Agent': GENIUS_USER_AGENT,
        Accept: 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    },
    'Genius search',
  );
  if (!searchResponse.ok) throw new Error(`Genius search returned ${searchResponse.status}`);

  const searchData = (await searchResponse.json()) as GeniusPublicSearchResponse;
  const firstHit = searchData.response?.sections?.[0]?.hits?.[0];
  const result = firstHit?.result;

  // Genius also indexes books and articles — only accept song results (prod parity).
  if (!firstHit || firstHit.type !== 'song' || !result?.url) {
    return { outcome: 'no-song-hit' };
  }
  const geniusUrl = result.url;

  const geniusArtist = normalizeArtistName(result.primary_artist?.name ?? '');
  const queryArtist = normalizeArtistName(artist ?? '');
  if (queryArtist && !geniusArtist.includes(queryArtist) && !queryArtist.includes(geniusArtist)) {
    return { outcome: 'artist-mismatch', geniusArtist, geniusUrl };
  }

  const pageResponse = await fetchWithRetry(
    geniusUrl,
    {
      headers: {
        'User-Agent': GENIUS_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    },
    'Genius page',
  );
  if (!pageResponse.ok) throw new Error(`Genius page returned ${pageResponse.status}`);

  const html = await pageResponse.text();
  const lyrics = extractLyricsFromHtml(html);
  if (!lyrics) return { outcome: 'no-lyrics-container', geniusUrl };

  if (!isValidGeniusLyrics(lyrics)) {
    const stripped = stripGeniusHeader(lyrics);
    const recoverable = isValidGeniusLyrics(stripped) && stripped.length >= 40;
    return {
      outcome: 'invalid-lyrics',
      geniusUrl,
      lyricsLength: lyrics.length,
      invalidReason: invalidReasonFor(lyrics),
      head: lyrics.slice(0, 60).replace(/\s+/g, ' ').trim(),
      recoverable,
      strippedHead: stripped.slice(0, 90).replace(/\s+/g, ' ').trim(),
    };
  }

  return { outcome: 'GENIUS-WIN', geniusUrl, lyricsLength: lyrics.length };
}

// Mirror production's fallback ORDER: LRCLIB first; only on a miss does Genius run.
async function probeCandidate(c: Candidate): Promise<ProbeResult> {
  try {
    const lrclib = await fetchLrclib(c.artist ?? '', c.title);
    if (lrclib !== null) return { ...c, outcome: 'LRCLIB-NOW-HITS', lyricsLength: lrclib.length };
    await sleep(jitterMs(150));
    const genius = await probeGenius(c.artist, c.title);
    return { ...c, ...genius };
  } catch (err) {
    return { ...c, outcome: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

// --- Neo4j (read-only) -----------------------------------------------------

// The full lyrics-null candidate set (the "577 missed tracks"). Unlike production's
// getUnenrichedTracks this is NOT staleness-throttled — we want the whole ceiling.
// artistName is derived identically (first RELEASED_BY artist). READ-ONLY.
async function loadCandidates(uri: string, user: string, password: string): Promise<Candidate[]> {
  const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  const session = driver.session({ defaultAccessMode: neo4j.session.READ });
  try {
    const result = await session.run(
      `MATCH (r:Release)-[:HAS_TRACK]->(t:Track)
       WHERE t.lyrics IS NULL
       OPTIONAL MATCH (r)-[:RELEASED_BY]->(a:Artist)
       WITH t, collect(a.name)[0] AS artist
       RETURN artist, t.title AS title,
              t.releaseDiscogsId AS releaseDiscogsId, t.position AS position
       ORDER BY releaseDiscogsId, position`,
    );
    return result.records.map((record) => {
      const rawId = record.get('releaseDiscogsId') as { toNumber(): number };
      return {
        releaseDiscogsId: rawId.toNumber(),
        position: record.get('position') as string,
        artist: record.get('artist') as string | null,
        title: record.get('title') as string,
      };
    });
  } finally {
    await session.close();
    await driver.close();
  }
}

// --- Concurrency pool ------------------------------------------------------

async function runPool(
  candidates: Candidate[],
  concurrency: number,
  worker: (c: Candidate) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, candidates.length) }, async () => {
    for (;;) {
      const idx = next++;
      const candidate = candidates[idx];
      if (!candidate) break;
      await worker(candidate);
    }
  });
  await Promise.all(runners);
}

// --- Reporting -------------------------------------------------------------

const OUTCOMES: Outcome[] = [
  'GENIUS-WIN',
  'LRCLIB-NOW-HITS',
  'no-song-hit',
  'artist-mismatch',
  'no-lyrics-container',
  'invalid-lyrics',
  'error',
];

function report(results: ProbeResult[]): void {
  const total = results.length;
  const counts = new Map<Outcome, number>(OUTCOMES.map((o) => [o, 0]));
  for (const r of results) counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);

  const win = counts.get('GENIUS-WIN') ?? 0;
  const lrclibNow = counts.get('LRCLIB-NOW-HITS') ?? 0;
  const lrclibStillMissing = total - lrclibNow;

  console.log('\n===== Genius incremental contribution over LRCLIB =====');
  console.log(`candidates (t.lyrics IS NULL): ${total}\n`);
  console.log('outcome                | count |  % of total');
  console.log('-----------------------|-------|------------');
  for (const o of OUTCOMES) {
    const n = counts.get(o) ?? 0;
    const pct = total ? ((n / total) * 100).toFixed(1) : '0.0';
    console.log(`${o.padEnd(22)} | ${String(n).padStart(5)} | ${pct.padStart(9)}%`);
  }

  const invalids = results.filter((r) => r.outcome === 'invalid-lyrics');
  const recoverable = invalids.filter((r) => r.recoverable).length;

  console.log('\n----- headline -----');
  console.log(`GENIUS-WIN / total                       = ${win} / ${total}`);
  console.log(`GENIUS-WIN / LRCLIB-missing              = ${win} / ${lrclibStillMissing}`);
  console.log(
    `true ceiling if extractor bug fixed too  = ${win + recoverable} / ${total}  ` +
      `(GENIUS-WIN ${win} + recoverable invalid-lyrics ${recoverable})`,
  );

  if (invalids.length) {
    const byReason = new Map<InvalidReason, number>();
    for (const r of invalids) {
      if (r.invalidReason) byReason.set(r.invalidReason, (byReason.get(r.invalidReason) ?? 0) + 1);
    }
    console.log('\n----- invalid-lyrics breakdown (rejection reason) -----');
    for (const [reason, n] of byReason) console.log(`  ${reason.padEnd(24)} ${n}`);
    console.log(
      `  recoverable (real lyrics, only the header is in the way): ${recoverable} / ${invalids.length}`,
    );
    console.log(
      `  not recoverable (instrumental / description / wrong-song): ${invalids.length - recoverable}`,
    );
    console.log('\n  not-recoverable heads (header-stripped; manual junk check):');
    for (const r of invalids.filter((x) => !x.recoverable)) {
      console.log(`    ${r.artist ?? '?'} — ${r.title} :: "${r.strippedHead ?? ''}"`);
    }
    console.log('\n  recoverable heads (header-stripped; sample):');
    for (const r of invalids.filter((x) => x.recoverable).slice(0, 20)) {
      console.log(`    ${r.artist ?? '?'} — ${r.title} :: "${r.strippedHead ?? ''}"`);
    }
  }

  const errors = results.filter((r) => r.outcome === 'error');
  if (errors.length) {
    console.log(`\n----- errors (${errors.length}) — sample -----`);
    for (const r of errors.slice(0, 10))
      console.log(`  ${r.artist ?? '?'} — ${r.title}: ${r.error}`);
  }
}

// --- main ------------------------------------------------------------------

function loadEnv(): void {
  const defaultEnv = fileURLToPath(new URL('../.env.local', import.meta.url));
  const envPath = argValue('--env') ?? defaultEnv;
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
    console.log(`[probe] loaded env from ${envPath}`);
  } else {
    console.log(`[probe] no env file at ${envPath} — relying on process.env`);
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

function readCheckpoint(outPath: string): ProbeResult[] {
  if (!existsSync(outPath)) return [];
  return readFileSync(outPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ProbeResult);
}

async function main(): Promise<void> {
  loadEnv();
  const uri = requireEnv('NEO4J_URI');
  const user = requireEnv('NEO4J_USER');
  const password = requireEnv('NEO4J_PASSWORD');

  const concurrency = Number(argValue('--concurrency') ?? '4');
  const limit = argValue('--limit') ? Number(argValue('--limit')) : undefined;
  const outPath = argValue('--out') ?? join(tmpdir(), 'ln-genius-probe.jsonl');
  const fresh = hasFlag('--fresh');

  console.log('[probe] loading candidates from Neo4j (read-only)…');
  let candidates = await loadCandidates(uri, user, password);
  console.log(`[probe] ${candidates.length} candidates with t.lyrics IS NULL`);
  if (limit !== undefined) candidates = candidates.slice(0, limit);

  const prior = fresh ? [] : readCheckpoint(outPath);
  const done = new Set(prior.map((r) => trackKey(r)));
  const todo = candidates.filter((c) => !done.has(trackKey(c)));
  console.log(
    `[probe] checkpoint=${outPath} | done=${done.size} | todo=${todo.length} | concurrency=${concurrency}`,
  );

  const collected: ProbeResult[] = [...prior.filter((r) => done.has(trackKey(r)))];
  let processed = 0;
  await runPool(todo, concurrency, async (candidate) => {
    const result = await probeCandidate(candidate);
    collected.push(result);
    appendFileSync(outPath, `${JSON.stringify(result)}\n`);
    processed++;
    if (processed % 25 === 0 || processed === todo.length) {
      const win = collected.filter((r) => r.outcome === 'GENIUS-WIN').length;
      console.log(`[probe] ${processed}/${todo.length} processed (genius-win so far: ${win})`);
    }
  });

  // Tally only the rows for the candidate set we were asked to probe.
  const wanted = new Set(candidates.map((c) => trackKey(c)));
  report(collected.filter((r) => wanted.has(trackKey(r))));
}

main().catch((err: unknown) => {
  console.error('[probe] fatal:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
