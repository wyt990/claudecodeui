import { useCallback, useEffect, useRef, useState } from 'react';
import { authenticatedFetch } from '../../../utils/api';
import { CLAUDE_MODELS, CODEX_MODELS, CURSOR_MODELS, GEMINI_MODELS } from '../../../../shared/modelConstants';
import type { PendingPermissionRequest, PermissionMode } from '../types/types';
import type { ProjectSession, SessionProvider } from '../../../types/app';

export type ClaudeModelPickerOption = { value: string; label: string };

interface UseChatProviderStateArgs {
  selectedSession: ProjectSession | null;
  /** SSH 远程工作区当前服务器 id；有值时从远端拉取 Claude 模型列表 */
  remoteClaudeServerId?: number | null;
}

const PRESET_CLAUDE_MODEL_IDS = new Set(CLAUDE_MODELS.OPTIONS.map((o) => o.value));

export function useChatProviderState({
  selectedSession,
  remoteClaudeServerId = null,
}: UseChatProviderStateArgs) {
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');
  const [pendingPermissionRequests, setPendingPermissionRequests] = useState<PendingPermissionRequest[]>([]);
  const [provider, setProvider] = useState<SessionProvider>(() => {
    return (localStorage.getItem('selected-provider') as SessionProvider) || 'claude';
  });
  const [cursorModel, setCursorModel] = useState<string>(() => {
    return localStorage.getItem('cursor-model') || CURSOR_MODELS.DEFAULT;
  });
  const [claudeModel, setClaudeModel] = useState<string>(() => {
    return localStorage.getItem('claude-model') || CLAUDE_MODELS.DEFAULT;
  });
  const [codexModel, setCodexModel] = useState<string>(() => {
    return localStorage.getItem('codex-model') || CODEX_MODELS.DEFAULT;
  });
  const [geminiModel, setGeminiModel] = useState<string>(() => {
    return localStorage.getItem('gemini-model') || GEMINI_MODELS.DEFAULT;
  });

  const [claudeModelOptions, setClaudeModelOptions] = useState<ClaudeModelPickerOption[]>(() => [
    ...CLAUDE_MODELS.OPTIONS,
  ]);

  const lastProviderRef = useRef(provider);

  useEffect(() => {
    if (!selectedSession?.id) {
      return;
    }

    const savedMode = localStorage.getItem(`permissionMode-${selectedSession.id}`);
    setPermissionMode((savedMode as PermissionMode) || 'default');
  }, [selectedSession?.id]);

  useEffect(() => {
    if (!selectedSession?.__provider || selectedSession.__provider === provider) {
      return;
    }

    setProvider(selectedSession.__provider);
    localStorage.setItem('selected-provider', selectedSession.__provider);
  }, [provider, selectedSession]);

  useEffect(() => {
    if (lastProviderRef.current === provider) {
      return;
    }
    setPendingPermissionRequests([]);
    lastProviderRef.current = provider;
  }, [provider]);

  useEffect(() => {
    setPendingPermissionRequests((previous) =>
      previous.filter((request) => !request.sessionId || request.sessionId === selectedSession?.id),
    );
  }, [selectedSession?.id]);

  useEffect(() => {
    let cancelled = false;

    const applyModelsFromRemote = (data: {
      models: { id: string; label?: string }[];
      defaultModelId?: string | null;
    }) => {
      const opts: ClaudeModelPickerOption[] = data.models.map((m) => ({
        value: m.id,
        label: m.label?.trim() ? m.label.trim() : m.id,
      }));
      setClaudeModelOptions(opts);
      const ids = new Set(opts.map((o) => o.value));
      const envDefault = typeof data.defaultModelId === 'string' ? data.defaultModelId : '';
      setClaudeModel((prev) => {
        const fromStorage = localStorage.getItem('claude-model');
        const cur = fromStorage || prev;
        if (ids.has(cur)) {
          return prev;
        }
        if (PRESET_CLAUDE_MODEL_IDS.has(cur) || !ids.has(cur)) {
          const fallback =
            opts.find((o) => o.value !== '(default)')?.value || opts[0]!.value;
          const next = envDefault && ids.has(envDefault) ? envDefault : fallback;
          localStorage.setItem('claude-model', next);
          return next;
        }
        return prev;
      });
    };

    (async () => {
      try {
        if (
          remoteClaudeServerId != null
          && Number.isFinite(remoteClaudeServerId)
          && remoteClaudeServerId >= 1
        ) {
          const r = await authenticatedFetch(
            `/api/ssh-servers/${remoteClaudeServerId}/claude-list-models`,
          );
          const data = (await r.json()) as {
            models?: { id: string; label?: string }[];
            defaultModelId?: string | null;
          };
          const list = Array.isArray(data?.models) ? data.models : [];
          if (!cancelled && list.length > 0) {
            applyModelsFromRemote({ models: list, defaultModelId: data.defaultModelId });
            return;
          }
          if (!cancelled) {
            setClaudeModelOptions([...CLAUDE_MODELS.OPTIONS]);
          }
          return;
        }

        const cfgRes = await authenticatedFetch('/api/cli/claude/sdk-config');
        const cfg = (await cfgRes.json()) as {
          dynamicModels?: boolean;
          claudecodeModelPicker?: boolean;
        };
        if (cancelled) {
          return;
        }

        if (cfg.claudecodeModelPicker) {
          const r = await authenticatedFetch('/api/cli/claude/claudecode-models');
          const data = await r.json();
          if (!cancelled && data?.models?.length) {
            applyModelsFromRemote(data);
            return;
          }
        }

        if (cfg.dynamicModels) {
          const r = await authenticatedFetch('/api/cli/claude/openai-models');
          const data = await r.json();
          if (!cancelled && data?.models?.length) {
            applyModelsFromRemote(data);
          }
        }
      } catch (err) {
        // Silently fail - fallback to built-in models
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [remoteClaudeServerId]);

  useEffect(() => {
    if (provider !== 'cursor') {
      return;
    }

    authenticatedFetch('/api/cursor/config')
      .then((response) => response.json())
      .then((data) => {
        if (!data.success || !data.config?.model?.modelId) {
          return;
        }

        const modelId = data.config.model.modelId as string;
        if (!localStorage.getItem('cursor-model')) {
          setCursorModel(modelId);
        }
      })
      .catch((error) => {
        console.error('Error loading Cursor config:', error);
      });
  }, [provider]);

  const cyclePermissionMode = useCallback(() => {
    const modes: PermissionMode[] =
      provider === 'codex'
        ? ['default', 'acceptEdits', 'bypassPermissions']
        : ['default', 'acceptEdits', 'bypassPermissions', 'plan'];

    const currentIndex = modes.indexOf(permissionMode);
    const nextIndex = (currentIndex + 1) % modes.length;
    const nextMode = modes[nextIndex];
    setPermissionMode(nextMode);

    if (selectedSession?.id) {
      localStorage.setItem(`permissionMode-${selectedSession.id}`, nextMode);
    }
  }, [permissionMode, provider, selectedSession?.id]);

  return {
    provider,
    setProvider,
    cursorModel,
    setCursorModel,
    claudeModel,
    setClaudeModel,
    claudeModelOptions,
    codexModel,
    setCodexModel,
    geminiModel,
    setGeminiModel,
    permissionMode,
    setPermissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    cyclePermissionMode,
  };
}
