import { parseSelf, parseVideoList, CommentReadError, type VideoItem } from '../douyin-bridge.ts';
import type { LibraryImport, LibraryWork } from '../library-format.ts';

// Pull the signed-in account's liked videos and favourites collection straight
// from the web endpoints (through the shared login WebView) and merge them into
// the local library, exactly like importing a desktop export — but live.
//
// The likes endpoint is the one that trips people up: it needs the profile's
// sec_user_id and paginates on `max_cursor` (see the desktop collector), NOT on
// `cursor`. Favourites uses `cursor`. So we read the identity first and drive
// each list with the right param names.
type Requester = (operation: 'self' | 'likes' | 'favorites', parameters: Record<string, string>) => Promise<{ status: number; body: string }>;

const PAGE_LIMIT = 300;

async function resolveSecUid(request: Requester): Promise<string> {
  const response = await request('self', {});
  const self = parseSelf(response.body, response.status);
  if (!self.loggedIn) throw new CommentReadError('auth', '登录状态已失效，请重新登录抖音。');
  if (!self.secUid) throw new CommentReadError('auth', '没有取到账号 ID，请重新登录抖音后重试。');
  return self.secUid;
}

async function collectAll(request: Requester, operation: 'likes' | 'favorites', secUid: string): Promise<VideoItem[]> {
  const items: VideoItem[] = [];
  const seen = new Set<string>();
  let cursor = '0';
  for (let page = 0; page < PAGE_LIMIT; page++) {
    const parameters: Record<string, string> = operation === 'likes'
      ? { sec_user_id: secUid, max_cursor: cursor, count: '18' }
      : { cursor, count: '20' };
    const response = await request(operation, parameters);
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
  const secUid = await resolveSecUid(request);
  const likes = await collectAll(request, 'likes', secUid);
  const favorites = await collectAll(request, 'favorites', secUid);
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
