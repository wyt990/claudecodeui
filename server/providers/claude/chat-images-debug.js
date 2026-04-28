/**
 * 用户附图 / 远程 SSH claudecode 流式调试日志开关。
 * - 显式关闭：CLOUDCLI_DEBUG_CHAT_IMAGES=0（或 CLOUDCLI_CHAT_IMAGES_DEBUG=0；或 false/no）
 * - 显式打开：CLOUDCLI_DEBUG_CHAT_IMAGES=1（或 CLOUDCLI_CHAT_IMAGES_DEBUG=1；或 true/yes）
 * - 未设置：NODE_ENV === 'production' 时为关，否则为开（npm run dev / node server 默认能看到日志）
 *
 * 前端对齐：`.env` 中另设 `VITE_CLOUDCLI_DEBUG_CHAT_IMAGES=1`（见 `src/lib/chatImagesDebug.ts`）。
 * @returns {boolean}
 */
export function isChatImagesDebugEnabled() {
  const v =
    process.env.CLOUDCLI_DEBUG_CHAT_IMAGES ?? process.env.CLOUDCLI_CHAT_IMAGES_DEBUG;
  if (v === '0' || v === 'false' || v === 'no') return false;
  if (v === '1' || v === 'true' || v === 'yes') return true;
  return process.env.NODE_ENV !== 'production';
}

/** @param {...unknown} args */
export function chatImagesDebugLog(...args) {
  if (isChatImagesDebugEnabled()) {
    console.log('[CloudCLI chat-images]', ...args);
  }
}
