import assert from 'node:assert/strict';
import test from 'node:test';
import { syncDouyinLibrary, type CapturePage } from '../src/mobile/sync-library.ts';
import type { LibraryImport } from '../src/library-format.ts';

function page(ids: string[]): string {
  return JSON.stringify({
    status_code: 0,
    has_more: 0,
    aweme_list: ids.map((id) => ({
      aweme_id: id,
      desc: `video ${id}`,
      create_time: 1690000000,
      author: { nickname: 'a' },
      video: { cover: { url_list: ['https://p3.douyinpic.com/c.jpeg'] } },
    })),
  });
}

test('syncDouyinLibrary captures likes/favourites pages, dedupes and merges them', async () => {
  const captured: string[] = [];
  const capture = async (kind: 'likes' | 'favorites'): Promise<CapturePage[]> => {
    captured.push(kind);
    if (kind === 'likes') {
      return [
        { status: 200, body: page(['7300000000000000001', '7300000000000000002']) },
        { status: 200, body: page(['7300000000000000002', '7300000000000000003']) },
      ];
    }
    return [{ status: 200, body: page(['7400000000000000001']) }];
  };

  const imports: LibraryImport[] = [];
  const result = await syncDouyinLibrary(capture, async (file) => { imports.push(file); });

  assert.deepEqual(result, { liked: 3, saved: 1 });
  assert.deepEqual(captured, ['likes', 'favorites']);
  assert.equal(imports.length, 2);
  assert.equal(imports[0].source, 'likes');
  assert.equal(imports[0].works.length, 3);
  assert.equal(imports[1].source, 'favorites');
  assert.equal(imports[1].works.length, 1);
});

test('syncDouyinLibrary surfaces a 403 Sign Invalid body as a rejection', async () => {
  const capture = async (kind: 'likes' | 'favorites'): Promise<CapturePage[]> => {
    if (kind === 'likes') return [{ status: 403, body: JSON.stringify({ status_code: 0, status_msg: 'Blocked by ArgusSecurityPlugin Sign Invalid' }) }];
    return [{ status: 200, body: page(['1']) }];
  };
  await assert.rejects(() => syncDouyinLibrary(capture, async () => {}), /被拒绝/);
});

test('syncDouyinLibrary refuses when nothing was captured', async () => {
  const capture = async (): Promise<CapturePage[]> => [];
  await assert.rejects(() => syncDouyinLibrary(capture, async () => {}), /没有捕获到/);
});
