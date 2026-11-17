import type { DanmakuItem } from '../douyin-bridge';

export const EMOJI_SPLIT = /(\[[^\]\n]{1,8}\])/g;
// Base screen-crossing cadence at 1× — measured from the Douyin reference recording.
export const MS_PER_SCREEN = 5333;

export type DanmakuPart = { kind: 'text'; value: string } | { kind: 'emoji'; uri: string };

export type FlyingBullet = {
  id: string;
  text: string;
  lane: number;
  spawnClock: number;
  speedFactor: number;
  width: number;
  measured: boolean;
};

export type DanmakuMetrics = {
  lineHeight: number;
  emojiSize: number;
  laneHeight: number;
  gap: number;
  laneCount: number;
};

/** Split danmaku text into plain text runs and inline native emoji tokens. */
export function splitDanmakuParts(text: string, map: Record<string, string>): DanmakuPart[] {
  const parts: DanmakuPart[] = [];
  for (const chunk of text.split(EMOJI_SPLIT)) {
    if (!chunk) continue;
    const uri = map[chunk];
    if (uri) parts.push({ kind: 'emoji', uri });
    else parts.push({ kind: 'text', value: chunk });
  }
  return parts;
}

/** Compute vertical lane geometry, horizontal gap, and usable lane count. */
export function danmakuMetrics(fontSize: number, height: number, lines: number): DanmakuMetrics {
  const safeFont = Math.max(10, fontSize);
  const lineHeight = Math.ceil(safeFont * 1.25);
  const emojiSize = safeFont + 4;
  const laneHeight = Math.max(lineHeight + 8, emojiSize + 8);
  const gap = Math.max(44, Math.round(safeFont * 2.6));
  const laneCount = Math.max(1, Math.min(Math.max(1, lines), Math.floor(Math.max(0, height - 4) / laneHeight)));
  return { lineHeight, emojiSize, laneHeight, gap, laneCount };
}

/**
 * Douyin-style length-proportional speed factor: shorter bullets glide gently
 * while longer bullets move briskly so they don't clog a lane, clamped to keep
 * all bullets comfortably readable.
 */
export function bulletSpeedFactor(bulletWidth: number, screenWidth: number): number {
  if (screenWidth <= 0) return 1;
  const raw = (screenWidth + Math.max(0, bulletWidth)) / (screenWidth + 100);
  return Math.max(0.92, Math.min(1.55, raw));
}

/** Base pixel velocity (px per 1× clock ms) before per-bullet speedFactor. */
export function baseSpeedPxPerMs(screenWidth: number): number {
  if (screenWidth <= 0) return 0;
  return screenWidth / MS_PER_SCREEN;
}

/**
 * Conservative initial width estimate before native onLayout reports the real
 * rendered pixel width. Handles CJK, inline "[emoji]" images, and surrogate-pair
 * Unicode emojis so the first-frame reservation never underestimates.
 */
export function estimateBulletWidth(text: string, map: Record<string, string>, fontSize: number): number {
  let width = 14;
  for (const chunk of text.split(EMOJI_SPLIT)) {
    if (!chunk) continue;
    if (map[chunk]) {
      width += fontSize + 6;
      continue;
    }
    for (const ch of chunk) {
      const code = ch.codePointAt(0) ?? 0;
      if (code > 0xffff) width += Math.ceil(fontSize * 1.35);
      else if (/[\u2e80-\u9fff\uff00-\uffef\u3000-\u303f]/.test(ch)) width += fontSize + 2;
      else if (ch === ' ') width += Math.ceil(fontSize * 0.4);
      else width += Math.ceil(fontSize * 0.68);
    }
  }
  return width;
}

/** Screen X coordinate (left edge) of a bullet given the shared 1× clockMs. */
export function bulletX(bullet: Pick<FlyingBullet, 'spawnClock' | 'speedFactor'>, clockMs: number, screenWidth: number): number {
  const v = baseSpeedPxPerMs(screenWidth) * bullet.speedFactor;
  return screenWidth - v * (clockMs - bullet.spawnClock);
}

/** Whether a bullet has completely exited the left side of the viewport. */
export function isBulletOffscreen(bullet: Pick<FlyingBullet, 'spawnClock' | 'speedFactor' | 'width'>, clockMs: number, screenWidth: number): boolean {
  const v = baseSpeedPxPerMs(screenWidth) * bullet.speedFactor;
  if (v <= 0) return false;
  return v * (clockMs - bullet.spawnClock) > screenWidth + bullet.width + 40;
}

/**
 * Earliest spawnClock for a candidate bullet with `nextFactor` to follow `prev`
 * in the same lane while keeping horizontal distance >= `gap` at entry AND
 * everywhere on screen until `prev` exits the left edge (prevents fast long
 * bullets from catching up to slower short bullets).
 */
export function minFollowClock(
  prev: Pick<FlyingBullet, 'spawnClock' | 'speedFactor' | 'width'>,
  nextFactor: number,
  screenWidth: number,
  gap: number,
): number {
  const base = baseSpeedPxPerMs(screenWidth);
  if (base <= 0) return Infinity;
  const vPrev = base * prev.speedFactor;
  const vNext = base * nextFactor;
  const entryClear = prev.spawnClock + (prev.width + gap) / vPrev;
  const exitSafe = prev.spawnClock + (screenWidth + prev.width + gap) / vPrev - screenWidth / vNext;
  return Math.max(entryClear, exitSafe);
}

/**
 * Pick the free lane (0..laneCount-1) that has been clear for the longest time
 * for a candidate bullet of speed `nextFactor`.
 */
