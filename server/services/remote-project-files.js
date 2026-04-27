/**
 * 远程 SSH 工作区：项目根路径解析与 SFTP 文件树 / 读文件（与本地 extractProjectDirectory + fs 对齐用途）。
 * @module server/services/remote-project-files
 */

import path from 'path';
import fsPromises from 'node:fs/promises';
import { withRemoteSsh } from '../remote/remote-ssh.js';
import { inferRemoteProjectCwdFromClaudeProjectDir } from '../remote/remote-claude-data.js';
import { validateAndNormalizeRemoteProjectPath } from './remote-claude-open-project.js';

const SKIP_NAMES = new Set(['node_modules', 'dist', 'build', '.git', '.svn', '.hg']);

/**
 * @param {number} perm
 * @returns {string}
 */
function permToRwx(perm) {
  const r = perm & 4 ? 'r' : '-';
  const w = perm & 2 ? 'w' : '-';
  const x = perm & 1 ? 'x' : '-';
  return r + w + x;
}

/**
 * @param {import('ssh2').SFTPWrapper} sftp
 * @param {string} abspath
 * @returns {Promise<import('ssh2').sftp.Stats>}
 */
function sftpStat(sftp, abspath) {
  return new Promise((resolve, reject) => {
    sftp.stat(abspath, (e, st) => {
      if (e) {
        reject(e);
      } else {
        resolve(st);
      }
    });
  });
}

/**
 * @param {import('ssh2').sftp.Stats | import('fs').Stats} st
 * @returns {number}
 */
function mtimeToMs(st) {
  const t = /** @type {any} */ (st).mtime;
  if (typeof /** @type {any} */ (st).mtimeMs === 'number') {
    return /** @type {any} */ (st).mtimeMs;
  }
  if (t == null) {
    return 0;
  }
  if (t instanceof Date) {
    return t.getTime();
  }
  if (typeof t === 'number') {
    return t < 1e12 ? t * 1000 : t;
  }
  return 0;
}

/**
 * @param {string} root
 * @param {string} candidate
 * @returns {boolean}
 */
function posixIsUnderRoot(root, candidate) {
  const r = root === '/' ? '/' : root.replace(/\/+$/, '');
  const c = candidate.replace(/\/+$/, '') || '/';
  if (c === r) {
    return true;
  }
  return c.startsWith(`${r}/`);
}

/**
 * @param {string} projectRootPosix
 * @param {string} filePathRaw
 * @returns {string | null} 归一化后的绝对路径，若越权则 null
 */
export function resolvePathUnderRemoteProjectRoot(projectRootPosix, filePathRaw) {
  if (filePathRaw == null || typeof filePathRaw !== 'string') {
    return null;
  }
  const trimmed = filePathRaw.trim();
  if (!trimmed) {
    return null;
  }
  let candidate;
  if (trimmed.startsWith('/')) {
    try {
      candidate = validateAndNormalizeRemoteProjectPath(trimmed, 'file');
    } catch {
      return null;
    }
  } else {
    try {
      candidate = validateAndNormalizeRemoteProjectPath(
        path.posix.join(projectRootPosix, trimmed),
        'file',
      );
    } catch {
      return null;
    }
  }
  if (!posixIsUnderRoot(projectRootPosix, candidate)) {
    return null;
  }
  return candidate;
}

/**
 * @param {number} userId
 * @param {number} serverId
 * @param {string} projectName  ~/.claude/projects 下目录名（与列表 API 的 name 一致）
 * @returns {Promise<string | null>} 远端项目根绝对路径（POSIX）
 */
