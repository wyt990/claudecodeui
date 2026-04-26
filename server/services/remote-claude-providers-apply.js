/**
 * 在远端通过 claudecode 的 --add-provider、--env-set 下发多渠配置，并在完成后可选 --env-export 校验。
 * @module server/services/remote-claude-providers-apply
 */

import { acquirePooledSshClient } from '../remote/remote-ssh-pool.js';
import { execBashTextResult } from '../remote/remote-ssh.js';
import { decryptSecret } from '../utils/ssh-vault.js';
import { claudeProviderCatalogDb, sshServerClaudeProviderPrefsDb } from '../database/db.js';
import { verifyEnvExportAgainstExpectations } from './remote-claude-ssh-ops.js';

const LOG = '[remote-claude-providers-apply]';
const APPLY_TIMEOUT_MS = Math.max(30_000, Math.min(600_000, Number(process.env.CLOUDCLI_SSH_CLAUDE_APPLY_TIMEOUT_MS) || 120_000) || 120_000);
/** 与 `remote-claude-probe` 一致：用 `bash -lic` 调 PATH，使 `nvm` / `~/.bashrc` 等与交互终端里 `claudecode` 可见性一致；纯 `bash -lc` 常找不到仅写在非登录路径里的 CLI。 */
const USE_INTERACTIVE_BASH_FOR_CLAUDECODE = true;

/**
 * @param {string} s
 */
function bashSingleQuoted(s) {
  if (s.includes('\0')) {
    throw new Error('NUL in string');
  }
  return `'${String(s).replace(/'/g, `'"'"'`)}'`;
}

/**
 * @param {string} modelsRaw
 * @returns {string} — 合并为 --models 传参的字符串（逗号或换行分隔，去空）
 */