export function pickFreeLane(
  flying: readonly FlyingBullet[],
  laneCount: number,
  clockMs: number,
  screenWidth: number,
  gap: number,
  nextFactor = 1,
): number {
  const latestByLane = new Array<FlyingBullet | null>(laneCount).fill(null);
  for (const bullet of flying) {
    if (bullet.lane < 0 || bullet.lane >= laneCount) continue;
    const prev = latestByLane[bullet.lane];
    if (!prev || bullet.spawnClock > prev.spawnClock) latestByLane[bullet.lane] = bullet;
  }
  let bestLane = -1;
  let earliestClear = Infinity;
  for (let lane = 0; lane < laneCount; lane += 1) {
    const last = latestByLane[lane];
    const clearAt = last ? minFollowClock(last, nextFactor, screenWidth, gap) : -Infinity;
    if (clearAt <= clockMs && clearAt < earliestClear) {
      earliestClear = clearAt;
      bestLane = lane;
    }
  }
  return bestLane;
}

/**
 * Keep same-lane bullets separated by at least `gap` (both at entry and before
 * exit) after native onLayout width measurement or a live font-size increase.
 */
export function reconcileLaneSpacing(flying: readonly FlyingBullet[], screenWidth: number, gap: number): FlyingBullet[] {
  if (screenWidth <= 0) return [...flying];
  const byLane = new Map<number, FlyingBullet[]>();
  for (const bullet of flying) {
    const list = byLane.get(bullet.lane);
    if (list) list.push(bullet);
    else byLane.set(bullet.lane, [bullet]);
  }
  let changed = false;
  const adjusted = new Map<string, FlyingBullet>();
  for (const laneBullets of byLane.values()) {
    if (laneBullets.length < 2) continue;
    laneBullets.sort((a, b) => a.spawnClock - b.spawnClock);
    let prev = laneBullets[0];
    for (let i = 1; i < laneBullets.length; i += 1) {
      const curr = laneBullets[i];
      const minSpawn = minFollowClock(prev, curr.speedFactor, screenWidth, gap);
      if (curr.spawnClock < minSpawn) {
        const updated = { ...curr, spawnClock: minSpawn };
        adjusted.set(curr.id, updated);
        prev = updated;
        changed = true;
      } else {
        prev = curr;
      }
    }
  }
  return changed ? flying.map(bullet => adjusted.get(bullet.id) ?? bullet) : [...flying];
}

/** Update a bullet's width from native onLayout and preserve same-lane gap. */
export function applyMeasuredWidth(
  flying: readonly FlyingBullet[],
  id: string,
  measuredWidth: number,
  screenWidth: number,
  gap: number,
): FlyingBullet[] {
  if (!Number.isFinite(measuredWidth) || measuredWidth <= 0) return [...flying];
  const rounded = Math.ceil(measuredWidth);
  let hit = false;
  const next = flying.map(bullet => {
    if (bullet.id !== id) return bullet;
    if (bullet.measured && bullet.width === rounded) return bullet;
    hit = true;
    return { ...bullet, width: rounded, measured: true };
  });
  return hit ? reconcileLaneSpacing(next, screenWidth, gap) : next;
}

/**
 * Prune offscreen / out-of-range bullets and admit due bullets into free lanes
 * using the shared UI clockMs as the single collision authority.
 */
export function stepDanmaku({
  items,
  carryOver,
  fired,
  flying,
  nowMs,
  clockMs,
  screenWidth,
  laneCount,
  fontSize,
  gap,
  emojiMap,
  epoch = 0,
}: {
  items: readonly DanmakuItem[];
  carryOver?: DanmakuItem[];
  fired: Set<string>;
  flying: readonly FlyingBullet[];
  nowMs: number;
  clockMs: number;
  screenWidth: number;
  laneCount: number;
  fontSize: number;
  gap: number;
  emojiMap: Record<string, string>;
  epoch?: number;
}): { flying: FlyingBullet[]; changed: boolean } {
  let changed = false;
  const next: FlyingBullet[] = [];
  for (const bullet of flying) {
    if (bullet.lane >= laneCount || isBulletOffscreen(bullet, clockMs, screenWidth)) {
      changed = true;
      continue;
    }
    next.push(bullet);
  }

  if (screenWidth <= 0 || laneCount <= 0) {
    return { flying: changed ? next : [...flying], changed };
  }

  // Drain tail bullets carried over from the ending loop before admitting new-loop items.
  if (carryOver && carryOver.length > 0) {
    for (let i = 0; i < carryOver.length; ) {
      const item = carryOver[i];
      const width = estimateBulletWidth(item.text, emojiMap, fontSize);
      const speedFactor = bulletSpeedFactor(width, screenWidth);
      const lane = pickFreeLane(next, laneCount, clockMs, screenWidth, gap, speedFactor);
      if (lane < 0) {
        i += 1;
        continue;
      }
      carryOver.splice(i, 1);
      next.push({ id: item.id, text: item.text, lane, spawnClock: clockMs, speedFactor, width, measured: false });
      changed = true;
    }
  }

  for (const item of items) {
    if (fired.has(item.id)) continue;
    if (item.offsetMs > nowMs) break;
    if (nowMs - item.offsetMs > 4000) {
      fired.add(item.id);
      continue;
    }
    const width = estimateBulletWidth(item.text, emojiMap, fontSize);
    const speedFactor = bulletSpeedFactor(width, screenWidth);
    const lane = pickFreeLane(next, laneCount, clockMs, screenWidth, gap, speedFactor);
    if (lane < 0) continue;
    fired.add(item.id);
    const uid = epoch > 0 ? `${item.id}#${epoch}` : item.id;
    next.push({ id: uid, text: item.text, lane, spawnClock: clockMs, speedFactor, width, measured: false });
    changed = true;
  }

  return { flying: changed ? next : [...flying], changed };
}
