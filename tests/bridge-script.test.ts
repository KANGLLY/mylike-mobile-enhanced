import { equal, ok } from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

import { buildBridgeScript } from '../src/douyin-bridge.ts';

// Regression guard for the Hermes bug: the injected runner must be a real,
// self-contained script (a literal string), never a function .toString() — which
// Hermes renders as `function f(){ [bytecode] }`. We prove it both by inspecting
// the text and by actually executing it against a stubbed page environment.
test('injected bridge script is self-contained and executes the fetch end to end', async () => {
  const script = buildBridgeScript({
    id: 'r1',
    operation: 'comments',
    parameters: { aweme_id: '1234567890123456789', cursor: '0', count: '20' },
    timeout: 5_000,
  });

  ok(!script.includes('[bytecode]'), 'must not contain a Hermes bytecode placeholder');
  ok(script.includes('mylikeRequest'), 'must inline the page request runner');
  ok(script.includes('/aweme/v1/web/comment/list/'), 'must contain the comment path');

  const captured: string[] = [];
  let requestedUrl = '';
  const resultBody = '{"status_code":0,"has_more":0,"comments":[]}';

  const context = {
    window: { ReactNativeWebView: { postMessage: (value: string) => captured.push(value) } },
    navigator: {
      language: 'zh-CN', platform: 'Win32', onLine: true, hardwareConcurrency: 8,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    },
    document: { cookie: 'msToken=tok%2B1; other=2' },
    screen: { width: 1280, height: 800 },
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: (url: string) => {
      requestedUrl = url;
      return Promise.resolve({ status: 200, text: () => Promise.resolve(resultBody) });
    },
  };

  runInNewContext(script, context, { timeout: 2_000 });
  await new Promise(resolve => setTimeout(resolve, 60));

  equal(captured.length, 1, 'the script must post exactly one bridge message');
  const message = JSON.parse(captured[0]!);
  equal(message.__mylike, true);
  equal(message.id, 'r1');
  equal(message.status, 200);
  equal(message.body, resultBody);
  ok(message.error === undefined || message.error === '');

  ok(requestedUrl.startsWith('https://www.douyin.com/aweme/v1/web/comment/list/?'), 'hits the comment endpoint');
  ok(requestedUrl.includes('aweme_id=1234567890123456789'), 'keeps the 64-bit id intact');
  ok(requestedUrl.includes('msToken=tok%2B1'), 'forwards the decoded msToken');
  ok(requestedUrl.includes('pc_client_type=1'), 'adds desktop client params');
});

test('a page-side exception is reported as SCRIPT_ERROR with its message', async () => {
  const script = buildBridgeScript({ id: 'r2', operation: 'self', parameters: {}, timeout: 5_000 });
  const captured: string[] = [];
  const context = {
    window: { ReactNativeWebView: { postMessage: (value: string) => captured.push(value) } },
    navigator: { language: 'zh-CN', platform: 'Win32', onLine: true, userAgent: 'Chrome/123' },
    document: { cookie: '' },
    screen: { width: 1280, height: 800 },
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
    // Throw synchronously inside the promise executor's fetch chain.
    fetch: () => { throw new Error('boom-fetch'); },
  };

  runInNewContext(script, context, { timeout: 2_000 });
  await new Promise(resolve => setTimeout(resolve, 60));

  equal(captured.length, 1);
  const message = JSON.parse(captured[0]!);
  equal(message.error, 'SCRIPT_ERROR');
  ok(String(message.message).includes('boom-fetch'));
});

