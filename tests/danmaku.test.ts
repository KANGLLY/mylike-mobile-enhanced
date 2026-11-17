import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDanmakuList } from '../src/douyin-bridge.ts';

test('parseDanmakuList maps danmaku_list to timed items', () => {
  const body = JSON.stringify({
    status_code: 0,
    total: 2,
    danmaku_list: [
      { danmaku_id: '111', text: '第一条', offset_time: 1234, danmaku_type: 0 },
      { danmaku_id: 222, text: '  第二条  ', offset_time: '5000', danmaku_type: 1 },
    ],
  });
  const page = parseDanmakuList(body);
  assert.equal(page.items.length, 2);
  assert.equal(page.items[0].id, '111');
  assert.equal(page.items[0].text, '第一条');
  assert.equal(page.items[0].offsetMs, 1234);
  assert.equal(page.items[1].id, '222');
  assert.equal(page.items[1].text, '第二条');
  assert.equal(page.items[1].offsetMs, 5000);
});

test('parseDanmakuList treats an empty body as no danmaku', () => {
  const page = parseDanmakuList('');
  assert.deepEqual(page, { items: [], total: 0 });
});

test('parseDanmakuList ignores a trailing log object after the payload', () => {
  const body = '{"status_code":0,"total":1,"danmaku_list":[{"danmaku_id":"2","text":"哟","offset_time":500}]}{"log_pb":{"impr_id":"x"}}';
  const page = parseDanmakuList(body);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].text, '哟');
});
