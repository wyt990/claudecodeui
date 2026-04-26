import { Server } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type RemoteTargetWorkspacePlaceholderProps = {
  serverLabel: string;
};

/**
 * 远程 `currentTarget` 且已选本机项目时的占位：主区多 Tab 在 P0 不执行远端逻辑，仅提示，避免与本地工作区混用。
 */
export default function RemoteTargetWorkspacePlaceholder({ serverLabel }: RemoteTargetWorkspacePlaceholderProps) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-muted/50">
        <Server className="h-7 w-7 text-muted-foreground" />
      </div>
      <h2 className="text-base font-semibold text-foreground">{t('remoteTarget.mainWorkspaceTitle', { name: serverLabel })}</h2>
      <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
        {t('remoteTarget.mainWorkspaceBody')}
      </p>
    </div>
  );
}
