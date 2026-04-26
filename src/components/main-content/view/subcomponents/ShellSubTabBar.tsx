import { useTranslation } from 'react-i18next';
import { X, Plus } from 'lucide-react';

type ShellSubTabBarProps = {
  tabIds: string[];
  activeId: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onClose: (id: string) => void;
};

export default function ShellSubTabBar({ tabIds, activeId, onSelect, onAdd, onClose }: ShellSubTabBarProps) {
  const { t } = useTranslation('chat');

  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-border/60 bg-muted/30 px-2 py-1.5">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {tabIds.map((id, i) => {
          const isActive = id === activeId;
          return (
            <div
              key={id}
              className={`inline-flex max-w-[220px] items-center gap-0.5 rounded-md border text-xs font-medium ${
                isActive
                  ? 'border-border bg-background text-foreground shadow-sm'
                  : 'border-transparent bg-transparent text-muted-foreground'
              }`}
            >
              <button
                type="button"
                onClick={() => onSelect(id)}
                className="min-w-0 flex-1 truncate rounded-l-md px-2 py-1 text-left hover:bg-muted/50"
              >
                {t('shell.subTabs.label', { index: i + 1 })}
              </button>
              {tabIds.length > 1 ? (
                <button
                  type="button"
                  className="shrink-0 rounded-r-md p-1.5 text-muted-foreground opacity-80 hover:bg-destructive/15 hover:opacity-100"
                  onClick={() => onClose(id)}
                  title={t('shell.subTabs.closeTitle')}
                  aria-label={t('shell.subTabs.closeTitle')}
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        onClick={onAdd}
        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-dashed border-border/80 bg-background/50 px-2 py-1 text-xs text-muted-foreground hover:bg-muted/50"
        title={t('shell.subTabs.addTitle')}
      >
        <Plus className="h-3.5 w-3.5" />
        {t('shell.subTabs.add')}
      </button>
    </div>
  );
}
