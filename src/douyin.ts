const DETAIL_HOST = 'api.amemv.com';
const MOBILE_AGENT =
  'Mozilla/5.0 (Linux; Android 13; 2210132C Build/TKQ1.220829.002) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36';
const WORK_ID = /^[1-9]\d{15,19}$/;
const REQUEST_TIMEOUT = 12_000;

export const mediaHeaders = {
  'User-Agent': MOBILE_AGENT,
  Referer: 'https://www.douyin.com/',
};

type RecordValue = Record<string, unknown>;
type Presentation = {
  author?: string; authorAvatar?: string; authorSecUid?: string;
  statistics?: { likes?: number; comments?: number; favorites?: number; shares?: number };
};
type VideoResult = Presentation & {
  id: string;
  title: string;
  candidates: string[];
  musicCandidates: string[];
  author?: string;
  size?: { width: number; height: number };
};

type GalleryResult = Presentation & {
  id: string;
  title: string;
  images: { candidates: string[]; liveCandidates: string[] }[];
  musicCandidates: string[];
  author?: string;
  article?: ArticleData;
};

export type ArticleData = {
  title: string;
  abstract: string;
  body: string;
  readTimeMinutes?: number;
  readTimeSeconds?: number;
  buttonText: string;
  backgroundColor?: string;
  publishedAt?: number;
  headerImages: string[];
};

export type MediaResult = VideoResult | GalleryResult;

class DouyinError extends Error {}

function object(value: unknown): RecordValue | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function httpsUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) return url;
  } catch {
    // Ignore invalid URLs returned by the platform.
  }
  return undefined;
}

function mediaUrls(...lists: unknown[]): string[] {
  const candidates = new Set<string>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const value of list) {
      // Keep the exact signed URL returned by the platform.
      if (typeof value === 'string' && httpsUrl(value)) candidates.add(value);
    }
  }
  return [...candidates].slice(0, 8);
}

function displayText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function videoSize(value: RecordValue | undefined) {
  const width = value?.width; const height = value?.height;
  return typeof width === 'number' && typeof height === 'number' && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 && width <= 16_384 && height <= 16_384 ? { width, height } : undefined;
}
function parseJsonObject(value: unknown): RecordValue | undefined {
  if (typeof value !== 'string' || !value.trim()) return object(value);
  try { return object(JSON.parse(value)); } catch { return undefined; }
}
export function formatArticleBody(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6])>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}
function isAudioUrl(url: string): boolean {
  return /\.(?:mp3|m4a|aac|wav|ogg|flac)(?:\?|$)/i.test(url);
}

