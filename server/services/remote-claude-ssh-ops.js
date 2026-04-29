/**
 * 远端 SSH 上执行 claudecode 子命令（list-models、set-default-model），与 providers-apply 共用交互式 bash。
 * @module server/services/remote-claude-ssh-ops
 */

import { acquirePooledSshClient } from '../remote/remote-ssh-pool.js';
import { execBashTextResult } from '../remote/remote-ssh.js';
import { parseClaudecodeListModelsText } from '../utils/claude-list-models-cli.js';

const LOG = '[remote-claude-ssh-ops]';
const LIST_TIMEOUT_MS = Math.max(30_000, Math.min(600_000, Number(process.env.CLOUDCLI_SSH_CLAUDE_LIST_MODELS_TIMEOUT_MS) || 180_000) || 180_000);
const SET_DEFAULT_TIMEOUT_MS = Math.max(15_000, Math.min(300_000, Number(process.env.CLOUDCLI_SSH_CLAUDE_SET_DEFAULT_TIMEOUT_MS) || 90_000) || 90_000);
const USE_INTERACTIVE_BASH = true;

/**
 * @param {string} modelId
 * @returns {string | null}
 */
export function assertSafeClaudecodeModelId(modelId) {
  const s = String(modelId || '').trim();
  if (s.length < 1 || s.length > 512) {
    return 'model id length invalid';
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s) || s.includes('`') || s.includes('$(')) {
    return 'model id contains disallowed characters';
  }
  return null;
}

/**
 * @param {string} text — full --env-export stdout
 * @param {{ zenFree: boolean, expectDefaultModelId?: string | null }} expect
 * @returns {{ nonEssentialOk: boolean, nonEssentialValue: string | null, zenOk: boolean, defaultModelInExport: string | null, lines: string[] }}
 */
function normBool01(val) {
  if (val == null) {
    return null;
  }
  const s = String(val).trim();
  if (s === '') {
    return null;
  }
  if (/^(0|false|no|off)$/i.test(s)) {
    return '0';
  }
  if (/^(1|true|yes|on)$/i.test(s)) {
    return '1';
  }
  return s;
}

