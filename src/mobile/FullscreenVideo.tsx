import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { mediaHeaders } from '../douyin';

// Fullscreen playback for a video whose aspect ratio fits the screen: the video
// is scaled up to fill the display (letterboxed by its own ratio) without
// rotating the whole app. Tap anywhere or the close button to exit.
export function FullscreenVideo({ uri, startSeconds, rate, onClose }: { uri: string; startSeconds: number; rate: number; onClose: () => void }) {
  const source = { uri, headers: mediaHeaders };
  const player = useVideoPlayer(source, value => {
    value.loop = true;
    value.muted = true;
    value.preservesPitch = true;
    value.bufferOptions = { preferredForwardBufferDuration: 3, waitsToMinimizeStalling: false, minBufferForPlayback: 0.25 };
  });
  useEffect(() => {
    try { if (startSeconds > 0) player.currentTime = startSeconds; } catch { /* seek may fail before the source is ready */ }
    try { player.playbackRate = rate; } catch { /* ignore unsupported rate values */ }
    player.play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player]);
  return <View style={styles.root}>
    <VideoView player={player} nativeControls={false} contentFit="contain" surfaceType="textureView" pointerEvents="none" style={StyleSheet.absoluteFill} />
    <Pressable accessibilityRole="button" accessibilityLabel="退出全屏" onPress={onClose} style={StyleSheet.absoluteFill} />
    <Text pointerEvents="none" style={styles.hint}>点按屏幕退出全屏</Text>
  </View>;
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  hint: { position: 'absolute', bottom: 28, alignSelf: 'center', color: '#ffffff88', fontSize: 12 },
});
