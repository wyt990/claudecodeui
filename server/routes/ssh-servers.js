/**
 * SSH server registry: groups, servers, encrypted credentials, test connection (P0).
 *
 * @module server/routes/ssh-servers
 */

import express from 'express';
import { sshServersDb, sshServerClaudeProviderPrefsDb } from '../database/db.js';
import { encryptSecret, decryptSecret, isVaultConfigured } from '../utils/ssh-vault.js';
import { testSshConnection } from '../services/ssh-test-connection.js';
import { probeRemoteClaudeEnv, runRemoteClaudeInstall } from '../services/remote-claude-probe.js';
import { runRemoteClaudeOpenProject } from '../services/remote-claude-open-project.js';
import { listRemoteSftpDirectory } from '../services/remote-sftp-browse-dir.js';
import {
  appendRemoteAllowedToolEntry,
  persistClaudeProviderPrefs,
  runClaudecodeProviderDeploy,
  runClaudecodeSystemEnvDeploy,
} from '../services/remote-claude-providers-apply.js';
import { runRemoteClaudecodeListModels, runRemoteClaudecodeSetDefaultModel } from '../services/remote-claude-ssh-ops.js';

const router = express.Router();

const AUTH_TYPES = new Set(['private_key', 'password']);

router.get('/meta', (req, res) => {
  res.json({
    vaultConfigured: isVaultConfigured(),
    targetKeyHeader: 'x-cloudcli-target',
    targetKeyQuery: 'targetKey',
    targetKeyExamples: ['local', 'remote:1'],
  });
});

router.get('/groups', (req, res) => {
  try {
    const userId = req.user.id;
    const rows = sshServersDb.listGroups(userId);
    //console.log(
    //  `[ssh-servers] GET /groups userId=${userId} count=${rows.length}`,
    //  rows.map((r) => ({ id: r.id, name: r.name, sort_order: r.sort_order })),
    //);
    res.json(rows);
  } catch (error) {
    console.error('[ssh-servers] list groups:', error);
    res.status(500).json({ error: 'Failed to list groups' });
  }
});

router.post('/groups', (req, res) => {
  try {
    const userId = req.user.id;
    const { name } = req.body;
    console.log(`[ssh-servers] POST /groups userId=${userId} body=`, req.body);
    if (!name || typeof name !== 'string' || !name.trim()) {
      console.warn('[ssh-servers] POST /groups rejected: name is required or empty');
      return res.status(400).json({ error: 'name is required' });
    }
    const row = sshServersDb.createGroup(userId, name);
    const payload = {
      id: row.id,
      name: row.name,
      sort_order: row.sort_order,
    };
    console.log(`[ssh-servers] POST /groups created:`, payload);
    res.status(201).json(payload);
  } catch (error) {
    console.error('[ssh-servers] create group:', error);
    res.status(500).json({ error: 'Failed to create group' });
  }
});

router.patch('/groups/:groupId', (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId, 10);
    if (!Number.isFinite(groupId)) {
      return res.status(400).json({ error: 'Invalid group id' });
    }
    const ok = sshServersDb.updateGroup(req.user.id, groupId, req.body || {});
    if (!ok) {
      return res.status(404).json({ error: 'Group not found' });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('[ssh-servers] update group:', error);
    res.status(500).json({ error: 'Failed to update group' });
  }
});

router.delete('/groups/:groupId', (req, res) => {
  try {
    const groupId = parseInt(req.params.groupId, 10);
    if (!Number.isFinite(groupId)) {
      return res.status(400).json({ error: 'Invalid group id' });
    }
    const result = sshServersDb.deleteGroup(req.user.id, groupId);
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }
    if (!result.ok) {
      return res.status(404).json({ error: 'Group not found' });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('[ssh-servers] delete group:', error);
    res.status(500).json({ error: 'Failed to delete group' });
  }
});

router.get('/', (req, res) => {
  try {
    const servers = sshServersDb.listServers(req.user.id).map((s) => ({
      id: s.id,
      group_id: s.group_id,
      group_name: s.group_name,
      display_name: s.display_name,
      host: s.host,
      port: s.port,
      username: s.username,
      auth_type: s.auth_type,
      host_key_fingerprint: s.host_key_fingerprint,
      last_connected_at: s.last_connected_at,
      last_error: s.last_error,
      created_at: s.created_at,
      updated_at: s.updated_at,
      has_secrets: sshServersDb.hasSecrets(req.user.id, s.id),
    }));
    res.json({ servers, vaultConfigured: isVaultConfigured() });
  } catch (error) {
    console.error('[ssh-servers] list:', error);
    res.status(500).json({ error: 'Failed to list servers' });
  }
});

const CLAUDE_DEPLOY_LOG = '[ssh-servers] claude-providers-apply';