export function verifyEnvExportAgainstExpectations(text, expect) {
  const t = text || '';
  const nonM = t.match(/CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC\s*=\s*([^\n#]+?)(?:\s*#|\s*$)/im);
  const nonRaw = nonM ? nonM[1].trim() : null;
  const nonVal = normBool01(nonRaw) ?? nonRaw;
  const wantN = expect.zenFree ? '0' : '1';
  const nonEssentialOk = nonVal != null && (nonVal === wantN || (wantN === '0' && nonVal === '0') || (wantN === '1' && nonVal === '1'));

  const zM = t.match(/CLAUDE_CODE_ZEN_FREE_MODELS\s*=\s*([^\n#]+?)(?:\s*#|\s*$)/im);
  const zValRaw = zM ? zM[1].trim() : null;
  const zVal = normBool01(zValRaw) ?? zValRaw;
  const wantZ = expect.zenFree ? '1' : '0';
  const zenOk = zVal == null || zVal === wantZ || (expect.zenFree && zVal === '1') || (!expect.zenFree && zVal === '0');

  const m = t.match(/model:\s*([^\s#]+)/im) || t.match(/^\s*model:\s*([^\s#]+)/m);
  const defaultModel = m ? m[1].trim() : null;

  const lines = [];
  lines.push(
    `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: found=${nonVal == null ? '(missing)' : String(nonVal)} want=${wantN} ${nonEssentialOk ? 'OK' : 'MISMATCH'}`,
  );
  lines.push(`CLAUDE_CODE_ZEN_FREE_MODELS: found=${zVal == null ? '(missing)' : zVal} want=${wantZ} ${zenOk ? 'OK' : 'CHECK'}`);
  if (expect && expect.expectDefaultModelId) {
    const dm = String(expect.expectDefaultModelId);
    const hit = Boolean(defaultModel && (defaultModel.includes(dm) || dm.includes(defaultModel)));
    lines.push(`default model in export: ${defaultModel == null ? '(unparsed)' : defaultModel} vs expect=${dm} ${hit ? 'OK' : 'INFO'}`);
  } else {
    lines.push(`default model (settings) in export: ${defaultModel == null ? '(unparsed)' : defaultModel}`);
  }

  return {
    nonEssentialOk,
    nonEssentialValue: nonVal,
    zenOk,
    defaultModelInExport: defaultModel,
    lines,
  };
}

/**
 * @param {number} userId
 * @param {number} serverId
 * @returns {Promise<{ raw: string, models: { id: string, label: string }[], defaultModelId: string | null, parseError: string | null, code: number | null, stderr: string }>}
 */
export async function runRemoteClaudecodeListModels(userId, serverId) {
  // Use text format for remote SSH (older claudecode versions may not support --json)
  // The parser will try JSON first if the output looks like JSON, then fall back to text
  const cmd = 'export NO_COLOR=1 FORCE_COLOR=0; claudecode --list-models';
  const { client, release } = await acquirePooledSshClient(userId, serverId);
  try {
    const r = await execBashTextResult(userId, serverId, client, cmd, LIST_TIMEOUT_MS, USE_INTERACTIVE_BASH);
    const raw = (r.stdout || '') + (r.stderr && r.stderr.length ? (r.stdout ? '\n' : '') + r.stderr : '');
    if (r.timedOut) {
      return { raw, models: [], defaultModelId: null, parseError: 'Remote list-models timed out', code: r.code, stderr: r.stderr || '' };
    }
    if (r.code !== 0 && r.code != null) {
      return { raw, models: [], defaultModelId: null, parseError: `claudecode --list-models exited ${r.code}`, code: r.code, stderr: r.stderr || '' };
    }
    const out = (r.stdout || '') + (r.stderr || '');
    const parsed = parseClaudecodeListModelsText(out);
    return {
      raw,
      models: parsed.models,
      defaultModelId: parsed.defaultModelId,
      parseError: parsed.error,
      code: r.code,
      stderr: r.stderr || '',
    };
  } finally {
    release();
  }
}

/**
 * @param {number} userId
 * @param {number} serverId
 * @param {string} modelId
 */
export async function runRemoteClaudecodeSetDefaultModel(userId, serverId, modelId) {
  const err = assertSafeClaudecodeModelId(modelId);
  if (err) {
    throw new Error(err);
  }
  const b = bashSingleQuotedForRemote(modelId);
  const full = `export NO_COLOR=1; claudecode --set-default-model ${b}`;
  const { client, release } = await acquirePooledSshClient(userId, serverId);
  try {
    const r = await execBashTextResult(userId, serverId, client, full, SET_DEFAULT_TIMEOUT_MS, USE_INTERACTIVE_BASH);
    const one = {
      step: 'set_default_model',
      command: `claudecode --set-default-model ${b}`,
      code: r.code,
      stdout: (r.stdout || '').trimEnd(),
      stderr: (r.stderr || '').trimEnd(),
      timedOut: r.timedOut,
      ok: !r.timedOut && (r.code === 0 || r.code === null),
    };
    console.log(`${LOG} userId=${userId} serverId=${serverId} step=set-default code=${r.code}`);
    if (!one.ok) {
      const h = (one.stderr || one.stdout || 'set-default failed').slice(0, 2000);
      const e = new Error(h);
      e.log = [one];
      throw e;
    }
    return { log: [one] };
  } finally {
    release();
  }
}

/**
 * 与 `remote-claude-providers-apply` 的 bash 单引号转义一致。
 * @param {string} s
 */
function bashSingleQuotedForRemote(s) {
  if (s.includes('\0')) {
    throw new Error('NUL in model id');
  }
  return `'${String(s).replace(/'/g, `'"'"'`)}'`;
}
