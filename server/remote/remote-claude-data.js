/**
 * 通过 SFTP 读取远端 ~/.claude 下的项目与会话（与 server/projects.js 的 Claude 路径对齐）。
 * @module server/remote/remote-claude-data
 */

import readline from 'readline';
import path from 'path';
import { withRemoteSsh } from './remote-ssh.js';
import { normalizeClaudeJsonlToApi } from '../providers/claude/adapter.js';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const CLAUDE_PROJECTS_REL = path.posix.join('.claude', 'projects');

/**
 * @param {import('ssh2').SFTPWrapper} sftp
 * @param {string} abspath
 * @returns {Promise<import('fs').Stats | import('ssh2').sftp.Stats | object>}
 */
function sftpFileStat(sftp, abspath) {
  return new Promise((resolve, reject) => {
    sftp.stat(abspath, (e, st) => {
      if (e) reject(e);
      else resolve(st);
    });
  });
}

/**
 * @param {import('fs').Stats | { mtime?: unknown; mtimeMs?: number } | null | undefined} st
 * @returns {number}
 */
function sftpMtimeToMs(st) {
  if (!st) {
    return 0;
  }
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
 * 小文件一次性读，按行回调，返回 false 时停止。
 * @param {import('ssh2').SFTPWrapper} sftp
 * @param {string} abspath
 * @param {(line: string, i: number) => void | boolean} onLine
 */
function readSftpFileLines(sftp, abspath, onLine) {
  return new Promise((resolve, reject) => {
    sftp.readFile(abspath, (e, buf) => {
      if (e) {
        if (e.code === 2) {
          resolve(0);
          return;
        }
        reject(e);
        return;
      }
      if (!Buffer.isBuffer(buf) || buf.length === 0) {
        resolve(0);
        return;
      }
      const b = buf.length > MAX_FILE_BYTES ? buf.subarray(0, MAX_FILE_BYTES) : buf;
      const t = b.toString('utf8');
      const lines = t.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const r = onLine(lines[i] || '', i);
        if (r === false) {
          break;
        }
      }
      resolve(lines.length);
    });
  });
}

/**
 * @param {import('ssh2').SFTPWrapper} sftp
 * @param {string} abspath
 * @param {(line: string) => void} forEach
 */
function streamSftpFileLines(sftp, abspath, forEach) {
  return new Promise((resolve, reject) => {
    const st = sftp.createReadStream(abspath, { highWaterMark: 64 * 1024 });
    st.on('error', (er) => {
      reject(er);
    });
    const rl = readline.createInterface({ input: st, crlfDelay: Infinity });
    rl.on('line', (line) => forEach(line));
    rl.on('close', () => resolve());
  });
}

/**
 * 列出 `~/.claude/projects` 下目录，构造与 getProjects 相近的项目对象（P1：只填 Claude 会话，Cursor 等空数组）。
 * @param {number} userId
 * @param {number} serverId
 */
