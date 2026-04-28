/**
 * 解析远端 claudecode --output-format=stream-json 的 NDJSON stdout，提取可展示的助手正文。
 * 避免把原始 JSON 行推给 UI（与纯文本 -p 行为对齐）。
 *
 * 须覆盖多种行类型：assistant / streamlined_text / result；否则仅 result 时界面会一直空白。
 * 非 JSON 行（CLI 报错等）须转发，否则用户看不到失败原因。
 * @module server/remote/remote-claude-ssh-stream-json
 */

import { createNormalizedMessage } from '../providers/types.js';
import { chatImagesDebugLog } from '../providers/claude/chat-images-debug.js';

const MAX_FALLBACK_LINE = 12_000;

/**
 * @param {unknown} message
 * @returns {string | null}
 */
function extractAssistantFromMessage(message) {
  if (!message || typeof message !== 'object') {
    return null;
  }
  const m = /** @type {Record<string, unknown>} */ (message);
  const content = m.content;
  if (typeof content === 'string' && content.trim()) {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  let out = '';
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      continue;
    }
    const b = /** @type {Record<string, unknown>} */ (block);
    if (b.type === 'text' && typeof b.text === 'string') {
      out += b.text;
    }
  }
  return out.length > 0 ? out : null;
}

/**
 * @param {unknown} obj
 * @returns {string | null}
 */
function extractAssistantText(obj) {
  if (!obj || typeof obj !== 'object') {
    return null;
  }
  const o = /** @type {Record<string, unknown>} */ (obj);
  if (o.type !== 'assistant') {
    return null;
  }
  return extractAssistantFromMessage(o.message);
}

/**
 * @param {unknown} obj
 * @returns {string | null}
 */
function extractStreamlinedText(obj) {
  if (!obj || typeof obj !== 'object') {
    return null;
  }
  const o = /** @type {Record<string, unknown>} */ (obj);
  if (o.type !== 'streamlined_text' || typeof o.text !== 'string') {
    return null;
  }
  const t = o.text.trim();
  return t.length > 0 ? o.text : null;
}

/**
 * @param {unknown} obj
 * @returns {string | null}
 */
function extractSuccessResultText(obj) {
  if (!obj || typeof obj !== 'object') {
    return null;
  }
  const o = /** @type {Record<string, unknown>} */ (obj);
  if (o.type !== 'result' || o.subtype !== 'success' || typeof o.result !== 'string') {
    return null;
  }
  const t = o.result.trim();
  return t.length > 0 ? o.result : null;
}

/**
 * @param {{ send: (d: unknown) => void }} writer
 * @param {string} workSid
 * @param {string} tk
 * @param {(chunk: string) => string} stripPrefix
 * @returns {{
 *   push: (buf: Buffer) => void;
 *   flush: () => void;
 *   getStats: () => { hadDisplayableText: boolean, sawToolUse: boolean, sawReadToolUse: boolean };
 * }}
 */
