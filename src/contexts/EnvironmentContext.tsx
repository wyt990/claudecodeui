import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { STORAGE_KEY } from '../utils/targetKey.js';

export type LocalTarget = { kind: 'local' };
export type RemoteTarget = { kind: 'remote'; serverId: number; displayName: string };
export type CurrentTarget = LocalTarget | RemoteTarget;

type EnvironmentContextValue = {
  currentTarget: CurrentTarget;
  targetKey: 'local' | `remote:${number}`;
  isRemote: boolean;
  setLocal: () => void;
  setRemote: (args: { serverId: number; displayName: string }) => void;
};

function toTargetKey(t: CurrentTarget): 'local' | `remote:${number}` {
  if (t.kind === 'local') {
    return 'local';
  }
  return `remote:${t.serverId}`;
}

function readStoredTarget(): CurrentTarget {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { kind: 'local' };
    }
    const p = JSON.parse(raw) as { kind?: string; serverId?: number; displayName?: string };
    const sid = p?.serverId;
    if (p && p.kind === 'remote' && typeof sid === 'number' && Number.isFinite(sid) && sid >= 1) {
      return {
        kind: 'remote',
        serverId: sid,
        displayName: typeof p.displayName === 'string' && p.displayName.trim() ? p.displayName.trim() : `remote:${sid}`,
      };
    }
  } catch {
    // ignore
  }
  return { kind: 'local' };
}

function writeStoredTarget(t: CurrentTarget) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(t));
  } catch {
    // ignore
  }
}

const EnvironmentContext = createContext<EnvironmentContextValue | null>(null);

export function EnvironmentProvider({ children }: { children: ReactNode }) {
  const [currentTarget, setCurrentTarget] = useState<CurrentTarget>(readStoredTarget);

  const persist = useCallback((t: CurrentTarget) => {
    writeStoredTarget(t);
    setCurrentTarget(t);
  }, []);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) {
        return;
      }
      setCurrentTarget(readStoredTarget());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setLocal = useCallback(() => {
    persist({ kind: 'local' });
  }, [persist]);

  const setRemote = useCallback(
    (args: { serverId: number; displayName: string }) => {
      persist({
        kind: 'remote',
        serverId: args.serverId,
        displayName: args.displayName?.trim() || `remote:${args.serverId}`,
      });
    },
    [persist],
  );

  const value = useMemo<EnvironmentContextValue>(() => {
    const key = toTargetKey(currentTarget);
    return {
      currentTarget,
      targetKey: key,
      isRemote: currentTarget.kind === 'remote',
      setLocal,
      setRemote,
    };
  }, [currentTarget, setLocal, setRemote]);

  return <EnvironmentContext.Provider value={value}>{children}</EnvironmentContext.Provider>;
}

export function useEnvironment(): EnvironmentContextValue {
  const c = useContext(EnvironmentContext);
  if (!c) {
    throw new Error('useEnvironment must be used within EnvironmentProvider');
  }
  return c;
}
