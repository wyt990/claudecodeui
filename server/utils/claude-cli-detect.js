import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { isClaudeOpenAICompatMode } from './claude-openai-env.js';

/**
 * Whether `command` is on PATH (same check as web terminal shell init).
 * Uses bash -lc so login PATH matches interactive shells.
 */
export function commandExists(command) {
  try {
    const result = spawnSync('bash', ['-lc', `which ${command}`], {
      stdio: 'pipe',
      timeout: 5000,
      env: process.env
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function whichAbsolute(command) {
  try {
    const result = spawnSync('bash', ['-lc', `command -v ${command} 2>/dev/null`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      env: process.env
    });
    const line = result.stdout?.trim().split('\n')[0]?.trim();
    if (line && fs.existsSync(line)) {
      return line;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Prefer `preferred` if present, else `fallback` (same as PTY shell for Claude). */
export function getCliCommand(preferred, fallback) {
  if (commandExists(preferred)) {
    return preferred;
  }
  if (commandExists(fallback)) {
    return fallback;
  }
  return null;
}

function cliPriorityOrder() {
  const p = (process.env.CLOUDCLI_CLAUDE_CLI_PRIORITY || '').trim().toLowerCase();
  if (p === 'claudecode' || p === 'claude-code-local') {
    return ['claudecode', 'claude'];
  }
  if (p === 'claude') {
    return ['claude', 'claudecode'];
  }
  if (isClaudeOpenAICompatMode()) {
    return ['claudecode', 'claude'];
  }
  return ['claude', 'claudecode'];
}

export function getCliCommandForPriority(order) {
  for (const cmd of order) {
    if (commandExists(cmd)) {
      return cmd;
    }
  }
  return null;
}

/** Shell PTY + badges: same resolution order as Claude Agent SDK executable when possible. */
export function getShellClaudeCliCommand() {
  return getCliCommandForPriority(cliPriorityOrder());
}

/**
 * Resolved binary for Claude-style terminal sessions (`claude` vs `claudecode`).
 * Chat uses Claude Agent SDK; this is for UI parity with shell + operator clarity.
 */
export function getClaudeShellBinaryResolution() {
  const order = cliPriorityOrder();
  const command = getCliCommandForPriority(order);
  return {
    command,
    claudeAvailable: commandExists('claude'),
    claudecodeAvailable: commandExists('claudecode'),
    resolutionOrder: order,
    chatUses: 'claude-agent-sdk',
    openAICompat: isClaudeOpenAICompatMode()
  };
}

/**
 * Absolute path to Claude Code / claudecode entry for @anthropic-ai/claude-agent-sdk
 * (`options.pathToClaudeCodeExecutable`). Non-.js/.ts paths are spawned as the command (bash wrapper OK).
 */
export function getClaudeCodeExecutablePathForSdk() {
  const explicit = process.env.CLAUDE_CODE_EXECUTABLE?.trim();
  if (explicit && fs.existsSync(explicit)) {
    return explicit;
  }

  const root = process.env.CLAUDE_CODE_ROOT?.trim();
  if (root) {
    const candidate = path.join(root, 'bin', 'claudecode');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const defaultFork = '/apps/claude-code/bin/claudecode';
  if (fs.existsSync(defaultFork)) {
    return defaultFork;
  }

  const order = cliPriorityOrder();
  for (const cmd of order) {
    const abs = whichAbsolute(cmd);
    if (abs) {
      return abs;
    }
  }
  return null;
}
