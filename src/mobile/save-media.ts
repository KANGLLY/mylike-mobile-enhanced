import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library/legacy';
import { mediaHeaders, type MediaResult } from '../douyin';

export type SaveKind = 'video' | 'images' | 'audio';

// Android's MediaStore derives the asset MIME type from the file extension. Douyin
// image URLs frequently end in a non-standard suffix (e.g. `.image`) or no suffix,
// which made the temp file look like `application/octet-stream` and saving failed
// with "MIME type application/octet-stream cannot be inserted into ... images".
// Keep extensions inside a known allow-list and fall back per media kind.
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif']);
const VIDEO_EXT = new Set(['mp4', 'mov', 'm4v', 'webm']);
const AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'wav', 'ogg']);

function extFromUrl(url: string): string {
  const match = url.split('?')[0].match(/\.([a-zA-Z0-9]{2,5})$/);
  const ext = match ? match[1].toLowerCase() : '';
  return ext === 'jpeg' ? 'jpg' : ext;
}

function extFromType(headers: Record<string, string> | undefined): string {
  const raw = String(headers?.['content-type'] ?? headers?.['Content-Type'] ?? '').toLowerCase();
  if (raw.includes('jpeg')) return 'jpg';
  if (raw.includes('png')) return 'png';
  if (raw.includes('webp')) return 'webp';
  if (raw.includes('gif')) return 'gif';
  if (raw.includes('heic')) return 'heic';
  if (raw.includes('mp4') || raw.includes('video/')) return 'mp4';
  if (raw.includes('mpeg') || raw.includes('audio/mp3')) return 'mp3';
  if (raw.includes('audio/')) return 'm4a';
  return '';
}

async function download(url: string, allowed: Set<string>, fallbackExt: string): Promise<string> {
  const dir = FileSystem.cacheDirectory ?? '';
  const stem = `${dir}mylike_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const temp = `${stem}.part`;
  // Douyin's CDN rejects requests without a referer/user-agent, so carry the same
  // headers the player uses when it streams the media.
  const result = await FileSystem.downloadAsync(url, temp, { headers: mediaHeaders });
  if (typeof result.status === 'number' && result.status >= 400) {
    throw new Error(`下载失败（HTTP ${result.status}）`);
  }
  // Pick an extension the media scanner recognises: real URL suffix if it is a known
  // media type, otherwise the response Content-Type, otherwise the per-kind fallback.
  let ext = extFromUrl(url);
  if (!allowed.has(ext)) ext = extFromType(result.headers as Record<string, string> | undefined);
  if (!allowed.has(ext)) ext = fallbackExt;
  if (ext === 'jpeg') ext = 'jpg';
  const target = `${stem}.${ext}`;
  try {
    await FileSystem.moveAsync({ from: temp, to: target });
    return target;
  } catch {
    return temp;
  }
}

// Save a single comment image / sticker (大表情包) to the phone's album.
export async function saveImageUrl(url: string): Promise<string> {
  const permission = await MediaLibrary.requestPermissionsAsync();
  if (!permission.granted) throw new Error('需要相册权限才能保存，请到系统设置里允许后重试。');
  const uri = await download(url, IMAGE_EXT, 'jpg');
  await MediaLibrary.saveToLibraryAsync(uri);
  return '已保存到手机相册。';
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
  let allowed = VIDEO_EXT;
  let fallback = 'mp4';
  if (kind === 'video') {
    if (!('candidates' in data) || !data.candidates.length) throw new Error('这个作品没有可保存的视频。');
    urls = [data.candidates[0]];
    allowed = VIDEO_EXT; fallback = 'mp4';
  } else if (kind === 'images') {
    if (!('images' in data) || !data.images.length) throw new Error('这个作品没有可保存的图片。');
    urls = data.images.map(image => image.candidates[0]).filter((value): value is string => Boolean(value));
    allowed = IMAGE_EXT; fallback = 'jpg';
  } else {
    const music = 'musicCandidates' in data ? data.musicCandidates : [];
    if (!music.length) throw new Error('这个作品没有可提取的音频。');
    urls = [music[0]];
    allowed = AUDIO_EXT; fallback = 'mp3';
  }

  let saved = 0;
  let lastError: unknown = null;
  for (const url of urls) {
    try {
      const uri = await download(url, allowed, fallback);
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
