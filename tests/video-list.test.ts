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

test('parseVideoList stops gracefully when the cursor no longer advances', () => {
  const stalled = JSON.stringify({
    status_code: 0,
    has_more: 1,
    max_cursor: 1699,
    aweme_list: [
      { aweme_id: '7300000000000000009', desc: 'x', create_time: 1690000000, author: { nickname: 'a' }, video: { cover: { url_list: ['https://p3.douyinpic.com/c.jpeg'] } } },
    ],
  });
  const page = parseVideoList(stalled, '1699');
  assert.equal(page.items.length, 1);
  assert.equal(page.nextCursor, null);
  assert.equal(page.hasMore, false);
});

test('parseVideoList preserves article title and head poster cover when desc is empty', () => {
  const articleList = JSON.stringify({
    status_code: 0,
    has_more: 0,
    max_cursor: '0',
    aweme_list: [
      {
        aweme_id: '7709124097083905018',
        aweme_type: 163,
        desc: '',
        create_time: 1794920326,
        author: { nickname: '相思' },
        article_info: {
          article_title: '没话题就聊这些',
          fe_data: JSON.stringify({
            head_poster_list: { url_list: ['https://p9-sign.douyinpic.com/header.jpeg'] },
          }),
        },
      },
    ],
  });
  const page = parseVideoList(articleList, '0');
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].title, '没话题就聊这些');
  assert.equal(page.items[0].coverUrl, 'https://p9-sign.douyinpic.com/header.jpeg');
  assert.equal(page.items[0].kind, 'gallery');
});
