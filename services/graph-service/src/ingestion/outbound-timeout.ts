/**
 * Per-request outbound-timeout resolution for the external API client factories (#357).
 *
 * Kept out of `createRateLimitedFetch` on purpose: the core stays env-free (a deliberate property),
 * so env reading lives here in the factory layer. A single `OUTBOUND_REQUEST_TIMEOUT_MS` overrides
 * every client; when unset, each client uses its own default — standard clients 30s, the bulk
 * MusicBrainz/AcousticBrainz clients 60s (their batched calls legitimately run longer).
 */
import { DEFAULT_TIMEOUT_MS } from './rate-limited-fetch.js';

/**
 * Default per-request timeout for the standard (non-bulk) clients. Derived from the core's
 * {@link DEFAULT_TIMEOUT_MS} so the standard default and the core's own fallback can't drift apart.
 */
export const DEFAULT_OUTBOUND_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;

/** Longer default for the bulk MusicBrainz/AcousticBrainz clients whose batched calls run slower. */
export const BULK_OUTBOUND_TIMEOUT_MS = 60_000;

/**
 * Resolve the per-request timeout from `OUTBOUND_REQUEST_TIMEOUT_MS`, falling back to the given
 * per-client default. A malformed or non-positive value falls back to the default (fail-safe), using
 * the same clamp the other numeric env vars use.
 */
export function resolveOutboundTimeoutMs(defaultMs: number): number {
  const parsed = parseInt(process.env['OUTBOUND_REQUEST_TIMEOUT_MS'] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultMs;
}