export function parseMediaDetail(body: string, id: string): MediaResult {
  let payload: RecordValue | undefined;
  try {
    // Preserve bare 19-digit work IDs before JSON.parse rounds them to Numbers.
    const safeBody = body.replace(
      /"aweme_id"\s*:\s*(\d{16,})(?=\s*[,}])|"(?:[^"\\]|\\.)*"/g,
      (token, digits: string | undefined) => (digits ? `"aweme_id":"${digits}"` : token),
    );
    payload = object(JSON.parse(safeBody));
  } catch {
    throw new DouyinError('详情响应不是 JSON，可能是验证页或接口限制。');
  }
  if (payload?.status_code !== 0 && payload?.status_code !== '0') {
    const code = payload?.status_code;
    const status = typeof code === 'number' || (typeof code === 'string' && /^-?\d+$/.test(code))
      ? String(code)
      : '缺失';
    throw new DouyinError(`抖音未返回成功状态（status_code: ${status}）。`);
  }
  const detail = object(payload.aweme_detail);
  if (!detail) throw new DouyinError('详情响应没有作品数据，游客请求可能未获放行。');
  if (detail.aweme_id !== id) throw new DouyinError('详情返回了不同的作品 ID，已停止播放。');
  const title = typeof detail.desc === 'string' && detail.desc.trim() ? detail.desc.trim() : '抖音视频';
  const author = displayText(object(detail.author)?.nickname);
  const authorInfo = object(detail.author);
  const authorAvatar = mediaUrls(object(authorInfo?.avatar_thumb)?.url_list, object(authorInfo?.avatar_medium)?.url_list, object(authorInfo?.avatar_168x168)?.url_list)[0];
  const authorSecUid = typeof authorInfo?.sec_uid === 'string' && /^MS4wLjAB[A-Za-z0-9_-]{8,248}$/.test(authorInfo.sec_uid) ? authorInfo.sec_uid : undefined;
  const statistics: NonNullable<Presentation['statistics']> = {};
  const counts = object(detail.statistics);
  for (const [key, field] of [['likes','digg_count'],['comments','comment_count'],['favorites','collect_count'],['shares','share_count']] as const) {
    const value = counts?.[field]; if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) statistics[key] = value;
  }
  const common = { id, title, ...(author && { author }), ...(authorAvatar && { authorAvatar }), ...(authorSecUid && { authorSecUid }), ...(Object.keys(statistics).length && { statistics }) };
  const articleInfo = object(detail.article_info);
  const articleContent = parseJsonObject(articleInfo?.article_content);
  const articleFe = parseJsonObject(articleInfo?.fe_data);
  const articleClient = parseJsonObject(articleInfo?.client_data);
  const articleBtn = object(articleClient?.detail_btn_info);
  const rawMarkdown = displayText(articleContent?.markdown) ?? displayText(articleContent?.content) ?? displayText(articleFe?.description) ?? '';
  const rawAbstract = displayText(articleContent?.long_article_abstract) ?? displayText(articleContent?.abstract) ?? '';
  const articleBody = formatArticleBody(rawMarkdown || rawAbstract);
  const articleAbstract = formatArticleBody(rawAbstract || articleBody);
  const isArticle = Boolean(
    articleInfo && (detail.aweme_type === 163 || displayText(articleInfo.business_id) === 'article' || articleBody || displayText(articleBtn?.text)),
  );
  if (isArticle && articleInfo) {
    const video = object(detail.video);
    const music = object(detail.music);
    const matchedSound = object(music?.matched_pgc_sound);
    const rawTime = detail.create_time;
    const publishedAt = typeof rawTime === 'number' && Number.isFinite(rawTime) && rawTime > 0
      ? (rawTime < 1e11 ? rawTime * 1000 : rawTime)
      : undefined;
    const headerImages = mediaUrls(
      object(articleFe?.head_poster_list)?.url_list,
      articleFe?.pre_cover ? [articleFe.pre_cover] : undefined,
      object(video?.cover)?.url_list,
      object(video?.origin_cover)?.url_list,
    );
    const rawDetailImages = Array.isArray(detail.images) ? detail.images : [];
    const detailGallery = rawDetailImages.map((value) => {
      const image = object(value);
      const imgVideo = object(image?.video);
      return {
        candidates: mediaUrls(image?.url_list, object(image?.display_image)?.url_list),
        liveCandidates: mediaUrls(
          object(imgVideo?.play_addr_h264)?.url_list,
          object(imgVideo?.play_addr)?.url_list,
          object(imgVideo?.play_addr_lowbr)?.url_list,
          object(image?.live_image)?.url_list,
          imgVideo?.url_list,
        ),
      };
    }).filter((entry) => entry.candidates.length > 0);
    const extraFeImages = Array.isArray(articleFe?.image_list)
      ? articleFe.image_list.flatMap((entry) => {
          if (typeof entry === 'string') return mediaUrls([entry]);
          const obj = object(entry);
          return mediaUrls(obj?.url_list, obj?.url ? [obj.url] : undefined);
        })
      : [];
    const images = detailGallery.length
      ? detailGallery
      : [
          ...(headerImages.length ? [{ candidates: headerImages, liveCandidates: [] }] : []),
          ...extraFeImages.filter((url) => !headerImages.includes(url)).map((url) => ({ candidates: [url], liveCandidates: [] })),
        ];
    const playUrls = mediaUrls(object(video?.play_addr_h264)?.url_list, object(video?.play_addr)?.url_list);
    const rawMusic = mediaUrls(
      object(music?.play_url)?.url_list, music?.url_list, object(matchedSound?.play_url)?.url_list,
    );
    const audioPlayUrls = playUrls.filter((url) => isAudioUrl(url) || rawMusic.length === 0);
    const musicCandidates = [...new Set([...rawMusic, ...audioPlayUrls])].slice(0, 8);
    const articleTitle = displayText(articleInfo.article_title) ?? displayText(detail.desc) ?? '抖音文章';
    const bgRaw = typeof articleFe?.background_color === 'string' ? articleFe.background_color.trim() : '';
    const article: ArticleData = {
      title: articleTitle,
      abstract: articleAbstract,
      body: articleBody,
      readTimeMinutes: positiveInt(articleInfo.read_time) ?? positiveInt(articleFe?.read_time),
      readTimeSeconds: positiveInt(articleFe?.read_time_second),
      buttonText: displayText(articleBtn?.text) ?? '阅读文章',
      ...( /^#[0-9a-fA-F]{6}$/.test(bgRaw) ? { backgroundColor: bgRaw } : {}),
      ...(publishedAt !== undefined ? { publishedAt } : {}),
      headerImages,
    };
    return { ...common, title: articleTitle, images, musicCandidates, article };
  }
  if (Array.isArray(detail.images) && detail.images.length > 0) {
    const images = detail.images.map((value) => {
      const image = object(value);
      const video = object(image?.video);
      return {
        candidates: mediaUrls(image?.url_list, object(image?.display_image)?.url_list),
        liveCandidates: mediaUrls(
          object(video?.play_addr_h264)?.url_list,
          object(video?.play_addr)?.url_list,
          object(video?.play_addr_lowbr)?.url_list,
          object(image?.live_image)?.url_list,
          video?.url_list,
          Array.isArray(image?.urls) ? object(image.urls[0])?.url_list : undefined,
        ),
      };
    });
    if (!images.some((image) => image.candidates.length))
      throw new DouyinError('已取到图集详情，但没有可用的 HTTPS 图片地址。');
    const music = object(detail.music);
    const matchedSound = object(music?.matched_pgc_sound);
    const musicCandidates = mediaUrls(
      object(music?.play_url)?.url_list, music?.url_list, object(matchedSound?.play_url)?.url_list,
    );
    return { ...common, images, musicCandidates };
  }
  const video = object(detail.video);
  const candidates = mediaUrls(object(video?.play_addr_h264)?.url_list, object(video?.play_addr)?.url_list);
  if (!candidates.length) throw new DouyinError('已取到详情，但没有可用的 HTTPS 视频地址。');
  const size = videoSize(video) ?? videoSize(object(video?.play_addr_h264)) ?? videoSize(object(video?.play_addr));
  const music = object(detail.music);
  const matchedSound = object(music?.matched_pgc_sound);
  const musicCandidates = mediaUrls(
    object(music?.play_url)?.url_list, music?.url_list, object(matchedSound?.play_url)?.url_list,
  );
  return { ...common, candidates, musicCandidates, ...(size && { size }) };
}