export async function resolveRemoteClaudeProjectRoot(userId, serverId, projectName) {
  const pn = projectName != null && String(projectName).trim() !== '' ? String(projectName).trim() : '';
  if (!pn) {
    console.log('[remote-project-files resolveRoot] empty projectName');
    return null;
  }
  return withRemoteSsh(userId, serverId, async ({ sftp, home }) => {
    const pdir = path.posix.join(home, '.claude', 'projects', pn);
    console.log('[remote-project-files resolveRoot] start', {
      userId,
      serverId,
      projectName: pn,
      home,
      pdir,
    });
    try {
      await sftpStat(sftp, pdir);
    } catch (stErr) {
      console.log('[remote-project-files resolveRoot] sftp stat pdir failed', {
        pdir,
        code: /** @type {any} */ (stErr).code,
        message: stErr && /** @type {any} */ (stErr).message,
      });
      return null;
    }
    let raw;
    try {
      raw = await inferRemoteProjectCwdFromClaudeProjectDir(sftp, pdir, pn);
    } catch (inferErr) {
      console.log('[remote-project-files resolveRoot] infer threw', {
        message: inferErr && /** @type {any} */ (inferErr).message,
        stack: inferErr && /** @type {any} */ (inferErr).stack,
      });
      return null;
    }
    if (raw == null || typeof raw !== 'string' || !raw.trim()) {
      console.log('[remote-project-files resolveRoot] infer returned empty', { raw });
      return null;
    }
    try {
      const normalized = validateAndNormalizeRemoteProjectPath(raw, 'project-root');
      console.log('[remote-project-files resolveRoot] ok', { raw, normalized });
      return normalized;
    } catch (valErr) {
      console.log('[remote-project-files resolveRoot] validate failed', {
        raw,
        message: valErr && /** @type {any} */ (valErr).message,
        code: /** @type {any} */ (valErr).code,
      });
      return null;
    }
  });
}

/**
 * @param {import('ssh2').SFTPWrapper} sftp
 * @param {string} rootPosix
 * @param {string} dirPosix
 * @param {number} maxDepth
 * @param {number} currentDepth
 * @returns {Promise<any[]>}
 */
