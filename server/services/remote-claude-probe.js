/**
 * 远端 SSH 上探测 OS 与 claude / claudecode，并白名单化社区安装命令（与 docs §5 一致）。
 * @module server/services/remote-claude-probe
 */

import { acquirePooledSshClient } from '../remote/remote-ssh-pool.js';
import { execBashTextResult, execRawLineResult } from '../remote/remote-ssh.js';

const PROBE_TIMEOUT = Math.max(5_000, Math.min(60_000, Number(process.env.CLOUDCLI_SSH_CLAUDE_PROBE_TIMEOUT_MS) || 25_000) || 25_000);
const INSTALL_TIMEOUT = Math.max(60_000, Number(process.env.CLOUDCLI_SSH_INSTALL_TIMEOUT_MS) || 600_000) || 600_000;
/** 设为 0 可关闭 [remote-claude-probe] 的详细终端日志 */
const PROBE_LOG_ENABLED = process.env.CLOUDCLI_SSH_CLAUDE_PROBE_LOG !== '0';
const LOG_MAX = 8000;

/**
 * @param {string} s
 * @param {number} [max]
 */
function clip(s, max = LOG_MAX) {
  const t = s == null ? '' : String(s);
  if (t.length <= max) return t;
  return `${t.slice(0, max)}...[clipped, totalLen=${t.length}]`;
}

/**
 * @param {string} event
 * @param {Record<string, unknown> | string} [data]
 */
function probeLog(event, data) {
  if (!PROBE_LOG_ENABLED) return;
  if (data && typeof data === 'object') {
    console.log(`[remote-claude-probe] ${event}`, data);
  } else if (data != null) {
    console.log(`[remote-claude-probe] ${event}`, data);
  } else {
    console.log(`[remote-claude-probe] ${event}`);
  }
}

export const DEFAULT_BASE = 'https://raw.githubusercontent.com/wyt990/claude-code-haha/main';

/**
 * 子路径固定为 `install/install.sh`（与仓库布局一致）。若 `CLOUDCLI_REMOTE_INSTALL_BASE_URL` 或 UI 里误写为
 * 已含末尾 `/install`（如 `.../haha/main/install`），再拼 `install/install.sh` 会变成 `.../install/install/...` → 404。
 * 本函数把「多写一层 install」的基址规约到应指向 **main 树** 的那层。
 * @param {string} base
 * @returns {string} 以 `/` 结尾的基址
 */
function normalizeInstallBaseForChildScripts(base) {
  const s = (base || '').trim();
  if (!s) {
    return s;
  }
  const u = new URL(s.endsWith('/') ? s : `${s}/`);
  let p = u.pathname.replace(/\/$/, '') || '/';
  if (/\/install$/i.test(p) && p.length > 1) {
    p = p.replace(/\/install$/i, '') || '/';
  }
  if (p === '') {
    p = '/';
  }
  u.pathname = p === '/' || p === '' ? '/' : `${p}/`;
  return u.href;
}

/**
 * @param {string | undefined} fromEnv
 * @returns {string}
 */
function getInstallBaseUrlInternal(fromEnv) {
  const b0 = (fromEnv || process.env.CLOUDCLI_REMOTE_INSTALL_BASE_URL || DEFAULT_BASE).trim();
  if (!b0.startsWith('https://')) {
    throw new Error('CLOUDCLI_REMOTE_INSTALL_BASE_URL must be an https URL');
  }
  const u0 = new URL(b0);
  if (u0.protocol !== 'https:') {
    throw new Error('Install base must use https');
  }
  if (!isHostAllowedForInstall(u0.hostname)) {
    throw new Error(`Host not in CLOUDCLI_REMOTE_INSTALL_HOST_ALLOW: ${u0.hostname}`);
  }
  const n = normalizeInstallBaseForChildScripts(b0);
  return n;
}

/**
 * @param {string} host
 * @returns {boolean}
 */
