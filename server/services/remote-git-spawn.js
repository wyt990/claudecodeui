/**
 * 在远端 SSH 工作区内执行 `git`，行为对齐本机 `spawnAsync('git', …, { cwd })`（成功返回 stdout，失败 throw）。
 * @module server/services/remote-git-spawn
 */

import { withRemoteSsh, execBashTextResult } from '../remote/remote-ssh.js';
import { bashSingleQuote } from '../remote/remote-ssh-helpers.js';

const GIT_TIMEOUT_MS = Math.max(60_000, Number(process.env.CLOUDCLI_REMOTE_GIT_TIMEOUT_MS || 120_000) || 120_000);

/**
 * @param {number} userId
 * @param {number} serverId
 * @param {string} cwdPosix
 * @param {string[]} gitArgs argv after `git`
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
export async function remoteGitSpawnAsync(userId, serverId, cwdPosix, gitArgs) {
  const quoted = gitArgs.map((a) => bashSingleQuote(String(a))).join(' ');
  const script = `cd ${bashSingleQuote(cwdPosix)} && git ${quoted}`;
  return withRemoteSsh(userId, serverId, async ({ client }) => {
    const r = await execBashTextResult(userId, serverId, client, script, GIT_TIMEOUT_MS, true);
    const { code, stdout, stderr } = r;
    if (code === 0) {
      return { stdout: stdout || '', stderr: stderr || '' };
    }
    const error = new Error(`Command failed: git ${gitArgs.join(' ')}`);
    /** @type {any} */ (error).code = code;
    /** @type {any} */ (error).stdout = stdout || '';
    /** @type {any} */ (error).stderr = stderr || '';
    throw error;
  });
}
