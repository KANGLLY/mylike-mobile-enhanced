import { parseVideoItems, CommentReadError, type VideoItem } from '../douyin-bridge.ts';
import type { LibraryImport, LibraryWork } from '../library-format.ts';

// The likes / favourites lists are Argus-protected private endpoints: their
// requests must be signed by Douyin's own page SDK. Instead of trying to forge
// an a_bogus (which gets rejected with "Sign Invalid"), we let the real, already
// logged-in Douyin page load its own "我的喜欢 / 我的收藏" tab and capture the
// responses it fires — those carry a valid signature. We just read what the page
// already fetched and merge it into the local library.
export type CapturePage = { status: number; body: string };
export type CaptureCollection = (kind: 'likes' | 'favorites') => Promise<CapturePage[]>;

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

async function collectFromCapture(capture: CaptureCollection, kind: 'likes' | 'favorites'): Promise<VideoItem[]> {
  const pages = await capture(kind);
  if (!pages.length) {
    throw new CommentReadError('empty', kind === 'likes'
      ? '没有捕获到“我的喜欢”数据，请确认已登录抖音后重试。'
      : '没有捕获到“我的收藏”数据，请确认已登录抖音后重试。');
  }
  const items: VideoItem[] = [];
  const seen = new Set<string>();
  let lastError: unknown = null;
  for (const page of pages) {
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
): Promise<SyncResult> {
  const likes = await collectFromCapture(captureCollection, 'likes');
  const favorites = await collectFromCapture(captureCollection, 'favorites');
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
