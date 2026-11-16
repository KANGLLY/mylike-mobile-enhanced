// Paged, signed Douyin comment reads executed inside the real douyin.com page.
// Pure module: no React Native imports, so the parsers run under `node --test`.
//
// The page-side request runner is embedded as a literal string and injected into
// a WebView that has the desktop Douyin site loaded. Douyin's own page SDK signs
// the request (a_bogus / msToken), exactly like the desktop MyLike app does.

export type CommentAttachment = { url: string; type: 'image' | 'video' };

export type FullComment = {
  id: string;
  workId: string;
  text: string;
  nickname: string;
  avatar: string | null;
  createdAt: number | null;
  likes: number | null;
  replyCount: number;
  region: string | null;
  attachments: CommentAttachment[];
};

export type CommentPage = { items: FullComment[]; nextCursor: string | null; hasMore: boolean };

export type CommentFailure =
  | 'auth' | 'invalid' | 'restricted' | 'empty' | 'stalled' | 'network' | 'timeout' | 'bridge';

export class CommentReadError extends Error {
  readonly code: CommentFailure;
  constructor(code: CommentFailure, message: string) {
    super(message);
    this.code = code;
    this.name = 'CommentReadError';
  }
}

// ---------------------------------------------------------------- value helpers

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
function count(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}
function numericId(value: unknown): string {
  const id = typeof value === 'string' ? value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
  if (!/^\d{1,30}$/.test(id)) throw new CommentReadError('invalid', '平台返回了无效的评论标识或分页游标。');
  return id;
}
function firstHttps(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    try {
      const url = new URL(entry);
      if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
    } catch { /* ignore malformed platform URL */ }
  }
  return null;
}

// Douyin returns 64-bit ids as JSON numbers; quote them before JSON.parse so
// `cid` / `aweme_id` / `cursor` keep every digit instead of losing precision.
function safeJson(body: string): unknown {
  return JSON.parse(body.replace(
    /"(?:cid|uid|aweme_id|item_id|comment_id|reply_id|cursor)"\s*:\s*(\d{16,})(?=\s*[,}])|"(?:[^"\\]|\\.)*"/g,
    (token, digits: string | undefined) => digits ? token.replace(digits, `"${digits}"`) : token,
  ));
}
// Some guest endpoints (e.g. the mobile reply list) append a second JSON log
// object after the payload. Return only the first balanced {...} object so
// JSON.parse never sees the trailing blob.
function trimToFirstJson(body: string): string {
  const start = body.indexOf('{');
  if (start < 0) return body;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return body.slice(start);
}
function statusCodeOf(payload: Record<string, unknown>): string {
  const raw = payload.status_code;
  const nested = record(raw)?.StatusCode ?? raw;
  return nested == null ? '' : String(nested);
}
// Douyin image comments nest the real URL inside objects like
// { origin_url: { url_list: [...] }, thumb_url: { url_list: [...] } }.
// Walk those objects (preferring the full-size origin_url) instead of only
// looking at top-level strings, otherwise image comments lose their pictures.
function commentAttachments(row: Record<string, unknown>): CommentAttachment[] {
  const out: CommentAttachment[] = [];
  const URL_KEYS = [
    'origin_url', 'display_image', 'thumb_url', 'thumbnail', 'static_url', 'image_url',
    'sticker_url', 'emoji_url', 'animated_url', 'animation_url', 'animate_url',
    'dynamic_url', 'gif_url', 'url_list',
  ];
  const clean = (raw: unknown): string | undefined => {
    if (typeof raw !== 'string') return undefined;
    try { const url = new URL(raw); if (url.protocol === 'https:' && !url.username && !url.password) return url.href; } catch { /* ignore malformed platform URL */ }
    return undefined;
  };
  const pick = (list: unknown[]): string | undefined => { for (const v of list) { const url = clean(v); if (url) return url; } return undefined; };
  const extract = (value: unknown, depth = 0): string | undefined => {
    if (typeof value === 'string') return clean(value);
    if (depth > 3) return undefined;
    const item = record(value);
    if (!item) return undefined;
    if (Array.isArray(item.url_list)) { const url = pick(item.url_list); if (url) return url; }
    for (const key of URL_KEYS) {
      const url = extract(item[key], depth + 1);
      if (url) return url;
    }
    return undefined;
  };
  const add = (value: unknown) => {
    const url = extract(value);
    if (url && !out.some((a) => a.url === url) && out.length < 9) out.push({ url, type: 'image' });
  };
  const imageList = Array.isArray(row.image_list) ? row.image_list : [];
  for (const value of imageList) { add(value); if (out.length >= 9) break; }
  const extraFields = [row.image_comment, row.sticker, row.sticker_info, row.emoji, row.emoji_info, row.sticker_list, row.emoji_detail_list];
  for (const field of extraFields) {
    const arr = Array.isArray(field) ? field : field ? [field] : [];
    for (const value of arr) { add(value); if (out.length >= 9) break; }
    if (out.length >= 9) break;
  }
  return out;
}

// ---------------------------------------------------------------- parsers

