import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDeviceSettings } from '../../../hooks/useDeviceSettings';
import { useVersionCheck } from '../../../hooks/useVersionCheck';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useSidebarController } from '../hooks/useSidebarController';
import { useTaskMaster } from '../../../contexts/TaskMasterContext';
import { useTasksSettings } from '../../../contexts/TasksSettingsContext';
import { useAuth } from '../../auth/context/AuthContext';
import { useEnvironment } from '../../../contexts/EnvironmentContext';
import { api } from '../../../utils/api';
import type { Project, SessionProvider } from '../../../types/app';
import type { MCPServerStatus, SidebarProps } from '../types/types';
import SidebarCollapsed from './subcomponents/SidebarCollapsed';
import SidebarContent from './subcomponents/SidebarContent';
import SidebarModals from './subcomponents/SidebarModals';
import type { SidebarProjectListProps } from './subcomponents/SidebarProjectList';
import OpenRemoteProjectDialog from './subcomponents/OpenRemoteProjectDialog';
import OpenLocalProjectDialog from './subcomponents/OpenLocalProjectDialog';
import ProjectClaudeMdRemoteModal from './subcomponents/ProjectClaudeMdRemoteModal';

type TaskMasterSidebarContext = {
  setCurrentProject: (project: Project) => void;
  mcpServerStatus: MCPServerStatus;
};

