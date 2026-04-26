import sessionManager from '../sessionManager.js';
import { bashSingleQuote } from './remote-ssh-helpers.js';

const SAFE_SESSION = /^[a-zA-Z0-9_.\-:]+$/;

/**
 * 在远端以 bash 执行的内容（在 `cd` 到项目目录之后）。假定远端为 Unix 与登录 PATH。
 * @param {{
 *   isPlainShell: boolean;
 *   initialCommand?: string | null;
 *   provider: string;
 *   hasSession: boolean;
 *   sessionId?: string | null;
 * }} p
 * @returns {{ script: string } | { error: string }}
 */
export function buildRemoteTuiInnerBash(p) {
  const {
    isPlainShell,
    initialCommand = null,
    provider,
    hasSession,
    sessionId = null,
  } = p;

  if (isPlainShell) {
    if (!initialCommand || typeof initialCommand !== 'string' || !initialCommand.trim()) {
      return { error: 'Plain shell requires initialCommand' };
    }
    return { script: `set -euo pipefail\nexec /bin/bash -lc ${bashSingleQuote(initialCommand)}` };
  }

  if (provider === 'cursor') {
    if (hasSession && sessionId && SAFE_SESSION.test(sessionId)) {
      return {
        script: 'set -euo pipefail\n' +
          'exec /bin/bash -c ' + bashSingleQuote(`cursor-agent --resume="${sessionId}" || cursor-agent`) + '\n',
      };
    }
    return { script: 'set -euo pipefail\nexec /bin/bash -c ' + bashSingleQuote('cursor-agent') + '\n' };
  }

  if (provider === 'codex') {
    if (hasSession && sessionId && SAFE_SESSION.test(sessionId)) {
      return {
        script: 'set -euo pipefail\n' +
          'exec /bin/bash -c ' + bashSingleQuote(`codex resume "${sessionId}" || codex`) + '\n',
      };
    }
    return { script: 'set -euo pipefail\nexec /bin/bash -c ' + bashSingleQuote('codex') + '\n' };
  }

  if (provider === 'gemini') {
    const command = initialCommand || 'gemini';
    let resumeId = sessionId;
    if (hasSession && sessionId) {
      try {
        const sess = sessionManager.getSession(sessionId);
        if (sess && sess.cliSessionId && SAFE_SESSION.test(String(sess.cliSessionId))) {
          resumeId = String(sess.cliSessionId);
        }
      } catch {
        resumeId = sessionId;
      }
      if (resumeId && !SAFE_SESSION.test(String(resumeId))) {
        resumeId = null;
      }
    }

    if (hasSession && resumeId) {
      return {
        script: 'set -euo pipefail\n' +
          'exec /bin/bash -c ' + bashSingleQuote(`${command} --resume "${resumeId}"`) + '\n',
      };
    }
    return { script: 'set -euo pipefail\nexec /bin/bash -c ' + bashSingleQuote(command) + '\n' };
  }

  // --- claude 默认：与本机 pty 逻辑一致（有会话则 resume 优先，忽略 initialCommand）---
  const initial = (initialCommand && String(initialCommand).trim()) || '';

  if (hasSession && sessionId) {
    if (!SAFE_SESSION.test(sessionId)) {
      return { error: 'Invalid session ID' };
    }
    return {
      script: [
        'set -euo pipefail',
        'CCLI=$(command -v claudecode 2>/dev/null || command -v claude 2>/dev/null) || { echo "ERROR: claude or claudecode not in remote PATH" >&2; exit 1; }',
        'S=' + bashSingleQuote(sessionId),
        'exec "$CCLI" --resume "$S" || exec "$CCLI"',
        '',
      ].join('\n'),
    };
  }

  if (initial) {
    return { script: 'set -euo pipefail\nexec /bin/bash -lc ' + bashSingleQuote(initial) + '\n' };
  }

  return {
    script: [
      'set -euo pipefail',
      'CCLI=$(command -v claudecode 2>/dev/null || command -v claude 2>/dev/null) || { echo "ERROR: claude or claudecode not in remote PATH" >&2; exit 1; }',
      'exec "$CCLI"',
      '',
    ].join('\n'),
  };
}
