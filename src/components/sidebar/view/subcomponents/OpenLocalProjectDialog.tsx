import { useCallback, useEffect, useState } from 'react';
import ReactDOM from 'react-dom';
import type { TFunction } from 'i18next';
import { ChevronUp, Folder, Loader2, X } from 'lucide-react';
import { api } from '../../../../utils/api';
import { Button, Input } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';

type BrowseEntry = { name: string; isDirectory: boolean };
type BrowsePayload = { path: string; parent: string | null; entries: BrowseEntry[] };

type OpenLocalProjectDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  t: TFunction;
};

export default function OpenLocalProjectDialog({
  open,
  onOpenChange,
  onSuccess,
  t,
}: OpenLocalProjectDialogProps) {
  const [pathInput, setPathInput] = useState('');
  const [browse, setBrowse] = useState<BrowsePayload | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [openLoading, setOpenLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadBrowse = useCallback(
    async (p?: string | null) => {
      setBrowseLoading(true);
      setError(null);
      try {
        // api.browseFilesystem accepts string path or null/undefined for default
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await (api as any).browseFilesystem(p);
        const j = (await res.json().catch(() => ({}))) as BrowsePayload & { error?: string };
        if (!res.ok) {
          setError(j.error || t('projects.browseLoadError'));
          return;
        }
        setBrowse(j);
        setPathInput(j.path);
      } catch (e) {
        setError(e instanceof Error ? e.message : t('projects.browseLoadError'));
      } finally {
        setBrowseLoading(false);
      }
    },
    [t],
  );

  useEffect(() => {
    if (open) {
      setError(null);
      setBrowse(null);
      setPathInput('');
      void loadBrowse();
    }
  }, [open, loadBrowse]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onOpenChange(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  const onGo = () => {
    const tPath = pathInput.trim();
    if (!tPath) {
      setError(t('projects.openLocalPathRequired'));
      return;
    }
    void loadBrowse(tPath);
  };

  const onOpenHere = async () => {
    const cwd = (browse && browse.path) || pathInput.trim();
    if (!cwd) {
      setError(t('projects.openLocalPathRequired'));
      return;
    }
    setOpenLoading(true);
    setError(null);
    try {
      // 使用 createProject API 添加现有路径作为项目
      const res = await api.createProject(cwd);
      const j = (await res.json().catch(() => ({}))) as { error?: string; project?: unknown };
      if (!res.ok) {
        setError(j.error || t('projects.openLocalFailed'));
        return;
      }
      onOpenChange(false);
      onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('projects.openLocalFailed'));
    } finally {
      setOpenLoading(false);
    }
  };

  if (!open) {
    return null;
  }

  return ReactDOM.createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onMouseDown={() => onOpenChange(false)}
      role="presentation"
    >
      <div
        className="max-h-[min(90vh,560px)] w-full max-w-lg overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="open-local-project-title"
      >
        <div className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
          <h2 id="open-local-project-title" className="text-base font-semibold text-foreground">
            {t('projects.openLocalPathDialogTitle')}
          </h2>
          <button
            type="button"
            className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={() => onOpenChange(false)}
            aria-label={t('actions.cancel')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3 p-4">
          <p className="text-xs text-muted-foreground leading-relaxed">{t('projects.openLocalPathDialogHint')}</p>
          <div className="flex gap-2">
            <Input
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  onGo();
                }
              }}
              placeholder={t('projects.openLocalPathPlaceholder')}
              className="font-mono text-xs"
              autoComplete="off"
            />
            <Button type="button" variant="secondary" onClick={onGo} disabled={browseLoading}>
              {t('projects.openLocalPathGo')}
            </Button>
          </div>
          {browse && (
            <div className="flex items-center justify-between gap-2">
              <p className="min-w-0 flex-1 truncate font-mono text-xs text-foreground" title={browse.path}>
                {browse.path}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 shrink-0"
                onClick={() => {
                  if (browse?.parent) {
                    void loadBrowse(browse.parent);
                  }
                }}
                disabled={browseLoading || !browse || browse.parent == null}
                title={t('projects.openLocalUp')}
              >
                <ChevronUp className="h-4 w-4" />
              </Button>
            </div>
          )}
          <div
            className={cn(
              'max-h-[220px] overflow-y-auto rounded-md border border-border/80 bg-muted/20',
              browseLoading && 'opacity-60',
            )}
          >
            {browseLoading && (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('projects.browseLoading')}
              </div>
            )}
            {!browseLoading && browse && browse.entries.length === 0 && (
              <p className="p-3 text-center text-sm text-muted-foreground">{t('projects.browseEmpty')}</p>
            )}
            {!browseLoading && browse && browse.entries.length > 0 && (
              <ul className="divide-y divide-border/50">
                {browse.entries.map((e) => (
                  <li key={e.name}>
                    {e.isDirectory ? (
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent/60"
                        onClick={() => void loadBrowse(browse.path ? `${browse.path}/${e.name}` : e.name)}
                      >
                        <Folder className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
                        <span className="min-w-0 flex-1 truncate font-mono text-xs">{e.name}</span>
                      </button>
                    ) : (
                      <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground/70">
                        <span className="ml-1 min-w-0 flex-1 truncate font-mono">{e.name}</span>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <div className="flex gap-3 border-t border-border bg-muted/20 px-4 py-3">
          <Button type="button" variant="outline" className="flex-1" onClick={() => onOpenChange(false)}>
            {t('actions.cancel')}
          </Button>
          <Button
            type="button"
            className="flex-1"
            onClick={() => void onOpenHere()}
            disabled={openLoading || browseLoading}
          >
            {openLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : t('projects.openLocalOpenHere')}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}