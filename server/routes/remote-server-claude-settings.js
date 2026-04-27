/**
 * 远程：多渠本机目录（claude-providers）+ 配置模板（claude_md）+ 在远程项目下追加 CLAUDE.md。
 * 每服务器下发走 `/api/ssh-servers/:id/claude-providers-apply`：`scope` 缺省或 `model` 为多渠与 OpenAI/Zen；`scope: system` 为 IS_SANDBOX 与本库按服务器的授权工具（见 ssh-servers 路由）。
 * 挂载在 `app.use("/api", authenticateToken, thisRouter)` 下。
 *
 * @module server/routes/remote-server-claude-settings
 */

import express from 'express';
import { sshServersDb, remoteConfigTemplatesDb, claudeProviderCatalogDb, sshServerClaudeProviderPrefsDb } from '../database/db.js';
import { encryptSecret, decryptSecret, isVaultConfigured } from '../utils/ssh-vault.js';
import { applyClaudeMdToRemoteProject } from '../services/remote-claude-env-push.js';
import { normalizeModelsForCli } from '../services/remote-claude-providers-apply.js';

const router = express.Router();
const CATALOG_LOG = '[claude-providers]';
const CHANNEL_RE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * @param {string} channelId
 * @param {string} baseUrl
 * @param {string} models
 */
function validateProviderPayload(channelId, baseUrl, models) {
  if (!channelId || !CHANNEL_RE.test(String(channelId).trim())) {
    return 'channelId must be 1–128 chars: letters, digits, . _ -';
  }
  if (!baseUrl || typeof baseUrl !== 'string') {
    return 'baseUrl is required';
  }
  let u;
  try {
    u = new URL(baseUrl.trim());
  } catch {
    return 'baseUrl must be a valid URL (http or https)';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return 'baseUrl must use http or https';
  }
  const m = normalizeModelsForCli(models);
  if (!m) {
    return 'models is required (comma- or line-separated list)';
  }
  return null;
}

