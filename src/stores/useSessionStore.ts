/**
 * Session-keyed message store.
 *
 * Holds per-session state in a Map keyed by **targetKey + sessionId**（`getSessionStoreKey`）.
 * Session switch = change activeSessionId pointer. 切换 `targetKey` 时由上层 `clearEntireStore()` 全清，避免串环境。
 * WebSocket handler = store.appendRealtime(msg.sessionId, msg). One line.
 * No localStorage for messages. Backend JSONL is the source of truth.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { stripClaudeImagePathsNote } from '../components/chat/utils/chatImagePaths';
import { chatImagesDebugLog, isChatImagesDebugEnabled } from '../lib/chatImagesDebug';
import type { SessionProvider } from '../types/app';
import { authenticatedFetch } from '../utils/api';
import { getSessionStoreKey } from '../utils/sessionStoreKey.js';

// ─── NormalizedMessage (mirrors server/adapters/types.js) ────────────────────

export type MessageKind =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'thinking'
  | 'stream_delta'
  | 'stream_end'
  | 'error'
  | 'complete'
  | 'status'
  | 'permission_request'
  | 'permission_cancelled'
  | 'session_created'
  | 'interactive_prompt'
  | 'task_notification';

export interface NormalizedMessage {
  id: string;
  sessionId: string;
  timestamp: string;
  provider: SessionProvider;
  kind: MessageKind;

  // kind-specific fields (flat for simplicity)
  role?: 'user' | 'assistant';
  content?: string;
  images?: string[];
  toolName?: string;
  toolInput?: unknown;
  toolId?: string;
  toolResult?: { content: string; isError: boolean; toolUseResult?: unknown } | null;
  isError?: boolean;
  text?: string;
  tokens?: number;
  canInterrupt?: boolean;
  tokenBudget?: unknown;
  requestId?: string;
  input?: unknown;
  context?: unknown;
  newSessionId?: string;
  status?: string;
  summary?: string;
  exitCode?: number;
  actualSessionId?: string;
  parentToolUseId?: string;
  subagentTools?: unknown[];
  isFinal?: boolean;
  // Cursor-specific ordering
  sequence?: number;
  rowid?: number;
  /** 与 `x-cloudcli-target` 一致，缺省在服务端归约为 `local` */
  targetKey?: string;
}

// ─── Per-session slot ────────────────────────────────────────────────────────

export type SessionStatus = 'idle' | 'loading' | 'streaming' | 'error';

export interface SessionSlot {
  serverMessages: NormalizedMessage[];
  realtimeMessages: NormalizedMessage[];
  merged: NormalizedMessage[];
  /** @internal Cache-invalidation refs for computeMerged */
  _lastServerRef: NormalizedMessage[];
  _lastRealtimeRef: NormalizedMessage[];
  status: SessionStatus;
  fetchedAt: number;
  total: number;
  hasMore: boolean;
  offset: number;
  tokenUsage: unknown;
}

const EMPTY: NormalizedMessage[] = [];

function createEmptySlot(): SessionSlot {
  return {
    serverMessages: EMPTY,
    realtimeMessages: EMPTY,
    merged: EMPTY,
    _lastServerRef: EMPTY,
    _lastRealtimeRef: EMPTY,
    status: 'idle',
    fetchedAt: 0,
    total: 0,
    hasMore: false,
    offset: 0,
    tokenUsage: null,
  };
}

/**
 * Compute merged messages: server + realtime, deduped by id.
 * Server messages take priority (they're the persisted source of truth).
 * Realtime messages that aren't yet in server stay (in-flight streaming).
 */
function computeMerged(server: NormalizedMessage[], realtime: NormalizedMessage[]): NormalizedMessage[] {
  if (realtime.length === 0) return server;
  if (server.length === 0) return realtime;
  const serverIds = new Set(server.map(m => m.id));
  const extra = realtime.filter(m => !serverIds.has(m.id));
  const merged = extra.length === 0 ? server : [...server, ...extra];
  return collapseDuplicateUserImageTurnsForDisplay(merged);
}

function toEpochMs(ts: string | undefined): number {
  if (!ts) return NaN;
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : NaN;
}

function normalizeUserImageComparableText(raw: string): string {
  // stripClaudeImagePathsNote already handles both safety guard and paths note
  // 使用统一函数剥离安全护栏和路径说明，确保 realtime(原始输入) 与 server(注入后文本) 匹配
  return stripClaudeImagePathsNote(String(raw || ''));
}

