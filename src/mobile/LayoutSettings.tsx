import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Modal, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { defaultPreferences, type Preferences } from './model';

export type LayoutMode = 'home' | 'detail';

function valueAt(x: number, width: number, min: number, max: number, step: number): number {
  const ratio = Math.max(0, Math.min(1, x / Math.max(1, width)));
  const raw = min + ratio * (max - min);
  const snapped = Math.round(raw / step) * step;
  return Math.round(Math.max(min, Math.min(max, snapped)));
}

function Slider({ min, max, step, value, onChange }: { min: number; max: number; step: number; value: number; onChange: (value: number) => void }) {
  const [width, setWidth] = useState(0);
  const widthRef = useRef(0); widthRef.current = width;
  const changeRef = useRef(onChange); changeRef.current = onChange;
  const valueRef = useRef(value); valueRef.current = value;
  const grantPxRef = useRef(0);
  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: event => {
      const px = event.nativeEvent.locationX;
      grantPxRef.current = px;
      const next = valueAt(px, widthRef.current, min, max, step);
      if (next !== valueRef.current) changeRef.current(next);
    },
    onPanResponderMove: (_event, gestureState) => {
      const next = valueAt(grantPxRef.current + gestureState.dx, widthRef.current, min, max, step);
      if (next !== valueRef.current) changeRef.current(next);
    },
  }), [min, max, step]);
  const ratio = Math.max(0, Math.min(1, (value - min) / Math.max(1, max - min)));
  return (
    <View style={styles.track} onLayout={event => setWidth(event.nativeEvent.layout.width)} {...responder.panHandlers}>
      <View pointerEvents="none" style={[styles.fill, { width: `${Math.round(ratio * 100)}%` }]} />
      <View pointerEvents="none" style={[styles.thumb, { left: `${Math.round(ratio * 100)}%` }]} />
    </View>
  );
}

function Line({ label, valueText, children }: { label: string; valueText: string; children: ReactNode }) {
  return (
    <View style={styles.line}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.sliderWrap}>{children}</View>
      <Text style={styles.value}>{valueText}</Text>
    </View>
  );
}

const formatOffset = (value: number) => (value > 0 ? `+${value}` : `${value}`);

/**
 * 播放界面底部元素高度调节浮层：浮在屏幕上方，方便实时观察底部进度条、文案与右侧点赞列的移动效果。
 */
export function LayoutSettings({ visible, initialMode = 'home', onClose, preferences, onChange }: {
  visible: boolean; initialMode?: LayoutMode; onClose: () => void; preferences: Preferences; onChange: (patch: Partial<Preferences>) => void;
}) {
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<LayoutMode>(initialMode);
  useEffect(() => { if (visible) setMode(initialMode); }, [visible, initialMode]);

  const isDetail = mode === 'detail';
  const seekValue = isDetail ? preferences.detailSeekOffset : preferences.seekOffset;
  const captionValue = isDetail ? preferences.detailCaptionOffset : preferences.captionOffset;
  const toolbarValue = isDetail ? preferences.detailToolbarOffset : preferences.toolbarOffset;

  const resetCurrent = () => {
    if (isDetail) {
      onChange({
        detailSeekOffset: defaultPreferences.detailSeekOffset,
        detailCaptionOffset: defaultPreferences.detailCaptionOffset,
        detailToolbarOffset: defaultPreferences.detailToolbarOffset,
      });
    } else {
      onChange({
        seekOffset: defaultPreferences.seekOffset,
        captionOffset: defaultPreferences.captionOffset,
        toolbarOffset: defaultPreferences.toolbarOffset,
      });
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={[styles.sheet, { top: Math.max(16, insets.top + 10) }]}>
        <View style={styles.head}>
          <Text style={styles.title}>界面高度调节</Text>
          <Pressable hitSlop={10} onPress={resetCurrent}><Text style={styles.reset}>恢复默认</Text></Pressable>
        </View>
        <View style={styles.tabs}>
          <Pressable style={[styles.tab, !isDetail && styles.tabActive]} onPress={() => setMode('home')}>
            <Text style={[styles.tabText, !isDetail && styles.tabTextActive]}>首页（有底栏）</Text>
          </Pressable>
          <Pressable style={[styles.tab, isDetail && styles.tabActive]} onPress={() => setMode('detail')}>
            <Text style={[styles.tabText, isDetail && styles.tabTextActive]}>喜欢/收藏（无底栏）</Text>
          </Pressable>
        </View>
        <View style={styles.card}>
          <Line label="进度条高度" valueText={formatOffset(seekValue)}>
            <Slider min={-20} max={120} step={2} value={seekValue} onChange={value => onChange(isDetail ? { detailSeekOffset: value } : { seekOffset: value })} />
          </Line>
          <Line label="文案高度" valueText={formatOffset(captionValue)}>
            <Slider min={-20} max={120} step={2} value={captionValue} onChange={value => onChange(isDetail ? { detailCaptionOffset: value } : { captionOffset: value })} />
          </Line>
          <Line label="点赞列高度" valueText={formatOffset(toolbarValue)}>
            <Slider min={-20} max={120} step={2} value={toolbarValue} onChange={value => onChange(isDetail ? { detailToolbarOffset: value } : { toolbarOffset: value })} />
          </Line>
        </View>
        <Pressable style={styles.done} onPress={onClose}><Text style={styles.doneText}>完成</Text></Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#00000028' },
  sheet: { position: 'absolute', left: 14, right: 14, backgroundColor: '#16181fe6', borderRadius: 16, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: '#ffffff1c' },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  title: { color: '#f2f2f5', fontSize: 16, fontWeight: '600' },
  reset: { color: '#9a9aa5', fontSize: 13 },
  tabs: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  tab: { flex: 1, height: 34, borderRadius: 8, backgroundColor: '#22242f', alignItems: 'center', justifyContent: 'center' },
  tabActive: { backgroundColor: '#fc2f56' },
  tabText: { color: '#b9bcc7', fontSize: 13, fontWeight: '500' },
  tabTextActive: { color: '#ffffff', fontWeight: '600' },
  card: { backgroundColor: '#22242fd9', borderRadius: 12, paddingHorizontal: 12, marginBottom: 10 },
  line: { flexDirection: 'row', alignItems: 'center', minHeight: 46 },
  label: { color: '#f2f2f5', fontSize: 14, width: 78 },
  sliderWrap: { flex: 1, height: 32, justifyContent: 'center', marginHorizontal: 8 },
  value: { color: '#b9bcc7', fontSize: 13, width: 44, textAlign: 'right' },
  track: { height: 32, justifyContent: 'center' },
  fill: { position: 'absolute', left: 0, height: 4, borderRadius: 2, backgroundColor: '#fc2f56', alignSelf: 'center' },
  thumb: { position: 'absolute', width: 18, height: 18, borderRadius: 9, backgroundColor: '#ffffff', marginLeft: -9, top: 7 },
  done: { height: 40, borderRadius: 10, backgroundColor: '#2c2f3d', alignItems: 'center', justifyContent: 'center' },
  doneText: { color: '#f2f2f5', fontSize: 15, fontWeight: '600' },
});
