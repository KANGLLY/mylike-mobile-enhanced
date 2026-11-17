// App-wide Douyin session.
//
// A single persistent desktop WebView is the source of truth for login and for
// every comment request: it is the page the user scans the QR code on, AND the
// page that signs/runs the requests. Keeping login and requests in the same
// WebView means a request always carries the exact cookies set by login.
//
// Normally it is parked at 2x2 in a corner (invisible, non-interactive). When the
// user taps "登录" it expands full-screen over the app so they can scan; the same
// native instance is reused, so the session is never rebuilt.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Modal, Pressable, StatusBar, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import {
  buildBridgeScript, CommentReadError, parseBridgeMessage, parseSelf, parseVideoList,
  type BridgeOperation, type BridgeResult,
} from '../douyin-bridge';
import { clearWebViewCookies } from './home-icon';
import type { CaptureBatchResult, CaptureOptions, CapturePage as SyncCapturePage, SyncEngine, SyncStopReason } from './sync-library';

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
// Desktop login page: forces the QR login overlay. The mobile site only shows a
// "download app" landing page, so login must be done on the desktop layout.
const LOGIN_URL = 'https://www.douyin.com/user/self?showTab=like';
// Force a desktop-like navigator so the PC page's fingerprint stays consistent.
const FINGERPRINT = `(function(){try{Object.defineProperty(navigator,'platform',{get:function(){return 'Win32';}});Object.defineProperty(navigator,'hardwareConcurrency',{get:function(){return 8;}});}catch(e){}})();true;`;

