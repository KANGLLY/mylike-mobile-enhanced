import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import { parseDanmakuList, type DanmakuItem } from '../douyin-bridge';
import { mediaHeaders } from '../douyin';
import { loadEmojiMap } from '../douyin-emoji';
import { useDouyinSession } from './douyin-session';
import {
  applyMeasuredWidth,
  danmakuMetrics,
  MS_PER_SCREEN,
  reconcileLaneSpacing,
  splitDanmakuParts,
  stepDanmaku,
  type FlyingBullet,
} from './danmaku-engine';

const CLOCK_HORIZON_MS = 3600_000;

const DanmakuBullet = memo(function DanmakuBullet({
  id, text, top, spawnClock, speedFactor, fontSize, lineHeight, emojiSize, emoji, widthSV, clockMsSV, onMeasure,
}: {
  id: string;
  text: string;
  top: number;
  spawnClock: number;
  speedFactor: number;
  fontSize: number;
  lineHeight: number;
  emojiSize: number;
  emoji: Record<string, string>;
  widthSV: SharedValue<number>;
  clockMsSV: SharedValue<number>;
  onMeasure: (id: string, width: number) => void;
}) {
  const spawnClockSV = useSharedValue(spawnClock);
  const speedFactorSV = useSharedValue(speedFactor);
  useEffect(() => { spawnClockSV.value = spawnClock; }, [spawnClock, spawnClockSV]);
  useEffect(() => { speedFactorSV.value = speedFactor; }, [speedFactor, speedFactorSV]);

  const animStyle = useAnimatedStyle(() => {
    const v = (widthSV.value / MS_PER_SCREEN) * speedFactorSV.value;
    return { transform: [{ translateX: widthSV.value - v * (clockMsSV.value - spawnClockSV.value) }] };
  });

  const parts = useMemo(() => splitDanmakuParts(text, emoji), [text, emoji]);

  return (
    <Animated.View
      onLayout={event => onMeasure(id, event.nativeEvent.layout.width)}
      style={[styles.bullet, { top }, animStyle]}
    >
      {parts.map((part, index) => part.kind === 'emoji'
        ? <Image key={index} source={{ uri: part.uri, headers: mediaHeaders }} style={{ width: emojiSize, height: emojiSize, marginHorizontal: 1 }} />
        : <Text key={index} allowFontScaling={false} numberOfLines={1} style={[styles.text, { fontSize, lineHeight }]}>{part.value}</Text>)}
    </Animated.View>
  );
});

