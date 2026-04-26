import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  ChevronRight,
  Cloud,
  Download,
  Loader2,
  Monitor,
  Pencil,
  PlugZap,
  Plus,
  Server,
  Settings,
  Trash2,
} from 'lucide-react';
import { Button, Input, ScrollArea } from '../../../../shared/view/ui';
import { useEnvironment } from '../../../../contexts/EnvironmentContext';
import { api } from '../../../../utils/api';
import RemoteClaudeProviderSettingsModal from './RemoteClaudeProviderSettingsModal';
const SSH_TREE_EXPANDED_KEY = 'cloudcli-ssh-sidebar-tree-expanded-v1';

type SshServerRow = {
  id: number;
  group_id: number | null;
  group_name: string | null;
  display_name: string;
  host: string;
  port: number;
  username: string;
  auth_type: 'private_key' | 'password';
  host_key_fingerprint: string | null;
  last_connected_at: string | null;
  last_error: string | null;
  has_secrets: boolean;
};

type SshGroupRow = { id: number; name: string; sort_order: number };

type ClaudeProbeRes = {
  hasCli: boolean;
  installFamily: 'unix' | 'win';
  installBaseUrl: string;
  installCommands: { curl: string; wget: string; pwsh: string };
  claudecodePath: string | null;
  claudePath: string | null;
  platform: string;
  homeConfigHint: string;
  family: string;
};

