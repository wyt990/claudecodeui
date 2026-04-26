/**
 * 在远程主机上对项目目录执行 `claudecode -p …` 或 `claude -p …`（与网页终端 PATH 一致用 `bash -lic`）。
 * 支持：`projectName`（在已有列表中解析路径）或 `projectPath`（直接绝对路径，用于从未在 Claude 中打开过的目录）。
 * @module server/services/remote-claude-open-project
 */

import path from 'path';
import { getRemoteClaudeProjectList } from '../remote/remote-claude-data.js';
import { withRemoteSsh, execBashTextResult } from '../remote/remote-ssh.js';

const LOG_PFX = '[remote-claude-open-project]';
const MAX_LOG_TAIL = 12_000;
const MAX_PATH_LEN = 4096;

/**
 * @param {string} s
 */
function bashSingleQuote(s) {
  if (s.includes('\0')) {
    throw new Error('NUL in string is not allowed');
  }
  return `'${String(s).replace(/'/g, `'"'"'`)}'`;
}

/**
 * 校验并归一化远程 POSIX 绝对路径（拒绝 `..` 段、空、过长）。
 * @param {string} raw
 * @param {string} [purpose]  日志/错误提示用
 * @returns {string}
 */
export function validateAndNormalizeRemoteProjectPath(raw, purpose = 'open') {
  if (raw == null || typeof raw !== 'string') {
    const e = new Error(`Invalid path for ${purpose}`);
    e.code = 'OPEN_PROJECT_PATH_REJECTED';
    throw e;
  }
  const t = raw.trim();
  if (!t) {
    const e = new Error('Path is empty');
    e.code = 'OPEN_PROJECT_PATH_REJECTED';
    throw e;
  }
  if (t.length > MAX_PATH_LEN) {
    const e = new Error('Path is too long');
    e.code = 'OPEN_PROJECT_PATH_REJECTED';
    throw e;
  }
  if (!t.startsWith('/')) {
    const e = new Error('Path must be absolute (start with /)');
    e.code = 'OPEN_PROJECT_PATH_REJECTED';
    throw e;
  }
  if (t.includes('\0')) {
    const e = new Error('Invalid path');
    e.code = 'OPEN_PROJECT_PATH_REJECTED';
    throw e;
  }
  const parts = t.split('/').filter(Boolean);
  for (const p of parts) {
    if (p === '..') {
      const e = new Error('Path must not contain .. segments');
      e.code = 'OPEN_PROJECT_PATH_REJECTED';
      throw e;
    }
  }
  if (parts.length === 0) {
    return '/';
  }
  return `/${parts.join('/')}`;
}

function parseOpenTimeoutMs() {
  const n = Number(process.env.CLOUDCLI_REMOTE_OPEN_PROJECT_TIMEOUT_MS);
  if (Number.isFinite(n) && n >= 3000) {
    return n;
  }
  return 120_000;
}

/**
 * @param {string} s
 * @param {string} dflt
 */
function defaultPrompt(s, dflt) {
  const t = String(s == null ? '' : s).trim();
  return t || dflt;
}

/**
 * @param {string} cwd
 * @param {string} projectPrompt
 */
function buildOpenScript(cwd, projectPrompt) {
  const qCwd = bashSingleQuote(cwd);
  const qP = bashSingleQuote(projectPrompt);
  return (
    `cd ${qCwd} && ` +
    `if command -v claudecode >/dev/null 2>&1; then claudecode -p ${qP}; ` +
    `elif command -v claude >/dev/null 2>&1; then claude -p ${qP}; ` +
    `else echo "claudecode/claude not in PATH" >&2; exit 127; fi`
  );
}

/**
 * @param {number} userId
 * @param {number} serverId
 * @param {{ prompt?: string, projectName?: string, projectPath?: string }} opts
 * @returns {Promise<{
 *   mode: 'list' | 'path';
 *   projectName: string;
 *   cwd: string;
 *   prompt: string;
 *   exitCode: number | null;
 *   timedOut: boolean;
 *   stdout: string;
 *   stderr: string;
 * }>}
 */
