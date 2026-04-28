import React, { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import ChatInterface from '../../chat/view/ChatInterface';
import FileTree from '../../file-tree/view/FileTree';
import StandaloneShell from '../../standalone-shell/view/StandaloneShell';
import GitPanel from '../../git-panel/view/GitPanel';
import PluginTabContent from '../../plugins/view/PluginTabContent';
import type { MainContentProps } from '../types/types';
import { useTaskMaster } from '../../../contexts/TaskMasterContext';
import { useTasksSettings } from '../../../contexts/TasksSettingsContext';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useEditorSidebar } from '../../code-editor/hooks/useEditorSidebar';
import EditorSidebar from '../../code-editor/view/EditorSidebar';
import { cn } from '../../../lib/utils';
import type { AppTab, Project } from '../../../types/app';
import { TaskMasterPanel } from '../../task-master';
import { useEnvironment } from '../../../contexts/EnvironmentContext';
import { useMainShellSubtabs } from '../../../hooks/useMainShellSubtabs';
import MainContentHeader from './subcomponents/MainContentHeader';
import ShellSubTabBar from './subcomponents/ShellSubTabBar';
import MainContentStateView from './subcomponents/MainContentStateView';
import ErrorBoundary from './ErrorBoundary';
import ImageViewer from '../../file-tree/view/ImageViewer';
import { isImageFile } from '../../file-tree/utils/fileTreeUtils';
import type { FileTreeImageSelection } from '../../file-tree/types/types';

type TaskMasterContextValue = {
  currentProject?: Project | null;
  setCurrentProject?: ((project: Project) => void) | null;
};

type TasksSettingsContextValue = {
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  isTaskMasterReady: boolean | null;
};

