/**
 * 远程 SSH 上执行 claude -p，stdout/stderr 以 stream_delta 推经 /ws（P2）。
 * @module server/remote/remote-claude-ssh-ws
 */

import { acquirePooledSshClient, takeExecSlot, releaseExecSlot } from './remote-ssh-pool.js';
import {
  isAcceptableRemoteFsPath,
  parseServerIdFromTargetKey,
  bashSingleQuote,
  REMOTE_SSH_BASH_PATH_BOOTSTRAP,
} from './remote-ssh-helpers.js';
import { createNormalizedMessage } from '../providers/types.js';
import { getRemoteClaudeSessionsForApi } from './remote-claude-data.js';
import { sshServerClaudeProviderPrefsDb } from '../database/db.js';
import { appendImagePathsToRemotePrompt, uploadRemoteClaudeImages } from './remote-claude-ssh-images.js';

const MAX_OUT = Math.max(1_000_000, Number(process.env.CLOUDCLI_REMOTE_CLAUDE_MAX_OUTPUT || 20 * 1024 * 1024) || 20 * 1024 * 1024);

/** 与 build-remote-tui-bash.js 中 --resume 所用 id 规则一致；排除前端占位 `new-session-*` */
const REMOTE_PRINT_RESUME_ID_RE = /^[a-zA-Z0-9_.\-:]+$/;

/**
 * @param {unknown} sessionId
 * @returns {string | null} 可传给 `claude --resume` 的 id，否则 null
 */
function remoteClaudePrintResumeId(sessionId) {
  if (sessionId == null) {
    return null;
  }
  const s = String(sessionId).trim();
  if (!s || s.startsWith('new-session-') || s.length > 280) {
    return null;
  }
  if (!REMOTE_PRINT_RESUME_ID_RE.test(s)) {
    return null;
  }
  return s;
}

function makeTargetKey(serverId) {
  return `remote:${serverId}`;
}

/**
 * 与 `server/claude-sdk.js` 中 `mapCliOptionsToSDK` 对齐：非 `default` 时为远端 CLI 生成 ` --permission-mode '…'` 片段。
 * 须与远端 `claudecode --help` 中 `--permission-mode` 的 choices 一致：
 * acceptEdits | bypassPermissions | default | dontAsk | plan（见官方/发行说明；此处不传 default）。
 * @param {{ permissionMode?: string, toolsSettings?: { skipPermissions?: boolean } }} options
 * @returns {string}
 */
function buildRemoteClaudePermissionModeCliSuffix(options) {
  if (!options || typeof options !== 'object') {
    return '';
  }
  let mode = String(options.permissionMode || 'default').trim() || 'default';
  const settings = options.toolsSettings || {};
  if (settings.skipPermissions && mode !== 'plan') {
    mode = 'bypassPermissions';
  }
  if (!mode || mode === 'default') {
    return '';
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(mode)) {
    return '';
  }
  const known = new Set(['acceptEdits', 'bypassPermissions', 'plan', 'dontAsk']);
  if (!known.has(mode)) {
    return '';
  }
  return ` --permission-mode ${bashSingleQuote(mode)}`;
}

/**
 * 与 `server/claude-sdk.js` 中 `mapCliOptionsToSDK` 对齐：把本地 `claude-settings` 随 `claude-command` 传来的
 * `allowedTools` / `disallowedTools` 转成远端 `claudecode -p` 的 `--allowed-tools` / `--disallowed-tools`。
 * （此前仅传了 `permissionMode`，未传工具名单，故设置里「已授权」在 SSH 远程不生效。）
 * @param {{ permissionMode?: string, toolsSettings?: { allowedTools?: string[], disallowedTools?: string[] } }} options
 * @returns {string}
 */
