/**
 * Shared backoff jitter for the external API clients (discogs, musicbrainz,
 * acousticbrainz, deezer, wikidata). Each client keeps its own exponential
 * schedule; this only randomizes the individual sleep so concurrent clients
 * don't retry in lockstep.
 *
 * @see issue #245 — relates to #225 (consolidate the clients behind one fetch core).
 */

/**
 * AWS "equal jitter": return a randomized wait in `[base/2, base]`, floored at any
 * server-requested `Retry-After` so we never retry sooner than the server asked.
 *
 * Independent draws per attempt desynchronize concurrent clients, so a shared 429
 * burst no longer makes every in-flight request retry at the same instant and
 * re-trigger the burst. The caller advances its exponential schedule from the
 * un-jittered `base`, so jitter shrinks individual sleeps without compounding the
 * backoff curve (and the per-client 32s cap on `base` is preserved: the ceiling here
 * is `base`).
 *
 * `random` is non-cryptographic (it spreads retries; it is not a secret) and is
 * injectable so tests can make the jitter deterministic. It must return a value in
 * `[0, 1)` and defaults to `Math.random`. With `random: () => 1` the result collapses
 * to exactly `base` — i.e. the pre-jitter behavior.
 */
export function jitteredBackoffMs(
  baseMs: number,
  options: { retryAfterMs?: number; random?: () => number } = {},
): number {
  const random = options.random ?? Math.random;
  const retryAfterMs = options.retryAfterMs ?? 0;
  const jittered = Math.round(baseMs / 2 + random() * (baseMs / 2));
  return Math.max(jittered, retryAfterMs);
}
