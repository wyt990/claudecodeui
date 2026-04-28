/**
 * 用户附图 / 远程 SSH 多模态调试。
 * - 与后端 `CLOUDCLI_DEBUG_CHAT_IMAGES` 对齐：构建时设 `VITE_CLOUDCLI_DEBUG_CHAT_IMAGES=1` 可在浏览器打相同前缀日志。
 * - 兼容：`VITE_DEBUG_CHAT_IMAGES`、`localStorage DEBUG_CHAT_IMAGES`；开发模式 DEV 默认开启（可被上面显式关闭）。
 */

export function isChatImagesDebugEnabled(): boolean {
  try {
    if (import.meta.env.VITE_CLOUDCLI_DEBUG_CHAT_IMAGES === '0') return false;
    if (import.meta.env.VITE_CLOUDCLI_DEBUG_CHAT_IMAGES === '1') return true;
    if (import.meta.env.VITE_DEBUG_CHAT_IMAGES === '0') return false;
    if (import.meta.env.VITE_DEBUG_CHAT_IMAGES === '1') return true;
    if (typeof localStorage !== 'undefined' && localStorage.getItem('DEBUG_CHAT_IMAGES') === '0') return false;
    if (typeof localStorage !== 'undefined' && localStorage.getItem('DEBUG_CHAT_IMAGES') === '1') return true;
    if (import.meta.env.DEV) return true;
  } catch {
    /* private mode */
  }
  return false;
}

export function chatImagesDebugLog(...args: unknown[]): void {
  if (isChatImagesDebugEnabled()) {
    console.log('[CloudCLI chat-images]', ...args);
  }
}