/**
 * @param {import('express').Response} res
 * @param {number} userId
 * @param {number} serverId
 */
function requireSshServerRow(res, userId, serverId) {
  const server = sshServersDb.getServer(userId, serverId);
  if (!server) {
    res.status(404).json({ error: 'Server not found' });
    return null;
  }
  return server;
}

function requireSshSecretsForApply(res, userId, serverId) {
  const server = requireSshServerRow(res, userId, serverId);
  if (!server) {
    return null;
  }
  const blob = sshServersDb.getSecretBlob(userId, serverId);
  if (!blob) {
    res.status(400).json({ error: 'No credentials stored', code: 'SSH_NO_SECRETS' });
    return null;
  }
  try {
    JSON.parse(decryptSecret(blob));
  } catch {
    res.status(500).json({ error: 'Failed to decrypt credentials', code: 'SSH_DECRYPT_FAILED' });
    return null;
  }
  return server;
}

const LIST_M_LOG = '[ssh-servers] claude-list-models';

/** GET /:serverId/claude-list-models  — 远端 claudecode --list-models 解析为模型列表 */
router.get('/:serverId/claude-list-models', async (req, res) => {
  const userId = req.user.id;
  const serverId = parseInt(req.params.serverId, 10);
  if (!Number.isFinite(serverId)) {
    return res.status(400).json({ error: 'Invalid server id' });
  }
  if (!requireSshSecretsForApply(res, userId, serverId)) {
    return;
  }
  console.log(`${LIST_M_LOG} userId=${userId} serverId=${serverId} step=request`);
  try {
    const r = await runRemoteClaudecodeListModels(userId, serverId);
    return res.json({
      models: r.models,
      defaultModelId: r.defaultModelId,
      parseError: r.parseError,
      code: r.code,
    });
  } catch (e) {
    const em = e instanceof Error ? e.message : String(e);
    console.error(`${LIST_M_LOG} userId=${userId} serverId=${serverId} step=error`, e);
    return res.status(500).json({ error: em, code: 'REMOTE_LIST_MODELS_FAILED' });
  }
});

/** POST /:serverId/claude-set-default-model  body: { modelId: string } */
router.post('/:serverId/claude-set-default-model', async (req, res) => {
  const userId = req.user.id;
  const serverId = parseInt(req.params.serverId, 10);
  if (!Number.isFinite(serverId)) {
    return res.status(400).json({ error: 'Invalid server id' });
  }
  if (!requireSshSecretsForApply(res, userId, serverId)) {
    return;
  }
  const modelId = req.body && typeof req.body.modelId === 'string' ? req.body.modelId.trim() : '';
  if (!modelId) {
    return res.status(400).json({ error: 'modelId is required' });
  }
  console.log(`${LIST_M_LOG} userId=${userId} serverId=${serverId} step=set_default modelId=${modelId.slice(0, 80)}`);
  try {
    const { log } = await runRemoteClaudecodeSetDefaultModel(userId, serverId, modelId);
    return res.json({ ok: true, log });
  } catch (e) {
    const em = e instanceof Error ? e.message : String(e);
    const plog = e && typeof e === 'object' && 'log' in e && Array.isArray((e).log) ? (e).log : [];
    console.error(`${LIST_M_LOG} set-default userId=${userId} serverId=${serverId}`, e);
    return res.status(500).json({ error: em, code: 'SET_DEFAULT_FAILED', log: plog });
  }
});

/** GET /:serverId/claude-provider-prefs */
router.get('/:serverId/claude-provider-prefs', (req, res) => {
  try {
    const userId = req.user.id;
    const serverId = parseInt(req.params.serverId, 10);
    if (!Number.isFinite(serverId)) {
      return res.status(400).json({ error: 'Invalid server id' });
    }
    if (!requireSshServerRow(res, userId, serverId)) {
      return;
    }
    const row = sshServerClaudeProviderPrefsDb.get(userId, serverId);
    let selectedEntryIds = [];
    if (row) {
      try {
        const j = JSON.parse(row.selected_entry_ids_json || '[]');
        if (Array.isArray(j)) {
          selectedEntryIds = j.map((n) => parseInt(String(n), 10)).filter((n) => Number.isFinite(n));
        }
      } catch {
        /* */
      }
    }
    let remoteAllowedTools = [];
    if (row?.remote_allowed_tools_json) {
      try {
        const j = JSON.parse(row.remote_allowed_tools_json);
        if (Array.isArray(j)) {
          remoteAllowedTools = j.map((x) => String(x).trim()).filter(Boolean);
        }
      } catch {
        /* */
      }
    }
    res.json({
      selectedEntryIds,
      openaiCompat: !row || row.openai_compat !== 0,
      zenFreeModels: row ? row.zen_free === 1 : false,
      isSandbox: row ? row.is_sandbox === 1 : false,
      remoteAllowedTools,
    });
  } catch (e) {
    console.error('[ssh-servers] claude-provider-prefs GET', e);
    res.status(500).json({ error: 'Failed to load prefs' });
  }
});