export async function getRemoteClaudeProjectList(userId, serverId) {
  console.log(`[remote-claude-data] getRemoteClaudeProjectList start userId=${userId} serverId=${serverId}`);
  return withRemoteSsh(userId, serverId, async ({ sftp, home }) => {
    const projectsRoot = path.posix.join(home, CLAUDE_PROJECTS_REL);
    console.log(
      `[remote-claude-data] sftp readdir home=${JSON.stringify(home)} projectsRoot=${JSON.stringify(projectsRoot)}`,
    );
    const out = [];
    const dirents = await new Promise((resolve, reject) => {
      sftp.readdir(projectsRoot, (e, list) => {
        if (e) {
          if (e.code === 2) {
            resolve([]);
            return;
          }
          reject(e);
        } else {
          resolve(list || []);
        }
      });
    });
    for (const de of dirents) {
      const name = de.filename;
      if (!name) {
        continue;
      }
      if (!de.attrs || typeof de.attrs.isDirectory !== 'function' || !de.attrs.isDirectory()) {
        continue;
      }
      const pdir = path.posix.join(projectsRoot, name);
      // 推断 cwd
      const jsonl = await new Promise((resolve) => {
        sftp.readdir(pdir, (e, files) => {
          if (e) {
            resolve(null);
            return;
          }
          const j = (files || []).find(
            (f) => f.filename && f.filename.endsWith('.jsonl') && !f.filename.startsWith('agent-'),
          );
          resolve(j ? j.filename : null);
        });
      });
      let projectPath = name.split('-').join('/');
      if (jsonl) {
        const fpath = path.posix.join(pdir, jsonl);
        const lines = await readSftpFileLines(sftp, fpath, (line, idx) => {
          if (idx > 2) {
            return false;
          }
          if (!line.trim()) {
            return true;
          }
          try {
            const ent = JSON.parse(line);
            if (ent && typeof ent.cwd === 'string' && ent.cwd) {
              projectPath = ent.cwd;
              return false;
            }
          } catch {
            return true;
          }
          return true;
        });
        if (!lines) {
          /* */ void lines;
        }
      }

      const displayName = projectPath.split('/').filter(Boolean).pop() || name;
      out.push({
        name,
        path: projectPath,
        fullPath: projectPath,
        displayName,
        isCustomName: false,
        isManuallyAdded: false,
        sessions: [],
        cursorSessions: [],
        codexSessions: [],
        geminiSessions: [],
        sessionMeta: { hasMore: false, total: 0 },
        targetKey: `remote:${serverId}`,
        serverId,
        __cloudcliRemote: true,
      });
    }
    for (const proj of out) {
      const sr = await getRemoteClaudeSessionsInternal(sftp, home, proj.name, 5, 0);
      proj.sessions = sr.sessions;
      proj.sessionMeta = { hasMore: sr.hasMore, total: sr.total };
    }
    console.log(
      `[remote-claude-data] getRemoteClaudeProjectList done serverId=${serverId} projectCount=${out.length}`,
    );
    return out;
  });
}

/**
 * @param {import('ssh2').SFTPWrapper} sftp
 * @param {string} home
 * @param {string} projectName
 * @param {number} limit
 * @param {number} offset
 */
export async function getRemoteClaudeSessionsInternal(sftp, home, projectName, limit, offset) {
  const pdir = path.posix.join(home, CLAUDE_PROJECTS_REL, projectName);
  const fileList = await new Promise((resolve, reject) => {
    sftp.readdir(pdir, (e, list) => {
      if (e) {
        if (e.code === 2) {
          resolve([]);
          return;
        }
        reject(e);
        return;
      }
      resolve(list || []);
    });
  });
  const jsonlFiles = fileList
    .filter(
      (f) =>
        f.filename
        && f.filename.endsWith('.jsonl')
        && !f.filename.startsWith('agent-'),
    )
    .map((f) => f.filename);

  if (jsonlFiles.length === 0) {
    return { sessions: [], hasMore: false, total: 0 };
  }

  const mtime = await Promise.all(
    jsonlFiles.map((fn) => {
      const p = path.posix.join(pdir, fn);
      return new Promise((resolve) => {
        sftpFileStat(sftp, p)
          .then((st) => {
            const m = sftpMtimeToMs(st) || 0;
            resolve({ fn, m: m || Date.now() });
          })
          .catch(() => resolve({ fn, m: 0 }));
      });
    }),
  );
  mtime.sort((a, b) => b.m - a.m);
  const filesSorted = mtime.map((x) => x.fn);

  const byId = new Map();
  for (const fn of filesSorted) {
    const fp = path.posix.join(pdir, fn);
    await streamSftpFileLines(sftp, fp, (line) => {
      if (!line.trim()) {
        return;
      }
      let ent;
      try {
        ent = JSON.parse(line);
      } catch {
        return;
      }
      if (!ent || !ent.sessionId) {
        return;
      }
      const id = ent.sessionId;
      if (byId.has(id)) {
        return;
      }
      let summary = 'Session';
      if (ent.type === 'user' && ent.message) {
        const t = ent.message;
        if (t && t.role === 'user' && t.content) {
          if (typeof t.content === 'string') {
            summary = t.content.slice(0, 200);
          } else if (Array.isArray(t.content) && t.content[0] && t.content[0].text) {
            summary = String(t.content[0].text).slice(0, 200);
          }
        }
      }
      byId.set(id, {
        id,
        summary,
        name: summary,
        created_at: ent.timestamp,
        updated_at: ent.timestamp,
        __cloudcliRemote: true,
      });
    });
  }
  const all = [...byId.values()];
  all.sort(
    (a, b) =>
      new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime(),
  );
  const total = all.length;
  const slice = all.slice(offset, offset + limit);
  return {
    sessions: slice,
    hasMore: offset + slice.length < total,
    total,
  };
}

