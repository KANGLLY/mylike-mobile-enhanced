import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, { useAnimatedReaction, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import type { PagerGesture } from './player-types';

export function clock(value: number) {
  const s = Math.max(0, Math.floor(value));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Relative horizontal scrubbing from the current playback ratio without jumping to tap X. */
export function scrubRatio(startRatio: number, translationX: number, trackWidth: number): number {
  'worklet';
  const clampedStart = Math.max(0, Math.min(1, Number.isFinite(startRatio) ? startRatio : 0));
  if (!Number.isFinite(translationX) || !Number.isFinite(trackWidth) || trackWidth <= 0) {
    return clampedStart;
  }
  return Math.max(0, Math.min(1, clampedStart + translationX / trackWidth));
}

export function SeekRail({ enabled, seconds, duration, paused, clear, bottom = 0, native, onBegin, onCommit, onCancel }: {
  enabled: boolean; seconds: number; duration: number; paused: boolean; clear: boolean;
  bottom?: number; native?: PagerGesture; onBegin: () => void; onCommit: (seconds: number) => void; onCancel: () => void;
}) {
  const width = useSharedValue(1);
  const drag = useSharedValue(false);
  const startRatio = useSharedValue(0);
  const position = useSharedValue(0);
  const [scrubbing, setScrubbing] = useState(false);
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    if (!drag.value) position.value = duration ? Math.max(0, Math.min(1, seconds / duration)) : 0;
  }, [seconds, duration, drag, position]);

  useAnimatedReaction(
    () => Math.floor(position.value * duration),
    (value, before) => { if (drag.value && value !== before) scheduleOnRN(setDisplay, value); },
  );

  const fillStyle = useAnimatedStyle(() => ({
    width: `${Math.max(0, Math.min(1, position.value)) * 100}%`,
  }));

  const thumbStyle = useAnimatedStyle(() => ({
    left: `${Math.max(0, Math.min(1, position.value)) * 100}%`,
  }));

  const pan = usePanGesture({
    enabled: enabled && duration > 0,
    activeOffsetX: [-4, 4],
    failOffsetY: [-18, 18],
    block: native,
    onActivate: e => {
      'worklet';
      drag.value = true;
      startRatio.value = position.value;
      const next = scrubRatio(startRatio.value, e.translationX, width.value);
      position.value = next;
      scheduleOnRN(setDisplay, Math.floor(next * duration));
      scheduleOnRN(setScrubbing, true);
      scheduleOnRN(onBegin);
    },
    onUpdate: e => {
      'worklet';
      position.value = scrubRatio(startRatio.value, e.translationX, width.value);
    },
    onDeactivate: e => {
      'worklet';
      if (e.canceled) scheduleOnRN(onCancel);
      else scheduleOnRN(onCommit, position.value * duration);
    },
    onFinalize: e => {
      'worklet';
      if (e.canceled && drag.value) scheduleOnRN(onCancel);
      drag.value = false;
      scheduleOnRN(setScrubbing, false);
    },
  });

  const visible = scrubbing || !clear && (paused || duration > 15);
  const extraPad = Math.min(14, Math.max(0, bottom));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        accessibilityLabel="拖动调整播放进度"
        style={[styles.hit, { bottom: bottom - extraPad, height: 60 + extraPad, paddingBottom: 8 + extraPad }]}
        onLayout={e => { width.value = Math.max(1, e.nativeEvent.layout.width - 24); }}
      >
        {scrubbing && (
          <Text pointerEvents="none" style={styles.time}>
            {clock(display)} / {clock(duration)}
          </Text>
        )}
        {visible && (
          <View pointerEvents="none" style={styles.trackWrap}>
            <View style={[styles.track, paused && !scrubbing && styles.wide, scrubbing && styles.scrubTrack]}>
              <Animated.View style={[styles.progress, scrubbing && styles.scrubProgress, fillStyle]} />
            </View>
            {scrubbing && <Animated.View style={[styles.thumb, thumbStyle]} />}
          </View>
        )}
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  hit: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 60, justifyContent: 'flex-end', paddingHorizontal: 12, paddingBottom: 8 },
  trackWrap: { height: 14, justifyContent: 'center' },
  track: { height: 1.5, backgroundColor: '#ffffff45', borderRadius: 3, overflow: 'hidden' },
  wide: { height: 3 },
  scrubTrack: { height: 6, backgroundColor: '#ffffff55', borderRadius: 3 },
  progress: { height: '100%', backgroundColor: '#f5f5f5' },
  scrubProgress: { backgroundColor: '#ffffff' },
  thumb: { position: 'absolute', width: 12, height: 12, borderRadius: 6, backgroundColor: '#ffffff', marginLeft: -6 },
  time: { color: '#fff', fontWeight: '600', fontSize: 18, alignSelf: 'center', position: 'absolute', bottom: 52, textShadowColor: '#0008', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3 },
});
