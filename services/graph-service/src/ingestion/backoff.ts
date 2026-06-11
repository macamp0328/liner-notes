/**
 * Backoff jitter for the shared rate-limited fetch core (rate-limited-fetch.ts),
 * which every external API client (discogs, musicbrainz, acousticbrainz, deezer,
 * wikidata) runs on. Each client instance keeps its own exponential schedule; this
 * only randomizes the individual sleep so concurrent clients don't retry in lockstep.
 *
 * @see issue #245 — landed alongside #225 (the clients now share one fetch core).
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
 * injectable so tests can make the jitter deterministic. It defaults to `Math.random`;
 * its output is clamped to `[0, 1]`, so an out-of-range stub can never push the wait
 * above `base` and break the cap. `random: () => 1` yields exactly `base` — the
 * pre-jitter value.
 */
export function jitteredBackoffMs(
  baseMs: number,
  options: { retryAfterMs?: number; random?: () => number } = {},
): number {
  const random = options.random ?? Math.random;
  const retryAfterMs = options.retryAfterMs ?? 0;
  // Clamp the draw to [0, 1] so an out-of-range stub can't push the jittered wait above
  // `base` and break the per-client 32s cap. (Retry-After is a separate floor, applied
  // below, and may legitimately exceed `base`.)
  const roll = Math.min(Math.max(random(), 0), 1);
  const jittered = Math.round(baseMs / 2 + roll * (baseMs / 2));
  return Math.max(jittered, retryAfterMs);
}