export function parseCommentList(body: string, workId: string, requestedCursor: string, httpStatus = 200): CommentPage {
  if (httpStatus === 401 || httpStatus === 403) throw new CommentReadError('auth', '登录状态已失效，请重新登录抖音。');
  if (httpStatus === 429) throw new CommentReadError('restricted', '请求过于频繁，请稍后再试。');
  if (httpStatus < 200 || httpStatus >= 300) throw new CommentReadError('network', `评论请求失败（HTTP ${httpStatus}）。`);
  if (/<(?:html|!doctype)/i.test(body.slice(0, 500))) throw new CommentReadError('restricted', '接口返回了网页，请重新登录或稍后再试。');
  if (!body.trim()) throw new CommentReadError('empty', '平台返回空响应，未能确认评论列表。');

  let payload: Record<string, unknown> | undefined;
  try { payload = record(safeJson(trimToFirstJson(body))); } catch { throw new CommentReadError('invalid', '评论响应不是有效 JSON。'); }
  if (!payload) throw new CommentReadError('invalid', '评论响应结构无效。');

  const code = statusCodeOf(payload);
  if (code !== '' && code !== '0') throw new CommentReadError('restricted', '登录后仍未能读取评论，请重新登录后重试。');

  const more = [1, true, '1'].includes(payload.has_more as never);
  if (!more && ![0, false, '0'].includes(payload.has_more as never)) throw new CommentReadError('invalid', '评论列表结构异常。');
  const rows = payload.comments === null && !more ? [] : payload.comments;
  if (!Array.isArray(rows)) throw new CommentReadError('invalid', '评论列表结构异常。');

  const items: FullComment[] = [];
  const seen = new Set<string>();
  for (const raw of rows) {
    const row = record(raw);
    if (!row) continue;
    let cid: string;
    try { cid = numericId(row.cid); } catch { continue; }
    if (/^0+$/.test(cid) || seen.has(cid)) continue;
    if (row.aweme_id != null && String(row.aweme_id) !== workId) throw new CommentReadError('invalid', '评论与当前作品不一致。');
    const user = record(row.user);
    const timestamp = count(row.create_time);
    seen.add(cid);
    items.push({
      id: cid,
      workId,
      text: truncate(text(row.text), 4000) || (Array.isArray(row.image_list) && row.image_list.length ? '[图片评论]' : '[评论]'),
      nickname: truncate(text(user?.nickname), 100) || '抖音用户',
      avatar: firstHttps(record(user?.avatar_thumb)?.url_list),
      createdAt: timestamp > 0 ? (timestamp < 1e11 ? timestamp * 1000 : timestamp) : null,
      likes: count(row.digg_count),
      replyCount: count(row.reply_comment_total),
      region: text(row.ip_label ?? row.ip_location) || null,
      attachments: commentAttachments(row),
    });
  }
  if (rows.length && !items.length) throw new CommentReadError('invalid', '评论列表解析失败。');
  if (more && !items.length) throw new CommentReadError('invalid', '评论列表解析失败，请稍后重试。');

  let nextCursor: string | null = null;
  if (more) {
    // The mobile reply endpoint may omit an explicit cursor; only continue when
    // the platform gives us a usable numeric one.
    const raw = payload.cursor ?? payload.max_cursor;
    try {
      const cursor = numericId(raw);
      if (!/^0+$/.test(cursor)) nextCursor = cursor;
    } catch { nextCursor = null; }
  }
  if (nextCursor !== null && nextCursor === requestedCursor) throw new CommentReadError('stalled', '评论分页没有推进，请重试。');
  return { items, nextCursor, hasMore: more };
}

export function parseSelf(body: string, httpStatus = 200): { loggedIn: boolean; nickname?: string; secUid?: string } {
  if (httpStatus === 401 || httpStatus === 403 || httpStatus === 0) return { loggedIn: false };
  if (!body.trim() || /<(?:html|!doctype)/i.test(body.slice(0, 300))) return { loggedIn: false };
  let payload: Record<string, unknown> | undefined;
  try { payload = record(safeJson(body)); } catch { return { loggedIn: false }; }
  if (!payload) return { loggedIn: false };
  if (statusCodeOf(payload) !== '0') return { loggedIn: false };
  const user = record(payload.user);
  if (!user) return { loggedIn: false };
  const uid = text(user.uid) || (typeof user.uid === 'number' ? String(user.uid) : '');
  if (!uid && !text(user.nickname)) return { loggedIn: false };
  const secUid = text(user.sec_uid) || text(user.sec_user_id);
  return { loggedIn: true, nickname: text(user.nickname) || undefined, ...(secUid ? { secUid } : {}) };
}

// ---------------------------------------------------------------- video lists

export type VideoKind = 'video' | 'gallery' | 'live-gallery';
export type VideoItem = {
  id: string;
  title: string;
  author: string;
  coverUrl: string | null;
  publishedAt: number | null;
  kind: VideoKind;
};
export type VideoPage = { items: VideoItem[]; nextCursor: string | null; hasMore: boolean };

const COVER_HOSTS = [
  'douyinpic.com', 'douyincdn.com', 'douyinstatic.com', 'byteimg.com', 'ibytedtos.com', 'bytecdn.cn', 'pstatp.com',
];
function coverUrl(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    try {
      const url = new URL(entry);
      if (url.protocol !== 'https:' || url.username || url.password || url.port) continue;
      if (COVER_HOSTS.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) return entry;
    } catch { /* ignore malformed cover URL */ }
  }
  return null;
}
function awemeToItem(value: unknown): VideoItem | null {
  const row = record(value);
  if (!row) return null;
  let id: string;
  try { id = numericId(row.aweme_id); } catch { return null; }
  if (/^0+$/.test(id)) return null;
  const video = record(row.video);
  const author = record(row.author);
  const images = Array.isArray(row.images) ? row.images : [];
  const cover =
    coverUrl(record(video?.cover)?.url_list)
    ?? coverUrl(record(video?.origin_cover)?.url_list)
    ?? coverUrl(record(images[0])?.url_list);
  const rawTime = count(row.create_time);
  return {
    id,
    title: truncate(text(row.desc), 500),
    author: truncate(text(author?.nickname), 200) || '抖音用户',
    coverUrl: cover,
    publishedAt: rawTime > 0 ? (rawTime < 1e11 ? rawTime * 1000 : rawTime) : null,
    kind: images.length ? 'gallery' : 'video',
  };
}

