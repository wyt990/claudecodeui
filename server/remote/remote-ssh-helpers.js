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

/**
 * sshd 的 exec 通道里即使用 `bash -lc`，也常拿不到与「本机开终端」相同的 PATH：
 * 非交互登录可能不读 ~/.bashrc；nvm/fnm、npm 全局、pip --user 多在 ~/.local/bin。
 * 在 `set -u` 之前执行：关 errexit/nounset → source 常见 profile → 追加常见 bin → 恢复 errexit。
 * @type {string}
 */
export const REMOTE_SSH_BASH_PATH_BOOTSTRAP = [
  'set +eu',
  'for __f in /etc/profile "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile" "$HOME/.bashrc"; do',
  '  [ -r "$__f" ] && . "$__f" 2>/dev/null',
  'done',
  'case ":${PATH:-}:" in *:"$HOME/.local/bin":*) ;; *) PATH="${PATH:+$PATH:}$HOME/.local/bin" ;; esac',
  'case ":${PATH:-}:" in *:"$HOME/bin":*) ;; *) PATH="${PATH:+$PATH:}$HOME/bin" ;; esac',
  'export PATH',
  'set -e',
].join('\n');
