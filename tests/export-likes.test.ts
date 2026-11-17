import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLikesLibrary } from '../src/mobile/export-likes-format.ts';
import { decodeLibrary } from '../src/library-format.ts';

test('likes export is a valid PC-importable mylike.library v2 file', () => {
  const json = buildLikesLibrary([
    { id: '7708361831513969811', title: '标题', author: '作者', publishedAt: 1700000000000, kind: 'video', coverUrl: 'https://p3.douyinpic.com/x.jpg' },
    { id: '123', title: '图集', author: 'A', publishedAt: null, kind: 'gallery', coverUrl: null },
  ], 1700000005000);
  const parsed = JSON.parse(json) as Record<string, any>;
  assert.equal(parsed.format, 'mylike.library');
  assert.equal(parsed.version, 2);
  assert.equal(parsed.source.kind, 'douyin.likes');
  assert.equal(parsed.order, 'desktop-liked');
  assert.equal(parsed.items.length, 2);
  const decoded = decodeLibrary(json);
  assert.equal(decoded.source, 'likes');
  assert.equal(decoded.works.length, 2);
  assert.equal(decoded.works[0]!.publishedAt, 1700000000000);
});

test('likes export skips invalid ids and de-duplicates', () => {
  const json = buildLikesLibrary([
    { id: 'abc', title: 'x', author: 'y', publishedAt: null, kind: 'video', coverUrl: null },
    { id: '55', title: 'x', author: 'y', publishedAt: null, kind: 'video', coverUrl: null },
    { id: '55', title: 'dup', author: 'y', publishedAt: null, kind: 'video', coverUrl: null },
  ]);
  const parsed = JSON.parse(json) as Record<string, any>;
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].id, '55');
});