/** POST /:serverId/claude-remote-allowed-tools  body: { entry } — 对话内「添加授权」追加一条到该服务器的 remote_allowed_tools */
router.post('/:serverId/claude-remote-allowed-tools', (req, res) => {
  try {
    const userId = req.user.id;
    const serverId = parseInt(req.params.serverId, 10);
    if (!Number.isFinite(serverId)) {
      return res.status(400).json({ error: 'Invalid server id' });
    }
    if (!requireSshServerRow(res, userId, serverId)) {
      return;
    }
    const b = req.body || {};
    const entry = typeof b.entry === 'string' ? b.entry.trim() : '';
    if (!entry) {
      return res.status(400).json({ error: 'entry is required' });
    }
    const out = appendRemoteAllowedToolEntry(userId, serverId, entry);
    if (!out.ok) {
      return res.status(400).json({ error: out.error || 'append failed' });
    }
    res.json({
      ok: true,
      alreadyAllowed: Boolean(out.alreadyAllowed),
      remoteAllowedTools: out.remoteAllowedTools || [],
    });
  } catch (e) {
    console.error('[ssh-servers] claude-remote-allowed-tools POST', e);
    res.status(500).json({ error: 'Failed to append allowed tool' });
  }
});

/** PUT /:serverId/claude-provider-prefs */
router.put('/:serverId/claude-provider-prefs', (req, res) => {
  try {
    const userId = req.user.id;
    const serverId = parseInt(req.params.serverId, 10);
    if (!Number.isFinite(serverId)) {
      return res.status(400).json({ error: 'Invalid server id' });
    }
    if (!requireSshServerRow(res, userId, serverId)) {
      return;
    }
    const b = req.body || {};
    /** @type {{ selectedEntryIds?: number[]; openaiCompat?: boolean; zenFreeModels?: boolean; isSandbox?: boolean; remoteAllowedTools?: string[] }} */
    const patch = {};
    if (Array.isArray(b.selectedEntryIds)) {
      patch.selectedEntryIds = b.selectedEntryIds;
    }
    if (b.openaiCompat !== undefined) {
      patch.openaiCompat = Boolean(b.openaiCompat);
    }
    if (b.zenFreeModels !== undefined) {
      patch.zenFreeModels = Boolean(b.zenFreeModels);
    }
    if (b.isSandbox !== undefined) {
      patch.isSandbox = Boolean(b.isSandbox);
    }
    if (Array.isArray(b.remoteAllowedTools)) {
      patch.remoteAllowedTools = b.remoteAllowedTools.map((x) => String(x).trim()).filter(Boolean);
    }
    persistClaudeProviderPrefs(userId, serverId, patch);
    const row = sshServerClaudeProviderPrefsDb.get(userId, serverId);
    let remoteAllowedTools = [];
    try {
      const j = JSON.parse(row?.remote_allowed_tools_json || '[]');
      if (Array.isArray(j)) {
        remoteAllowedTools = j.map((x) => String(x).trim()).filter(Boolean);
      }
    } catch {
      /* */
    }
    const selectedEntryIds = (() => {
      try {
        const j = JSON.parse(row?.selected_entry_ids_json || '[]');
        return Array.isArray(j) ? j.map((n) => parseInt(String(n), 10)).filter((n) => Number.isFinite(n)) : [];
      } catch {
        return [];
      }
    })();
    res.json({
      ok: true,
      selectedEntryIds,
      openaiCompat: !row || row.openai_compat !== 0,
      zenFreeModels: row ? row.zen_free === 1 : false,
      isSandbox: row ? row.is_sandbox === 1 : false,
      remoteAllowedTools,
    });
  } catch (e) {
    console.error('[ssh-servers] claude-provider-prefs PUT', e);
    res.status(500).json({ error: 'Failed to save prefs' });
  }
});

