import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert } from 'react-native';
import { useMobile } from './context';
import { useDouyinSession } from './douyin-session';
import {
  formatSyncDiagnostic,
  syncDouyinLibrary,
  type CaptureMode,
  type SyncCheckpoint,
  type SyncProgress,
  type SyncTarget,
} from './sync-library';

// A single, app-wide update task. It lives above the navigator so leaving the
// More/Settings screen keeps the likes/favourites capture running in the
// background; it only stops when the user explicitly cancels.
type CheckpointsMap = { likes: SyncCheckpoint | null; favorites: SyncCheckpoint | null };

type SyncValue = {
  syncing: boolean;
  activeTarget: SyncTarget | null;
  progress: SyncProgress | null;
  checkpoints: CheckpointsMap;
  start: (mode: CaptureMode, target?: SyncTarget) => Promise<void>;
  cancel: () => void;
  clearCheckpoint: (kind: 'likes' | 'favorites') => Promise<void>;
};

const CHECKPOINT_KEY = {
  likes: 'sync:checkpoint:likes',
  favorites: 'sync:checkpoint:favorites',
} as const;

function parseCheckpoint(raw: string | null, kind: 'likes' | 'favorites'): SyncCheckpoint | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || parsed.kind !== kind || !parsed.diagnostic) return null;
    return parsed as SyncCheckpoint;
  } catch {
    return null;
  }
}

const noop = () => {};
const SyncContext = createContext<SyncValue>({
  syncing: false,
  activeTarget: null,
  progress: null,
  checkpoints: { likes: null, favorites: null },
  start: async () => {},
  cancel: noop,
  clearCheckpoint: async () => {},
});
export function useSync(): SyncValue { return useContext(SyncContext); }

export function SyncProvider({ children }: { children: ReactNode }) {
  const { store, changed } = useMobile();
  const { captureCollection, cancelCapture } = useDouyinSession();
  const [syncing, setSyncing] = useState(false);
  const [activeTarget, setActiveTarget] = useState<SyncTarget | null>(null);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [checkpoints, setCheckpoints] = useState<CheckpointsMap>({ likes: null, favorites: null });
  const running = useRef(false);
  const cancelled = useRef(false);
  const checkpointsRef = useRef<CheckpointsMap>(checkpoints);
  checkpointsRef.current = checkpoints;

  useEffect(() => {
    let alive = true;
    void Promise.all([
      store.readState(CHECKPOINT_KEY.likes),
      store.readState(CHECKPOINT_KEY.favorites),
    ]).then(([rawLikes, rawFavs]) => {
      if (!alive) return;
      setCheckpoints({
        likes: parseCheckpoint(rawLikes, 'likes'),
        favorites: parseCheckpoint(rawFavs, 'favorites'),
      });
    }).catch(() => {});
    return () => { alive = false; };
  }, [store]);

  const saveCheckpoint = useCallback(async (checkpoint: SyncCheckpoint) => {
    setCheckpoints(prev => ({ ...prev, [checkpoint.kind]: checkpoint }));
    try { await store.writeState(CHECKPOINT_KEY[checkpoint.kind], checkpoint); } catch { /* ignore persistence failure */ }
  }, [store]);

  const clearCheckpoint = useCallback(async (kind: 'likes' | 'favorites') => {
    setCheckpoints(prev => ({ ...prev, [kind]: null }));
    try { await store.writeState(CHECKPOINT_KEY[kind], null); } catch { /* ignore */ }
  }, [store]);

  const start = useCallback(async (mode: CaptureMode, target: SyncTarget = 'both') => {
    if (running.current) return;
    running.current = true;
    cancelled.current = false;
    setSyncing(true);
    setActiveTarget(target);
    setProgress(null);

    const latestCheckpoints: Partial<CheckpointsMap> = {};
    const prevCheckpoints = checkpointsRef.current;

    try {
      const result = await syncDouyinLibrary(
        captureCollection,
        store.importCollection,
        (value) => { if (!cancelled.current) setProgress(value); },
        () => cancelled.current,
        mode,
        target,
        {
          resumeCursor: {
            likes: prevCheckpoints.likes?.resumeCursor ?? null,
            favorites: prevCheckpoints.favorites?.resumeCursor ?? null,
          },
          previousCheckpoint: prevCheckpoints,
          onCheckpoint: async (cp) => {
            latestCheckpoints[cp.kind] = cp;
            await saveCheckpoint(cp);
          },
        },
      );
      changed();

      const diagLines: string[] = [];
      if (latestCheckpoints.likes?.diagnostic) diagLines.push(`喜欢：${formatSyncDiagnostic(latestCheckpoints.likes.diagnostic)}`);
      if (latestCheckpoints.favorites?.diagnostic) diagLines.push(`收藏：${formatSyncDiagnostic(latestCheckpoints.favorites.diagnostic)}`);

      if (cancelled.current) {
        Alert.alert('已取消更新', ['已保留本次抓到的数据与断点位置。', ...diagLines].join('\n'));
        return;
      }

      const summary = target === 'likes'
        ? `点赞 ${result.liked} 条已同步到本机。`
        : target === 'favorites'
          ? `收藏 ${result.saved} 条已同步到本机。`
          : `点赞 ${result.liked} 条，收藏 ${result.saved} 条已同步到本机。`;
      const hasResume = Boolean(
        (target !== 'favorites' && latestCheckpoints.likes?.resumeCursor) ||
        (target !== 'likes' && latestCheckpoints.favorites?.resumeCursor),
      );
      const title = hasResume ? '本轮已保存（有可续传断点）' : '已更新';
      Alert.alert(title, [summary, ...diagLines].join('\n\n'));
    } catch (error) {
      changed();
      const diagLines: string[] = [];
      if (latestCheckpoints.likes?.diagnostic) diagLines.push(`喜欢：${formatSyncDiagnostic(latestCheckpoints.likes.diagnostic)}`);
      if (latestCheckpoints.favorites?.diagnostic) diagLines.push(`收藏：${formatSyncDiagnostic(latestCheckpoints.favorites.diagnostic)}`);
      if (cancelled.current) {
        Alert.alert('已取消更新', ['已保留本次抓到的数据与断点位置。', ...diagLines].join('\n'));
      } else {
        const msg = error instanceof Error ? error.message : '请稍后重试。';
        Alert.alert('更新中断', [msg, ...diagLines].join('\n\n'));
      }
    } finally {
      running.current = false;
      setSyncing(false);
      setActiveTarget(null);
      setProgress(null);
    }
  }, [captureCollection, store, changed, saveCheckpoint]);

  const cancel = useCallback(() => {
    if (!running.current) return;
    cancelled.current = true;
    cancelCapture();
  }, [cancelCapture]);

  return (
    <SyncContext.Provider value={{ syncing, activeTarget, progress, checkpoints, start, cancel, clearCheckpoint }}>
      {children}
    </SyncContext.Provider>
  );
}
