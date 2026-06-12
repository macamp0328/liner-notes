/** undici / Node network-level error codes that warrant a bounded retry. */
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * Identify a transient network-level failure thrown by fetch (undici) — a DNS, connection, or
 * socket error rather than an HTTP status. undici surfaces these as `TypeError: fetch failed`
 * with the real socket error nested in `.cause`. Returns a short code/label for logging, or
 * null when the error is not retryable.
 *
 * Shared by the HTTP clients (DiscogsClient, MusicBrainzClient, AcousticBrainzClient,
 * DeezerClient, WikidataClient) so their retry loops agree on what counts as a
 * retryable network blip.
 */
export function transientNetworkCode(err: unknown): string | null {
  // A per-request timeout (AbortSignal.timeout) rejects with a DOMException named 'TimeoutError'.
  // It carries no transient `.code` string (its legacy `.code` is the number 23) and its message is
  // not "fetch failed", so the inspection below would return null — and in some runtimes DOMException
  // isn't even an instanceof Error, tripping the guard. So match it first, by name. A caller-initiated
  // cancel is an 'AbortError' DOMException and stays non-transient (returns null) so an intentional
  // abort propagates instead of being retried.
  if (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'TimeoutError'
  ) {
    return 'TimeoutError';
  }
  if (!(err instanceof Error)) return null;
  if (err.message.includes('fetch failed')) return 'fetch failed';
  for (const candidate of [err.cause, err]) {
    const code = (candidate as { code?: unknown } | undefined)?.code;
    if (typeof code === 'string' && TRANSIENT_NETWORK_CODES.has(code)) return code;
  }
  return null;
}