/** POST /:serverId/claude-providers-apply  body: { selectedEntryIds, openaiCompat, zenFreeModels, runEnvExport? } */
router.post('/:serverId/claude-providers-apply', async (req, res) => {
  const userId = req.user.id;
  const serverId = parseInt(req.params.serverId, 10);
  if (!Number.isFinite(serverId)) {
    return res.status(400).json({ error: 'Invalid server id' });
  }
  if (!requireSshSecretsForApply(res, userId, serverId)) {
    return;
  }
  const b = req.body || {};
  const runEnvExport = b.runEnvExport === undefined ? true : Boolean(b.runEnvExport);
  const persistFromBody = b.persist !== false;
  const scope = b.scope === 'system' ? 'system' : 'model';

  if (scope === 'system') {
    const isSandbox = Boolean(b.isSandbox);
    const remoteAllowedTools = Array.isArray(b.remoteAllowedTools)
      ? b.remoteAllowedTools.map((x) => String(x).trim()).filter(Boolean)
      : [];
    console.log(
      `${CLAUDE_DEPLOY_LOG} userId=${userId} serverId=${serverId} step=system_deploy isSandbox=${isSandbox} toolsCount=${remoteAllowedTools.length} runEnvExport=${runEnvExport} persist=${persistFromBody}`,
    );
    try {
      if (persistFromBody) {
        persistClaudeProviderPrefs(userId, serverId, { isSandbox, remoteAllowedTools });
      }
      const { log } = await runClaudecodeSystemEnvDeploy(userId, serverId, { isSandbox, runEnvExport });
      log.push({
        step: 'allowed_tools_cloudcli',
        command: `stored ${remoteAllowedTools.length} tool name(s) in app DB for this server (merged with browser allowedTools on each remote claudecode -p)`,
        code: 0,
        stdout: remoteAllowedTools.length ? remoteAllowedTools.join(', ') : '(empty)',
        stderr: '',
        timedOut: false,
        ok: true,
      });
      res.json({ ok: true, log, message: 'System deploy completed.' });
    } catch (e) {
      const em = e instanceof Error ? e.message : String(e);
      const plog = e && typeof e === 'object' && 'log' in e && Array.isArray((e).log) ? (e).log : [];
      console.error(`${CLAUDE_DEPLOY_LOG} userId=${userId} serverId=${serverId} step=system_error`, e);
      res.status(500).json({ error: em, code: 'CLAUDE_SYSTEM_APPLY_FAILED', log: plog });
    }
    return;
  }

  const selectedEntryIds = Array.isArray(b.selectedEntryIds) ? b.selectedEntryIds : [];
  const openaiCompat = b.openaiCompat === undefined ? true : Boolean(b.openaiCompat);
  const zenFreeModels = Boolean(b.zenFreeModels);

  console.log(
    `${CLAUDE_DEPLOY_LOG} userId=${userId} serverId=${serverId} step=start selected=${JSON.stringify(
      selectedEntryIds,
    )} openaiCompat=${openaiCompat} zenFree=${zenFreeModels} disableNonEssentialWillBe=${zenFreeModels ? 0 : 1} runEnvExport=${runEnvExport} persist=${persistFromBody}`,
  );

  try {
    if (persistFromBody) {
      persistClaudeProviderPrefs(userId, serverId, { selectedEntryIds, openaiCompat, zenFreeModels });
    }
    const { log } = await runClaudecodeProviderDeploy(userId, serverId, {
      selectedEntryIds,
      openaiCompat,
      zenFreeModels,
      runEnvExport,
    });
    res.json({ ok: true, log, message: 'Deploy completed. Review env-export in log below.' });
  } catch (e) {
    const em = e instanceof Error ? e.message : String(e);
    const plog = e && typeof e === 'object' && 'log' in e && Array.isArray((e).log) ? (e).log : [];
    console.error(`${CLAUDE_DEPLOY_LOG} userId=${userId} serverId=${serverId} step=error`, e);
    res.status(500).json({ error: em, code: 'CLAUDEPROVIDER_APPLY_FAILED', log: plog });
  }
});

router.post('/', (req, res) => {
  try {
    const {
      display_name: displayName,
      host,
      port,
      username,
      auth_type: authType,
      group_id: groupId,
    } = req.body || {};

    if (!displayName || !host || !username || !authType) {
      return res.status(400).json({
        error: 'display_name, host, username, and auth_type are required',
      });
    }
    if (!AUTH_TYPES.has(authType)) {
      return res.status(400).json({ error: 'auth_type must be "private_key" or "password"' });
    }
    const p = port !== undefined ? parseInt(port, 10) : 22;
    if (!Number.isFinite(p) || p < 1 || p > 65535) {
      return res.status(400).json({ error: 'port must be between 1 and 65535' });
    }

    const { id } = sshServersDb.createServer(req.user.id, {
      display_name: displayName,
      host,
      port: p,
      username,
      auth_type: authType,
      group_id: groupId ?? null,
    });
    const server = sshServersDb.getServer(req.user.id, id);
    res.status(201).json(server);
  } catch (error) {
    console.error('[ssh-servers] create:', error);
    res.status(500).json({ error: 'Failed to create server' });
  }
});

