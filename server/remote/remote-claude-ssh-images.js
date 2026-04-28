/**
 * 将前端传来的 data URL 图片写到远端项目目录下（与本地 claude-sdk handleImages 对齐），供 claudecode -p 从路径读图。
 * @module server/remote/remote-claude-ssh-images
 */

import path from 'path';
import crypto from 'node:crypto';
import { withSftpStream } from './remote-ssh.js';
import { buildClaudeImagePathsSuffix } from '../utils/claude-image-prompt-note.js';
import { chatImagesDebugLog } from '../providers/claude/chat-images-debug.js';

const MAX_IMAGES = 5;
const MAX_BYTES = 5 * 1024 * 1024;
/** stream-json stdin 含 base64 图块，上限略高于单图 API 限制 */
const MAX_JSONL_BYTES = 12 * 1024 * 1024;

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
/**
 * @param {import('ssh2').SFTPWrapper} sftp
 * @param {string} absPath
 * @returns {Promise<Buffer>}
 */
function sftpReadFileBuffer(sftp, absPath) {
  return new Promise((resolve, reject) => {
    sftp.readFile(absPath, (e, buf) => {
      if (e) reject(e);
      else resolve(buf);
    });
  });
}

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
  const imageNote = buildClaudeImagePathsSuffix(posixPaths);
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
    const batchId = crypto.randomBytes(8).toString('hex');
    const dir = path.posix.join(safeCwd, '.tmp', 'images', `${ts}-${batchId}`);
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
      const fp = path.posix.join(dir, `ccli-img-${batchId}-${outIndex}.${ext}`);
      const buf = Buffer.from(base64Data, 'base64');
      if (buf.length > MAX_BYTES) {
        throw new Error(`Image ${index + 1} exceeds ${MAX_BYTES} bytes`);
      }
      await new Promise((resolve, reject) => {
        sftp.writeFile(fp, buf, (e) => (e ? reject(e) : resolve()));
      });
      const back = await sftpReadFileBuffer(sftp, fp);
      if (!Buffer.isBuffer(back) || back.length !== buf.length || !back.equals(buf)) {
        throw new Error(`Remote image verify failed after write: ${fp} (size ${back?.length ?? 0} vs ${buf.length})`);
      }
      paths.push(fp);
      outIndex += 1;
    }
    if (paths.length === 0) {
      throw new Error('No valid images (expected data:image/...;base64,... entries)');
    }
    return { paths };
  });
}

/**
 * 将单行 NDJSON（SDK user 消息，含多模态 content）写到远端，供 `claudecode --input-format=stream-json` 从 stdin 读取。
 * @param {number} userId
 * @param {number} serverId
 * @param {import('ssh2').Client} client
 * @param {string} cwd
 * @param {string} jsonlUtf8 须含末尾 \\n
 * @returns {Promise<{ path: string }>}
 */
export async function uploadRemoteClaudeStdinJsonl(userId, serverId, client, cwd, jsonlUtf8) {
  const safeCwd = String(cwd || '').replace(/\\/g, '/').trim();
  const buf = Buffer.from(jsonlUtf8, 'utf8');
  if (buf.length > MAX_JSONL_BYTES) {
    throw new Error(`Multimodal stdin exceeds ${MAX_JSONL_BYTES} bytes`);
  }
  return withSftpStream(userId, serverId, client, async (sftp) => {
    const ts = Date.now();
    const batchId = crypto.randomBytes(8).toString('hex');
    const dir = path.posix.join(safeCwd, '.tmp', 'ccli-stream-json', `${ts}-${batchId}`);
    await mkdirpSftp(sftp, dir);
    const fp = path.posix.join(dir, 'stdin.jsonl');
    await new Promise((resolve, reject) => {
      sftp.writeFile(fp, buf, (e) => (e ? reject(e) : resolve()));
    });
    const back = await sftpReadFileBuffer(sftp, fp);
    if (!Buffer.isBuffer(back) || back.length !== buf.length || !back.equals(buf)) {
      throw new Error(`Remote stdin JSONL verify failed: ${fp}`);
    }
    chatImagesDebugLog('[remote stdin.jsonl] uploaded', {
      path: fp,
      bytes: buf.length,
      linePreview: jsonlUtf8.slice(0, 120).replace(/"data":"[^"]{40,}"/, '"data":"<redacted>"'),
    });
    return { path: fp };
  });
}