export function DanmakuOverlay({ workId, seconds, durationMs, playing, playbackRate = 1, seekKey = 0, width, height, top, opacity = 80, fontSize = 16, speed = 1, lines = 6 }: {
  workId: string; seconds: number; durationMs: number; playing: boolean; playbackRate?: number; seekKey?: number; width: number; height: number; top: number;
  opacity?: number; fontSize?: number; speed?: number; lines?: number;
}) {
  const { request } = useDouyinSession();
  const [items, setItems] = useState<DanmakuItem[]>([]);
  const [flying, setFlying] = useState<FlyingBullet[]>([]);
  const [emoji, setEmoji] = useState<Record<string, string>>({});

  const fired = useRef<Set<string>>(new Set());
  const carryOverRef = useRef<DanmakuItem[]>([]);
  const carryExpireRef = useRef(0);
  const loopEpochRef = useRef(0);
  const flyingRef = useRef<FlyingBullet[]>([]);
  const itemsRef = useRef<DanmakuItem[]>(items); itemsRef.current = items;
  const emojiRef = useRef(emoji); emojiRef.current = emoji;
  const playingRef = useRef(playing); playingRef.current = playing;
  const playbackRateRef = useRef(playbackRate);
  const durationMsRef = useRef(durationMs); durationMsRef.current = durationMs;
  const widthRef = useRef(width); widthRef.current = width;
  const fontSizeRef = useRef(fontSize); fontSizeRef.current = fontSize;
  const fetchedWorkRef = useRef('');

  const metrics = useMemo(() => danmakuMetrics(fontSize, height, lines), [fontSize, height, lines]);
  const metricsRef = useRef(metrics); metricsRef.current = metrics;

  const clockMsSV = useSharedValue(0);
  const widthSV = useSharedValue(width);
  useEffect(() => { widthSV.value = width; }, [width, widthSV]);

  // Exact piecewise-linear clock mirrored between JS arithmetic and Reanimated
  // withTiming (native C++ animator), avoiding useFrameCallback restarts and
  // synchronous UI-thread locks while guaranteeing identical UI/JS positions.
  const clockAnchor = useRef({ baseClock: 0, baseWall: Date.now(), rate: 0 });
  const readClockMs = useCallback(() => {
    const { baseClock, baseWall, rate } = clockAnchor.current;
    return baseClock + (Date.now() - baseWall) * rate;
  }, []);

  const syncClockRate = useCallback((nextRate: number, resetZero = false) => {
    const nowWall = Date.now();
    const curClock = resetZero ? 0 : readClockMs();
    clockAnchor.current = { baseClock: curClock, baseWall: nowWall, rate: nextRate };
    cancelAnimation(clockMsSV);
    clockMsSV.value = curClock;
    if (nextRate > 0) {
      clockMsSV.value = withTiming(curClock + CLOCK_HORIZON_MS * nextRate, {
        duration: CLOCK_HORIZON_MS,
        easing: Easing.linear,
      });
    }
  }, [clockMsSV, readClockMs]);

  const effectiveRate = playing ? Math.max(0.1, speed) * Math.max(0.1, playbackRate) : 0;
  useEffect(() => {
    syncClockRate(effectiveRate);
  }, [effectiveRate, syncClockRate]);

  useEffect(() => () => { cancelAnimation(clockMsSV); }, [clockMsSV]);

  useEffect(() => {
    let alive = true;
    void loadEmojiMap().then(value => { if (alive) setEmoji(value); });
    return () => { alive = false; };
  }, []);

  // Reset state only when switching works (never on durationMs jitter).
  useEffect(() => {
    fetchedWorkRef.current = '';
    fired.current = new Set();
    carryOverRef.current = [];
    carryExpireRef.current = 0;
    loopEpochRef.current = 0;
    flyingRef.current = [];
    setFlying([]);
    setItems([]);
    syncClockRate(effectiveRate, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workId]);

  // Fetch the whole clip's danmaku once per work (window = [0, duration]).
  useEffect(() => {
    if (!workId || durationMs <= 0 || fetchedWorkRef.current === workId) return;
    fetchedWorkRef.current = workId;
    let alive = true;
    void (async () => {
      try {
        const response = await request('danmaku', {
          item_id: workId, duration: String(durationMs), start_time: '0', end_time: String(durationMs), item_type: '0',
        }, 10000);
        const page = parseDanmakuList(response.body, response.status);
        if (alive && page.items.length) {
          const sorted = [...page.items].sort((a, b) => a.offsetMs - b.offsetMs);
          setItems(sorted);
        }
      } catch {
        if (alive && fetchedWorkRef.current === workId) fetchedWorkRef.current = '';
      }
    })();
    return () => { alive = false; };
  }, [workId, durationMs, request]);

  // Smooth playhead anchor between 500ms timeUpdate ticks (and during long-press 2×
  // where FeedScreen defers time updates until finger release); on natural loop,
  // keep in-flight bullets gliding and carry over trailing items seamlessly.
  const playheadAnchor = useRef({ videoMs: seconds * 1000, wallMs: Date.now() });
  const lastSeconds = useRef(seconds);
  const lastSeekKey = useRef(seekKey);
  const wasPlaying = useRef(playing);
  useEffect(() => {
    const now = Date.now();
    const explicitSeek = seekKey !== lastSeekKey.current;
    const jumpedForward = seconds > lastSeconds.current + 2.5;
    const jumpedBackward = seconds < lastSeconds.current - 1.0;
    lastSeekKey.current = seekKey;

    if (explicitSeek || jumpedForward || jumpedBackward) {
      const durationSec = durationMsRef.current / 1000;
      const isNaturalLoop = !explicitSeek && jumpedBackward && seconds <= 1.5 && (durationSec <= 0 || lastSeconds.current >= Math.max(1.5, durationSec - 2.0));
      if (isNaturalLoop) {
        loopEpochRef.current += 1;
        const tailLimit = Math.max(durationMsRef.current, lastSeconds.current * 1000 + 500);
        const tail = itemsRef.current
          .filter(item => !fired.current.has(item.id) && item.offsetMs <= tailLimit)
          .slice(0, 12)
          .map(item => ({ ...item, id: `${item.id}#t${loopEpochRef.current}` }));
        carryOverRef.current = tail;
        carryExpireRef.current = now + 3000;
        fired.current = new Set();
      } else {
        loopEpochRef.current += 1;
        const targetMs = seconds * 1000;
        const nextFired = new Set<string>();
        for (const item of itemsRef.current) {
          if (item.offsetMs < targetMs - 2000) nextFired.add(item.id);
        }
        fired.current = nextFired;
        carryOverRef.current = [];
        carryExpireRef.current = 0;
        const { flying: immediate } = stepDanmaku({
          items: itemsRef.current,
          fired: fired.current,
          flying: [],
          nowMs: targetMs,
          clockMs: readClockMs(),
          screenWidth: widthRef.current,
          laneCount: metricsRef.current.laneCount,
          fontSize: fontSizeRef.current,
          gap: metricsRef.current.gap,
          emojiMap: emojiRef.current,
          epoch: loopEpochRef.current,
        });
        flyingRef.current = immediate;
        setFlying(immediate);
      }
      playheadAnchor.current = { videoMs: seconds * 1000, wallMs: now };
    } else if (seconds !== lastSeconds.current) {
      playheadAnchor.current = { videoMs: seconds * 1000, wallMs: now };
    } else if (playbackRate !== playbackRateRef.current && wasPlaying.current) {
      const elapsed = Math.max(0, now - playheadAnchor.current.wallMs);
      playheadAnchor.current = {
        videoMs: playheadAnchor.current.videoMs + elapsed * playbackRateRef.current,
        wallMs: now,
      };
    }
    lastSeconds.current = seconds;
    playbackRateRef.current = playbackRate;
    if (playing !== wasPlaying.current) {
      if (playing) playheadAnchor.current.wallMs = now;
      wasPlaying.current = playing;
    }
  }, [seconds, playing, playbackRate, seekKey, readClockMs]);

  // Apply live laneCount / gap / width changes immediately without waiting for the next tick.
  useEffect(() => {
    const prev = flyingRef.current;
    if (!prev.length) return;
    const filtered = prev.filter(bullet => bullet.lane < metrics.laneCount);
    const next = reconcileLaneSpacing(filtered, width, metrics.gap);
    const changed = next.length !== prev.length || next.some((bullet, i) => bullet !== prev[i]);
    if (changed) {
      flyingRef.current = next;
      setFlying(next);
    }
  }, [metrics.laneCount, metrics.gap, width]);

  const handleMeasure = useCallback((id: string, measuredWidth: number) => {
    const prev = flyingRef.current;
    const next = applyMeasuredWidth(prev, id, measuredWidth, widthRef.current, metricsRef.current.gap);
    flyingRef.current = next;
    const spawnShifted = next.some((bullet, i) => prev[i] && bullet.id === prev[i].id && bullet.spawnClock !== prev[i].spawnClock);
    if (spawnShifted) setFlying(next);
  }, []);

  // Periodic admission & pruning driven by exact JS mirror of the UI clock.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!playingRef.current) return;
      const nowWall = Date.now();
      if (carryOverRef.current.length && nowWall > carryExpireRef.current) {
        carryOverRef.current = [];
      }
      const rawElapsed = Math.max(0, nowWall - playheadAnchor.current.wallMs);
      const maxExtrapolate = playbackRateRef.current > 1 ? 60000 : 1200;
      const rawNowMs = playheadAnchor.current.videoMs + Math.min(maxExtrapolate, rawElapsed) * playbackRateRef.current;
      const limit = durationMsRef.current > 0 ? durationMsRef.current : rawNowMs;
      const nowMs = Math.min(limit, rawNowMs);
      const { flying: next, changed } = stepDanmaku({
        items: itemsRef.current,
        carryOver: carryOverRef.current,
        fired: fired.current,
        flying: flyingRef.current,
        nowMs,
        clockMs: readClockMs(),
        screenWidth: widthRef.current,
        laneCount: metricsRef.current.laneCount,
        fontSize: fontSizeRef.current,
        gap: metricsRef.current.gap,
        emojiMap: emojiRef.current,
        epoch: loopEpochRef.current,
      });
      if (changed) {
        flyingRef.current = next;
        setFlying(next);
      }
    }, 50);
    return () => clearInterval(timer);
  }, [readClockMs]);

  return (
    <View pointerEvents="none" style={[styles.layer, { top, height: Math.max(0, height), opacity: Math.max(0, Math.min(1, opacity / 100)) }]}>
      <View pointerEvents="none" style={[styles.stage, { width: Math.max(width * 4, 2400) }]}>
        {flying.map(item => (
          <DanmakuBullet
            key={item.id}
            id={item.id}
            text={item.text}
            top={2 + item.lane * metrics.laneHeight}
            spawnClock={item.spawnClock}
            speedFactor={item.speedFactor}
            fontSize={fontSize}
            lineHeight={metrics.lineHeight}
            emojiSize={metrics.emojiSize}
            emoji={emoji}
            widthSV={widthSV}
            clockMsSV={clockMsSV}
            onMeasure={handleMeasure}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: { position: 'absolute', left: 0, right: 0, overflow: 'hidden', zIndex: 3 },
  stage: { position: 'absolute', top: 0, left: 0, bottom: 0 },
  bullet: { position: 'absolute', left: 0, flexDirection: 'row', alignItems: 'center' },
  text: { color: '#fff', fontWeight: '600', textShadowColor: '#0008', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2 },
});
