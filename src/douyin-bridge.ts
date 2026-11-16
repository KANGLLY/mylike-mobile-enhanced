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
function statusCodeOf(payload: Record<string, unknown>): string {
  const raw = payload.status_code;
  const nested = record(raw)?.StatusCode ?? raw;
  return nested == null ? '' : String(nested);
}
function commentAttachments(row: Record<string, unknown>): CommentAttachment[] {
  const out: CommentAttachment[] = [];
  const imageList = Array.isArray(row.image_list) ? row.image_list : [];
  for (const value of imageList) {
    const item = record(value);
    const list = item && Array.isArray(item.url_list) ? item.url_list : Array.isArray(value) ? value : [];
    const url = firstHttps(list);
    if (url) out.push({ url, type: 'image' });
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
  try { payload = record(safeJson(body)); } catch { throw new CommentReadError('invalid', '评论响应不是有效 JSON。'); }
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
    const cursor = numericId(payload.cursor);
    if (/^0+$/.test(cursor)) throw new CommentReadError('invalid', '分页游标异常。');
    nextCursor = cursor;
  }
  if (nextCursor !== null && nextCursor === requestedCursor) throw new CommentReadError('stalled', '评论分页没有推进，请重试。');
  return { items, nextCursor, hasMore: more };
}

export function parseSelf(body: string, httpStatus = 200): { loggedIn: boolean; nickname?: string } {
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
  return { loggedIn: true, nickname: text(user.nickname) || undefined };
}

// ---------------------------------------------------------------- page bridge

export type BridgeOperation = 'comments' | 'commentReplies' | 'self';
export type BridgeRequest = { id: string; operation: BridgeOperation; parameters: Record<string, string>; timeout: number };
export type BridgeResult = { id: string; status: number; body: string; error?: string; message?: string };

// The page-side request runner, embedded as a literal string — NOT function
// .toString(). Under Hermes, Function.prototype.toString() yields a
// `function f(){ [bytecode] }` placeholder, so serializing a JS function would
// inject a broken body and every request would throw SCRIPT_ERROR. A plain
// string survives the bundle verbatim and stays fully self-contained in the page.
// It is written with no backslash escapes so it can live in a template literal.
const PAGE_SCRIPT = [
  "var PATHS={self:'/aweme/v1/web/user/profile/self/',comments:'/aweme/v1/web/comment/list/',commentReplies:'/aweme/v1/web/comment/list/reply/'};",
  "function mylikeRequest(request){return new Promise(function(resolve){try{",
  "var params=new URLSearchParams({device_platform:'webapp',aid:'6383',channel:'channel_pc_web',version_code:'290100',version_name:'29.1.0',update_version_code:'170400',cookie_enabled:'true',platform:'PC'});",
  "var p=request.parameters||{};var keys=Object.keys(p);for(var i=0;i<keys.length;i++){params.set(keys[i],p[keys[i]]);}",
  "var commentRead=request.operation==='comments'||request.operation==='commentReplies';var referrer;",
  "if(commentRead){if(!params.has('count')){params.set('count','20');}params.set('pc_client_type','1');",
  "params.set('browser_language',navigator.language||'');params.set('browser_platform',navigator.platform||'');params.set('browser_online',String(navigator.onLine));",
  "if(navigator.hardwareConcurrency){params.set('cpu_core_num',String(navigator.hardwareConcurrency));}",
  "var ua=navigator.userAgent||'';var ci=ua.indexOf('Chrome/');var chrome='';if(ci>=0){var mm=ua.substring(ci+7).match(/^[0-9.]+/);if(mm){chrome=mm[0];}}",
  "if(chrome){params.set('browser_name','Chrome');params.set('browser_version',chrome);params.set('engine_name','Blink');params.set('engine_version',chrome);}",
  "var os='';if(ua.indexOf('Windows')>=0){os='Windows';}else if(ua.indexOf('Macintosh')>=0){os='Mac OS';}else if(ua.indexOf('Linux')>=0){os='Linux';}if(os){params.set('os_name',os);}",
  "if(typeof screen!=='undefined'){params.set('screen_width',String(screen.width));params.set('screen_height',String(screen.height));}",
  "var parts=(document.cookie||'').split(';');var tk='';for(var c=0;c<parts.length;c++){var seg=parts[c];while(seg.charAt(0)===' '){seg=seg.substring(1);}if(seg.indexOf('msToken=')===0){tk=seg.substring(8);break;}}if(tk){try{tk=decodeURIComponent(tk);}catch(_e){}params.set('msToken',tk);}",
  "referrer='https://www.douyin.com/video/'+(p.aweme_id||p.item_id||'');}",
  "var controller=new AbortController();var timer=setTimeout(function(){try{controller.abort();}catch(_e){}},request.timeout||15000);",
  "var opts={credentials:'include',cache:'no-store',signal:controller.signal,method:'GET',headers:{accept:'application/json, text/plain, */*'}};if(referrer){opts.referrer=referrer;}",
  "fetch('https://www.douyin.com'+PATHS[request.operation]+'?'+params.toString(),opts).then(function(resp){return resp.text().then(function(body){clearTimeout(timer);resolve({id:request.id,status:resp.status,body:body});});}).catch(function(err){clearTimeout(timer);var aborted=err&&err.name==='AbortError';resolve({id:request.id,status:0,body:'',error:aborted?'TIMEOUT':'NETWORK_ERROR'});});",
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
