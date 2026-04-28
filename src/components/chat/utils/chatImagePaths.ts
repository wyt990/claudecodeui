/**
 * 与本地 claude-sdk / 远程 SSH 注入的「图片路径说明」后缀一致，用于气泡内隐藏冗长路径、仅保留用户正文。
 */
const IMAGE_PATHS_NOTE_RE = /\n\n\[Images provided at the following paths:\][\s\S]*$/;
const IMAGE_SAFETY_GUARD_RE = /\n?\[IMAGE CONTENT SAFETY GUARD\][\s\S]*?(?=\n\[Images provided at the following paths:\]|$)/g;

export function stripClaudeImagePathsNote(text: string): string {
  return String(text || '')
    .replace(IMAGE_PATHS_NOTE_RE, '')
    .replace(IMAGE_SAFETY_GUARD_RE, '')
    .trimEnd();
}