function buildRemoteClaudeAllowedDisallowedCliSuffix(options) {
  if (!options || typeof options !== 'object') {
    return '';
  }
  const settings = options.toolsSettings || {};
  const permissionMode = String(options.permissionMode || 'default').trim() || 'default';
  let allowedTools = [...(settings.allowedTools || [])];
  if (permissionMode === 'plan') {
    const planModeTools = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch'];
    for (const tool of planModeTools) {
      if (!allowedTools.includes(tool)) {
        allowedTools.push(tool);
      }
    }
  }
  const disallowedTools = [...(settings.disallowedTools || [])];
  let suffix = '';
  if (allowedTools.length > 0) {
    suffix += ` --allowed-tools ${bashSingleQuote(allowedTools.join(','))}`;
  }
  if (disallowedTools.length > 0) {
    suffix += ` --disallowed-tools ${bashSingleQuote(disallowedTools.join(','))}`;
  }
  return suffix;
}

/**
 * claude/claudecode 在非 TTY 下可能先往 stderr 打印「stdin 等待」类提示；远端脚本用 2>&1 合并进 stdout，
 * 否则会与模型正文一起进 stream_delta。配合 bash 侧 `< /dev/null` 可消除产生；此处再剥残留前缀。
 * @returns {(chunk: string) => string}
 */
function createRemoteClaudeStdoutPrefixFilter() {
  let buf = '';
  let passed = false;
  /** 中文：「3 秒内」等数字可能随版本变化 */
  const reCn = /^警告：\d+ 秒内未收到标准输入数据[\s\S]*?等待更长时间。\s*/;
  const reEnWarn = /^Warning:[^\n]{0,500}\n?/i;
  const reEnNoData = /^No data received within \d+ seconds[^\n]*\n?/i;

  return (chunk) => {
    if (passed) {
      return chunk;
    }
    buf += chunk;
    let m = buf.match(reCn);
    if (m) {
      buf = buf.slice(m[0].length);
      passed = true;
      return buf;
    }
    m = buf.match(reEnNoData);
    if (m) {
      buf = buf.slice(m[0].length);
      passed = true;
      return buf;
    }
    m = buf.match(reEnWarn);
    if (m && /stdin|input|pipe|continuing/i.test(m[0])) {
      buf = buf.slice(m[0].length);
      passed = true;
      return buf;
    }
    if (buf.length > 0) {
      const startsCnWarn = /^警告/.test(buf);
      if (!startsCnWarn && !/^Warn/i.test(buf) && !/^No data received/i.test(buf)) {
        passed = true;
        const out = buf;
        buf = '';
        return out;
      }
      if (buf.length >= 2 && buf[0] === '警' && buf[1] !== '告') {
        passed = true;
        const out = buf;
        buf = '';
        return out;
      }
    }
    if (buf.length > 2048) {
      passed = true;
      const out = buf;
      buf = '';
      return out;
    }
    return '';
  };
}

/** @type {Map<string, { stream: any, releaseAll: () => void }>} */
const active = new Map();

/**
 * @param {string} sessionId
 * @returns {boolean}
 */
export function isRemoteSshClaudeSessionActive(sessionId) {
  if (!sessionId) {
    return false;
  }
  return active.has(sessionId);
}

/**
 * @param {string} sessionId
 * @returns {boolean}
 */
export function abortRemoteSshClaudeSession(sessionId) {
  const a = sessionId && active.get(sessionId);
  if (!a) {
    return false;
  }
  try {
    a.stream?.close?.();
  } catch {
    /* */
  }
  try {
    a.releaseAll();
  } catch {
    /* */
  }
  active.delete(sessionId);
  return true;
}

/**
 * @param {{ userId: number, command: string, options: any, writer: { send: (d: any) => void } }} p
 * @returns {Promise<void>}
 */