// The logged-in page itself loads the likes / favourites tabs; we hook its own
// fetch/XHR to capture signed responses and the live request template. For long
// scans we replay subsequent cursors through the page's live SDK (zero DOM
// bloat) and fall back to DOM-slimming scroll if direct requests are rejected.
const LIKES_URL = 'https://www.douyin.com/user/self?showTab=like';
const FAVORITES_URL = 'https://www.douyin.com/user/self?showTab=favorite_collection';
const CAPTURE_HOOK = `(function(){try{
function send(o){try{window.ReactNativeWebView.postMessage(JSON.stringify(o));}catch(e){}}
function opOf(u){try{if(!u)return '';if(u.indexOf('/aweme/v1/web/aweme/favorite/')>=0)return 'likes';if(u.indexOf('/aweme/v1/web/aweme/listcollection/')>=0)return 'favorites';}catch(e){}return '';}
function readHeaders(h){var out={};if(!h)return out;try{if(typeof h.forEach==='function'){h.forEach(function(v,k){out[k]=v;});return out;}}catch(e){}try{if(Array.isArray(h)){for(var i=0;i<h.length;i++){if(h[i]&&h[i].length>=2)out[h[i][0]]=h[i][1];}return out;}}catch(e){}try{var ks=Object.keys(h);for(var j=0;j<ks.length;j++){out[ks[j]]=h[ks[j]];}}catch(e){}return out;}
function readBody(b){if(!b)return '';if(typeof b==='string')return b;try{if(typeof URLSearchParams!=='undefined'&&b instanceof URLSearchParams)return b.toString();}catch(e){}return '';}
function saveTpl(op,transport,url,method,headers,body){if(!op)return;if(window.__mylikeTpl&&window.__mylikeTpl.op===op)return;window.__mylikeTpl={op:op,transport:transport,url:String(url||''),method:String(method||'GET'),headers:readHeaders(headers),body:readBody(body)};}
window.__mylikeDirectReqId='';window.__mylikeDirectCursor='';
var of=window.fetch;
if(of){window.fetch=function(input,init){var url='';try{url=typeof input==='string'?input:(input&&input.url)||'';}catch(e){}var op=opOf(url);var rid='';var dcur='';if(op&&window.__mylikeDirectReqId){rid=window.__mylikeDirectReqId;dcur=window.__mylikeDirectCursor;window.__mylikeDirectReqId='';window.__mylikeDirectCursor='';}if(op&&!rid){var hdrs=readHeaders(input&&input.headers);var ih=readHeaders(init&&init.headers);var hk=Object.keys(ih);for(var hi=0;hi<hk.length;hi++){hdrs[hk[hi]]=ih[hk[hi]];}saveTpl(op,'fetch',url,(init&&init.method)||(input&&input.method)||'GET',hdrs,init&&init.body);}var pr=of.apply(this,arguments);if(op){try{pr.then(function(resp){try{resp.clone().text().then(function(t){send({__mylikeCap:true,op:op,status:resp.status,body:t,reqId:rid,cursor:dcur,engine:rid?'direct':'scroll'});});}catch(e){if(rid)send({__mylikeCap:true,op:op,status:resp.status||0,body:'',reqId:rid,cursor:dcur,engine:'direct',error:'READ_ERROR'});}}).catch(function(err){if(rid)send({__mylikeCap:true,op:op,status:0,body:'',reqId:rid,cursor:dcur,engine:'direct',error:String((err&&err.message)||err||'NETWORK_ERROR')});});}catch(e){}}return pr;};}
var oo=XMLHttpRequest.prototype.open,oh=XMLHttpRequest.prototype.setRequestHeader,os=XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open=function(m,u){try{this.__mop=opOf(u);this.__murl=u;this.__mmethod=m||'GET';this.__mheaders={};}catch(e){}return oo.apply(this,arguments);};
XMLHttpRequest.prototype.setRequestHeader=function(k,v){try{if(this.__mop&&this.__mheaders)this.__mheaders[k]=v;}catch(e){}return oh.apply(this,arguments);};
XMLHttpRequest.prototype.send=function(b){var x=this;var rid='';var dcur='';if(x.__mop&&window.__mylikeDirectReqId){rid=window.__mylikeDirectReqId;dcur=window.__mylikeDirectCursor;window.__mylikeDirectReqId='';window.__mylikeDirectCursor='';}if(x.__mop&&!rid){saveTpl(x.__mop,'xhr',x.__murl,x.__mmethod,x.__mheaders,b);}if(x.__mop){x.__mrid=rid;x.__mdcur=dcur;try{x.addEventListener('load',function(){try{send({__mylikeCap:true,op:x.__mop,status:x.status,body:x.responseText,reqId:x.__mrid||'',cursor:x.__mdcur||'',engine:x.__mrid?'direct':'scroll'});}catch(e){}});x.addEventListener('error',function(){if(x.__mrid)send({__mylikeCap:true,op:x.__mop,status:0,body:'',reqId:x.__mrid,cursor:x.__mdcur||'',engine:'direct',error:'NETWORK_ERROR'});});x.addEventListener('timeout',function(){if(x.__mrid)send({__mylikeCap:true,op:x.__mop,status:0,body:'',reqId:x.__mrid,cursor:x.__mdcur||'',engine:'direct',error:'TIMEOUT'});});}catch(e){}}return os.apply(this,arguments);};
window.__mylikePauseScroll=function(){if(window.__mylikeScrollCtrl)window.__mylikeScrollCtrl.paused=true;};
window.__mylikeResumeScroll=function(){if(window.__mylikeScrollCtrl)window.__mylikeScrollCtrl.paused=false;};
window.__mylikeFetchPage=function(reqId,cursor){try{var tpl=window.__mylikeTpl;if(!tpl){send({__mylikeCap:true,op:'',status:0,body:'',reqId:String(reqId),cursor:String(cursor),engine:'direct',error:'NO_TEMPLATE'});return;}var u=new URL(tpl.url,location.origin);u.searchParams.delete('a_bogus');u.searchParams.delete('X-Bogus');u.searchParams.delete('x-bogus');if(tpl.op==='likes'){u.searchParams.set('max_cursor',String(cursor));}else{if(u.searchParams.has('cursor')||(tpl.method||'GET').toUpperCase()==='GET'){u.searchParams.set('cursor',String(cursor));}}var body=tpl.body||'';if(body){try{if(body.charAt(0)==='{'){var obj=JSON.parse(body);if('cursor' in obj)obj.cursor=Number(cursor)||cursor;body=JSON.stringify(obj);}else{var bp=new URLSearchParams(body);bp.set('cursor',String(cursor));body=bp.toString();}}catch(e){}}var hdrs={};var ks=Object.keys(tpl.headers||{});for(var i=0;i<ks.length;i++){var k=ks[i];var lk=String(k).toLowerCase();if(lk.indexOf('bd-ticket-guard')===0||lk==='x-bogus'||lk==='content-length'||lk==='host'||lk==='cookie'||lk==='user-agent'||lk==='referer'||lk==='origin')continue;hdrs[k]=tpl.headers[k];}window.__mylikeDirectReqId=String(reqId);window.__mylikeDirectCursor=String(cursor);if(tpl.transport==='xhr'){var xhr=new XMLHttpRequest();xhr.withCredentials=true;xhr.open(tpl.method||'GET',u.toString(),true);var hks=Object.keys(hdrs);for(var j=0;j<hks.length;j++){try{xhr.setRequestHeader(hks[j],hdrs[hks[j]]);}catch(e){}}xhr.send(body||null);}else{var opts={method:tpl.method||'GET',credentials:'include',headers:hdrs};if(body&&String(tpl.method||'GET').toUpperCase()!=='GET')opts.body=body;window.fetch(u.toString(),opts).catch(function(){});}}catch(e){window.__mylikeDirectReqId='';window.__mylikeDirectCursor='';send({__mylikeCap:true,op:(window.__mylikeTpl&&window.__mylikeTpl.op)||'',status:0,body:'',reqId:String(reqId),cursor:String(cursor),engine:'direct',error:String((e&&e.message)||e||'DIRECT_ERROR')});}};
}catch(e){}})();true;`;
const captureScroll = (max: number, opKind: 'likes' | 'favorites') => `(function(){var ctrl=window.__mylikeScrollCtrl={paused:false,n:0,tick:0,box:null};function findBox(){if(ctrl.box&&ctrl.box.isConnected&&ctrl.box.scrollHeight>ctrl.box.clientHeight+100)return ctrl.box;var els=document.querySelectorAll('div');var best=null,bh=0;for(var i=0;i<els.length;i++){var el=els[i];if(el.scrollHeight>el.clientHeight+100&&el.clientHeight>300&&el.scrollHeight>bh){bh=el.scrollHeight;best=el;}}ctrl.box=best;return best;}function pruneDom(){try{var imgs=document.querySelectorAll('img');for(var i=0;i<imgs.length;i++){var img=imgs[i];if(img.dataset&&img.dataset.mylikePruned)continue;var r=img.getBoundingClientRect();if(r.bottom<-800){if(img.dataset)img.dataset.mylikePruned='1';img.removeAttribute('src');img.removeAttribute('srcset');}}var vids=document.querySelectorAll('video');for(var j=0;j<vids.length;j++){var v=vids[j];if(v.dataset&&v.dataset.mylikePruned)continue;var vr=v.getBoundingClientRect();if(vr.bottom<-800){if(v.dataset)v.dataset.mylikePruned='1';try{v.pause();}catch(e){}v.removeAttribute('src');try{v.load();}catch(e){}}}}catch(e){}}function push(){if(ctrl.paused)return;try{window.scrollTo(0,1e9);}catch(e){}try{document.documentElement.scrollTop=1e9;document.body.scrollTop=1e9;}catch(e){}try{var box=findBox();if(box){box.scrollTop=box.scrollHeight;}}catch(e){}if(++ctrl.tick%3===0)pruneDom();}var iv=setInterval(function(){if(ctrl.paused)return;push();if(++ctrl.n>${max}){clearInterval(iv);try{window.ReactNativeWebView.postMessage(JSON.stringify({__mylikeScrollEnd:true,op:'${opKind}'}));}catch(e){}}},1000);push();})();true;`;