async function readDirRecursive(sftp, rootPosix, dirPosix, maxDepth, currentDepth) {
  const items = [];
  const list = await new Promise((resolve, reject) => {
    sftp.readdir(dirPosix, (e, l) => {
      if (e) {
        reject(e);
      } else {
        resolve(l || []);
      }
    });
  });

  for (const de of list) {
    const name = de.filename;
    if (!name || name === '.' || name === '..') {
      continue;
    }
    if (SKIP_NAMES.has(name)) {
      continue;
    }

    const itemPath = path.posix.join(dirPosix, name);
    if (!posixIsUnderRoot(rootPosix, itemPath)) {
      continue;
    }

    const isDir = de.attrs && typeof de.attrs.isDirectory === 'function' && de.attrs.isDirectory();
    /** @type {any} */
    const item = {
      name,
      path: itemPath,
      type: isDir ? 'directory' : 'file',
    };

    try {
      const st = await sftpStat(sftp, itemPath);
      item.size = typeof st.size === 'number' ? st.size : 0;
      const ms = mtimeToMs(st);
      item.modified = ms ? new Date(ms).toISOString() : null;
      const mode = typeof st.mode === 'number' ? st.mode : 0;
      const ownerPerm = (mode >> 6) & 7;
      const groupPerm = (mode >> 3) & 7;
      const otherPerm = mode & 7;
      item.permissions = ownerPerm.toString() + groupPerm.toString() + otherPerm.toString();
      item.permissionsRwx = permToRwx(ownerPerm) + permToRwx(groupPerm) + permToRwx(otherPerm);
    } catch {
      item.size = 0;
      item.modified = null;
      item.permissions = '000';
      item.permissionsRwx = '---------';
    }

    if (isDir && currentDepth < maxDepth) {
      try {
        item.children = await readDirRecursive(sftp, rootPosix, itemPath, maxDepth, currentDepth + 1);
      } catch {
        item.children = [];
      }
    }

    items.push(item);
  }

  return items.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

/**
 * @param {number} userId
 * @param {number} serverId
 * @param {string} rootPosix
 * @param {number} [maxDepth]
 * @returns {Promise<any[]>}
 */
export async function getRemoteProjectFileTree(userId, serverId, rootPosix, maxDepth = 10) {
  return withRemoteSsh(userId, serverId, async ({ sftp }) => {
    await sftpStat(sftp, rootPosix);
    return readDirRecursive(sftp, rootPosix, rootPosix, maxDepth, 0);
  });
}

/**
 * @param {number} userId
 * @param {number} serverId
 * @param {string} absPosixPath
 * @returns {Promise<Buffer>}
 */
export async function readRemoteFileBytes(userId, serverId, absPosixPath) {
  return withRemoteSsh(userId, serverId, async ({ sftp }) => {
    return new Promise((resolve, reject) => {
      sftp.readFile(absPosixPath, (err, buf) => {
        if (err) {
          reject(err);
        } else {
          resolve(buf);
        }
      });
    });
  });
}

/**
 * @param {number} userId
 * @param {number} serverId
 * @param {string} projectName
 * @param {string} filePathQuery
 * @returns {Promise<{ projectRoot: string, resolved: string }>}
 */
export async function resolveRemoteReadablePath(userId, serverId, projectName, filePathQuery) {
  const projectRoot = await resolveRemoteClaudeProjectRoot(userId, serverId, projectName);
  if (!projectRoot) {
    const e = new Error('Remote project not found');
    /** @type {any} */ (e).code = 'REMOTE_PROJECT_NOT_FOUND';
    throw e;
  }
  const resolved = resolvePathUnderRemoteProjectRoot(projectRoot, filePathQuery);
  if (!resolved) {
    const e = new Error('Path must be under project root');
    /** @type {any} */ (e).code = 'REMOTE_PATH_ESCAPE';
    throw e;
  }
  return { projectRoot, resolved };
}

/**
 * 解析项目内目录（空 / `.` / `./` 表示项目根）。
 * @param {string} projectRootPosix
 * @param {string} dirPathRaw
 * @returns {string | null}
 */
export function resolveRemoteDirectoryInProject(projectRootPosix, dirPathRaw) {
  const t = dirPathRaw == null ? '' : String(dirPathRaw).trim();
  if (!t || t === '.' || t === './') {
    return projectRootPosix;
  }
  return resolvePathUnderRemoteProjectRoot(projectRootPosix, t);
}

/**
 * @param {import('ssh2').SFTPWrapper} sftp
 * @param {string} p
 * @param {string | Buffer} data
 * @returns {Promise<void>}
 */
function sftpWriteFilePromise(sftp, p, data) {
  return new Promise((resolve, reject) => {
    sftp.writeFile(p, data, (e) => (e ? reject(e) : resolve()));
  });
}

/**
 * @param {import('ssh2').SFTPWrapper} sftp
 * @param {string} oldPath
 * @param {string} newPath
 * @returns {Promise<void>}
 */
function sftpRenamePromise(sftp, oldPath, newPath) {
  return new Promise((resolve, reject) => {
    sftp.rename(oldPath, newPath, (e) => (e ? reject(e) : resolve()));
  });
}

/**
 * @param {import('ssh2').SFTPWrapper} sftp
 * @param {string} p
 * @returns {Promise<void>}
 */
function sftpUnlinkPromise(sftp, p) {
  return new Promise((resolve, reject) => {
    sftp.unlink(p, (e) => (e ? reject(e) : resolve()));
  });
}

/**
 * @param {import('ssh2').SFTPWrapper} sftp
 * @param {string} p
 * @returns {Promise<void>}
 */
function sftpRmdirPromise(sftp, p) {
  return new Promise((resolve, reject) => {
    sftp.rmdir(p, (e) => (e ? reject(e) : resolve()));
  });
}

/**
 * @param {import('ssh2').sftp.Stats} st
 * @returns {boolean}
 */
function statIsDir(st) {
  return typeof st.isDirectory === 'function' && st.isDirectory();
}

/**
 * 逐级创建目录（已存在且为目录则跳过）。
 * @param {import('ssh2').SFTPWrapper} sftp
 * @param {string} dirPath
 * @returns {Promise<void>}
 */
async function mkdirRecursiveSftp(sftp, dirPath) {
  const normalized = validateAndNormalizeRemoteProjectPath(dirPath, 'mkdir');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) {
    return;
  }
  let acc = `/${parts[0]}`;
  for (let i = 0; i < parts.length; i += 1) {
    if (i > 0) {
      acc = path.posix.join(acc, parts[i]);
    }
    await new Promise((resolve, reject) => {
      sftp.mkdir(acc, (err) => {
        if (!err) {
          resolve();
          return;
        }
        sftp.stat(acc, (e2, st) => {
          if (!e2 && statIsDir(st)) {
            resolve();
            return;
          }
          reject(err);
        });
      });
    });
  }
}

/**
 * @param {import('ssh2').SFTPWrapper} sftp
 * @param {string} targetPath
 * @returns {Promise<void>}
 */
