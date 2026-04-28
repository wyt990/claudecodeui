/**
 * 远程 SSH：从 JSONL 用户正文中的路径说明读取图片，填充 NormalizedMessage.images（data URL）。
 * @module server/remote/remote-claude-user-images-enrich
 */

import path from 'node:path';
import { extractClaudeImagePathsFromContent } from '../providers/claude/enrich-user-images-from-disk.js';
import { chatImagesDebugLog, isChatImagesDebugEnabled } from '../providers/claude/chat-images-debug.js';

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

const EXT_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
};

/**
 * @param {string} p
 */
function posixNorm(p) {
  return path.posix.normalize(String(p || '').replace(/\\/g, '/'));
}

/**
 * @param {string} filePath
 * @param {string} rootPath
 */
function isPosixPathUnderRoot(filePath, rootPath) {
  const root = posixNorm(rootPath).replace(/\/+$/, '') || '/';
  const file = posixNorm(filePath);
  if (file === root) return false;
  const prefix = root === '/' ? '/' : `${root}/`;
  return file.startsWith(prefix);
}

/**
 * @param {import('ssh2').SFTPWrapper} sftp
 * @param {string} abspath
 * @returns {Promise<Buffer>}
 */
function sftpReadFileBuffer(sftp, abspath) {
  return new Promise((resolve, reject) => {
    sftp.readFile(abspath, (e, buf) => {
      if (e) reject(e);
      else resolve(buf);
    });
  });
}

/**
 * @param {import('ssh2').SFTPWrapper} sftp
 * @param {string} abspath
 * @returns {Promise<any>}
 */
function sftpStat(sftp, abspath) {
  return new Promise((resolve, reject) => {
    sftp.stat(abspath, (e, st) => {
      if (e) reject(e);
      else resolve(st);
    });
  });
}

/**
 * @param {any} st
 */
function sftpEntryIsFile(st) {
  if (st && typeof st.isFile === 'function') return st.isFile();
  const mode = /** @type {any} */ (st).mode;
  if (typeof mode === 'number') return (mode & 0o170000) === 0o100000;
  return false;
}

/**
 * @param {Buffer} buf
 * @param {string} posixPath
 */
function bufferToDataUrl(buf, posixPath) {
  const ext = path.posix.extname(posixPath).slice(1).toLowerCase();
  const mime = EXT_MIME[ext] || 'application/octet-stream';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/**
 * @param {import('ssh2').SFTPWrapper} sftp
 * @param {any[]} messages
 * @param {string} posixProjectRoot 远端工程根目录（绝对 POSIX 路径）
 * @returns {Promise<any[]>}
 */
export async function enrichClaudeUserImagesFromRemoteSftp(sftp, messages, posixProjectRoot) {
  const root = posixNorm(posixProjectRoot).replace(/\/+$/, '') || '/';
  if (!root.startsWith('/')) {
    if (isChatImagesDebugEnabled()) {
      chatImagesDebugLog('remote enrich skip: root not absolute', { root });
    }
    return messages;
  }

  const out = [];
  let enrichedCount = 0;
  for (const msg of messages) {
    if (msg.kind !== 'text' || msg.role !== 'user') {
      out.push(msg);
      continue;
    }
    if (Array.isArray(msg.images) && msg.images.length > 0) {
      out.push(msg);
      continue;
    }
    const paths = extractClaudeImagePathsFromContent(msg.content || '');
    if (paths.length === 0) {
      out.push(msg);
      continue;
    }
    if (isChatImagesDebugEnabled()) {
      chatImagesDebugLog('remote enrich: user msg paths', {
        id: msg.id,
        pathCount: paths.length,
        pathsPreview: paths.map((p) => String(p).slice(0, 120)),
      });
    }
    const dataUrls = [];
    for (const p of paths) {
      const abs = posixNorm(p);
      if (!isPosixPathUnderRoot(abs, root)) {
        if (isChatImagesDebugEnabled()) {
          chatImagesDebugLog('remote enrich: path not under root', { abs, root });
        }
        continue;
      }
      try {
        const st = await sftpStat(sftp, abs);
        if (!sftpEntryIsFile(st) || /** @type {any} */ (st).size > MAX_IMAGE_BYTES) {
          throw new Error('skip');
        }
        const buf = await sftpReadFileBuffer(sftp, abs);
        if (!Buffer.isBuffer(buf) || buf.length > MAX_IMAGE_BYTES) {
          throw new Error('skip');
        }
        dataUrls.push(bufferToDataUrl(buf, abs));
        if (isChatImagesDebugEnabled()) {
          chatImagesDebugLog('remote enrich: read ok', { abs, bytes: buf.length });
        }
      } catch (e) {
        if (isChatImagesDebugEnabled()) {
          chatImagesDebugLog('remote enrich: read fail', {
            abs,
            err: e && /** @type {any} */ (e).message ? /** @type {any} */ (e).message : String(e),
          });
        }
      }
    }
    if (dataUrls.length === 0) {
      out.push(msg);
    } else {
      enrichedCount += 1;
      out.push({ ...msg, images: dataUrls });
    }
  }
  if (isChatImagesDebugEnabled()) {
    chatImagesDebugLog('remote enrich done', { enrichedUserMessages: enrichedCount, root });
  }
  return out;
}
