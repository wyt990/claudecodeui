/**
 * 从 JSONL 用户正文里的「Images provided at the following paths」解析路径，
 * 在本地项目根下可读时读入为 data URL，供刷新后仍显示缩略图。
 * @module providers/claude/enrich-user-images-from-disk
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { chatImagesDebugLog, isChatImagesDebugEnabled } from './chat-images-debug.js';

const IMAGE_PATHS_BLOCK = /\n\n\[Images provided at the following paths:\]\n([\s\S]*)$/;

const EXT_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
};

/**
 * @param {string} content
 * @returns {string[]}
 */
export function extractClaudeImagePathsFromContent(content) {
  const m = String(content || '').match(IMAGE_PATHS_BLOCK);
  if (!m) return [];
  const block = m[1] || '';
  const paths = [];
  for (const line of block.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const n = /^\d+\.\s+(.+)$/.exec(t);
    if (n) paths.push(n[1].trim());
  }
  return paths;
}

/**
 * @param {string} absFile
 * @param {string} absProjectRoot
 * @returns {boolean}
 */
function isPathUnderProjectRoot(absFile, absProjectRoot) {
  const root = path.resolve(absProjectRoot);
  const file = path.resolve(absFile);
  if (file === root) return false;
  const rel = path.relative(root, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * @param {string} absPath
 * @returns {Promise<string>}
 */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

async function filePathToDataUrl(absPath) {
  const st = await fs.stat(absPath);
  if (!st.isFile() || st.size > MAX_IMAGE_BYTES) {
    throw new Error('skip');
  }
  const buf = await fs.readFile(absPath);
  const ext = path.extname(absPath).slice(1).toLowerCase();
  const mime = EXT_MIME[ext] || 'application/octet-stream';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/**
 * @param {import('../types.js').NormalizedMessage[]} messages
 * @param {string} projectPath - 绝对路径，与 API query 一致
 * @returns {Promise<import('../types.js').NormalizedMessage[]>}
 */
export async function enrichClaudeUserImagesFromDisk(messages, projectPath) {
  if (!projectPath || !Array.isArray(messages) || messages.length === 0) {
    if (isChatImagesDebugEnabled()) {
      chatImagesDebugLog('enrich skip: empty', {
        hasProjectPath: Boolean(projectPath),
        msgLen: Array.isArray(messages) ? messages.length : -1,
      });
    }
    return messages;
  }
  const root = path.resolve(projectPath);
  if (isChatImagesDebugEnabled()) {
    chatImagesDebugLog('enrich start', { projectRoot: root, messageCount: messages.length });
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
      chatImagesDebugLog('user msg has path note', {
        id: msg.id,
        pathCount: paths.length,
        pathsPreview: paths.map((p) => String(p).slice(0, 120)),
        contentHasNote: /\n\n\[Images provided at the following paths:\]/.test(String(msg.content || '')),
      });
    }
    const dataUrls = [];
    for (const p of paths) {
      const abs = path.resolve(p);
      const under = isPathUnderProjectRoot(abs, root);
      if (!under) {
        if (isChatImagesDebugEnabled()) {
          chatImagesDebugLog('path rejected (not under projectRoot)', { abs, root });
        }
        continue;
      }
      try {
        dataUrls.push(await filePathToDataUrl(abs));
        if (isChatImagesDebugEnabled()) {
          chatImagesDebugLog('read ok', { abs });
        }
      } catch (e) {
        if (isChatImagesDebugEnabled()) {
          chatImagesDebugLog('read fail', { abs, err: e && e.message ? e.message : String(e) });
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
    chatImagesDebugLog('enrich done', { enrichedUserMessages: enrichedCount });
  }
  return out;
}
