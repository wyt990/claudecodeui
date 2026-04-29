import fs from 'fs';
import os from 'os';
import { spawnSync } from 'child_process';
import path from 'path';
import { getClaudeCodeExecutablePathForSdk } from './claude-cli-detect.js';

function parseDotEnvFile(filePath) {
  const out = {};
  try {
    if (!fs.existsSync(filePath)) return out;
    const text = fs.readFileSync(filePath, 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (key) out[key] = val;
    }
  } catch {
    /* ignore */
  }
  return out;
}

/**
 * Merge claudecode install / dev repo `.env` so `--list-models` / Agent SDK child sees ANTHROPIC_* even when
 * CloudCLI `.env` only has server keys (install puts secrets under CLAUDE_CODE_INSTALL_PREFIX).
 * Later files override earlier keys.
 */
export function mergeEnvForClaudecodeSpawn(execPath) {
  const merged = { ...process.env };
  const extraFiles = [];

  if (execPath && fs.existsSync(execPath)) {
    try {
      if (fs.statSync(execPath).size < 800) {
        const body = fs.readFileSync(execPath, 'utf8');
        const m = body.match(/export\s+CLAUDE_CODE_INSTALL_PREFIX="([^"]+)"/);
        if (m) {
          extraFiles.push(path.join(m[1], '.env'));
        }
      }
    } catch {
      /* ignore */
    }
  }

  if (process.env.CLAUDE_CODE_INSTALL_PREFIX?.trim()) {
    extraFiles.push(path.join(process.env.CLAUDE_CODE_INSTALL_PREFIX.trim(), '.env'));
  }

  extraFiles.push('/apps/claude-code/.env');
  extraFiles.push(path.join(os.homedir(), '.local/share/claude-code-local/.env'));

  const seen = new Set();
  for (const fp of extraFiles) {
    if (!fp || seen.has(fp)) continue;
    seen.add(fp);
    const kv = parseDotEnvFile(fp);
    for (const [k, v] of Object.entries(kv)) {
      if (v !== undefined && v !== '') {
        merged[k] = v;
      }
    }
  }

  return merged;
}