/**
 * 与 getSessionMessages（projects.js）等价的行收集 + 分页，再经 adapter 转 API。
 * @param {number} userId
 * @param {number} serverId
 * @param {string} projectName
 * @param {string} sessionId
 * @param {number | null} limit
 * @param {number} offset
 */
export async function getRemoteClaudeSessionMessages(userId, serverId, projectName, sessionId, limit, offset) {
  return withRemoteSsh(userId, serverId, async ({ sftp, home }) => {
    const pdir = path.posix.join(home, CLAUDE_PROJECTS_REL, projectName);
    const fileList = await new Promise((resolve, reject) => {
      sftp.readdir(pdir, (e, list) => {
        if (e) {
          if (e.code === 2) {
            resolve([]);
            return;
          }
          reject(e);
          return;
        }
        resolve(list || []);
      });
    });
    const jsonlFiles = fileList
      .filter(
        (f) =>
          f.filename
          && f.filename.endsWith('.jsonl')
          && !f.filename.startsWith('agent-'),
      )
      .map((f) => f.filename);
    if (jsonlFiles.length === 0) {
      return { messages: [], total: 0, hasMore: false };
    }
    const allRaw = [];
    for (const fn of jsonlFiles) {
      const fp = path.posix.join(pdir, fn);
      const one = await new Promise((resolve) => {
        sftp.readFile(fp, (e, buf) => {
          if (e) {
            resolve(null);
            return;
          }
          if (!Buffer.isBuffer(buf) || !buf.length) {
            resolve(null);
            return;
          }
          const t = buf.length > MAX_FILE_BYTES ? buf.subarray(0, MAX_FILE_BYTES) : buf;
          resolve(t.toString('utf8'));
        });
      });
      if (!one) {
        continue;
      }
      for (const line of one.split('\n')) {
        if (!line.trim()) {
          continue;
        }
        try {
          const entry = JSON.parse(line);
          if (entry && entry.sessionId === sessionId) {
            allRaw.push(entry);
          }
        } catch {
          /* */ void 0;
        }
      }
    }
    allRaw.sort(
      (a, b) =>
        new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime(),
    );
    if (limit === null) {
      return normalizeClaudeJsonlToApi(
        { messages: allRaw, total: allRaw.length, hasMore: false, offset, limit: null },
        sessionId,
      );
    }
    const total = allRaw.length;
    const start = Math.max(0, total - offset - limit);
    const end = total - offset;
    const page = allRaw.slice(start, end);
    return normalizeClaudeJsonlToApi(
      {
        messages: page,
        total,
        hasMore: start > 0,
        offset,
        limit,
      },
      sessionId,
    );
  });
}

/**
 * 对外：会话列表 API
 * @param {number} userId
 * @param {number} serverId
 * @param {string} projectName
 * @param {number} limit
 * @param {number} offset
 */
export async function getRemoteClaudeSessionsForApi(userId, serverId, projectName, limit, offset) {
  return withRemoteSsh(userId, serverId, async ({ sftp, home }) =>
    getRemoteClaudeSessionsInternal(sftp, home, projectName, limit, offset),
  );
}