// Parse a liked-videos page (`/aweme/v1/web/aweme/favorite/`) or a favorites
// collection page (`/aweme/v1/web/aweme/listcollection/`). Both expose
// `aweme_list`, `has_more`, and a `max_cursor`/`cursor`.
export function parseVideoList(body: string, requestedCursor: string, httpStatus = 200): VideoPage {
  if (httpStatus === 401 || httpStatus === 403) {
    const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 240);
    let code = '';
    try { code = statusCodeOf(record(safeJson(trimToFirstJson(body))) ?? {}); } catch { /* ignore */ }
    if (!snippet || code === '8' || /not[\s_-]*login|未登录|登录已失效/i.test(snippet)) throw new CommentReadError('auth', '登录状态已失效，请重新登录抖音。');
    throw new CommentReadError('restricted', `点赞/收藏接口被拒绝（HTTP ${httpStatus}）${snippet ? `：${snippet}` : ''}`);
  }
  if (httpStatus === 429) throw new CommentReadError('restricted', '请求过于频繁，请稍后再试。');
  if (httpStatus < 200 || httpStatus >= 300) throw new CommentReadError('network', `列表请求失败（HTTP ${httpStatus}）。`);
  if (/<(?:html|!doctype)/i.test(body.slice(0, 500))) throw new CommentReadError('restricted', '接口返回了网页，请重新登录或稍后再试。');
  if (!body.trim()) throw new CommentReadError('empty', '平台返回空响应，未能确认列表。');

  let payload: Record<string, unknown> | undefined;
  try { payload = record(safeJson(trimToFirstJson(body))); } catch { throw new CommentReadError('invalid', '列表响应不是有效 JSON。'); }
  if (!payload) throw new CommentReadError('invalid', '列表响应结构无效。');
  const code = statusCodeOf(payload);
  if (code !== '' && code !== '0') throw new CommentReadError('restricted', `未能读取列表（status_code=${code}，HTTP ${httpStatus}）${body.replace(/\s+/g, ' ').trim().slice(0, 240)}`);

  const more = [1, true, '1'].includes(payload.has_more as never);
  if (!more && ![0, false, '0'].includes(payload.has_more as never)) throw new CommentReadError('invalid', '列表结构异常。');
  const rows = payload.aweme_list === null && !more ? [] : payload.aweme_list;
  if (!Array.isArray(rows)) throw new CommentReadError('invalid', '列表结构异常。');

  const items: VideoItem[] = [];
  const seen = new Set<string>();
  for (const raw of rows) {
    const item = awemeToItem(raw);
    if (item && !seen.has(item.id)) { seen.add(item.id); items.push(item); }
  }

  let nextCursor: string | null = null;
  if (more) {
    try {
      const cursor = numericId(payload.max_cursor ?? payload.cursor);
      if (!/^0+$/.test(cursor)) nextCursor = cursor;
    } catch { nextCursor = null; }
  }
  // A non-advancing cursor means the platform stopped paginating for us; keep the
  // items we already have and end here instead of failing the whole sync.
  if (nextCursor !== null && nextCursor === requestedCursor) nextCursor = null;
  return { items, nextCursor, hasMore: more && nextCursor !== null };
}

// Parse a captured "likes / favourites" page body into items, ignoring pagination
// (the collection sync captures several already-signed pages and unions them).
export function parseVideoItems(body: string, httpStatus = 200): VideoItem[] {
  if (httpStatus === 401 || httpStatus === 403) {
    const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 240);
    let code = '';
    try { code = statusCodeOf(record(safeJson(trimToFirstJson(body))) ?? {}); } catch { /* ignore */ }
    if (!snippet || code === '8' || /not[\s_-]*login|未登录|登录已失效/i.test(snippet)) throw new CommentReadError('auth', '登录状态已失效，请重新登录抖音。');
    throw new CommentReadError('restricted', `点赞/收藏接口被拒绝（HTTP ${httpStatus}）${snippet ? `：${snippet}` : ''}`);
  }
  if (httpStatus === 429) throw new CommentReadError('restricted', '请求过于频繁，请稍后再试。');
  if (httpStatus < 200 || httpStatus >= 300) throw new CommentReadError('network', `列表请求失败（HTTP ${httpStatus}）。`);
  if (/<(?:html|!doctype)/i.test(body.slice(0, 500))) throw new CommentReadError('restricted', '接口返回了网页，请稍后重试。');
  if (!body.trim()) return [];
  let payload: Record<string, unknown> | undefined;
  try { payload = record(safeJson(trimToFirstJson(body))); } catch { throw new CommentReadError('invalid', '列表响应不是有效 JSON。'); }
  if (!payload) return [];
  const code = statusCodeOf(payload);
  if (code !== '' && code !== '0') throw new CommentReadError('restricted', `未能读取列表（status_code=${code}，HTTP ${httpStatus}）`);
  const rows = Array.isArray(payload.aweme_list) ? payload.aweme_list : [];
  const items: VideoItem[] = [];
  const seen = new Set<string>();
  for (const raw of rows) {
    const item = awemeToItem(raw);
    if (item && !seen.has(item.id)) { seen.add(item.id); items.push(item); }
  }
  return items;
}

export type DanmakuItem = { id: string; text: string; offsetMs: number; type: number };
export type DanmakuPage = { items: DanmakuItem[]; total: number };