export function createRemoteClaudeStreamJsonStdoutHandler(writer, workSid, tk, stripPrefix) {
  let lineBuf = '';
  /** 已从 assistant/streamlined 推过正文时不再用 result 重复推全文 */
  let emittedFromAssistantOrStreamlined = false;
  /** 统计：用于上层判定该回合是否可信 */
  let hadDisplayableText = false;
  let sawToolUse = false;
  let sawReadToolUse = false;

  /**
   * @param {string} trimmed
   */
  function emitJsonLine(trimmed) {
    try {
      const obj = JSON.parse(trimmed);
      const objType = /** @type {{ type?: string }} */ (obj).type;
      if (objType === 'tool_use') {
        sawToolUse = true;
        const nameRaw =
          /** @type {{ name?: unknown, tool_name?: unknown }} */ (obj).name
          ?? /** @type {{ name?: unknown, tool_name?: unknown }} */ (obj).tool_name
          ?? '';
        const name = String(nameRaw || '').trim().toLowerCase();
        if (name === 'read') {
          sawReadToolUse = true;
        }
      }
      const ast = extractAssistantText(obj);
      const st = extractStreamlinedText(obj);
      const resText = extractSuccessResultText(obj);

      if (ast) {
        emittedFromAssistantOrStreamlined = true;
        hadDisplayableText = true;
        chatImagesDebugLog('[remote stream-json] emit assistant', { workSid, chars: ast.length });
        writer.send(
          createNormalizedMessage({
            kind: 'stream_delta',
            content: ast,
            sessionId: workSid,
            provider: 'claude',
            targetKey: tk,
          }),
        );
        return;
      }
      if (st) {
        emittedFromAssistantOrStreamlined = true;
        hadDisplayableText = true;
        chatImagesDebugLog('[remote stream-json] emit streamlined_text', { workSid, chars: st.length });
        writer.send(
          createNormalizedMessage({
            kind: 'stream_delta',
            content: st,
            sessionId: workSid,
            provider: 'claude',
            targetKey: tk,
          }),
        );
        return;
      }
      if (resText && !emittedFromAssistantOrStreamlined) {
        hadDisplayableText = true;
        chatImagesDebugLog('[remote stream-json] emit result.success', { workSid, chars: resText.length });
        writer.send(
          createNormalizedMessage({
            kind: 'stream_delta',
            content: resText,
            sessionId: workSid,
            provider: 'claude',
            targetKey: tk,
          }),
        );
        return;
      }
      if (resText && emittedFromAssistantOrStreamlined) {
        chatImagesDebugLog('[remote stream-json] skip result.success (already had assistant/streamlined)', {
          workSid,
          chars: resText.length,
        });
        return;
      }
      chatImagesDebugLog('[remote stream-json] json line no displayable text', {
        workSid,
        type: /** @type {{ type?: string }} */ (obj).type,
        subtype: /** @type {{ subtype?: string }} */ (obj).subtype,
      });
    } catch {
      /* 解析失败则走下方纯文本转发 */
      const slice = trimmed.length > MAX_FALLBACK_LINE ? `${trimmed.slice(0, MAX_FALLBACK_LINE)}…` : trimmed;
      chatImagesDebugLog('[remote stream-json] non-json or parse error → plain delta', {
        workSid,
        head: slice.slice(0, 200),
      });
      writer.send(
        createNormalizedMessage({
          kind: 'stream_delta',
          content: slice + '\n',
          sessionId: workSid,
          provider: 'claude',
          targetKey: tk,
        }),
      );
    }
  }

  /**
   * @param {string} trimmed
   */
  function emitPlainLine(trimmed) {
    if (trimmed.startsWith('__CLOUDCLI_PROBE__:')) {
      chatImagesDebugLog('[remote stream-json] probe line (suppressed to UI)', { workSid, line: trimmed });
      return;
    }
    const slice = trimmed.length > MAX_FALLBACK_LINE ? `${trimmed.slice(0, MAX_FALLBACK_LINE)}…` : trimmed;
    chatImagesDebugLog('[remote stream-json] plain line → delta', { workSid, head: slice.slice(0, 200) });
    writer.send(
      createNormalizedMessage({
        kind: 'stream_delta',
        content: slice + '\n',
        sessionId: workSid,
        provider: 'claude',
        targetKey: tk,
      }),
    );
  }

  function push(buf) {
    const t = stripPrefix(buf.toString('utf8'));
    lineBuf += t;
    for (;;) {
      const nl = lineBuf.indexOf('\n');
      if (nl === -1) {
        break;
      }
      const line = lineBuf.slice(0, nl);
      lineBuf = lineBuf.slice(nl + 1);
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      if (trimmed[0] === '{') {
        emitJsonLine(trimmed);
      } else {
        emitPlainLine(trimmed);
      }
    }
  }

  function flush() {
    const rest = lineBuf.trim();
    lineBuf = '';
    if (!rest) {
      return;
    }
    chatImagesDebugLog('[remote stream-json] flush remainder', { workSid, len: rest.length, startsWithBrace: rest[0] === '{' });
    if (rest[0] === '{') {
      emitJsonLine(rest);
    } else {
      emitPlainLine(rest);
    }
  }

  function getStats() {
    return { hadDisplayableText, sawToolUse, sawReadToolUse };
  }

  return { push, flush, getStats };
}
