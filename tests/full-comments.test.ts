import { deepEqual, equal, ok, throws } from 'node:assert/strict';
import { test } from 'node:test';

import { buildBridgeScript, parseBridgeMessage, parseCommentList, parseSelf } from '../src/douyin-bridge.ts';

const WORK_ID = '7637322941528689935';
const CID = '7637322941528689937';
const NEXT_CURSOR = '1700000000000000002';

const pageBody = (extra: Record<string, unknown> = {}) => JSON.stringify({
  status_code: 0,
  has_more: 1,
  cursor: NEXT_CURSOR,
  comments: [
    {
      cid: CID,
      aweme_id: WORK_ID,
      text: '  第一条评论  ',
      user: { nickname: ' 张三 ', avatar_thumb: { url_list: ['http://unsafe.test/a', 'https://images.example.test/avatar.jpg'] } },
      create_time: 1_700_000_000,
      digg_count: 5,
      reply_comment_total: 2,
      ip_label: '广东',
      image_list: [{ url_list: ['http://unsafe.test/p', 'https://images.example.test/p1.jpg'] }],
    },
  ],
  ...extra,
});

test('parseCommentList maps a page into typed comments and keeps the cursor', () => {
  const page = parseCommentList(pageBody(), WORK_ID, '0');
  equal(page.hasMore, true);
  equal(page.nextCursor, NEXT_CURSOR);
  equal(page.items.length, 1);
  const comment = page.items[0]!;
  equal(comment.id, CID);
  equal(comment.workId, WORK_ID);
  equal(comment.text, '第一条评论');
  equal(comment.nickname, '张三');
  equal(comment.avatar, 'https://images.example.test/avatar.jpg');
  equal(comment.createdAt, 1_700_000_000_000);
  equal(comment.likes, 5);
  equal(comment.replyCount, 2);
  equal(comment.region, '广东');
  deepEqual(comment.attachments, [{ url: 'https://images.example.test/p1.jpg', type: 'image' }]);
});

test('parseCommentList treats a null list with has_more=0 as genuinely empty', () => {
  const page = parseCommentList('{"status_code":0,"has_more":0,"comments":null}', WORK_ID, '0');
  deepEqual(page.items, []);
  equal(page.hasMore, false);
  equal(page.nextCursor, null);
});

test('parseCommentList reports auth, rate-limit, bad-JSON and mismatch failures', () => {
  throws(() => parseCommentList('', WORK_ID, '0', 401), /重新登录/);
  throws(() => parseCommentList('{"status_code":0}', WORK_ID, '0', 429), /频繁/);
  throws(() => parseCommentList('not json at all', WORK_ID, '0'), /有效 JSON/);
  throws(() => parseCommentList('{"status_code":5,"has_more":0}', WORK_ID, '0'), /登录后仍/);
  const mismatched = pageBody({ comments: [{ cid: CID, aweme_id: '999', text: 'x', user: { nickname: 'a' } }] });
  throws(() => parseCommentList(mismatched, WORK_ID, '0'), /当前作品不一致/);
});

test('parseCommentList rejects a stalled cursor', () => {
  throws(() => parseCommentList(pageBody({ cursor: NEXT_CURSOR }), WORK_ID, NEXT_CURSOR), /没有推进/);
});

test('parseSelf recognises a logged-in profile and rejects anonymous responses', () => {
  deepEqual(parseSelf('{"status_code":0,"user":{"uid":12345678901234567890,"nickname":"我自己"}}'), { loggedIn: true, nickname: '我自己' });
  equal(parseSelf('{"status_code":5}').loggedIn, false);
  equal(parseSelf('<html>login</html>').loggedIn, false);
  equal(parseSelf('', 401).loggedIn, false);
});

test('buildBridgeScript embeds the page function, request id and message bridge', () => {
  const script = buildBridgeScript({ id: 'r1', operation: 'comments', parameters: { aweme_id: WORK_ID, cursor: '0', count: '20' }, timeout: 15_000 });
  ok(script.startsWith('(function(){'));
  ok(script.includes('/aweme/v1/web/comment/list/'));
  ok(script.includes('device_platform'));
  ok(script.includes('ReactNativeWebView.postMessage'));
  ok(script.includes('r1'));
});

test('parseBridgeMessage accepts only well-formed bridge messages', () => {
  const result = parseBridgeMessage(JSON.stringify({ __mylike: true, id: 'r7', status: 200, body: '{"ok":1}', error: '' }));
  ok(result);
  equal(result!.id, 'r7');
  equal(result!.status, 200);
  equal(result!.body, '{"ok":1}');
  equal(result!.error, undefined);
  equal(parseBridgeMessage('not-json'), null);
  equal(parseBridgeMessage(JSON.stringify({ id: 'r7' })), null);
});