export function parseDanmakuList(body: string, httpStatus = 200): DanmakuPage {
  if (httpStatus === 401 || httpStatus === 403) throw new CommentReadError('auth', '登录状态已失效，请重新登录抖音。');
  if (httpStatus === 429) throw new CommentReadError('restricted', '请求过于频繁，请稍后再试。');
  if (httpStatus < 200 || httpStatus >= 300) throw new CommentReadError('network', `弹幕请求失败（HTTP ${httpStatus}）。`);
  if (/<(?:html|!doctype)/i.test(body.slice(0, 500))) throw new CommentReadError('restricted', '接口返回了网页，请重新登录或稍后再试。');
  if (!body.trim()) return { items: [], total: 0 };
  let payload: Record<string, unknown> | undefined;
  try { payload = record(safeJson(trimToFirstJson(body))); } catch { throw new CommentReadError('invalid', '弹幕响应不是有效 JSON。'); }
  if (!payload) throw new CommentReadError('invalid', '弹幕响应结构无效。');
  const code = statusCodeOf(payload);
  if (code !== '' && code !== '0') throw new CommentReadError('restricted', '未能读取弹幕，请稍后再试。');
  const rows = Array.isArray(payload.danmaku_list) ? (payload.danmaku_list as unknown[]) : [];
  const items: DanmakuItem[] = [];
  for (const raw of rows) {
    const row = record(raw);
    if (!row) continue;
    const text = typeof row.text === 'string' ? row.text.trim() : '';
    if (!text) continue;
    const offset = Number(row.offset_time);
    const id = row.danmaku_id != null ? String(row.danmaku_id) : `d${items.length}`;
    items.push({ id, text, offsetMs: Number.isFinite(offset) ? offset : 0, type: Number(row.danmaku_type) || 0 });
  }
  const total = Number(payload.total);
  return { items, total: Number.isFinite(total) ? total : items.length };
}

// ---------------------------------------------------------------- page bridge

export type BridgeOperation = 'comments' | 'commentReplies' | 'self' | 'likes' | 'favorites' | 'danmaku';
export type BridgeRequest = { id: string; operation: BridgeOperation; parameters: Record<string, string>; timeout: number };
export type BridgeResult = { id: string; status: number; body: string; error?: string; message?: string };

