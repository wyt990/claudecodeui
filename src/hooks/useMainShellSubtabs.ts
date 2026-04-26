import { useCallback, useEffect, useState } from 'react';

const LS_KEY = 'cloudcli-main-shell-subtabs-v1';

type Bundle = { tabIds: string[]; activeId: string };

type Stored = { ids: string[]; active: string };

function genId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `s-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function readAll(): Record<string, Stored> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) {
      return {};
    }
    return JSON.parse(raw) as Record<string, Stored>;
  } catch {
    return {};
  }
}

function readForTarget(targetKey: string): Stored | null {
  const a = readAll();
  return a[targetKey] ?? null;
}

function writeForTarget(targetKey: string, data: Stored) {
  try {
    const a = readAll();
    a[targetKey] = data;
    localStorage.setItem(LS_KEY, JSON.stringify(a));
  } catch {
    /* */
  }
}

function initialBundle(targetKey: string): Bundle {
  const s = readForTarget(targetKey);
  if (s?.ids?.length) {
    const active = s.active && s.ids.includes(s.active) ? s.active : s.ids[0]!;
    return { tabIds: s.ids, activeId: active };
  }
  const id = genId();
  return { tabIds: [id], activeId: id };
}

/**
 * 主区「终端」多标签（P3/§9）：每 currentTarget 独立持久化，切换环境后从对应键恢复或新建单标签。
 */
export function useMainShellSubtabs(targetKey: string) {
  const [b, setB] = useState<Bundle>(() => initialBundle(targetKey));

  useEffect(() => {
    setB(initialBundle(targetKey));
  }, [targetKey]);

  const { tabIds, activeId } = b;

  useEffect(() => {
    if (!tabIds.length) {
      return;
    }
    if (!activeId || !tabIds.includes(activeId)) {
      setB((prev) => ({ ...prev, activeId: prev.tabIds[0] as string }));
    }
  }, [tabIds, activeId]);

  useEffect(() => {
    if (!b.tabIds.length) {
      return;
    }
    if (!b.activeId) {
      return;
    }
    writeForTarget(targetKey, { ids: b.tabIds, active: b.activeId });
  }, [b.tabIds, b.activeId, targetKey]);

  const setActive = useCallback((id: string) => {
    setB((prev) => ({ ...prev, activeId: id }));
  }, []);

  const addTab = useCallback(() => {
    const id = genId();
    setB((prev) => ({ tabIds: [...prev.tabIds, id], activeId: id }));
  }, []);

  const removeTab = useCallback((id: string) => {
    setB((prev) => {
      if (prev.tabIds.length <= 1) {
        return prev;
      }
      const next = prev.tabIds.filter((t) => t !== id);
      const nextActive = prev.activeId === id ? (next[0] as string) : prev.activeId;
      return { tabIds: next, activeId: nextActive };
    });
  }, []);

  return { tabIds, activeId, setActive, addTab, removeTab };
}
