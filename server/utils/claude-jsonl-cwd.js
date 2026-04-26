/**
 * 从 Claude / Claude Code JSONL 行解析工作目录。
 * - 旧版：顶层 `cwd`
 * - 新版：`snapshot` 可为 **JSON 字符串**；路径可能在 `cwd` / `workingDirectory` / `workspaceFolder` 等键下
 *
 * 项目根路径推断（与 `~/.claude/projects/<编码名>` 对应）：
 * 1. 优先从各 `.jsonl` 行解析 `cwd` / `snapshot` 内工作区字段，以及整 JSON 里扫到的绝对路径字符串。
 * 2. 若无：用 SFTP/本地 `stat` 按候选列表探测。候选含 `home/<slugBody>`、slug 反推路径等。
 * 3. Claude 编码目录名时会把路径里的 `/` 与部分字符压成 `-`，其中 **磁盘上的 `_` 在目录名里会变成 `-`**，
 *    故在每条候选路径上追加「仅 basename 内 `-` → `_`」的变体（例如 `/apps/AI-NovelGenerator` → `/apps/AI_NovelGenerator`）。
 * @module server/utils/claude-jsonl-cwd
 */

import path from 'node:path';

const PREFERRED_SUBTREES = ['session', 'workspace', 'environment', 'project', 'context', 'state', 'metadata', 'model'];

/** 视为「工作区绝对路径」的字段名（值须为以 / 开头的非空字符串） */
const WORKSPACE_PATH_KEYS = [
  'cwd',
  'workingDirectory',
  'workspaceFolder',
  'workspacePath',
  'projectRoot',
  'rootPath',
  'projectPath',
  'directory',
];

const MAX_SLUG_DECODE_COMBOS = 180;

/** 从 JSON 里扫出的「疑似 POSIX 绝对路径」字符串（排除 URL） */
const POSIX_ABS_PATH_LIKE =
  /^\/(?:[a-zA-Z0-9_.+\/@-]+\/)*[a-zA-Z0-9_.+\/@-]+$/;

const MAX_HARVEST_PATHS = 120;

/**
 * 从 `.../.claude/projects/<name>` 推断远端用户 home（前缀到 `/.claude/projects` 为止）。
 * @param {string} pdir
 * @returns {string | null}
 */
export function inferredHomeFromClaudeProjectsPdir(pdir) {
  const t = String(pdir || '');
  const marker = '/.claude/projects/';
  const i = t.indexOf(marker);
  if (i >= 0) {
    return t.slice(0, i) || null;
  }
  return null;
}

/**
 * Claude 项目目录名里用 `-` 表示原路径分段；原路径段内的 `_` 在目录名中会变成 `-`。
 * 在已反推出的绝对路径上，追加「最后一层目录名中 `-` 视为 `_`」的变体供 stat。
 * @param {string} p
 * @returns {string | null}
 */
function pathWithBasenameHyphensAsUnderscores(p) {
  const norm = String(p || '').trim();
  if (!norm.startsWith('/')) {
    return null;
  }
  const base = path.posix.basename(norm);
  if (!base.includes('-')) {
    return null;
  }
  const dir = path.posix.dirname(norm);
  const next = path.posix.join(dir, base.replace(/-/g, '_'));
  return next === norm ? null : next;
}

/**
 * 深度遍历 JSON，收集短字符串形式的绝对路径（用于 snapshot 里非常规字段名）。
 * @param {unknown} node
 * @param {Set<string>} out
 * @param {number} depth
 */