router.patch('/:serverId', (req, res) => {
  try {
    const serverId = parseInt(req.params.serverId, 10);
    if (!Number.isFinite(serverId)) {
      return res.status(400).json({ error: 'Invalid server id' });
    }
    const existing = sshServersDb.getServer(req.user.id, serverId);
    if (!existing) {
      return res.status(404).json({ error: 'Server not found' });
    }
    const body = req.body || {};
    if (body.auth_type !== undefined && !AUTH_TYPES.has(body.auth_type)) {
      return res.status(400).json({ error: 'auth_type must be "private_key" or "password"' });
    }
    const ok = sshServersDb.updateServer(req.user.id, serverId, body);
    if (!ok) {
      return res.status(400).json({ error: 'Nothing to update' });
    }
    res.json(sshServersDb.getServer(req.user.id, serverId));
  } catch (error) {
    console.error('[ssh-servers] patch:', error);
    res.status(500).json({ error: 'Failed to update server' });
  }
});

router.delete('/:serverId', (req, res) => {
  try {
    const serverId = parseInt(req.params.serverId, 10);
    if (!Number.isFinite(serverId)) {
      return res.status(400).json({ error: 'Invalid server id' });
    }
    const ok = sshServersDb.deleteServer(req.user.id, serverId);
    if (!ok) {
      return res.status(404).json({ error: 'Server not found' });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('[ssh-servers] delete:', error);
    res.status(500).json({ error: 'Failed to delete server' });
  }
});

router.put('/:serverId/secrets', (req, res) => {
  try {
    const serverId = parseInt(req.params.serverId, 10);
    if (!Number.isFinite(serverId)) {
      return res.status(400).json({ error: 'Invalid server id' });
    }
    const server = sshServersDb.getServer(req.user.id, serverId);
    if (!server) {
      return res.status(404).json({ error: 'Server not found' });
    }

    const { privateKey, privateKeyPassphrase, password } = req.body || {};
    const bundle = {};

    if (server.auth_type === 'private_key') {
      if (!privateKey || typeof privateKey !== 'string' || !privateKey.trim()) {
        return res.status(400).json({ error: 'privateKey PEM is required for auth_type private_key' });
      }
      bundle.privateKey = privateKey.trim();
      if (privateKeyPassphrase && typeof privateKeyPassphrase === 'string') {
        bundle.privateKeyPassphrase = privateKeyPassphrase;
      }
    } else if (server.auth_type === 'password') {
      if (!password || typeof password !== 'string') {
        return res.status(400).json({ error: 'password is required for auth_type password' });
      }
      bundle.password = password;
    }

    const blob = encryptSecret(JSON.stringify(bundle));
    sshServersDb.setSecretBlob(serverId, blob);
    res.json({ success: true });
  } catch (error) {
    if (error.code === 'VAULT_NOT_CONFIGURED') {
      return res.status(503).json({ error: error.message, code: error.code });
    }
    console.error('[ssh-servers] secrets:', error);
    res.status(500).json({ error: 'Failed to store credentials' });
  }
});

router.post('/:serverId/test', async (req, res) => {
  const t0 = Date.now();
  const userId = req.user.id;
  const serverId = parseInt(req.params.serverId, 10);
  const logPfx = `[ssh-servers] POST /:serverId/test userId=${userId} serverId=${serverId}`;

  if (!Number.isFinite(serverId)) {
    console.warn(`${logPfx} step=reject reason=invalid_id`);
    return res.status(400).json({ error: 'Invalid server id' });
  }

  const server = sshServersDb.getServer(userId, serverId);
  if (!server) {
    console.warn(`${logPfx} step=reject reason=not_found`);
    return res.status(404).json({ error: 'Server not found' });
  }

  console.log(
    `${logPfx} step=server_row host=${server.host} port=${server.port} username=${server.username} auth_type=${server.auth_type} display_name=${server.display_name || ''}`,
  );

  const blob = sshServersDb.getSecretBlob(userId, serverId);
  if (!blob) {
    console.warn(`${logPfx} step=reject reason=no_secret_blob code=SSH_NO_SECRETS (PUT /secrets first)`);
    return res.status(400).json({
      error: 'No credentials stored. Save secrets first (PUT .../secrets).',
      code: 'SSH_NO_SECRETS',
    });
  }

  let secrets;
  try {
    secrets = JSON.parse(decryptSecret(blob));
  } catch (error) {
    console.error(`${logPfx} step=decrypt_failed`, error);
    return res.status(500).json({
      error: 'Failed to decrypt credentials. Check CLOUDCLI_VAULT_KEY matches the key used when storing.',
      code: 'SSH_DECRYPT_FAILED',
    });
  }

  const hasPk = Boolean(secrets?.privateKey && String(secrets.privateKey).trim());
  const hasPw = Boolean(secrets?.password);
  console.log(
    `${logPfx} step=secrets_loaded auth_type=${server.auth_type} hasPrivateKeyField=${hasPk} hasPasswordField=${hasPw}`,
  );
  if (server.auth_type === 'private_key' && !hasPk) {
    console.warn(`${logPfx} step=reject reason=decrypted_json_missing_privateKey (auth is private_key)`);
    return res.status(400).json({
      error: 'Stored credentials are missing private key. Re-save secrets (PUT .../secrets).',
      code: 'SSH_SECRETS_INCOMPLETE',
    });
  }
  if (server.auth_type === 'password' && !hasPw) {
    console.warn(`${logPfx} step=reject reason=decrypted_json_missing_password (auth is password)`);
    return res.status(400).json({
      error: 'Stored credentials are missing password. Re-save secrets (PUT .../secrets).',
      code: 'SSH_SECRETS_INCOMPLETE',
    });
  }

  try {
    console.log(`${logPfx} step=ssh_test_start`);
    const result = await testSshConnection({
      host: server.host,
      port: server.port,
      username: server.username,
      privateKey: server.auth_type === 'private_key' ? secrets.privateKey : undefined,
      passphrase: secrets.privateKeyPassphrase || undefined,
      password: server.auth_type === 'password' ? secrets.password : undefined,
    });
    const ms = Date.now() - t0;
    sshServersDb.touchServerConnection(
      userId,
      serverId,
      true,
      null,
      result.hostKeyFingerprintSha256,
    );
    console.log(
      `${logPfx} step=ssh_test_ok hostKey_fp=${result.hostKeyFingerprintSha256 || 'null'} totalMs=${ms}`,
    );
    res.json({
      ok: true,
      hostKeyFingerprintSha256: result.hostKeyFingerprintSha256,
    });
  } catch (error) {
    const ms = Date.now() - t0;
    const errMsg = error && typeof error.message === 'string' ? error.message : String(error);
    console.error(
      `${logPfx} step=ssh_test_failed afterMs=${ms} error=${errMsg} (client will get HTTP 400 + SSH_CONNECT_FAILED)`,
    );
    sshServersDb.touchServerConnection(userId, serverId, false, errMsg, null);
    res.status(400).json({
      ok: false,
      error: errMsg || 'SSH connection failed',
      code: 'SSH_CONNECT_FAILED',
    });
  }
});

/**
 * 远端 claude / claudecode 探测 + 可配置安装基址（与 docs §5 一致）。
 */
router.post('/:serverId/claude-probe', async (req, res) => {
  const userId = req.user.id;
  const serverId = parseInt(req.params.serverId, 10);
  if (!Number.isFinite(serverId)) {
    return res.status(400).json({ error: 'Invalid server id' });
  }
  const server = sshServersDb.getServer(userId, serverId);
  if (!server) {
    return res.status(404).json({ error: 'Server not found' });
  }
  const blob = sshServersDb.getSecretBlob(userId, serverId);
  if (!blob) {
    return res.status(400).json({ error: 'No credentials stored', code: 'SSH_NO_SECRETS' });
  }
  try {
    JSON.parse(decryptSecret(blob));
  } catch (error) {
    console.error('[ssh-servers] claude-probe decrypt:', error);
    return res.status(500).json({
      error: 'Failed to decrypt credentials. Check CLOUDCLI_VAULT_KEY',
      code: 'SSH_DECRYPT_FAILED',
    });
  }
  const host = server.host || '';
  const display = server.display_name != null ? String(server.display_name) : '';
  console.log(
    `[ssh-servers] claude-probe step=request userId=${userId} serverId=${serverId} host=${host} displayName=${display}`,
  );
  try {
    const probe = await probeRemoteClaudeEnv(userId, serverId);
    console.log(
      `[ssh-servers] claude-probe step=ok userId=${userId} serverId=${serverId} host=${host} hasCli=${probe.hasCli} claudecodePath=${probe.claudecodePath == null ? 'null' : JSON.stringify(probe.claudecodePath)} claudePath=${probe.claudePath == null ? 'null' : JSON.stringify(probe.claudePath)} installFamily=${probe.installFamily}`,
    );
    return res.json(probe);
  } catch (e) {
    const msg = e && typeof e.message === 'string' ? e.message : 'claude-probe failed';
    console.error(
      `[ssh-servers] claude-probe step=error userId=${userId} serverId=${serverId} host=${host}:`,
      e,
    );
    return res.status(400).json({ error: msg, code: 'SSH_CLAUDE_PROBE_FAILED' });
  }
});

/**
 * 远程列目录（SFTP），`path` 缺省时为远程 `$HOME`。需已保存凭据。
 */
router.get('/:serverId/browse-dir', async (req, res) => {
  const userId = req.user.id;
  const serverId = parseInt(req.params.serverId, 10);
  if (!Number.isFinite(serverId)) {
    return res.status(400).json({ error: 'Invalid server id' });
  }
  const server = sshServersDb.getServer(userId, serverId);
  if (!server) {
    return res.status(404).json({ error: 'Server not found' });
  }
  const blob = sshServersDb.getSecretBlob(userId, serverId);
  if (!blob) {
    return res.status(400).json({ error: 'No credentials stored', code: 'SSH_NO_SECRETS' });
  }
  try {
    JSON.parse(decryptSecret(blob));
  } catch (error) {
    console.error('[ssh-servers] browse-dir decrypt:', error);
    return res.status(500).json({
      error: 'Failed to decrypt credentials. Check CLOUDCLI_VAULT_KEY',
      code: 'SSH_DECRYPT_FAILED',
    });
  }
  const q = req.query && req.query.path != null && String(req.query.path).trim() ? String(req.query.path) : undefined;
  console.log(
    `[ssh-servers] GET /browse-dir userId=${userId} serverId=${serverId} host=${server.host || ''} hasPathParam=${Boolean(q)}`,
  );
  try {
    const data = await listRemoteSftpDirectory(userId, serverId, q);
    return res.json(data);
  } catch (e) {
    const code = e && e.code;
    const msg = e && typeof e.message === 'string' ? e.message : 'browse-dir failed';
    if (code === 'OPEN_PROJECT_PATH_REJECTED' || (typeof code === 'string' && code.startsWith('OPEN_'))) {
      return res.status(400).json({ error: msg, code: code || 'BROWSE_PATH_INVALID' });
    }
    console.error(`[ssh-servers] browse-dir error userId=${userId} serverId=${serverId}:`, e);
    return res.status(400).json({ error: msg, code: 'BROWSE_DIR_FAILED' });
  }
});

/**
 * 在远程项目目录下执行 claudecode/claude `-p`（与本地 `cd` + CLI 行为一致，便于在服务端日志中排查）。
 * `projectName`（在 `~/.claude/projects` 已登记）与 `projectPath`（任意合法绝对目录）二选一。
 */
router.post('/:serverId/open-claude-project', async (req, res) => {
  const userId = req.user.id;
  const serverId = parseInt(req.params.serverId, 10);
  if (!Number.isFinite(serverId)) {
    return res.status(400).json({ error: 'Invalid server id' });
  }
  const projectName = req.body && req.body.projectName;
  const projectPath = req.body && req.body.projectPath;
  const hasName = projectName && typeof projectName === 'string' && projectName.trim();
  const hasPath = projectPath && typeof projectPath === 'string' && projectPath.trim();
  if (hasName && hasPath) {
    return res.status(400).json({ error: 'Provide only one of projectName or projectPath', code: 'OPEN_PROJECT_BAD_REQUEST' });
  }
  if (!hasName && !hasPath) {
    return res.status(400).json({ error: 'projectName or projectPath is required', code: 'OPEN_PROJECT_BAD_REQUEST' });
  }
  const server = sshServersDb.getServer(userId, serverId);
  if (!server) {
    return res.status(404).json({ error: 'Server not found' });
  }
  const blob = sshServersDb.getSecretBlob(userId, serverId);
  if (!blob) {
    return res.status(400).json({ error: 'No credentials stored', code: 'SSH_NO_SECRETS' });
  }
  try {
    JSON.parse(decryptSecret(blob));
  } catch (error) {
    console.error('[ssh-servers] open-claude-project decrypt:', error);
    return res.status(500).json({
      error: 'Failed to decrypt credentials. Check CLOUDCLI_VAULT_KEY',
      code: 'SSH_DECRYPT_FAILED',
    });
  }
  const host = server.host || '';
  const display = server.display_name != null ? String(server.display_name) : '';
  const prompt = req.body && typeof req.body.prompt === 'string' ? req.body.prompt : undefined;
  console.log(
    `[ssh-servers] open-claude-project step=request userId=${userId} serverId=${serverId} host=${host} displayName=${display} hasPath=${Boolean(hasPath)} projectName=${
      hasName ? JSON.stringify(String(projectName).trim()) : '""'
    } hasPromptField=${Boolean(prompt)}`,
  );
  try {
    const run = await runRemoteClaudeOpenProject(userId, serverId, {
      prompt,
      ...(hasPath ? { projectPath: String(projectPath).trim() } : { projectName: String(projectName).trim() }),
    });
    const cap = 50_000;
    const slice = (s) => (s && s.length > cap ? s.slice(0, cap) + '\n…[truncated]…' : s || '');
    if (run.timedOut) {
      return res.status(400).json({
        ok: false,
        error: 'Remote open command timed out',
        code: 'OPEN_PROJECT_TIMEOUT',
        mode: run.mode,
        projectName: run.projectName,
        cwd: run.cwd,
        prompt: run.prompt,
        exitCode: run.exitCode,
        stdout: slice(run.stdout),
        stderr: slice(run.stderr),
        timedOut: true,
      });
    }
    if (run.exitCode !== 0) {
      const msg = (run.stderr && run.stderr.trim()) || (run.stdout && run.stdout.trim()) || `Exit code ${run.exitCode}`;
      return res.status(400).json({
        ok: false,
        error: msg,
        code: 'OPEN_PROJECT_FAILED',
        mode: run.mode,
        projectName: run.projectName,
        cwd: run.cwd,
        prompt: run.prompt,
        exitCode: run.exitCode,
        stdout: slice(run.stdout),
        stderr: slice(run.stderr),
        timedOut: false,
      });
    }
    return res.json({
      ok: true,
      mode: run.mode,
      projectName: run.projectName,
      cwd: run.cwd,
      prompt: run.prompt,
      exitCode: run.exitCode,
      stdout: slice(run.stdout),
      stderr: slice(run.stderr),
    });
  } catch (e) {
    const code = e && typeof e.code === 'string' ? e.code : null;
    const msg = e && typeof e.message === 'string' ? e.message : 'open-claude-project failed';
    if (code === 'REMOTE_PROJECT_NOT_FOUND') {
      return res.status(404).json({ error: msg, code });
    }
    if (
      code === 'REMOTE_PROJECT_PATH_INVALID' ||
      code === 'OPEN_PROJECT_BAD_REQUEST' ||
      code === 'OPEN_PROJECT_PATH_REJECTED'
    ) {
      return res.status(400).json({ error: msg, code: code || 'OPEN_PROJECT_BAD_REQUEST' });
    }
    console.error(`[ssh-servers] open-claude-project step=error userId=${userId} serverId=${serverId} host=${host}:`, e);
    return res.status(500).json({ error: msg, code: 'OPEN_PROJECT_FAILED' });
  }
});

/**
 * 白名单化远程执行安装；安装日志可能很长；成功后建议再调 claude-probe 或切项目以刷新。
 */
router.post('/:serverId/claude-install', async (req, res) => {
  const userId = req.user.id;
  const serverId = parseInt(req.params.serverId, 10);
  if (!Number.isFinite(serverId)) {
    return res.status(400).json({ error: 'Invalid server id' });
  }
  if (!isVaultConfigured()) {
    return res.status(503).json({ error: 'Vault not configured', code: 'VAULT_NOT_CONFIGURED' });
  }
  const server = sshServersDb.getServer(userId, serverId);
  if (!server) {
    return res.status(404).json({ error: 'Server not found' });
  }
  const blob = sshServersDb.getSecretBlob(userId, serverId);
  if (!blob) {
    return res.status(400).json({ error: 'No credentials stored', code: 'SSH_NO_SECRETS' });
  }
  try {
    JSON.parse(decryptSecret(blob));
  } catch (error) {
    return res.status(500).json({ error: 'Failed to decrypt credentials', code: 'SSH_DECRYPT_FAILED' });
  }
  try {
    const run = await runRemoteClaudeInstall(userId, serverId, req.body || {});
    if (run && run.skipped) {
      return res.json(run);
    }
    const { code, stdout, stderr, timedOut } = run;
    if (timedOut) {
      return res.status(400).json({
        ok: false,
        error: 'Remote install timed out',
        code: 'INSTALL_TIMEOUT',
        exitCode: code,
        stdout,
        stderr,
        timedOut: true,
      });
    }
    const ok = code === 0;
    let afterProbe;
    if (ok) {
      try {
        afterProbe = await probeRemoteClaudeEnv(userId, serverId);
      } catch (e) {
        afterProbe = { error: e && e.message };
      }
    }
    if (!ok) {
      return res.status(400).json({
        ok: false,
        error: stderr || `Remote install exited with code ${code}`,
        code: 'INSTALL_FAILED',
        exitCode: code,
        stdout: stdout && stdout.slice(0, 200_000),
        stderr: stderr && stderr.slice(0, 200_000),
        afterProbe: afterProbe || null,
      });
    }
    return res.json({
      ok: true,
      exitCode: code,
      stdout: stdout && stdout.slice(0, 200_000),
      stderr: stderr && stderr.slice(0, 200_000),
      afterProbe: afterProbe || null,
    });
  } catch (e) {
    const msg = e && typeof e.message === 'string' ? e.message : 'install failed';
    console.error('[ssh-servers] claude-install:', e);
    if (String(msg).includes('must be') || String(msg).includes('not match')) {
      return res.status(400).json({ error: msg, code: 'INSTALL_VALIDATION' });
    }
    return res.status(400).json({ error: msg, code: 'INSTALL_FAILED' });
  }
});

export default router;
