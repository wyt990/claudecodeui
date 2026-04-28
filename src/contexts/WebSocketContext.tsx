import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../components/auth/context/AuthContext';
import { IS_PLATFORM } from '../constants/config';
import { getTargetKey } from '../utils/targetKey.js';
import { chatImagesDebugLog, isChatImagesDebugEnabled } from '../lib/chatImagesDebug';

type WebSocketContextType = {
  ws: WebSocket | null;
  /** @returns 是否已写入 socket（未连接时返回 false） */
  sendMessage: (message: any) => boolean;
  latestMessage: any | null;
  isConnected: boolean;
};

const WebSocketContext = createContext<WebSocketContextType | null>(null);

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};

const buildWebSocketUrl = (token: string | null) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (IS_PLATFORM) return `${protocol}//${window.location.host}/ws`; // Platform mode: Use same domain as the page (goes through proxy)
  if (!token) return null;
  return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`; // OSS mode: Use same host:port that served the page
};

const useWebSocketProviderState = (): WebSocketContextType => {
  const wsRef = useRef<WebSocket | null>(null);
  const unmountedRef = useRef(false); // Track if component is unmounted
  const hasConnectedRef = useRef(false); // Track if we've ever connected (to detect reconnects)
  const [latestMessage, setLatestMessage] = useState<any>(null);
  const [isConnected, setIsConnected] = useState(false);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const { token } = useAuth();

  useEffect(() => {
    connect();
    
    return () => {
      unmountedRef.current = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [token]); // everytime token changes, we reconnect

  const connect = useCallback(() => {
    if (unmountedRef.current) return; // Prevent connection if unmounted
    try {
      // Construct WebSocket URL
      const wsUrl = buildWebSocketUrl(token);

      if (!wsUrl) return console.warn('No authentication token found for WebSocket connection');
      
      const websocket = new WebSocket(wsUrl);

      websocket.onopen = () => {
        setIsConnected(true);
        wsRef.current = websocket;
        if (hasConnectedRef.current) {
          // This is a reconnect — signal so components can catch up on missed messages
          setLatestMessage({
            type: 'websocket-reconnected',
            timestamp: Date.now(),
            targetKey: getTargetKey(),
          });
        }
        hasConnectedRef.current = true;
      };

      websocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (isChatImagesDebugEnabled()) {
            const k = data?.kind ?? data?.type;
            const prov = data?.provider;
            const remoteTk = typeof data?.targetKey === 'string' && data.targetKey.startsWith('remote:');
            if (prov === 'claude' || remoteTk || k === 'stream_delta' || k === 'stream_end' || k === 'complete' || k === 'session_created') {
              const content = data?.content;
              chatImagesDebugLog('[WS in]', {
                kind: k,
                sessionId: data?.sessionId,
                targetKey: data?.targetKey,
                provider: prov,
                contentChars: typeof content === 'string' ? content.length : undefined,
                exitCode: data?.exitCode,
                newSessionId: data?.newSessionId,
              });
            }
          }
          setLatestMessage(data);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      websocket.onclose = () => {
        setIsConnected(false);
        wsRef.current = null;
        
        // Attempt to reconnect after 3 seconds
        reconnectTimeoutRef.current = setTimeout(() => {
          if (unmountedRef.current) return; // Prevent reconnection if unmounted
          connect();
        }, 3000);
      };

      websocket.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

    } catch (error) {
      console.error('Error creating WebSocket connection:', error);
    }
  }, [token]); // everytime token changes, we reconnect

  const sendMessage = useCallback((message: any) => {
    if (isChatImagesDebugEnabled() && message?.type === 'claude-command') {
      const o = message.options ?? {};
      chatImagesDebugLog('[WS out] claude-command', {
        useRemoteSsh: Boolean(o.useRemoteSsh),
        serverId: o.serverId,
        targetKey: o.targetKey,
        sessionId: o.sessionId,
        imagesCount: Array.isArray(o.images) ? o.images.length : 0,
        commandChars: typeof message.command === 'string' ? message.command.length : 0,
        model: o.model,
        projectName: o.projectName,
      });
    }
    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
      return true;
    }
    console.warn('[WebSocket] sendMessage skipped: socket not open (readyState=', socket?.readyState, ')');
    return false;
  }, []);

  const value: WebSocketContextType = useMemo(() =>
  ({
    ws: wsRef.current,
    sendMessage,
    latestMessage,
    isConnected
  }), [sendMessage, latestMessage, isConnected]);

  return value;
};

export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const webSocketData = useWebSocketProviderState();
  
  return (
    <WebSocketContext.Provider value={webSocketData}>
      {children}
    </WebSocketContext.Provider>
  );
};

export default WebSocketContext;
