import { parseVideoList, type VideoItem } from '../douyin-bridge';
import type { LibraryImport, LibraryWork } from '../library-format';

// Pull the signed-in account's liked videos and favourites collection straight
// from the web endpoints (through the shared login WebView) and merge them into
// the local library, exactly like importing a desktop export — but live.
type Requester = (operation: 'likes' | 'favorites', parameters: Record<string, string>) => Promise<{ status: number; body: string }>;

const PAGE_LIMIT = 300;

async function collectAll(request: Requester, operation: 'likes' | 'favorites'): Promise<VideoItem[]> {
  const items: VideoItem[] = [];
  const seen = new Set<string>();
  let cursor = '0';
  for (let page = 0; page < PAGE_LIMIT; page++) {
    const response = await request(operation, { cursor, count: '20' });
    const parsed = parseVideoList(response.body, cursor, response.status);
    for (const item of parsed.items) {
      if (!seen.has(item.id)) { seen.add(item.id); items.push(item); }
    }
    if (!parsed.hasMore || !parsed.nextCursor) break;
    cursor = parsed.nextCursor;
  }
  return items;
}

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

export type SyncResult = { liked: number; saved: number };

export async function syncDouyinLibrary(
  request: Requester,
  importCollection: (file: LibraryImport) => Promise<unknown>,
): Promise<SyncResult> {
  const likes = await collectAll(request, 'likes');
  const favorites = await collectAll(request, 'favorites');
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