function Sidebar({
  projects,
  selectedProject,
  selectedSession,
  onProjectSelect,
  onSessionSelect,
  onNewSession,
  onSessionDelete,
  onProjectDelete,
  isLoading,
  loadingProgress,
  onRefresh,
  onShowSettings,
  showSettings,
  settingsInitialTab,
  onCloseSettings,
  isMobile,
  onOpenProjectFile,
}: SidebarProps) {
  const { t } = useTranslation(['sidebar', 'common']);
  const { isPWA } = useDeviceSettings({ trackMobile: false });
  const { updateAvailable, latestVersion, currentVersion, releaseInfo, installMode } = useVersionCheck(
    'siteboon',
    'claudecodeui',
  );
  const { preferences, setPreference } = useUiPreferences();
  const { sidebarVisible } = preferences;
  const { setCurrentProject, mcpServerStatus } = useTaskMaster() as TaskMasterSidebarContext;
  const { tasksEnabled } = useTasksSettings();
  const auth = useAuth();
  const { isRemote, currentTarget } = useEnvironment();
  const remoteWorkspaceLabel = isRemote && currentTarget.kind === 'remote' ? currentTarget.displayName : null;

  const [remoteClaudeOpenBusyName, setRemoteClaudeOpenBusyName] = useState<string | null>(null);
  const [claudeMdProject, setClaudeMdProject] = useState<Project | null>(null);
  const [openRemotePathDialog, setOpenRemotePathDialog] = useState(false);
  const [openLocalPathDialog, setOpenLocalPathDialog] = useState(false);
  const handleOpenRemoteClaudeProject = useCallback(
    async (project: Project) => {
      if (!isRemote || currentTarget.kind !== 'remote' || !project?.__cloudcliRemote) {
        return;
      }
      setRemoteClaudeOpenBusyName(project.name);
      try {
        const res = await api.sshServers.openClaudeProject(currentTarget.serverId, { projectName: project.name });
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          window.alert(j.error || t('projects.openOnRemoteFailed'));
          return;
        }
        if (window.refreshProjects) {
          void window.refreshProjects();
        }
      } catch (e) {
        window.alert(e instanceof Error ? e.message : t('projects.openOnRemoteFailed'));
      } finally {
        setRemoteClaudeOpenBusyName(null);
      }
    },
    [currentTarget, isRemote, t],
  );

  const onAfterRemotePathOpen = useCallback(() => {
    if (window.refreshProjects) {
      void window.refreshProjects();
    }
  }, []);

  const onAfterLocalPathOpen = useCallback(() => {
    if (window.refreshProjects) {
      void window.refreshProjects();
    }
  }, []);

  const {
    isSidebarCollapsed,
    expandedProjects,
    editingProject,
    showNewProject,
    editingName,
    loadingSessions,
    initialSessionsLoaded,
    currentTime,
    isRefreshing,
    editingSession,
    editingSessionName,
    searchFilter,
    searchMode,
    setSearchMode,
    conversationResults,
    isSearching,
    searchProgress,
    clearConversationResults,
    deletingProjects,
    deleteConfirmation,
    sessionDeleteConfirmation,
    showVersionModal,
    filteredProjects,
    toggleProject,
    handleSessionClick,
    toggleStarProject,
    isProjectStarred,
    getProjectSessions,
    startEditing,
    cancelEditing,
    saveProjectName,
    showDeleteSessionConfirmation,
    confirmDeleteSession,
    requestProjectDelete,
    confirmDeleteProject,
    loadMoreSessions,
    handleProjectSelect,
    refreshProjects,
    updateSessionSummary,
    collapseSidebar: handleCollapseSidebar,
    expandSidebar: handleExpandSidebar,
    setShowNewProject,
    setEditingName,
    setEditingSession,
    setEditingSessionName,
    setSearchFilter,
    setDeleteConfirmation,
    setSessionDeleteConfirmation,
    setShowVersionModal,
  } = useSidebarController({
    projects,
    selectedProject,
    selectedSession,
    isLoading,
    isMobile,
    t,
    onRefresh,
    onProjectSelect,
    onSessionSelect,
    onSessionDelete,
    onProjectDelete,
    setCurrentProject,
    setSidebarVisible: (visible) => setPreference('sidebarVisible', visible),
    sidebarVisible,
  });

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    document.documentElement.classList.toggle('pwa-mode', isPWA);
    document.body.classList.toggle('pwa-mode', isPWA);
  }, [isPWA]);

  const handleProjectCreated = () => {
    if (window.refreshProjects) {
      void window.refreshProjects();
      return;
    }

    window.location.reload();
  };

  const projectListProps: SidebarProjectListProps = {
    projects,
    filteredProjects,
    selectedProject,
    selectedSession,
    isLoading,
    loadingProgress,
    expandedProjects,
    editingProject,
    editingName,
    loadingSessions,
    initialSessionsLoaded,
    currentTime,
    editingSession,
    editingSessionName,
    deletingProjects,
    tasksEnabled,
    mcpServerStatus,
    getProjectSessions,
    isProjectStarred,
    onEditingNameChange: setEditingName,
    onToggleProject: toggleProject,
    onProjectSelect: handleProjectSelect,
    onToggleStarProject: toggleStarProject,
    onStartEditingProject: startEditing,
    onCancelEditingProject: cancelEditing,
    onSaveProjectName: (projectName) => {
      void saveProjectName(projectName);
    },
    onDeleteProject: requestProjectDelete,
    onSessionSelect: handleSessionClick,
    onDeleteSession: showDeleteSessionConfirmation,
    onLoadMoreSessions: (project) => {
      void loadMoreSessions(project);
    },
    onNewSession,
    onEditingSessionNameChange: setEditingSessionName,
    onStartEditingSession: (sessionId, initialName) => {
      setEditingSession(sessionId);
      setEditingSessionName(initialName);
    },
    onCancelEditingSession: () => {
      setEditingSession(null);
      setEditingSessionName('');
    },
    onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: SessionProvider) => {
      void updateSessionSummary(projectName, sessionId, summary, provider);
    },
    t,
    onOpenRemoteClaudeProject:
      isRemote && currentTarget.kind === 'remote' ? handleOpenRemoteClaudeProject : undefined,
    remoteClaudeOpenBusyName: remoteClaudeOpenBusyName,
    isRemoteContext: isRemote,
    onOpenRemoteProjectByPath: isRemote && currentTarget.kind === 'remote' ? () => setOpenRemotePathDialog(true) : undefined,
    onOpenClaudeMdRemote:
      isRemote && currentTarget.kind === 'remote' ? (p: Project) => setClaudeMdProject(p) : undefined,
  };

  return (
    <>
      <SidebarModals
        projects={projects}
        showSettings={showSettings}
        settingsInitialTab={settingsInitialTab}
        onCloseSettings={onCloseSettings}
        showNewProject={showNewProject}
        onCloseNewProject={() => setShowNewProject(false)}
        onProjectCreated={handleProjectCreated}
        deleteConfirmation={deleteConfirmation}
        onCancelDeleteProject={() => setDeleteConfirmation(null)}
        onConfirmDeleteProject={confirmDeleteProject}
        sessionDeleteConfirmation={sessionDeleteConfirmation}
        onCancelDeleteSession={() => setSessionDeleteConfirmation(null)}
        onConfirmDeleteSession={confirmDeleteSession}
        showVersionModal={showVersionModal}
        onCloseVersionModal={() => setShowVersionModal(false)}
        releaseInfo={releaseInfo}
        currentVersion={currentVersion}
        latestVersion={latestVersion}
        installMode={installMode}
        t={t}
      />

      {isRemote && currentTarget.kind === 'remote' && claudeMdProject && (
        <ProjectClaudeMdRemoteModal
          open
          onOpenChange={(o) => {
            if (!o) {
              setClaudeMdProject(null);
            }
          }}
          serverId={currentTarget.serverId}
          project={claudeMdProject}
          t={t}
        />
      )}

      {isRemote && currentTarget.kind === 'remote' && (
        <OpenRemoteProjectDialog
          open={openRemotePathDialog}
          onOpenChange={setOpenRemotePathDialog}
          serverId={currentTarget.serverId}
          onSuccess={onAfterRemotePathOpen}
          t={t}
        />
      )}

      {!isRemote && (
        <OpenLocalProjectDialog
          open={openLocalPathDialog}
          onOpenChange={setOpenLocalPathDialog}
          onSuccess={onAfterLocalPathOpen}
          t={t}
        />
      )}

      {isSidebarCollapsed ? (
        <SidebarCollapsed
          onExpand={handleExpandSidebar}
          onShowSettings={onShowSettings}
          updateAvailable={updateAvailable}
          onShowVersionModal={() => setShowVersionModal(true)}
          onLogout={() => auth.logout()}
          t={t}
        />
      ) : (
        <>
          <SidebarContent
            isPWA={isPWA}
            isMobile={isMobile}
            isLoading={isLoading}
            projects={projects}
            searchFilter={searchFilter}
            onSearchFilterChange={setSearchFilter}
            onClearSearchFilter={() => setSearchFilter('')}
            searchMode={searchMode}
            onSearchModeChange={(mode: 'projects' | 'conversations' | 'servers') => {
              setSearchMode(mode);
              if (mode === 'projects') clearConversationResults();
            }}
            conversationResults={conversationResults}
            isSearching={isSearching}
            searchProgress={searchProgress}
            onConversationResultClick={(projectName: string, sessionId: string, provider: string, messageTimestamp?: string | null, messageSnippet?: string | null) => {
              const resolvedProvider = (provider || 'claude') as SessionProvider;
              const project = projects.find(p => p.name === projectName);
              const searchTarget = { __searchTargetTimestamp: messageTimestamp || null, __searchTargetSnippet: messageSnippet || null };
              const sessionObj = {
                id: sessionId,
                __provider: resolvedProvider,
                __projectName: projectName,
                ...searchTarget,
              };
              if (project) {
                handleProjectSelect(project);
                const sessions = getProjectSessions(project);
                const existing = sessions.find(s => s.id === sessionId);
                if (existing) {
                  handleSessionClick({ ...existing, ...searchTarget }, projectName);
                } else {
                  handleSessionClick(sessionObj, projectName);
                }
              } else {
                handleSessionClick(sessionObj, projectName);
              }
            }}
            onRefresh={() => {
              void refreshProjects();
            }}
            isRefreshing={isRefreshing}
            isRemoteContext={isRemote}
            remoteWorkspaceLabel={remoteWorkspaceLabel}
            createProjectDisabled={isRemote}
            onCreateProject={() => setShowNewProject(true)}
            onOpenRemoteProjectByPath={() => setOpenRemotePathDialog(true)}
            onOpenLocalProjectByPath={() => setOpenLocalPathDialog(true)}
            onCollapseSidebar={handleCollapseSidebar}
            updateAvailable={updateAvailable}
            releaseInfo={releaseInfo}
            latestVersion={latestVersion}
            onShowVersionModal={() => setShowVersionModal(true)}
            onShowSettings={onShowSettings}
            onLogout={() => auth.logout()}
            projectListProps={projectListProps}
            onOpenProjectFile={onOpenProjectFile}
            t={t}
          />
        </>
      )}

    </>
  );
}

export default Sidebar;
