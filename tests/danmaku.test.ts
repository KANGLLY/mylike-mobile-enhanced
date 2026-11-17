import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDanmakuList, type DanmakuItem } from '../src/douyin-bridge.ts';
import {
  applyMeasuredWidth,
  bulletSpeedFactor,
  bulletX,
  danmakuMetrics,
  minFollowClock,
  pickFreeLane,
  splitDanmakuParts,
  stepDanmaku,
  type FlyingBullet,
} from '../src/mobile/danmaku-engine.ts';

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

test('douyin-style bullet speed gives longer bullets higher velocity without catch-up overlap', () => {
  const width = 390;
  const shortFactor = bulletSpeedFactor(40, width);
  const longFactor = bulletSpeedFactor(320, width);
  assert.ok(longFactor > shortFactor);

  // Even when a fast long bullet follows a slower short bullet on the same lane,
  // minFollowClock guarantees gap >= 44 across the entire visible screen [0, width].
  const gap = 44;
  const prev: FlyingBullet = { id: 'short', text: '666', lane: 0, spawnClock: 0, speedFactor: shortFactor, width: 40, measured: true };
  const spawnLong = minFollowClock(prev, longFactor, width, gap);
  const next: FlyingBullet = { id: 'long', text: '这是一条非常长非常长的弹幕用来测试追尾', lane: 0, spawnClock: spawnLong, speedFactor: longFactor, width: 320, measured: true };

  for (let clock = spawnLong; clock <= spawnLong + 8000; clock += 50) {
    const prevRight = bulletX(prev, clock, width) + prev.width;
    const nextLeft = bulletX(next, clock, width);
    if (prevRight > 0 && nextLeft < width) {
      assert.ok(nextLeft - prevRight >= gap - 1e-6, `catch-up overlap at clock=${clock}: gap=${nextLeft - prevRight}`);
    }
  }
});

test('same-lane bullets never overlap across speeds, 2x playback boost, line counts, and font sizes', () => {
  const screenWidth = 390;
  const height = 640;
  const emojiMap = { '[微笑]': 'https://example.com/smile.png' };
  const burst: DanmakuItem[] = Array.from({ length: 48 }, (_, i) => ({
    id: `d-${i}`,
    text: i % 3 === 0 ? '哈哈哈[微笑]太好笑了🔥这是一条很长很长的弹幕' : i % 2 === 0 ? '前方高能预警请注意' : '666',
    offsetMs: Math.floor(i / 4) * 200,
  }));

  for (const speed of [1, 1.5, 2]) {
    for (const playbackRate of [1, 2]) {
      for (const lines of [3, 6]) {
        for (const fontSize of [16, 22]) {
          const metrics = danmakuMetrics(fontSize, height, lines);
          const fired = new Set<string>();
          let flying: FlyingBullet[] = [];
          let clockMs = 0;

          for (let wallMs = 0; wallMs <= 12000; wallMs += 50) {
            clockMs += 50 * speed * playbackRate;
            const nowMs = wallMs * playbackRate;
            const res = stepDanmaku({
              items: burst,
              fired,
              flying,
              nowMs,
              clockMs,
              screenWidth,
              laneCount: metrics.laneCount,
              fontSize,
              gap: metrics.gap,
              emojiMap,
            });
            flying = res.flying;

            for (const b of flying) {
              if (!b.measured) {
                flying = applyMeasuredWidth(flying, b.id, b.width + 12, screenWidth, metrics.gap);
              }
            }

            const byLane = new Map<number, FlyingBullet[]>();
            for (const b of flying) {
              assert.ok(b.lane >= 0 && b.lane < metrics.laneCount);
              const list = byLane.get(b.lane) ?? [];
              list.push(b);
              byLane.set(b.lane, list);
            }
            for (const list of byLane.values()) {
              list.sort((a, b) => bulletX(a, clockMs, screenWidth) - bulletX(b, clockMs, screenWidth));
              for (let i = 1; i < list.length; i += 1) {
                const prevRight = bulletX(list[i - 1], clockMs, screenWidth) + list[i - 1].width;
                const currLeft = bulletX(list[i], clockMs, screenWidth);
                assert.ok(currLeft - prevRight >= metrics.gap - 1e-6, `overlap at speed=${speed}, rate=${playbackRate}, lines=${lines}, fontSize=${fontSize}: gap=${currLeft - prevRight}`);
              }
            }
          }
        }
      }
    }
  }
});

test('applyMeasuredWidth adjusts trailing bullet if font growth causes encroachment', () => {
  const screenWidth = 390;
  const gap = 44;
  let flying: FlyingBullet[] = [
    { id: '1', text: '第一条', lane: 0, spawnClock: 0, speedFactor: 1, width: 60, measured: true },
    { id: '2', text: '第二条', lane: 0, spawnClock: 1500, speedFactor: 1.2, width: 60, measured: true },
  ];
  flying = applyMeasuredWidth(flying, '1', 160, screenWidth, gap);
  assert.equal(flying[0].width, 160);
  assert.ok(flying[1].spawnClock >= minFollowClock(flying[0], flying[1].speedFactor, screenWidth, gap));
});

test('danmakuMetrics ensures vertical non-overlap and splitDanmakuParts preserves inline emojis', () => {
  for (const fontSize of [12, 16, 20, 22]) {
    const m = danmakuMetrics(fontSize, 600, 6);
    assert.ok(m.laneHeight > m.lineHeight);
    assert.ok(m.laneHeight > m.emojiSize);
    assert.ok(m.gap >= Math.ceil(fontSize * 0.5));
  }
  const parts = splitDanmakuParts('真棒[微笑]哈哈', { '[微笑]': 'https://e/1.png' });
  assert.deepEqual(parts, [
    { kind: 'text', value: '真棒' },
    { kind: 'emoji', uri: 'https://e/1.png' },
    { kind: 'text', value: '哈哈' },
  ]);
  assert.equal(pickFreeLane([], 3, 0, 390, 44, 1), 0);
});

test('loop carryOver drains trailing bullets and admits next-loop bullets without collision or key clash', () => {
  const screenWidth = 390;
  const gap = 44;
  const prevFlying: FlyingBullet[] = [
    { id: '1', text: '上一轮第一条', lane: 0, spawnClock: 1000, speedFactor: 1.05, width: 110, measured: true },
  ];
  const carryOver: DanmakuItem[] = [
    { id: '2#t1', text: '上一轮尾巴', offsetMs: 2800 },
  ];
  const nextLoopItems: DanmakuItem[] = [
    { id: '1', text: '上一轮第一条', offsetMs: 100 },
  ];
  const fired = new Set<string>();
  const res = stepDanmaku({
    items: nextLoopItems,
    carryOver,
    fired,
    flying: prevFlying,
    nowMs: 200,
    clockMs: 5000,
    screenWidth,
    laneCount: 3,
    fontSize: 16,
    gap,
    emojiMap: {},
    epoch: 1,
  });
  assert.equal(carryOver.length, 0);
  assert.equal(res.flying.length, 3);
  assert.deepEqual(res.flying.map(b => b.id), ['1', '2#t1', '1#1']);
  assert.equal(new Set(res.flying.map(b => b.id)).size, 3);
});
