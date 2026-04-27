import { useCallback, useEffect, useState } from 'react';
import ReactDOM from 'react-dom';
import type { TFunction } from 'i18next';
import { ChevronDown, ChevronRight, Loader2, X } from 'lucide-react';
import { api } from '../../../../utils/api';
import { Button, Input } from '../../../../shared/view/ui';

type Row = {
  id: number;
  channelId: string;
  baseUrl: string;
  models: string;
  hasApiKey: boolean;
  createdAt?: string;
  updatedAt?: string;
};

type Prefs = {
  selectedEntryIds: number[];
  openaiCompat: boolean;
  zenFreeModels: boolean;
  isSandbox: boolean;
  remoteAllowedTools: string[];
};

type PickerModel = { id: string; label: string };

type LogLine = {
  step: string;
  command: string;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  ok: boolean;
};

type TabId = 'model' | 'system';

type Props = {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  serverId: number;
  serverName: string;
  vaultConfigured: boolean;
  t: TFunction;
  /** 从聊天「打开设置」跳转时设为 system */
  initialTab?: 'model' | 'system';
};

export default function RemoteClaudeProviderSettingsModal({
  open,
  onOpenChange,
  serverId,
  serverName,
  vaultConfigured,
  t,
  initialTab = 'model',
}: Props) {
  const [activeTab, setActiveTab] = useState<TabId>('model');
  const [rows, setRows] = useState<Row[]>([]);
  const [loadBusy, setLoadBusy] = useState(false);
  const [prefs, setPrefs] = useState<Prefs>({
    selectedEntryIds: [],
    openaiCompat: true,
    zenFreeModels: false,
    isSandbox: false,
    remoteAllowedTools: [],
  });
  const [applyModelBusy, setApplyModelBusy] = useState(false);
  const [applySystemBusy, setApplySystemBusy] = useState(false);
  const [toolDraft, setToolDraft] = useState('');
  const [lastLog, setLastLog] = useState<LogLine[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [formCh, setFormCh] = useState('');
  const [formBase, setFormBase] = useState('');
  const [formModels, setFormModels] = useState('');
  const [formKey, setFormKey] = useState('');
  const [saveBusy, setSaveBusy] = useState(false);
  /** 添加/编辑表单默认收起，避免遮挡表格阅读 */
  const [formPanelOpen, setFormPanelOpen] = useState(false);

  const [rmModels, setRmModels] = useState<PickerModel[]>([]);
  const [listParseInfo, setListParseInfo] = useState<string | null>(null);
  const [rmDefaultId, setRmDefaultId] = useState<string | null>(null);
  const [listModelsBusy, setListModelsBusy] = useState(false);
  const [setDefId, setSetDefId] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoadBusy(true);
    setErr(null);
    try {
      const [cr, pr] = await Promise.all([api.remoteClaude.listClaudeProviders(), api.sshServers.getClaudeProviderPrefs(serverId)]);
      if (cr.ok) {
        setRows((await cr.json()) as Row[]);
      }
      if (pr.ok) {
        const p = (await pr.json()) as Partial<Prefs> & { remoteAllowedTools?: string[] };
        setPrefs({
          selectedEntryIds: Array.isArray(p.selectedEntryIds) ? p.selectedEntryIds : [],
          openaiCompat: p.openaiCompat !== false,
          zenFreeModels: Boolean(p.zenFreeModels),
          isSandbox: Boolean(p.isSandbox),
          remoteAllowedTools: Array.isArray(p.remoteAllowedTools)
            ? p.remoteAllowedTools.map((x) => String(x).trim()).filter(Boolean)
            : [],
        });
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'load failed');
    } finally {
      setLoadBusy(false);
    }
  }, [serverId]);

  useEffect(() => {
    if (open) {
      void loadAll();
      setMsg(null);
      setLastLog(null);
      setFormCh('');
      setFormBase('');
      setFormModels('');
      setFormKey('');
      setEditingId(null);
      setFormPanelOpen(false);
      setRmModels([]);
      setListParseInfo(null);
      setRmDefaultId(null);
      setActiveTab(initialTab === 'system' ? 'system' : 'model');
      setToolDraft('');
    }
  }, [open, loadAll, initialTab]);

  const fetchRemoteModels = useCallback(async () => {
    if (!vaultConfigured) {
      return;
    }
    setListModelsBusy(true);
    setListParseInfo(null);
    setErr(null);
    try {
      const res = await api.sshServers.claudeListModels(serverId);
      const j = (await res.json().catch(() => ({}))) as {
        models?: PickerModel[];
        defaultModelId?: string | null;
        parseError?: string | null;
        error?: string;
      };
      if (!res.ok) {
        setErr(j.error || t('sshServers.claudeListModelsErr'));
        setRmModels([]);
        setRmDefaultId(null);
        return;
      }
      setRmModels(Array.isArray(j.models) ? j.models : []);
      setRmDefaultId((j.defaultModelId && String(j.defaultModelId)) || null);
      setListParseInfo(j.parseError && String(j.parseError).trim() ? j.parseError : null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'list-models failed');
      setRmModels([]);
    } finally {
      setListModelsBusy(false);
    }
  }, [serverId, t, vaultConfigured]);

  const onSetRemoteDefault = useCallback(
    async (modelId: string) => {
      if (!vaultConfigured) {
        return;
      }
      setSetDefId(modelId);
      setErr(null);
      try {
        const res = await api.sshServers.claudeSetDefaultModel(serverId, { modelId });
        const j = (await res.json().catch(() => ({}))) as { error?: string; log?: LogLine[]; ok?: boolean };
        if (!res.ok) {
          if (j.log && j.log.length) {
            setLastLog(j.log);
          }
          setErr(j.error || t('sshServers.claudeSetDefaultErr'));
          return;
        }
        if (j.log) {
          setLastLog(j.log);
        }
        setMsg(t('sshServers.claudeSetDefaultOk', { id: modelId }));
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'set-default failed');
      } finally {
        setSetDefId(null);
      }
    },
    [serverId, t, vaultConfigured],
  );

  if (!open) {
    return null;
  }

  const isSelected = (id: number) => prefs.selectedEntryIds.includes(id);

  const toggleSel = (id: number) => {
    setPrefs((p) => {
      const s = new Set(p.selectedEntryIds);
      if (s.has(id)) {
        s.delete(id);
      } else {
        s.add(id);
      }
      return { ...p, selectedEntryIds: [...s] };
    });
  };

  const startEdit = (r: Row) => {
    setEditingId(r.id);
    setFormCh(r.channelId);
    setFormBase(r.baseUrl);
    setFormModels(r.models);
    setFormKey('');
    setFormPanelOpen(true);
  };

  const collapseAndClearForm = () => {
    setEditingId(null);
    setFormCh('');
    setFormBase('');
    setFormModels('');
    setFormKey('');
    setFormPanelOpen(false);
  };

  const onSaveForm = async () => {
    setSaveBusy(true);
    setErr(null);
    try {
      if (editingId != null) {
        const res = await api.remoteClaude.updateClaudeProvider(editingId, {
          channelId: formCh,
          baseUrl: formBase,
          models: formModels,
          apiKey: formKey,
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
          setErr(j.error || 'update failed');
          return;
        }
        setMsg(t('sshServers.claudeProviderSaveOk'));
        setEditingId(null);
        setFormCh('');
        setFormBase('');
        setFormModels('');
        setFormKey('');
        setFormPanelOpen(false);
      } else {
        if (!formKey.trim()) {
          setErr(t('sshServers.claudeProviderKeyRequired'));
          return;
        }
        const res = await api.remoteClaude.createClaudeProvider({
          channelId: formCh,
          baseUrl: formBase,
          models: formModels,
          apiKey: formKey,
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
          setErr(j.error || 'create failed');
          return;
        }
        setMsg(t('sshServers.claudeProviderSaveOk'));
        setFormCh('');
        setFormBase('');
        setFormModels('');
        setFormKey('');
        setFormPanelOpen(false);
      }
      void loadAll();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'error');
    } finally {
      setSaveBusy(false);
    }
  };

  const onDelete = async (id: number) => {
    if (!window.confirm(t('sshServers.claudeProviderConfirmDelete'))) {
      return;
    }
    setErr(null);
    const res = await api.remoteClaude.deleteClaudeProvider(id);
    if (res.ok) {
      setPrefs((p) => ({ ...p, selectedEntryIds: p.selectedEntryIds.filter((x) => x !== id) }));
      void loadAll();
    } else {
      setErr('delete failed');
    }
  };

  const onApplyModel = async () => {
    setApplyModelBusy(true);
    setErr(null);
    setMsg(null);
    setLastLog(null);
    try {
      const res = await api.sshServers.applyClaudeProviders(serverId, {
        scope: 'model',
        selectedEntryIds: prefs.selectedEntryIds,
        openaiCompat: prefs.openaiCompat,
        zenFreeModels: prefs.zenFreeModels,
        runEnvExport: true,
        persist: true,
      });
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        log?: LogLine[];
        message?: string;
        ok?: boolean;
      };
      if (!res.ok) {
        if (j.log && j.log.length) {
          setLastLog(j.log);
        }
        setErr(j.error || t('sshServers.claudeProviderApplyErr'));
        return;
      }
      if (j.log) {
        setLastLog(j.log);
      }
      setMsg(t('sshServers.claudeProviderApplyOk'));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'error');
    } finally {
      setApplyModelBusy(false);
    }
  };

  const addToolEntry = () => {
    const s = toolDraft.trim();
    if (!s) {
      return;
    }
    setPrefs((p) => {
      if (p.remoteAllowedTools.includes(s)) {
        return p;
      }
      return { ...p, remoteAllowedTools: [...p.remoteAllowedTools, s] };
    });
    setToolDraft('');
  };

  const removeToolEntry = (entry: string) => {
    setPrefs((p) => ({ ...p, remoteAllowedTools: p.remoteAllowedTools.filter((x) => x !== entry) }));
  };

  const onApplySystem = async () => {
    setApplySystemBusy(true);
    setErr(null);
    setMsg(null);
    setLastLog(null);
    try {
      const res = await api.sshServers.applyClaudeProviders(serverId, {
        scope: 'system',
        isSandbox: prefs.isSandbox,
        remoteAllowedTools: prefs.remoteAllowedTools,
        runEnvExport: true,
        persist: true,
      });
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        log?: LogLine[];
        message?: string;
        ok?: boolean;
      };
      if (!res.ok) {
        if (j.log && j.log.length) {
          setLastLog(j.log);
        }
        setErr(j.error || t('sshServers.claudeProviderApplySystemErr'));
        return;
      }
      if (j.log) {
        setLastLog(j.log);
      }
      setMsg(t('sshServers.claudeProviderApplySystemOk'));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'error');
    } finally {
      setApplySystemBusy(false);
    }
  };

  return ReactDOM.createPortal(
    <div
      className="fixed inset-0 z-[220] flex items-center justify-center bg-black/60 p-2 backdrop-blur-sm md:p-4"
      onMouseDown={() => onOpenChange(false)}
      role="presentation"
    >
      <div
        className="flex max-h-[min(92vh,720px)] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="rccp-title"
      >
        <div className="shrink-0 flex items-center justify-between border-b border-border bg-muted/30 px-4 py-2.5">
          <div className="min-w-0">
            <h2 id="rccp-title" className="truncate text-sm font-semibold text-foreground">
              {t('sshServers.claudeProviderModalTitle', { name: serverName })}
            </h2>
            <p className="text-[10px] text-muted-foreground">{t('sshServers.claudeProviderModalHint')}</p>
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
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="shrink-0 flex gap-1 border-b border-border bg-muted/20 px-2 pt-2">
              <button
                type="button"
                className={`rounded-t-md px-3 py-1.5 text-[11px] font-medium ${
                  activeTab === 'model' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
                onClick={() => setActiveTab('model')}
              >
                {t('sshServers.claudeProviderTabModel')}
              </button>
              <button
                type="button"
                className={`rounded-t-md px-3 py-1.5 text-[11px] font-medium ${
                  activeTab === 'system' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
                onClick={() => setActiveTab('system')}
              >
                {t('sshServers.claudeProviderTabSystem')}
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 md:p-4 [scrollbar-gutter:stable]">
              <div className="space-y-3 pr-1 text-xs">
                {activeTab === 'model' && (
                  <>
              <div className="space-y-2">
                <div className="text-[10px] font-medium text-foreground/90">{t('sshServers.claudeProviderCatalog')}</div>
                <p className="text-[10px] text-muted-foreground">{t('sshServers.claudeProviderCatalogHint')}</p>
                <div className="overflow-x-auto rounded border border-border">
                  <table className="w-full min-w-[400px] border-collapse text-left text-[10px]">
                    <thead>
                      <tr className="border-b border-border bg-muted/40">
                        <th className="p-1.5 font-medium" />
                        <th className="p-1.5 font-medium">{t('sshServers.claudeProviderColId')}</th>
                        <th className="p-1.5 font-medium">{t('sshServers.claudeProviderColBase')}</th>
                        <th className="p-1.5 font-medium">{t('sshServers.claudeProviderColModels')}</th>
                        <th className="p-1.5 font-medium">Key</th>
                        <th className="p-1.5" />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.id} className="border-b border-border/60">
                          <td className="p-1">
                            <input
                              type="checkbox"
                              checked={isSelected(r.id)}
                              onChange={() => toggleSel(r.id)}
                              aria-label={r.channelId}
                            />
                          </td>
                          <td className="p-1 font-mono text-[9px]">{r.channelId}</td>
                          <td className="p-1 break-all text-[9px]">{r.baseUrl}</td>
                          <td className="p-1 font-mono text-[9px]">{r.models}</td>
                          <td className="p-1 text-[9px]">{r.hasApiKey ? '****' : '—'}</td>
                          <td className="p-1 text-right">
                            <button
                              type="button"
                              className="text-primary underline-offset-2 hover:underline"
                              onClick={() => startEdit(r)}
                            >
                              {t('sshServers.claudeProviderEdit')}
                            </button>
                            <button
                              type="button"
                              className="ml-1.5 text-rose-600"
                              onClick={() => void onDelete(r.id)}
                            >
                              {t('actions.delete')}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="rounded border border-dashed border-border/80">
                <button
                  type="button"
                  className="flex w-full items-start gap-2 rounded-t-lg p-2.5 text-left hover:bg-muted/40"
                  aria-expanded={formPanelOpen}
                  aria-controls="rccp-provider-form"
                  onClick={() => setFormPanelOpen((o) => !o)}
                >
                  <span className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden>
                    {formPanelOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[10px] font-medium text-foreground/90">
                      {editingId == null ? t('sshServers.claudeProviderAddNew') : t('sshServers.claudeProviderEditForm')}
                    </span>
                    {!formPanelOpen && (
                      <span className="mt-0.5 block text-[9px] text-muted-foreground">{t('sshServers.claudeProviderFormClickToExpand')}</span>
                    )}
                  </span>
                </button>
                {formPanelOpen && (
                  <div id="rccp-provider-form" className="border-t border-border/60 px-2.5 pb-2.5 pt-1">
                    <p className="mb-1.5 text-[9px] text-amber-700/90 dark:text-amber-200/80">
                      {!vaultConfigured && t('sshServers.claudeInstallNeedSecrets')}{' '}
                    </p>
                    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                      <div>
                        <div className="text-[9px] text-muted-foreground">{t('sshServers.claudeProviderColId')}</div>
                        <Input
                          className="h-8 text-[11px] font-mono"
                          value={formCh}
                          onChange={(e) => setFormCh(e.target.value)}
                          disabled={!vaultConfigured}
                          placeholder="oneapi"
                        />
                      </div>
                      <div>
                        <div className="text-[9px] text-muted-foreground">{t('sshServers.claudeProviderColBase')}</div>
                        <Input
                          className="h-8 text-[11px] font-mono"
                          value={formBase}
                          onChange={(e) => setFormBase(e.target.value)}
                          disabled={!vaultConfigured}
                          placeholder="https://..."
                        />
                      </div>
                      <div className="sm:col-span-2">
                        <div className="text-[9px] text-muted-foreground">{t('sshServers.claudeProviderColModels')}</div>
                        <Input
                          className="h-8 text-[11px] font-mono"
                          value={formModels}
                          onChange={(e) => setFormModels(e.target.value)}
                          disabled={!vaultConfigured}
                          placeholder="a,b"
                        />
                      </div>
                      <div className="sm:col-span-2">
                        <div className="text-[9px] text-muted-foreground">{t('sshServers.claudeProviderApiKey')}</div>
                        <Input
                          className="h-8 text-[11px] font-mono"
                          type="password"
                          autoComplete="off"
                          value={formKey}
                          onChange={(e) => setFormKey(e.target.value)}
                          disabled={!vaultConfigured}
                          placeholder={editingId != null ? t('sshServers.claudeProviderKeyOptional') : ''}
                        />
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <Button
                        type="button"
                        size="sm"
                        className="h-7 text-[10px]"
                        disabled={!vaultConfigured || saveBusy}
                        onClick={() => void onSaveForm()}
                      >
                        {saveBusy ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : editingId != null ? (
                          t('actions.save')
                        ) : (
                          t('sshServers.claudeProviderAddBtn')
                        )}
                      </Button>
                      {editingId != null && (
                        <Button type="button" size="sm" variant="ghost" className="h-7 text-[10px]" onClick={collapseAndClearForm}>
                          {t('actions.cancel')}
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div className="rounded border border-border/70 bg-muted/20 p-2.5">
                <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-[10px] font-medium text-foreground/90">{t('sshServers.claudeRemoteListModelsTitle')}</div>
                    <p className="text-[9px] text-muted-foreground">{t('sshServers.claudeRemoteListModelsHint')}</p>
                    {rmDefaultId && <p className="mt-0.5 text-[9px] font-mono text-foreground/80">→ {t('sshServers.claudeListResolvedDefault', { id: rmDefaultId })}</p>}
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="h-7 text-[10px] shrink-0"
                    disabled={!vaultConfigured || listModelsBusy}
                    onClick={() => void fetchRemoteModels()}
                  >
                    {listModelsBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : t('sshServers.claudeListModelsButton')}
                  </Button>
                </div>
                {listParseInfo && (
                  <p className="mb-1.5 text-[9px] text-amber-800 dark:text-amber-200/90">{listParseInfo}</p>
                )}
                {rmModels.length === 0 && !listModelsBusy && (
                  <p className="text-[9px] text-muted-foreground">{t('sshServers.claudeListModelsEmpty')}</p>
                )}
                {rmModels.length > 0 && (
                  <div
                    className="max-h-40 overflow-y-auto rounded border border-border/60 bg-background/80 [scrollbar-gutter:stable]"
                    role="list"
                  >
                    {rmModels.map((m) => (
                      <div
                        key={m.id}
                        className="flex items-center justify-between gap-1 border-b border-border/30 px-2 py-1 text-[10px] last:border-b-0"
                        role="listitem"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-foreground/90" title={m.label}>
                            {m.label}
                          </div>
                          <div className="truncate font-mono text-[9px] text-muted-foreground" title={m.id}>
                            {m.id}
                          </div>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-6 shrink-0 px-1.5 text-[9px]"
                          disabled={!vaultConfigured || setDefId === m.id || m.id === '(default)'}
                          onClick={() => void onSetRemoteDefault(m.id)}
                        >
                          {setDefId === m.id ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : t('sshServers.claudeSetDefaultBtn')}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <label className="flex cursor-pointer items-start gap-2 text-[10px]">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={prefs.openaiCompat}
                  onChange={(e) => setPrefs((p) => ({ ...p, openaiCompat: e.target.checked }))}
                />
                <span>{t('sshServers.claudeProviderOpenaiCompat')}</span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 text-[10px]">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={prefs.zenFreeModels}
                  onChange={(e) => setPrefs((p) => ({ ...p, zenFreeModels: e.target.checked }))}
                />
                <span>{t('sshServers.claudeProviderZenFree')}</span>
              </label>

              <div className="border-t border-border/60 pt-2">
                <Button
                  type="button"
                  className="h-8 w-full sm:w-auto"
                  disabled={applyModelBusy || !vaultConfigured}
                  onClick={() => void onApplyModel()}
                >
                  {applyModelBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t('sshServers.claudeProviderApplyModel')}
                </Button>
              </div>
                  </>
                )}

                {activeTab === 'system' && (
                  <>
                    <p className="text-[10px] text-muted-foreground">{t('sshServers.claudeProviderSystemTabHint')}</p>
                    <label className="flex cursor-pointer items-start gap-2 text-[10px]">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={prefs.isSandbox}
                        onChange={(e) => setPrefs((p) => ({ ...p, isSandbox: e.target.checked }))}
                      />
                      <span>{t('sshServers.claudeProviderSandbox')}</span>
                    </label>

                    <div className="rounded border border-border/70 bg-muted/20 p-2.5">
                      <div className="text-[10px] font-medium text-foreground/90">{t('sshServers.claudeProviderRemoteToolsTitle')}</div>
                      <p className="mt-0.5 text-[9px] text-muted-foreground">{t('sshServers.claudeProviderRemoteToolsHint')}</p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <Input
                          className="h-8 min-w-[140px] flex-1 text-[11px] font-mono"
                          value={toolDraft}
                          onChange={(e) => setToolDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              addToolEntry();
                            }
                          }}
                          placeholder={t('sshServers.claudeProviderToolPlaceholder')}
                          disabled={!vaultConfigured}
                        />
                        <Button type="button" size="sm" variant="secondary" className="h-8 text-[10px]" disabled={!vaultConfigured} onClick={addToolEntry}>
                          {t('sshServers.claudeProviderToolAdd')}
                        </Button>
                      </div>
                      {prefs.remoteAllowedTools.length === 0 ? (
                        <p className="mt-2 text-[9px] text-muted-foreground">{t('sshServers.claudeProviderRemoteToolsEmpty')}</p>
                      ) : (
                        <ul className="mt-2 max-h-36 space-y-1 overflow-y-auto rounded border border-border/50 bg-background/80 p-1.5 [scrollbar-gutter:stable]">
                          {prefs.remoteAllowedTools.map((entry) => (
                            <li
                              key={entry}
                              className="flex items-center justify-between gap-2 rounded px-1.5 py-0.5 font-mono text-[10px] text-foreground/90"
                            >
                              <span className="min-w-0 truncate" title={entry}>
                                {entry}
                              </span>
                              <button type="button" className="shrink-0 text-rose-600 hover:underline" onClick={() => removeToolEntry(entry)}>
                                {t('actions.delete')}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    <div className="border-t border-border/60 pt-2">
                      <Button
                        type="button"
                        className="h-8 w-full sm:w-auto"
                        disabled={applySystemBusy || !vaultConfigured}
                        onClick={() => void onApplySystem()}
                      >
                        {applySystemBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t('sshServers.claudeProviderApplySystem')}
                      </Button>
                    </div>
                  </>
                )}

              {err && <p className="text-sm text-destructive">{err}</p>}
              {msg && <p className="text-sm text-emerald-600 dark:text-emerald-400">{msg}</p>}

              {lastLog && lastLog.length > 0 && (
                <div>
                  <div className="mb-1 text-[10px] font-medium text-foreground/90">{t('sshServers.claudeProviderLog')}</div>
                  <pre className="max-h-48 overflow-auto rounded border border-border/80 bg-muted/30 p-2 text-[9px] leading-tight text-muted-foreground [scrollbar-gutter:stable]">
                    {lastLog
                      .map(
                        (l) =>
                          `== ${l.step} code=${l.code} ok=${l.ok} ==\n${l.command}\n${l.stdout || ''}\n${l.stderr || ''}`.trim(),
                      )
                      .join('\n\n')}
                  </pre>
                </div>
              )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