async function rmRecursiveSftp(sftp, targetPath) {
  let st;
  try {
    st = await sftpStat(sftp, targetPath);
  } catch (e) {
    if (/** @type {any} */ (e).code === 2) {
      return;
    }
    throw e;
  }
  if (statIsDir(st)) {
    const list = await new Promise((resolve, reject) => {
      sftp.readdir(targetPath, (e, l) => (e ? reject(e) : resolve(l || [])));
    });
    for (const de of list) {
      const n = de.filename;
      if (!n || n === '.' || n === '..') {
        continue;
      }
      const child = path.posix.join(targetPath, n);
      await rmRecursiveSftp(sftp, child);
    }
    await sftpRmdirPromise(sftp, targetPath);
  } else {
    await sftpUnlinkPromise(sftp, targetPath);
  }
}

/**
 * 上传目标：位于 `resolvedTargetDir` 下的相对路径，且必须在项目根内。
 * @param {string} projectRootPosix
 * @param {string} resolvedTargetDir
 * @param {string} relRaw 相对 `resolvedTargetDir` 的路径（可含子目录）
 * @returns {string | null}
 */
export function resolveUploadDestAbs(projectRootPosix, resolvedTargetDir, relRaw) {
  const parts = String(relRaw || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p && p !== '.' && p !== '..');
  if (parts.length === 0) {
    return null;
  }
  const sub = parts.join('/');
  let candidate;
  try {
    candidate = validateAndNormalizeRemoteProjectPath(
      path.posix.join(resolvedTargetDir, sub),
      'upload',
    );
  } catch {
    return null;
  }
  if (!posixIsUnderRoot(projectRootPosix, candidate)) {
    return null;
  }
  const td = resolvedTargetDir === '/' ? '/' : resolvedTargetDir.replace(/\/+$/, '');
  const cd = candidate === '/' ? '/' : candidate.replace(/\/+$/, '') || '/';
  if (cd !== td && !cd.startsWith(`${td}/`)) {
    return null;
  }
  return candidate;
}

/**
 * @param {number} userId
 * @param {number} serverId
 * @param {string} resolvedAbsUtf8Path
 * @param {string} content
 * @returns {Promise<void>}
 */
export async function writeRemoteUtf8File(userId, serverId, resolvedAbsUtf8Path, content) {
  const buf = Buffer.from(content == null ? '' : String(content), 'utf8');
  return withRemoteSsh(userId, serverId, async ({ sftp }) => {
    const parent = path.posix.dirname(resolvedAbsUtf8Path);
    if (parent && parent !== '/' && parent !== resolvedAbsUtf8Path) {
      await mkdirRecursiveSftp(sftp, parent);
    }
    await sftpWriteFilePromise(sftp, resolvedAbsUtf8Path, buf);
  });
}

/**
 * @param {number} userId
 * @param {number} serverId
 * @param {string} projectRootPosix
 * @param {string} resolvedFullPath
 * @param {'file' | 'directory'} type
 * @returns {Promise<void>}
 */
export async function remoteCreateEntry(userId, serverId, projectRootPosix, resolvedFullPath, type) {
  if (!posixIsUnderRoot(projectRootPosix, resolvedFullPath)) {
    const e = new Error('Path must be under project root');
    /** @type {any} */ (e).code = 'REMOTE_PATH_ESCAPE';
    throw e;
  }
  const normRoot = projectRootPosix === '/' ? '/' : projectRootPosix.replace(/\/+$/, '');
  const normTarget = resolvedFullPath.replace(/\/+$/, '') || '/';
  if (normTarget === normRoot) {
    const e = new Error('Invalid path');
    /** @type {any} */ (e).code = 'REMOTE_INVALID_PATH';
    throw e;
  }

  return withRemoteSsh(userId, serverId, async ({ sftp }) => {
    try {
      await sftpStat(sftp, resolvedFullPath);
      const e = new Error('Already exists');
      /** @type {any} */ (e).code = 'EEXIST';
      throw e;
    } catch (ex) {
      if (/** @type {any} */ (ex).code === 'EEXIST') {
        throw ex;
      }
      if (/** @type {any} */ (ex).code !== 2 && /** @type {any} */ (ex).code !== 'ENOENT') {
        throw ex;
      }
    }
    if (type === 'directory') {
      await new Promise((resolve, reject) => {
        sftp.mkdir(resolvedFullPath, (e) => (e ? reject(e) : resolve()));
      });
      return;
    }
    const parentDir = path.posix.dirname(resolvedFullPath);
    if (parentDir && parentDir !== '/' && parentDir !== resolvedFullPath) {
      await mkdirRecursiveSftp(sftp, parentDir);
    }
    await sftpWriteFilePromise(sftp, resolvedFullPath, Buffer.alloc(0));
  });
}

