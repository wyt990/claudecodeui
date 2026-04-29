import { Settings, LogOut } from 'lucide-react';
import type { TFunction } from 'i18next';
import { IS_PLATFORM } from '../../../../constants/config';
import { useAuth } from '../../../auth/context/AuthContext';
import type { ReleaseInfo } from '../../../../types/sharedTypes';

type SidebarFooterProps = {
  updateAvailable: boolean;
  releaseInfo: ReleaseInfo | null;
  latestVersion: string | null;
  onShowVersionModal: () => void;
  onShowSettings: () => void;
  onLogout?: () => void;
  t: TFunction;
};

export default function SidebarFooter({
  onShowSettings,
  onLogout,
  t,
}: SidebarFooterProps) {
  const auth = useAuth();
  const isAuthenticated = !!auth?.user;
  return (
    <div className="flex-shrink-0" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0)' }}>
      <div className="nav-divider" />

      {/* Desktop: settings + logout — compact */}
      <div className="hidden space-y-0 px-2 py-1 md:block">
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
          onClick={onShowSettings}
        >
          <Settings className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="text-sm">{t('actions.settings')}</span>
        </button>
        {!IS_PLATFORM && isAuthenticated && (
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
            onClick={() => {
              if (onLogout) {
                onLogout();
              } else {
                auth.logout();
              }
            }}
          >
            <LogOut className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="text-sm">{t('actions.logout')}</span>
          </button>
        )}
      </div>

      {/* Mobile: compact */}
      <div className="space-y-1 px-3 py-1.5 md:hidden">
        <button
          type="button"
          className="flex h-10 w-full items-center gap-2.5 rounded-lg bg-muted/40 px-3 text-left transition-colors hover:bg-muted/60 active:scale-[0.99]"
          onClick={onShowSettings}
        >
          <Settings className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">{t('actions.settings')}</span>
        </button>
        {!IS_PLATFORM && isAuthenticated && (
          <button
            type="button"
            className="flex h-10 w-full items-center gap-2.5 rounded-lg bg-muted/40 px-3 text-left transition-colors hover:bg-muted/60 active:scale-[0.99]"
            onClick={() => {
              if (onLogout) {
                onLogout();
              } else {
                auth.logout();
              }
            }}
          >
            <LogOut className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">{t('actions.logout')}</span>
          </button>
        )}
      </div>

      {!IS_PLATFORM && !isAuthenticated && (
        <div className="px-3 py-1 md:hidden">
          <div className="h-2" />
        </div>
      )}
    </div>
  );
}
