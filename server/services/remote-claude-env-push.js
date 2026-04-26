/**
 * 在远程项目根追加或创建 CLAUDE.md。
 * @module server/services/remote-claude-env-push
 */

import path from 'path';
import { withRemoteSsh } from '../remote/remote-ssh.js';
import { validateAndNormalizeRemoteProjectPath } from './remote-claude-open-project.js';

const LOG_PFX = '[remote-claude-env-push]';

/**
 * @param {import('ssh2').SFTPWrapper} sftp
 * @param {string} p
 * @param {string | Buffer} data
 * @returns {Promise<void>}
 */
function sftpWriteFile(sftp, p, data) {
  return new Promise((resolve, reject) => {
    sftp.writeFile(p, data, (e) => (e ? reject(e) : resolve()));
  });
}

/**
 * @param {import('ssh2').SFTPWrapper} sftp
 * @param {string} p
 * @returns {Promise<Buffer | null>}
 */
function sftpReadFile(sftp, p) {
  return new Promise((resolve, reject) => {
    sftp.readFile(p, (e, buf) => {
      if (e) {
        if (e.code === 2) {
          resolve(null);
          return;
        }
        reject(e);
        return;
      }
      resolve(buf);
    });
  });
}

/**
 * 在项目根追加或创建 CLAUDE.md（已存在则追加，否则新建）。
 * @param {number} userId
 * @param {number} serverId
 * @param {string} projectPathRaw
 * @param {string} blockText
 * @returns {Promise<{ claudePath: string, created: boolean, appended: boolean }>}
 */
export async function applyClaudeMdToRemoteProject(userId, serverId, projectPathRaw, blockText) {
  const projectPath = validateAndNormalizeRemoteProjectPath(String(projectPathRaw), 'claude-md');
  const text = (blockText == null ? '' : String(blockText));
  if (!text.trim()) {
    const e = new Error('Template body is empty');
    e.code = 'CLAUDE_MD_EMPTY';
    throw e;
  }
  const block = `<!-- cloudcli:remote-claude-md append ${new Date().toISOString()} -->\n${text.trim()}\n`;

  const result = await withRemoteSsh(userId, serverId, async ({ sftp }) => {
    const full = path.posix.join(projectPath, 'CLAUDE.md');
    const existing = await sftpReadFile(sftp, full);
    let next;
    let created;
    let appended;
    if (!existing || !existing.length) {
      next = block;
      created = true;
      appended = false;
    } else {
      const old = existing.toString('utf8');
      next = old.replace(/\s*$/, '') + '\n\n' + block;
      created = false;
      appended = true;
    }
    await sftpWriteFile(sftp, full, Buffer.from(next, 'utf8'));
    return { claudePath: full, created, appended };
  });
  console.log(
    `${LOG_PFX} claude.md userId=${userId} serverId=${serverId} path=${JSON.stringify(result.claudePath)} created=${result.created} appended=${result.appended}`,
  );
  return result;
}
