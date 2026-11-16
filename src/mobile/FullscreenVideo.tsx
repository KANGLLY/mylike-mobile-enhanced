import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { mediaHeaders } from '../douyin';

// Fullscreen playback for a video whose aspect ratio fits the screen: the video
// is scaled up to fill the display (letterboxed by its own ratio) without
// rotating the whole app. Long-press to play at 2x (release to restore); exit
// with the close button rendered by the caller.
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
  const startBoost = () => { try { player.playbackRate = 2; } catch { /* ignore */ } };
  const endBoost = () => { try { player.playbackRate = rate; } catch { /* ignore */ } };
  return <View style={styles.root}>
    <VideoView player={player} nativeControls={false} contentFit="contain" surfaceType="textureView" pointerEvents="none" style={StyleSheet.absoluteFill} />
    <Pressable accessibilityRole="button" accessibilityLabel="长按二倍速" delayLongPress={150} onLongPress={startBoost} onPressOut={endBoost} onPress={() => { /* tap no longer exits; use the close button */ }} style={StyleSheet.absoluteFill} />
    <Text pointerEvents="none" style={styles.hint}>长按 2× 快进 · 右上角退出</Text>
  </View>;
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  hint: { position: 'absolute', bottom: 28, alignSelf: 'center', color: '#ffffff88', fontSize: 12 },
});