function userImageDisplayKey(m: NormalizedMessage): string | null {
  if (
    m.kind !== 'text' ||
    m.role !== 'user' ||
    !Array.isArray(m.images) ||
    m.images.length === 0
  ) {
    return null;
  }
  const text = normalizeUserImageComparableText(String(m.content || ''));
  const first = String(m.images[0] || '');
  // 仅用于 UI 兜底去重，不做持久化判断。
  return `${text}@@${first.slice(0, 128)}`;
}

/**
 * 兜底：折叠由自动重试导致的“连续重复用户带图消息”。
 * 仅在以下条件同时满足时才去重：
 * - 连续两条都是 user text + images
 * - 去路径说明后的正文一致
 * - 第一张图片签名一致
 * - 时间戳间隔 <= 8 秒
 */
function collapseDuplicateUserImageTurnsForDisplay(messages: NormalizedMessage[]): NormalizedMessage[] {
  if (messages.length <= 1) return messages;
  const out: NormalizedMessage[] = [];
  for (const cur of messages) {
    const prev = out.length > 0 ? out[out.length - 1] : null;
    if (!prev) {
      out.push(cur);
      continue;
    }
    const curKey = userImageDisplayKey(cur);
    const prevKey = userImageDisplayKey(prev);
    if (!curKey || !prevKey || curKey !== prevKey) {
      out.push(cur);
      continue;
    }
    const curTs = toEpochMs(cur.timestamp);
    const prevTs = toEpochMs(prev.timestamp);
    if (!Number.isFinite(curTs) || !Number.isFinite(prevTs) || Math.abs(curTs - prevTs) > 8_000) {
      out.push(cur);
      continue;
    }
    // 命中重复：丢弃后者，仅展示一条。
  }
  return out;
}

/**
 * Recompute slot.merged only when the input arrays have actually changed
 * (by reference). Returns true if merged was recomputed.
 */
function recomputeMergedIfNeeded(slot: SessionSlot): boolean {
  if (slot.serverMessages === slot._lastServerRef && slot.realtimeMessages === slot._lastRealtimeRef) {
    return false;
  }
  slot._lastServerRef = slot.serverMessages;
  slot._lastRealtimeRef = slot.realtimeMessages;
  slot.merged = computeMerged(slot.serverMessages, slot.realtimeMessages);
  return true;
}

/**
 * JSONL/API 用户气泡通常无 `images`（仅存路径说明），乐观 realtime 里才有 data URL。
 * 在丢弃 realtime 前把图片按「去路径说明后的正文」对齐写回 server 副本，避免刷新后缩略图消失。
 */
function countUserWithImages(arr: NormalizedMessage[]): number {
  return arr.filter((m) => m.kind === 'text' && m.role === 'user' && Array.isArray(m.images) && m.images.length > 0).length;
}

function mergeUserImagesFromRealtime(server: NormalizedMessage[], realtime: NormalizedMessage[]): NormalizedMessage[] {
  const dbg = isChatImagesDebugEnabled();
  const rtQueue = realtime.filter(
    (m) =>
      m.kind === 'text' &&
      m.role === 'user' &&
      Array.isArray(m.images) &&
      m.images.length > 0,
  );
  if (rtQueue.length === 0) {
    if (dbg) {
      chatImagesDebugLog('merge: no realtime user rows with images', { serverLen: server.length });
    }
    return server;
  }

  let qi = 0;
  let patched = false;
  const out: NormalizedMessage[] = [];
  for (const sm of server) {
    if (
      sm.kind !== 'text' ||
      sm.role !== 'user' ||
      (Array.isArray(sm.images) && sm.images.length > 0)
    ) {
      out.push(sm);
      continue;
    }
    const sStrip = normalizeUserImageComparableText(String(sm.content || ''));
    let assigned = false;
    for (let j = qi; j < rtQueue.length; j++) {
      const rt = rtQueue[j];
      const rStrip = normalizeUserImageComparableText(String(rt.content || ''));
      if (rStrip !== sStrip) continue;
      qi = j + 1;
      patched = true;
      if (dbg) {
        chatImagesDebugLog('merge: attached images to server user row', {
          id: sm.id,
          sStripPreview: sStrip.slice(0, 80),
          imageCount: rt.images?.length ?? 0,
        });
      }
      out.push({ ...sm, images: [...(rt.images as string[])] });
      assigned = true;
      break;
    }
    if (!assigned) {
      if (dbg && sStrip.length > 0 && !Array.isArray(sm.images)) {
        const hasPathNote = String(sm.content || '').includes('[Images provided at the following paths:');
        if (hasPathNote) {
          chatImagesDebugLog('merge: server user has path note but no strip match to rt', {
            id: sm.id,
            sStripPreview: sStrip.slice(0, 80),
            rtQueueLen: rtQueue.length,
            qi,
          });
        }
      }
      out.push(sm);
    }
  }
  if (dbg) {
    chatImagesDebugLog('merge: result', { patched, outUserWithImages: countUserWithImages(patched ? out : server) });
  }
  return patched ? out : server;
}

