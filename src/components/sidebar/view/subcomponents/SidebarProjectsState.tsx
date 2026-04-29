import { Folder, Search } from 'lucide-react';
import type { TFunction } from 'i18next';
import type { LoadingProgress } from '../../../../types/app';
import { Button } from '../../../../shared/view/ui';

type SidebarProjectsStateProps = {
  isLoading: boolean;
  loadingProgress: LoadingProgress | null;
  projectsCount: number;
  filteredProjectsCount: number;
  t: TFunction;
  isRemoteContext?: boolean;
  onOpenRemoteProjectByPath?: () => void;
};

export default function SidebarProjectsState({
  isLoading,
  loadingProgress,
  projectsCount,
  filteredProjectsCount,
  t,
  isRemoteContext = false,
  onOpenRemoteProjectByPath,
}: SidebarProjectsStateProps) {
  // 远程上下文时，始终显示打开项目按钮（即使已有项目）
  const showOpenProjectButton = isRemoteContext && typeof onOpenRemoteProjectByPath === 'function';

  if (isLoading) {
    return (
      <div className="px-4 py-12 text-center md:py-8">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted md:mb-3">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
        </div>
        <h3 className="mb-2 text-base font-medium text-foreground md:mb-1">{t('projects.loadingProjects')}</h3>
        {loadingProgress && loadingProgress.total > 0 ? (
          <div className="space-y-2">
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-all duration-300 ease-out"
                style={{ width: `${(loadingProgress.current / loadingProgress.total) * 100}%` }}
              />
            </div>
            <p className="text-sm text-muted-foreground">
              {loadingProgress.current}/{loadingProgress.total} {t('projects.projects')}
            </p>
            {loadingProgress.currentProject && (
              <p
                className="mx-auto max-w-[200px] truncate text-xs text-muted-foreground/70"
                title={loadingProgress.currentProject}
              >
                {loadingProgress.currentProject.split('-').slice(-2).join('/')}
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t('projects.fetchingProjects')}</p>
        )}
        {showOpenProjectButton && (
          <div className="mt-4">
            <Button
              type="button"
              variant="default"
              className="bg-emerald-600 text-white hover:bg-emerald-700"
              onClick={onOpenRemoteProjectByPath}
            >
              {t('projects.openRemoteByPathButton')}
            </Button>
          </div>
        )}
      </div>
    );
  }

  if (projectsCount === 0) {
    return (
      <div className="px-4 py-12 text-center md:py-8">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted md:mb-3">
          <Folder className="h-6 w-6 text-muted-foreground" />
        </div>
        <h3 className="mb-2 text-base font-medium text-foreground md:mb-1">{t('projects.noProjects')}</h3>
        <p className="text-sm text-muted-foreground">{t('projects.runClaudeCli')}</p>
        {showOpenProjectButton && (
          <div className="mt-4">
            <Button
              type="button"
              variant="default"
              className="bg-emerald-600 text-white hover:bg-emerald-700"
              onClick={onOpenRemoteProjectByPath}
            >
              {t('projects.openRemoteByPathButton')}
            </Button>
            <p className="mt-2 text-xs text-muted-foreground leading-relaxed">{t('projects.openRemoteByPathHint')}</p>
          </div>
        )}
      </div>
    );
  }

  if (filteredProjectsCount === 0) {
    return (
      <div className="px-4 py-12 text-center md:py-8">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted md:mb-3">
          <Search className="h-6 w-6 text-muted-foreground" />
        </div>
        <h3 className="mb-2 text-base font-medium text-foreground md:mb-1">{t('projects.noMatchingProjects')}</h3>
        <p className="text-sm text-muted-foreground">{t('projects.tryDifferentSearch')}</p>
        {showOpenProjectButton && (
          <div className="mt-4">
            <Button
              type="button"
              variant="default"
              className="bg-emerald-600 text-white hover:bg-emerald-700"
              onClick={onOpenRemoteProjectByPath}
            >
              {t('projects.openRemoteByPathButton')}
            </Button>
          </div>
        )}
      </div>
    );
  }

  // 有项目时的状态（不再返回 null，而是返回打开项目按钮）
  if (showOpenProjectButton) {
    return (
      <div className="px-2 py-2">
        <Button
          type="button"
          variant="outline"
          className="w-full bg-emerald-600/10 text-emerald-700 hover:bg-emerald-600/20 border-emerald-600/30 dark:text-emerald-400 dark:hover:bg-emerald-600/15"
          onClick={onOpenRemoteProjectByPath}
        >
          {t('projects.openRemoteByPathButton')}
        </Button>
      </div>
    );
  }

  return null;
}