// The page-side request runner, embedded as a literal string — NOT function
// .toString(). Under Hermes, Function.prototype.toString() yields a
// `function f(){ [bytecode] }` placeholder, so serializing a JS function would
// inject a broken body and every request would throw SCRIPT_ERROR. A plain
// string survives the bundle verbatim and stays fully self-contained in the page.
// It is written with no backslash escapes so it can live in a template literal.
// a_bogus signer, inlined as a literal string (source: alphaply/DouyinComments
// douyin.js; pure JS, Math/Date/String only). Exposes MYLIKE_A_BOGUS.reply/detail.
const A_BOGUS_SOURCE = "var MYLIKE_A_BOGUS=(function(){\n// All the content in this article is only for learning and communication use, not for any other purpose, strictly prohibited for commercial use and illegal use, otherwise all the consequences are irrelevant to the author!\nfunction rc4_encrypt(plaintext, key) {\n    var s = [];\n    for (var i = 0; i < 256; i++) {\n        s[i] = i;\n    }\n    var j = 0;\n    for (var i = 0; i < 256; i++) {\n        j = (j + s[i] + key.charCodeAt(i % key.length)) % 256;\n        var temp = s[i];\n        s[i] = s[j];\n        s[j] = temp;\n    }\n\n    var i = 0;\n    var j = 0;\n    var cipher = [];\n    for (var k = 0; k < plaintext.length; k++) {\n        i = (i + 1) % 256;\n        j = (j + s[i]) % 256;\n        var temp = s[i];\n        s[i] = s[j];\n        s[j] = temp;\n        var t = (s[i] + s[j]) % 256;\n        cipher.push(String.fromCharCode(s[t] ^ plaintext.charCodeAt(k)));\n    }\n    return cipher.join('');\n}\n\nfunction le(e, r) {\n    return (e << (r %= 32) | e >>> 32 - r) >>> 0\n}\n\nfunction de(e) {\n    return 0 <= e && e < 16 ? 2043430169 : 16 <= e && e < 64 ? 2055708042 : void console['error'](\"invalid j for constant Tj\")\n}\n\nfunction pe(e, r, t, n) {\n    return 0 <= e && e < 16 ? (r ^ t ^ n) >>> 0 : 16 <= e && e < 64 ? (r & t | r & n | t & n) >>> 0 : (console['error']('invalid j for bool function FF'),\n        0)\n}\n\nfunction he(e, r, t, n) {\n    return 0 <= e && e < 16 ? (r ^ t ^ n) >>> 0 : 16 <= e && e < 64 ? (r & t | ~r & n) >>> 0 : (console['error']('invalid j for bool function GG'),\n        0)\n}\n\nfunction reset() {\n    this.reg[0] = 1937774191,\n        this.reg[1] = 1226093241,\n        this.reg[2] = 388252375,\n        this.reg[3] = 3666478592,\n        this.reg[4] = 2842636476,\n        this.reg[5] = 372324522,\n        this.reg[6] = 3817729613,\n        this.reg[7] = 2969243214,\n        this[\"chunk\"] = [],\n        this[\"size\"] = 0\n}\n\nfunction write(e) {\n    var a = \"string\" == typeof e ? function (e) {\n        n = encodeURIComponent(e)['replace'](/%([0-9A-F]{2})/g, (function (e, r) {\n                return String['fromCharCode'](\"0x\" + r)\n            }\n        ))\n            , a = new Array(n['length']);\n        return Array['prototype']['forEach']['call'](n, (function (e, r) {\n                a[r] = e.charCodeAt(0)\n            }\n        )),\n            a\n    }(e) : e;\n    this.size += a.length;\n    var f = 64 - this['chunk']['length'];\n    if (a['length'] < f)\n        this['chunk'] = this['chunk'].concat(a);\n    else\n        for (this['chunk'] = this['chunk'].concat(a.slice(0, f)); this['chunk'].length >= 64;)\n            this['_compress'](this['chunk']),\n                f < a['length'] ? this['chunk'] = a['slice'](f, Math['min'](f + 64, a['length'])) : this['chunk'] = [],\n                f += 64\n}\n\nfunction sum(e, t) {\n    e && (this['reset'](),\n        this['write'](e)),\n        this['_fill']();\n    for (var f = 0; f < this.chunk['length']; f += 64)\n        this._compress(this['chunk']['slice'](f, f + 64));\n    var i = null;\n    if (t == 'hex') {\n        i = \"\";\n        for (f = 0; f < 8; f++)\n            i += se(this['reg'][f]['toString'](16), 8, \"0\")\n    } else\n        for (i = new Array(32),\n                 f = 0; f < 8; f++) {\n            var c = this.reg[f];\n            i[4 * f + 3] = (255 & c) >>> 0,\n                c >>>= 8,\n                i[4 * f + 2] = (255 & c) >>> 0,\n                c >>>= 8,\n                i[4 * f + 1] = (255 & c) >>> 0,\n                c >>>= 8,\n                i[4 * f] = (255 & c) >>> 0\n        }\n    return this['reset'](),\n        i\n}\n\nfunction _compress(t) {\n    if (t < 64)\n        console.error(\"compress error: not enough data\");\n    else {\n        for (var f = function (e) {\n            for (var r = new Array(132), t = 0; t < 16; t++)\n                r[t] = e[4 * t] << 24,\n                    r[t] |= e[4 * t + 1] << 16,\n                    r[t] |= e[4 * t + 2] << 8,\n                    r[t] |= e[4 * t + 3],\n                    r[t] >>>= 0;\n            for (var n = 16; n < 68; n++) {\n                var a = r[n - 16] ^ r[n - 9] ^ le(r[n - 3], 15);\n                a = a ^ le(a, 15) ^ le(a, 23),\n                    r[n] = (a ^ le(r[n - 13], 7) ^ r[n - 6]) >>> 0\n            }\n            for (n = 0; n < 64; n++)\n                r[n + 68] = (r[n] ^ r[n + 4]) >>> 0;\n            return r\n        }(t), i = this['reg'].slice(0), c = 0; c < 64; c++) {\n            var o = le(i[0], 12) + i[4] + le(de(c), c)\n                , s = ((o = le(o = (4294967295 & o) >>> 0, 7)) ^ le(i[0], 12)) >>> 0\n                , u = pe(c, i[0], i[1], i[2]);\n            u = (4294967295 & (u = u + i[3] + s + f[c + 68])) >>> 0;\n            var b = he(c, i[4], i[5], i[6]);\n            b = (4294967295 & (b = b + i[7] + o + f[c])) >>> 0,\n                i[3] = i[2],\n                i[2] = le(i[1], 9),\n                i[1] = i[0],\n                i[0] = u,\n                i[7] = i[6],\n                i[6] = le(i[5], 19),\n                i[5] = i[4],\n                i[4] = (b ^ le(b, 9) ^ le(b, 17)) >>> 0\n        }\n        for (var l = 0; l < 8; l++)\n            this['reg'][l] = (this['reg'][l] ^ i[l]) >>> 0\n    }\n}\n\nfunction _fill() {\n    var a = 8 * this['size']\n        , f = this['chunk']['push'](128) % 64;\n    for (64 - f < 8 && (f -= 64); f < 56; f++)\n        this.chunk['push'](0);\n    for (var i = 0; i < 4; i++) {\n        var c = Math['floor'](a / 4294967296);\n        this['chunk'].push(c >>> 8 * (3 - i) & 255)\n    }\n    for (i = 0; i < 4; i++)\n        this['chunk']['push'](a >>> 8 * (3 - i) & 255)\n\n}\n\nfunction SM3() {\n    this.reg = [];\n    this.chunk = [];\n    this.size = 0;\n    this.reset()\n}\nSM3.prototype.reset = reset;\nSM3.prototype.write = write;\nSM3.prototype.sum = sum;\nSM3.prototype._compress = _compress;\nSM3.prototype._fill = _fill;\n\nfunction result_encrypt(long_str, num = null) {\n    let s_obj = {\n        \"s0\": \"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=\",\n        \"s1\": \"Dkdpgh4ZKsQB80/Mfvw36XI1R25+WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe=\",\n        \"s2\": \"Dkdpgh4ZKsQB80/Mfvw36XI1R25-WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe=\",\n        \"s3\": \"ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe\",\n        \"s4\": \"Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe\"\n    }\n    let constant = {\n        \"0\": 16515072,\n        \"1\": 258048,\n        \"2\": 4032,\n        \"str\": s_obj[num],\n    }\n\n    let result = \"\";\n    let lound = 0;\n    let long_int = get_long_int(lound, long_str);\n    for (let i = 0; i < long_str.length / 3 * 4; i++) {\n        if (Math.floor(i / 4) !== lound) {\n            lound += 1;\n            long_int = get_long_int(lound, long_str);\n        }\n        let key = i % 4;\n        switch (key) {\n            case 0:\n                temp_int = (long_int & constant[\"0\"]) >> 18;\n                result += constant[\"str\"].charAt(temp_int);\n                break;\n            case 1:\n                temp_int = (long_int & constant[\"1\"]) >> 12;\n                result += constant[\"str\"].charAt(temp_int);\n                break;\n            case 2:\n                temp_int = (long_int & constant[\"2\"]) >> 6;\n                result += constant[\"str\"].charAt(temp_int);\n                break;\n            case 3:\n                temp_int = long_int & 63;\n                result += constant[\"str\"].charAt(temp_int);\n                break;\n            default:\n                break;\n        }\n    }\n    return result;\n}\n\nfunction get_long_int(round, long_str) {\n    round = round * 3;\n    return (long_str.charCodeAt(round) << 16) | (long_str.charCodeAt(round + 1) << 8) | (long_str.charCodeAt(round + 2));\n}\n\nfunction gener_random(random, option) {\n    return [\n        (random & 255 & 170) | option[0] & 85, // 163\n        (random & 255 & 85) | option[0] & 170, //87\n        (random >> 8 & 255 & 170) | option[1] & 85, //37\n        (random >> 8 & 255 & 85) | option[1] & 170, //41\n    ]\n}\n\n//////////////////////////////////////////////\nfunction generate_rc4_bb_str(url_search_params, user_agent, window_env_str, suffix = \"cus\", Arguments = [0, 1, 14]) {\n    let sm3 = new SM3()\n    let start_time = Date.now()\n    /**\n     * 进行3次加密处理\n     * 1: url_search_params两次sm3之的结果\n     * 2: 对后缀两次sm3之的结果\n     * 3: 对ua处理之后的结果\n     */\n        // url_search_params两次sm3之的结果\n    let url_search_params_list = sm3.sum(sm3.sum(url_search_params + suffix))\n    // 对后缀两次sm3之的结果\n    let cus = sm3.sum(sm3.sum(suffix))\n    // 对ua处理之后的结果\n    let ua = sm3.sum(result_encrypt(rc4_encrypt(user_agent, String.fromCharCode.apply(null, [0.00390625, 1, Arguments[2]])), \"s3\"))\n    //\n    let end_time = Date.now()\n    // b\n    let b = {\n        8: 3, // 固定\n        10: end_time, //3次加密结束时间\n        15: {\n            \"aid\": 6383,\n            \"pageId\": 6241,\n            \"boe\": false,\n            \"ddrt\": 7,\n            \"paths\": {\n                \"include\": [\n                    {},\n                    {},\n                    {},\n                    {},\n                    {},\n                    {},\n                    {}\n                ],\n                \"exclude\": []\n            },\n            \"track\": {\n                \"mode\": 0,\n                \"delay\": 300,\n                \"paths\": []\n            },\n            \"dump\": true,\n            \"rpU\": \"\"\n        },\n        16: start_time, //3次加密开始时间\n        18: 44, //固定\n        19: [1, 0, 1, 5],\n    }\n\n    //3次加密开始时间\n    b[20] = (b[16] >> 24) & 255\n    b[21] = (b[16] >> 16) & 255\n    b[22] = (b[16] >> 8) & 255\n    b[23] = b[16] & 255\n    b[24] = (b[16] / 256 / 256 / 256 / 256) >> 0\n    b[25] = (b[16] / 256 / 256 / 256 / 256 / 256) >> 0\n\n    // 参数Arguments [0, 1, 14, ...]\n    // let Arguments = [0, 1, 14]\n    b[26] = (Arguments[0] >> 24) & 255\n    b[27] = (Arguments[0] >> 16) & 255\n    b[28] = (Arguments[0] >> 8) & 255\n    b[29] = Arguments[0] & 255\n\n    b[30] = (Arguments[1] / 256) & 255\n    b[31] = (Arguments[1] % 256) & 255\n    b[32] = (Arguments[1] >> 24) & 255\n    b[33] = (Arguments[1] >> 16) & 255\n\n    b[34] = (Arguments[2] >> 24) & 255\n    b[35] = (Arguments[2] >> 16) & 255\n    b[36] = (Arguments[2] >> 8) & 255\n    b[37] = Arguments[2] & 255\n\n    // (url_search_params + \"cus\") 两次sm3之的结果\n    /**let url_search_params_list = [\n     91, 186,  35,  86, 143, 253,   6,  76,\n     34,  21, 167, 148,   7,  42, 192, 219,\n     188,  20, 182,  85, 213,  74, 213, 147,\n     37, 155,  93, 139,  85, 118, 228, 213\n     ]*/\n    b[38] = url_search_params_list[21]\n    b[39] = url_search_params_list[22]\n\n    // (\"cus\") 对后缀两次sm3之的结果\n    /**\n     * let cus = [\n     136, 101, 114, 147,  58,  77, 207, 201,\n     215, 162, 154,  93, 248,  13, 142, 160,\n     105,  73, 215, 241,  83,  58,  51,  43,\n     255,  38, 168, 141, 216, 194,  35, 236\n     ]*/\n    b[40] = cus[21]\n    b[41] = cus[22]\n\n    // 对ua处理之后的结果\n    /**\n     * let ua = [\n     129, 190,  70, 186,  86, 196, 199,  53,\n     99,  38,  29, 209, 243,  17, 157,  69,\n     147, 104,  53,  23, 114, 126,  66, 228,\n     135,  30, 168, 185, 109, 156, 251,  88\n     ]*/\n    b[42] = ua[23]\n    b[43] = ua[24]\n\n    //3次加密结束时间\n    b[44] = (b[10] >> 24) & 255\n    b[45] = (b[10] >> 16) & 255\n    b[46] = (b[10] >> 8) & 255\n    b[47] = b[10] & 255\n    b[48] = b[8]\n    b[49] = (b[10] / 256 / 256 / 256 / 256) >> 0\n    b[50] = (b[10] / 256 / 256 / 256 / 256 / 256) >> 0\n\n\n    // object配置项\n    b[51] = b[15]['pageId']\n    b[52] = (b[15]['pageId'] >> 24) & 255\n    b[53] = (b[15]['pageId'] >> 16) & 255\n    b[54] = (b[15]['pageId'] >> 8) & 255\n    b[55] = b[15]['pageId'] & 255\n\n    b[56] = b[15]['aid']\n    b[57] = b[15]['aid'] & 255\n    b[58] = (b[15]['aid'] >> 8) & 255\n    b[59] = (b[15]['aid'] >> 16) & 255\n    b[60] = (b[15]['aid'] >> 24) & 255\n\n    // 中间进行了环境检测\n    // 代码索引:  2496 索引值:  17 （索引64关键条件）\n    // '1536|747|1536|834|0|30|0|0|1536|834|1536|864|1525|747|24|24|Win32'.charCodeAt()得到65位数组\n    /**\n     * let window_env_list = [49, 53, 51, 54, 124, 55, 52, 55, 124, 49, 53, 51, 54, 124, 56, 51, 52, 124, 48, 124, 51,\n     * 48, 124, 48, 124, 48, 124, 49, 53, 51, 54, 124, 56, 51, 52, 124, 49, 53, 51, 54, 124, 56,\n     * 54, 52, 124, 49, 53, 50, 53, 124, 55, 52, 55, 124, 50, 52, 124, 50, 52, 124, 87, 105, 110,\n     * 51, 50]\n     */\n    let window_env_list = [];\n    for (let index = 0; index < window_env_str.length; index++) {\n        window_env_list.push(window_env_str.charCodeAt(index))\n    }\n    b[64] = window_env_list.length\n    b[65] = b[64] & 255\n    b[66] = (b[64] >> 8) & 255\n\n    b[69] = [].length\n    b[70] = b[69] & 255\n    b[71] = (b[69] >> 8) & 255\n\n    b[72] = b[18] ^ b[20] ^ b[26] ^ b[30] ^ b[38] ^ b[40] ^ b[42] ^ b[21] ^ b[27] ^ b[31] ^ b[35] ^ b[39] ^ b[41] ^ b[43] ^ b[22] ^\n        b[28] ^ b[32] ^ b[36] ^ b[23] ^ b[29] ^ b[33] ^ b[37] ^ b[44] ^ b[45] ^ b[46] ^ b[47] ^ b[48] ^ b[49] ^ b[50] ^ b[24] ^\n        b[25] ^ b[52] ^ b[53] ^ b[54] ^ b[55] ^ b[57] ^ b[58] ^ b[59] ^ b[60] ^ b[65] ^ b[66] ^ b[70] ^ b[71]\n    let bb = [\n        b[18], b[20], b[52], b[26], b[30], b[34], b[58], b[38], b[40], b[53], b[42], b[21], b[27], b[54], b[55], b[31],\n        b[35], b[57], b[39], b[41], b[43], b[22], b[28], b[32], b[60], b[36], b[23], b[29], b[33], b[37], b[44], b[45],\n        b[59], b[46], b[47], b[48], b[49], b[50], b[24], b[25], b[65], b[66], b[70], b[71]\n    ]\n    bb = bb.concat(window_env_list).concat(b[72])\n    return rc4_encrypt(String.fromCharCode.apply(null, bb), String.fromCharCode.apply(null, [121]));\n}\n\nfunction generate_random_str() {\n    let random_str_list = []\n    random_str_list = random_str_list.concat(gener_random(Math.random() * 10000, [3, 45]))\n    random_str_list = random_str_list.concat(gener_random(Math.random() * 10000, [1, 0]))\n    random_str_list = random_str_list.concat(gener_random(Math.random() * 10000, [1, 5]))\n    return String.fromCharCode.apply(null, random_str_list)\n}\n\nfunction sign(url_search_params, user_agent, arguments) {\n    /**\n     * url_search_params：\"device_platform=webapp&aid=6383&channel=channel_pc_web&update_version_code=170400&pc_client_type=1&version_code=170400&version_name=17.4.0&cookie_enabled=true&screen_width=1536&screen_height=864&browser_language=zh-CN&browser_platform=Win32&browser_name=Chrome&browser_version=123.0.0.0&browser_online=true&engine_name=Blink&engine_version=123.0.0.0&os_name=Windows&os_version=10&cpu_core_num=16&device_memory=8&platform=PC&downlink=10&effective_type=4g&round_trip_time=50&webid=7362810250930783783&msToken=VkDUvz1y24CppXSl80iFPr6ez-3FiizcwD7fI1OqBt6IICq9RWG7nCvxKb8IVi55mFd-wnqoNkXGnxHrikQb4PuKob5Q-YhDp5Um215JzlBszkUyiEvR\"\n     * user_agent：\"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36\"\n     */\n    let result_str = generate_random_str() + generate_rc4_bb_str(\n        url_search_params,\n        user_agent,\n        \"1536|747|1536|834|0|30|0|0|1536|834|1536|864|1525|747|24|24|Win32\",\n        \"cus\",\n        arguments\n    );\n    return result_encrypt(result_str, \"s4\") + \"=\";\n}\n\nfunction sign_datail(params, userAgent) {\n    return sign(params, userAgent, [0, 1, 14])\n}\n\nfunction sign_reply(params, userAgent) {\n    return sign(params, userAgent, [0, 1, 8])\n}\nreturn {reply:sign_reply, detail:sign_datail, sign:sign};\n})();";

