import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ANSI color codes for terminal output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    cyan: '\x1b[36m',
    dim: '\x1b[2m',
};

const c = {
    info: (text) => `${colors.cyan}${text}${colors.reset}`,
    bright: (text) => `${colors.bright}${text}${colors.reset}`,
    dim: (text) => `${colors.dim}${text}${colors.reset}`,
};

// Use DATABASE_PATH environment variable if set, otherwise use default location
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'auth.db');
const INIT_SQL_PATH = path.join(__dirname, 'init.sql');

// Ensure database directory exists if custom path is provided
if (process.env.DATABASE_PATH) {
  const dbDir = path.dirname(DB_PATH);
  try {
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
      console.log(`Created database directory: ${dbDir}`);
    }
  } catch (error) {
    console.error(`Failed to create database directory ${dbDir}:`, error.message);
    throw error;
  }
}

// As part of 1.19.2 we are introducing a new location for auth.db. The below handles exisitng moving legacy database from install directory to new location
const LEGACY_DB_PATH = path.join(__dirname, 'auth.db');
if (DB_PATH !== LEGACY_DB_PATH && !fs.existsSync(DB_PATH) && fs.existsSync(LEGACY_DB_PATH)) {
  try {
    fs.copyFileSync(LEGACY_DB_PATH, DB_PATH);
    console.log(`[MIGRATION] Copied database from ${LEGACY_DB_PATH} to ${DB_PATH}`);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(LEGACY_DB_PATH + suffix)) {
        fs.copyFileSync(LEGACY_DB_PATH + suffix, DB_PATH + suffix);
      }
    }
  } catch (err) {
    console.warn(`[MIGRATION] Could not copy legacy database: ${err.message}`);
  }
}

// Create database connection
const db = new Database(DB_PATH);

// app_config must exist before any other module imports (auth.js reads the JWT secret at load time).
// runMigrations() also creates this table, but it runs too late for existing installations
// where auth.js is imported before initializeDatabase() is called.
db.exec(`CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Show app installation path prominently
const appInstallPath = path.join(__dirname, '../..');
console.log('');
console.log(c.dim('═'.repeat(60)));
console.log(`${c.info('[INFO]')} App Installation: ${c.bright(appInstallPath)}`);
console.log(`${c.info('[INFO]')} Database: ${c.dim(path.relative(appInstallPath, DB_PATH))}`);
if (process.env.DATABASE_PATH) {
  console.log(`       ${c.dim('(Using custom DATABASE_PATH from environment)')}`);
}
console.log(c.dim('═'.repeat(60)));
console.log('');

const runMigrations = () => {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(users)").all();
    const columnNames = tableInfo.map(col => col.name);

    // Multi-user migration: Add role column
    if (!columnNames.includes('role')) {
      console.log('Running migration: Adding role column for multi-user support');
      db.exec("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'");
      // Make the first user an admin if they exist
      db.exec("UPDATE users SET role = 'admin' WHERE id = (SELECT MIN(id) FROM users)");
    }

    // Multi-user migration: Add projects_root column
    if (!columnNames.includes('projects_root')) {
      console.log('Running migration: Adding projects_root column');
      db.exec('ALTER TABLE users ADD COLUMN projects_root TEXT');
    }

    // Create user_workspaces table if it doesn't exist
    db.exec(`CREATE TABLE IF NOT EXISTS user_workspaces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL,
      is_default BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_user_workspaces_user ON user_workspaces(user_id)');

    // Create user_mcp_configs table if it doesn't exist
    db.exec(`CREATE TABLE IF NOT EXISTS user_mcp_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      provider TEXT NOT NULL DEFAULT 'claude',
      config_json TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, provider)
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_user_mcp_configs_user ON user_mcp_configs(user_id)');

    // Create user_settings table if it doesn't exist
    db.exec(`CREATE TABLE IF NOT EXISTS user_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      setting_key TEXT NOT NULL,
      setting_value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, setting_key)
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_user_settings_user ON user_settings(user_id)');

    // Migrate session_names to be user-specific
    // First add user_id column if it doesn't exist
    const sessionNamesInfo = db.prepare("PRAGMA table_info(session_names)").all();
    const sessionNamesColumns = sessionNamesInfo.map(col => col.name);

    if (!sessionNamesColumns.includes('user_id')) {
      console.log('Running migration: Making session_names user-specific');
      // Add user_id column
      db.exec('ALTER TABLE session_names ADD COLUMN user_id INTEGER');

      // If there's an existing user, associate all existing sessions with that user
      const firstUser = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
      if (firstUser) {
        db.run('UPDATE session_names SET user_id = ? WHERE user_id IS NULL', firstUser.id);
      }

      // Drop the old unique constraint and create new one with user_id
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_names_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          session_id TEXT NOT NULL,
          provider TEXT NOT NULL DEFAULT 'claude',
          custom_name TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          UNIQUE(user_id, session_id, provider)
        )
      `);
      db.exec('INSERT INTO session_names_new SELECT * FROM session_names WHERE user_id IS NOT NULL');
      db.exec('DROP TABLE session_names');
      db.exec('ALTER TABLE session_names_new RENAME TO session_names');
      db.exec('CREATE INDEX IF NOT EXISTS idx_session_names_user ON session_names(user_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_session_names_lookup ON session_names(session_id, provider)');
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS user_notification_preferences (
        user_id INTEGER PRIMARY KEY,
        preferences_json TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS vapid_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_key TEXT NOT NULL,
        private_key TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        endpoint TEXT NOT NULL UNIQUE,
        keys_p256dh TEXT NOT NULL,
        keys_auth TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Create app_config table if it doesn't exist (for existing installations)
    db.exec(`CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Create default workspace for existing users if none exists
    const usersWithoutWorkspace = db.prepare(`
      SELECT u.id, u.username
      FROM users u
      LEFT JOIN user_workspaces uw ON u.id = uw.user_id
      WHERE uw.id IS NULL
    `).all();

    for (const user of usersWithoutWorkspace) {
      console.log(`Creating default workspace for user: ${user.username}`);
      const defaultPath = process.env.DEFAULT_PROJECTS_ROOT || path.join(process.env.HOME || '', 'projects');
      db.prepare(`
        INSERT INTO user_workspaces (user_id, name, root_path, is_default)
        VALUES (?, 'Default', ?, 1)
      `).run(user.id, defaultPath);
    }

    console.log('Database migrations completed successfully');
  } catch (error) {
    console.error('Error running migrations:', error.message);
    throw error;
  }
};