export async function streamRemoteClaudePromptOverSsh({ userId, command, options, writer }) {
  let optionsMut = options && typeof options === 'object' ? { ...options } : {};
  const { projectPath, sessionId, model, targetKey, serverId: optSid, useRemoteSsh, projectName: optProjectName } = optionsMut;
  if (!useRemoteSsh) {
    return;
  }
  const serverId = optSid != null && Number.isFinite(optSid) ? optSid : parseServerIdFromTargetKey(targetKey);
  if (serverId == null || !Number.isFinite(serverId) || serverId < 1) {
    writer.send(
      createNormalizedMessage({ kind: 'error', content: 'Invalid serverId for remote Claude', sessionId, provider: 'claude' }),
    );
    return;
  }

  try {
    const row = sshServerClaudeProviderPrefsDb.get(userId, serverId);
    let extra = [];
    if (row?.remote_allowed_tools_json) {
      try {
        const j = JSON.parse(row.remote_allowed_tools_json);
        if (Array.isArray(j)) {
          extra = j.map((x) => String(x).trim()).filter(Boolean);
        }
      } catch {
        /* */
      }
    }
    if (extra.length > 0) {
      const ts = optionsMut.toolsSettings && typeof optionsMut.toolsSettings === 'object' ? { ...optionsMut.toolsSettings } : {};
      const base = Array.isArray(ts.allowedTools) ? [...ts.allowedTools] : [];
      for (const t of extra) {
        if (!base.includes(t)) {
          base.push(t);
        }
      }
      optionsMut = { ...optionsMut, toolsSettings: { ...ts, allowedTools: base } };
    }
  } catch {
    /* */
  }
  const tk = makeTargetKey(serverId);
  if (!isAcceptableRemoteFsPath(String(projectPath || ''))) {
    writer.send(
      createNormalizedMessage({ kind: 'error', content: 'Invalid remote project path', sessionId, provider: 'claude', targetKey: tk }),
    );
    return;
  }
  const cwd = String(projectPath).trim();
  const projectName = typeof optProjectName === 'string' ? optProjectName.trim() : '';
  const modelArg = (model && String(model).trim()) || '';

  const q = (s) => bashSingleQuote(s);
  const resumeId = remoteClaudePrintResumeId(sessionId);
  const permSuffix =
    buildRemoteClaudePermissionModeCliSuffix(optionsMut) + buildRemoteClaudeAllowedDisallowedCliSuffix(optionsMut);

  await takeExecSlot(userId, serverId);
  let acq;
  try {
    acq = await acquirePooledSshClient(userId, serverId);
  } catch (e) {
    releaseExecSlot(userId, serverId);
    throw e;
  }
  const { client, release: releasePooled } = acq;
  let released = false;
  const releaseAll = () => {
    if (released) {
      return;
    }
    released = true;
    try {
      releasePooled();
    } catch {
      /* */
    }
    try {
      releaseExecSlot(userId, serverId);
    } catch {
      /* */
    }
  };

  let promptBody = String(command ?? '');
  const hasImages = optionsMut?.images && Array.isArray(optionsMut.images) && optionsMut.images.length > 0;
  if (hasImages) {
    try {
      const { paths } = await uploadRemoteClaudeImages(userId, serverId, client, cwd, optionsMut.images);
      promptBody = appendImagePathsToRemotePrompt(promptBody, paths);
    } catch (e) {
      const msg = e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
      console.warn('[remote-claude-ssh-ws] remote image upload failed:', msg, e);
      releaseAll();
      writer.send(
        createNormalizedMessage({
          kind: 'error',
          content: msg || 'Remote image upload failed',
          sessionId,
          provider: 'claude',
          targetKey: tk,
        }),
      );
      return;
    }
  }

  const b64 = Buffer.from(promptBody, 'utf8').toString('base64');
  if (b64.length > 4_000_000) {
    releaseAll();
    writer.send(createNormalizedMessage({ kind: 'error', content: 'Prompt too large for remote', sessionId, provider: 'claude', targetKey: tk }));
    return;
  }

  // 有会话 id 时必须 `claude --resume <id> -p ...`，否则每次 -p 都是新会话（与本地 SDK resume 行为对齐）
  const scriptLines = [
    REMOTE_SSH_BASH_PATH_BOOTSTRAP,
    'set -euo pipefail',
    'cd ' + q(cwd) + ' || { echo "cd failed" >&2; exit 1; }',
    `PROMPT=$(printf '%s' '${b64}' | base64 -d)`,
    'CCLI=$(command -v claudecode 2>/dev/null || command -v claude 2>/dev/null) || { echo "claude or claudecode not in remote PATH" >&2; exit 1; }',
  ];
  if (resumeId) {
    scriptLines.push('RSID=' + q(resumeId));
    if (modelArg) {
      scriptLines.push('exec "$CCLI"' + permSuffix + ' --resume "$RSID" -p "$PROMPT" --model ' + q(modelArg) + ' < /dev/null 2>&1');
    } else {
      scriptLines.push('exec "$CCLI"' + permSuffix + ' --resume "$RSID" -p "$PROMPT" < /dev/null 2>&1');
    }
  } else if (modelArg) {
    scriptLines.push('exec "$CCLI"' + permSuffix + ' -p "$PROMPT" --model ' + q(modelArg) + ' < /dev/null 2>&1');
  } else {
    scriptLines.push('exec "$CCLI"' + permSuffix + ' -p "$PROMPT" < /dev/null 2>&1');
  }
  const fullScript = scriptLines.join('\n');

  const workSid = String(
    sessionId != null && String(sessionId).trim() !== ''
      ? sessionId
      : `remote-sess-${userId}-${serverId}-${Date.now()}`,
  );

  // eslint-disable-next-line consistent-return
  return new Promise((resolve) => {
    try {
      client.exec('bash -lic ' + q(fullScript), (err, stream) => {
        if (err || !stream) {
          releaseAll();
          writer.send(
            createNormalizedMessage({ kind: 'error', content: err ? err.message : 'Remote exec failed', sessionId, provider: 'claude', targetKey: tk }),
          );
          resolve();
          return;
        }
        active.set(workSid, { stream, releaseAll });

        let n = 0;
        const stripPrefix = createRemoteClaudeStdoutPrefixFilter();
        const onData = (buf) => {
          const t = buf.toString('utf8');
          n += t.length;
          if (n > MAX_OUT) {
            return;
          }
          const forwarded = stripPrefix(t);
          if (!forwarded) {
            return;
          }
          writer.send(
            createNormalizedMessage({ kind: 'stream_delta', content: forwarded, sessionId: workSid, provider: 'claude', targetKey: tk }),
          );
        };
        stream.on('data', onData);
        stream.on('close', async (code) => {
          active.delete(workSid);
          releaseAll();
          const ok = code == null || code === 0;
          // 须先用占位 workSid 结束流式，再发 session_created；否则 finalize 找不到 __streaming_* 槽位
          writer.send(createNormalizedMessage({ kind: 'stream_end', sessionId: workSid, provider: 'claude', targetKey: tk }));
          writer.send(
            createNormalizedMessage({
              kind: 'complete',
              exitCode: ok ? 0 : 1,
              sessionId: workSid,
              provider: 'claude',
              targetKey: tk,
            }),
          );
          if (ok && !resumeId && projectName) {
            try {
              const result = await getRemoteClaudeSessionsForApi(userId, serverId, projectName, 25, 0);
              const newest = result?.sessions?.[0];
              if (newest?.id && String(workSid).startsWith('new-session-')) {
                writer.send(
                  createNormalizedMessage({
                    kind: 'session_created',
                    newSessionId: newest.id,
                    sessionId: workSid,
                    provider: 'claude',
                    targetKey: tk,
                  }),
                );
              }
            } catch (e) {
              console.warn('[remote-claude-ssh-ws] session_created probe failed:', e?.message || e);
            }
          }
          resolve();
        });
      });
    } catch (e) {
      releaseAll();
      throw e;
    }
  });
}
