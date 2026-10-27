/**
 * Upstream failure reasons for the conflict proxy. A reason is a short human
 * sentence that never carries a URL, a query string or a credential: it is
 * returned to the browser as `reason` and logged verbatim.
 */

export class UpstreamFailure extends Error {
  /** @param {string} reason - the short reason shown to the viewer. */
  constructor(reason) {
    super(reason);
    this.name = 'UpstreamFailure';
    this.reason = reason;
  }
}

/** Reason for a non-OK HTTP status from an upstream named `label`. */
export function httpFailure(label, status) {
  if (status === 429)
    return new UpstreamFailure(`${label} HTTP 429 (rate limited)`);
  return new UpstreamFailure(`${label} HTTP ${status}`);
}

/**
 * Classify any error from a fetch, body read or parse into an UpstreamFailure.
 * Network errors (fetch throws a TypeError) and timeouts are named as such; the
 * original message is never used, since it can echo the request URL.
 */
export function failureFrom(err, label) {
  if (err instanceof UpstreamFailure) return err;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError')
    return new UpstreamFailure(`${label} timed out`);
  if (err instanceof TypeError)
    return new UpstreamFailure(`${label} unreachable (network/DNS)`);
  if (err?.code === 'RESPONSE_TOO_LARGE')
    return new UpstreamFailure(`${label} response too large`);
  if (err?.code === 'BAD_BODY')
    return new UpstreamFailure(`${label} returned an unexpected body`);
  return new UpstreamFailure(`${label} request failed`);
}
