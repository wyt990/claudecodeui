/**
 * 每 (userId, serverId) 一条 SSH 主连接复用；空闲回收；exec/SFTP 并发限流；失败退避。
 * @module server/remote/remote-ssh-pool
 */

import { loadSshConfig, connectSshClient } from './remote-ssh-conn.js';
import { clearCachedRemoteHome } from './remote-ssh-caches.js';

const IDLE_MS = Math.max(10_000, Number(process.env.CLOUDCLI_SSH_IDLE_MS || 120_000) || 120_000);
const MAX_EXEC = Math.max(1, Number(process.env.CLOUDCLI_SSH_MAX_CONCURRENT_EXEC || 8) || 8);
const MAX_SFTP = Math.max(1, Number(process.env.CLOUDCLI_SSH_MAX_CONCURRENT_SFTP || 4) || 4);
const RECONNECT_BACKOFF_MAX_MS = 30_000;
const RECONNECT_BACKOFF_STEPS = [1_000, 5_000, 30_000];

/**
 * @param {number} userId
 * @param {number} serverId
 */
function poolKey(userId, serverId) {
  return `${userId}:${serverId}`;
}

class SlotGate {
  /** @param {number} max */
  constructor(max) {
    this.max = max;
    this.inFlight = 0;
    /** @type {Array<() => void>} */
    this.waiting = [];
  }

  /**
   * @returns {Promise<void>}
   */
  async acquire() {
    if (this.inFlight < this.max) {
      this.inFlight++;
      return;
    }
    await new Promise((res) => this.waiting.push(res));
    this.inFlight++;
  }

  release() {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const next = this.waiting.shift();
    if (next) {
      next();
    }
  }
}

/** @type {Map<string, SlotGate>} */
const execGates = new Map();
/** @type {Map<string, SlotGate>} */
const sftpGates = new Map();

/**
 * @param {Map<string, SlotGate>} map
 * @param {string} key
 * @param {number} max
 */
function getGate(map, key, max) {
  let g = map.get(key);
  if (!g) {
    g = new SlotGate(max);
    map.set(key, g);
  }
  return g;
}

/**
 * @param {number} userId
 * @param {number} serverId
 * @returns {Promise<void>}
 */
export async function takeExecSlot(userId, serverId) {
  return getGate(execGates, poolKey(userId, serverId), MAX_EXEC).acquire();
}

/**
 * @param {number} userId
 * @param {number} serverId
 */
export function releaseExecSlot(userId, serverId) {
  getGate(execGates, poolKey(userId, serverId), MAX_EXEC).release();
}

/**
 * @param {number} userId
 * @param {number} serverId
 * @returns {Promise<void>}
 */
export async function takeSftpSlot(userId, serverId) {
  return getGate(sftpGates, poolKey(userId, serverId), MAX_SFTP).acquire();
}

/**
 * @param {number} userId
 * @param {number} serverId
 */
export function releaseSftpSlot(userId, serverId) {
  getGate(sftpGates, poolKey(userId, serverId), MAX_SFTP).release();
}

class PoolEntry {
  constructor() {
    /** @type {import('ssh2').Client | null} */
    this.client = null;
    this.refCount = 0;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.idleTimer = null;
    this.connecting = null;
    this.reconnectStreak = 0;
  }
}

/** @type {Map<string, PoolEntry>} */
const pool = new Map();

/**
 * @param {string} k
 * @param {number} userId
 * @param {number} serverId
 * @param {PoolEntry} entry
 * @param {import('ssh2').Client} client
 */
function bindClientLifecycle(userId, serverId, entry, client) {
  const onDead = () => {
    if (entry.client !== client) {
      return;
    }
    entry.client = null;
    clearCachedRemoteHome(userId, serverId);
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  };

  client.once('error', onDead);
  client.once('end', onDead);
}

/**
 * @param {string} k
 * @param {number} userId
 * @param {number} serverId
 * @param {PoolEntry} e
 */
function scheduleIdle(k, userId, serverId, e) {
  if (e.idleTimer) {
    clearTimeout(e.idleTimer);
  }
  e.idleTimer = setTimeout(() => {
    e.idleTimer = null;
    if (e.refCount > 0) {
      return;
    }
    if (e.client) {
      try {
        e.client.removeAllListeners();
        e.client.end();
      } catch {
        /* */
      }
    }
    e.client = null;
    pool.delete(k);
  }, IDLE_MS);
}

/**
 * @param {string} k
 * @param {number} userId
 * @param {number} serverId
 * @param {PoolEntry} e
 */
function cancelIdle(k, e) {
  if (e.idleTimer) {
    clearTimeout(e.idleTimer);
    e.idleTimer = null;
  }
}

/**
 * @param {string} k
 * @param {number} userId
 * @param {number} serverId
 * @param {PoolEntry} e
 * @returns {Promise<import('ssh2').Client>}
 */
async function getOrConnectClient(k, userId, serverId, e) {
  if (e.client) {
    return e.client;
  }
  if (e.connecting) {
    return e.connecting;
  }
  e.connecting = (async () => {
    if (e.reconnectStreak > 0) {
      const i = Math.min(e.reconnectStreak - 1, RECONNECT_BACKOFF_STEPS.length - 1);
      const ms = Math.min(RECONNECT_BACKOFF_STEPS[i] || RECONNECT_BACKOFF_MAX_MS, RECONNECT_BACKOFF_MAX_MS);
      await new Promise((r) => setTimeout(r, ms));
    }
    const config = loadSshConfig(userId, serverId);
    const c = await connectSshClient(config);
    e.reconnectStreak = 0;
    e.client = c;
    bindClientLifecycle(userId, serverId, e, c);
    return c;
  })();
  try {
    const c = await e.connecting;
    return c;
  } catch (err) {
    e.reconnectStreak = Math.min(e.reconnectStreak + 1, 10);
    throw err;
  } finally {
    e.connecting = null;
  }
}

/**
 * 获取池化 SSH 主连接。调用方在逻辑结束时**必须**调用 `release`（与 acquire 成对，含流异常路径）。
 * @param {number} userId
 * @param {number} serverId
 * @returns {Promise<{ client: import('ssh2').Client, release: () => void }>}
 */
export async function acquirePooledSshClient(userId, serverId) {
  const k = poolKey(userId, serverId);
  let e = pool.get(k);
  if (!e) {
    e = new PoolEntry();
    pool.set(k, e);
  }
  cancelIdle(k, e);
  e.refCount += 1;

  try {
    const client = await getOrConnectClient(k, userId, serverId, e);
    return {
      client,
      release: () => {
        e.refCount = Math.max(0, e.refCount - 1);
        if (e.refCount === 0) {
          scheduleIdle(k, userId, serverId, e);
        }
      },
    };
  } catch (err) {
    e.refCount = Math.max(0, e.refCount - 1);
    if (e.refCount === 0) {
      scheduleIdle(k, userId, serverId, e);
    }
    throw err;
  }
}

export { MAX_EXEC, MAX_SFTP, IDLE_MS };