const PAGE_SCRIPT = [
  A_BOGUS_SOURCE,
  "var PATHS={self:'/aweme/v1/web/user/profile/self/',comments:'/aweme/v1/web/comment/list/',commentReplies:'/aweme/v1/web/comment/list/reply/',likes:'/aweme/v1/web/aweme/favorite/',favorites:'/aweme/v1/web/aweme/listcollection/',danmaku:'/aweme/v1/web/danmaku/get_v2/'};",
  "function mylikeToken(params){var parts=(document.cookie||'').split(';');var tk='';for(var c=0;c<parts.length;c++){var seg=parts[c];while(seg.charAt(0)===' '){seg=seg.substring(1);}if(seg.indexOf('msToken=')===0){tk=seg.substring(8);break;}}if(tk){try{tk=decodeURIComponent(tk);}catch(_e){}params.set('msToken',tk);}}",
  "function mylikeCookieFp(params){var parts=(document.cookie||'').split(';');var fp='',webid='';for(var i=0;i<parts.length;i++){var seg=parts[i];while(seg.charAt(0)===' '){seg=seg.substring(1);}if(seg.indexOf('s_v_web_id=')===0){fp=seg.substring(11);}else if(seg.indexOf('webid=')===0){webid=seg.substring(6);}}if(fp){try{fp=decodeURIComponent(fp);}catch(_e){}params.set('verifyFp',fp);params.set('fp',fp);}if(webid){try{webid=decodeURIComponent(webid);}catch(_e){}params.set('webid',webid);}}",
  "function mylikeFp(params){params.set('pc_client_type','1');params.set('browser_language',navigator.language||'');params.set('browser_platform',navigator.platform||'');params.set('browser_online',String(navigator.onLine));if(navigator.hardwareConcurrency){params.set('cpu_core_num',String(navigator.hardwareConcurrency));}var ua=navigator.userAgent||'';var ci=ua.indexOf('Chrome/');var chrome='';if(ci>=0){var mm=ua.substring(ci+7).match(/^[0-9.]+/);if(mm){chrome=mm[0];}}if(chrome){params.set('browser_name','Chrome');params.set('browser_version',chrome);params.set('engine_name','Blink');params.set('engine_version',chrome);}var os='';if(ua.indexOf('Windows')>=0){os='Windows';}else if(ua.indexOf('Macintosh')>=0){os='Mac OS';}else if(ua.indexOf('Linux')>=0){os='Linux';}if(os){params.set('os_name',os);}if(typeof screen!=='undefined'){params.set('screen_width',String(screen.width));params.set('screen_height',String(screen.height));}}",
  "function mylikeRequest(request){return new Promise(function(resolve){try{",
  "var op=request.operation;var p=request.parameters||{};var keys=Object.keys(p);var i;",
  "var params=new URLSearchParams({device_platform:'webapp',aid:'6383',channel:'channel_pc_web',version_code:'290100',version_name:'29.1.0',update_version_code:'170400',cookie_enabled:'true',platform:'PC'});",
  "var method='GET';var body=null;var referrer='';var headers={accept:'application/json, text/plain, */*'};var href;",
  "if(op==='favorites'){mylikeFp(params);params.set('pc_libra_divert','Windows');params.set('publish_video_strategy_type','2');mylikeCookieFp(params);mylikeToken(params);referrer='https://www.douyin.com/user/self?from_tab_name=main&showTab=favorite_collection';method='POST';headers['content-type']='application/x-www-form-urlencoded;charset=UTF-8';headers['x-secsdk-csrf-token']='DOWNGRADE';body=new URLSearchParams({cursor:p.cursor||'0',count:p.count||'20'}).toString();}",
  "else{for(i=0;i<keys.length;i++){params.set(keys[i],p[keys[i]]);}if(op==='comments'||op==='commentReplies'){if(!params.has('count')){params.set('count','20');}mylikeFp(params);mylikeToken(params);referrer='https://www.douyin.com/video/'+(p.aweme_id||p.item_id||'');}else if(op==='likes'){mylikeFp(params);mylikeCookieFp(params);mylikeToken(params);referrer='https://www.douyin.com/user/self?from_tab_name=main&showTab=likes';}else if(op==='danmaku'){mylikeFp(params);mylikeToken(params);referrer='https://www.douyin.com/video/'+(p.item_id||'');}}",
  "var query=params.toString();",
  // Risk-gated private endpoints (reply list, my likes, my collections) are not
  // auto-signed by the mobile WebView page (unlike desktop Electron where the
  // page's webmssdk wraps fetch). Sign them here so they don't hang/return empty.
  // commentReplies uses the sign_reply ([0,1,8]) variant; everything else detail.
  "if((op==='commentReplies'||op==='likes'||op==='favorites'||op==='danmaku')&&typeof MYLIKE_A_BOGUS!=='undefined'&&MYLIKE_A_BOGUS){try{var ab=(op==='commentReplies'?MYLIKE_A_BOGUS.reply:MYLIKE_A_BOGUS.detail)(query,navigator.userAgent||'');if(ab){query=query+'&a_bogus='+ab;}}catch(_signErr){}}",
  "href='https://www.douyin.com'+PATHS[op]+'?'+query;",
  "var controller=new AbortController();var timer=setTimeout(function(){try{controller.abort();}catch(_e){}},request.timeout||15000);",
  "var opts={credentials:'include',cache:'no-store',signal:controller.signal,method:method,headers:headers};if(referrer){opts.referrer=referrer;}if(body){opts.body=body;}",
  "fetch(href,opts).then(function(resp){return resp.text().then(function(txt){clearTimeout(timer);resolve({id:request.id,status:resp.status,body:txt});});}).catch(function(err){clearTimeout(timer);var aborted=err&&err.name==='AbortError';resolve({id:request.id,status:0,body:'',error:aborted?'TIMEOUT':'NETWORK_ERROR'});});",
  "}catch(e){resolve({id:request.id,status:0,body:'',error:'SCRIPT_ERROR',message:String(e&&e.message?e.message:e)});}});}",
].join('\n');