/**
 * @param {number} userId
 * @param {number} serverId
 * @param {string} resolvedOldPath
 * @param {string} resolvedNewPath
 * @param {string} projectRootPosix
 * @returns {Promise<void>}
 */
export async function remoteRenameWithinProject(
  userId,
  serverId,
  projectRootPosix,
  resolvedOldPath,
  resolvedNewPath,
) {
  if (!posixIsUnderRoot(projectRootPosix, resolvedOldPath) || !posixIsUnderRoot(projectRootPosix, resolvedNewPath)) {
    const e = new Error('Path must be under project root');
    /** @type {any} */ (e).code = 'REMOTE_PATH_ESCAPE';
    throw e;
  }
  return withRemoteSsh(userId, serverId, async ({ sftp }) => {
    await sftpStat(sftp, resolvedOldPath);
    try {
      await sftpStat(sftp, resolvedNewPath);
      const e = new Error('Already exists');
      /** @type {any} */ (e).code = 'EEXIST';
      throw e;
    } catch (ex) {
      if (/** @type {any} */ (ex).code === 'EEXIST') {
        throw ex;
      }
      if (/** @type {any} */ (ex).code !== 2 && /** @type {any} */ (ex).code !== 'ENOENT') {
        throw ex;
      }
    }
    await sftpRenamePromise(sftp, resolvedOldPath, resolvedNewPath);
  });
}

/**
 * @param {number} userId
 * @param {number} serverId
 * @param {string} projectRootPosix
 * @param {string} resolvedFrom
 * @param {string} resolvedNewPath
 * @returns {Promise<void>}
 */
export async function remoteMoveWithinProject(
  userId,
  serverId,
  projectRootPosix,
  resolvedFrom,
  resolvedNewPath,
) {
  if (!posixIsUnderRoot(projectRootPosix, resolvedFrom) || !posixIsUnderRoot(projectRootPosix, resolvedNewPath)) {
    const e = new Error('Path must be under project root');
    /** @type {any} */ (e).code = 'REMOTE_PATH_ESCAPE';
    throw e;
  }
  const normRoot = projectRootPosix === '/' ? '/' : projectRootPosix.replace(/\/+$/, '');
  const fromNorm = resolvedFrom.replace(/\/+$/, '') || '/';
  if (fromNorm === normRoot) {
    const e = new Error('Cannot move project root');
    /** @type {any} */ (e).code = 'REMOTE_MOVE_ROOT';
    throw e;
  }

  return withRemoteSsh(userId, serverId, async ({ sftp }) => {
    const fromSt = await sftpStat(sftp, resolvedFrom);
    const dirSt = await sftpStat(sftp, path.posix.dirname(resolvedNewPath));
    if (!statIsDir(dirSt)) {
      const e = new Error('Destination must be a directory');
      /** @type {any} */ (e).code = 'ENOTDIR';
      throw e;
    }
    if (statIsDir(fromSt)) {
      const normFrom = `${resolvedFrom.replace(/\/+$/, '')}/`;
      const normNewDir = `${path.posix.dirname(resolvedNewPath).replace(/\/+$/, '')}/`;
      if (normNewDir.startsWith(normFrom)) {
        const e = new Error('Cannot move a folder into itself or its subfolder');
        /** @type {any} */ (e).code = 'REMOTE_MOVE_INTO_SELF';
        throw e;
      }
    }
    if (resolvedFrom === resolvedNewPath) {
      return;
    }
    try {
      await sftpStat(sftp, resolvedNewPath);
      const e = new Error('Already exists');
      /** @type {any} */ (e).code = 'EEXIST';
      throw e;
    } catch (ex) {
      if (/** @type {any} */ (ex).code === 'EEXIST') {
        throw ex;
      }
      if (/** @type {any} */ (ex).code !== 2 && /** @type {any} */ (ex).code !== 'ENOENT') {
        throw ex;
      }
    }
    await sftpRenamePromise(sftp, resolvedFrom, resolvedNewPath);
  });
}

/**
 * @param {number} userId
 * @param {number} serverId
 * @param {string} projectRootPosix
 * @param {string} resolvedPath
 * @returns {Promise<void>}
 */
/**
 * @param {number} userId
 * @param {number} serverId
 * @param {string} absPosixPath
 * @returns {Promise<{ exists: boolean, isDirectory?: boolean }>}
 */