/**
 * Refresh/fetch 后服务端通常已追平文本，但远端场景下用户图片常不在 API 行内（仅路径说明）。
 * 仅保留「用户 text + images」的 realtime 行，避免缩略图被清空。
 */
function retainRealtimeImageRows(realtime: NormalizedMessage[]): NormalizedMessage[] {
  return realtime.filter(
    (m) =>
      m.kind === 'text' &&
      m.role === 'user' &&
      Array.isArray(m.images) &&
      m.images.length > 0,
  );
}

/**
 * 当服务端已返回同内容且含 images 的用户行时，剔除对应 realtime 图片行，避免重复显示。
 */
function dropRealtimeImageRowsAlreadyOnServer(
  server: NormalizedMessage[],
  realtime: NormalizedMessage[],
): NormalizedMessage[] {
  if (realtime.length === 0) return realtime;
  const serverUserWithImages = server
    .filter(
      (m) =>
        m.kind === 'text' &&
        m.role === 'user' &&
        Array.isArray(m.images) &&
        m.images.length > 0,
    )
    .map((m) => normalizeUserImageComparableText(String(m.content || '')))
    .filter(Boolean);
  if (serverUserWithImages.length === 0) {
    return realtime;
  }
  return realtime.filter((m) => {
    if (
      m.kind !== 'text' ||
      m.role !== 'user' ||
      !Array.isArray(m.images) ||
      m.images.length === 0
    ) {
      return true;
    }
    const rtStrip = normalizeUserImageComparableText(String(m.content || ''));
    return !serverUserWithImages.includes(rtStrip);
  });
}

// ─── Stale threshold ─────────────────────────────────────────────────────────

const STALE_THRESHOLD_MS = 30_000;

const MAX_REALTIME_MESSAGES = 500;

// ─── In-flight request tracking ──────────────────────────────────────────────

interface InflightRequest {
  promise: Promise<unknown>;
  timestamp: number;
}

