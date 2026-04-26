/**
 * SSH 连接 + SFTP（P3：主连接经 remote-ssh-pool 每 (userId, serverId) 复用）。
 * @module server/remote/remote-ssh
 */

import { getCachedRemoteHome, setCachedRemoteHome } from './remote-ssh-caches.js';
import {
  acquirePooledSshClient,
  takeExecSlot,
  releaseExecSlot,
  takeSftpSlot,
  releaseSftpSlot,
} from './remote-ssh-pool.js';

const EXEC_TIMEOUT_MS = Math.max(5_000, Number(process.env.CLOUDCLI_SSH_EXEC_TIMEOUT_MS || 20_000) || 20_000);
const INSTALL_LOG_CAP = Math.min(2 * 1024 * 1024, Number(process.env.CLOUDCLI_REMOTE_INSTALL_LOG_MAX || 500_000) || 500_000);

/**
 * 供 ssh2 `exec(整条命令)` 使用。OpenSSH 常见为 `/bin/sh -c "<你传的字符串>"`；若用
 * `bash ... ${JSON.stringify(…)}`，**双引号**里的 `$U` 会被**外层** sh 先展开（常为「空」），
 * 于是 bash 收到 `case  in` 而报错。用 POSIX 单引号整段包给 `bash` 的 `-c` 脚本体，外 sh 不展开，仅 bash 解析。
 * @param {string} script
 */
function shSingleQuoteBashCArg(script) {
  if (script.includes('\0')) {
    throw new Error('NUL in bash -c script is not allowed');
  }
  return `'${script.replace(/'/g, `'"'"'`)}'`;
}

export { loadSshConfig, connectSshClient } from './remote-ssh-conn.js';

/**
 * 在**已建连**的 `client` 上执行 `bash`；不结束 `client`；超时只关闭本次 exec 流。
 * 默认 **`bash -lc`（非交互登录）**，stdout 干净，适合 `echo -n $HOME`、安装脚本等，勿被 `.bashrc` 的 echo 污染。
 * 调用方应已 `takeExecSlot`（与 releaseExecSlot 在 stream 结束或超时路径成对）。
 * @param {import('ssh2').Client} client
 * @param {string} cmd
 */
function execBashTextOnPooledClient(client, cmd) {
  return new Promise((resolve, reject) => {
    const full = `bash -lc ${shSingleQuoteBashCArg(cmd)}`;
    const to = setTimeout(() => {
      try {
        if (st) {
          st.removeAllListeners();
        }
        if (typeof st?.close === 'function') {
          st.close();
        } else if (typeof st?.destroy === 'function') {
          st.destroy();
        }
      } catch {
        /* */
      }
      reject(new Error('Remote exec timeout'));
    }, EXEC_TIMEOUT_MS);
    /** @type {import('ssh2').ClientChannel | null} */
    let st = null;
    client.exec(full, (err, stream) => {
      st = stream;
      if (err) {
        clearTimeout(to);
        reject(err);
        return;
      }
      if (!stream) {
        clearTimeout(to);
        reject(new Error('No exec stream'));
        return;
      }
      let out = '';
      let errBuf = '';
      stream.on('data', (d) => {
        out += d.toString();
      });
      stream.stderr.on('data', (d) => {
        errBuf += d.toString();
      });
      stream.on('close', (code) => {
        clearTimeout(to);
        if (code !== 0) {
          reject(new Error(errBuf || `Remote exec code ${code}`));
          return;
        }
        resolve(out.trim());
      });
    });
  });
}

/**
 * @param {import('ssh2').Client} client
 * @param {number} userId
 * @param {number} serverId
 * @param {string} cmd
 */
export async function execBashText(userId, serverId, client, cmd) {
  await takeExecSlot(userId, serverId);
  try {
    return await execBashTextOnPooledClient(client, cmd);
  } finally {
    releaseExecSlot(userId, serverId);
  }
}

/**
 * 在 `client` 上 `bash`；不 reject 于非零 code；带超时。`useInteractiveBash` 为 true 时用
 * **`bash -lic`（交互 + 登录）**，与文档 §5 的 PATH 探测一致，使 `command -v` 与终端一致，但
 * 勿用于「整段 stdout 须机器可读」的命令（`bash -lic` 的启动脚本可能向 stdout 写内容）。
 * @param {import('ssh2').Client} client
 * @param {string} cmd
 * @param {number} timeoutMs
 * @param {boolean} [useInteractiveBash]
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, timedOut: boolean }>}
 */
