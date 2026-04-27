/** 从聊天权限区打开「远程多渠 / 系统」弹窗时派发；SidebarServersPanel 监听。 */
export const CLOUDCLI_OPEN_REMOTE_CLAUDE_PROVIDER = 'cloudcli:open-remote-claude-provider';

export type OpenRemoteClaudeProviderDetail = {
  serverId: number;
  initialTab?: 'model' | 'system';
};