test('likes reads use a GET with count and msToken on the favorite endpoint', async () => {
  const script = buildBridgeScript({ id: 'r3', operation: 'likes', parameters: { cursor: '0', count: '20' }, timeout: 5_000 });
  const captured: string[] = [];
  let requestedUrl = '';
  const context = {
    window: { ReactNativeWebView: { postMessage: (value: string) => captured.push(value) } },
    navigator: {
      language: 'zh-CN', platform: 'Win32', onLine: true, hardwareConcurrency: 8,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    },
    document: { cookie: 'msToken=tok' },
    screen: { width: 1280, height: 800 },
    URLSearchParams, AbortController, setTimeout, clearTimeout,
    fetch: (url: string) => { requestedUrl = url; return Promise.resolve({ status: 200, text: () => Promise.resolve('{"status_code":0,"has_more":0,"aweme_list":[]}') }); },
  };
  runInNewContext(script, context, { timeout: 2_000 });
  await new Promise(resolve => setTimeout(resolve, 60));
  equal(captured.length, 1);
  ok(requestedUrl.startsWith('https://www.douyin.com/aweme/v1/web/aweme/favorite/?'), 'hits the likes endpoint');
  ok(requestedUrl.includes('count=20'));
  ok(requestedUrl.includes('msToken=tok'));
});

test('comment replies are signed exactly like the comment list (regression: replies need msToken + fingerprint + referrer)', async () => {
  const script = buildBridgeScript({ id: 'r5', operation: 'commentReplies', parameters: { item_id: '7708361831513969811', comment_id: '7708474744363270961', cursor: '0', count: '20', item_type: '0' }, timeout: 5_000 });
  const captured: string[] = [];
  let requestedUrl = ''; let init: any = null;
  const context = {
    window: { ReactNativeWebView: { postMessage: (value: string) => captured.push(value) } },
    navigator: {
      language: 'zh-CN', platform: 'Win32', onLine: true, hardwareConcurrency: 8,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    },
    document: { cookie: 'msToken=tok' },
    screen: { width: 1280, height: 800 },
    URLSearchParams, AbortController, setTimeout, clearTimeout,
    fetch: (url: string, options: any) => { requestedUrl = url; init = options; return Promise.resolve({ status: 200, text: () => Promise.resolve('{"status_code":0,"has_more":0,"comments":[]}') }); },
  };
  runInNewContext(script, context, { timeout: 2_000 });
  await new Promise(resolve => setTimeout(resolve, 60));
  equal(captured.length, 1);
  ok(requestedUrl.startsWith('https://www.douyin.com/aweme/v1/web/comment/list/reply/?'), 'hits the reply endpoint');
  ok(requestedUrl.includes('item_id=7708361831513969811'), 'keeps the aweme id');
  ok(requestedUrl.includes('comment_id=7708474744363270961'), 'keeps the 19-digit comment id intact');
  ok(requestedUrl.includes('pc_client_type=1'), 'adds the desktop fingerprint (the bug: replies skipped this)');
  ok(requestedUrl.includes('msToken=tok'), 'forwards msToken (the bug: replies skipped this)');
  equal(init.referrer, 'https://www.douyin.com/video/7708361831513969811');
});

test('favourites reads POST cursor/count with the csrf downgrade header', async () => {
  const script = buildBridgeScript({ id: 'r4', operation: 'favorites', parameters: { cursor: '0', count: '20' }, timeout: 5_000 });
  const captured: string[] = [];
  let requestedUrl = ''; let init: any = null;
  const context = {
    window: { ReactNativeWebView: { postMessage: (value: string) => captured.push(value) } },
    navigator: {
      language: 'zh-CN', platform: 'Win32', onLine: true, hardwareConcurrency: 8,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    },
    document: { cookie: 'msToken=tok' },
    screen: { width: 1280, height: 800 },
    URLSearchParams, AbortController, setTimeout, clearTimeout,
    fetch: (url: string, options: any) => { requestedUrl = url; init = options; return Promise.resolve({ status: 200, text: () => Promise.resolve('{"status_code":0,"has_more":0,"aweme_list":[]}') }); },
  };
  runInNewContext(script, context, { timeout: 2_000 });
  await new Promise(resolve => setTimeout(resolve, 60));
  equal(captured.length, 1);
  ok(requestedUrl.startsWith('https://www.douyin.com/aweme/v1/web/aweme/listcollection/?'), 'hits the favourites endpoint');
  ok(requestedUrl.includes('publish_video_strategy_type=2'));
  equal(init.method, 'POST');
  equal(init.headers['x-secsdk-csrf-token'], 'DOWNGRADE');
  equal(init.body, 'cursor=0&count=20');
});
