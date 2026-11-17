import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Modal, PanResponder, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import type { Preferences } from './model';

function valueAt(x: number, width: number, min: number, max: number, step: number): number {
  const ratio = Math.max(0, Math.min(1, x / Math.max(1, width)));
  const raw = min + ratio * (max - min);
  const snapped = Math.round(raw / step) * step;
  return Number(Math.max(min, Math.min(max, snapped)).toFixed(2));
}

// Lightweight slider (no native dependency): drag anywhere on the track and the
// thumb jumps to that position. Enough for the four danmaku settings.
function Slider({ min, max, step, value, onChange }: { min: number; max: number; step: number; value: number; onChange: (value: number) => void }) {
  const [width, setWidth] = useState(0);
  const widthRef = useRef(0); widthRef.current = width;
  const changeRef = useRef(onChange); changeRef.current = onChange;
  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: event => changeRef.current(valueAt(event.nativeEvent.locationX, widthRef.current, min, max, step)),
    onPanResponderMove: event => changeRef.current(valueAt(event.nativeEvent.locationX, widthRef.current, min, max, step)),
  }), [min, max, step]);
  const ratio = (value - min) / Math.max(0.0001, max - min);
  return <View style={styles.track} onLayout={event => setWidth(event.nativeEvent.layout.width)} {...responder.panHandlers}>
    <View style={[styles.fill, { width: `${Math.round(ratio * 100)}%` }]} />
    <View style={[styles.thumb, { left: `${Math.round(ratio * 100)}%` }]} />
  </View>;
}

function Line({ label, valueText, children }: { label: string; valueText: string; children: ReactNode }) {
  return <View style={styles.line}>
    <Text style={styles.label}>{label}</Text>
    <View style={styles.sliderWrap}>{children}</View>
    <Text style={styles.value}>{valueText}</Text>
  </View>;
}

const sizeLabel = (value: number) => value <= 13 ? '很小' : value <= 15 ? '小' : value <= 17 ? '适中' : value <= 19 ? '大' : '很大';
const speedLabel = (value: number) => value < 0.9 ? '慢' : value <= 1.15 ? '适中' : value <= 1.5 ? '快' : '很快';

// 弹幕设置：开关 + 不透明度 / 字体大小 / 移动速度 / 展示行数（前四项）。
export function DanmakuSettings({ visible, onClose, preferences, onChange }: {
  visible: boolean; onClose: () => void; preferences: Preferences; onChange: (patch: Partial<Preferences>) => void;
}) {
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
    <Pressable style={styles.backdrop} onPress={onClose} />
    <View style={styles.sheet}>
      <View style={styles.head}>
        <Text style={styles.title}>弹幕设置</Text>
        <Pressable hitSlop={10} onPress={() => onChange({ danmakuOpacity: 80, danmakuFontSize: 16, danmakuSpeed: 1, danmakuLines: 6 })}><Text style={styles.reset}>恢复默认</Text></Pressable>
      </View>
      <View style={styles.card}>
        <View style={styles.switchLine}><Text style={styles.label}>弹幕</Text><Switch value={preferences.danmaku} onValueChange={value => onChange({ danmaku: value })} trackColor={{ true: '#fc2f56', false: '#4a4d5c' }} thumbColor="#ffffff" /></View>
      </View>
      <View style={styles.card}>
        <Line label="不透明度" valueText={`${Math.round(preferences.danmakuOpacity)}%`}><Slider min={20} max={100} step={10} value={preferences.danmakuOpacity} onChange={value => onChange({ danmakuOpacity: value })} /></Line>
        <Line label="字体大小" valueText={sizeLabel(preferences.danmakuFontSize)}><Slider min={12} max={22} step={1} value={preferences.danmakuFontSize} onChange={value => onChange({ danmakuFontSize: value })} /></Line>
        <Line label="移动速度" valueText={speedLabel(preferences.danmakuSpeed)}><Slider min={0.5} max={2} step={0.1} value={preferences.danmakuSpeed} onChange={value => onChange({ danmakuSpeed: value })} /></Line>
        <Line label="展示行数" valueText={`${preferences.danmakuLines} 行`}><Slider min={1} max={10} step={1} value={preferences.danmakuLines} onChange={value => onChange({ danmakuLines: value })} /></Line>
      </View>
      <Pressable style={styles.done} onPress={onClose}><Text style={styles.doneText}>完成</Text></Pressable>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#00000066' },
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: '#16181f', borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 26 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  title: { color: '#f2f2f5', fontSize: 17, fontWeight: '600' },
  reset: { color: '#9a9aa5', fontSize: 14 },
  card: { backgroundColor: '#22242f', borderRadius: 12, paddingHorizontal: 12, marginBottom: 12 },
  switchLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 50 },
  line: { flexDirection: 'row', alignItems: 'center', minHeight: 52 },
  label: { color: '#f2f2f5', fontSize: 15, width: 76 },
  sliderWrap: { flex: 1, height: 34, justifyContent: 'center', marginHorizontal: 8 },
  value: { color: '#b9bcc7', fontSize: 13, width: 52, textAlign: 'right' },
  track: { height: 34, justifyContent: 'center' },
  fill: { position: 'absolute', left: 0, height: 4, borderRadius: 2, backgroundColor: '#fc2f56', alignSelf: 'center' },
  thumb: { position: 'absolute', width: 18, height: 18, borderRadius: 9, backgroundColor: '#ffffff', marginLeft: -9, top: 8 },
  done: { marginTop: 4, height: 46, borderRadius: 12, backgroundColor: '#2c2f3d', alignItems: 'center', justifyContent: 'center' },
  doneText: { color: '#f2f2f5', fontSize: 16, fontWeight: '600' },
});