export type CapturePage = SyncCapturePage;

type Pending = { resolve: (value: BridgeResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export type DouyinSessionValue = {
  mounted: boolean;
  loggedIn: boolean;
  checking: boolean;
  loginVisible: boolean;
  loginError: string;
  loginDebug: string;
  nickname: string;
  openLogin: () => void;
  closeLogin: () => void;
  completeLogin: () => Promise<boolean>;
  checkLogin: (silent?: boolean) => Promise<boolean>;
  logout: () => Promise<void>;
  request: (operation: BridgeOperation, parameters: Record<string, string>, timeoutMs?: number) => Promise<BridgeResult>;
  captureCollection: (kind: 'likes' | 'favorites', options?: CaptureOptions & { stop?: () => boolean }) => Promise<CapturePage[] | CaptureBatchResult>;
  cancelCapture: () => void;
};

const fallback: DouyinSessionValue = {
  mounted: false, loggedIn: false, checking: false, loginVisible: false, loginError: '', loginDebug: '', nickname: '',
  openLogin: () => {}, closeLogin: () => {}, completeLogin: async () => false, checkLogin: async () => false, logout: async () => {},
  request: async () => { throw new CommentReadError('bridge', '评论服务尚未就绪。'); },
  captureCollection: async () => [],
  cancelCapture: () => {},
};
const SessionContext = createContext<DouyinSessionValue>(fallback);
export function useDouyinSession(): DouyinSessionValue { return useContext(SessionContext); }

// Turn a raw self-endpoint response into a short human label for on-screen
// diagnostics, e.g. "HTTP 200 · status_code=8".
function describeSelf(status: number, body: string): string {
  if (status === 0) return '无法连接（网络错误）';
  if (!body.trim()) return `HTTP ${status} · 空响应`;
  const match = body.match(/"status_code"\s*:\s*"?(-?\d+)"?/);
  if (match) return `HTTP ${status} · status_code=${match[1]}`;
  if (/<(?:html|!doctype)/i.test(body.slice(0, 200))) return `HTTP ${status} · 返回网页`;
  return `HTTP ${status}`;
}

export function DouyinSessionProvider({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const webRef = useRef<any>(null);
  const capWebRef = useRef<any>(null);
  const pending = useRef(new Map<string, Pending>());
  const sequence = useRef(0);
  const ready = useRef<{ promise: Promise<void>; resolve: () => void } | null>(null);
  const mountedRef = useRef(false);

  const [mounted, setMounted] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);
  const [nickname, setNickname] = useState('');
  const [checking, setChecking] = useState(false);
  const [loginVisible, setLoginVisible] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [loginDebug, setLoginDebug] = useState('');
  const [resetKey, setResetKey] = useState(0);
  const [capture, setCapture] = useState<{ kind: 'likes' | 'favorites'; nonce: number; maxScrolls: number } | null>(null);
  type CapState = {
    kind: 'likes' | 'favorites';
    mode: NonNullable<CaptureOptions['mode']>;
    resumeCursor: string | null;
    pages: CapturePage[];
    seen: Set<string>;
    done: boolean;
    onPage?: (page: CapturePage) => void;
    maxScrolls: number;
    idleTimeoutMs: number;
    stop?: () => boolean;
    startedAt: number;
    usedDirect: boolean;
    usedScroll: boolean;
    directTried: boolean;
    directSuccessPages: number;
    directRetries: number;
    pendingReqId: string;
    pendingCursor: string;
    lastHasMore: boolean | null;
    lastCursor: string | null;
    lastStatus: number | null;
    lastStatusCode: string;
    lastDetail: string;
  };
  const capRef = useRef<CapState | null>(null);
  const capSeq = useRef(0);
  const capDirectSeq = useRef(0);
  const capTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const capIdle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const capDirectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const capFinish = useRef<((reason?: SyncStopReason, detail?: string) => void) | null>(null);

  const ensureBridge = useCallback((): Promise<void> => {
    if (!ready.current) {
      let resolve!: () => void;
      const promise = new Promise<void>(done => { resolve = done; });
      ready.current = { promise, resolve };
      // Never let a stalled page load block every request forever.
      setTimeout(() => ready.current?.resolve(), 20_000);
    }
    if (!mountedRef.current) { mountedRef.current = true; setMounted(true); }
    return ready.current.promise;
  }, []);

  const onMessage = useCallback((event: WebViewMessageEvent) => {
    const parsed = parseBridgeMessage(event.nativeEvent.data);
    if (!parsed) return;
    const entry = pending.current.get(parsed.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.current.delete(parsed.id);
    if (parsed.error === 'TIMEOUT') { entry.reject(new CommentReadError('timeout', '评论请求超时，请重试。')); return; }
    if (parsed.error) {
      const detail = parsed.message ? `（${parsed.message}）` : '';
      const message = parsed.error === 'NETWORK_ERROR'
        ? `网络异常，评论读取失败${detail}`
        : parsed.error === 'SCRIPT_ERROR'
          ? `页面脚本执行失败${detail}`
          : `评论读取失败，请重试${detail}`;
      entry.reject(new CommentReadError('network', message));
      return;
    }
    entry.resolve(parsed);
  }, []);

  const sendDirectPage = useCallback((state: CapState, cursor: string, delayMs = 320) => {
    if (state.done || capRef.current !== state) return;
    if (capDirectTimer.current) clearTimeout(capDirectTimer.current);
    const reqId = `d${++capDirectSeq.current}`;
    state.pendingReqId = reqId;
    state.pendingCursor = cursor;
    capDirectTimer.current = setTimeout(() => {
      capDirectTimer.current = null;
      if (state.done || capRef.current !== state) return;
      try {
        capWebRef.current?.injectJavaScript(`window.__mylikeFetchPage&&window.__mylikeFetchPage(${JSON.stringify(reqId)},${JSON.stringify(cursor)});true;`);
      } catch {
        // If inject fails, fall back to scroll capture.
        state.usedScroll = true;
        state.pendingReqId = '';
        if (capIdle.current) clearTimeout(capIdle.current);
        capIdle.current = setTimeout(() => { capFinish.current?.('idle_timeout'); }, state.idleTimeoutMs);
      }
      if (capIdle.current) clearTimeout(capIdle.current);
      capIdle.current = setTimeout(() => { capFinish.current?.('idle_timeout'); }, Math.max(state.idleTimeoutMs, 20_000));
    }, delayMs);
  }, []);

  const onCaptureMessage = useCallback((event: WebViewMessageEvent) => {
    let msg: any;
    try { msg = JSON.parse(event.nativeEvent.data); } catch { return; }
    const state = capRef.current;
    if (!state || state.done) return;
    if (msg?.__mylikeScrollEnd && msg.op === state.kind) {
      if (!state.pendingReqId) capFinish.current?.('scroll_limit');
      return;
    }
    if (!msg || msg.__mylikeCap !== true) return;
    if (msg.op && msg.op !== state.kind) return;

    const status = Number(msg.status) || 0;
    const body = typeof msg.body === 'string' ? msg.body : '';
    const reqId = typeof msg.reqId === 'string' ? msg.reqId : '';
    const reqCursor = typeof msg.cursor === 'string' ? msg.cursor : '';
    const isDirect = Boolean(reqId && reqId === state.pendingReqId);
    if (reqId && !isDirect) return; // Ignore stale direct responses.

    if (isDirect) {
      state.pendingReqId = '';
      if (capDirectTimer.current) { clearTimeout(capDirectTimer.current); capDirectTimer.current = null; }
    }

    // Ignore passive scroll responses once direct cursor paging is driving.
    if (!isDirect && state.usedDirect && state.directSuccessPages > 0) return;

    if (msg.error || !body) {
      state.lastStatus = status;
      state.lastDetail = String(msg.error || `HTTP ${status}`);
      if (isDirect) {
        if (state.directSuccessPages === 0) {
          // Live SDK couldn't sign direct request -> fall back seamlessly to DOM-slimmed scroll.
          state.usedScroll = true;
          try { capWebRef.current?.injectJavaScript('window.__mylikeResumeScroll&&window.__mylikeResumeScroll();true;'); } catch {}
          if (capIdle.current) clearTimeout(capIdle.current);
          capIdle.current = setTimeout(() => { capFinish.current?.('idle_timeout'); }, state.idleTimeoutMs);
          return;
        }
        if (state.directRetries < 2) {
          state.directRetries += 1;
          sendDirectPage(state, reqCursor || state.pendingCursor, state.directRetries === 1 ? 1800 : 4000);
          return;
        }
        capFinish.current?.('error', state.lastDetail);
      }
      return;
    }

    state.lastStatus = status;
    let parsed: ReturnType<typeof parseVideoList> | null = null;
    let parseErr: unknown = null;
    try {
      parsed = parseVideoList(body, reqCursor, status);
      state.lastStatusCode = '0';
    } catch (err) {
      parseErr = err;
      const codeMatch = err instanceof Error ? err.message.match(/status_code=([^，,\s）)]+)/) : null;
      if (codeMatch) state.lastStatusCode = codeMatch[1];
      state.lastDetail = err instanceof Error ? err.message : String(err);
    }

    if (parseErr && isDirect) {
      const isAuth = parseErr instanceof CommentReadError && parseErr.code === 'auth';
      const isRate = status === 429 || (parseErr instanceof CommentReadError && parseErr.message.includes('过于频繁'));
      if (state.directSuccessPages === 0 && !isAuth) {
        // First direct call got rejected (e.g. Sign Invalid) -> seamlessly fall back to scroll!
        state.usedScroll = true;
        try { capWebRef.current?.injectJavaScript('window.__mylikeResumeScroll&&window.__mylikeResumeScroll();true;'); } catch {}
        if (capIdle.current) clearTimeout(capIdle.current);
        capIdle.current = setTimeout(() => { capFinish.current?.('idle_timeout'); }, state.idleTimeoutMs);
        return;
      }
      if (isRate && state.directRetries < 2) {
        state.directRetries += 1;
        sendDirectPage(state, reqCursor || state.pendingCursor, state.directRetries === 1 ? 2200 : 5000);
        return;
      }
      capFinish.current?.(isAuth ? 'auth' : isRate ? 'rate_limit' : 'restricted', state.lastDetail);
      return;
    }

    const key = `${status}|${body.length}|${body.slice(0, 48)}`;
    if (state.seen.has(key)) {
      if (isDirect && parsed?.hasMore && parsed.nextCursor && parsed.nextCursor !== reqCursor) {
        sendDirectPage(state, parsed.nextCursor);
      }
      return;
    }
    state.seen.add(key);

    const engineTag: 'direct' | 'scroll' = isDirect ? 'direct' : 'scroll';
    if (isDirect) { state.usedDirect = true; state.directSuccessPages += 1; state.directRetries = 0; }
    else { state.usedScroll = true; }

    if (parsed) {
      state.lastHasMore = parsed.hasMore;
      // Preserve resumeCursor until the first resumed direct page confirms progress.
      if (parsed.nextCursor && (state.mode !== 'resume' || isDirect)) {
        state.lastCursor = parsed.nextCursor;
      }
    }

    const page: CapturePage = { status, body, cursor: reqCursor, engine: engineTag };
    state.pages.push(page);
    try { state.onPage?.(page); } catch { /* progress callback must never break capture */ }

    if (state.stop?.()) { capFinish.current?.('cancelled'); return; }
    if (state.mode === 'top' && state.pages.length >= 4) { capFinish.current?.('top_done'); return; }
    if (parsed && !parsed.hasMore) { capFinish.current?.('completed'); return; }

    // Switch to direct cursor pagination right after Page 1 captures the live template.
    if (!isDirect && state.mode !== 'top' && !state.directTried) {
      const startCursor = state.mode === 'resume' && state.resumeCursor ? state.resumeCursor : parsed?.nextCursor ?? null;
      if (startCursor) {
        state.directTried = true;
        state.usedDirect = true;
        try { capWebRef.current?.injectJavaScript('window.__mylikePauseScroll&&window.__mylikePauseScroll();true;'); } catch {}
        sendDirectPage(state, startCursor, 280);
        return;
      }
    }

    if (isDirect) {
      if (parsed?.nextCursor) {
        sendDirectPage(state, parsed.nextCursor, 320);
      } else {
        capFinish.current?.('completed');
      }
      return;
    }

    if (capIdle.current) clearTimeout(capIdle.current);
    capIdle.current = setTimeout(() => { capFinish.current?.('idle_timeout'); }, state.idleTimeoutMs);
  }, [sendDirectPage]);

  const captureCollection = useCallback((kind: 'likes' | 'favorites', options?: CaptureOptions & { stop?: () => boolean }): Promise<CaptureBatchResult> => {
    return new Promise<CaptureBatchResult>(resolve => {
      capSeq.current += 1;
      const mode = options?.mode ?? 'down';
      const maxScrolls = Math.max(1, options?.maxScrolls ?? 70);
      const timeoutMs = Math.max(10_000, options?.timeoutMs ?? 120_000);
      const idleTimeoutMs = Math.max(8_000, options?.idleTimeoutMs ?? (mode === 'full' || mode === 'resume' ? 25_000 : 12_000));
      const resumeCursor = options?.resumeCursor ?? null;
      const state: CapState = {
        kind,
        mode,
        resumeCursor,
        pages: [],
        seen: new Set<string>(),
        done: false,
        onPage: options?.onPage,
        maxScrolls,
        idleTimeoutMs,
        stop: options?.stop,
        startedAt: Date.now(),
        usedDirect: false,
        usedScroll: false,
        directTried: false,
        directSuccessPages: 0,
        directRetries: 0,
        pendingReqId: '',
        pendingCursor: '',
        lastHasMore: null,
        lastCursor: resumeCursor,
        lastStatus: null,
        lastStatusCode: '',
        lastDetail: '',
      };
      capRef.current = state;
      if (capTimer.current) clearTimeout(capTimer.current);
      if (capIdle.current) clearTimeout(capIdle.current);
      if (capDirectTimer.current) clearTimeout(capDirectTimer.current);
      const finish = (reason: SyncStopReason = 'idle_timeout', detail?: string) => {
        if (state.done) return;
        state.done = true;
        if (capTimer.current) { clearTimeout(capTimer.current); capTimer.current = null; }
        if (capIdle.current) { clearTimeout(capIdle.current); capIdle.current = null; }
        if (capDirectTimer.current) { clearTimeout(capDirectTimer.current); capDirectTimer.current = null; }
        capFinish.current = null;
        if (capRef.current === state) capRef.current = null;
        setCapture(null);
        const engine: SyncEngine = state.usedDirect && state.usedScroll ? 'mixed' : state.usedDirect ? 'direct' : 'scroll';
        resolve({
          pages: state.pages.slice(),
          diagnostic: {
            reason,
            engine,
            pages: state.pages.length,
            hasMore: state.lastHasMore,
            nextCursor: state.lastHasMore === false ? null : state.lastCursor,
            lastStatus: state.lastStatus,
            lastStatusCode: state.lastStatusCode,
            elapsedMs: Math.max(1, Date.now() - state.startedAt),
            detail: detail ?? state.lastDetail,
          },
        });
      };
      capFinish.current = finish;
      capTimer.current = setTimeout(() => finish('total_timeout'), timeoutMs);
      capIdle.current = setTimeout(() => finish('idle_timeout'), Math.max(idleTimeoutMs, 20_000));
      setCapture({ kind, nonce: capSeq.current, maxScrolls });
    });
  }, []);

  const cancelCapture = useCallback(() => { capFinish.current?.('cancelled'); }, []);

  const request = useCallback(async (operation: BridgeOperation, parameters: Record<string, string>, timeoutMs = 15_000): Promise<BridgeResult> => {
    await ensureBridge();
    const web = webRef.current;
    if (!web) throw new CommentReadError('bridge', '评论服务尚未就绪。');
    const id = `r${++sequence.current}`;
    const script = buildBridgeScript({ id, operation, parameters, timeout: timeoutMs });
    return await new Promise<BridgeResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.current.delete(id);
        reject(new CommentReadError('timeout', '评论读取超时，请重试。'));
      }, timeoutMs + 5_000);
      pending.current.set(id, { resolve, reject, timer });
      try {
        web.injectJavaScript(script);
      } catch {
        clearTimeout(timer);
        pending.current.delete(id);
        reject(new CommentReadError('bridge', '评论读取指令发送失败。'));
      }
    });
  }, [ensureBridge]);

  // One probe of the self endpoint; also records a diagnostic label.
  const probe = useCallback(async (): Promise<{ loggedIn: boolean; label: string }> => {
    try {
      const result = await request('self', {});
      const state = parseSelf(result.body, result.status);
      const label = describeSelf(result.status, result.body);
      setLoggedIn(state.loggedIn);
      if (state.loggedIn) setNickname(state.nickname ?? '');
      setLoginDebug(`登录检测：${label}`);
      return { loggedIn: state.loggedIn, label };
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : '未知错误';
      setLoginDebug(`登录检测失败：${message}`);
      return { loggedIn: false, label: `检测失败：${message}` };
    }
  }, [request]);

  const detect = useCallback(async (silent: boolean): Promise<boolean> => {
    if (!silent) setChecking(true);
    try { return (await probe()).loggedIn; } finally { if (!silent) setChecking(false); }
  }, [probe]);

  const checkLogin = useCallback((silent = false) => detect(silent), [detect]);

  const openLogin = useCallback(() => {
    setLoginError('');
    setLoginVisible(true);
    void ensureBridge().catch(() => {});
  }, [ensureBridge]);

  const closeLogin = useCallback(() => setLoginVisible(false), []);

  const logout = useCallback(async () => {
    setLoggedIn(false); setNickname(''); setLoginError(''); setLoginDebug(''); setLoginVisible(false);
    try { await clearWebViewCookies(); } catch { /* 清 cookie 失败也重置本地状态 */ }
    ready.current = null;
    setResetKey(key => key + 1);
  }, []);

  const completeLogin = useCallback(async (): Promise<boolean> => {
    setLoginError('');
    setChecking(true);
    let result: { loggedIn: boolean; label: string };
    try { result = await probe(); } finally { setChecking(false); }
    if (result.loggedIn) { setLoginVisible(false); return true; }
    setLoginError(`还没有检测到登录状态。${result.label}`);
    return false;
  }, [probe]);

  // While the login page is open, quietly poll the self endpoint. As soon as the
  // QR scan lands and cookies are set, the modal closes on its own.
  useEffect(() => {
    if (!loginVisible) return;
    let alive = true;
    const tick = async () => {
      const ok = await detect(true);
      if (alive && ok) setLoginVisible(false);
    };
    const first = setTimeout(tick, 1500);
    const interval = setInterval(tick, 3000);
    return () => { alive = false; clearTimeout(first); clearInterval(interval); };
  }, [loginVisible, detect]);

  useEffect(() => () => { for (const entry of pending.current.values()) clearTimeout(entry.timer); if (capTimer.current) clearTimeout(capTimer.current); if (capIdle.current) clearTimeout(capIdle.current); if (capDirectTimer.current) clearTimeout(capDirectTimer.current); }, []);

  const value = useMemo<DouyinSessionValue>(() => ({
    mounted, loggedIn, checking, loginVisible, loginError, loginDebug, nickname,
    openLogin, closeLogin, completeLogin, checkLogin, logout, request, captureCollection, cancelCapture,
  }), [mounted, loggedIn, checking, loginVisible, loginError, loginDebug, nickname, openLogin, closeLogin, completeLogin, checkLogin, logout, request, captureCollection, cancelCapture]);

  return <SessionContext.Provider value={value}>
    {children}
    {mounted && <View style={loginVisible ? styles.overlay : styles.hidden} pointerEvents={loginVisible ? 'auto' : 'none'} accessibilityElementsHidden={!loginVisible} importantForAccessibility={loginVisible ? 'auto' : 'no-hide-descendants'}>
      <WebView
        key={resetKey}
        ref={webRef}
        source={{ uri: LOGIN_URL }}
        userAgent={DESKTOP_UA}
        injectedJavaScriptBeforeContentLoaded={FINGERPRINT}
        onMessage={onMessage}
        onLoadEnd={() => ready.current?.resolve()}
        javaScriptEnabled
        domStorageEnabled
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        cacheEnabled
        originWhitelist={['*']}
        mixedContentMode="always"
        setSupportMultipleWindows={false}
        style={styles.webview}
      />
      {loginVisible && <View style={[styles.loginChrome, { paddingTop: insets.top }]} pointerEvents="box-none">
        <StatusBar barStyle="light-content" />
        <View style={styles.loginHeader}>
          <Pressable accessibilityRole="button" accessibilityLabel="取消登录" onPress={closeLogin} hitSlop={10}><Text style={styles.loginCancel}>取消</Text></Pressable>
          <Text style={styles.loginTitle}>登录抖音</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="完成登录" onPress={() => { void completeLogin(); }} disabled={checking} hitSlop={10}><Text style={[styles.loginDone, checking && styles.loginDoneBusy]}>{checking ? '检测中…' : '完成'}</Text></Pressable>
        </View>
        <Text style={styles.loginHint}>用抖音 App 扫码登录（桌面版会显示二维码）。登录成功后本页会自动关闭。{(loginDebug || loginError) ? `\n${loginDebug}${loginError ? `\n${loginError}` : ''}` : ''}</Text>
      </View>}
    </View>}
    {capture && <View key={`cap-${capture.nonce}`} style={styles.captureHidden} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <WebView
        ref={capWebRef}
        source={{ uri: capture.kind === 'likes' ? LIKES_URL : FAVORITES_URL }}
        userAgent={DESKTOP_UA}
        injectedJavaScriptBeforeContentLoaded={FINGERPRINT + '\n' + CAPTURE_HOOK}
        injectedJavaScript={captureScroll(capture.maxScrolls, capture.kind)}
        onMessage={onCaptureMessage}
        javaScriptEnabled
        domStorageEnabled
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        cacheEnabled
        originWhitelist={['*']}
        mixedContentMode="always"
        setSupportMultipleWindows={false}
        style={styles.webview}
      />
    </View>}
  </SessionContext.Provider>;
}

const styles = StyleSheet.create({
  hidden: { position: 'absolute', left: 0, top: 0, width: 2, height: 2, opacity: 0.01, overflow: 'hidden' },
  captureHidden: { position: 'absolute', left: -3000, top: 0, width: 400, height: 800, opacity: 0.01 },
  overlay: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, zIndex: 1000, elevation: 1000, backgroundColor: '#151723' },
  webview: { flex: 1, backgroundColor: '#fff' },
  loginChrome: { position: 'absolute', left: 0, right: 0, top: 0, zIndex: 1001, elevation: 1001, backgroundColor: '#151723' },
  loginHeader: { height: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#2c2f3d' },
  loginTitle: { fontSize: 16, fontWeight: '600', color: '#fff' },
  loginCancel: { fontSize: 15, color: '#bababb' },
  loginDone: { fontSize: 15, fontWeight: '600', color: '#fc2f56' },
  loginDoneBusy: { color: '#666' },
  loginHint: { fontSize: 12, lineHeight: 18, color: '#c7c7cf', paddingHorizontal: 16, paddingVertical: 8, backgroundColor: '#22242f' },
});
