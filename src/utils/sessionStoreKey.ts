import { getTargetKey } from './targetKey.js';

const SEP = '\u001f';

/**
 * 与方案 §4.5 一致：Map 主键 = targetKey + 分隔 + sessionId，避免跨环境 sessionId 碰撞。
 */
export function makeSessionStoreKey(targetKey: string, sessionId: string): string {
  return `${targetKey}${SEP}${sessionId}`;
}

/**
 * @param sessionId 原始会话 id
 * @param targetKey 缺省为当前 `getTargetKey()`
 */
export function getSessionStoreKey(sessionId: string, targetKey?: string): string {
  const tk = targetKey ?? getTargetKey();
  return makeSessionStoreKey(tk, sessionId);
}
