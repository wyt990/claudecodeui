import { useEffect, useState } from 'react';
import type { TFunction } from 'i18next';
import { ChevronRight, Folder, Loader2, PlayCircle, Star } from 'lucide-react';
import type { LoadingProgress, Project } from '../../../../types/app';
import { cn } from '../../../../lib/utils';
import { Button, ScrollArea } from '../../../../shared/view/ui';
import FileTree from '../../../file-tree/view/FileTree';
import SidebarProjectsState from './SidebarProjectsState';

export type SidebarProjectsFileViewProps = {
  projects: Project[];
  filteredProjects: Project[];
  selectedProject: Project | null;
  isLoading: boolean;
  loadingProgress: LoadingProgress | null;
  isProjectStarred: (projectName: string) => boolean;
  onProjectSelect: (project: Project) => void;
  onToggleStarProject: (projectName: string) => void;
  onOpenProjectFile?: (path: string, options?: { preferEditorOnlyLayout?: boolean }) => void;
  t: TFunction;
  isRemoteContext?: boolean;
  onOpenRemoteProjectByPath?: () => void;
  onOpenRemoteClaudeProject?: (project: Project) => void | Promise<void>;
  remoteClaudeOpenBusyName?: string | null;
};

/** Which project row is expanded to show its file tree (at most one). */
export default function SidebarProjectsFileView({
  projects,
  filteredProjects,
  selectedProject,
  isLoading,
  loadingProgress,
  isProjectStarred,
  onProjectSelect,
  onToggleStarProject,
  onOpenProjectFile,
  t,
  isRemoteContext = false,
  onOpenRemoteProjectByPath,
  onOpenRemoteClaudeProject,
  remoteClaudeOpenBusyName,
}: SidebarProjectsFileViewProps) {
  const [expandedForTree, setExpandedForTree] = useState<string | null>(() => selectedProject?.name ?? null);

  // External selection change (e.g. other UI): expand that project's tree and collapse others.
  useEffect(() => {
    if (selectedProject?.name) {
      setExpandedForTree(selectedProject.name);
    } else {
      setExpandedForTree(null);
    }
  }, [selectedProject?.name]);

  const handleAccordionRowClick = (project: Project) => {
    if (expandedForTree === project.name) {
      setExpandedForTree(null);
      return;
    }
    setExpandedForTree(project.name);
    onProjectSelect(project);
  };

  const state = (
    <SidebarProjectsState
      isLoading={isLoading}
      loadingProgress={loadingProgress}
      projectsCount={projects.length}
      filteredProjectsCount={filteredProjects.length}
      t={t}
      isRemoteContext={isRemoteContext}
      onOpenRemoteProjectByPath={onOpenRemoteProjectByPath}
    />
  );

  const showList = !isLoading && projects.length > 0 && filteredProjects.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col pb-safe-area-inset-bottom md:px-1.5 md:py-2">
      {!showList ? (
        state
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-1 pr-1 pb-2">
            {filteredProjects.map((project) => {
              const treeOpen = expandedForTree === project.name;
              const isSelected = selectedProject?.name === project.name;
              const starred = isProjectStarred(project.name);
              const isRemoteClaude = project.__cloudcliRemote === true;
              const canOpenRemote = isRemoteClaude && typeof onOpenRemoteClaudeProject === 'function';
              const remoteBusy = remoteClaudeOpenBusyName === project.name;
              return (
                <div
                  key={project.name}
                  className={cn(
                    'overflow-hidden rounded-md border border-border/40 bg-background/40',
                    treeOpen && 'border-border/70 bg-accent/15',
                  )}
                >
                  <div className="flex items-center gap-0.5 px-0.5 py-0.5">
                    <button
                      type="button"
                      className={cn(
                        'flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-1 text-left transition-colors',
                        isSelected || treeOpen ? 'bg-accent/50' : 'hover:bg-accent/40',
                      )}
                      aria-expanded={treeOpen}
                      onClick={() => handleAccordionRowClick(project)}
                    >
                      <ChevronRight
                        className={cn(
                          'h-3.5 w-3.5 flex-shrink-0 text-muted-foreground transition-transform duration-150',
                          treeOpen && 'rotate-90',
                        )}
                        aria-hidden
                      />
                      <Folder
                        className={cn(
                          'h-3.5 w-3.5 flex-shrink-0',
                          isSelected || treeOpen ? 'text-primary' : 'text-muted-foreground',
                        )}
                      />
                      <span className="truncate text-xs font-medium text-foreground">{project.displayName || project.name}</span>
                    </button>
                    {canOpenRemote && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 flex-shrink-0 text-emerald-600 hover:bg-emerald-500/10 hover:text-emerald-700 dark:text-emerald-400"
                        title={t('tooltips.openRemoteClaudeProject')}
                        disabled={Boolean(remoteBusy)}
                        onClick={(e) => {
                          e.stopPropagation();
                          void onOpenRemoteClaudeProject?.(project);
                        }}
                      >
                        {remoteBusy ? (
                          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                        ) : (
                          <PlayCircle className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 flex-shrink-0 text-muted-foreground hover:text-amber-500"
                      aria-label={starred ? t('tooltips.removeFromFavorites') : t('tooltips.addToFavorites')}
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleStarProject(project.name);
                      }}
                    >
                      <Star className={cn('h-3.5 w-3.5', starred && 'fill-amber-400 text-amber-500')} />
                    </Button>
                  </div>

                  {treeOpen && (
                    <div className="flex h-[min(52vh,400px)] min-h-[160px] shrink-0 flex-col overflow-hidden border-t border-border/40">
                      <FileTree
                        selectedProject={project}
                        embedded
                        openTextFilesOnDoubleClick
                        onFileOpen={(path) => onOpenProjectFile?.(path, { preferEditorOnlyLayout: true })}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
