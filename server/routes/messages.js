/**
 * Unified messages endpoint.
 *
 * GET /api/sessions/:sessionId/messages?provider=claude&projectName=foo&limit=50&offset=0
 *
 * Replaces the four provider-specific session message endpoints with a single route
 * that delegates to the appropriate adapter via the provider registry.
 *
 * @module routes/messages
 */

import express from 'express';
import { getProvider, getAllProviders } from '../providers/registry.js';
import { chatImagesDebugLog, isChatImagesDebugEnabled } from '../providers/claude/chat-images-debug.js';
import { parseTargetScope } from '../utils/parse-target-scope.js';
import { getRemoteClaudeSessionMessages } from '../remote/remote-claude-data.js';

const router = express.Router();

/**
 * GET /api/sessions/:sessionId/messages
 */
router.get('/:sessionId/messages', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const provider = req.query.provider || 'claude';
    const projectName = req.query.projectName || '';
    const projectPath = req.query.projectPath || '';
    const limitParam = req.query.limit;
    const limit = limitParam !== undefined && limitParam !== null && limitParam !== ''
      ? parseInt(limitParam, 10)
      : null;
    const offset = parseInt(req.query.offset || '0', 10);

    const scope = parseTargetScope(req);
    if (scope.kind === 'invalid') {
      return res.status(400).json({ error: scope.error, code: 'INVALID_TARGET' });
    }
    if (scope.kind === 'remote') {
      if (provider !== 'claude') {
        return res.status(501).json({
          error: 'Remote target history (non-Claude) is not implemented in this release.',
          code: 'REMOTE_HISTORY_NOT_SUPPORTED',
        });
      }
      if (!projectName) {
        return res.status(400).json({ error: 'projectName is required' });
      }
      const { sshServersDb } = await import('../database/db.js');
      if (!sshServersDb.getServer(req.user.id, scope.serverId)) {
        return res.status(404).json({ error: 'SSH server not found' });
      }
      const result = await getRemoteClaudeSessionMessages(
        req.user.id,
        scope.serverId,
        projectName,
        sessionId,
        limit,
        offset,
        { projectPath },
      );
      if (isChatImagesDebugEnabled() && provider === 'claude' && Array.isArray(result?.messages)) {
        chatImagesDebugLog('GET messages query (remote SSH)', {
          sessionId,
          serverId: scope.serverId,
          projectName: projectName || '(empty)',
          limit,
          offset,
          note: 'remote：SFTP enrich（projectPath 优先，否则 jsonl 推断 cwd）',
        });
        const userWithImages = result.messages.filter(
          (m) => m.kind === 'text' && m.role === 'user' && Array.isArray(m.images) && m.images.length > 0,
        ).length;
        chatImagesDebugLog('GET messages response (remote)', {
          total: result.messages.length,
          userRowsWithImages: userWithImages,
        });
      }
      return res.json(result);
    }

    const adapter = getProvider(provider);
    if (!adapter) {
      const available = getAllProviders().join(', ');
      return res.status(400).json({ error: `Unknown provider: ${provider}. Available: ${available}` });
    }

    if (isChatImagesDebugEnabled() && provider === 'claude') {
      chatImagesDebugLog('GET messages query', {
        sessionId,
        projectName: projectName || '(empty)',
        projectPath: projectPath ? String(projectPath).slice(0, 240) : '(empty)',
        limit,
        offset,
      });
    }

    const result = await adapter.fetchHistory(sessionId, {
      projectName,
      projectPath,
      limit,
      offset,
    });

    if (isChatImagesDebugEnabled() && provider === 'claude' && Array.isArray(result?.messages)) {
      const userWithImages = result.messages.filter(
        (m) => m.kind === 'text' && m.role === 'user' && Array.isArray(m.images) && m.images.length > 0,
      ).length;
      chatImagesDebugLog('GET messages response', {
        total: result.messages.length,
        userRowsWithImages: userWithImages,
      });
    }

    return res.json(result);
  } catch (error) {
    console.error('Error fetching unified messages:', error);
    return res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

export default router;