// Initialize database with schema
const initializeDatabase = async () => {
  try {
    // Check if database already has tables
    const existingTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const hasUsersTable = existingTables.some(t => t.name === 'users');

    if (hasUsersTable) {
      console.log('Existing database detected, running migrations only...');
      runMigrations();
    } else {
      const initSQL = fs.readFileSync(INIT_SQL_PATH, 'utf8');
      db.exec(initSQL);
      console.log('Database initialized successfully');
      runMigrations();
    }
  } catch (error) {
    console.error('Error initializing database:', error.message);
    throw error;
  }
};

// User database operations
const userDb = {
  // Check if any users exist
  hasUsers: () => {
    try {
      const row = db.prepare('SELECT COUNT(*) as count FROM users').get();
      return row.count > 0;
    } catch (err) {
      throw err;
    }
  },

  // Get total user count
  getUserCount: () => {
    try {
      const row = db.prepare('SELECT COUNT(*) as count FROM users WHERE is_active = 1').get();
      return row.count;
    } catch (err) {
      throw err;
    }
  },

  // Create a new user (multi-user support)
  createUser: (username, passwordHash, role = 'user', projectsRoot = null) => {
    try {
      // First user becomes admin by default
      const hasUsers = userDb.hasUsers();
      const finalRole = !hasUsers ? 'admin' : role;

      const stmt = db.prepare(`
        INSERT INTO users (username, password_hash, role, projects_root)
        VALUES (?, ?, ?, ?)
      `);
      const result = stmt.run(username, passwordHash, finalRole, projectsRoot);

      // Create default workspace for new user
      const userId = result.lastInsertRowid;
      const defaultPath = projectsRoot || process.env.DEFAULT_PROJECTS_ROOT || path.join(process.env.HOME || '', 'projects');
      db.prepare(`
        INSERT INTO user_workspaces (user_id, name, root_path, is_default)
        VALUES (?, 'Default', ?, 1)
      `).run(userId, defaultPath);

      return { id: userId, username, role: finalRole };
    } catch (err) {
      throw err;
    }
  },

  // Get user by username
  getUserByUsername: (username) => {
    try {
      const row = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username);
      return row;
    } catch (err) {
      throw err;
    }
  },

  // Update last login time (non-fatal — logged but not thrown)
  updateLastLogin: (userId) => {
    try {
      db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
    } catch (err) {
      console.warn('Failed to update last login:', err.message);
    }
  },

  // Get user by ID
  getUserById: (userId) => {
    try {
      const row = db.prepare('SELECT id, username, role, created_at, last_login, git_name, git_email, has_completed_onboarding, projects_root FROM users WHERE id = ? AND is_active = 1').get(userId);
      return row;
    } catch (err) {
      throw err;
    }
  },

  // Get all users (for admin) - including soft-deleted
  getAllUsers: () => {
    try {
      const rows = db.prepare(`
        SELECT id, username, role, created_at, last_login, is_active, has_completed_onboarding
        FROM users
        ORDER BY is_active DESC, created_at DESC
      `).all();
      return rows;
    } catch (err) {
      throw err;
    }
  },

  // Update user
  updateUser: (userId, updates) => {
    try {
      const fields = [];
      const values = [];

      if (updates.username !== undefined) {
        fields.push('username = ?');
        values.push(updates.username);
      }
      if (updates.role !== undefined) {
        fields.push('role = ?');
        values.push(updates.role);
      }
      if (updates.is_active !== undefined) {
        fields.push('is_active = ?');
        values.push(updates.is_active ? 1 : 0);
      }
      if (updates.git_name !== undefined) {
        fields.push('git_name = ?');
        values.push(updates.git_name);
      }
      if (updates.git_email !== undefined) {
        fields.push('git_email = ?');
        values.push(updates.git_email);
      }
      if (updates.password_hash !== undefined) {
        fields.push('password_hash = ?');
        values.push(updates.password_hash);
      }
      if (updates.projects_root !== undefined) {
        fields.push('projects_root = ?');
        values.push(updates.projects_root);
      }

      if (fields.length === 0) {
        return false;
      }

      values.push(userId);
      const stmt = db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`);
      const result = stmt.run(...values);
      return result.changes > 0;
    } catch (err) {
      throw err;
    }
  },

  // Delete user (soft delete by setting is_active = 0)
  deleteUser: (userId) => {
    try {
      const stmt = db.prepare('UPDATE users SET is_active = 0 WHERE id = ?');
      const result = stmt.run(userId);
      return result.changes > 0;
    } catch (err) {
      throw err;
    }
  },

  // Permanently delete user and all associated data
  permanentlyDeleteUser: (userId) => {
    try {
      const stmt = db.prepare('DELETE FROM users WHERE id = ?');
      const result = stmt.run(userId);
      return result.changes > 0;
    } catch (err) {
      throw err;
    }
  },

  getFirstUser: () => {
    try {
      const row = db.prepare('SELECT id, username, created_at, last_login FROM users WHERE is_active = 1 LIMIT 1').get();
      return row;
    } catch (err) {
      throw err;
    }
  },

  updateGitConfig: (userId, gitName, gitEmail) => {
    try {
      const stmt = db.prepare('UPDATE users SET git_name = ?, git_email = ? WHERE id = ?');
      stmt.run(gitName, gitEmail, userId);
    } catch (err) {
      throw err;
    }
  },

  getGitConfig: (userId) => {
    try {
      const row = db.prepare('SELECT git_name, git_email FROM users WHERE id = ?').get(userId);
      return row;
    } catch (err) {
      throw err;
    }
  },

  completeOnboarding: (userId) => {
    try {
      const stmt = db.prepare('UPDATE users SET has_completed_onboarding = 1 WHERE id = ?');
      stmt.run(userId);
    } catch (err) {
      throw err;
    }
  },

  hasCompletedOnboarding: (userId) => {
    try {
      const row = db.prepare('SELECT has_completed_onboarding FROM users WHERE id = ?').get(userId);
      return row?.has_completed_onboarding === 1;
    } catch (err) {
      throw err;
    }
  },

  // Check if user is admin
  isAdmin: (userId) => {
    try {
      const row = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
      return row?.role === 'admin';
    } catch (err) {
      throw err;
    }
  }
};

// API Keys database operations
const apiKeysDb = {
  // Generate a new API key
  generateApiKey: () => {
    return 'ck_' + crypto.randomBytes(32).toString('hex');
  },

  // Create a new API key
  createApiKey: (userId, keyName) => {
    try {
      const apiKey = apiKeysDb.generateApiKey();
      const stmt = db.prepare('INSERT INTO api_keys (user_id, key_name, api_key) VALUES (?, ?, ?)');
      const result = stmt.run(userId, keyName, apiKey);
      return { id: result.lastInsertRowid, keyName, apiKey };
    } catch (err) {
      throw err;
    }
  },

  // Get all API keys for a user
  getApiKeys: (userId) => {
    try {
      const rows = db.prepare('SELECT id, key_name, api_key, created_at, last_used, is_active FROM api_keys WHERE user_id = ? ORDER BY created_at DESC').all(userId);
      return rows;
    } catch (err) {
      throw err;
    }
  },

  // Validate API key and get user
  validateApiKey: (apiKey) => {
    try {
      const row = db.prepare(`
        SELECT u.id, u.username, ak.id as api_key_id
        FROM api_keys ak
        JOIN users u ON ak.user_id = u.id
        WHERE ak.api_key = ? AND ak.is_active = 1 AND u.is_active = 1
      `).get(apiKey);

      if (row) {
        // Update last_used timestamp
        db.prepare('UPDATE api_keys SET last_used = CURRENT_TIMESTAMP WHERE id = ?').run(row.api_key_id);
      }

      return row;
    } catch (err) {
      throw err;
    }
  },

  // Delete an API key
  deleteApiKey: (userId, apiKeyId) => {
    try {
      const stmt = db.prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?');
      const result = stmt.run(apiKeyId, userId);
      return result.changes > 0;
    } catch (err) {
      throw err;
    }
  },

  // Toggle API key active status
  toggleApiKey: (userId, apiKeyId, isActive) => {
    try {
      const stmt = db.prepare('UPDATE api_keys SET is_active = ? WHERE id = ? AND user_id = ?');
      const result = stmt.run(isActive ? 1 : 0, apiKeyId, userId);
      return result.changes > 0;
    } catch (err) {
      throw err;
    }
  }
};

// User credentials database operations (for GitHub tokens, GitLab tokens, etc.)
const credentialsDb = {
  // Create a new credential
  createCredential: (userId, credentialName, credentialType, credentialValue, description = null) => {
    try {
      const stmt = db.prepare('INSERT INTO user_credentials (user_id, credential_name, credential_type, credential_value, description) VALUES (?, ?, ?, ?, ?)');
      const result = stmt.run(userId, credentialName, credentialType, credentialValue, description);
      return { id: result.lastInsertRowid, credentialName, credentialType };
    } catch (err) {
      throw err;
    }
  },

  // Get all credentials for a user, optionally filtered by type
  getCredentials: (userId, credentialType = null) => {
    try {
      let query = 'SELECT id, credential_name, credential_type, description, created_at, is_active FROM user_credentials WHERE user_id = ?';
      const params = [userId];

      if (credentialType) {
        query += ' AND credential_type = ?';
        params.push(credentialType);
      }

      query += ' ORDER BY created_at DESC';

      const rows = db.prepare(query).all(...params);
      return rows;
    } catch (err) {
      throw err;
    }
  },

  // Get active credential value for a user by type (returns most recent active)
  getActiveCredential: (userId, credentialType) => {
    try {
      const row = db.prepare('SELECT credential_value FROM user_credentials WHERE user_id = ? AND credential_type = ? AND is_active = 1 ORDER BY created_at DESC LIMIT 1').get(userId, credentialType);
      return row?.credential_value || null;
    } catch (err) {
      throw err;
    }
  },

  // Delete a credential
  deleteCredential: (userId, credentialId) => {
    try {
      const stmt = db.prepare('DELETE FROM user_credentials WHERE id = ? AND user_id = ?');
      const result = stmt.run(credentialId, userId);
      return result.changes > 0;
    } catch (err) {
      throw err;
    }
  },

  // Toggle credential active status
  toggleCredential: (userId, credentialId, isActive) => {
    try {
      const stmt = db.prepare('UPDATE user_credentials SET is_active = ? WHERE id = ? AND user_id = ?');
      const result = stmt.run(isActive ? 1 : 0, credentialId, userId);
      return result.changes > 0;
    } catch (err) {
      throw err;
    }
  }
};

const DEFAULT_NOTIFICATION_PREFERENCES = {
  channels: {
    inApp: false,
    webPush: false
  },
  events: {
    actionRequired: true,
    stop: true,
    error: true
  }
};

const normalizeNotificationPreferences = (value) => {
  const source = value && typeof value === 'object' ? value : {};

  return {
    channels: {
      inApp: source.channels?.inApp === true,
      webPush: source.channels?.webPush === true
    },
    events: {
      actionRequired: source.events?.actionRequired !== false,
      stop: source.events?.stop !== false,
      error: source.events?.error !== false
    }
  };
};

const notificationPreferencesDb = {
  getPreferences: (userId) => {
    try {
      const row = db.prepare('SELECT preferences_json FROM user_notification_preferences WHERE user_id = ?').get(userId);
      if (!row) {
        const defaults = normalizeNotificationPreferences(DEFAULT_NOTIFICATION_PREFERENCES);
        db.prepare(
          'INSERT INTO user_notification_preferences (user_id, preferences_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)'
        ).run(userId, JSON.stringify(defaults));
        return defaults;
      }

      let parsed;
      try {
        parsed = JSON.parse(row.preferences_json);
      } catch {
        parsed = DEFAULT_NOTIFICATION_PREFERENCES;
      }
      return normalizeNotificationPreferences(parsed);
    } catch (err) {
      throw err;
    }
  },

  updatePreferences: (userId, preferences) => {
    try {
      const normalized = normalizeNotificationPreferences(preferences);
      db.prepare(
        `INSERT INTO user_notification_preferences (user_id, preferences_json, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(user_id) DO UPDATE SET
           preferences_json = excluded.preferences_json,
           updated_at = CURRENT_TIMESTAMP`
      ).run(userId, JSON.stringify(normalized));
      return normalized;
    } catch (err) {
      throw err;
    }
  }
};

const pushSubscriptionsDb = {
  saveSubscription: (userId, endpoint, keysP256dh, keysAuth) => {
    try {
      db.prepare(
        `INSERT INTO push_subscriptions (user_id, endpoint, keys_p256dh, keys_auth)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           user_id = excluded.user_id,
           keys_p256dh = excluded.keys_p256dh,
           keys_auth = excluded.keys_auth`
      ).run(userId, endpoint, keysP256dh, keysAuth);
    } catch (err) {
      throw err;
    }
  },

  getSubscriptions: (userId) => {
    try {
      return db.prepare('SELECT endpoint, keys_p256dh, keys_auth FROM push_subscriptions WHERE user_id = ?').all(userId);
    } catch (err) {
      throw err;
    }
  },

  removeSubscription: (endpoint) => {
    try {
      db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
    } catch (err) {
      throw err;
    }
  },

  removeAllForUser: (userId) => {
    try {
      db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId);
    } catch (err) {
      throw err;
    }
  }
};

// Session custom names database operations (user-specific)
const sessionNamesDb = {
  // Set (insert or update) a custom session name (user-specific)
  setName: (userId, sessionId, provider, customName) => {
    db.prepare(`
      INSERT INTO session_names (user_id, session_id, provider, custom_name)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, session_id, provider)
      DO UPDATE SET custom_name = excluded.custom_name, updated_at = CURRENT_TIMESTAMP
    `).run(userId, sessionId, provider, customName);
  },

  // Get a single custom session name (user-specific)
  getName: (userId, sessionId, provider) => {
    const row = db.prepare(
      'SELECT custom_name FROM session_names WHERE user_id = ? AND session_id = ? AND provider = ?'
    ).get(userId, sessionId, provider);
    return row?.custom_name || null;
  },

  // Batch lookup — returns Map<sessionId, customName> (user-specific)
  getNames: (userId, sessionIds, provider) => {
    if (!sessionIds.length) return new Map();
    const placeholders = sessionIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT session_id, custom_name FROM session_names
       WHERE user_id = ? AND session_id IN (${placeholders}) AND provider = ?`
    ).all(userId, ...sessionIds, provider);
    return new Map(rows.map(r => [r.session_id, r.custom_name]));
  },

  // Delete a custom session name (user-specific)
  deleteName: (userId, sessionId, provider) => {
    return db.prepare(
      'DELETE FROM session_names WHERE user_id = ? AND session_id = ? AND provider = ?'
    ).run(userId, sessionId, provider).changes > 0;
  },

  // Get all session names for a user
  getAllNames: (userId, provider) => {
    const rows = db.prepare(
      'SELECT session_id, custom_name FROM session_names WHERE user_id = ? AND provider = ?'
    ).all(userId, provider);
    return new Map(rows.map(r => [r.session_id, r.custom_name]));
  }
};