function execBashTextOnPooledClientResult(client, cmd, timeoutMs, useInteractiveBash) {
  return new Promise((resolve, reject) => {
    const shell = useInteractiveBash ? 'bash -lic' : 'bash -lc';
    const full = `${shell} ${shSingleQuoteBashCArg(cmd)}`;
    /** @type {ReturnType<setTimeout> | null} */
    let to = null;
    let settled = false;
    /** @type {import('ssh2').ClientChannel | null} */
    let st = null;

    const finish = (code, out, errBuf, timed) => {
      if (settled) return;
      settled = true;
      if (to) clearTimeout(to);
      resolve({ code: code == null ? null : code, stdout: out, stderr: errBuf, timedOut: Boolean(timed) });
    };

    to = setTimeout(() => {
      try {
        if (st) {
          st.removeAllListeners();
        }
        if (typeof st?.close === 'function') {
          st.close();
        } else if (typeof st?.destroy === 'function') {
          st.destroy();
        }
      } catch {
        /* */
      }
      finish(-1, '', 'Remote exec timeout', true);
    }, timeoutMs);

    client.exec(full, (err, stream) => {
      st = stream;
      if (err) {
        if (to) clearTimeout(to);
        reject(err);
        return;
      }
      if (!stream) {
        if (to) clearTimeout(to);
        reject(new Error('No exec stream'));
        return;
      }
      let out = '';
      let errBuf = '';
      try {
        stream.setEncoding('utf8');
      } catch {
        /* */
      }
      stream.on('data', (d) => {
        out += d.toString();
        if (out.length > INSTALL_LOG_CAP) {
          out = '...[log truncated]...\n' + out.slice(-(INSTALL_LOG_CAP - 40));
        }
      });
      try {
        stream.stderr.setEncoding('utf8');
      } catch {
        /* */
      }
      stream.stderr.on('data', (d) => {
        errBuf += d.toString();
        if (errBuf.length > INSTALL_LOG_CAP) {
          errBuf = '...[log truncated]...\n' + errBuf.slice(-(INSTALL_LOG_CAP - 40));
        }
      });
      stream.on('error', (e) => {
        if (!settled) finish(-1, out, errBuf + (e && e.message ? e.message : String(e)), false);
      });
      stream.on('close', (code) => {
        finish(typeof code === 'number' ? code : 0, out, errBuf, false);
      });
    });
  });
}

/**
 * @param {import('ssh2').Client} client
 * @param {string} line
 * @param {number} timeoutMs
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, timedOut: boolean }>}
 */
function execRawLineOnPooledClientResult(client, line, timeoutMs) {
  return new Promise((resolve, reject) => {
    /** @type {ReturnType<setTimeout> | null} */
    let to = null;
    let settled = false;
    let st = null;
    const finish = (code, out, errBuf, timed) => {
      if (settled) return;
      settled = true;
      if (to) clearTimeout(to);
      resolve({ code: code == null ? null : code, stdout: out, stderr: errBuf, timedOut: Boolean(timed) });
    };
    to = setTimeout(() => {
      try {
        if (st) {
          st.removeAllListeners();
        }
        if (typeof st?.close === 'function') {
          st.close();
        } else if (typeof st?.destroy === 'function') {
          st.destroy();
        }
      } catch {
        /* */
      }
      finish(-1, '', 'Remote exec timeout', true);
    }, timeoutMs);

    client.exec(line, (err, stream) => {
      st = stream;
      if (err) {
        if (to) clearTimeout(to);
        reject(err);
        return;
      }
      if (!stream) {
        if (to) clearTimeout(to);
        reject(new Error('No exec stream'));
        return;
      }
      let out = '';
      let errBuf = '';
      try {
        stream.setEncoding('utf8');
      } catch {
        /* */
      }
      stream.on('data', (d) => {
        out += d.toString();
        if (out.length > INSTALL_LOG_CAP) {
          out = out.slice(0, INSTALL_LOG_CAP) + '\n[log truncated]';
        }
      });
      try {
        stream.stderr.setEncoding('utf8');
      } catch {
        /* */
      }
      stream.stderr.on('data', (d) => {
        errBuf += d.toString();
        if (errBuf.length > INSTALL_LOG_CAP) {
          errBuf = errBuf.slice(0, INSTALL_LOG_CAP) + '\n[log truncated]';
        }
      });
      stream.on('error', (e) => {
        if (!settled) finish(-1, out, errBuf + (e && e.message ? e.message : String(e)), false);
      });
      stream.on('close', (code) => {
        finish(typeof code === 'number' ? code : 0, out, errBuf, false);
      });
    });
  });
}

