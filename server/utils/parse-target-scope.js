/**
 * Parse CloudCLI target scope from query or header (P0: routing only; remote data paths follow in P1).
 *
 * @module server/utils/parse-target-scope
 */

/**
 * @typedef {{ kind: 'local', targetKey: 'local' }} LocalTarget
 * @typedef {{ kind: 'remote', serverId: number, targetKey: string }} RemoteTarget
 * @typedef {{ kind: 'invalid', error: string }} InvalidTarget
 */

/**
 * @param {import('express').Request} req
 * @returns {LocalTarget | RemoteTarget | InvalidTarget}
 */
export function parseTargetScope(req) {
  const raw = (
    req.query.targetKey
    || req.headers['x-cloudcli-target']
    || 'local'
  ).toString().trim();

  if (!raw || raw === 'local') {
    return { kind: 'local', targetKey: 'local' };
  }

  const m = /^remote:(\d+)$/.exec(raw);
  if (!m) {
    return {
      kind: 'invalid',
      error: 'Invalid targetKey. Use "local" or "remote:<serverId>" (numeric id).',
    };
  }

  const serverId = parseInt(m[1], 10);
  if (!Number.isFinite(serverId) || serverId < 1) {
    return { kind: 'invalid', error: 'Invalid server id in targetKey.' };
  }

  return { kind: 'remote', serverId, targetKey: raw };
}
