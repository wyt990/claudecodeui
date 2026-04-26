/**
 * 远程 SSH 上执行 claude -p，stdout/stderr 以 stream_delta 推经 /ws（P2）。
 * @module server/remote/remote-claude-ssh-ws
 */

import { acquirePooledSshClient, takeExecSlot, releaseExecSlot } from './remote-ssh-pool.js';
import { isAcceptableRemoteFsPath, parseServerIdFromTargetKey, bashSingleQuote } from './remote-ssh-helpers.js';
import { createNormalizedMessage } from '../providers/types.js';

const MAX_OUT = Math.max(1_000_000, Number(process.env.CLOUDCLI_REMOTE_CLAUDE_MAX_OUTPUT || 20 * 1024 * 1024) || 20 * 1024 * 1024);

function makeTargetKey(serverId) {
  return `remote:${serverId}`;
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
  const { projectPath, sessionId, model, targetKey, serverId: optSid, useRemoteSsh } = options;
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
  const tk = makeTargetKey(serverId);
  if (!isAcceptableRemoteFsPath(String(projectPath || ''))) {
    writer.send(
      createNormalizedMessage({ kind: 'error', content: 'Invalid remote project path', sessionId, provider: 'claude', targetKey: tk }),
    );
    return;
  }
  if (options?.images && Array.isArray(options.images) && options.images.length) {
    writer.send(
      createNormalizedMessage({
        kind: 'error',
        content: 'Remote mode does not support image upload yet. Remove images or use local target.',
        sessionId,
        provider: 'claude',
        targetKey: tk,
      }),
    );
    return;
  }

  const b64 = Buffer.from(String(command), 'utf8').toString('base64');
  const cwd = String(projectPath).trim();
  const modelArg = (model && String(model).trim()) || '';

  const q = (s) => bashSingleQuote(s);
  // claude -p 打印流；会话恢复交由 CLI/远端 JSONL 侧处理（P2 先不拼 --continue，减少版本差异）
  const scriptLines = [
    'set -euo pipefail',
    'cd ' + q(cwd) + ' || { echo "cd failed" >&2; exit 1; }',
    `PROMPT=$(printf '%s' '${b64}' | base64 -d)`,
    'CCLI=$(command -v claudecode 2>/dev/null || command -v claude 2>/dev/null) || { echo "claude or claudecode not in remote PATH" >&2; exit 1; }',
  ];
  if (modelArg) {
    scriptLines.push('exec "$CCLI" -p "$PROMPT" --model ' + q(modelArg) + ' 2>&1');
  } else {
    scriptLines.push('exec "$CCLI" -p "$PROMPT" 2>&1');
  }
  const fullScript = scriptLines.join('\n');
  if (b64.length > 4_000_000) {
    writer.send(createNormalizedMessage({ kind: 'error', content: 'Prompt too large for remote', sessionId, provider: 'claude', targetKey: tk }));
    return;
  }

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
        const onData = (buf) => {
          const t = buf.toString('utf8');
          n += t.length;
          if (n > MAX_OUT) {
            return;
          }
          writer.send(
            createNormalizedMessage({ kind: 'stream_delta', content: t, sessionId: workSid, provider: 'claude', targetKey: tk }),
          );
        };
        stream.on('data', onData);
        stream.on('close', (code) => {
          active.delete(workSid);
          releaseAll();
          writer.send(createNormalizedMessage({ kind: 'stream_end', sessionId: workSid, provider: 'claude', targetKey: tk }));
          writer.send(
            createNormalizedMessage({
              kind: 'complete',
              exitCode: code == null || code === 0 ? 0 : 1,
              sessionId: workSid,
              provider: 'claude',
              targetKey: tk,
            }),
          );
          resolve();
        });
      });
    } catch (e) {
      releaseAll();
      throw e;
    }
  });
}
