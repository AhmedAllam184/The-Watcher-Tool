import { admitSameSiteRequest } from '../../../src/localRequestGate.mjs';
import { isHostedMode } from '../../hosted/mode.js';

/**
 * Hosted mode sits behind its host's HTTPS proxy, which always adds
 * forwarding headers and terminates TLS. Those headers are expected there,
 * and every request has already passed the sign-in gate.
 */
function requestFacts(req) {
  const headers = req.headers || {};
  if (isHostedMode()) {
    const forwardedProto = String(headers['x-forwarded-proto'] || '')
      .split(',')[0]
      .trim()
      .toLowerCase();
    return {
      protocol: forwardedProto === 'http' ? 'http:' : 'https:',
      proxyHeaders: {},
    };
  }
  return {
    protocol: req.socket?.encrypted ? 'https:' : 'http:',
    proxyHeaders: headers,
  };
}

/**
 * Cross-site request gate for cost-bearing and log endpoints. Feeds the
 * request to the pure, unit-tested `admitSameSiteRequest` and answers 403
 * itself when the request is refused. Returns true when it has already
 * responded (the caller returns); false when the handler should continue.
 * Refuses cross-site browser requests (foreign or opaque Origin, a
 * Sec-Fetch-Site other than same-origin/none, or reverse-proxy headers) while
 * keeping loopback non-browser tools and the HOST=0.0.0.0 LAN opt-in working.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {boolean} True when a 403 was sent.
 */
export function admitSameSite(req, res) {
  const { protocol, proxyHeaders } = requestFacts(req);
  const verdict = admitSameSiteRequest({
    hostHeader: req.headers?.host,
    protocol,
    origin: req.headers?.origin,
    secFetchSite: req.headers?.['sec-fetch-site'],
    proxyHeaders,
  });
  if (verdict.ok) return false;
  res.statusCode = verdict.status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ error: verdict.error }));
  return true;
}

/**
 * Wrap a middleware handler so cross-site requests are refused with 403
 * before the handler runs. Loopback tools and same-origin browser requests
 * pass straight through.
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next?: Function) => unknown} handler
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next?: Function) => unknown}
 */
export function sameSiteGated(handler) {
  return (req, res, next) => {
    if (admitSameSite(req, res)) return undefined;
    return handler(req, res, next);
  };
}
