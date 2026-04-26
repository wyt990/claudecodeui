import { IS_PLATFORM } from "../constants/config";
import { getTargetKey } from './targetKey.js';

// Utility function for authenticated API calls
export const authenticatedFetch = (url, options = {}) => {
  const token = localStorage.getItem('auth-token');

  const defaultHeaders = {};

  // Only set Content-Type for non-FormData requests
  if (!(options.body instanceof FormData)) {
    defaultHeaders['Content-Type'] = 'application/json';
  }

  if (!IS_PLATFORM && token) {
    defaultHeaders['Authorization'] = `Bearer ${token}`;
  }

  try {
    const tk = getTargetKey();
    if (tk) {
      defaultHeaders['x-cloudcli-target'] = tk;
    }
  } catch {
    // ignore: target key optional for unauthenticated or SSR
  }

  return fetch(url, {
    ...options,
    headers: {
      ...defaultHeaders,
      ...options.headers,
    },
  }).then((response) => {
    const refreshedToken = response.headers.get('X-Refreshed-Token');
    if (refreshedToken) {
      localStorage.setItem('auth-token', refreshedToken);
    }
    return response;
  });
};

// API endpoints
export const api = {
  // Auth endpoints (no token required)
  auth: {
    status: () => fetch('/api/auth/status'),
    login: (username, password) => fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
    register: (username, password) => fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
    user: () => authenticatedFetch('/api/auth/user'),
    logout: () => authenticatedFetch('/api/auth/logout', { method: 'POST' }),
  },

  // Protected endpoints
  // config endpoint removed - no longer needed (frontend uses window.location)
  projects: () => authenticatedFetch('/api/projects'),
  sessions: (projectName, limit = 5, offset = 0) =>
    authenticatedFetch(`/api/projects/${projectName}/sessions?limit=${limit}&offset=${offset}`),
  // Unified endpoint — all providers through one URL
  unifiedSessionMessages: (sessionId, provider = 'claude', { projectName = '', projectPath = '', limit = null, offset = 0 } = {}) => {
    const params = new URLSearchParams();
    params.append('provider', provider);
    if (projectName) params.append('projectName', projectName);
    if (projectPath) params.append('projectPath', projectPath);
    if (limit !== null) {
      params.append('limit', String(limit));
      params.append('offset', String(offset));
    }
    const queryString = params.toString();
    return authenticatedFetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages${queryString ? `?${queryString}` : ''}`);
  },
  renameProject: (projectName, displayName) =>
    authenticatedFetch(`/api/projects/${projectName}/rename`, {
      method: 'PUT',
      body: JSON.stringify({ displayName }),
    }),
  deleteSession: (projectName, sessionId) =>
    authenticatedFetch(`/api/projects/${projectName}/sessions/${sessionId}`, {
      method: 'DELETE',
    }),
  renameSession: (sessionId, summary, provider) =>
    authenticatedFetch(`/api/sessions/${sessionId}/rename`, {
      method: 'PUT',
      body: JSON.stringify({ summary, provider }),
    }),
  deleteCodexSession: (sessionId) =>
    authenticatedFetch(`/api/codex/sessions/${sessionId}`, {
      method: 'DELETE',
    }),
  deleteGeminiSession: (sessionId) =>
    authenticatedFetch(`/api/gemini/sessions/${sessionId}`, {
      method: 'DELETE',
    }),
  deleteProject: (projectName, force = false) =>
    authenticatedFetch(`/api/projects/${projectName}${force ? '?force=true' : ''}`, {
      method: 'DELETE',
    }),
  searchConversationsUrl: (query, limit = 50) => {
    const token = localStorage.getItem('auth-token');
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    if (token) params.set('token', token);
    return `/api/search/conversations?${params.toString()}`;
  },
  createProject: (path) =>
    authenticatedFetch('/api/projects/create', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  createWorkspace: (workspaceData) =>
    authenticatedFetch('/api/projects/create-workspace', {
      method: 'POST',
      body: JSON.stringify(workspaceData),
    }),
  readFile: (projectName, filePath) =>
    authenticatedFetch(`/api/projects/${projectName}/file?filePath=${encodeURIComponent(filePath)}`),
  readFileBlob: (projectName, filePath) =>
    authenticatedFetch(`/api/projects/${projectName}/files/content?path=${encodeURIComponent(filePath)}`),
  saveFile: (projectName, filePath, content) =>
    authenticatedFetch(`/api/projects/${projectName}/file`, {
      method: 'PUT',
      body: JSON.stringify({ filePath, content }),
    }),
  getFiles: (projectName, options = {}) =>
    authenticatedFetch(`/api/projects/${projectName}/files`, options),

  // File operations
  createFile: (projectName, { path, type, name }) =>
    authenticatedFetch(`/api/projects/${projectName}/files/create`, {
      method: 'POST',
      body: JSON.stringify({ path, type, name }),
    }),

  renameFile: (projectName, { oldPath, newName }) =>
    authenticatedFetch(`/api/projects/${projectName}/files/rename`, {
      method: 'PUT',
      body: JSON.stringify({ oldPath, newName }),
    }),

  moveFile: (projectName, { fromPath, toDirectoryPath }) =>
    authenticatedFetch(`/api/projects/${projectName}/files/move`, {
      method: 'PUT',
      body: JSON.stringify({ fromPath, toDirectoryPath }),
    }),

  deleteFile: (projectName, { path, type }) =>
    authenticatedFetch(`/api/projects/${projectName}/files`, {
      method: 'DELETE',
      body: JSON.stringify({ path, type }),
    }),

  uploadFiles: (projectName, formData) =>
    authenticatedFetch(`/api/projects/${projectName}/files/upload`, {
      method: 'POST',
      body: formData,
      headers: {}, // Let browser set Content-Type for FormData
    }),

  // TaskMaster endpoints
  taskmaster: {
    // Initialize TaskMaster in a project
    init: (projectName) =>
      authenticatedFetch(`/api/taskmaster/init/${projectName}`, {
        method: 'POST',
      }),

    // Add a new task
    addTask: (projectName, { prompt, title, description, priority, dependencies }) =>
      authenticatedFetch(`/api/taskmaster/add-task/${projectName}`, {
        method: 'POST',
        body: JSON.stringify({ prompt, title, description, priority, dependencies }),
      }),

    // Parse PRD to generate tasks
    parsePRD: (projectName, { fileName, numTasks, append }) =>
      authenticatedFetch(`/api/taskmaster/parse-prd/${projectName}`, {
        method: 'POST',
        body: JSON.stringify({ fileName, numTasks, append }),
      }),

    // Get available PRD templates
    getTemplates: () =>
      authenticatedFetch('/api/taskmaster/prd-templates'),

    // Apply a PRD template
    applyTemplate: (projectName, { templateId, fileName, customizations }) =>
      authenticatedFetch(`/api/taskmaster/apply-template/${projectName}`, {
        method: 'POST',
        body: JSON.stringify({ templateId, fileName, customizations }),
      }),

    // Update a task
    updateTask: (projectName, taskId, updates) =>
      authenticatedFetch(`/api/taskmaster/update-task/${projectName}/${taskId}`, {
        method: 'PUT',
        body: JSON.stringify(updates),
      }),
  },

  // Browse filesystem for project suggestions
  browseFilesystem: (dirPath = null) => {
    const params = new URLSearchParams();
    if (dirPath) params.append('path', dirPath);

    return authenticatedFetch(`/api/browse-filesystem?${params}`);
  },

  createFolder: (folderPath) =>
    authenticatedFetch('/api/create-folder', {
      method: 'POST',
      body: JSON.stringify({ path: folderPath }),
    }),

  // User endpoints
  user: {
    gitConfig: () => authenticatedFetch('/api/user/git-config'),
    updateGitConfig: (gitName, gitEmail) =>
      authenticatedFetch('/api/user/git-config', {
        method: 'POST',
        body: JSON.stringify({ gitName, gitEmail }),
      }),
    onboardingStatus: () => authenticatedFetch('/api/user/onboarding-status'),
    completeOnboarding: () =>
      authenticatedFetch('/api/user/complete-onboarding', {
        method: 'POST',
      }),
  },

  // User management endpoints (admin only)
  users: {
    // Get all users
    getAll: () => authenticatedFetch('/api/auth/users'),

    // Update user
    update: (userId, updates) =>
      authenticatedFetch(`/api/auth/users/${userId}`, {
        method: 'PUT',
        body: JSON.stringify(updates),
      }),

    // Delete user (soft delete)
    delete: (userId) =>
      authenticatedFetch(`/api/auth/users/${userId}`, {
        method: 'DELETE',
      }),

    // Permanently delete user
    permanentDelete: (userId) =>
      authenticatedFetch(`/api/auth/users/${userId}/permanent`, {
        method: 'DELETE',
      }),

    // Change user password
    changePassword: (userId, newPassword, currentPassword) =>
      authenticatedFetch(`/api/auth/users/${userId}/password`, {
        method: 'PUT',
        body: JSON.stringify({ newPassword, currentPassword }),
      }),
  },

  // User workspaces endpoints
  workspaces: {
    // Get all workspaces for current user
    getAll: () => authenticatedFetch('/api/users/workspaces'),

    // Get default workspace
    getDefault: () => authenticatedFetch('/api/users/workspaces/default'),

    // Create workspace
    create: (name, rootPath, isDefault = false) =>
      authenticatedFetch('/api/users/workspaces', {
        method: 'POST',
        body: JSON.stringify({ name, root_path: rootPath, is_default: isDefault }),
      }),

    // Update workspace
    update: (workspaceId, updates) =>
      authenticatedFetch(`/api/users/workspaces/${workspaceId}`, {
        method: 'PUT',
        body: JSON.stringify(updates),
      }),

    // Delete workspace
    delete: (workspaceId) =>
      authenticatedFetch(`/api/users/workspaces/${workspaceId}`, {
        method: 'DELETE',
      }),
  },

  /** SSH remote server registry (P0) */
  sshServers: {
    meta: () => authenticatedFetch('/api/ssh-servers/meta'),
    listGroups: () => authenticatedFetch('/api/ssh-servers/groups'),
    createGroup: (name) =>
      authenticatedFetch('/api/ssh-servers/groups', {
        method: 'POST',
        body: JSON.stringify({ name }),
      }),
    updateGroup: (groupId, body) =>
      authenticatedFetch(`/api/ssh-servers/groups/${groupId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    deleteGroup: (groupId) =>
      authenticatedFetch(`/api/ssh-servers/groups/${groupId}`, {
        method: 'DELETE',
      }),
    list: () => authenticatedFetch('/api/ssh-servers'),
    create: (body) =>
      authenticatedFetch('/api/ssh-servers', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    update: (serverId, body) =>
      authenticatedFetch(`/api/ssh-servers/${serverId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    delete: (serverId) =>
      authenticatedFetch(`/api/ssh-servers/${serverId}`, {
        method: 'DELETE',
      }),
    setSecrets: (serverId, body) =>
      authenticatedFetch(`/api/ssh-servers/${serverId}/secrets`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    test: (serverId) =>
      authenticatedFetch(`/api/ssh-servers/${serverId}/test`, {
        method: 'POST',
      }),
    claudeProbe: (serverId) =>
      authenticatedFetch(`/api/ssh-servers/${serverId}/claude-probe`, {
        method: 'POST',
      }),
    claudeInstall: (serverId, body) =>
      authenticatedFetch(`/api/ssh-servers/${serverId}/claude-install`, {
        method: 'POST',
        body: JSON.stringify(body || {}),
      }),
    openClaudeProject: (serverId, body) =>
      authenticatedFetch(`/api/ssh-servers/${serverId}/open-claude-project`, {
        method: 'POST',
        body: JSON.stringify(body || {}),
      }),
    browseRemoteDir: (serverId, dirPath) => {
      const u =
        dirPath != null && String(dirPath).trim() !== ''
          ? `/api/ssh-servers/${serverId}/browse-dir?path=${encodeURIComponent(String(dirPath))}`
          : `/api/ssh-servers/${serverId}/browse-dir`;
      return authenticatedFetch(u);
    },
    getClaudeProviderPrefs: (serverId) =>
      authenticatedFetch(`/api/ssh-servers/${serverId}/claude-provider-prefs`),
    putClaudeProviderPrefs: (serverId, body) =>
      authenticatedFetch(`/api/ssh-servers/${serverId}/claude-provider-prefs`, {
        method: 'PUT',
        body: JSON.stringify(body || {}),
      }),
    applyClaudeProviders: (serverId, body) =>
      authenticatedFetch(`/api/ssh-servers/${serverId}/claude-providers-apply`, {
        method: 'POST',
        body: JSON.stringify(body || {}),
      }),
    claudeListModels: (serverId) => authenticatedFetch(`/api/ssh-servers/${serverId}/claude-list-models`),
    claudeSetDefaultModel: (serverId, body) =>
      authenticatedFetch(`/api/ssh-servers/${serverId}/claude-set-default-model`, {
        method: 'POST',
        body: JSON.stringify(body || {}),
      }),
  },

  /** 远程 claudecode：LLM 环境、模板、CLAUDE.md 应用 */
  remoteClaude: {
    listTemplates: (kind) => {
      const q = kind ? `?kind=${encodeURIComponent(kind)}` : '';
      return authenticatedFetch(`/api/remote-config-templates${q}`);
    },
    createTemplate: (body) =>
      authenticatedFetch('/api/remote-config-templates', { method: 'POST', body: JSON.stringify(body) }),
    updateTemplate: (id, body) =>
      authenticatedFetch(`/api/remote-config-templates/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
    deleteTemplate: (id) =>
      authenticatedFetch(`/api/remote-config-templates/${id}`, { method: 'DELETE' }),
    applyClaudeMd: (serverId, body) =>
      authenticatedFetch(`/api/ssh-servers/${serverId}/claude-md/apply`, {
        method: 'POST',
        body: JSON.stringify(body || {}),
      }),
    listClaudeProviders: () => authenticatedFetch('/api/claude-providers'),
    createClaudeProvider: (body) =>
      authenticatedFetch('/api/claude-providers', { method: 'POST', body: JSON.stringify(body || {}) }),
    updateClaudeProvider: (entryId, body) =>
      authenticatedFetch(`/api/claude-providers/${entryId}`, { method: 'PUT', body: JSON.stringify(body || {}) }),
    deleteClaudeProvider: (entryId) =>
      authenticatedFetch(`/api/claude-providers/${entryId}`, { method: 'DELETE' }),
  },

  /** Resolved `claude` / `claudecode` on server PATH (same as web terminal for Claude). */
  claudeCliShellBinary: () => authenticatedFetch('/api/cli/claude/shell-binary'),

  // Generic GET method for any endpoint
  get: (endpoint) => authenticatedFetch(`/api${endpoint}`),

  // Generic POST method for any endpoint
  post: (endpoint, body) => authenticatedFetch(`/api${endpoint}`, {
    method: 'POST',
    ...(body instanceof FormData ? { body } : { body: JSON.stringify(body) }),
  }),

  // Generic PUT method for any endpoint
  put: (endpoint, body) => authenticatedFetch(`/api${endpoint}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  }),

  // Generic DELETE method for any endpoint
  delete: (endpoint, options = {}) => authenticatedFetch(`/api${endpoint}`, {
    method: 'DELETE',
    ...options,
  }),
};
