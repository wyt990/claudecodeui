import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../../utils/api';

type ClaudeShellBinaryPayload = {
  command: string | null;
  claudeAvailable: boolean;
  claudecodeAvailable: boolean;
  resolutionOrder: string[];
  chatUses: string;
};

export default function ClaudeShellBinaryBadge() {
  const { t } = useTranslation('chat');
  const [info, setInfo] = useState<ClaudeShellBinaryPayload | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.claudeCliShellBinary();
        if (!res.ok || cancelled) {
          return;
        }
        const data = (await res.json()) as ClaudeShellBinaryPayload;
        if (!cancelled) {
          setInfo(data);
        }
      } catch {
        // ignore network errors
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const command = info?.command ?? null;

  return (
    <span
      className="inline-flex max-w-[11rem] truncate rounded-md border border-border/50 bg-muted/30 px-2 py-1 text-[11px] text-muted-foreground sm:max-w-none sm:text-xs"
      title={t('claudeCli.shellBinaryTitle')}
    >
      {command ? t('claudeCli.shellBinaryBadge', { command }) : t('claudeCli.shellBinaryNone')}
    </span>
  );
}