function ensureServerSecrets(res, userId, serverId) {
  const server = sshServersDb.getServer(userId, serverId);
  if (!server) {
    res.status(404).json({ error: 'Server not found' });
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

/** GET /claude-providers — 本地多渠配置列表（不返回明文 key） */
router.get('/claude-providers', (req, res) => {
  try {
    const userId = req.user.id;
    const rows = claudeProviderCatalogDb.list(userId);
    res.json(
      rows.map((r) => ({
        id: r.id,
        channelId: r.channel_id,
        baseUrl: r.base_url,
        models: r.models_raw,
        hasApiKey: Boolean(r.has_api_key),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    );
  } catch (e) {
    console.error(`${CATALOG_LOG} list`, e);
    res.status(500).json({ error: 'Failed to list providers' });
  }
});

/** POST /claude-providers */
router.post('/claude-providers', (req, res) => {
  try {
    const userId = req.user.id;
    const b = req.body || {};
    const channelId = typeof b.channelId === 'string' ? b.channelId.trim() : '';
    const baseUrl = typeof b.baseUrl === 'string' ? b.baseUrl : '';
    const models = typeof b.models === 'string' ? b.models : b.models == null ? '' : String(b.models);
    const apiKey = b.apiKey != null && typeof b.apiKey === 'string' ? b.apiKey : '';
    const v = validateProviderPayload(channelId, baseUrl, models);
    if (v) {
      return res.status(400).json({ error: v });
    }
    if (!isVaultConfigured()) {
      return res.status(503).json({ error: 'CLOUDCLI_VAULT_KEY is not configured; cannot store API key.', code: 'VAULT_NOT_CONFIGURED' });
    }
    if (!apiKey.trim()) {
      return res.status(400).json({ error: 'apiKey is required' });
    }
    const enc = encryptSecret(apiKey);
    const r0 = claudeProviderCatalogDb.create(
      userId,
      channelId,
      String(baseUrl).trim(),
      String(models).trim(),
      enc,
    );
    const row = claudeProviderCatalogDb.get(userId, r0.id);
    console.log(`${CATALOG_LOG} create userId=${userId} id=${r0.id} channelId=${channelId}`);
    if (!row) {
      return res.status(500).json({ error: 'create failed' });
    }
    res.status(201).json({
      id: row.id,
      channelId: row.channel_id,
      baseUrl: row.base_url,
      models: row.models_raw,
      hasApiKey: Boolean(row.api_key_encrypted),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  } catch (e) {
    if (e && e.code === 'VAULT_NOT_CONFIGURED') {
      return res.status(503).json({ error: e.message, code: e.code });
    }
    if (e && (e.message || '').includes('UNIQUE')) {
      return res.status(409).json({ error: 'A provider with this channelId already exists' });
    }
    console.error(`${CATALOG_LOG} create`, e);
    res.status(500).json({ error: 'Failed to create provider' });
  }
});

/** PUT /claude-providers/:entryId */
router.put('/claude-providers/:entryId', (req, res) => {
  try {
    const userId = req.user.id;
    const id = parseInt(req.params.entryId, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    const row0 = claudeProviderCatalogDb.get(userId, id);
    if (!row0) {
      return res.status(404).json({ error: 'Not found' });
    }
    const b = req.body || {};
    const channelId = typeof b.channelId === 'string' ? b.channelId.trim() : String(row0.channel_id);
    const baseUrl = typeof b.baseUrl === 'string' ? b.baseUrl : String(row0.base_url);
    const models = typeof b.models === 'string' ? b.models : b.models == null ? String(row0.models_raw) : String(b.models);
    const apiKey = b.apiKey != null && typeof b.apiKey === 'string' ? b.apiKey : '';
    const v = validateProviderPayload(channelId, baseUrl, models);
    if (v) {
      return res.status(400).json({ error: v });
    }
    let updateKey = false;
    let enc = null;
    if (apiKey.trim().length > 0) {
      if (!isVaultConfigured()) {
        return res.status(503).json({ error: 'CLOUDCLI_VAULT_KEY is not configured; cannot store API key.', code: 'VAULT_NOT_CONFIGURED' });
      }
      enc = encryptSecret(apiKey);
      updateKey = true;
    }
    const ok = claudeProviderCatalogDb.update(
      userId,
      id,
      channelId,
      String(baseUrl).trim(),
      String(models).trim(),
      enc,
      updateKey,
    );
    if (!ok) {
      return res.status(404).json({ error: 'Not found' });
    }
    const row = claudeProviderCatalogDb.get(userId, id);
    if (!row) {
      return res.status(500).json({ error: 'read failed' });
    }
    console.log(`${CATALOG_LOG} update userId=${userId} id=${id} channelId=${row.channel_id}`);
    res.json({
      id: row.id,
      channelId: row.channel_id,
      baseUrl: row.base_url,
      models: row.models_raw,
      hasApiKey: Boolean(row.api_key_encrypted),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  } catch (e) {
    if (e && e.code === 'VAULT_NOT_CONFIGURED') {
      return res.status(503).json({ error: e.message, code: e.code });
    }
    if (e && (e.message || '').includes('UNIQUE')) {
      return res.status(409).json({ error: 'A provider with this channelId already exists' });
    }
    console.error(`${CATALOG_LOG} update`, e);
    res.status(500).json({ error: 'Failed to update provider' });
  }
});

/** DELETE /claude-providers/:entryId */
router.delete('/claude-providers/:entryId', (req, res) => {
  try {
    const userId = req.user.id;
    const id = parseInt(req.params.entryId, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    if (!claudeProviderCatalogDb.get(userId, id)) {
      return res.status(404).json({ error: 'Not found' });
    }
    sshServerClaudeProviderPrefsDb.removeCatalogIdFromAllRows(userId, id);
    if (!claudeProviderCatalogDb.delete(userId, id)) {
      return res.status(404).json({ error: 'Not found' });
    }
    console.log(`${CATALOG_LOG} delete userId=${userId} id=${id}`);
    res.json({ success: true });
  } catch (e) {
    console.error(`${CATALOG_LOG} delete`, e);
    res.status(500).json({ error: 'Failed to delete' });
  }
});

/** GET /remote-config-templates?kind=claude_md|llm|null */
router.get('/remote-config-templates', (req, res) => {
  try {
    const userId = req.user.id;
    const kind = req.query && (req.query.kind === 'llm' || req.query.kind === 'claude_md') ? req.query.kind : null;
    const rows = remoteConfigTemplatesDb.list(userId, kind);
    res.json(rows);
  } catch (e) {
    console.error('[remote-config-templates] list', e);
    res.status(500).json({ error: 'Failed to list templates' });
  }
});

/** POST /remote-config-templates — 仅支持 kind=claude_md（新建） */
router.post('/remote-config-templates', (req, res) => {
  try {
    const userId = req.user.id;
    const { name, kind, payload } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (kind !== 'claude_md') {
      return res.status(400).json({ error: 'kind must be claude_md' });
    }
    const payloadJson = JSON.stringify(payload == null ? {} : payload);
    const r = remoteConfigTemplatesDb.create(userId, name, kind, payloadJson);
    const row = remoteConfigTemplatesDb.get(userId, r.id);
    res.status(201).json(row);
  } catch (e) {
    console.error('[remote-config-templates] create', e);
    res.status(500).json({ error: 'Failed to create template' });
  }
});

/** PUT /remote-config-templates/:templateId */
router.put('/remote-config-templates/:templateId', (req, res) => {
  try {
    const userId = req.user.id;
    const id = parseInt(req.params.templateId, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'Invalid template id' });
    }
    const { name, payload } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    const row0 = remoteConfigTemplatesDb.get(userId, id);
    if (!row0) {
      return res.status(404).json({ error: 'Template not found' });
    }
    const ok = remoteConfigTemplatesDb.update(userId, id, name, JSON.stringify(payload == null ? {} : payload));
    if (!ok) {
      return res.status(404).json({ error: 'Template not found' });
    }
    res.json(remoteConfigTemplatesDb.get(userId, id));
  } catch (e) {
    console.error('[remote-config-templates] update', e);
    res.status(500).json({ error: 'Failed to update template' });
  }
});

/** DELETE /remote-config-templates/:templateId */
router.delete('/remote-config-templates/:templateId', (req, res) => {
  try {
    const userId = req.user.id;
    const id = parseInt(req.params.templateId, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'Invalid template id' });
    }
    const ok = remoteConfigTemplatesDb.delete(userId, id);
    if (!ok) {
      return res.status(404).json({ error: 'Template not found' });
    }
    res.json({ success: true });
  } catch (e) {
    console.error('[remote-config-templates] delete', e);
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

/** POST /ssh-servers/:serverId/claude-md/apply  body: { projectPath, templateId?, blockText? } */
router.post('/ssh-servers/:serverId/claude-md/apply', async (req, res) => {
  const userId = req.user.id;
  const serverId = parseInt(req.params.serverId, 10);
  if (!Number.isFinite(serverId)) {
    return res.status(400).json({ error: 'Invalid server id' });
  }
  if (!ensureServerSecrets(res, userId, serverId)) {
    return;
  }
  const { projectPath, templateId, blockText } = req.body || {};
  if (!projectPath || typeof projectPath !== 'string' || !projectPath.trim()) {
    return res.status(400).json({ error: 'projectPath is required' });
  }
  let text = blockText && typeof blockText === 'string' ? blockText : '';
  if (templateId != null) {
    const tid = parseInt(String(templateId), 10);
    if (!Number.isFinite(tid)) {
      return res.status(400).json({ error: 'Invalid templateId' });
    }
    const row = remoteConfigTemplatesDb.get(userId, tid);
    if (!row || row.kind !== 'claude_md') {
      return res.status(404).json({ error: 'CLAUDE.md template not found' });
    }
    try {
      const p = JSON.parse(row.payload_json || '{}');
      text = (p.body != null && String(p.body)) || p.markdown || p.text || text;
    } catch {
      /* */
    }
  }
  if (!text || !String(text).trim()) {
    return res.status(400).json({ error: 'blockText or a template with body is required' });
  }
  try {
    const r = await applyClaudeMdToRemoteProject(userId, serverId, projectPath, text);
    return res.json({ ok: true, ...r });
  } catch (e) {
    const c = e && e.code;
    if (c === 'OPEN_PROJECT_PATH_REJECTED' || c === 'CLAUDE_MD_EMPTY') {
      return res.status(400).json({ error: e.message, code: c || 'APPLY_CLAUDE_MD_INVALID' });
    }
    console.error('[claude-md/apply]', e);
    return res.status(500).json({ error: e.message || 'apply claude.md failed' });
  }
});

export default router;
