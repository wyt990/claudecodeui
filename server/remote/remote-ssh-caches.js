/**
 * 跨 P3 SSH 连接池的轻量进程内缓存，连接失效时由池清空 $HOME 缓存。
 * @module server/remote/remote-ssh-caches
 */

const homeByServer = new Map();
/** 解析 $HOME 逻辑变更时 bump，避免沿用脏缓存 */
const HOME_CACHE_VER = 2;

/**
 * @param {number} userId
 * @param {number} serverId
 */
export function getCachedRemoteHome(userId, serverId) {
  return homeByServer.get(`${userId}:${serverId}:v${HOME_CACHE_VER}`);
}

/**
 * @param {number} userId
 * @param {number} serverId
 * @param {string} home
 */
export function setCachedRemoteHome(userId, serverId, home) {
  homeByServer.set(`${userId}:${serverId}:v${HOME_CACHE_VER}`, home);
}

/**
 * @param {number} userId
 * @param {number} serverId
 */
export function clearCachedRemoteHome(userId, serverId) {
  homeByServer.delete(`${userId}:${serverId}:v${HOME_CACHE_VER}`);
}