export async function remotePathMetadata(userId, serverId, absPosixPath) {
  return withRemoteSsh(userId, serverId, async ({ sftp }) => {
    try {
      const st = await sftpStat(sftp, absPosixPath);
      return { exists: true, isDirectory: statIsDir(st) };
    } catch (e) {
      if (/** @type {any} */ (e).code === 2 || /** @type {any} */ (e).code === 'ENOENT') {
        return { exists: false };
      }
      throw e;
    }
  });
}

export async function remoteDeletePath(userId, serverId, projectRootPosix, resolvedPath) {
  if (!posixIsUnderRoot(projectRootPosix, resolvedPath)) {
    const e = new Error('Path must be under project root');
    /** @type {any} */ (e).code = 'REMOTE_PATH_ESCAPE';
    throw e;
  }
  const normRoot = projectRootPosix === '/' ? '/' : projectRootPosix.replace(/\/+$/, '');
  const normTarget = resolvedPath.replace(/\/+$/, '') || '/';
  if (normTarget === normRoot) {
    const e = new Error('Cannot delete project root directory');
    /** @type {any} */ (e).code = 'REMOTE_DELETE_ROOT';
    throw e;
  }
  return withRemoteSsh(userId, serverId, async ({ sftp }) => {
    await rmRecursiveSftp(sftp, resolvedPath);
  });
}

/**
 * @param {number} userId
 * @param {number} serverId
 * @param {string} projectRootPosix
 * @param {string} resolvedTargetDir
 * @param {{ localTempPath: string, destRelativePosix: string }[]} items
 * @returns {Promise<{ name: string, path: string, size: number }[]>}
 */
export async function remoteUploadFromLocalTemp(
  userId,
  serverId,
  projectRootPosix,
  resolvedTargetDir,
  items,
) {
  if (!posixIsUnderRoot(projectRootPosix, resolvedTargetDir)) {
    const e = new Error('Path must be under project root');
    /** @type {any} */ (e).code = 'REMOTE_PATH_ESCAPE';
    throw e;
  }

  return withRemoteSsh(userId, serverId, async ({ sftp }) => {
    await mkdirRecursiveSftp(sftp, resolvedTargetDir);
    const uploaded = [];
    for (const it of items) {
      const destAbs = resolveUploadDestAbs(projectRootPosix, resolvedTargetDir, it.destRelativePosix);
      if (!destAbs) {
        continue;
      }
      const buf = await fsPromises.readFile(it.localTempPath);
      const parent = path.posix.dirname(destAbs);
      if (parent && parent !== '/' && parent !== destAbs) {
        await mkdirRecursiveSftp(sftp, parent);
      }
      await sftpWriteFilePromise(sftp, destAbs, buf);
      uploaded.push({
        name: it.destRelativePosix,
        path: destAbs,
        size: buf.length,
      });
    }
    return uploaded;
  });
}

/**
 * SFTP stat 远端绝对路径（POSIX）。
 * @param {number} userId
 * @param {number} serverId
 * @param {string} absPosixPath
 * @returns {Promise<import('ssh2').sftp.Stats>}
 */
export async function remoteStatPath(userId, serverId, absPosixPath) {
  return withRemoteSsh(userId, serverId, async ({ sftp }) => sftpStat(sftp, absPosixPath));
}

/**
 * 递归删除远端文件或目录。调用方须保证路径已校验在允许范围内。
 * @param {number} userId
 * @param {number} serverId
 * @param {string} absPosixPath
 * @returns {Promise<void>}
 */
export async function remoteDeletePathRecursive(userId, serverId, absPosixPath) {
  return withRemoteSsh(userId, serverId, async ({ sftp }) => {
    await rmRecursiveSftp(sftp, absPosixPath);
  });
}

/**
 * 列出远端目录下一层文件名（不含 `.` / `..`）。
 * @param {number} userId
 * @param {number} serverId
 * @param {string} dirPosix
 * @returns {Promise<string[]>}
 */
export async function remoteReaddirBasenames(userId, serverId, dirPosix) {
  return withRemoteSsh(userId, serverId, async ({ sftp }) => {
    const list = await new Promise((resolve, reject) => {
      sftp.readdir(dirPosix, (e, l) => (e ? reject(e) : resolve(l || [])));
    });
    return list.map((de) => de.filename).filter((n) => n && n !== '.' && n !== '..');
  });
}
