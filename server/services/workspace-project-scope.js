/**
 * 将 HTTP 请求上的 CloudCLI 目标（local / remote:<id>）解析为项目工作区路径（本机绝对路径或远端 POSIX 根）。
 * @module server/services/workspace-project-scope
 */

import { parseTargetScope } from '../utils/parse-target-scope.js';
import { sshServersDb } from '../database/db.js';
import { extractProjectDirectory } from '../projects.js';
import { resolveRemoteClaudeProjectRoot } from './remote-project-files.js';

/**
 * @typedef {{ mode: 'local', projectPath: string }} LocalWorkspaceCtx
 * @typedef {{ mode: 'remote', userId: number, serverId: number, projectPath: string }} RemoteWorkspaceCtx
 * @typedef {LocalWorkspaceCtx | RemoteWorkspaceCtx} WorkspaceProjectCtx
 */

/**
 * @param {import('express').Request} req
 * @param {string} projectName
 * @returns {Promise<WorkspaceProjectCtx>}
 */
export async function resolveWorkspaceProject(req, projectName) {
  const pn = projectName != null && String(projectName).trim() !== '' ? String(projectName).trim() : '';
  if (!pn) {
    const e = new Error('Project name is required');
    /** @type {any} */ (e).httpStatus = 400;
    throw e;
  }

  const scope = parseTargetScope(req);
  if (scope.kind === 'invalid') {
    const e = new Error(scope.error);
    /** @type {any} */ (e).httpStatus = 400;
    throw e;
  }

  if (scope.kind === 'local') {
    const projectPath = await extractProjectDirectory(pn);
    return { mode: 'local', projectPath };
  }

  if (!sshServersDb.getServer(req.user.id, scope.serverId)) {
    const e = new Error('SSH server not found');
    /** @type {any} */ (e).httpStatus = 404;
    throw e;
  }

  const root = await resolveRemoteClaudeProjectRoot(req.user.id, scope.serverId, pn);
  if (!root) {
    const e = new Error(`Project "${pn}" does not exist on remote`);
    /** @type {any} */ (e).httpStatus = 404;
    throw e;
  }

  return { mode: 'remote', userId: req.user.id, serverId: scope.serverId, projectPath: root };
}