export function normalizeModelsForCli(modelsRaw) {
  return String(modelsRaw || '')
    .split(/[,\n]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .join(',');
}

/**
 * @param {object} row
 * @param {string} keyPlain
 * @returns {string}
 */
function buildAddProviderCommand(row, keyPlain) {
  const models = normalizeModelsForCli(row.models_raw);
  if (!models) {
    throw new Error(`Provider "${row.channel_id}": models is empty`);
  }
  if (!keyPlain) {
    throw new Error(`Provider "${row.channel_id}": API key is missing (save with vault or re-enter the key)`);
  }
  return `claudecode --add-provider --id ${bashSingleQuoted(row.channel_id)} --base-url ${bashSingleQuoted(
    row.base_url,
  )} --api-key ${bashSingleQuoted(keyPlain)} --models ${bashSingleQuoted(models)}`;
}

/**
 * @param {number} userId
 * @param {number} serverId
 * @param {{ selectedEntryIds: number[]; openaiCompat: boolean; zenFreeModels: boolean; runEnvExport: boolean}} opts
 * @returns {Promise<{ log: Array<{ step: string; command: string; code: number | null; stdout: string; stderr: string; timedOut: boolean; ok: boolean }> }>}
 */
export async function runClaudecodeProviderDeploy(userId, serverId, opts) {
  const selected = Array.isArray(opts.selectedEntryIds) ? opts.selectedEntryIds : [];
  const runEnvExport = Boolean(opts.runEnvExport);
  const openaiCompat = Boolean(opts.openaiCompat);
  const zenFree = Boolean(opts.zenFreeModels);

  /** @type {Array<{ step: string; command: string; code: number | null; stdout: string; stderr: string; timedOut: boolean; ok: boolean }>} */
  const log = [];

  /**
   * @param {string} message
   * @param {any} [cause]
   */
  const throwWith = (message, cause) => {
    const e = new Error(cause && cause.message ? `${message}: ${cause.message}` : message);
    e.log = log;
    e.cause = cause;
    throw e;
  };

  const { client, release } = await acquirePooledSshClient(userId, serverId);
  try {
    for (const rawId of selected) {
      const eid = parseInt(String(rawId), 10);
      if (!Number.isFinite(eid)) {
        continue;
      }
      const row = claudeProviderCatalogDb.get(userId, eid);
      if (!row) {
        console.warn(`${LOG} userId=${userId} serverId=${serverId} step=skip_missing entryId=${eid}`);
        continue;
      }
      let keyPlain = '';
      if (row.api_key_encrypted) {
        try {
          keyPlain = decryptSecret(row.api_key_encrypted);
        } catch (e) {
          console.error(`${LOG} userId=${userId} step=decrypt_key_failed entryId=${eid}`, e);
          throwWith(`Failed to decrypt API key for channel "${row.channel_id}". Check CLOUDCLI_VAULT_KEY.`, e);
        }
      }
      let command;
      try {
        command = buildAddProviderCommand(row, keyPlain);
      } catch (e) {
        const em = e instanceof Error ? e.message : String(e);
        throwWith(em, e);
      }
      console.log(`${LOG} userId=${userId} serverId=${serverId} step=add_provider id=${eid} channel_id=${row.channel_id}`);
      const r = await execBashTextResult(
        userId,
        serverId,
        client,
        command,
        APPLY_TIMEOUT_MS,
        USE_INTERACTIVE_BASH_FOR_CLAUDECODE,
      );
      const line = {
        step: 'add_provider',
        command: command.replace(keyPlain, '***'),
        code: r.code,
        stdout: (r.stdout || '').trimEnd(),
        stderr: (r.stderr || '').trimEnd(),
        timedOut: r.timedOut,
        ok: !r.timedOut && (r.code === 0 || r.code === null),
      };
      log.push(line);
      if (!line.ok) {
        const h = (line.stderr || line.stdout || 'Remote command failed').slice(0, 2000);
        throwWith(`add-provider failed (channel: ${row.channel_id}): ${h}`);
      }
    }

    const oa = openaiCompat ? 1 : 0;
    const oacmd = `claudecode --env-set CLAUDE_CODE_USE_OPENAI_COMPAT_API=${oa}`;
    console.log(`${LOG} userId=${userId} serverId=${serverId} step=env_openai_compat value=${oa}`);
    const rOa = await execBashTextResult(
      userId,
      serverId,
      client,
      oacmd,
      APPLY_TIMEOUT_MS,
      USE_INTERACTIVE_BASH_FOR_CLAUDECODE,
    );
    const lineOa = {
      step: 'env_openai_compat',
      command: oacmd,
      code: rOa.code,
      stdout: (rOa.stdout || '').trimEnd(),
      stderr: (rOa.stderr || '').trimEnd(),
      timedOut: rOa.timedOut,
      ok: !rOa.timedOut && (rOa.code === 0 || rOa.code === null),
    };
    log.push(lineOa);
    if (!lineOa.ok) {
      const h = (lineOa.stderr || lineOa.stdout || 'Remote command failed').slice(0, 2000);
      throwWith(`--env-set OpenAI compat failed: ${h}`);
    }

    const z = zenFree ? 1 : 0;
    const zcmd = `claudecode --env-set CLAUDE_CODE_ZEN_FREE_MODELS=${z}`;
    console.log(`${LOG} userId=${userId} serverId=${serverId} step=env_zen value=${z}`);
    const rZ = await execBashTextResult(
      userId,
      serverId,
      client,
      zcmd,
      APPLY_TIMEOUT_MS,
      USE_INTERACTIVE_BASH_FOR_CLAUDECODE,
    );
    const lineZ = {
      step: 'env_zen_free',
      command: zcmd,
      code: rZ.code,
      stdout: (rZ.stdout || '').trimEnd(),
      stderr: (rZ.stderr || '').trimEnd(),
      timedOut: rZ.timedOut,
      ok: !rZ.timedOut && (rZ.code === 0 || rZ.code === null),
    };
    log.push(lineZ);
    if (!lineZ.ok) {
      const h = (lineZ.stderr || lineZ.stdout || 'Remote command failed').slice(0, 2000);
      throwWith(`--env-set ZEN free models failed: ${h}`);
    }

    const dne = zenFree ? 0 : 1;
    const dcmd = `claudecode --env-set CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=${dne}`;
    console.log(
      `${LOG} userId=${userId} serverId=${serverId} step=env_disable_nonessential traffic=${dne} (Zen on → 0 for Zen list fetch)`,
    );
    const rD = await execBashTextResult(
      userId,
      serverId,
      client,
      dcmd,
      APPLY_TIMEOUT_MS,
      USE_INTERACTIVE_BASH_FOR_CLAUDECODE,
    );
    const lineD = {
      step: 'env_disable_nonessential',
      command: dcmd,
      code: rD.code,
      stdout: (rD.stdout || '').trimEnd(),
      stderr: (rD.stderr || '').trimEnd(),
      timedOut: rD.timedOut,
      ok: !rD.timedOut && (rD.code === 0 || rD.code === null),
    };
    log.push(lineD);
    if (!lineD.ok) {
      const h = (lineD.stderr || lineD.stdout || 'Remote command failed').slice(0, 2000);
      throwWith(`--env-set CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC failed: ${h}`);
    }

    if (runEnvExport) {
      const ex = 'claudecode --env-export';
      console.log(`${LOG} userId=${userId} serverId=${serverId} step=env_export`);
      const rE = await execBashTextResult(
        userId,
        serverId,
        client,
        ex,
        APPLY_TIMEOUT_MS,
        USE_INTERACTIVE_BASH_FOR_CLAUDECODE,
      );
      const outAll = (rE.stdout || '') + (rE.stderr ? (rE.stdout ? '\n' : '') + rE.stderr : '');
      const lineE = {
        step: 'env_export',
        command: ex,
        code: rE.code,
        stdout: (rE.stdout || '').trimEnd(),
        stderr: (rE.stderr || '').trimEnd(),
        timedOut: rE.timedOut,
        ok: !rE.timedOut && (rE.code === 0 || rE.code === null),
      };
      log.push(lineE);
      if (!lineE.ok) {
        const h = (lineE.stderr || lineE.stdout || 'env-export failed').slice(0, 2000);
        throwWith(`claudecode --env-export failed: ${h}`);
      }

      const v = verifyEnvExportAgainstExpectations(outAll, { zenFree, expectDefaultModelId: null });
      const vText = v.lines.join('\n');
      const vOk = v.nonEssentialOk && v.zenOk;
      log.push({
        step: 'env_verify',
        command: 'parse --env-export output: NON essential traffic, Zen, default model line',
        code: 0,
        stdout: vText,
        stderr: vOk ? '' : 'Check warnings in stdout',
        timedOut: false,
        ok: vOk,
      });
      if (!vOk) {
        console.warn(`${LOG} userId=${userId} serverId=${serverId} step=env_verify_warn`, vText);
      } else {
        console.log(`${LOG} userId=${userId} serverId=${serverId} step=env_verify_ok`, vText.slice(0, 500));
      }
    }

    console.log(
      `${LOG} userId=${userId} serverId=${serverId} step=done logSteps=${log.length} selectedCount=${selected.length}`,
    );
    return { log };
  } finally {
    release();
  }
}

/**
 * 持久化偏好（供与下发分离时调用）。
 * @param {number} userId
 * @param {number} serverId
 * @param {{ selectedEntryIds: number[]; openaiCompat: boolean; zenFreeModels: boolean}} opts
 */
export function persistClaudeProviderPrefs(userId, serverId, opts) {
  const selected = Array.isArray(opts.selectedEntryIds) ? opts.selectedEntryIds : [];
  sshServerClaudeProviderPrefsDb.upsert(userId, serverId, selected, Boolean(opts.openaiCompat), Boolean(opts.zenFreeModels));
}