function serialize(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function buildBridgeScript(request: BridgeRequest): string {
  const payload = serialize(request);
  const id = serialize(request.id);
  return `(function(){try{var req=${payload};function post(o){try{window.ReactNativeWebView.postMessage(JSON.stringify(o));}catch(_e){}}${PAGE_SCRIPT}mylikeRequest(req).then(function(r){r=r||{};r.__mylike=true;post(r);}).catch(function(e){post({__mylike:true,id:req.id,status:0,body:'',error:'SCRIPT_ERROR',message:String(e&&e.message?e.message:e)});});}catch(e){try{window.ReactNativeWebView.postMessage(JSON.stringify({__mylike:true,id:${id},status:0,body:'',error:'SCRIPT_ERROR',message:String(e&&e.message?e.message:e)}));}catch(_e){}}})();true;`;
}

export function parseBridgeMessage(raw: string): BridgeResult | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  const message = record(value);
  if (!message || message.__mylike !== true || typeof message.id !== 'string') return null;
  return {
    id: message.id,
    status: typeof message.status === 'number' ? message.status : Number(message.status) || 0,
    body: typeof message.body === 'string' ? message.body : '',
    error: typeof message.error === 'string' && message.error ? message.error : undefined,
    message: typeof message.message === 'string' ? message.message : undefined,
  };
}
