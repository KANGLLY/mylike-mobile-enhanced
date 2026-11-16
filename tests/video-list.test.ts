import assert from 'node:assert/strict';
import test from 'node:test';
import { parseVideoList } from '../src/douyin-bridge.ts';

const likePage = JSON.stringify({
  status_code: 0,
  has_more: 1,
  max_cursor: 1699999999999,
  aweme_list: [
    {
      aweme_id: '7300000000000000001',
      desc: '一条视频',
      create_time: 1690000000,
      author: { nickname: '作者A' },
      video: { cover: { url_list: ['https://p3.douyinpic.com/cover.jpeg'] } },
    },
    {
      aweme_id: '7300000000000000002',
      desc: '图集',
      create_time: 1690000000,
      images: [{ url_list: ['https://p3.douyinpic.com/img.jpeg'] }],
      author: { nickname: '作者B' },
    },
  ],
});

test('parseVideoList maps aweme_list, cover, kind and cursor', () => {
  const page = parseVideoList(likePage, '0');
  assert.equal(page.items.length, 2);
  assert.equal(page.items[0].id, '7300000000000000001');
  assert.equal(page.items[0].kind, 'video');
  assert.equal(page.items[0].coverUrl, 'https://p3.douyinpic.com/cover.jpeg');
  assert.equal(page.items[1].kind, 'gallery');
  assert.equal(page.hasMore, true);
  assert.equal(page.nextCursor, '1699999999999');
});

test('parseVideoList trims trailing log after the first JSON object', () => {
  const page = parseVideoList(`${likePage}\n$log=abc`, '0');
  assert.equal(page.items.length, 2);
});

test('parseVideoList reports an expired login', () => {
  assert.throws(() => parseVideoList('', '0', 401), /登录/);
});
