/**
 * 在远端目录下执行一条命令（argv 列表），不强制 exit 0；用于 TaskMaster / npx 等。
 * @module server/services/remote-argv-exec
 */

import { withRemoteSsh, execBashTextResult } from '../remote/remote-ssh.js';
import { bashSingleQuote } from '../remote/remote-ssh-helpers.js';

const DEFAULT_TIMEOUT_MS = Math.max(120_000, Number(process.env.CLOUDCLI_REMOTE_ARGV_EXEC_TIMEOUT_MS || 600_000) || 600_000);

/**
 * @param {number} userId
 * @param {number} serverId
 * @param {string} cwdPosix
 * @param {string[]} argv 完整 argv（含可执行名，如 `task-master` / `npx`）
 * @param {number} [timeoutMs]
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, timedOut: boolean }>}
 */
export async function remoteArgvExecResult(userId, serverId, cwdPosix, argv, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const quoted = argv.map((a) => bashSingleQuote(String(a))).join(' ');
  const script = `cd ${bashSingleQuote(cwdPosix)} && ${quoted}`;
  return withRemoteSsh(userId, serverId, async ({ client }) =>
    execBashTextResult(userId, serverId, client, script, timeoutMs, true),
  );
}

/**
 * 在远端 `cwdPosix` 下执行一段 **bash 语句**（已拼进 `cd … &&`，不要再写嵌套 `bash -lc`）。
 * 外层为 `bash -lic`，与 Web SSH 终端常见 PATH（如宝塔在 `~/.bashrc` 追加的 node）一致；
 * 若用 `remoteArgvExecResult(..., ['bash','-lc', ...])` 会形成「外 -lic 包内 -lc」，内层非交互登录可能读不到 `.bashrc`，导致 `command -v` 与手动 SSH 不一致。
 *
 * @param {number} userId
 * @param {number} serverId
 * @param {string} cwdPosix
 * @param {string} bashBody 仅可信服务端拼接的片段，勿直接拼用户输入
 * @param {number} [timeoutMs]
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, timedOut: boolean }>}
 */
export async function remoteBashLineResult(userId, serverId, cwdPosix, bashBody, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const body = String(bashBody || '').trim();
  if (!body) {
    return { code: -1, stdout: '', stderr: 'empty bashBody', timedOut: false };
  }
  const script = `cd ${bashSingleQuote(cwdPosix)} && ${body}`;
  return withRemoteSsh(userId, serverId, async ({ client }) =>
    execBashTextResult(userId, serverId, client, script, timeoutMs, true),
  );
}
