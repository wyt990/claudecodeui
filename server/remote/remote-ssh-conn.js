/**
 * 单次 SSH 建连（不区分池；P3 主连接经 remote-ssh-pool 复用）。
 * @module server/remote/remote-ssh-conn
 */

import { Client } from 'ssh2';
import { sshServersDb } from '../database/db.js';
import { decryptSecret } from '../utils/ssh-vault.js';

/**
 * @param {number} userId
 * @param {number} serverId
 */
export function loadSshConfig(userId, serverId) {
  const server = sshServersDb.getServer(userId, serverId);
  if (!server) {
    throw new Error('SSH server not found');
  }
  const blob = sshServersDb.getSecretBlob(userId, serverId);
  if (!blob) {
    const e = new Error('No credentials stored for this server');
    e.code = 'SSH_NO_SECRETS';
    throw e;
  }
  let secrets;
  try {
    secrets = JSON.parse(decryptSecret(blob));
  } catch {
    const e = new Error('Failed to decrypt credentials');
    e.code = 'SSH_DECRYPT_FAILED';
    throw e;
  }

  return {
    host: server.host,
    port: server.port || 22,
    username: server.username,
    authType: server.auth_type,
    privateKey: server.auth_type === 'private_key' ? secrets.privateKey : undefined,
    passphrase: server.auth_type === 'private_key' ? secrets.privateKeyPassphrase : undefined,
    password: server.auth_type === 'password' ? secrets.password : undefined,
  };
}

/**
 * @param {ReturnType<typeof loadSshConfig>} config
 * @returns {Promise<import('ssh2').Client>}
 */
export function connectSshClient(config) {
  const keepMs = Math.max(5_000, Number(process.env.CLOUDCLI_SSH_KEEPALIVE_MS || 30_000) || 30_000);
  const c = {
    host: config.host,
    port: config.port,
    username: config.username,
    readyTimeout: 45_000,
    keepAliveInterval: keepMs,
    keepAliveCountMax: 2,
  };
  if (config.privateKey) {
    c.privateKey = config.privateKey;
    if (config.passphrase) {
      c.passphrase = config.passphrase;
    }
  } else if (config.password) {
    c.password = config.password;
  } else {
    return Promise.reject(new Error('No SSH key or password'));
  }

  const conn = new Client();
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => {
      try {
        conn.end();
      } catch {
        /* */
      }
      reject(new Error('SSH connection timeout'));
    }, 46_000);
    conn
      .on('ready', () => {
        clearTimeout(to);
        resolve(conn);
      })
      .on('error', (e) => {
        clearTimeout(to);
        reject(e);
      })
      .connect(c);
  });
}