/** Strip ANSI (e.g. chalk) so we can parse `claudecode --list-models` output. */
export function stripAnsi(str) {
  if (!str || typeof str !== 'string') return '';
  return str.replace(/\u001b\[[\d;]*m/g, '');
}

/**
 * Parse `claudecode --list-models` stdout. Does not return raw text (may contain secrets).
 * @returns {{ models: Array<{ id: string, label: string }>, defaultModelId: string | null, error: string | null }}
 */
export function parseClaudecodeListModelsText(text) {
  const clean = stripAnsi(text);

  // Try to parse as JSON first (new format with --json flag)
  try {
    const json = JSON.parse(clean);
    if (json && typeof json === 'object') {
      return parseClaudecodeListModelsJson(json);
    }
  } catch {
    // Not JSON, fall back to text parsing
  }

  // Legacy text format parsing (kept for backward compatibility)
  const lines = clean.split(/\r?\n/);

  // New text format: parse "- 模型名 (路由：xxx)" or "- 模型名 (来自 xxx)" patterns
  const models = [];
  let defaultModelId = null;

  // Extract default/current model from "当前模型：" or "默认模型：" lines
  for (const line of lines) {
    const trimmed = line.trim();
    // Match "当前模型：xxx" or "默认模型：xxx"
    if (trimmed.startsWith('当前模型：') || trimmed.startsWith('当前模型:')) {
      const m = trimmed.match(/当前模型[：:]\s*(.+)$/);
      if (m) defaultModelId = m[1].trim();
    }
    if (trimmed.startsWith('默认模型：') || trimmed.startsWith('默认模型:')) {
      const m = trimmed.match(/默认模型[：:]\s*(.+)$/);
      if (m) defaultModelId = m[1].trim();
    }
    // Also check settings: model: xxx
    if (trimmed.startsWith('model:') || trimmed.startsWith('model：')) {
      const m = trimmed.match(/model[：:]\s*(.+)$/);
      if (m && !defaultModelId) defaultModelId = m[1].trim();
    }
  }

  // Parse model lines: "- 模型名 (路由：xxx)" or "- 模型名 (来自 xxx)"
  for (const line of lines) {
    const trimmed = line.trim();
    // Match "- xxx (路由：yyy)" pattern
    const routeMatch = trimmed.match(/^-\s*(.+?)\s*\((?:路由|route)[：:]\s*(.+)\)$/);
    if (routeMatch) {
      const label = routeMatch[1].trim();
      const id = routeMatch[2].trim();
      if (id && label) {
        models.push({ id, label });
      }
      continue;
    }
    // Match "- xxx (来自 yyy)" pattern (custom models from env vars)
    const fromMatch = trimmed.match(/^-\s*(.+?)\s*\((?:来自|from)\s+(.+)\)$/);
    if (fromMatch) {
      const id = fromMatch[1].trim();
      const source = fromMatch[2].trim();
      const label = source ? `${id} (${source})` : id;
      if (id) {
        models.push({ id, label });
      }
      continue;
    }
  }

  // Deduplicate by id
  const seen = new Set();
  const uniqueModels = [];
  for (const m of models) {
    if (!seen.has(m.id)) {
      seen.add(m.id);
      uniqueModels.push(m);
    }
  }

  if (uniqueModels.length === 0) {
    // Try legacy format as fallback
    const legacyModels = [];
    let inPicker = false;
    for (const line of lines) {
      const trimmed = line.trim();
      const isPickerHeader =
        (trimmed.includes('可用模型列表') && trimmed.includes('Model Picker')) ||
        /\(Model Picker\)/i.test(trimmed) ||
        /^=+\s*Model Picker\s*$/i.test(trimmed);
      if (isPickerHeader) {
        inPicker = true;
        continue;
      }
      if (!inPicker) continue;

      if (
        trimmed.startsWith('OpenAI 兼容 Provider') ||
        trimmed.startsWith('Zen 免费模型') ||
        (trimmed.startsWith('OpenAI') && trimmed.includes('Provider 环境')) ||
        trimmed === '=== 信息结束 ===' ||
        (trimmed.startsWith('===') && trimmed.includes('信息'))
      ) {
        break;
      }
      if (/^\s{4}/.test(line)) {
        continue;
      }
      const row = line.match(/^\s{2}([^:\n]+):\s*(.+)\s*$/);
      if (!row) continue;
      const label = row[1].trim();
      const id = row[2].trim();
      if (!label || !id) continue;
      legacyModels.push({ id, label });
    }

    if (legacyModels.length > 0) {
      const nonDefault = legacyModels.find((x) => x.id !== '(default)');
      const legacyDefaultId = defaultModelId || (nonDefault && nonDefault.id) || (legacyModels[0] && legacyModels[0].id) || null;
      return { models: legacyModels, defaultModelId: legacyDefaultId, error: null };
    }

    return {
      models: [],
      defaultModelId,
      error: 'Could not parse model list from claudecode --list-models'
    };
  }

  return { models: uniqueModels, defaultModelId, error: null };
}

/**
 * Parse JSON output from `claudecode --list-models --json`.
 * @param {object} json - Parsed JSON object
 * @returns {{ models: Array<{ id: string, label: string }>, defaultModelId: string | null, error: string | null }}
 */
function parseClaudecodeListModelsJson(json) {
  const models = [];

  // Add built-in models if any
  if (Array.isArray(json.builtinModels)) {
    for (const m of json.builtinModels) {
      if (typeof m === 'string' && m) {
        models.push({ id: m, label: m });
      }
    }
  }

  // Add custom models (from environment variables)
  if (Array.isArray(json.customModels)) {
    for (const m of json.customModels) {
      if (m && typeof m === 'object' && typeof m.id === 'string' && m.id) {
        const label = m.source ? `${m.id} (${m.source})` : m.id;
        models.push({ id: m.id, label });
      }
    }
  }

  // Add OpenAI compatible models
  if (json.openaiCompat && json.openaiCompat.enabled && Array.isArray(json.openaiCompat.providers)) {
    for (const provider of json.openaiCompat.providers) {
      if (provider && Array.isArray(provider.models)) {
        for (const m of provider.models) {
          if (m && typeof m === 'object' && typeof m.routedValue === 'string' && m.routedValue) {
            const label = m.originalName || m.routedValue;
            models.push({ id: m.routedValue, label });
          }
        }
      }
    }
  }

  // Add Zen free models
  if (json.zenFreeModels && json.zenFreeModels.enabled && Array.isArray(json.zenFreeModels.models)) {
    for (const m of json.zenFreeModels.models) {
      if (m && typeof m === 'object' && typeof m.routedValue === 'string' && m.routedValue) {
        const label = m.originalName || m.routedValue;
        models.push({ id: m.routedValue, label });
      }
    }
  }

  // Deduplicate by id, keeping first occurrence
  const seen = new Set();
  const uniqueModels = [];
  for (const m of models) {
    if (!seen.has(m.id)) {
      seen.add(m.id);
      uniqueModels.push(m);
    }
  }

  // Determine default model
  // Priority: settings.model > defaultModel > currentModel > first available model
  let defaultModelId = null;
  if (json.settings && typeof json.settings.model === 'string' && json.settings.model) {
    defaultModelId = json.settings.model;
  } else if (typeof json.defaultModel === 'string' && json.defaultModel) {
    defaultModelId = json.defaultModel;
  } else if (typeof json.currentModel === 'string' && json.currentModel) {
    defaultModelId = json.currentModel;
  } else if (uniqueModels.length > 0) {
    defaultModelId = uniqueModels[0].id;
  }

  if (uniqueModels.length === 0) {
    return {
      models: [],
      defaultModelId,
      error: 'No models found in claudecode --list-models JSON output'
    };
  }

  return { models: uniqueModels, defaultModelId, error: null };
}

export function isClaudecodeExecutablePath(execPath) {
  if (!execPath || typeof execPath !== 'string') return false;
  return path.basename(execPath) === 'claudecode';
}

/**
 * Run `claudecode --list-models --json` with server env; return parsed picker models only.
 */
export function runClaudecodeListModels() {
  const execPath = getClaudeCodeExecutablePathForSdk();
  if (!execPath || !isClaudecodeExecutablePath(execPath)) {
    return {
      models: [],
      defaultModelId: null,
      error: 'Not using claudecode executable (path is official claude or unset)'
    };
  }

  const childEnv = mergeEnvForClaudecodeSpawn(execPath);
  childEnv.NO_COLOR = '1';
  childEnv.FORCE_COLOR = '0';
  // Do not set CI=1: claudecode's auth treats CI as test mode and may require ANTHROPIC_API_KEY,
  // ignoring ANTHROPIC_AUTH_TOKEN-only setups.

  let cwd = process.cwd();
  try {
    const marker = `${path.sep}claude-code`;
    const j = execPath.indexOf(marker);
    if (j >= 0) {
      cwd = execPath.slice(0, j + marker.length);
    }
  } catch {
    /* keep cwd */
  }

  // Use --json flag for structured output (new format)
  const result = spawnSync(execPath, ['--list-models', '--json'], {
    encoding: 'utf8',
    env: childEnv,
    cwd,
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120000
  });

  if (result.error) {
    return { models: [], defaultModelId: null, error: result.error.message };
  }
  if (result.status !== 0) {
    const errTail = (result.stderr || result.stdout || '').slice(-800);
    return {
      models: [],
      defaultModelId: null,
      error: `claudecode --list-models exited ${result.status}: ${errTail}`
    };
  }

  return parseClaudecodeListModelsText(result.stdout || '');
}
