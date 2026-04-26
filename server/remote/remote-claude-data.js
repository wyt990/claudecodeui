/**
 * 通过 SFTP 读取远端 ~/.claude 下的项目与会话（与 server/projects.js 的 Claude 路径对齐）。
 * @module server/remote/remote-claude-data
 */

import readline from 'readline';
import path from 'path';
import { withRemoteSsh } from './remote-ssh.js';
import { normalizeClaudeJsonlToApi } from '../providers/claude/adapter.js';
import {
  extractCwdFromClaudeJsonlEntry,
  buildRemoteProjectRootStatProbeList,
  harvestAbsolutePathStringsFromValue,
} from '../utils/claude-jsonl-cwd.js';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const CLAUDE_PROJECTS_REL = path.posix.join('.claude', 'projects');

/**
 * 与本地 `extractProjectDirectory` 一致：遍历目录下所有非 agent 的 .jsonl，聚合 `cwd`。
 * 仅用「首个 jsonl 前几行」会漏掉 cwd 或选错文件，回退到 `replace(/-/g,'/')` 会把 `AI-NovelGenerator` 拆错。
 *
 * @param {import('ssh2').SFTPWrapper} sftp
 * @param {string} pdir 远端 ~/.claude/projects/{projectName} 绝对路径
 * @param {string} projectName 该段目录名（编码名）
 * @returns {Promise<string | null>} 推断的工作区绝对路径；目录不可读时 null
 */
function logInferCwd(msg, extra = {}) {
  const tail = Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : '';
  console.log(`[remote-claude-data inferCwd] ${msg}${tail}`);
}