export function harvestAbsolutePathStringsFromValue(node, out, depth = 0) {
  if (depth > 16 || out.size >= MAX_HARVEST_PATHS) {
    return;
  }
  if (typeof node === 'string') {
    const s = node.trim();
    if (
      s.length >= 2 &&
      s.length <= 512 &&
      s.startsWith('/') &&
      !s.includes('://') &&
      !s.includes('\n') &&
      !s.includes('\0') &&
      POSIX_ABS_PATH_LIKE.test(s)
    ) {
      out.add(s);
    }
    return;
  }
  if (node == null || typeof node !== 'object') {
    return;
  }
  if (Array.isArray(node)) {
    for (const el of node) {
      harvestAbsolutePathStringsFromValue(el, out, depth + 1);
      if (out.size >= MAX_HARVEST_PATHS) {
        return;
      }
    }
    return;
  }
  /** @type {Record<string, unknown>} */
  const o = /** @type {any} */ (node);
  if (typeof o.snapshot === 'string' && o.snapshot.length < 400_000) {
    const inner = parseSnapshotObject(o.snapshot);
    if (inner) {
      harvestAbsolutePathStringsFromValue(inner, out, depth + 1);
      if (out.size >= MAX_HARVEST_PATHS) {
        return;
      }
    }
  }
  for (const [k, v] of Object.entries(o)) {
    if (k === 'snapshot' && typeof o.snapshot === 'string') {
      continue;
    }
    harvestAbsolutePathStringsFromValue(v, out, depth + 1);
    if (out.size >= MAX_HARVEST_PATHS) {
      return;
    }
  }
}

/**
 * @param {unknown} snap
 * @returns {Record<string, unknown> | null}
 */
function parseSnapshotObject(snap) {
  if (snap == null) {
    return null;
  }
  if (typeof snap === 'object' && !Array.isArray(snap)) {
    return /** @type {Record<string, unknown>} */ (snap);
  }
  if (typeof snap === 'string') {
    const t = snap.trim();
    if (!t) {
      return null;
    }
    try {
      const o = JSON.parse(t);
      if (o && typeof o === 'object' && !Array.isArray(o)) {
        return /** @type {Record<string, unknown>} */ (o);
      }
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * @param {Record<string, unknown>} obj
 * @returns {string | null}
 */
function workspacePathAtObject(obj) {
  for (const k of WORKSPACE_PATH_KEYS) {
    const v = obj[k];
    if (typeof v === 'string' && v.startsWith('/') && v.length > 1 && v.length < 4096 && !v.includes('\0')) {
      return v;
    }
  }
  return null;
}

/**
 * @param {unknown} node
 * @param {number} depth
 * @returns {string | null}
 */
function digWorkspaceInObject(node, depth) {
  if (depth > 14 || node == null || typeof node !== 'object' || Array.isArray(node)) {
    return null;
  }
  /** @type {Record<string, unknown>} */
  const obj = /** @type {any} */ (node);
  const direct = workspacePathAtObject(obj);
  if (direct) {
    return direct;
  }
  for (const k of PREFERRED_SUBTREES) {
    const child = obj[k];
    if (child && typeof child === 'object') {
      const r = digWorkspaceInObject(child, depth + 1);
      if (r) {
        return r;
      }
    }
  }
  for (const [k, v] of Object.entries(obj)) {
    if (PREFERRED_SUBTREES.includes(k)) {
      continue;
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const r = digWorkspaceInObject(v, depth + 1);
      if (r) {
        return r;
      }
    }
  }
  return null;
}

/**
 * @param {unknown} entry
 * @returns {string | null}
 */
export function extractCwdFromClaudeJsonlEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  /** @type {Record<string, unknown>} */
  const o = /** @type {any} */ (entry);
  const top = workspacePathAtObject(o);
  if (top) {
    return top;
  }
  const snapObj = parseSnapshotObject(o.snapshot);
  if (snapObj) {
    const fromSnap = digWorkspaceInObject(snapObj, 0);
    if (fromSnap) {
      return fromSnap;
    }
  }
  return null;
}

/**
 * Claude 将 `~/.claude/projects` 下目录名由绝对路径经 `[^a-zA-Z0-9-] -> -` 得到；无法从 jsonl 读路径时，
 * 枚举「哪些 `-` 对应原路径的 `/`」得到候选绝对路径（在远端用 stat 探测）。
 * @param {string} projectName 例如 `-apps-AI-NovelGenerator`
 * @returns {string[]} 去重；**优先路径段数更少**（减少把目录名里的 `-` 误当成 `/` 的拆分），同段数再按更短路径。
 */
export function decodedClaudeProjectSlugToPathCandidates(projectName) {
  const name = String(projectName || '').trim();
  const out = new Set();
  if (!name) {
    return [];
  }
  if (!name.startsWith('-')) {
    out.add(`/${name.replace(/-/g, '/')}`);
    return sortPathCandidates(out);
  }
  const body = name.slice(1);
  if (!body) {
    return ['/'];
  }
  const hypIdx = [];
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === '-') {
      hypIdx.push(i);
    }
  }
  const H = hypIdx.length;
  if (H === 0) {
    out.add(`/${body}`);
    return sortPathCandidates(out);
  }

  let gen = 0;
  /**
   * @param {number} start
   * @param {number} need
   * @param {number[]} acc
   */
  function dfs(start, need, acc) {
    if (gen >= MAX_SLUG_DECODE_COMBOS || need < 0) {
      return;
    }
    if (need === 0) {
      gen += 1;
      const breaks = [...acc].sort((a, b) => a - b);
      const idxs = [-1, ...breaks, body.length];
      const segs = [];
      let ok = true;
      for (let i = 0; i < idxs.length - 1; i += 1) {
        const s = body.slice(idxs[i] + 1, idxs[i + 1]);
        if (!s) {
          ok = false;
          break;
        }
        segs.push(s);
      }
      if (ok && segs.length > 0) {
        out.add(`/${segs.join('/')}`);
      }
      return;
    }
    for (let i = start; i < H; i += 1) {
      acc.push(hypIdx[i]);
      dfs(i + 1, need - 1, acc);
      acc.pop();
      if (gen >= MAX_SLUG_DECODE_COMBOS) {
        return;
      }
    }
  }

  for (let k = 2; k <= Math.min(H + 1, 14); k += 1) {
    const need = k - 1;
    if (need > H) {
      break;
    }
    dfs(0, need, []);
    if (gen >= MAX_SLUG_DECODE_COMBOS) {
      break;
    }
  }

  out.add(`/${body.replace(/-/g, '/')}`);
  return sortPathCandidates(out);
}

