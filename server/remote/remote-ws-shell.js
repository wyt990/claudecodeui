/**
 * 远程交互式 shell：SSH2 exec + PTY，经 /shell WebSocket 与 xterm 桥接（P2）。
 * @module server/remote/remote-ws-shell
 */

import { acquirePooledSshClient, takeExecSlot, releaseExecSlot } from './remote-ssh-pool.js';
import { buildRemoteTuiInnerBash } from './build-remote-tui-bash.js';
import { isAcceptableRemoteFsPath, parseServerIdFromTargetKey, bashSingleQuote } from './remote-ssh-helpers.js';

/**
 * @param {import('ws').WebSocket} _ws
 * @param {number} userId
 * @param {object} data init 报文
 * @returns {Promise<{ client: import('ssh2').Client, stream: import('ssh2').ClientChannel, targetKey: string, releaseSession: () => void }>}
 */
export async function startRemoteShellPtyOnWebSocket(_ws, userId, data) {
  const targetKey = typeof data.targetKey === 'string' ? data.targetKey : '';
  const serverId = parseServerIdFromTargetKey(targetKey) ?? (Number.isFinite(data.serverId) ? Number(data.serverId) : null);
  if (!serverId) {
    throw new Error('Remote shell requires targetKey=remote:<id> or serverId');
  }

  const projectPath = typeof data.projectPath === 'string' ? data.projectPath.trim() : '';
  if (!isAcceptableRemoteFsPath(projectPath)) {
    throw new Error('Invalid remote projectPath');
  }

  const built = buildRemoteTuiInnerBash({
    isPlainShell: Boolean(data.isPlainShell),
    initialCommand: data.initialCommand,
    provider: (data.provider && String(data.provider)) || 'claude',
    hasSession: Boolean(data.hasSession),
    sessionId: data.sessionId || null,
  });
  if ('error' in built) {
    throw new Error(built.error);
  }

  const fullScript = [
    'set -euo pipefail',
    `cd ${bashSingleQuote(projectPath)}` + ' || { echo "cd failed" >&2; exit 1; }',
    built.script,
  ].join('\n');

  const cols = Number(data.cols) > 0 ? Number(data.cols) : 80;
  const rows = Number(data.rows) > 0 ? Number(data.rows) : 24;

  await takeExecSlot(userId, serverId);
  let acq;
  try {
    acq = await acquirePooledSshClient(userId, serverId);
  } catch (e) {
    releaseExecSlot(userId, serverId);
    throw e;
  }
  const { client, release: releasePooled } = acq;
  const releaseSession = () => {
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

  return new Promise((resolve, reject) => {
    client.exec(`bash -lc ${bashSingleQuote(fullScript)}`, { pty: { term: 'xterm-256color', cols, rows } }, (err, stream) => {
      if (err) {
        releaseSession();
        reject(err);
        return;
      }
      if (!stream) {
        releaseSession();
        reject(new Error('No SSH stream'));
        return;
      }
      resolve({ client, stream, targetKey: `remote:${serverId}`, releaseSession });
    });
  });
}

/**
 * 桥接流：将 SSH stream 与 WebSocket 双向连接；返回 dispose。
 * P3：不结束主 SSH 连接，仅 `releaseSession`（还 exec 槽、池化引用）以复用同机连接。
 * @param {import('ws').WebSocket} ws
 * @param {import('stream').Readable & import('stream').Writable & { setWindow?: (rows, cols) => void }} stream
 * @param {string} targetKey
 * @param {() => void} releaseSession 还池化 + exec 槽（可多次调，内部幂等）
 * @param {(buf: string) => void} [onBinaryChunk]
 * @returns {() => void}
 */
export function wireRemoteShellStreamToWebSocket(ws, stream, targetKey, releaseSession, onBinaryChunk) {
  const toWs = (kind, rest) => {
    if (ws.readyState === 1) {
      try {
        ws.send(JSON.stringify({ type: kind, targetKey, ...rest }));
      } catch {
        /* */
      }
    }
  };

  const onData = (buf) => {
    const d = buf.toString('utf8');
    toWs('output', { data: d });
    onBinaryChunk?.(d);
  };

  let released = false;
  const releaseOnce = () => {
    if (released) {
      return;
    }
    released = true;
    try {
      releaseSession();
    } catch {
      /* */
    }
  };

  stream.on('data', onData);

  stream.on('close', (code) => {
    toWs('output', {
      data: `\r\n\x1b[33m[Remote shell exited: ${code ?? 0}]\x1b[0m\r\n`,
    });
    releaseOnce();
  });

  const dispose = () => {
    try {
      stream.removeListener('data', onData);
      stream.stderr?.removeListener('data', onData);
    } catch {
      /* */
    }
    try {
      stream.end?.();
    } catch {
      /* */
    }
    releaseOnce();
  };

  return dispose;
}

/**
 * 发送终端列行到 SSH stream
 * @param {any} stream
 * @param {number} rows
 * @param {number} cols
 */
export function applyRemotePtySize(stream, rows, cols) {
  if (typeof stream.setWindow === 'function') {
    try {
      stream.setWindow(rows, cols, 500, 200);
    } catch {
      /* */
    }
  }
}

/**
 * 写入用户输入
 * @param {any} stream
 * @param {string} data
 */
export function writeToRemotePtyStream(stream, data) {
  if (typeof data !== 'string' || !data) {
    return;
  }
  try {
    if (stream.write) {
      stream.write(data, 'utf8');
    } else {
      stream.end?.(data);
    }
  } catch {
    /* */
  }
}