export async function inferRemoteProjectCwdFromClaudeProjectDir(sftp, pdir, projectName) {
  const lossyFallback = String(projectName).replace(/-/g, '/');

  const files = await new Promise((resolve, reject) => {
    sftp.readdir(pdir, (e, list) => {
      if (e) {
        if (e.code === 2) {
          resolve(null);
          return;
        }
        reject(e);
        return;
      }
      resolve(list || []);
    });
  });
  if (!files) {
    logInferCwd('readdir pdir failed or empty (ENOENT)', { pdir, projectName });
    return null;
  }

  const jsonlFiles = files
    .map((f) => f.filename)
    .filter((fn) => fn && fn.endsWith('.jsonl') && !fn.startsWith('agent-'));

  logInferCwd('scan start', {
    pdir,
    projectName,
    lossyFallback,
    jsonlCount: jsonlFiles.length,
    jsonlSample: jsonlFiles.slice(0, 12),
  });

  if (jsonlFiles.length === 0) {
    logInferCwd('no jsonl → lossyFallback', { lossyFallback });
    return lossyFallback;
  }

  const cwdCounts = new Map();
  let latestTimestamp = 0;
  let latestCwd = /** @type {string | null} */ (null);
  /** @type {string[]} */
  const sampleKeysNoCwd = [];
  /** @type {Set<string>} */
  const harvestedPaths = new Set();

  for (const file of jsonlFiles) {
    const fpath = path.posix.join(pdir, file);
    await readSftpFileLines(sftp, fpath, (line) => {
      if (!line.trim()) {
        return true;
      }
      try {
        const entry = JSON.parse(line);
        harvestAbsolutePathStringsFromValue(entry, harvestedPaths, 0);
        const cwd = extractCwdFromClaudeJsonlEntry(entry);
        if (cwd) {
          cwdCounts.set(cwd, (cwdCounts.get(cwd) || 0) + 1);
          const ts = new Date(
            (entry && entry.timestamp) ||
              (entry && entry.snapshot && /** @type {any} */ (entry.snapshot).timestamp) ||
              0,
          ).getTime();
          if (ts > latestTimestamp) {
            latestTimestamp = ts;
            latestCwd = cwd;
          }
        } else if (sampleKeysNoCwd.length < 5 && entry && typeof entry === 'object') {
          const keys = Object.keys(entry).slice(0, 24);
          sampleKeysNoCwd.push(`${file}:${keys.join(',')}`);
        }
      } catch {
        /* skip malformed */
      }
      return true;
    });
  }

  const cwdSummary = Object.fromEntries(cwdCounts);

  if (cwdCounts.size === 0) {
    const candidates = buildRemoteProjectRootStatProbeList(null, pdir, projectName, harvestedPaths);
    logInferCwd('no cwd in jsonl → probe stat candidates', {
      sampleLinesTopKeys: sampleKeysNoCwd,
      candidateCount: candidates.length,
      harvestCount: harvestedPaths.size,
      harvestSample: Array.from(harvestedPaths).slice(0, 8),
      firstCandidates: candidates.slice(0, 16),
    });
    for (const c of candidates) {
      try {
        await sftpFileStat(sftp, c);
        logInferCwd('stat hit', { chosen: c });
        return c;
      } catch {
        /* try next */
      }
    }
    logInferCwd('stat miss → lossyFallback', { lossyFallback });
    return lossyFallback;
  }
  if (cwdCounts.size === 1) {
    const only = Array.from(cwdCounts.keys())[0];
    logInferCwd('single cwd', { chosen: only, cwdSummary });
    return only;
  }
  const mostRecentCount = cwdCounts.get(latestCwd || '') || 0;
  const maxCount = Math.max(...cwdCounts.values());
  if (latestCwd && mostRecentCount >= maxCount * 0.25) {
    logInferCwd('multi cwd → latestCwd', { chosen: latestCwd, latestTimestamp, cwdSummary });
    return latestCwd;
  }
  for (const [cwd, count] of cwdCounts.entries()) {
    if (count === maxCount) {
      logInferCwd('multi cwd → max count', { chosen: cwd, cwdSummary });
      return cwd;
    }
  }
  const last = latestCwd || lossyFallback;
  logInferCwd('multi cwd → fallback', { chosen: last, cwdSummary });
  return last;
}

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
      let projectPath = name.split('-').join('/');
      try {
        const inferred = await inferRemoteProjectCwdFromClaudeProjectDir(sftp, pdir, name);
        if (inferred != null && String(inferred).trim() !== '') {
          projectPath = inferred;
        }
      } catch {
        /* keep split fallback */
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

/**
 * 从远端 ~/.claude/projects/{projectName}/*.jsonl 中移除指定 session 的所有行（与 projects.js deleteSession 行为一致）。
 * @param {number} userId
 * @param {number} serverId
 * @param {string} projectName
 * @param {string} sessionId
 * @returns {Promise<boolean>}
 */
export async function deleteRemoteClaudeSession(userId, serverId, projectName, sessionId) {
  const sid = String(sessionId);
  console.log(
    `[remote-claude-data] deleteRemoteClaudeSession userId=${userId} serverId=${serverId} project=${projectName} sessionId=${sid}`,
  );
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
      const err = new Error('No session files found for this project');
      /** @type {any} */ (err).code = 'REMOTE_NO_SESSION_FILES';
      throw err;
    }

    for (const file of jsonlFiles) {
      const jsonlFile = path.posix.join(pdir, file);
      const buf = await new Promise((resolve, reject) => {
        sftp.readFile(jsonlFile, (e, b) => {
          if (e) {
            reject(e);
            return;
          }
          resolve(b);
        });
      });
      if (!Buffer.isBuffer(buf) || !buf.length) {
        continue;
      }
      if (buf.length > MAX_FILE_BYTES) {
        const err = new Error('Session file too large to modify');
        /** @type {any} */ (err).code = 'REMOTE_SESSION_FILE_TOO_LARGE';
        throw err;
      }
      const content = buf.toString('utf8');
      const lines = content.split('\n').filter((line) => line.trim());

      const hasSession = lines.some((line) => {
        try {
          const data = JSON.parse(line);
          return data.sessionId === sid;
        } catch {
          return false;
        }
      });

      if (!hasSession) {
        continue;
      }

      const filteredLines = lines.filter((line) => {
        try {
          const data = JSON.parse(line);
          return data.sessionId !== sid;
        } catch {
          return true;
        }
      });

      const out = filteredLines.join('\n') + (filteredLines.length > 0 ? '\n' : '');
      await new Promise((resolve, reject) => {
        sftp.writeFile(jsonlFile, Buffer.from(out, 'utf8'), (e) => (e ? reject(e) : resolve()));
      });
      console.log(`[remote-claude-data] deleteRemoteClaudeSession wrote file=${JSON.stringify(file)}`);
      return true;
    }

    const err = new Error(`Session ${sid} not found in any files`);
    /** @type {any} */ (err).code = 'REMOTE_SESSION_NOT_FOUND';
    throw err;
  });
}