export async function runRemoteClaudeOpenProject(userId, serverId, opts = {}) {
  const t0 = Date.now();
  const projectPrompt = defaultPrompt(
    typeof opts.prompt === 'string' ? opts.prompt : process.env.CLOUDCLI_REMOTE_OPEN_PROJECT_PROMPT,
    'test',
  );
  const timeoutMs = parseOpenTimeoutMs();
  const hasName = typeof opts.projectName === 'string' && opts.projectName.trim();
  const hasPath = typeof opts.projectPath === 'string' && opts.projectPath.trim();

  if (hasName && hasPath) {
    const e = new Error('Specify only one of projectName or projectPath');
    e.code = 'OPEN_PROJECT_BAD_REQUEST';
    throw e;
  }
  if (!hasName && !hasPath) {
    const e = new Error('projectName or projectPath is required');
    e.code = 'OPEN_PROJECT_BAD_REQUEST';
    throw e;
  }

  let mode;
  /** @type {string} */
  let cwd;
  /** @type {string} */
  let label;

  if (hasPath) {
    mode = 'path';
    cwd = validateAndNormalizeRemoteProjectPath(String(opts.projectPath), 'open');
    label = cwd === '/' ? 'root' : path.posix.basename(cwd) || 'project';
    console.log(
      `${LOG_PFX} start mode=path userId=${userId} serverId=${serverId} cwd=${JSON.stringify(
        cwd,
      )} label=${JSON.stringify(label)} prompt=${JSON.stringify(projectPrompt)} timeoutMs=${timeoutMs}`,
    );
  } else {
    mode = 'list';
    const name = String(opts.projectName).trim();
    console.log(
      `${LOG_PFX} start mode=list userId=${userId} serverId=${serverId} projectName=${JSON.stringify(
        name,
      )} prompt=${JSON.stringify(projectPrompt)} timeoutMs=${timeoutMs}`,
    );
    const list = await getRemoteClaudeProjectList(userId, serverId);
    const proj = list.find((p) => p && p.name === name);
    if (!proj) {
      console.warn(
        `${LOG_PFX} not_found userId=${userId} serverId=${serverId} projectName=${JSON.stringify(
          name,
        )} listCount=${list.length}`,
      );
      const e = new Error('Remote project not found');
      e.code = 'REMOTE_PROJECT_NOT_FOUND';
      throw e;
    }
    const resolved = typeof proj.fullPath === 'string' && proj.fullPath ? proj.fullPath : proj.path;
    if (!resolved || typeof resolved !== 'string' || !resolved.startsWith('/')) {
      console.warn(
        `${LOG_PFX} bad_cwd userId=${userId} serverId=${serverId} projectName=${JSON.stringify(name)} cwd=${JSON.stringify(
          resolved,
        )}`,
      );
      const e = new Error('Invalid project path on remote');
      e.code = 'REMOTE_PROJECT_PATH_INVALID';
      throw e;
    }
    cwd = resolved;
    label = name;
  }

  const script = buildOpenScript(cwd, projectPrompt);
  const r = await withRemoteSsh(userId, serverId, async ({ client }) => {
    return execBashTextResult(userId, serverId, client, script, timeoutMs, true);
  });

  const { code, stdout, stderr, timedOut } = r;
  const ms = Date.now() - t0;
  const olen = (stdout && stdout.length) || 0;
  const elen = (stderr && stderr.length) || 0;
  const logOut = olen > MAX_LOG_TAIL ? stdout.slice(olen - MAX_LOG_TAIL) : stdout || '';
  const logErr = elen > MAX_LOG_TAIL ? stderr.slice(elen - MAX_LOG_TAIL) : stderr || '';

  console.log(
    `${LOG_PFX} done mode=${mode} userId=${userId} serverId=${serverId} projectName=${JSON.stringify(
      label,
    )} cwd=${JSON.stringify(cwd)} exitCode=${code} timedOut=${Boolean(timedOut)} ms=${ms} stdout_len=${olen} stderr_len=${elen}`,
  );
  if (logOut) {
    console.log(`${LOG_PFX} stdout_tail (last ${MAX_LOG_TAIL} chars):\n${logOut}`);
  }
  if (logErr) {
    console.log(`${LOG_PFX} stderr_tail (last ${MAX_LOG_TAIL} chars):\n${logErr}`);
  }

  return {
    mode,
    projectName: label,
    cwd,
    prompt: projectPrompt,
    exitCode: code,
    timedOut: Boolean(timedOut),
    stdout: stdout || '',
    stderr: stderr || '',
  };
}
