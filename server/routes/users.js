import express from 'express';
import { userDb, userWorkspacesDb, userMcpConfigsDb, userSettingsDb } from '../database/db.js';
import { authenticateToken, requireAdmin } from '../middleware/auth.js';

const router = express.Router();

// ─── User Workspaces ─────────────────────────────────────────────────────────

// Get current user's workspaces
router.get('/workspaces', authenticateToken, (req, res) => {
  try {
    const workspaces = userWorkspacesDb.getWorkspaces(req.user.id);
    res.json({ workspaces });
  } catch (error) {
    console.error('Get workspaces error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get current user's default workspace
router.get('/workspaces/default', authenticateToken, (req, res) => {
  try {
    const workspace = userWorkspacesDb.getDefaultWorkspace(req.user.id);
    if (!workspace) {
      return res.status(404).json({ error: 'No default workspace found' });
    }
    res.json({ workspace });
  } catch (error) {
    console.error('Get default workspace error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create workspace for current user
router.post('/workspaces', authenticateToken, (req, res) => {
  try {
    const { name, root_path, is_default } = req.body;

    if (!name || !root_path) {
      return res.status(400).json({ error: 'Name and root_path are required' });
    }

    const workspace = userWorkspacesDb.createWorkspace(req.user.id, name, root_path, is_default);
    res.json({ success: true, workspace });
  } catch (error) {
    console.error('Create workspace error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update workspace
router.put('/workspaces/:workspaceId', authenticateToken, (req, res) => {
  try {
    const { workspaceId } = req.params;
    const { name, root_path, is_default } = req.body;

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (root_path !== undefined) updates.root_path = root_path;
    if (is_default !== undefined) updates.is_default = is_default;

    const success = userWorkspacesDb.updateWorkspace(req.user.id, parseInt(workspaceId), updates);
    if (!success) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Update workspace error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete workspace
router.delete('/workspaces/:workspaceId', authenticateToken, (req, res) => {
  try {
    const { workspaceId } = req.params;

    // Prevent deleting default workspace
    const workspace = userWorkspacesDb.getWorkspaceById(req.user.id, parseInt(workspaceId));
    if (!workspace) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    if (workspace.is_default) {
      return res.status(400).json({ error: 'Cannot delete default workspace' });
    }

    const success = userWorkspacesDb.deleteWorkspace(req.user.id, parseInt(workspaceId));
    if (!success) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Delete workspace error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── User MCP Configs ────────────────────────────────────────────────────────

// Get current user's MCP config for a provider
router.get('/mcp-config/:provider?', authenticateToken, (req, res) => {
  try {
    const provider = req.params.provider || 'claude';
    const config = userMcpConfigsDb.getConfig(req.user.id, provider);
    res.json({ config: config || {} });
  } catch (error) {
    console.error('Get MCP config error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Save current user's MCP config
router.put('/mcp-config/:provider?', authenticateToken, (req, res) => {
  try {
    const provider = req.params.provider || 'claude';
    const config = req.body;

    userMcpConfigsDb.saveConfig(req.user.id, provider, config);
    res.json({ success: true });
  } catch (error) {
    console.error('Save MCP config error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete current user's MCP config
router.delete('/mcp-config/:provider?', authenticateToken, (req, res) => {
  try {
    const provider = req.params.provider || 'claude';

    userMcpConfigsDb.deleteConfig(req.user.id, provider);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete MCP config error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── User Settings ───────────────────────────────────────────────────────────

// Get all settings for current user
router.get('/settings', authenticateToken, (req, res) => {
  try {
    const settings = userSettingsDb.getAllSettings(req.user.id);
    res.json({ settings });
  } catch (error) {
    console.error('Get settings error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get a specific setting
router.get('/settings/:key', authenticateToken, (req, res) => {
  try {
    const value = userSettingsDb.getSetting(req.user.id, req.params.key);
    res.json({ value: value !== null ? value : undefined });
  } catch (error) {
    console.error('Get setting error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Set a setting
router.put('/settings/:key', authenticateToken, (req, res) => {
  try {
    const value = req.body.value;
    if (value === undefined) {
      return res.status(400).json({ error: 'Value is required' });
    }

    userSettingsDb.setSetting(req.user.id, req.params.key, value);
    res.json({ success: true });
  } catch (error) {
    console.error('Set setting error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete a setting
router.delete('/settings/:key', authenticateToken, (req, res) => {
  try {
    const success = userSettingsDb.deleteSetting(req.user.id, req.params.key);
    res.json({ success });
  } catch (error) {
    console.error('Delete setting error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
