import { useEffect, useRef, useState } from 'react';
import { Animated, Image, StyleSheet, View } from 'react-native';
import { parseDanmakuList, type DanmakuItem } from '../douyin-bridge';
import { mediaHeaders } from '../douyin';
import { loadEmojiMap } from '../douyin-emoji';
import { useDouyinSession } from './douyin-session';

const EMOJI_SPLIT = /(\[[^\]\n]{1,8}\])/g;
// Swap Douyin's inline "[微笑]" tokens for the native emoji images in danmaku
// text; before the catalogue loads it falls back to the raw text.
function danmakuText(text: string, map: Record<string, string>) {
  if (!Object.keys(map).length) return text;
  return text.split(EMOJI_SPLIT).map((part, index) => {
    const uri = map[part];
    if (uri) return <Image key={index} source={{ uri, headers: mediaHeaders }} style={{ width: 16, height: 16 }} />;
    return part;
  });
}

// A danmaku item that is currently flying across the screen.
type Flying = { key: string; text: string; top: number; x: Animated.Value; started: boolean };

// Danmaku speed matches Douyin: measured ~0.1875 screen-widths/second on the
// reference recording, i.e. 2 widths (width -> -width) in ~10.67s.
// Overlay layer that pulls the video's time-based danmaku (danmaku/get_v2) once
// the clip starts, then releases each bullet when the playhead reaches its
// offset_time — like Douyin's bullet comments, laid out in horizontal lanes.
export function DanmakuOverlay({ workId, seconds, durationMs, playing, width, height, top }: {
  workId: string; seconds: number; durationMs: number; playing: boolean; width: number; height: number; top: number;
}) {
  const { request } = useDouyinSession();
  const [items, setItems] = useState<DanmakuItem[]>([]);
  const [flying, setFlying] = useState<Flying[]>([]);
  const [emoji, setEmoji] = useState<Record<string, string>>({});
  useEffect(() => { let alive = true; void loadEmojiMap().then(value => { if (alive) setEmoji(value); }); return () => { alive = false; }; }, []);
  const fired = useRef<Set<string>>(new Set());
  const lane = useRef(0);
  const secondsRef = useRef(seconds); secondsRef.current = seconds;
  const playingRef = useRef(playing); playingRef.current = playing;
  const heightRef = useRef(height); heightRef.current = height;

  // Fetch the whole clip's danmaku once per work (window = [0, duration]).
  useEffect(() => {
    fired.current = new Set(); setFlying([]); setItems([]);
    if (!workId || durationMs <= 0) return;
    let alive = true;
    void (async () => {
      try {
        const response = await request('danmaku', {
          item_id: workId, duration: String(durationMs), start_time: '0', end_time: String(durationMs), item_type: '0',
        }, 10000);
        const page = parseDanmakuList(response.body, response.status);
        if (alive && page.items.length) setItems(page.items);
      } catch { /* 弹幕拿不到时保持静默，不影响播放 */ }
    })();
    return () => { alive = false; };
  }, [workId, durationMs, request]);

  // Release bullets whose offset_time the playhead has just crossed.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!playingRef.current || !items.length) return;
      const now = secondsRef.current * 1000;
      setFlying(previous => {
        let next = previous;
        const laneCount = Math.max(3, Math.min(6, Math.floor((heightRef.current || 420) / 32)));
        for (const item of items) {
          if (fired.current.has(item.id)) continue;
          const delta = item.offsetMs - now;
          if (delta <= 80 && delta > -900) {
            fired.current.add(item.id);
            const slot = lane.current % laneCount; lane.current += 1;
            next = next.concat({ key: item.id, text: item.text, top: 4 + slot * 30, x: new Animated.Value(width), started: false });
          }
        }
        return next;
      });
    }, 200);
    return () => clearInterval(timer);
  }, [items, width]);

  // Kick off the fly-across animation for newly spawned bullets.
  useEffect(() => {
    setFlying(previous => {
      let changed = false;
      const next = previous.map(item => {
        if (item.started) return item;
        changed = true;
        Animated.timing(item.x, { toValue: -width, duration: 10670, useNativeDriver: true }).start(({ finished }) => {
          if (finished) setFlying(current => current.filter(x => x.key !== item.key));
        });
        return { ...item, started: true };
      });
      return changed ? next : previous;
    });
  }, [flying, width]);

  return <View pointerEvents="none" style={[styles.layer, { top, height: Math.max(0, height) }]}>
    {flying.map(item => <Animated.Text key={item.key} numberOfLines={1} style={[styles.text, { top: item.top, transform: [{ translateX: item.x }] }]}>{danmakuText(item.text, emoji)}</Animated.Text>)}
  </View>;
}

const styles = StyleSheet.create({
  layer: { position: 'absolute', left: 0, right: 0, overflow: 'hidden', zIndex: 3 },
  text: { position: 'absolute', left: 0, color: '#fff', fontSize: 15, fontWeight: '600', textShadowColor: '#0008', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2 },
});