function MainContent({
  selectedProject,
  selectedSession,
  activeTab,
  setActiveTab,
  ws,
  sendMessage,
  webSocketConnected,
  latestMessage,
  isMobile,
  onMenuClick,
  isLoading,
  onInputFocusChange,
  onSessionActive,
  onSessionInactive,
  onSessionProcessing,
  onSessionNotProcessing,
  processingSessions,
  onReplaceTemporarySession,
  onNavigateToSession,
  onShowSettings,
  externalMessageUpdate,
}: MainContentProps) {
  const { isRemote, targetKey } = useEnvironment();
  const isRemoteWithProject = Boolean(isRemote && selectedProject);
  const { tabIds: shellTabIds, activeId: activeShellTabId, setActive: setActiveShellTab, addTab: addShellTab, removeTab: removeShellTab } =
    useMainShellSubtabs(targetKey);
  const { preferences } = useUiPreferences();
  const { autoExpandTools, showRawParameters, showThinking, autoScrollToBottom, sendByCtrlEnter } = preferences;

  const { currentProject, setCurrentProject } = useTaskMaster() as TaskMasterContextValue;
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings() as TasksSettingsContextValue;

  // 本地：仍以「已安装 task-master CLI」为准。远程：可无 CLI（仅读 tasks.json / PRD），不应因 installation-status 为 false 隐藏标签。
  const shouldShowTasksTab = Boolean(tasksEnabled && (isRemote || isTaskMasterInstalled));

  const {
    editingFile,
    editorWidth,
    editorExpanded,
    hasManualWidth,
    resizeHandleRef,
    handleFileOpen,
    handleCloseEditor,
    handleToggleEditorExpand,
    handleResizeStart,
  } = useEditorSidebar({
    selectedProject,
    isMobile,
  });

  const [filesLayoutEditorFocus, setFilesLayoutEditorFocus] = useState(false);
  const [selectedImage, setSelectedImage] = useState<FileTreeImageSelection | null>(null);

  // 处理文件打开：图片文件使用 ImageViewer，其他文件使用代码编辑器
  const handleFileOpenWithImage = useCallback(
    (filePath: string, diffInfo?: unknown) => {
      if (!selectedProject) {
        handleFileOpen(filePath, diffInfo as any);
        return;
      }

      if (isImageFile(filePath)) {
        setSelectedImage({
          name: filePath.split('/').pop() || filePath,
          path: filePath,
          projectPath: selectedProject.path,
          projectName: selectedProject.name,
        });
      } else {
        handleFileOpen(filePath, diffInfo as any);
      }
    },
    [handleFileOpen, selectedProject],
  );

  const handleTabChange = useCallback<Dispatch<SetStateAction<AppTab>>>((tab) => {
    if (typeof tab === 'function') {
      setActiveTab((prev) => {
        const next = tab(prev);
        if (next === 'files') {
          queueMicrotask(() => setFilesLayoutEditorFocus(false));
        }
        return next;
      });
      return;
    }
    if (tab === 'files') {
      setFilesLayoutEditorFocus(false);
    }
    setActiveTab(tab);
  }, [setActiveTab]);

  useEffect(() => {
    if (activeTab !== 'files') {
      setFilesLayoutEditorFocus(false);
    }
  }, [activeTab]);

  useEffect(() => {
    if (!editingFile && filesLayoutEditorFocus) {
      setFilesLayoutEditorFocus(false);
    }
  }, [editingFile, filesLayoutEditorFocus]);

  useEffect(() => {
    const onOpenProjectFile = (event: Event) => {
      const detail = (event as CustomEvent<{ path?: string; preferEditorOnlyLayout?: boolean }>).detail;
      const path = detail?.path;
      if (typeof path !== 'string' || !path.trim()) {
        return;
      }
      if (detail?.preferEditorOnlyLayout) {
        setFilesLayoutEditorFocus(true);
      } else {
        setFilesLayoutEditorFocus(false);
      }
      setActiveTab('files');
      handleFileOpen(path);
    };

    window.addEventListener('cloudcli:open-file', onOpenProjectFile);
    return () => window.removeEventListener('cloudcli:open-file', onOpenProjectFile);
  }, [handleFileOpen, setActiveTab]);

  useEffect(() => {
    const selectedProjectName = selectedProject?.name;
    const currentProjectName = currentProject?.name;

    if (selectedProject && selectedProjectName !== currentProjectName) {
      setCurrentProject?.(selectedProject);
    }
  }, [selectedProject, currentProject?.name, setCurrentProject]);

  useEffect(() => {
    if (!shouldShowTasksTab && activeTab === 'tasks') {
      setActiveTab('chat');
    }
  }, [shouldShowTasksTab, activeTab, setActiveTab]);

  useEffect(() => {
    if (!isRemoteWithProject) {
      return;
    }
    const allowedWhenRemote = new Set<AppTab>(['chat', 'preview', 'shell', 'files', 'git', 'tasks']);
    if (!allowedWhenRemote.has(activeTab)) {
      setActiveTab('chat');
    }
  }, [isRemoteWithProject, activeTab, setActiveTab]);

  if (isLoading) {
    return <MainContentStateView mode="loading" isMobile={isMobile} onMenuClick={onMenuClick} />;
  }

  if (!selectedProject) {
    return (
      <MainContentStateView
        mode="empty"
        emptyContext={isRemote ? 'remote' : 'default'}
        isMobile={isMobile}
        onMenuClick={onMenuClick}
      />
    );
  }

  const hideMainFilePane = filesLayoutEditorFocus && activeTab === 'files';

  return (
    <div className="flex h-full flex-col">
      <MainContentHeader
        activeTab={activeTab}
        setActiveTab={handleTabChange}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        shouldShowTasksTab={shouldShowTasksTab}
        isRemoteTarget={isRemote}
        isMobile={isMobile}
        onMenuClick={onMenuClick}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          className={cn(
            'flex min-h-0 min-w-[200px] flex-1 flex-col overflow-hidden',
            (editorExpanded || hideMainFilePane) && 'hidden',
          )}
        >
          <div className={`h-full ${activeTab === 'chat' ? 'block' : 'hidden'}`}>
            <ErrorBoundary showDetails>
              <ChatInterface
                selectedProject={selectedProject}
                selectedSession={selectedSession}
                ws={ws}
                sendMessage={sendMessage}
                webSocketConnected={webSocketConnected}
                latestMessage={latestMessage}
                onFileOpen={handleFileOpenWithImage}
                onInputFocusChange={onInputFocusChange}
                onSessionActive={onSessionActive}
                onSessionInactive={onSessionInactive}
                onSessionProcessing={onSessionProcessing}
                onSessionNotProcessing={onSessionNotProcessing}
                processingSessions={processingSessions}
                onReplaceTemporarySession={onReplaceTemporarySession}
                onNavigateToSession={onNavigateToSession}
                onShowSettings={onShowSettings}
                autoExpandTools={autoExpandTools}
                showRawParameters={showRawParameters}
                showThinking={showThinking}
                autoScrollToBottom={autoScrollToBottom}
                sendByCtrlEnter={sendByCtrlEnter}
                externalMessageUpdate={externalMessageUpdate}
                onShowAllTasks={tasksEnabled ? () => setActiveTab('tasks') : null}
              />
            </ErrorBoundary>
          </div>

          {activeTab === 'files' && (
            <div className="h-full overflow-hidden">
              <FileTree selectedProject={selectedProject} onFileOpen={handleFileOpenWithImage} />
            </div>
          )}

          {activeTab === 'shell' && (
            <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
              <ShellSubTabBar
                tabIds={shellTabIds}
                activeId={activeShellTabId}
                onSelect={setActiveShellTab}
                onAdd={addShellTab}
                onClose={removeShellTab}
              />
              <div className="min-h-0 min-w-0 flex-1">
                {shellTabIds.map((sid) => (
                  <div key={sid} className={sid === activeShellTabId ? 'h-full' : 'hidden'}>
                    <StandaloneShell
                      project={selectedProject}
                      session={selectedSession}
                      showHeader={false}
                      isActive={activeTab === 'shell' && sid === activeShellTabId}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'git' && (
            <div className="h-full overflow-hidden">
              <GitPanel selectedProject={selectedProject} isMobile={isMobile} onFileOpen={handleFileOpenWithImage} />
            </div>
          )}

          {shouldShowTasksTab && <TaskMasterPanel isVisible={activeTab === 'tasks'} />}

          <div className={`h-full overflow-hidden ${activeTab === 'preview' ? 'block' : 'hidden'}`} />

          {activeTab.startsWith('plugin:') && (
            <div className="h-full overflow-hidden">
              <PluginTabContent
                pluginName={activeTab.replace('plugin:', '')}
                selectedProject={selectedProject}
                selectedSession={selectedSession}
              />
            </div>
          )}
        </div>

        <EditorSidebar
          editingFile={editingFile}
          isMobile={isMobile}
          editorExpanded={editorExpanded}
          editorWidth={editorWidth}
          hasManualWidth={hasManualWidth}
          resizeHandleRef={resizeHandleRef}
          onResizeStart={handleResizeStart}
          onCloseEditor={handleCloseEditor}
          onToggleEditorExpand={handleToggleEditorExpand}
          projectPath={selectedProject.fullPath || selectedProject.path}
          fillSpace={activeTab === 'files'}
          mainPaneHidden={hideMainFilePane}
        />
      </div>

      {/* 图片查看器：点击图片文件时显示 */}
      {selectedImage && (
        <ImageViewer file={selectedImage} onClose={() => setSelectedImage(null)} />
      )}
    </div>
  );
}

export default React.memo(MainContent);
