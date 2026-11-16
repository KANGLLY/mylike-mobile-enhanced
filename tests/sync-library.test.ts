import assert from 'node:assert/strict';
import test from 'node:test';
import { syncDouyinLibrary } from '../src/mobile/sync-library.ts';
import type { LibraryImport } from '../src/library-format.ts';

function page(cursor: string, ids: string[], more: boolean) {
  return JSON.stringify({
    status_code: 0,
    has_more: more ? 1 : 0,
    max_cursor: cursor,
    cursor,
    aweme_list: ids.map((id) => ({
      aweme_id: id,
      desc: `video ${id}`,
      create_time: 1690000000,
      author: { nickname: 'a' },
      video: { cover: { url_list: ['https://p3.douyinpic.com/c.jpeg'] } },
    })),
  });
}

test('syncDouyinLibrary reads sec_uid, drives likes on max_cursor and favourites on cursor', async () => {
  const calls: { op: string; params: Record<string, string> }[] = [];
  const likesPages: Record<string, string> = {
    '0': page('1700000000001', ['7300000000000000001', '7300000000000000002'], true),
    '1700000000001': page('0', ['7300000000000000003'], false),
  };
  const request = async (op: 'self' | 'likes' | 'favorites', params: Record<string, string>) => {
    calls.push({ op, params });
    if (op === 'self') {
      return {
        status: 200,
        body: JSON.stringify({ status_code: 0, user: { uid: 123, sec_uid: 'MS4wLjABAAAA_sec_uid_1', nickname: '我' } }),
      };
    }
    if (op === 'likes') {
      const body = likesPages[params.max_cursor];
      assert.ok(body, `unexpected max_cursor ${params.max_cursor}`);
      return { status: 200, body };
    }
    return { status: 200, body: page('0', ['7400000000000000001'], false) };
  };

  const imports: LibraryImport[] = [];
  const result = await syncDouyinLibrary(request, async (file) => { imports.push(file); });

  assert.deepEqual(result, { liked: 3, saved: 1 });
  // The first likes request must carry sec_user_id and paginate on max_cursor.
  const firstLike = calls.find((c) => c.op === 'likes')!;
  assert.equal(firstLike.params.sec_user_id, 'MS4wLjABAAAA_sec_uid_1');
  assert.equal(firstLike.params.max_cursor, '0');
  assert.equal(firstLike.params.count, '18');
  // Second likes page advances on max_cursor.
  const likeCalls = calls.filter((c) => c.op === 'likes');
  assert.equal(likeCalls[1].params.max_cursor, '1700000000001');
  // Favourites uses cursor.
  const fav = calls.find((c) => c.op === 'favorites')!;
  assert.equal(fav.params.cursor, '0');
  assert.equal(fav.params.count, '20');

  assert.equal(imports.length, 2);
  assert.equal(imports[0].source, 'likes');
  assert.equal(imports[0].works.length, 3);
  assert.equal(imports[1].source, 'favorites');
  assert.equal(imports[1].works.length, 1);
});

test('syncDouyinLibrary refuses to sync when the session has no sec_uid', async () => {
  const request = async (_op: 'self' | 'likes' | 'favorites') => ({
    status: 200,
    body: JSON.stringify({ status_code: 0, user: { uid: 1, nickname: 'x' } }),
  });
  await assert.rejects(() => syncDouyinLibrary(request, async () => {}), /重新登录/);
});
