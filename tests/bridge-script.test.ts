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
