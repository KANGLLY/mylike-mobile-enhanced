import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library/legacy';
import { mediaHeaders, type MediaResult } from '../douyin';

export type SaveKind = 'video' | 'images' | 'audio';

function extOf(url: string, fallback: string): string {
  const match = url.split('?')[0].match(/\.([a-zA-Z0-9]{2,5})$/);
  return match ? match[1].toLowerCase() : fallback;
}

async function download(url: string, fallbackExt: string): Promise<string> {
  const dir = FileSystem.cacheDirectory ?? '';
  const target = `${dir}mylike_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${extOf(url, fallbackExt)}`;
  // Douyin's CDN rejects requests without a referer/user-agent, so carry the same
  // headers the player uses when it streams the media.
  const result = await FileSystem.downloadAsync(url, target, { headers: mediaHeaders });
  if (typeof result.status === 'number' && result.status >= 400) {
    throw new Error(`下载失败（HTTP ${result.status}）`);
  }
  return result.uri;
}

function labelOf(kind: SaveKind): string {
  return kind === 'video' ? '视频' : kind === 'images' ? '图片' : '音频';
}

// Download the requested media of the current work and store it on the phone.
// Video works save the first video candidate; gallery works save every picture;
// audio saves the background music track. Everything goes through the system
// media library so it lands in the phone's album / files.
export async function saveWorkMedia(data: MediaResult, kind: SaveKind): Promise<string> {
  const permission = await MediaLibrary.requestPermissionsAsync();
  if (!permission.granted) throw new Error('需要相册权限才能保存，请到系统设置里允许后重试。');

  let urls: string[] = [];
  let fallback = 'mp4';
  if (kind === 'video') {
    if (!('candidates' in data) || !data.candidates.length) throw new Error('这个作品没有可保存的视频。');
    urls = [data.candidates[0]];
    fallback = 'mp4';
  } else if (kind === 'images') {
    if (!('images' in data) || !data.images.length) throw new Error('这个作品没有可保存的图片。');
    urls = data.images.map(image => image.candidates[0]).filter((value): value is string => Boolean(value));
    fallback = 'jpg';
  } else {
    const music = 'musicCandidates' in data ? data.musicCandidates : [];
    if (!music.length) throw new Error('这个作品没有可提取的音频。');
    urls = [music[0]];
    fallback = 'mp3';
  }

  let saved = 0;
  let lastError: unknown = null;
  for (const url of urls) {
    try {
      const uri = await download(url, fallback);
      await MediaLibrary.saveToLibraryAsync(uri);
      saved += 1;
    } catch (failure) {
      lastError = failure;
      if (urls.length === 1) throw failure;
    }
  }
  if (!saved) throw lastError instanceof Error ? lastError : new Error('保存失败，请稍后重试。');
  return `已保存 ${saved} 个${labelOf(kind)}到手机。`;
}