/**
 * 见 `execBashTextOnPooledClientResult`。`useInteractiveBash` 为 true 时用 `bash -lic`（远端的 `command -v` 等）。
 * @param {number} userId
 * @param {number} serverId
 * @param {import('ssh2').Client} client
 * @param {string} cmd
 * @param {number} timeoutMs
 * @param {boolean} [useInteractiveBash] 为 true 时用 `bash -lic`；缺省/ false 为 `bash -lc`（安装脚本等）
 */
export async function execBashTextResult(userId, serverId, client, cmd, timeoutMs, useInteractiveBash) {
  await takeExecSlot(userId, serverId);
  try {
    return await execBashTextOnPooledClientResult(client, cmd, timeoutMs, useInteractiveBash === true);
  } finally {
    releaseExecSlot(userId, serverId);
  }
}

/**
 * 不包 bash，用于 Windows PowerShell 等单条命令（非交互）。
 * @param {number} userId
 * @param {number} serverId
 * @param {import('ssh2').Client} client
 * @param {string} line
 * @param {number} timeoutMs
 */
export async function execRawLineResult(userId, serverId, client, line, timeoutMs) {
  await takeExecSlot(userId, serverId);
  try {
    return await execRawLineOnPooledClientResult(client, line, timeoutMs);
  } finally {
    releaseExecSlot(userId, serverId);
  }
}

/**
 * @param {import('ssh2').Client} client
 * @param {number} userId
 * @param {number} serverId
 */
/**
 * 从 `echo -n $HOME` 的 stdout 取**最后一行**且以 `/` 开头的段，防 `.bashrc`/banner 在交互
 * shell 中弄脏 stdout 时把「欢迎语」与路径拼在一起（历史：勿对机器可读命令用 `bash -lic`）。
 * @param {string} raw
 * @returns {string}
 */
function pickRemoteHomePathFromExecOutput(raw) {
  const s = (raw || '').replace(/\r/g, '');
  const lines = s.split('\n').map((l) => l.trimEnd()).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const l = lines[i];
    if (l.length > 0 && l[0] === '/' && l.length < 4096) {
      return l;
    }
  }
  const one = s.trim();
  if (one.length > 0 && one[0] === '/') {
    return one.split('\n').pop().trim() || one;
  }
  return '';
}

export async function getRemoteHomeDir(client, userId, serverId) {
  const c = getCachedRemoteHome(userId, serverId);
  if (c) {
    return c;
  }
  const out = await execBashText(userId, serverId, client, 'echo -n $HOME');
  const home = pickRemoteHomePathFromExecOutput(out);
  if (!home) {
    console.error('[remote-ssh] getRemoteHomeDir bad output (first 200 chars):', (out || '').slice(0, 200));
    throw new Error('Could not resolve remote $HOME');
  }
  setCachedRemoteHome(userId, serverId, home);
  return home;
}

/**
 * 在已池化的 `client` 上打开 SFTP 子通道（带并发槽位）。
 * @param {number} userId
 * @param {number} serverId
 * @param {import('ssh2').Client} client
 * @param {(sftp: import('ssh2').SFTPWrapper) => Promise<unknown> | unknown} work
 */
export function withSftpStream(userId, serverId, client, work) {
  return new Promise((resolve, reject) => {
    takeSftpSlot(userId, serverId)
      .then(() => {
        const finishOk = (v) => {
          releaseSftpSlot(userId, serverId);
          resolve(v);
        };
        const finishErr = (e) => {
          releaseSftpSlot(userId, serverId);
          reject(e);
        };
        try {
          client.sftp((e, sftp) => {
            if (e) {
              finishErr(e);
              return;
            }
            Promise.resolve(work(sftp))
              .then((v) => {
                try {
                  sftp.end();
                } catch {
                  /* */
                }
                finishOk(v);
              })
              .catch((er) => {
                try {
                  sftp.end();
                } catch {
                  /* */
                }
                finishErr(er);
              });
          });
        } catch (err) {
          releaseSftpSlot(userId, serverId);
          reject(err);
        }
      })
      .catch(reject);
  });
}

/**
 * @param {number} userId
 * @param {number} serverId
 * @param {({ client: import('ssh2').Client, sftp: import('ssh2').SFTPWrapper, home: string }) => Promise<unknown> | unknown} run
 */
export async function withRemoteSsh(userId, serverId, run) {
  const { client, release } = await acquirePooledSshClient(userId, serverId);
  try {
    const home = await getRemoteHomeDir(client, userId, serverId);
    return await withSftpStream(userId, serverId, client, (sftp) => run({ client, sftp, home }));
  } finally {
    release();
  }
}