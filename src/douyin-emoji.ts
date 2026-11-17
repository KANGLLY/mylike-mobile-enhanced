import { mediaHeaders } from './douyin';

// Douyin's built-in inline emoji (the "[微笑]" style tokens inside comment text).
// The public web endpoint returns the whole catalogue without signing, so we
// fetch it once and map display_name -> image url.
let cache: Record<string, string> | null = null;

export async function loadEmojiMap(): Promise<Record<string, string>> {
  if (cache) return cache;
  const map: Record<string, string> = {};
  try {
    const response = await fetch('https://www.douyin.com/aweme/v1/web/emoji/list/', {
      headers: mediaHeaders,
      credentials: 'omit',
    });
    if (response.ok) {
      const data = (await response.json()) as { emoji_list?: unknown };
      const list = Array.isArray(data?.emoji_list) ? data.emoji_list : [];
      for (const value of list) {
        const item = value as { display_name?: unknown; emoji_url?: { url_list?: unknown } };
        const name = typeof item?.display_name === 'string' ? item.display_name : '';
        const urls = item?.emoji_url?.url_list;
        const url = Array.isArray(urls) ? urls.find((u): u is string => typeof u === 'string' && u.startsWith('https')) : '';
        if (name && url) {
          map[name] = url;
          map[name.replace(/^\[|\]$/g, '')] = url;
        }
      }
    }
  } catch {
    /* offline or blocked: caller falls back to plain text */
  }
  if (Object.keys(map).length) cache = map;
  return map;
}