const MIN_REFRESH_INTERVAL_MS = 500; // 最短刷新间隔：500ms

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useSessionStore() {
  const storeRef = useRef(new Map<string, SessionSlot>());
  const activeSessionIdRef = useRef<string | null>(null);
  // Bump to force re-render — only when the active session's data changes
  const [, setTick] = useState(0);
  // Track in-flight requests per session to prevent concurrent duplicates
  const inflightRef = useRef(new Map<string, InflightRequest>());
  const notify = useCallback((rawSessionId: string) => {
    const want = getSessionStoreKey(rawSessionId);
    const actRaw = activeSessionIdRef.current;
    const act = actRaw ? getSessionStoreKey(actRaw) : null;
    // 尚无正式 sessionId 时（例如新会话占位 `new-session-*`），act 为 null；仍须 tick 才能显示首条远程流式回复
    if (act === null || want === act) {
      setTick((n) => n + 1);
    }
  }, []);

  const setActiveSession = useCallback((sessionId: string | null) => {
    activeSessionIdRef.current = sessionId;
  }, []);

  const getSlot = useCallback((rawSessionId: string): SessionSlot => {
    const key = getSessionStoreKey(rawSessionId);
    const store = storeRef.current;
    if (!store.has(key)) {
      store.set(key, createEmptySlot());
    }
    return store.get(key)!;
  }, []);

  const has = useCallback((rawSessionId: string) => storeRef.current.has(getSessionStoreKey(rawSessionId)), []);

  const clearEntireStore = useCallback(() => {
    storeRef.current.clear();
    activeSessionIdRef.current = null;
    inflightRef.current.clear();
    setTick(n => n + 1);
  }, []);

  /**
   * Fetch messages from the unified endpoint and populate serverMessages.
   * Includes inflight lock and debounce to prevent concurrent/repeated requests.
   */
  const fetchFromServer = useCallback(async (
    sessionId: string,
    opts: {
      provider?: SessionProvider;
      projectName?: string;
      projectPath?: string;
      limit?: number | null;
      offset?: number;
      /** Force refresh even if recently fetched */
      force?: boolean;
    } = {},
  ) => {
    const key = getSessionStoreKey(sessionId);
    const inflight = inflightRef.current;

    // Check for in-flight request - return existing promise if one exists
    const existing = inflight.get(key);
    if (existing) {
      const elapsed = Date.now() - existing.timestamp;
      // If request started < 2s ago, reuse it
      if (elapsed < 2000) {
        chatImagesDebugLog('[SessionStore] reuse inflight fetch', { sessionId, elapsedMs: elapsed });
        return existing.promise as Promise<SessionSlot>;
      }
      // Otherwise, the old request may have stalled; proceed with new one
    }

    // Check if recently fetched (debounce) - skip if data is fresh enough
    const slot = getSlot(sessionId);
    if (!opts.force && (opts.offset ?? 0) === 0) {
      const fetchedElapsed = Date.now() - slot.fetchedAt;
      if (fetchedElapsed < MIN_REFRESH_INTERVAL_MS) {
        chatImagesDebugLog('[SessionStore] skip fetch (recently fetched)', {
          sessionId,
          elapsedMs: fetchedElapsed,
          thresholdMs: MIN_REFRESH_INTERVAL_MS,
        });
        return slot;
      }
    }

    // Start new request
    slot.status = 'loading';
    notify(sessionId);

    const requestPromise = (async () => {
      try {
        const params = new URLSearchParams();
        if (opts.provider) params.append('provider', opts.provider);
        if (opts.projectName) params.append('projectName', opts.projectName);
        if (opts.projectPath) params.append('projectPath', opts.projectPath);
        if (opts.limit !== null && opts.limit !== undefined) {
          params.append('limit', String(opts.limit));
          params.append('offset', String(opts.offset ?? 0));
        }

        const qs = params.toString();
        const url = `/api/sessions/${encodeURIComponent(sessionId)}/messages${qs ? `?${qs}` : ''}`;
        const response = await authenticatedFetch(url);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        const messages: NormalizedMessage[] = data.messages || [];
        const rtSnapshot = [...slot.realtimeMessages];
        const mergedMessages = mergeUserImagesFromRealtime(messages, rtSnapshot);

        if (isChatImagesDebugEnabled()) {
          const apiPathNote = messages.filter(
            (m) =>
              m.kind === 'text' &&
              m.role === 'user' &&
              String(m.content || '').includes('[Images provided at the following paths:'),
          ).length;
          chatImagesDebugLog('fetchFromServer', {
            sessionId,
            offset: opts.offset ?? 0,
            optsProjectPath: opts.projectPath ? String(opts.projectPath).slice(0, 160) : '(empty)',
            apiTotal: messages.length,
            apiUserWithPathNote: apiPathNote,
            apiUserWithImages: countUserWithImages(messages),
            rtLen: rtSnapshot.length,
            rtUserWithImages: countUserWithImages(rtSnapshot),
            mergedUserWithImages: countUserWithImages(mergedMessages),
          });
        }

        // Initial page load: treat server as source of truth, but keep user image
        // optimistic rows so thumbnails don't disappear when API lacks inline images.
        if ((opts.offset ?? 0) === 0) {
          slot.realtimeMessages = retainRealtimeImageRows(slot.realtimeMessages);
        }
        slot.serverMessages = mergedMessages;
        slot.total = data.total ?? messages.length;
        slot.hasMore = Boolean(data.hasMore);
        slot.offset = (opts.offset ?? 0) + messages.length;
        slot.fetchedAt = Date.now();
        slot.status = 'idle';
        recomputeMergedIfNeeded(slot);
        if (data.tokenUsage) {
          slot.tokenUsage = data.tokenUsage;
        }
        // 服务端已含图时，清理已匹配的 realtime 图片行，防止同条消息重复显示。
        slot.realtimeMessages = dropRealtimeImageRowsAlreadyOnServer(
          slot.serverMessages,
          slot.realtimeMessages,
        );
        recomputeMergedIfNeeded(slot);

        notify(sessionId);
        inflight.delete(key);
        return slot;
      } catch (error) {
        console.error(`[SessionStore] fetch failed for ${sessionId}:`, error);
        slot.status = 'error';
        notify(sessionId);
        inflight.delete(key);
        return slot;
      }
    })();

    inflight.set(key, { promise: requestPromise, timestamp: Date.now() });
    return requestPromise as Promise<SessionSlot>;
  }, [getSlot, notify]);

  /**
   * Load older (paginated) messages and prepend to serverMessages.
   */
  const fetchMore = useCallback(async (
    sessionId: string,
    opts: {
      provider?: SessionProvider;
      projectName?: string;
      projectPath?: string;
      limit?: number;
    } = {},
  ) => {
    const slot = getSlot(sessionId);
    if (!slot.hasMore) return slot;

    const params = new URLSearchParams();
    if (opts.provider) params.append('provider', opts.provider);
    if (opts.projectName) params.append('projectName', opts.projectName);
    if (opts.projectPath) params.append('projectPath', opts.projectPath);
    const limit = opts.limit ?? 20;
    params.append('limit', String(limit));
    params.append('offset', String(slot.offset));

    const qs = params.toString();
    const url = `/api/sessions/${encodeURIComponent(sessionId)}/messages${qs ? `?${qs}` : ''}`;

    try {
      const response = await authenticatedFetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const olderMessages: NormalizedMessage[] = data.messages || [];

      // Prepend older messages (they're earlier in the conversation)
      const combined = mergeUserImagesFromRealtime(
        [...olderMessages, ...slot.serverMessages],
        slot.realtimeMessages,
      );
      if (isChatImagesDebugEnabled()) {
        chatImagesDebugLog('fetchMore', {
          sessionId,
          olderLen: olderMessages.length,
          mergedUserWithImages: countUserWithImages(combined),
        });
      }
      slot.serverMessages = combined;
      slot.hasMore = Boolean(data.hasMore);
      slot.offset = slot.offset + olderMessages.length;
      recomputeMergedIfNeeded(slot);
      notify(sessionId);
      return slot;
    } catch (error) {
      console.error(`[SessionStore] fetchMore failed for ${sessionId}:`, error);
      return slot;
    }
  }, [getSlot, notify]);

  /**
   * Append a realtime (WebSocket) message to the correct session slot.
   * This works regardless of which session is actively viewed.
   */
  const appendRealtime = useCallback((sessionId: string, msg: NormalizedMessage) => {
    const slot = getSlot(sessionId);
    let updated = [...slot.realtimeMessages, msg];
    if (updated.length > MAX_REALTIME_MESSAGES) {
      updated = updated.slice(-MAX_REALTIME_MESSAGES);
    }
    slot.realtimeMessages = updated;
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Append multiple realtime messages at once (batch).
   */
  const appendRealtimeBatch = useCallback((sessionId: string, msgs: NormalizedMessage[]) => {
    if (msgs.length === 0) return;
    const slot = getSlot(sessionId);
    let updated = [...slot.realtimeMessages, ...msgs];
    if (updated.length > MAX_REALTIME_MESSAGES) {
      updated = updated.slice(-MAX_REALTIME_MESSAGES);
    }
    slot.realtimeMessages = updated;
    recomputeMergedIfNeeded(slot);
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Re-fetch serverMessages from the unified endpoint (e.g., on projects_updated).
   * Includes inflight lock and debounce to prevent concurrent/repeated requests.
   */
  const refreshFromServer = useCallback(async (
    sessionId: string,
    opts: {
      provider?: SessionProvider;
      projectName?: string;
      projectPath?: string;
      /** Force refresh even if recently fetched */
      force?: boolean;
    } = {},
  ) => {
    const key = getSessionStoreKey(sessionId);
    const inflight = inflightRef.current;

    // Check for in-flight request - return existing promise if one exists
    const existing = inflight.get(key);
    if (existing) {
      const elapsed = Date.now() - existing.timestamp;
      // If request started < 2s ago, reuse it
      if (elapsed < 2000) {
        chatImagesDebugLog('[SessionStore] reuse inflight refresh', { sessionId, elapsedMs: elapsed });
        return;
      }
    }

    // Check if recently fetched (debounce) - skip if data is fresh enough and total unchanged
    const slot = getSlot(sessionId);
    if (!opts.force) {
      const fetchedElapsed = Date.now() - slot.fetchedAt;
      if (fetchedElapsed < MIN_REFRESH_INTERVAL_MS) {
        chatImagesDebugLog('[SessionStore] skip refresh (recently fetched)', {
          sessionId,
          elapsedMs: fetchedElapsed,
          thresholdMs: MIN_REFRESH_INTERVAL_MS,
        });
        return;
      }
    }

    const requestPromise = (async () => {
      try {
        const params = new URLSearchParams();
        if (opts.provider) params.append('provider', opts.provider);
        if (opts.projectName) params.append('projectName', opts.projectName);
        if (opts.projectPath) params.append('projectPath', opts.projectPath);

        const qs = params.toString();
        const url = `/api/sessions/${encodeURIComponent(sessionId)}/messages${qs ? `?${qs}` : ''}`;
        const response = await authenticatedFetch(url);

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();

        const rtSnapshot = [...slot.realtimeMessages];
        const incoming = (data.messages || []) as NormalizedMessage[];
        const mergedRefresh = mergeUserImagesFromRealtime(incoming, rtSnapshot);
        if (isChatImagesDebugEnabled()) {
          const apiPathNote = incoming.filter(
            (m: NormalizedMessage) =>
              m.kind === 'text' &&
              m.role === 'user' &&
              String(m.content || '').includes('[Images provided at the following paths:'),
          ).length;
          chatImagesDebugLog('refreshFromServer', {
            sessionId,
            optsProjectPath: opts.projectPath ? String(opts.projectPath).slice(0, 160) : '(empty)',
            apiTotal: incoming.length,
            apiUserWithPathNote: apiPathNote,
            apiUserWithImages: countUserWithImages(incoming),
            rtLen: rtSnapshot.length,
            rtUserWithImages: countUserWithImages(rtSnapshot),
            mergedUserWithImages: countUserWithImages(mergedRefresh),
          });
        }
        slot.serverMessages = mergedRefresh;
        slot.total = data.total ?? slot.serverMessages.length;
        slot.hasMore = Boolean(data.hasMore);
        slot.fetchedAt = Date.now();
        // Drop most realtime rows once server catches up, but preserve user image
        // rows used to patch API user bubbles in remote SSH mode.
        slot.realtimeMessages = retainRealtimeImageRows(slot.realtimeMessages);
        // 若服务端已经返回了对应带图用户行，则移除该 realtime 行避免重复显示。
        slot.realtimeMessages = dropRealtimeImageRowsAlreadyOnServer(
          slot.serverMessages,
          slot.realtimeMessages,
        );
        recomputeMergedIfNeeded(slot);
        notify(sessionId);
        inflight.delete(key);
      } catch (error) {
        console.error(`[SessionStore] refresh failed for ${sessionId}:`, error);
        inflight.delete(key);
      }
    })();

    inflight.set(key, { promise: requestPromise, timestamp: Date.now() });
    await requestPromise;
    return slot;
  }, [getSlot, notify]);

  /**
   * Update session status.
   */
  const setStatus = useCallback((sessionId: string, status: SessionStatus) => {
    const slot = getSlot(sessionId);
    slot.status = status;
    notify(sessionId);
  }, [getSlot, notify]);

  /**
   * Check if a session's data is stale (>30s old).
   */
  const isStale = useCallback((rawSessionId: string) => {
    const slot = storeRef.current.get(getSessionStoreKey(rawSessionId));
    if (!slot) return true;
    return Date.now() - slot.fetchedAt > STALE_THRESHOLD_MS;
  }, []);

  /**
   * Update or create a streaming message (accumulated text so far).
   * Uses a well-known ID so subsequent calls replace the same message.
   */
  const updateStreaming = useCallback((rawSessionId: string, accumulatedText: string, msgProvider: SessionProvider) => {
    const key = getSessionStoreKey(rawSessionId);
    const slot = getSlot(rawSessionId);
    const streamId = `__streaming_${key}`;
    const msg: NormalizedMessage = {
      id: streamId,
      sessionId: rawSessionId,
      timestamp: new Date().toISOString(),
      provider: msgProvider,
      kind: 'stream_delta',
      content: accumulatedText,
    };
    const idx = slot.realtimeMessages.findIndex(m => m.id === streamId);
    if (idx >= 0) {
      slot.realtimeMessages = [...slot.realtimeMessages];
      slot.realtimeMessages[idx] = msg;
    } else {
      slot.realtimeMessages = [...slot.realtimeMessages, msg];
    }
    recomputeMergedIfNeeded(slot);
    notify(rawSessionId);
  }, [getSlot, notify]);

  /**
   * Finalize streaming: convert the streaming message to a regular text message.
   * The well-known streaming ID is replaced with a unique text message ID.
   */
  const finalizeStreaming = useCallback((rawSessionId: string) => {
    const key = getSessionStoreKey(rawSessionId);
    const slot = storeRef.current.get(key);
    if (!slot) return;
    const streamId = `__streaming_${key}`;
    const idx = slot.realtimeMessages.findIndex(m => m.id === streamId);
    if (idx >= 0) {
      const stream = slot.realtimeMessages[idx];
      slot.realtimeMessages = [...slot.realtimeMessages];
      slot.realtimeMessages[idx] = {
        ...stream,
        id: `text_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        kind: 'text',
        role: 'assistant',
      };
      recomputeMergedIfNeeded(slot);
      notify(rawSessionId);
    }
  }, [notify]);

  /**
   * 将占位会话（如 `new-session-*`）下的消息迁到真实 sessionId（与远端 session_created 对齐）。
   */
  const reassignSessionMessages = useCallback((fromRawId: string, toRawId: string) => {
    if (!fromRawId || !toRawId || fromRawId === toRawId) {
      return;
    }
    const fromKey = getSessionStoreKey(fromRawId);
    const toKey = getSessionStoreKey(toRawId);
    const fromSlot = storeRef.current.get(fromKey);
    if (!fromSlot) {
      return;
    }
    const toSlot = getSlot(toRawId);
    const oldStreamId = `__streaming_${fromKey}`;
    const newStreamId = `__streaming_${toKey}`;
    toSlot.serverMessages = [...fromSlot.serverMessages];
    toSlot.realtimeMessages = fromSlot.realtimeMessages.map((m) => ({
      ...m,
      sessionId: toRawId,
      id: m.id === oldStreamId ? newStreamId : m.id,
    }));
    toSlot.total = fromSlot.total;
    toSlot.hasMore = fromSlot.hasMore;
    toSlot.fetchedAt = fromSlot.fetchedAt;
    recomputeMergedIfNeeded(toSlot);
    storeRef.current.delete(fromKey);
    if (activeSessionIdRef.current === fromRawId) {
      activeSessionIdRef.current = toRawId;
    }
    notify(toRawId);
  }, [getSlot, notify]);

  /**
   * Clear realtime messages for a session (e.g., after stream completes and server fetch catches up).
   */
  const clearRealtime = useCallback((rawSessionId: string) => {
    const key = getSessionStoreKey(rawSessionId);
    const slot = storeRef.current.get(key);
    if (slot) {
      slot.realtimeMessages = [];
      recomputeMergedIfNeeded(slot);
      notify(rawSessionId);
    }
  }, [notify]);

  /**
   * Get merged messages for a session (for rendering).
   */
  const getMessages = useCallback((rawSessionId: string): NormalizedMessage[] => {
    return storeRef.current.get(getSessionStoreKey(rawSessionId))?.merged ?? [];
  }, []);

  /**
   * Get session slot (for status, pagination info, etc.).
   */
  const getSessionSlot = useCallback((rawSessionId: string): SessionSlot | undefined => {
    return storeRef.current.get(getSessionStoreKey(rawSessionId));
  }, []);

  return useMemo(() => ({
    getSlot,
    has,
    clearEntireStore,
    fetchFromServer,
    fetchMore,
    appendRealtime,
    appendRealtimeBatch,
    refreshFromServer,
    setActiveSession,
    setStatus,
    isStale,
    updateStreaming,
    finalizeStreaming,
    reassignSessionMessages,
    clearRealtime,
    getMessages,
    getSessionSlot,
  }), [
    getSlot, has, clearEntireStore, fetchFromServer, fetchMore,
    appendRealtime, appendRealtimeBatch, refreshFromServer,
    setActiveSession, setStatus, isStale, updateStreaming, finalizeStreaming,
    reassignSessionMessages, clearRealtime, getMessages, getSessionSlot,
  ]);
}

export type SessionStore = ReturnType<typeof useSessionStore>;
