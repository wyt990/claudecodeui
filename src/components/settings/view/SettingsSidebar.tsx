import { Bell, Bot, GitBranch, Info, Key, ListChecks, Palette, Puzzle, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../../lib/utils';
import { PillBar, Pill } from '../../../shared/view/ui';
import type { SettingsMainTab } from '../types/types';

const REMOTE_DISABLED: readonly SettingsMainTab[] = [
  'agents',
  'git',
  'tasks',
  'plugins',
  'notifications',
];

type SettingsSidebarProps = {
  activeTab: SettingsMainTab;
  onChange: (tab: SettingsMainTab) => void;
  isAdmin?: boolean;
  /** 远程 `currentTarget` 时按方案 §7.1 禁用的设置栏（外观 / API / 关于 等仍可用） */
  isRemoteTarget?: boolean;
};

type NavItem = {
  id: SettingsMainTab;
  labelKey: string;
  icon: typeof Bot;
  adminOnly?: boolean;
};

const NAV_ITEMS: NavItem[] = [
  { id: 'agents', labelKey: 'mainTabs.agents', icon: Bot },
  { id: 'appearance', labelKey: 'mainTabs.appearance', icon: Palette },
  { id: 'git', labelKey: 'mainTabs.git', icon: GitBranch },
  { id: 'api', labelKey: 'mainTabs.apiTokens', icon: Key },
  { id: 'tasks', labelKey: 'mainTabs.tasks', icon: ListChecks },
  { id: 'plugins', labelKey: 'mainTabs.plugins', icon: Puzzle },
  { id: 'notifications', labelKey: 'mainTabs.notifications', icon: Bell },
  { id: 'about', labelKey: 'mainTabs.about', icon: Info },
  { id: 'users', labelKey: 'mainTabs.users', icon: Users, adminOnly: true },
];

export default function SettingsSidebar({ activeTab, onChange, isAdmin = false, isRemoteTarget = false }: SettingsSidebarProps) {
  const { t } = useTranslation('settings');

  // Filter items based on admin status
  const visibleItems = NAV_ITEMS.filter(item => !item.adminOnly || isAdmin);

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden w-56 flex-shrink-0 border-r border-border bg-muted/30 md:flex md:flex-col">
        <nav className="flex flex-col gap-1 p-3">
          {visibleItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            const isDisabled = isRemoteTarget && REMOTE_DISABLED.includes(item.id);

            return (
              <button
                type="button"
                key={item.id}
                disabled={isDisabled}
                title={isDisabled ? t('remoteTarget.sidebarTabDisabled') : undefined}
                onClick={() => {
                  if (isDisabled) {
                    return;
                  }
                  onChange(item.id);
                }}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors duration-150',
                  isActive
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground active:bg-accent/50',
                  isDisabled && 'cursor-not-allowed opacity-40',
                )}
              >
                <Icon className="h-4 w-4 flex-shrink-0" />
                {t(item.labelKey)}
              </button>
            );
          })}
        </nav>
      </aside>

      {/* Mobile horizontal nav — pill bar */}
      <div className="flex-shrink-0 border-b border-border px-3 py-2 md:hidden">
        <PillBar className="scrollbar-hide w-full overflow-x-auto">
          {visibleItems.map((item) => {
            const Icon = item.icon;

            const isDisabled = isRemoteTarget && REMOTE_DISABLED.includes(item.id);
            return (
              <Pill
                key={item.id}
                isActive={activeTab === item.id}
                onClick={() => {
                  if (isDisabled) {
                    return;
                  }
                  onChange(item.id);
                }}
                disabled={isDisabled}
                className="flex-shrink-0"
                title={isDisabled ? t('remoteTarget.sidebarTabDisabled') : undefined}
              >
                <Icon className="h-3.5 w-3.5" />
                {t(item.labelKey)}
              </Pill>
            );
          })}
        </PillBar>
      </div>
    </>
  );
}
