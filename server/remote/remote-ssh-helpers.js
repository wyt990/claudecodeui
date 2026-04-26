/**
 * @param {string | undefined} raw
 * @returns {number | null}
 */
export function parseServerIdFromTargetKey(raw) {
  if (!raw || typeof raw !== 'string' || !raw.startsWith('remote:')) {
    return null;
  }
  const n = Number.parseInt(String(raw).slice(7), 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

/**
 * 远端路径白名单式校验（与 UI 的 SFTP 发现路径同阶）
 * @param {string} p
 * @returns {boolean}
 */
export function isAcceptableRemoteFsPath(p) {
  if (!p || typeof p !== 'string' || p.length < 1 || p.length > 8_000) {
    return false;
  }
  if (!p.startsWith('/')) {
    return false;
  }
  if (p.includes('..') || p.includes('\0') || p.includes('\n') || p.includes('\r')) {
    return false;
  }
  return true;
}

/**
 * Bash 单引号内嵌（含 ' 转义为 '"'"'）
 * @param {string} s
 * @returns {string}
 */
export function bashSingleQuote(s) {
  if (typeof s !== 'string') {
    return "''";
  }
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
