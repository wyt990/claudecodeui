/**
 * Claude Code 会把斜杠命令等写成带标签的片段；会话列表用 `summary` 展示时需缩短为可读标题。
 * 优先取 `<command-message>` 内文本，否则 `<command-name>`，再否则去掉标签后的纯文本。
 * @param {unknown} raw
 * @returns {string}
 */
export function humanizeClaudeSessionSummary(raw) {
  if (raw == null || typeof raw !== 'string') return '';
  const s = raw.trim();
  if (!s) return '';

  const cmdMsg = /<command-message>\s*([^<]*?)\s*<\/command-message>/i.exec(s);
  if (cmdMsg) {
    const inner = (cmdMsg[1] || '').trim();
    if (inner) return inner.length > 120 ? `${inner.slice(0, 117)}...` : inner;
  }

  const cmdName = /<command-name>\s*([^<]*?)\s*<\/command-name>/i.exec(s);
  if (cmdName) {
    const inner = (cmdName[1] || '').trim();
    if (inner) return inner.length > 120 ? `${inner.slice(0, 117)}...` : inner;
  }

  if (s.includes('<') && s.includes('>')) {
    const stripped = s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (stripped.length > 0) {
      return stripped.length > 120 ? `${stripped.slice(0, 117)}...` : stripped;
    }
  }

  return s;
}
