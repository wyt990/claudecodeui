import { useCallback, useEffect, useState } from 'react';
import ReactDOM from 'react-dom';
import type { TFunction } from 'i18next';
import { Loader2, X } from 'lucide-react';
import { api } from '../../../../utils/api';
import { Button, Input } from '../../../../shared/view/ui';
import type { Project } from '../../../../types/app';

type Tpl = { id: number; name: string; kind: 'claude_md' | 'llm'; payload_json: string };

type Props = {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  serverId: number;
  project: Project;
  t: TFunction;
};

export default function ProjectClaudeMdRemoteModal({ open, onOpenChange, serverId, project, t }: Props) {
  const [mdTpls, setMdTpls] = useState<Tpl[]>([]);
  const [claudeBlock, setClaudeBlock] = useState('');
  const [mdTemplateId, setMdTemplateId] = useState<string>('');
  const [newMdTplName, setNewMdTplName] = useState('');
  const [loadBusy, setLoadBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const projectPath = (project.fullPath || project.path || '').trim();
  const display = project.displayName || project.name;

  const loadTemplates = useCallback(async () => {
    setLoadBusy(true);
    setErr(null);
    try {
      const mt = await api.remoteClaude.listTemplates('claude_md');
      if (mt.ok) {
        setMdTpls((await mt.json()) as Tpl[]);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'load failed');
    } finally {
      setLoadBusy(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      void loadTemplates();
      setMsg(null);
    }
  }, [open, loadTemplates]);

  if (!open) {
    return null;
  }

  const onSaveMdAsTemplate = async () => {
    if (!newMdTplName.trim() || !claudeBlock.trim()) {
      setErr(t('sshServers.mdTemplateNameBody'));
      return;
    }
    setSaveBusy(true);
    try {
      const res = await api.remoteClaude.createTemplate({
        name: newMdTplName.trim(),
        kind: 'claude_md',
        payload: { body: claudeBlock },
      });
      if (!res.ok) {
        setErr('create template failed');
        return;
      }
      setNewMdTplName('');
      setMsg(t('sshServers.templateSaved'));
      void loadTemplates();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'error');
    } finally {
      setSaveBusy(false);
    }
  };

  const onDeleteTemplate = async (id: number) => {
    if (!window.confirm(t('sshServers.confirmDeleteTemplate'))) {
      return;
    }
    const res = await api.remoteClaude.deleteTemplate(id);
    if (res.ok) {
      void loadTemplates();
    }
  };

  const onApplyClaudeMd = async () => {
    if (!projectPath.startsWith('/')) {
      setErr(t('projects.openRemotePathMustAbsolute'));
      return;
    }
    setApplyBusy(true);
    setErr(null);
    try {
      const tid = mdTemplateId ? parseInt(mdTemplateId, 10) : undefined;
      const res = await api.remoteClaude.applyClaudeMd(serverId, {
        projectPath,
        templateId: tid,
        blockText: claudeBlock && !tid ? claudeBlock : undefined,
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setErr(j.error || 'apply claude.md failed');
        return;
      }
      setMsg(t('sshServers.claudeMdApplyOk'));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'error');
    } finally {
      setApplyBusy(false);
    }
  };

  return ReactDOM.createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-2 backdrop-blur-sm md:p-4"
      onMouseDown={() => onOpenChange(false)}
      role="presentation"
    >
      <div
        className="flex max-h-[min(92vh,640px)] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-claude-md-title"
      >
        <div className="shrink-0 flex items-center justify-between border-b border-border bg-muted/30 px-4 py-2.5">
          <div className="min-w-0">
            <h2 id="project-claude-md-title" className="truncate text-sm font-semibold text-foreground">
              {t('projects.claudeMdRemoteTitle', { name: display })}
            </h2>
            <p className="text-[10px] text-muted-foreground">{t('projects.claudeMdRemotePathHint')}</p>
            <p className="mt-0.5 truncate font-mono text-[10px] text-foreground/80" title={projectPath}>
              {projectPath || '—'}
            </p>
          </div>
          <button
            type="button"
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted"
            onClick={() => onOpenChange(false)}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {loadBusy ? (
          <div className="flex min-h-0 flex-1 items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 md:p-4 [scrollbar-gutter:stable]">
            <div className="space-y-3 pr-1">
              <p className="text-[10px] text-muted-foreground">{t('projects.claudeMdRemoteBody')}</p>
              <textarea
                className="min-h-[120px] w-full rounded border border-border bg-background px-2 py-1.5 text-xs"
                value={claudeBlock}
                onChange={(e) => setClaudeBlock(e.target.value)}
                placeholder="Markdown…"
              />
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] text-muted-foreground">{t('sshServers.orUseTemplate')}</span>
                <select
                  className="h-8 max-w flex-1 rounded border border-border bg-background px-2 text-xs"
                  value={mdTemplateId}
                  onChange={(e) => setMdTemplateId(e.target.value)}
                >
                  <option value="">{t('sshServers.pickMdTemplate')}</option>
                  {mdTpls.map((x) => (
                    <option key={x.id} value={String(x.id)}>
                      {x.name}
                    </option>
                  ))}
                </select>
                <Button type="button" size="sm" disabled={applyBusy} onClick={() => void onApplyClaudeMd()}>
                  {applyBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t('sshServers.applyClaudeMdRemote')}
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  className="h-8 max-w-xs text-xs"
                  value={newMdTplName}
                  onChange={(e) => setNewMdTplName(e.target.value)}
                  placeholder={t('sshServers.newTemplateName')}
                />
                <Button type="button" size="sm" variant="outline" disabled={saveBusy} onClick={() => void onSaveMdAsTemplate()}>
                  {t('sshServers.saveBodyAsMdTemplate')}
                </Button>
              </div>
              {mdTpls.length > 0 && (
                <ul className="max-h-20 space-y-0.5 overflow-y-auto text-[10px] text-muted-foreground">
                  {mdTpls.map((x) => (
                    <li key={x.id} className="flex items-center justify-between gap-1">
                      <span className="truncate">{x.name}</span>
                      <button type="button" className="shrink-0 text-rose-600" onClick={() => void onDeleteTemplate(x.id)}>
                        {t('actions.delete')}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {err && <p className="text-sm text-destructive">{err}</p>}
              {msg && <p className="text-sm text-emerald-600 dark:text-emerald-400">{msg}</p>}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
