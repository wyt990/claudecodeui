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
  const lines = clean.split(/\r?\n/);

  let resolvedDefault = null;
  for (const line of lines) {
    const m = line.match(/解析后的模型:\s*(.+)\s*$/);
    if (m) {
      resolvedDefault = m[1].trim();
      break;
    }
  }

  const models = [];
  let inPicker = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.includes('可用模型列表 (Model Picker)')) {
      inPicker = true;
      continue;
    }
    if (!inPicker) continue;

    if (
      trimmed.startsWith('OpenAI 兼容 Provider') ||
      trimmed.startsWith('Zen 免费模型') ||
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
    models.push({ id, label });
  }

  const nonDefault = models.find((x) => x.id !== '(default)');
  const defaultModelId =
    resolvedDefault ||
    (nonDefault && nonDefault.id) ||
    (models[0] && models[0].id) ||
    null;

  if (models.length === 0) {
    return {
      models: [],
      defaultModelId,
      error: 'Could not parse model list from claudecode --list-models'
    };
  }

  return { models, defaultModelId, error: null };
}

export function isClaudecodeExecutablePath(execPath) {
  if (!execPath || typeof execPath !== 'string') return false;
  return path.basename(execPath) === 'claudecode';
}

/**
 * Run `claudecode --list-models` with server env; return parsed picker models only.
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

  const result = spawnSync(execPath, ['--list-models'], {
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