function isHostAllowedForInstall(host) {
  const def = 'raw.githubusercontent.com';
  const raw = (process.env.CLOUDCLI_REMOTE_INSTALL_HOST_ALLOW || def).trim();
  const set = new Set(
    raw
      .split(/[,;]\s*|\s+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  return set.has(host.toLowerCase());
}

/**
 * @param {string | undefined} override
 * @returns {string}
 */
export function resolveAndValidateBaseUrl(override) {
  const b0 = (override && String(override).trim()) || (process.env.CLOUDCLI_REMOTE_INSTALL_BASE_URL || DEFAULT_BASE).trim();
  if (!b0.startsWith('https://')) {
    throw new Error('Install base URL must use https');
  }
  const n = normalizeInstallBaseForChildScripts(b0);
  const u = new URL(n);
  if (!isHostAllowedForInstall(u.hostname)) {
    throw new Error(`Host not in CLOUDCLI_REMOTE_INSTALL_HOST_ALLOW: ${u.hostname}`);
  }
  return n;
}

/**
 * @param {'unix' | 'win'} family
 * @param {'curl' | 'wget' | 'pwsh'} method
 * @param {string} base
 */
export function buildInstallLine(family, method, base) {
  const b = normalizeInstallBaseForChildScripts(base);
  if (family === 'win' || method === 'pwsh') {
    const url = new URL('install/install.ps1', b).href;
    return {
      kind: 'raw',
      line: `powershell -NoProfile -NonInteractive -Command "Set-ExecutionPolicy -Scope Process Bypass -Force; iex (irm -UseBasicParsing ${JSON.stringify(url)})"`,
    };
  }
  const shUrl = new URL('install/install.sh', b).href;
  if (method === 'wget') {
    return {
      kind: 'bash',
      line: `set -euo pipefail; wget -qO- ${JSON.stringify(shUrl)} | bash`,
    };
  }
  return {
    kind: 'bash',
    line: `set -euo pipefail; curl -fsSL ${JSON.stringify(shUrl)} | bash`,
  };
}

/**
 * @param {string} userLine
 * @param {string} base
 * @param {'curl' | 'wget' | 'pwsh'} method
 */
function validateUserInstallLine(userLine, base, method) {
  const fam = method === 'pwsh' ? 'win' : 'unix';
  const bNorm = normalizeInstallBaseForChildScripts(base);
  const built = buildInstallLine(fam, method, bNorm);
  if (userLine.replace(/\r/g, '').trim() === built.line.replace(/\r/g, '').trim()) {
    return built;
  }
  const t = userLine.replace(/\r/g, '').trim();
  const b = bNorm;
  const sh = new URL('install/install.sh', b).href;
  const ps1 = new URL('install/install.ps1', b).href;
  if (t.includes('curl') && t.includes('bash') && t.includes('https://') && t.includes(sh)) {
    return { kind: 'bash', line: t.startsWith('set -e') ? t : `set -euo pipefail; ${t}` };
  }
  if (t.includes('wget') && t.includes('bash') && t.includes('https://') && t.includes(sh)) {
    return { kind: 'bash', line: t.startsWith('set -e') ? t : `set -euo pipefail; ${t}` };
  }
  if (t.toLowerCase().includes('https://') && t.includes(ps1) && (t.toLowerCase().includes('irm') || t.toLowerCase().includes('iex') || t.toLowerCase().includes('powershell'))) {
    return { kind: 'raw', line: t };
  }
  throw new Error('Command does not match allowed install templates for the configured base URL');
}

/**
 * @param {number} userId
 * @param {number} serverId
 */
export async function probeRemoteClaudeEnv(userId, serverId) {
  probeLog('probe_start', { userId, serverId, PROBE_TIMEOUT });
  const { client, release } = await acquirePooledSshClient(userId, serverId);
  let base;
  try {
    base = getInstallBaseUrlInternal();
  } catch (e) {
    release();
    throw e;
  }
  try {
    /**
     * 单条**一行**、仅用 `;` 分句。探测**单独**用 `execBashTextResult(..., true)` → `bash -lic` 与单引号
     * 体，以匹配用户终端 PATH。安装脚本等仍用 `bash -lc`（勿让 `.bashrc` 的 echo 与 `$HOME` 等机器可读
     * 输出混在同一流里）。
     */
    const script =
      'U=$(uname -s 2>/dev/null || true);' +
      'C0=unix;W=0;[ -n "${OS:-}" ] && [ "$OS" = "Windows_NT" ] && W=1;' +
      'case $U in MINGW*) W=1;; MSYS*) W=1;; *CYGWIN*) W=1;; esac;' +
      '[ "$W" = "1" ] && C0=win;' +
      'A=$(command -v claudecode 2>/dev/null || true);' +
      'B=$(command -v claude 2>/dev/null || true);' +
      'printf "CCLI0:%s\\n" "$C0";' +
      'printf "CCLIU:%s\\n" "$U";' +
      'printf "CCLI1:%s\\n" "$A";' +
      'printf "CCLI2:%s\\n" "$B";' +
      'printf "CCLIP:%s\\n" "$PATH"';
    const r = await execBashTextResult(userId, serverId, client, script, PROBE_TIMEOUT, true);
    probeLog('probe_raw_exec', {
      userId,
      serverId,
      code: r.code,
      timedOut: r.timedOut,
      stdoutLen: (r.stdout || '').length,
      stderrLen: (r.stderr || '').length,
      stdout: clip((r.stdout || '').trim() || '(empty)'),
      stderr: clip((r.stderr || '').trim() || '(empty)'),
    });
    if (r.timedOut) {
      throw new Error('Remote claude probe timed out');
    }
    if (r.code != null && r.code !== 0) {
      const h = (r.stderr || r.stdout || '').trim().slice(0, 500);
      throw new Error(
        h ? `Remote claude probe failed (code ${r.code}): ${h}` : `Remote claude probe failed (code ${r.code})`,
      );
    }
    const out = (r.stdout || '') + (r.stderr || '');
    const lines = out
      .split('\n')
      .map((l) => l.replace(/\r$/, '').trim())
      .filter((l) => l.length > 0);
    probeLog('probe_lines', { userId, serverId, lineCount: lines.length, sample: lines.slice(0, 40) });
    let installFamily = 'unix';
    let uname = '';
    let fWin = false;
    let p1 = '';
    let p2 = '';
    let pathLine = '';
    for (const L of lines) {
      if (L.startsWith('CCLI0:')) {
        fWin = L.slice(6) === 'win';
        installFamily = fWin ? 'win' : 'unix';
      } else if (L.startsWith('CCLIU:')) {
        // 前缀 "CCLIU:" 为 6 个字符，勿用 slice(5) 否则会含前导 :（uname 变成 :Linux）
        uname = (L.length > 6 ? L.slice(6) : '').trim() || 'unknown';
      } else if (L.startsWith('CCLI1:')) {
        p1 = L.slice(6).trim();
      } else if (L.startsWith('CCLI2:')) {
        p2 = L.slice(6).trim();
      } else if (L.startsWith('CCLIP:')) {
        pathLine = L.slice(6);
      }
    }
    if (!uname) {
      uname = fWin ? 'windows' : 'linux';
    }
    const claudecodePath = p1 || null;
    const claudePath = p2 || null;
    const hasCli = Boolean((p1 && p1.length > 0) || (p2 && p2.length > 0));
    probeLog('probe_parsed', {
      userId,
      serverId,
      hasCli,
      claudecodePath: claudecodePath || null,
      claudePath: claudePath || null,
      installFamily,
      uname: uname || null,
      path: clip(pathLine, 2000) || null,
    });
    return {
      platform: uname,
      family: fWin ? 'windows' : uname && uname.toLowerCase().includes('darwin') ? 'darwin' : 'linux',
      installFamily,
      claudecodePath: claudecodePath || null,
      claudePath: claudePath || null,
      hasCli,
      homeConfigHint: '$HOME/.local/share/claude-code-local/.env',
      installBaseUrl: base,
      installCommands: {
        curl: buildInstallLine('unix', 'curl', base).line,
        wget: buildInstallLine('unix', 'wget', base).line,
        pwsh: buildInstallLine('win', 'pwsh', base).line,
      },
    };
  } catch (e) {
    probeLog('probe_error', {
      userId,
      serverId,
      err: e instanceof Error ? e.message : String(e),
    });
    throw e;
  } finally {
    release();
  }
}

/**
 * @param {number} userId
 * @param {number} serverId
 * @param {object} body
 */
export async function runRemoteClaudeInstall(userId, serverId, body) {
  const base = resolveAndValidateBaseUrl(body && body.baseUrl);
  const method = (body && body.method && String(body.method)) || 'curl';
  if (!['curl', 'wget', 'pwsh'].includes(method)) {
    throw new Error('method must be "curl", "wget", or "pwsh"');
  }
  const pre = await probeRemoteClaudeEnv(userId, serverId);
  if (pre.hasCli) {
    return { skipped: true, message: 'Claude or claudecode already on remote PATH', probe: pre, exitCode: 0, stdout: '', stderr: '' };
  }

  let spec;
  if (body && body.command && String(body.command).trim()) {
    spec = validateUserInstallLine(String(body.command), base, method);
  } else {
    if (pre.installFamily === 'win' || method === 'pwsh') {
      spec = buildInstallLine('win', 'pwsh', base);
    } else {
      spec = buildInstallLine('unix', method, base);
    }
  }

  const { client, release } = await acquirePooledSshClient(userId, serverId);
  try {
    if (spec.kind === 'bash') {
      return await execBashTextResult(userId, serverId, client, spec.line, INSTALL_TIMEOUT);
    }
    return await execRawLineResult(userId, serverId, client, spec.line, INSTALL_TIMEOUT);
  } finally {
    release();
  }
}

export { PROBE_TIMEOUT, INSTALL_TIMEOUT };
