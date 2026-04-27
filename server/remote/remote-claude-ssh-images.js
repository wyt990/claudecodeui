/**
 * 将前端传来的 data URL 图片写到远端项目目录下（与本地 claude-sdk handleImages 对齐），供 claudecode -p 从路径读图。
 * @module server/remote/remote-claude-ssh-images
 */

import path from 'path';
import { withSftpStream } from './remote-ssh.js';

const MAX_IMAGES = 5;
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * @param {import('ssh2').SFTPWrapper} sftp
 * @param {string} absPath POSIX 绝对路径
 * @returns {Promise<void>}
 */
function sftpStatsIsDirectory(st) {
  if (!st) return false;
  if (typeof st.isDirectory === 'function') {
    return st.isDirectory();
  }
  const mode = typeof st.mode === 'number' ? st.mode : 0;
  return (mode & 0o170000) === 0o040000;
}

/**
 * 逐级 mkdir；部分 SFTP 在目录已存在时返回 4（Failure）而非 11，需 stat 确认后再继续。
 * @param {import('ssh2').SFTPWrapper} sftp
 * @param {string} absPath
 * @returns {Promise<void>}
 */
async function mkdirpSftp(sftp, absPath) {
  const norm = path.posix.normalize(String(absPath || '').replace(/\\/g, '/'));
  if (!norm.startsWith('/')) {
    throw new Error('Remote image directory must be an absolute path');
  }
  const segments = norm.split('/').filter(Boolean);
  let cur = '';
  for (const seg of segments) {
    cur += `/${seg}`;
    await new Promise((resolve, reject) => {
      sftp.mkdir(cur, (err) => {
        if (!err) {
          resolve();
          return;
        }
        sftp.stat(cur, (stErr, st) => {
          if (!stErr && sftpStatsIsDirectory(st)) {
            resolve();
            return;
          }
          const c = typeof err.code === 'number' ? err.code : 0;
          const base = err.message || 'SFTP error';
          reject(new Error(`mkdir ${cur}: ${base} (code ${c})`));
        });
      });
    });
  }
}

/**
 * @param {string} command
 * @param {string[]} posixPaths
 * @returns {string}
 */
export function appendImagePathsToRemotePrompt(command, posixPaths) {
  if (!posixPaths || posixPaths.length === 0) {
    return String(command || '');
  }
  const imageNote = `\n\n[Images provided at the following paths:]\n${posixPaths.map((p, i) => `${i + 1}. ${p}`).join('\n')}`;
  const c = String(command || '');
  if (c.trim()) {
    return c + imageNote;
  }
  return c;
}

/**
 * @param {number} userId
 * @param {number} serverId
 * @param {import('ssh2').Client} client
 * @param {string} cwd 远端工程根（POSIX）
 * @param {Array<{ data?: string }>} images
 * @returns {Promise<{ paths: string[] }>}
 */
export async function uploadRemoteClaudeImages(userId, serverId, client, cwd, images) {
  const list = Array.isArray(images) ? images.slice(0, MAX_IMAGES) : [];
  if (list.length === 0) {
    return { paths: [] };
  }
  const safeCwd = String(cwd || '').replace(/\\/g, '/').trim();
  return withSftpStream(userId, serverId, client, async (sftp) => {
    const ts = Date.now();
    const dir = path.posix.join(safeCwd, '.tmp', 'images', String(ts));
    await mkdirpSftp(sftp, dir);
    const paths = [];
    let outIndex = 0;
    for (let index = 0; index < list.length; index++) {
      const image = list[index];
      const data = image?.data;
      if (typeof data !== 'string') {
        continue;
      }
      const m = data.match(/^data:([^;]+);base64,(.+)$/);
      if (!m) {
        continue;
      }
      const mimeType = m[1];
      const base64Data = m[2];
      let ext = (mimeType.split('/')[1] || 'png').replace(/[^a-zA-Z0-9.+-]/g, '');
      if (!ext) {
        ext = 'png';
      }
      const fp = path.posix.join(dir, `image_${outIndex}.${ext}`);
      const buf = Buffer.from(base64Data, 'base64');
      if (buf.length > MAX_BYTES) {
        throw new Error(`Image ${index + 1} exceeds ${MAX_BYTES} bytes`);
      }
      await new Promise((resolve, reject) => {
        sftp.writeFile(fp, buf, (e) => (e ? reject(e) : resolve()));
      });
      paths.push(fp);
      outIndex += 1;
    }
    if (paths.length === 0) {
      throw new Error('No valid images (expected data:image/...;base64,... entries)');
    }
    return { paths };
  });
}
