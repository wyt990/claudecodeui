/**
 * One-shot SSH connectivity test (auth + exec) using ssh2.
 *
 * @module server/services/ssh-test-connection
 */

import crypto from 'crypto';
import { Client } from 'ssh2';

/**
 * @param {Buffer} hostKeyBuffer raw host key from ssh2 hostVerifier
 * @returns {string}
 */
export function sshHostKeyFingerprintSha256(hostKeyBuffer) {
  const digest = crypto.createHash('sha256').update(hostKeyBuffer).digest('base64');
  return `SHA256:${digest}`;
}

/**
 * @param {object} opts
 * @param {string} opts.host
 * @param {number} [opts.port]
 * @param {string} opts.username
 * @param {string} [opts.privateKey] PEM
 * @param {string} [opts.passphrase]
 * @param {string} [opts.password]
 * @returns {Promise<{ ok: true, hostKeyFingerprintSha256: string | null }>}
 */
const LOG = '[ssh-test-conn]';

/**
 * 安全摘要：不输出密钥/密码内容。
 * @param {object} cfg
 */
function logConnectSummary(cfg) {
  const hasPk = Boolean(cfg.privateKey);
  const hasPw = Boolean(cfg.password);
  const auth = hasPk ? 'private_key' : hasPw ? 'password' : 'none';
  console.log(
    `${LOG} connect: host=${cfg.host} port=${cfg.port} username=${cfg.username} auth=${auth} hasPassphrase=${Boolean(cfg.passphrase)} readyTimeout=25000`,
  );
}

export function testSshConnection(opts) {
  const {
    host,
    port = 22,
    username,
    privateKey,
    passphrase,
    password,
  } = opts;

  return new Promise((resolve, reject) => {
    const conn = new Client();
    let hostKeyFingerprintSha256 = null;
    const t0 = Date.now();
    // 建连 + 一次性 exec 共用：过短会导致慢网失败；主路径应在收到 exit/close 后立即结束
    const FULL_MS = 45000;
    const timer = setTimeout(() => {
      try {
        conn.end();
      } catch {
        /* ignore */
      }
      console.error(
        `${LOG} step=timeout after ${Date.now() - t0}ms (limit ${FULL_MS}ms) host=${host} port=${port}`,
      );
      reject(new Error('SSH connection timed out'));
    }, FULL_MS);

    const done = (fn) => {
      clearTimeout(timer);
      fn();
    };

    conn.on('ready', () => {
      const ms = Date.now() - t0;
      console.log(`${LOG} step=ready tcp+ssh+auth ok in ${ms}ms, exec "echo cloudcli_ssh_ok"`);
      conn.exec('echo cloudcli_ssh_ok', (err, stream) => {
        if (err) {
          console.error(`${LOG} step=exec_call_failed`, err?.message, err?.code);
          done(() => {
            try {
              conn.end();
            } catch {
              /* ignore */
            }
            reject(err);
          });
          return;
        }

        let settled = false;
        let stdoutChunks = 0;
        const stderrAcc = [];
        const finish = (onDone) => {
          if (settled) return;
          settled = true;
          done(onDone);
        };

        // 必须消费 stdout：不读时 push() 易背压，OpenSSH 侧可能阻塞在写、end/close 迟迟不触发
        // ssh2 的 close 在 utils.js 里会等 end；而 exit（exit-status）不依赖 end，应优先以 exit 判定成功
        stream.on('data', (d) => {
          stdoutChunks += 1;
          void d;
        });
        try {
          stream.setEncoding('utf8');
        } catch {
          /* ignore */
        }
        stream.on('end', () => {
          const ms = Date.now() - t0;
          console.log(`${LOG} step=exec_stdout_end chunks=${stdoutChunks} ${ms}ms since connect`);
        });

        stream.stderr.on('data', (d) => {
          stderrAcc.push(d.toString());
        });

        stream.on('exit', (exitCode, signal) => {
          const total = Date.now() - t0;
          const errText = stderrAcc.join('').trim();
          console.log(
            `${LOG} step=exec_exit_event code=${exitCode} signal=${signal != null ? signal : 'null'} stderr_len=${errText.length} totalMs=${total}`,
          );
          if (settled) return;
          if (exitCode === 0) {
            finish(() => {
              try {
                conn.end();
              } catch {
                /* ignore */
              }
              console.log(
                `${LOG} step=ok via exit=0 hostKeyFp=${hostKeyFingerprintSha256 || 'null'} totalMs=${Date.now() - t0}`,
              );
              resolve({ ok: true, hostKeyFingerprintSha256 });
            });
            return;
          }
          if (exitCode == null) {
            finish(() => {
              try {
                conn.end();
              } catch {
                /* ignore */
              }
              reject(
                new Error(
                  errText || `Remote process exited on signal: ${String(signal) || 'unknown'}`,
                ),
              );
            });
            return;
          }
          const msg = errText || `Remote shell exited with code ${exitCode}`;
          finish(() => {
            try {
              conn.end();
            } catch {
              /* ignore */
            }
            console.error(`${LOG} step=exec_fail code=${exitCode} stderr=${JSON.stringify(msg.slice(0, 200))}`);
            reject(new Error(msg));
          });
        });

        // 未收到 exit 时，close 仍可能带上退出码（依赖 ssh2 内部 _exit）
        stream.on('close', (code, signal) => {
          if (settled) return;
          const total = Date.now() - t0;
          const errText = stderrAcc.join('').trim();
          const codeStr = code == null && signal == null ? 'null' : String(code);
          const sigStr = signal == null ? 'null' : String(signal);
          console.log(`${LOG} step=exec_close_event codeArg=${codeStr} signal=${sigStr} totalMs=${total}`);
          if (code === 0) {
            finish(() => {
              try {
                conn.end();
              } catch {
                /* ignore */
              }
              console.log(
                `${LOG} step=ok via close code=0 hostKeyFp=${hostKeyFingerprintSha256 || 'null'} totalMs=${Date.now() - t0}`,
              );
              resolve({ ok: true, hostKeyFingerprintSha256 });
            });
            return;
          }
          if (code == null) {
            finish(() => {
              try {
                conn.end();
              } catch {
                /* ignore */
              }
              reject(
                new Error(
                  errText || `Remote channel closed (signal: ${String(signal) || 'unknown'})`,
                ),
              );
            });
            return;
          }
          const msg = errText || `Remote shell exited with code ${code}`;
          finish(() => {
            try {
              conn.end();
            } catch {
              /* ignore */
            }
            reject(new Error(msg));
          });
        });
      });
    });

    conn.on('error', (err) => {
      const e = err;
      console.error(
        `${LOG} step=client_error name=${e?.name || 'Error'} code=${e?.code ?? 'n/a'} level=${e?.level ?? 'n/a'} message=${e?.message || e}`,
      );
      done(() => reject(err));
    });

    const config = {
      host,
      port,
      username,
      readyTimeout: 25000,
      hostVerifier: (key, verify) => {
        try {
          const buf = Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'hex');
          hostKeyFingerprintSha256 = sshHostKeyFingerprintSha256(buf);
        } catch {
          hostKeyFingerprintSha256 = null;
        }
        verify(true);
      },
    };

    if (privateKey) {
      config.privateKey = privateKey;
      if (passphrase) {
        config.passphrase = passphrase;
      }
    }
    if (password) {
      config.password = password;
    }

    logConnectSummary(config);
    console.log(`${LOG} step=connecting`);
    conn.connect(config);
  });
}
