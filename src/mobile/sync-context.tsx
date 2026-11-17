import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { Alert } from 'react-native';
import { useMobile } from './context';
import { useDouyinSession } from './douyin-session';
import { syncDouyinLibrary, type SyncProgress } from './sync-library';

// A single, app-wide update task. It lives above the navigator so leaving the
// More/Settings screen keeps the likes/favourites capture running in the
// background; it only stops when the user explicitly cancels.
type SyncMode = 'top' | 'down';
type SyncValue = {
  syncing: boolean;
  progress: SyncProgress | null;
  start: (mode: SyncMode) => Promise<void>;
  cancel: () => void;
};

const noop = () => {};
const SyncContext = createContext<SyncValue>({ syncing: false, progress: null, start: async () => {}, cancel: noop });
export function useSync(): SyncValue { return useContext(SyncContext); }

export function SyncProvider({ children }: { children: ReactNode }) {
  const { store, changed } = useMobile();
  const { captureCollection, cancelCapture } = useDouyinSession();
  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const running = useRef(false);
  const cancelled = useRef(false);

  const start = useCallback(async (mode: SyncMode) => {
    if (running.current) return;
    running.current = true;
    cancelled.current = false;
    setSyncing(true);
    setProgress(null);
    try {
      const result = await syncDouyinLibrary(
        captureCollection,
        store.importCollection,
        (value) => { if (!cancelled.current) setProgress(value); },
        () => cancelled.current,
        mode,
      );
      if (cancelled.current) { Alert.alert('已取消更新', '已停止本次更新。'); return; }
      changed();
      Alert.alert('已更新', `点赞 ${result.liked} 条，收藏 ${result.saved} 条已同步到本机。`);
    } catch (error) {
      if (cancelled.current) Alert.alert('已取消更新', '已停止本次更新。');
      else Alert.alert('更新失败', error instanceof Error ? error.message : '请稍后重试。');
    } finally {
      running.current = false;
      setSyncing(false);
      setProgress(null);
    }
  }, [captureCollection, store, changed]);

  const cancel = useCallback(() => {
    if (!running.current) return;
    cancelled.current = true;
    cancelCapture();
  }, [cancelCapture]);

  return <SyncContext.Provider value={{ syncing, progress, start, cancel }}>{children}</SyncContext.Provider>;
}
