import { parseVideoItems, CommentReadError, type VideoItem } from '../douyin-bridge.ts';
import type { LibraryImport, LibraryWork } from '../library-format.ts';

// The likes / favourites lists are Argus-protected private endpoints: their
// requests must be signed by Douyin's own page SDK. Instead of trying to forge
// an a_bogus (which gets rejected with "Sign Invalid"), we let the real, already
// logged-in Douyin page load its own "我的喜欢 / 我的收藏" tab and capture the
// responses it fires — those carry a valid signature. We just read what the page
// already fetched and merge it into the local library.
export type CapturePage = { status: number; body: string };
export type CaptureOptions = { onPage?: (page: CapturePage) => void; maxScrolls?: number; timeoutMs?: number };
export type CaptureMode = 'top' | 'down' | 'full';
export type SyncTarget = 'likes' | 'favorites' | 'both';
export type CaptureCollection = (kind: 'likes' | 'favorites', options?: CaptureOptions) => Promise<CapturePage[]>;
export type SyncProgress = { stage: 'likes' | 'favorites'; received: number; pages: number };

function toLibraryWork(item: VideoItem, index: number): LibraryWork {
  return {
    id: item.id,
    title: item.title,
    author: item.author,
    publishedAt: item.publishedAt,
    kind: item.kind,
    coverUrl: item.coverUrl,
    sourceOrder: index,
  };
}

async function collectFromCapture(
  capture: CaptureCollection,
  kind: 'likes' | 'favorites',
  onProgress?: (value: SyncProgress) => void,
  mode: CaptureMode = 'down',
): Promise<VideoItem[]> {
  let pages = 0;
  const liveSeen = new Set<string>();
  const maxScrolls = mode === 'top' ? 4 : mode === 'full' ? 1500 : 70;
  const timeoutMs = mode === 'top' ? 55_000 : mode === 'full' ? 600_000 : 120_000;
  const captured = await capture(kind, {
    maxScrolls,
    timeoutMs,
    onPage: (page) => {
      pages += 1;
      try {
        for (const item of parseVideoItems(page.body, page.status)) liveSeen.add(item.id);
      } catch {
        /* ignore live-count errors; the authoritative pass below reports them */
      }
      onProgress?.({ stage: kind, received: liveSeen.size, pages });
    },
  });
  if (!captured.length) {
    throw new CommentReadError('empty', kind === 'likes'
      ? '没有捕获到“我的喜欢”数据，请确认已登录抖音后重试。'
      : '没有捕获到“我的收藏”数据，请确认已登录抖音后重试。');
  }
  const items: VideoItem[] = [];
  const seen = new Set<string>();
  let lastError: unknown = null;
  for (const page of captured) {
    let list: VideoItem[];
    try {
      list = parseVideoItems(page.body, page.status);
    } catch (failure) {
      lastError = failure;
      continue;
    }
    for (const item of list) {
      if (!seen.has(item.id)) { seen.add(item.id); items.push(item); }
    }
  }
  if (!items.length && lastError) throw lastError;
  return items;
}

export type SyncResult = { liked: number; saved: number };

export async function syncDouyinLibrary(
  captureCollection: CaptureCollection,
  importCollection: (file: LibraryImport) => Promise<unknown>,
  onProgress?: (value: SyncProgress) => void,
  shouldStop?: () => boolean,
  mode: CaptureMode = 'down',
  target: SyncTarget = 'both',
): Promise<SyncResult> {
  const likes = target === 'favorites' ? [] : await collectFromCapture(captureCollection, 'likes', onProgress, mode);
  if (shouldStop?.()) throw new Error('已取消更新。');
  const favorites = target === 'likes' ? [] : await collectFromCapture(captureCollection, 'favorites', onProgress, mode);
  if (shouldStop?.()) throw new Error('已取消更新。');
  const exportedAt = Date.now();
  if (likes.length) {
    await importCollection({
      version: 3, exportedAt, source: 'likes', sourceLabel: '抖音点赞',
      works: likes.map(toLibraryWork), folders: [], duplicateRows: 0,
    });
  }
  if (favorites.length) {
    await importCollection({
      version: 3, exportedAt, source: 'favorites', sourceLabel: '抖音收藏',
      works: favorites.map(toLibraryWork), folders: [], duplicateRows: 0,
    });
  }
  return { liked: likes.length, saved: favorites.length };
}
