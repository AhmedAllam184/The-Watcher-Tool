/**
 * Whether the server was started in hosted mode (`GEV_HOSTED=1`): on a public
 * web host for one signed-in operator. See server/hosted/auth.js.
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
export function isHostedMode(env = process.env) {
  return String(env.GEV_HOSTED ?? '').trim() === '1';
}