export default function SidebarServersPanel({ t }: { t: TFunction }) {
  const { t: tCommon } = useTranslation('common');
  const { isRemote, currentTarget, setLocal, setRemote } = useEnvironment();
  const [loading, setLoading] = useState(true);
  const [vaultConfigured, setVaultConfigured] = useState(false);
  const [servers, setServers] = useState<SshServerRow[]>([]);
  const [groups, setGroups] = useState<SshGroupRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [testMessage, setTestMessage] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [username, setUsername] = useState('');
  const [authType, setAuthType] = useState<'private_key' | 'password'>('private_key');
  const [groupId, setGroupId] = useState<string>('');
  const [privateKey, setPrivateKey] = useState('');
  const [keyPassphrase, setKeyPassphrase] = useState('');
  const [password, setPassword] = useState('');

  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [savingGroup, setSavingGroup] = useState(false);

  const [expandedMap, setExpandedMap] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem(SSH_TREE_EXPANDED_KEY);
      if (raw) {
        return JSON.parse(raw) as Record<string, boolean>;
      }
    } catch {
      /* ignore */
    }
    return {};
  });

  const [editGroupId, setEditGroupId] = useState<number | null>(null);
  const [editGroupName, setEditGroupName] = useState('');
  const [savingEditGroup, setSavingEditGroup] = useState(false);
  const [busyGroupId, setBusyGroupId] = useState<number | null>(null);

  const [editServerId, setEditServerId] = useState<number | null>(null);
  const [savingServerEdit, setSavingServerEdit] = useState(false);
  const [edDisplayName, setEdDisplayName] = useState('');
  const [edHost, setEdHost] = useState('');
  const [edPort, setEdPort] = useState('22');
  const [edUsername, setEdUsername] = useState('');
  const [edAuthType, setEdAuthType] = useState<'private_key' | 'password'>('private_key');
  const [edGroupId, setEdGroupId] = useState<string>('');
  const [edPrivateKey, setEdPrivateKey] = useState('');
  const [edKeyPassphrase, setEdKeyPassphrase] = useState('');
  const [edPassword, setEdPassword] = useState('');

  const [claudeInstall, setClaudeInstall] = useState<{
    server: SshServerRow;
    probe: ClaudeProbeRes;
  } | null>(null);
  const [claudeMethod, setClaudeMethod] = useState<'curl' | 'wget' | 'pwsh'>('curl');
  const [claudeBaseOverride, setClaudeBaseOverride] = useState('');
  const [claudeCmdDraft, setClaudeCmdDraft] = useState('');
  const [claudeInstallBusy, setClaudeInstallBusy] = useState(false);
  const [claudeInstallLog, setClaudeInstallLog] = useState<string | null>(null);
  const [claudeProbingId, setClaudeProbingId] = useState<number | null>(null);
  const [claudeProviderServer, setClaudeProviderServer] = useState<SshServerRow | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(SSH_TREE_EXPANDED_KEY, JSON.stringify(expandedMap));
    } catch {
      /* ignore */
    }
  }, [expandedMap]);

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const [listRes, groupsRes] = await Promise.all([api.sshServers.list(), api.sshServers.listGroups()]);
      console.info('[ssh-servers/ui] load: list status=', listRes.status, 'groups status=', groupsRes.status);
      if (!listRes.ok) {
        const errText = await listRes.text().catch(() => '');
        console.warn('[ssh-servers/ui] load: list failed body=', errText.slice(0, 200));
        throw new Error(`HTTP ${listRes.status}`);
      }
      const data = (await listRes.json()) as { servers: SshServerRow[]; vaultConfigured: boolean };
      setServers(data.servers || []);
      setVaultConfigured(Boolean(data.vaultConfigured));
      if (groupsRes.ok) {
        const list = (await groupsRes.json()) as SshGroupRow[];
        setGroups(list);
        console.info(
          '[ssh-servers/ui] load: groups count=',
          list.length,
          'rows=',
          list.map((g) => ({ id: g.id, name: g.name })),
        );
      } else {
        setGroups([]);
        const errText = await groupsRes.text().catch(() => '');
        console.warn(
          '[ssh-servers/ui] load: GET /groups failed status=',
          groupsRes.status,
          'body=',
          errText.slice(0, 300),
        );
      }
    } catch (e) {
      console.error('[ssh-servers/ui] load error:', e);
      setError(e instanceof Error ? e.message : 'load failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submitNewGroup = async () => {
    setError(null);
    const name = newGroupName.trim();
    if (!name) {
      setError(t('sshServers.formRequiredShort'));
      return;
    }
    setSavingGroup(true);
    try {
      console.info('[ssh-servers/ui] createGroup: name=', name);
      const res = await api.sshServers.createGroup(name);
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        let j: { error?: string; code?: string } = {};
        try {
          j = JSON.parse(errBody) as { error?: string; code?: string };
        } catch {
          /* 非 JSON */
        }
        console.warn(
          '[ssh-servers/ui] createGroup failed status=',
          res.status,
          'body=',
          errBody.slice(0, 400),
          'parsed=',
          j,
        );
        setError(j.error || t('sshServers.groupCreateFailed'));
        return;
      }
      const created = (await res.json().catch(() => ({}))) as { id?: number; name?: string; sort_order?: number };
      console.info('[ssh-servers/ui] createGroup: success payload=', created);
      setGroupDialogOpen(false);
      setNewGroupName('');
      setTestMessage(t('sshServers.groupCreatedOk'));
      await load();
    } catch (e) {
      console.error('[ssh-servers/ui] createGroup: exception', e);
      setError(e instanceof Error ? e.message : t('sshServers.groupCreateFailed'));
    } finally {
      setSavingGroup(false);
    }
  };

  const handleCreateServer = async () => {
    setError(null);
    setTestMessage(null);
    if (!displayName.trim() || !host.trim() || !username.trim()) {
      setError(t('sshServers.formRequired'));
      return;
    }
    const p = parseInt(port, 10);
    if (!Number.isFinite(p) || p < 1 || p > 65535) {
      setError(t('sshServers.invalidPort'));
      return;
    }
    if (authType === 'private_key' && !privateKey.trim()) {
      setError(t('sshServers.privateKeyRequired'));
      return;
    }
    if (authType === 'password' && !password) {
      setError(t('sshServers.passwordRequired'));
      return;
    }
    try {
      const createRes = await api.sshServers.create({
        display_name: displayName.trim(),
        host: host.trim(),
        port: p,
        username: username.trim(),
        auth_type: authType,
        group_id: groupId ? parseInt(groupId, 10) : null,
      });
      if (!createRes.ok) {
        const j = await createRes.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error || `HTTP ${createRes.status}`);
      }
      const created = (await createRes.json()) as { id: number };
      const secretBody =
        authType === 'private_key'
          ? { privateKey: privateKey.trim(), privateKeyPassphrase: keyPassphrase || undefined }
          : { password };
      const secRes = await api.sshServers.setSecrets(created.id, secretBody);
      if (!secRes.ok) {
        const j = await secRes.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error || `Secrets HTTP ${secRes.status}`);
      }
      setFormOpen(false);
      setDisplayName('');
      setHost('');
      setPort('22');
      setUsername('');
      setPrivateKey('');
      setKeyPassphrase('');
      setPassword('');
      setTestMessage(t('sshServers.createdOk'));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'create failed');
    }
  };

  const handleTest = async (id: number) => {
    setBusyId(id);
    setTestMessage(null);
    setError(null);
    const meta = servers.find((s) => s.id === id);
    const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
    const url = `/api/ssh-servers/${id}/test`;
    console.info('[ssh-test/ui] 开始测试连接', { serverId: id, url, display: meta?.display_name, host: meta?.host, port: meta?.port });
    try {
      const res = await api.sshServers.test(id);
      const raw = await res.text();
      let j: {
        ok?: boolean;
        error?: string;
        code?: string;
        hostKeyFingerprintSha256?: string;
      } = {};
      try {
        j = raw ? (JSON.parse(raw) as typeof j) : {};
      } catch {
        console.warn('[ssh-test/ui] 响应非 JSON, raw=', raw.slice(0, 500));
      }
      const ms = typeof performance !== 'undefined' ? Math.round(performance.now() - t0) : undefined;
      if (!res.ok) {
        const detail = j.error || raw.slice(0, 300) || `HTTP ${res.status}`;
        const codePart = j.code ? ` [${j.code}]` : '';
        console.error('[ssh-test/ui] 测试失败', {
          serverId: id,
          httpStatus: res.status,
          ms,
          code: j.code,
          error: j.error,
          bodyPreview: raw.slice(0, 400),
        });
        throw new Error(`${detail}${codePart}`);
      }
      console.info('[ssh-test/ui] 测试成功', { serverId: id, ms, hostKeyFp: j.hostKeyFingerprintSha256 });
      setTestMessage(
        j.hostKeyFingerprintSha256
          ? t('sshServers.testOkWithFp', { fp: j.hostKeyFingerprintSha256 })
          : t('sshServers.testOk'),
      );
      await load();
      if (meta && meta.has_secrets && vaultConfigured) {
        void (async () => {
          try {
            const pr = await api.sshServers.claudeProbe(id);
            if (!pr.ok) return;
            const probeJson = (await pr.json()) as ClaudeProbeRes;
            if (probeJson.hasCli) {
              return;
            }
            setClaudeBaseOverride(probeJson.installBaseUrl);
            setClaudeMethod(probeJson.installFamily === 'win' ? 'pwsh' : 'curl');
            setClaudeCmdDraft(
              probeJson.installFamily === 'win'
                ? probeJson.installCommands.pwsh
                : probeJson.installCommands.curl,
            );
            setClaudeInstallLog(null);
            setClaudeInstall({ server: meta, probe: probeJson });
          } catch {
            /* 探测非阻塞 */
          }
        })();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'test failed';
      setError(msg);
      console.error('[ssh-test/ui] 异常', { serverId: id, message: msg, err: e });
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (id: number) => {
    if (!window.confirm(t('sshServers.confirmDelete'))) return;
    setBusyId(id);
    try {
      const res = await api.sshServers.delete(id);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'delete failed');
    } finally {
      setBusyId(null);
    }
  };

  const openEditServer = (s: SshServerRow) => {
    setError(null);
    setEditServerId(s.id);
    setEdDisplayName(s.display_name);
    setEdHost(s.host);
    setEdPort(String(s.port));
    setEdUsername(s.username);
    setEdAuthType(s.auth_type);
    setEdGroupId(s.group_id != null ? String(s.group_id) : '');
    setEdPrivateKey('');
    setEdKeyPassphrase('');
    setEdPassword('');
  };

  const closeEditServer = () => {
    if (savingServerEdit) return;
    setEditServerId(null);
  };

  const openClaudeSetup = async (s: SshServerRow) => {
    if (!s.has_secrets || !vaultConfigured) {
      setError(t('sshServers.claudeInstallNeedSecrets'));
      return;
    }
    setError(null);
    setClaudeInstallLog(null);
    setClaudeProbingId(s.id);
    try {
      const pr = await api.sshServers.claudeProbe(s.id);
      const raw = await pr.text();
      let j: ClaudeProbeRes & { error?: string } = {} as ClaudeProbeRes & { error?: string };
      try {
        j = raw ? (JSON.parse(raw) as typeof j) : ({} as typeof j);
      } catch {
        /* 非 JSON */
      }
      if (!pr.ok) {
        setError(j.error || t('sshServers.claudeProbeFailed'));
        return;
      }
      if (j.hasCli) {
        setTestMessage(
          t('sshServers.claudeAlreadyInstalled', { path: j.claudecodePath || j.claudePath || 'PATH' }),
        );
        return;
      }
      setClaudeBaseOverride(j.installBaseUrl);
      setClaudeMethod(j.installFamily === 'win' ? 'pwsh' : 'curl');
      setClaudeCmdDraft(
        j.installFamily === 'win' ? j.installCommands.pwsh : j.installCommands.curl,
      );
      setClaudeInstall({ server: s, probe: j });
    } finally {
      setClaudeProbingId(null);
    }
  };

  const runClaudeInstallAction = async () => {
    if (!claudeInstall) return;
    setError(null);
    setClaudeInstallLog(null);
    setClaudeInstallBusy(true);
    try {
      const cmdT = claudeCmdDraft.trim();
      const res = await api.sshServers.claudeInstall(claudeInstall.server.id, {
        method: claudeMethod,
        baseUrl: claudeBaseOverride.trim() || undefined,
        ...(cmdT ? { command: cmdT } : {}),
      });
      const raw = await res.text();
      let j: {
        ok?: boolean;
        skipped?: boolean;
        error?: string;
        stdout?: string;
        stderr?: string;
        afterProbe?: { hasCli?: boolean };
        message?: string;
      } = {};
      try {
        j = raw ? (JSON.parse(raw) as typeof j) : {};
      } catch {
        setClaudeInstallLog(raw.slice(0, 8000));
        setError(t('sshServers.claudeInstallFailed'));
        return;
      }
      if (j.skipped) {
        setTestMessage(j.message || t('sshServers.claudeInstallSkipped'));
        setClaudeInstall(null);
        return;
      }
      if (!res.ok) {
        setClaudeInstallLog([j.stdout, j.stderr].filter(Boolean).join('\n\n') || j.error || raw);
        setError(j.error || t('sshServers.claudeInstallFailed'));
        return;
      }
      if (j.ok) {
        const a = j.afterProbe;
        setClaudeInstallLog([j.stdout, j.stderr].filter(Boolean).join('\n\n') || null);
        if (a && a.hasCli) {
          setTestMessage(t('sshServers.claudeInstallDoneOk'));
        } else {
          setTestMessage(t('sshServers.claudeInstallExitOkButNotDetected'));
        }
        setClaudeInstall(null);
        await load();
        if (typeof window !== 'undefined' && window.refreshProjects) {
          void window.refreshProjects();
        }
        return;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('sshServers.claudeInstallFailed'));
    } finally {
      setClaudeInstallBusy(false);
    }
  };

  const submitServerEdit = async () => {
    if (editServerId == null) return;
    setError(null);
    setTestMessage(null);
    if (!edDisplayName.trim() || !edHost.trim() || !edUsername.trim()) {
      setError(t('sshServers.formRequired'));
      return;
    }
    const p = parseInt(edPort, 10);
    if (!Number.isFinite(p) || p < 1 || p > 65535) {
      setError(t('sshServers.invalidPort'));
      return;
    }
    const orig = servers.find((x) => x.id === editServerId);
    const authChanged = Boolean(orig && edAuthType !== orig.auth_type);
    if (authChanged) {
      if (edAuthType === 'private_key' && !edPrivateKey.trim()) {
        setError(t('sshServers.authTypeChangePrivateKeyRequired'));
        return;
      }
      if (edAuthType === 'password' && !edPassword) {
        setError(t('sshServers.authTypeChangePasswordRequired'));
        return;
      }
    }

    setSavingServerEdit(true);
    try {
      const patchRes = await api.sshServers.update(editServerId, {
        display_name: edDisplayName.trim(),
        host: edHost.trim(),
        port: p,
        username: edUsername.trim(),
        auth_type: edAuthType,
        group_id: edGroupId ? parseInt(edGroupId, 10) : null,
      });
      if (!patchRes.ok) {
        const j = await patchRes.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error || `HTTP ${patchRes.status}`);
      }
      if (authChanged) {
        const secretBody =
          edAuthType === 'private_key'
            ? { privateKey: edPrivateKey.trim(), privateKeyPassphrase: edKeyPassphrase || undefined }
            : { password: edPassword };
        const secRes = await api.sshServers.setSecrets(editServerId, secretBody);
        if (!secRes.ok) {
          const j = await secRes.json().catch(() => ({}));
          throw new Error((j as { error?: string }).error || `Secrets HTTP ${secRes.status}`);
        }
      } else {
        const needPk = edAuthType === 'private_key' && edPrivateKey.trim() !== '';
        const needPw = edAuthType === 'password' && edPassword;
        if (needPk) {
          const secRes = await api.sshServers.setSecrets(editServerId, {
            privateKey: edPrivateKey.trim(),
            privateKeyPassphrase: edKeyPassphrase || undefined,
          });
          if (!secRes.ok) {
            const j = await secRes.json().catch(() => ({}));
            throw new Error((j as { error?: string }).error || `Secrets HTTP ${secRes.status}`);
          }
        } else if (needPw) {
          const secRes = await api.sshServers.setSecrets(editServerId, { password: edPassword });
          if (!secRes.ok) {
            const j = await secRes.json().catch(() => ({}));
            throw new Error((j as { error?: string }).error || `Secrets HTTP ${secRes.status}`);
          }
        }
      }
      setTestMessage(t('sshServers.serverUpdatedOk'));
      setEditServerId(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'update failed');
    } finally {
      setSavingServerEdit(false);
    }
  };

  const submitEditGroup = async () => {
    if (editGroupId == null) return;
    setError(null);
    const name = editGroupName.trim();
    if (!name) {
      setError(t('sshServers.formRequiredShort'));
      return;
    }
    setSavingEditGroup(true);
    try {
      const res = await api.sshServers.updateGroup(editGroupId, { name });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        let j: { error?: string } = {};
        try {
          j = JSON.parse(errBody) as { error?: string };
        } catch {
          /* 非 JSON */
        }
        setError(j.error || t('sshServers.groupCreateFailed'));
        return;
      }
      setEditGroupId(null);
      setEditGroupName('');
      setTestMessage(t('sshServers.groupUpdatedOk'));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('sshServers.groupCreateFailed'));
    } finally {
      setSavingEditGroup(false);
    }
  };

  const handleDeleteGroup = async (g: SshGroupRow) => {
    if (!window.confirm(t('sshServers.confirmDeleteGroup'))) return;
    setBusyGroupId(g.id);
    setError(null);
    try {
      const res = await api.sshServers.deleteGroup(g.id);
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error || `HTTP ${res.status}`);
        return;
      }
      setTestMessage(t('sshServers.groupDeletedOk'));
      setExpandedMap((ex) => {
        const next = { ...ex };
        delete next[`g-${g.id}`];
        return next;
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'delete group failed');
    } finally {
      setBusyGroupId(null);
    }
  };

  const isNodeOpen = (key: string) => expandedMap[key] !== false;

  const toggleNode = (key: string) => {
    setExpandedMap((ex) => {
      const open = ex[key] !== false;
      return { ...ex, [key]: !open };
    });
  };

  const sortedGroups = useMemo(
    () => [...groups].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id),
    [groups],
  );

  const { byGroup, ungrouped } = useMemo(() => {
    const by: Record<number, SshServerRow[]> = {};
    for (const g of groups) {
      by[g.id] = [];
    }
    const un: SshServerRow[] = [];
    for (const s of servers) {
      if (s.group_id != null && Object.prototype.hasOwnProperty.call(by, s.group_id)) {
        by[s.group_id]!.push(s);
      } else {
        un.push(s);
      }
    }
    return { byGroup: by, ungrouped: un };
  }, [servers, groups]);

  const hasTreeContent = sortedGroups.length > 0 || servers.length > 0;

  const renderServerRow = (s: SshServerRow) => {
    const showUseRemote =
      !isRemote || currentTarget.kind !== 'remote' || currentTarget.serverId !== s.id;
    return (
      <li
        key={s.id}
        className="mt-1 rounded-lg border border-border/50 bg-card/40 px-2.5 py-2 text-xs"
      >
        <div className="min-w-0">
          <p className="truncate font-medium text-foreground">{s.display_name}</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {s.username}@{s.host}:{s.port}
          </p>
          {!s.has_secrets && (
            <p className="mt-1.5 text-[10px] text-amber-700 dark:text-amber-300">
              {t('sshServers.noSecrets')}
            </p>
          )}
          {s.last_error && (
            <p className="mt-1.5 line-clamp-2 text-[10px] text-destructive">{s.last_error}</p>
          )}
        </div>
        <div
          className="mt-2.5 flex flex-wrap items-center justify-end gap-1.5 border-t border-border/40 pt-2.5"
          role="group"
          aria-label={s.display_name}
        >
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-amber-600 transition-colors hover:bg-amber-500/12 disabled:cursor-not-allowed disabled:opacity-40 dark:text-amber-400"
            title={t('sshServers.testConnectionAction')}
            disabled={!s.has_secrets || busyId === s.id || !vaultConfigured || savingServerEdit}
            onClick={() => void handleTest(s.id)}
          >
            {busyId === s.id ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <PlugZap className="h-4 w-4" strokeWidth={2.25} />
            )}
          </button>
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-zinc-600 transition-colors hover:bg-zinc-500/12 disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-300"
            title={t('sshServers.claudeProviderSettingsAction')}
            disabled={!s.has_secrets || !vaultConfigured || busyId === s.id || savingServerEdit}
            onClick={() => setClaudeProviderServer(s)}
          >
            <Settings className="h-4 w-4" strokeWidth={2.25} />
          </button>
          {showUseRemote && (
            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-sky-600 transition-colors hover:bg-sky-500/12 disabled:cursor-not-allowed disabled:opacity-40 dark:text-sky-400"
              title={t('sshServers.useThisEnv')}
              disabled={!s.has_secrets}
              onClick={() => setRemote({ serverId: s.id, displayName: s.display_name || `${s.host}:${s.port}` })}
            >
              <Cloud className="h-4 w-4" strokeWidth={2.25} />
            </button>
          )}
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-emerald-600 transition-colors hover:bg-emerald-500/12 disabled:cursor-not-allowed disabled:opacity-40 dark:text-emerald-400"
            title={t('sshServers.claudeInstallAction')}
            disabled={!s.has_secrets || !vaultConfigured || busyId === s.id || savingServerEdit}
            onClick={() => void openClaudeSetup(s)}
          >
            {claudeProbingId === s.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" strokeWidth={2.25} />}
          </button>
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-violet-600 transition-colors hover:bg-violet-500/12 disabled:cursor-not-allowed disabled:opacity-40 dark:text-violet-400"
            title={t('sshServers.editServerAction')}
            disabled={busyId === s.id || savingServerEdit}
            onClick={() => openEditServer(s)}
          >
            <Pencil className="h-4 w-4" strokeWidth={2.25} />
          </button>
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-rose-600 transition-colors hover:bg-rose-500/12 disabled:cursor-not-allowed disabled:opacity-40 dark:text-rose-400"
            title={t('sshServers.deleteServerAction')}
            disabled={busyId === s.id || savingServerEdit}
            onClick={() => void handleDelete(s.id)}
          >
            <Trash2 className="h-4 w-4" strokeWidth={2.25} />
          </button>
        </div>
      </li>
    );
  };

  if (loading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 py-12 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
        <span className="text-xs">{t('sshServers.loading')}</span>
      </div>
    );
  }

  return (
    <ScrollArea className="min-w-0 flex-1 overflow-y-auto overscroll-contain md:px-1.5 md:py-2">
      <div className="w-full min-w-0 space-y-3 px-2 pb-4">
        <div className="space-y-1.5 rounded-lg border border-border/50 bg-muted/20 px-3 py-2 text-[11px] text-foreground">
          <div className="font-medium text-muted-foreground">
            {isRemote && currentTarget.kind === 'remote'
              ? t('sshServers.currentRemote', { name: currentTarget.displayName })
              : t('sshServers.currentLocal')}
          </div>
          <div className="flex flex-wrap gap-2">
            {isRemote && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="h-7 text-[10px]"
                onClick={() => setLocal()}
              >
                <Monitor className="mr-1 h-3 w-3" />
                {t('sshServers.useLocal')}
              </Button>
            )}
          </div>
        </div>

        {!vaultConfigured && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100">
            {t('sshServers.vaultRequired')}
          </div>
        )}

        {error && (
          <div className="w-full min-w-0 max-w-full break-all rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        {testMessage && (
          <div className="w-full min-w-0 max-w-full break-all rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-foreground">
            {testMessage}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => void load()}>
            {t('actions.refresh')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            onClick={() => {
              setError(null);
              setNewGroupName('');
              setGroupDialogOpen(true);
            }}
          >
            {t('sshServers.newGroup')}
          </Button>
          <Button size="sm" className="h-8 text-xs" onClick={() => setFormOpen((v) => !v)}>
            <Plus className="mr-1 h-3 w-3" />
            {formOpen ? t('sshServers.cancelAdd') : t('sshServers.newServer')}
          </Button>
        </div>

        {groupDialogOpen && (
          <div
            className="fixed inset-0 z-[200] flex items-end justify-center bg-black/50 p-3 sm:items-center"
            role="dialog"
            aria-modal
            aria-labelledby="ssh-new-group-title"
            onKeyDown={(e) => e.key === 'Escape' && !savingGroup && setGroupDialogOpen(false)}
            onClick={(e) => e.target === e.currentTarget && !savingGroup && setGroupDialogOpen(false)}
          >
            <div
              className="w-full max-w-sm rounded-lg border border-border bg-card p-4 shadow-lg"
              onClick={(e) => e.stopPropagation()}
            >
              <p id="ssh-new-group-title" className="mb-2 text-sm font-medium text-foreground">
                {t('sshServers.newGroupDialogTitle')}
              </p>
              <Input
                className="h-9 text-sm"
                autoFocus
                placeholder={t('sshServers.promptGroupName')}
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !savingGroup) {
                    e.preventDefault();
                    void submitNewGroup();
                  }
                }}
              />
              <div className="mt-3 flex justify-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={savingGroup}
                  onClick={() => setGroupDialogOpen(false)}
                >
                  {tCommon('buttons.cancel')}
                </Button>
                <Button type="button" size="sm" disabled={savingGroup} onClick={() => void submitNewGroup()}>
                  {savingGroup ? <Loader2 className="h-4 w-4 animate-spin" /> : t('sshServers.createGroupButton')}
                </Button>
              </div>
            </div>
          </div>
        )}

        {editGroupId != null && (
          <div
            className="fixed inset-0 z-[200] flex items-end justify-center bg-black/50 p-3 sm:items-center"
            role="dialog"
            aria-modal
            aria-labelledby="ssh-edit-group-title"
            onKeyDown={(e) => e.key === 'Escape' && !savingEditGroup && setEditGroupId(null)}
            onClick={(e) => e.target === e.currentTarget && !savingEditGroup && setEditGroupId(null)}
          >
            <div
              className="w-full max-w-sm rounded-lg border border-border bg-card p-4 shadow-lg"
              onClick={(e) => e.stopPropagation()}
            >
              <p id="ssh-edit-group-title" className="mb-2 text-sm font-medium text-foreground">
                {t('sshServers.editGroupTitle')}
              </p>
              <Input
                className="h-9 text-sm"
                autoFocus
                placeholder={t('sshServers.promptGroupName')}
                value={editGroupName}
                onChange={(e) => setEditGroupName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !savingEditGroup) {
                    e.preventDefault();
                    void submitEditGroup();
                  }
                }}
              />
              <div className="mt-3 flex justify-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={savingEditGroup}
                  onClick={() => setEditGroupId(null)}
                >
                  {tCommon('buttons.cancel')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={savingEditGroup}
                  onClick={() => void submitEditGroup()}
                >
                  {savingEditGroup ? <Loader2 className="h-4 w-4 animate-spin" /> : t('sshServers.renameGroupButton')}
                </Button>
              </div>
            </div>
          </div>
        )}

        {editServerId != null && (
          <div
            className="fixed inset-0 z-[200] flex items-end justify-center bg-black/50 p-3 sm:items-center"
            role="dialog"
            aria-modal
            aria-labelledby="ssh-edit-server-title"
            onKeyDown={(e) => e.key === 'Escape' && !savingServerEdit && closeEditServer()}
            onClick={(e) => e.target === e.currentTarget && !savingServerEdit && closeEditServer()}
          >
            <div
              className="max-h-[min(90vh,32rem)] w-full max-w-sm overflow-y-auto rounded-lg border border-border bg-card p-4 shadow-lg"
              onClick={(e) => e.stopPropagation()}
            >
              <p id="ssh-edit-server-title" className="mb-1 text-sm font-medium text-foreground">
                {t('sshServers.editServerTitle')}
              </p>
              <p className="mb-3 text-[10px] leading-relaxed text-muted-foreground">
                {t('sshServers.editSecretsOptionalHint')}
              </p>
              <div className="space-y-2">
                <Input
                  className="h-8 text-xs"
                  placeholder={t('sshServers.displayName')}
                  value={edDisplayName}
                  onChange={(e) => setEdDisplayName(e.target.value)}
                />
                <Input
                  className="h-8 text-xs"
                  placeholder={t('sshServers.host')}
                  value={edHost}
                  onChange={(e) => setEdHost(e.target.value)}
                />
                <Input
                  className="h-8 text-xs"
                  placeholder={t('sshServers.port')}
                  value={edPort}
                  onChange={(e) => setEdPort(e.target.value)}
                />
                <Input
                  className="h-8 text-xs"
                  placeholder={t('sshServers.username')}
                  value={edUsername}
                  onChange={(e) => setEdUsername(e.target.value)}
                />
                <select
                  className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                  value={edAuthType}
                  onChange={(e) => setEdAuthType(e.target.value as 'private_key' | 'password')}
                >
                  <option value="private_key">{t('sshServers.authPrivateKey')}</option>
                  <option value="password">{t('sshServers.authPassword')}</option>
                </select>
                {groups.length > 0 && (
                  <select
                    className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                    value={edGroupId}
                    onChange={(e) => setEdGroupId(e.target.value)}
                  >
                    <option value="">{t('sshServers.noGroup')}</option>
                    {groups.map((g) => (
                      <option key={g.id} value={String(g.id)}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                )}
                {edAuthType === 'private_key' ? (
                  <>
                    <textarea
                      className="min-h-[72px] w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-[11px]"
                      placeholder={t('sshServers.privateKeyEditPlaceholder')}
                      value={edPrivateKey}
                      onChange={(e) => setEdPrivateKey(e.target.value)}
                    />
                    <Input
                      className="h-8 text-xs"
                      type="password"
                      placeholder={t('sshServers.keyPassphraseOptional')}
                      value={edKeyPassphrase}
                      onChange={(e) => setEdKeyPassphrase(e.target.value)}
                    />
                  </>
                ) : (
                  <Input
                    className="h-8 text-xs"
                    type="password"
                    placeholder={t('sshServers.passwordEditPlaceholder')}
                    value={edPassword}
                    onChange={(e) => setEdPassword(e.target.value)}
                  />
                )}
                <div className="mt-2 flex justify-end gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={savingServerEdit}
                    onClick={closeEditServer}
                  >
                    {tCommon('buttons.cancel')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={savingServerEdit || !vaultConfigured}
                    onClick={() => void submitServerEdit()}
                  >
                    {savingServerEdit ? <Loader2 className="h-4 w-4 animate-spin" /> : t('sshServers.editServerSave')}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}

        {claudeInstall && (
          <div
            className="fixed inset-0 z-[200] flex items-end justify-center bg-black/50 p-3 sm:items-center"
            role="dialog"
            aria-modal
            aria-labelledby="ssh-claude-install-title"
            onKeyDown={(e) => e.key === 'Escape' && !claudeInstallBusy && setClaudeInstall(null)}
            onClick={(e) => e.target === e.currentTarget && !claudeInstallBusy && setClaudeInstall(null)}
          >
            <div
              className="max-h-[min(92vh,40rem)] w-full max-w-lg overflow-y-auto rounded-lg border border-border bg-card p-4 shadow-lg"
              onClick={(e) => e.stopPropagation()}
            >
              <p id="ssh-claude-install-title" className="mb-1 text-sm font-medium text-foreground">
                {t('sshServers.claudeInstallDialogTitle')}
              </p>
              <p className="mb-2 text-[10px] leading-relaxed text-muted-foreground">
                {t('sshServers.claudeInstallDialogHint')}
              </p>
              <p className="mb-1 text-[10px] text-muted-foreground">
                {t('sshServers.claudeOsLabel')}: {claudeInstall.probe.platform} (
                {claudeInstall.probe.installFamily === 'win' ? t('sshServers.claudeFamilyWin') : t('sshServers.claudeFamilyUnix')}
                ) · {t('sshServers.claudeConfigPathHint', { path: claudeInstall.probe.homeConfigHint })}
              </p>
              <div className="mb-2">
                <label className="mb-0.5 block text-[10px] text-muted-foreground" htmlFor="claude-base-url">
                  {t('sshServers.claudeInstallBaseUrl')}
                </label>
                <Input
                  id="claude-base-url"
                  className="h-8 text-xs"
                  value={claudeBaseOverride}
                  onChange={(e) => setClaudeBaseOverride(e.target.value)}
                />
              </div>
              <div className="mb-2">
                <span className="mb-0.5 block text-[10px] text-muted-foreground">
                  {t('sshServers.claudeInstallMethod')}
                </span>
                <div className="flex flex-wrap gap-2">
                  {claudeInstall.probe.installFamily === 'win' ? (
                    <Button
                      type="button"
                      size="sm"
                      variant={claudeMethod === 'pwsh' ? 'default' : 'secondary'}
                      className="h-7 text-[10px]"
                      onClick={() => {
                        setClaudeMethod('pwsh');
                        setClaudeCmdDraft(claudeInstall.probe.installCommands.pwsh);
                      }}
                    >
                      {t('sshServers.claudeMethodPowerShell')}
                    </Button>
                  ) : (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        variant={claudeMethod === 'curl' ? 'default' : 'secondary'}
                        className="h-7 text-[10px]"
                        onClick={() => {
                          setClaudeMethod('curl');
                          setClaudeCmdDraft(claudeInstall.probe.installCommands.curl);
                        }}
                      >
                        {t('sshServers.claudeMethodCurl')}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={claudeMethod === 'wget' ? 'default' : 'secondary'}
                        className="h-7 text-[10px]"
                        onClick={() => {
                          setClaudeMethod('wget');
                          setClaudeCmdDraft(claudeInstall.probe.installCommands.wget);
                        }}
                      >
                        {t('sshServers.claudeMethodWget')}
                      </Button>
                    </>
                  )}
                </div>
              </div>
              <label className="mb-0.5 block text-[10px] text-muted-foreground" htmlFor="claude-cmd-ta">
                {t('sshServers.claudeInstallCommandLabel')}
              </label>
              <textarea
                id="claude-cmd-ta"
                className="mb-3 min-h-[120px] w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-[11px] leading-relaxed [overflow-wrap:break-word] break-words"
                value={claudeCmdDraft}
                onChange={(e) => setClaudeCmdDraft(e.target.value)}
              />
              {claudeInstallLog && (
                <div className="mb-2 max-h-32 overflow-y-auto rounded border border-border/60 bg-muted/20 p-2 text-[10px] [overflow-wrap:break-word] break-words text-muted-foreground">
                  {claudeInstallLog}
                </div>
              )}
              <div className="mt-1 flex flex-wrap justify-end gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={claudeInstallBusy}
                  onClick={() => setClaudeInstall(null)}
                >
                  {tCommon('buttons.cancel')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={claudeInstallBusy || !claudeCmdDraft.trim()}
                  onClick={() => void runClaudeInstallAction()}
                >
                  {claudeInstallBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : t('sshServers.claudeRunInstall')}
                </Button>
              </div>
            </div>
          </div>
        )}

        {claudeProviderServer && (
          <RemoteClaudeProviderSettingsModal
            open
            onOpenChange={(o) => {
              if (!o) setClaudeProviderServer(null);
            }}
            serverId={claudeProviderServer.id}
            serverName={claudeProviderServer.display_name || `${claudeProviderServer.host}:${claudeProviderServer.port}`}
            vaultConfigured={vaultConfigured}
            t={t}
          />
        )}

        {formOpen && (
          <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3">
            <p className="text-xs font-medium text-foreground">{t('sshServers.addTitle')}</p>
            <Input
              className="h-8 text-xs"
              placeholder={t('sshServers.displayName')}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
            <Input
              className="h-8 text-xs"
              placeholder={t('sshServers.host')}
              value={host}
              onChange={(e) => setHost(e.target.value)}
            />
            <Input
              className="h-8 text-xs"
              placeholder={t('sshServers.port')}
              value={port}
              onChange={(e) => setPort(e.target.value)}
            />
            <Input
              className="h-8 text-xs"
              placeholder={t('sshServers.username')}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <select
              className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
              value={authType}
              onChange={(e) => setAuthType(e.target.value as 'private_key' | 'password')}
            >
              <option value="private_key">{t('sshServers.authPrivateKey')}</option>
              <option value="password">{t('sshServers.authPassword')}</option>
            </select>
            {groups.length > 0 && (
              <select
                className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                value={groupId}
                onChange={(e) => setGroupId(e.target.value)}
              >
                <option value="">{t('sshServers.noGroup')}</option>
                {groups.map((g) => (
                  <option key={g.id} value={String(g.id)}>
                    {g.name}
                  </option>
                ))}
              </select>
            )}
            {authType === 'private_key' ? (
              <>
                <textarea
                  className="min-h-[72px] w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-[11px]"
                  placeholder={t('sshServers.privateKeyPlaceholder')}
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                />
                <Input
                  className="h-8 text-xs"
                  type="password"
                  placeholder={t('sshServers.keyPassphraseOptional')}
                  value={keyPassphrase}
                  onChange={(e) => setKeyPassphrase(e.target.value)}
                />
              </>
            ) : (
              <Input
                className="h-8 text-xs"
                type="password"
                placeholder={t('sshServers.passwordPlaceholder')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
            <Button size="sm" className="h-8 w-full text-xs" disabled={!vaultConfigured} onClick={() => void handleCreateServer()}>
              {t('sshServers.saveServer')}
            </Button>
          </div>
        )}

        {!hasTreeContent ? (
          <div className="px-2 py-8 text-center text-xs text-muted-foreground">
            <Server className="mx-auto mb-2 h-8 w-8 opacity-40" />
            {t('sshServers.empty')}
          </div>
        ) : (
          <ul className="space-y-1" role="tree" aria-label={t('sshServers.serversTreeLabel')}>
            {sortedGroups.map((g) => {
              const key = `g-${g.id}`;
              const open = isNodeOpen(key);
              const list = byGroup[g.id] || [];
              return (
                <li key={g.id} className="rounded-md border border-border/40 bg-muted/5" role="treeitem" aria-expanded={open}>
                  <div className="flex items-center gap-0.5 pr-1">
                    <button
                      type="button"
                      className="flex flex-1 items-center gap-1.5 py-1.5 pl-1.5 pr-0 text-left text-xs font-medium text-foreground"
                      onClick={() => toggleNode(key)}
                    >
                      <span className="text-muted-foreground" aria-hidden>
                        {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{g.name}</span>
                    </button>
                    <div className="flex shrink-0 items-center">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                        title={t('sshServers.editGroupTitle')}
                        disabled={busyGroupId === g.id}
                        onClick={() => {
                          setError(null);
                          setEditGroupId(g.id);
                          setEditGroupName(g.name);
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                        title={t('sshServers.deleteGroupAction')}
                        disabled={busyGroupId === g.id}
                        onClick={() => void handleDeleteGroup(g)}
                      >
                        {busyGroupId === g.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                      </Button>
                    </div>
                  </div>
                  {open && (
                    <ul className="ml-1 border-l border-border/30 pb-1 pl-2" role="group">
                      {list.length === 0 ? (
                        <li className="px-1 py-2 text-[10px] text-muted-foreground">{t('sshServers.groupNoServers')}</li>
                      ) : (
                        list.map((s) => renderServerRow(s))
                      )}
                    </ul>
                  )}
                </li>
              );
            })}

            {ungrouped.length > 0 && (
              <li
                key="ungrouped"
                className="rounded-md border border-dashed border-border/50 bg-muted/5"
                role="treeitem"
                aria-expanded={isNodeOpen('ungrouped')}
              >
                <div className="flex items-center gap-0.5 pr-1">
                  <button
                    type="button"
                    className="flex w-full items-center gap-1.5 py-1.5 pl-1.5 pr-2 text-left text-xs font-medium text-foreground"
                    onClick={() => toggleNode('ungrouped')}
                  >
                    <span className="text-muted-foreground" aria-hidden>
                      {isNodeOpen('ungrouped') ? (
                        <ChevronDown className="h-4 w-4 shrink-0" />
                      ) : (
                        <ChevronRight className="h-4 w-4 shrink-0" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {t('sshServers.ungroupedTitle')}
                    </span>
                  </button>
                </div>
                {isNodeOpen('ungrouped') && (
                  <ul className="ml-1 border-l border-border/30 pb-1 pl-2" role="group">
                    {ungrouped.map((s) => renderServerRow(s))}
                  </ul>
                )}
              </li>
            )}
          </ul>
        )}

      </div>
    </ScrollArea>
  );
}
