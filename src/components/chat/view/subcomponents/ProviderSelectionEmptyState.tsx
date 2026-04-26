import React from "react";
import { useTranslation } from "react-i18next";
import type { ProjectSession, SessionProvider } from "../../../../types/app";
import type { ClaudeModelPickerOption } from "../../hooks/useChatProviderState";
import { NextTaskBanner } from "../../../task-master";

type ProviderSelectionEmptyStateProps = {
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: SessionProvider;
  setProvider: (next: SessionProvider) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  claudeModel: string;
  setClaudeModel: (model: string) => void;
  claudeModelOptions: ClaudeModelPickerOption[];
  cursorModel: string;
  setCursorModel: (model: string) => void;
  codexModel: string;
  setCodexModel: (model: string) => void;
  geminiModel: string;
  setGeminiModel: (model: string) => void;
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  onShowAllTasks?: (() => void) | null;
  setInput: React.Dispatch<React.SetStateAction<string>>;
};

export default function ProviderSelectionEmptyState({
  selectedSession,
  currentSessionId,
  tasksEnabled,
  isTaskMasterInstalled,
  onShowAllTasks,
  setInput,
}: ProviderSelectionEmptyStateProps) {
  const { t } = useTranslation("chat");
  const nextTaskPrompt = t("tasks.nextTaskPrompt", {
    defaultValue: "Start the next task",
  });

  /* ── New session：助手与模型在底部输入区选择，此处仅保留 Task 入口 ── */
  if (!selectedSession && !currentSessionId) {
    if (tasksEnabled && isTaskMasterInstalled) {
      return (
        <div className="flex h-full min-h-0 flex-col items-center justify-center px-4">
          <div className="w-full max-w-md">
            <NextTaskBanner
              onStartTask={() => setInput(nextTaskPrompt)}
              onShowAllTasks={onShowAllTasks}
            />
          </div>
        </div>
      );
    }
    return <div className="h-full min-h-0 flex-1" aria-hidden />;
  }

  /* ── Existing session — continue prompt ── */
  if (selectedSession) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="max-w-md px-6 text-center">
          <p className="mb-1.5 text-lg font-semibold text-foreground">
            {t("session.continue.title")}
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t("session.continue.description")}
          </p>

          {tasksEnabled && isTaskMasterInstalled && (
            <div className="mt-5">
              <NextTaskBanner
                onStartTask={() => setInput(nextTaskPrompt)}
                onShowAllTasks={onShowAllTasks}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
}
