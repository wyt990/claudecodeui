/**
 * 与 `EnvironmentContext` 同步：解析 localStorage 中的 currentTarget 为 `local` 或 `remote:<id>`。
 * 供非 React 模块（如 `api.js`）在请求中附带 `x-cloudcli-target`。
 */
const STORAGE_KEY = 'cloudcli-current-target';

/**
 * @returns {string} `local` 或 `remote:<正整数 id>`
 */
export function getTargetKey() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return 'local';
    }
    const p = JSON.parse(raw);
    if (p && p.kind === 'remote' && Number.isFinite(p.serverId) && p.serverId >= 1) {
      return `remote:${p.serverId}`;
    }
  } catch {
    // ignore
  }
  return 'local';
}

export { STORAGE_KEY };
