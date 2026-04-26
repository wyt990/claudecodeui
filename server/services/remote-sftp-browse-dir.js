/**
 * 远程 SFTP 列目录（供侧栏「打开项目」浏览路径）。
 * @module server/services/remote-sftp-browse-dir
 */

import path from 'path';
import { withRemoteSsh, getRemoteHomeDir } from '../remote/remote-ssh.js';
import { validateAndNormalizeRemoteProjectPath } from './remote-claude-open-project.js';

/**
 * @param {number} userId
 * @param {number} serverId
 * @param {string | undefined} rawPath 缺省或空则使用远程 `$HOME`
 * @returns {Promise<{ path: string, parent: string | null, entries: { name: string, isDirectory: boolean }[] }>}
 */
export async function listRemoteSftpDirectory(userId, serverId, rawPath) {
  return withRemoteSsh(userId, serverId, async ({ sftp, client }) => {
    let target;
    if (rawPath == null || (typeof rawPath === 'string' && !rawPath.trim())) {
      const home = await getRemoteHomeDir(client, userId, serverId);
      target = home;
    } else {
      target = validateAndNormalizeRemoteProjectPath(String(rawPath), 'browse');
    }

    const list = await new Promise((resolve, reject) => {
      sftp.readdir(target, (e, l) => {
        if (e) {
          reject(e);
        } else {
          resolve(l || []);
        }
      });
    });

    const entries = [];
    for (const de of list) {
      const name = de.filename;
      if (!name || name === '.' || name === '..') {
        continue;
      }
      const isDir = de.attrs && typeof de.attrs.isDirectory === 'function' && de.attrs.isDirectory();
      entries.push({ name, isDirectory: Boolean(isDir) });
    }
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    let parent = null;
    if (target === '/') {
      parent = null;
    } else {
      const parentAbs = path.posix.dirname(target);
      parent = parentAbs === target ? null : parentAbs;
    }

    return { path: target, parent, entries };
  });
}
