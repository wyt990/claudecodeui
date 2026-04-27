import { MessageSquare, Terminal, Folder, GitBranch, ClipboardCheck, type LucideIcon } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { Tooltip, PillBar, Pill } from '../../../../shared/view/ui';
import type { AppTab } from '../../../../types/app';
import { usePlugins } from '../../../../contexts/PluginsContext';
import PluginIcon from '../../../plugins/view/PluginIcon';

type MainContentTabSwitcherProps = {
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  shouldShowTasksTab: boolean;
  /** 远程工作区：仅开放已对 SSH 接线的 Tab；其余灰显 */
  isRemoteTarget: boolean;
};

type BuiltInTab = {
  kind: 'builtin';
  id: AppTab;
  labelKey: string;
  icon: LucideIcon;
};

type PluginTab = {
  kind: 'plugin';
  id: AppTab;
  label: string;
  pluginName: string;
  iconFile: string;
};

type TabDefinition = BuiltInTab | PluginTab;

const BASE_TABS: BuiltInTab[] = [
  { kind: 'builtin', id: 'chat',  labelKey: 'tabs.chat',  icon: MessageSquare },
  { kind: 'builtin', id: 'shell', labelKey: 'tabs.shell', icon: Terminal },
  { kind: 'builtin', id: 'files', labelKey: 'tabs.files', icon: Folder },
  { kind: 'builtin', id: 'git',   labelKey: 'tabs.git',   icon: GitBranch },
];

const TASKS_TAB: BuiltInTab = {
  kind: 'builtin',
  id: 'tasks',
  labelKey: 'tabs.tasks',
  icon: ClipboardCheck,
};

/** 远程下已接 API/WebSocket 的 Tab；插件等仍灰显 */
const REMOTE_WORKSPACE_ALLOWED_TAB_IDS = new Set<AppTab>(['chat', 'preview', 'shell', 'files', 'git', 'tasks']);

function isTabBlockedByRemoteMode(tab: TabDefinition, isRemoteTarget: boolean): boolean {
  if (!isRemoteTarget) {
    return false;
  }
  if (tab.kind === 'plugin') {
    return true;
  }
  return !REMOTE_WORKSPACE_ALLOWED_TAB_IDS.has(tab.id);
}

function remoteTabBlockedTipKey(tab: TabDefinition): string {
  if (tab.kind === 'plugin') {
    return 'remoteTarget.tabBlockedPlugin';
  }
  if (tab.id === 'git') {
    return 'remoteTarget.tabBlockedGit';
  }
  if (tab.id === 'tasks') {
    return 'remoteTarget.tabBlockedTasks';
  }
  return 'remoteTarget.tabDisabled';
}

export default function MainContentTabSwitcher({
  activeTab,
  setActiveTab,
  shouldShowTasksTab,
  isRemoteTarget,
}: MainContentTabSwitcherProps) {
  const { t } = useTranslation();
  const { plugins } = usePlugins();

  const builtInTabs: BuiltInTab[] = shouldShowTasksTab ? [...BASE_TABS, TASKS_TAB] : BASE_TABS;

  const pluginTabs: PluginTab[] = plugins
    .filter((p) => p.enabled)
    .map((p) => ({
      kind: 'plugin',
      id: `plugin:${p.name}` as AppTab,
      label: p.displayName,
      pluginName: p.name,
      iconFile: p.icon,
    }));

  const tabs: TabDefinition[] = [...builtInTabs, ...pluginTabs];

  return (
    <PillBar>
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        const displayLabel = tab.kind === 'builtin' ? t(tab.labelKey) : tab.label;
        const blocked = isTabBlockedByRemoteMode(tab, isRemoteTarget);
        const tip = blocked ? `${displayLabel} — ${t(remoteTabBlockedTipKey(tab))}` : displayLabel;

        return (
          <Tooltip key={tab.id} content={tip} position="bottom">
            <Pill
              isActive={isActive}
              onClick={() => (blocked ? undefined : setActiveTab(tab.id))}
              disabled={blocked}
              className="px-2.5 py-[5px]"
            >
              {tab.kind === 'builtin' ? (
                <tab.icon className="h-3.5 w-3.5" strokeWidth={isActive ? 2.2 : 1.8} />
              ) : (
                <PluginIcon
                  pluginName={tab.pluginName}
                  iconFile={tab.iconFile}
                  className="flex h-3.5 w-3.5 items-center justify-center [&>svg]:h-full [&>svg]:w-full"
                />
              )}
              <span className="hidden lg:inline">{displayLabel}</span>
            </Pill>
          </Tooltip>
        );
      })}
    </PillBar>
  );
}