/**
 * @param {Set<string>} s
 * @returns {string[]}
 */
function sortPathCandidates(s) {
  return Array.from(s).sort((a, b) => {
    const da = a.split('/').filter(Boolean).length;
    const db = b.split('/').filter(Boolean).length;
    if (da !== db) {
      return da - db;
    }
    return a.length - b.length;
  });
}

/**
 * 合并用于 SFTP stat 探测的路径：优先 harvest（更长、更具体），其次 home+slug，最后 slug 组合枚举。
 * @param {string | null} homeDir
 * @param {string} pdir
 * @param {string} projectName
 * @param {Iterable<string>} harvested
 * @returns {string[]}
 */
export function buildRemoteProjectRootStatProbeList(homeDir, pdir, projectName, harvested) {
  const ordered = [];
  const seen = new Set();

  const push = (/** @type {string} */ p) => {
    const x = String(p).trim();
    if (!x || seen.has(x)) {
      return;
    }
    seen.add(x);
    ordered.push(x);
    const us = pathWithBasenameHyphensAsUnderscores(x);
    if (us && !seen.has(us)) {
      seen.add(us);
      ordered.push(us);
    }
  };

  const harvestArr = Array.from(harvested).sort((a, b) => {
    const da = a.split('/').filter(Boolean).length;
    const db = b.split('/').filter(Boolean).length;
    if (da !== db) {
      return da - db;
    }
    return a.length - b.length;
  });
  for (const h of harvestArr) {
    push(h);
  }

  const home = homeDir || inferredHomeFromClaudeProjectsPdir(pdir);
  const pn = String(projectName || '').trim();
  if (home && pn.startsWith('-')) {
    const body = pn.slice(1);
    if (body) {
      push(`${home}/${body}`);
    }
  }

  for (const c of decodedClaudeProjectSlugToPathCandidates(pn)) {
    push(c);
  }

  return ordered;
}