export async function resolveMedia(id: string, signal?: AbortSignal): Promise<MediaResult> {
  if (!WORK_ID.test(id)) throw new DouyinError('作品 ID 无效。');
  if (signal?.aborted) throw new DouyinError('已取消取链。');

  const url = `https://${DETAIL_HOST}/aweme/v1/aweme/detail/` +
    `?aweme_id=${id}&aid=6383&device_platform=web&version_code=190500&version_name=19.5.0`;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, REQUEST_TIMEOUT);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': MOBILE_AGENT, Accept: 'application/json, text/plain, */*' },
      credentials: 'omit',
      signal: controller.signal,
    });
    if (!response.ok) throw new DouyinError(`详情请求被拒绝（HTTP ${response.status}）。`);
    const body = await response.text();
    if (!body.trim()) throw new DouyinError('详情响应为空。');
    return parseMediaDetail(body, id);
  } catch (error) {
    if (signal?.aborted) throw new DouyinError('已取消取链。');
    if (controller.signal.aborted) throw new DouyinError('详情请求超时（12 秒）。');
    if (error instanceof DouyinError) throw error;
    throw new DouyinError('详情请求失败，请检查手机能否访问抖音。');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

export function redactMediaUrls(message: string): string {
  return message.replace(/https?:\/\/[^\s"'<>]+/gi, '[媒体地址]').slice(0, 300);
}