// Apply custom session names from the database (overrides CLI-generated summaries, user-specific)
function applyCustomSessionNames(userId, sessions, provider) {
  // Skip if userId is missing or sessions is not a valid array
  if (!userId || !Array.isArray(sessions) || !sessions.length) return;
  try {
    const ids = sessions.map(s => s.id);
    const customNames = sessionNamesDb.getNames(userId, ids, provider);
    for (const session of sessions) {
      const custom = customNames.get(session.id);
      if (custom) session.summary = custom;
    }
  } catch (error) {
    console.warn(`[DB] Failed to apply custom session names for ${provider}:`, error.message);
  }
}

// App config database operations
const appConfigDb = {
  get: (key) => {
    try {
      const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(key);
      return row?.value || null;
    } catch (err) {
      return null;
    }
  },

  set: (key, value) => {
    db.prepare(
      'INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, value);
  },

  getOrCreateJwtSecret: () => {
    let secret = appConfigDb.get('jwt_secret');
    if (!secret) {
      secret = crypto.randomBytes(64).toString('hex');
      appConfigDb.set('jwt_secret', secret);
    }
    return secret;
  }
};

// Backward compatibility - keep old names pointing to new system
const githubTokensDb = {
  createGithubToken: (userId, tokenName, githubToken, description = null) => {
    return credentialsDb.createCredential(userId, tokenName, 'github_token', githubToken, description);
  },
  getGithubTokens: (userId) => {
    return credentialsDb.getCredentials(userId, 'github_token');
  },
  getActiveGithubToken: (userId) => {
    return credentialsDb.getActiveCredential(userId, 'github_token');
  },
  deleteGithubToken: (userId, tokenId) => {
    return credentialsDb.deleteCredential(userId, tokenId);
  },
  toggleGithubToken: (userId, tokenId, isActive) => {
    return credentialsDb.toggleCredential(userId, tokenId, isActive);
  }
};

// User workspaces database operations
const userWorkspacesDb = {
  // Get all workspaces for a user
  getWorkspaces: (userId) => {
    try {
      return db.prepare('SELECT * FROM user_workspaces WHERE user_id = ? ORDER BY is_default DESC, name ASC').all(userId);
    } catch (err) {
      throw err;
    }
  },

  // Get default workspace for a user
  getDefaultWorkspace: (userId) => {
    try {
      return db.prepare('SELECT * FROM user_workspaces WHERE user_id = ? AND is_default = 1').get(userId);
    } catch (err) {
      throw err;
    }
  },

  // Get workspace by ID (with user ownership check)
  getWorkspaceById: (userId, workspaceId) => {
    try {
      return db.prepare('SELECT * FROM user_workspaces WHERE id = ? AND user_id = ?').get(workspaceId, userId);
    } catch (err) {
      throw err;
    }
  },

  // Create workspace
  createWorkspace: (userId, name, rootPath, isDefault = false) => {
    try {
      // If this is set as default, unset other defaults
      if (isDefault) {
        db.prepare('UPDATE user_workspaces SET is_default = 0 WHERE user_id = ?').run(userId);
      }

      const stmt = db.prepare(`
        INSERT INTO user_workspaces (user_id, name, root_path, is_default)
        VALUES (?, ?, ?, ?)
      `);
      const result = stmt.run(userId, name, rootPath, isDefault ? 1 : 0);
      return { id: result.lastInsertRowid, name, rootPath, isDefault };
    } catch (err) {
      throw err;
    }
  },

  // Update workspace
  updateWorkspace: (userId, workspaceId, updates) => {
    try {
      const fields = [];
      const values = [];

      if (updates.name !== undefined) {
        fields.push('name = ?');
        values.push(updates.name);
      }
      if (updates.root_path !== undefined) {
        fields.push('root_path = ?');
        values.push(updates.root_path);
      }
      if (updates.is_default !== undefined) {
        fields.push('is_default = ?');
        values.push(updates.is_default ? 1 : 0);
        // Unset other defaults
        db.prepare('UPDATE user_workspaces SET is_default = 0 WHERE user_id = ? AND id != ?').run(userId, workspaceId);
      }

      if (fields.length === 0) {
        return false;
      }

      values.push(workspaceId, userId);
      const stmt = db.prepare(`UPDATE user_workspaces SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`);
      const result = stmt.run(...values);
      return result.changes > 0;
    } catch (err) {
      throw err;
    }
  },

  // Delete workspace
  deleteWorkspace: (userId, workspaceId) => {
    try {
      const stmt = db.prepare('DELETE FROM user_workspaces WHERE id = ? AND user_id = ?');
      const result = stmt.run(workspaceId, userId);
      return result.changes > 0;
    } catch (err) {
      throw err;
    }
  }
};

// User MCP configurations database operations
const userMcpConfigsDb = {
  // Get MCP config for a user and provider
  getConfig: (userId, provider = 'claude') => {
    try {
      const row = db.prepare('SELECT config_json FROM user_mcp_configs WHERE user_id = ? AND provider = ?').get(userId, provider);
      if (!row) {
        return null;
      }
      try {
        return JSON.parse(row.config_json);
      } catch {
        return null;
      }
    } catch (err) {
      throw err;
    }
  },

  // Save MCP config
  saveConfig: (userId, provider, config) => {
    try {
      const configJson = JSON.stringify(config);
      db.prepare(`
        INSERT INTO user_mcp_configs (user_id, provider, config_json, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id, provider) DO UPDATE SET
          config_json = excluded.config_json,
          updated_at = CURRENT_TIMESTAMP
      `).run(userId, provider, configJson);
      return true;
    } catch (err) {
      throw err;
    }
  },

  // Delete MCP config
  deleteConfig: (userId, provider) => {
    try {
      const stmt = db.prepare('DELETE FROM user_mcp_configs WHERE user_id = ? AND provider = ?');
      const result = stmt.run(userId, provider);
      return result.changes > 0;
    } catch (err) {
      throw err;
    }
  }
};

// User settings database operations
const userSettingsDb = {
  // Get a single setting
  getSetting: (userId, settingKey) => {
    try {
      const row = db.prepare('SELECT setting_value FROM user_settings WHERE user_id = ? AND setting_key = ?').get(userId, settingKey);
      if (!row) {
        return null;
      }
      try {
        return JSON.parse(row.setting_value);
      } catch {
        return row.setting_value;
      }
    } catch (err) {
      throw err;
    }
  },

  // Get all settings for a user
  getAllSettings: (userId) => {
    try {
      const rows = db.prepare('SELECT setting_key, setting_value FROM user_settings WHERE user_id = ?').all(userId);
      const settings = {};
      for (const row of rows) {
        try {
          settings[row.setting_key] = JSON.parse(row.setting_value);
        } catch {
          settings[row.setting_key] = row.setting_value;
        }
      }
      return settings;
    } catch (err) {
      throw err;
    }
  },

  // Set a setting
  setSetting: (userId, settingKey, settingValue) => {
    try {
      const valueJson = typeof settingValue === 'object' ? JSON.stringify(settingValue) : String(settingValue);
      db.prepare(`
        INSERT INTO user_settings (user_id, setting_key, setting_value, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id, setting_key) DO UPDATE SET
          setting_value = excluded.setting_value,
          updated_at = CURRENT_TIMESTAMP
      `).run(userId, settingKey, valueJson);
      return true;
    } catch (err) {
      throw err;
    }
  },

  // Delete a setting
  deleteSetting: (userId, settingKey) => {
    try {
      const stmt = db.prepare('DELETE FROM user_settings WHERE user_id = ? AND setting_key = ?');
      const result = stmt.run(userId, settingKey);
      return result.changes > 0;
    } catch (err) {
      throw err;
    }
  }
};

export {
  db,
  initializeDatabase,
  userDb,
  apiKeysDb,
  credentialsDb,
  notificationPreferencesDb,
  pushSubscriptionsDb,
  sessionNamesDb,
  applyCustomSessionNames,
  appConfigDb,
  githubTokensDb, // Backward compatibility
  userWorkspacesDb,
  userMcpConfigsDb,
  userSettingsDb
};
