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
  buildBridgeScript, CommentReadError, parseBridgeMessage, parseSelf,
  type BridgeOperation, type BridgeResult,
} from '../douyin-bridge';
import { clearWebViewCookies } from './home-icon';

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
// Desktop login page: forces the QR login overlay. The mobile site only shows a
// "download app" landing page, so login must be done on the desktop layout.
const LOGIN_URL = 'https://www.douyin.com/user/self?showTab=like';
// Force a desktop-like navigator so the PC page's fingerprint stays consistent.
const FINGERPRINT = `(function(){try{Object.defineProperty(navigator,'platform',{get:function(){return 'Win32';}});Object.defineProperty(navigator,'hardwareConcurrency',{get:function(){return 8;}});}catch(e){}})();true;`;

// The logged-in page itself loads the likes / favourites tabs; we hook its own
// fetch/XHR to capture the signed responses it produces. That keeps us on the
// official signature path (no forged a_bogus) — we just read what the page got.
const LIKES_URL = 'https://www.douyin.com/user/self?showTab=like';
const FAVORITES_URL = 'https://www.douyin.com/user/self?showTab=favorite_collection';
const CAPTURE_HOOK = `(function(){try{
function send(o){try{window.ReactNativeWebView.postMessage(JSON.stringify(o));}catch(e){}}
function opOf(u){try{if(!u)return '';if(u.indexOf('/aweme/v1/web/aweme/favorite/')>=0)return 'likes';if(u.indexOf('/aweme/v1/web/aweme/listcollection/')>=0)return 'favorites';}catch(e){}return '';}
var of=window.fetch;
if(of){window.fetch=function(input,init){var url='';try{url=typeof input==='string'?input:(input&&input.url)||'';}catch(e){}var op=opOf(url);var pr=of.apply(this,arguments);if(op){try{pr.then(function(resp){try{resp.clone().text().then(function(t){send({__mylikeCap:true,op:op,status:resp.status,body:t});});}catch(e){}});}catch(e){}}return pr;};}
var oo=XMLHttpRequest.prototype.open,os=XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open=function(m,u){try{this.__mop=opOf(u);}catch(e){}return oo.apply(this,arguments);};
XMLHttpRequest.prototype.send=function(){var x=this;if(x.__mop){try{x.addEventListener('load',function(){try{send({__mylikeCap:true,op:x.__mop,status:x.status,body:x.responseText});}catch(e){}});}catch(e){}}return os.apply(this,arguments);};
}catch(e){}})();true;`;
const CAPTURE_SCROLL = `(function(){var n=0;function push(){try{window.scrollTo(0,1e9);}catch(e){}try{document.documentElement.scrollTop=1e9;document.body.scrollTop=1e9;}catch(e){}try{var els=document.querySelectorAll('div');var best=null,bh=0;for(var i=0;i<els.length;i++){var el=els[i];if(el.scrollHeight>el.clientHeight+100&&el.clientHeight>300&&el.scrollHeight>bh){bh=el.scrollHeight;best=el;}}if(best){best.scrollTop=best.scrollHeight;}}catch(e){}}var iv=setInterval(function(){push();if(++n>70){clearInterval(iv);}},1000);push();})();true;`;

export type CapturePage = { status: number; body: string };

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
  captureCollection: (kind: 'likes' | 'favorites', onPage?: (page: CapturePage) => void) => Promise<CapturePage[]>;
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
  const [capture, setCapture] = useState<{ kind: 'likes' | 'favorites'; nonce: number } | null>(null);
  const capRef = useRef<{ kind: 'likes' | 'favorites'; pages: CapturePage[]; seen: Set<string>; done: boolean; onPage?: (page: CapturePage) => void } | null>(null);
  const capSeq = useRef(0);
  const capTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const capIdle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const capFinish = useRef<(() => void) | null>(null);

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

  const onCaptureMessage = useCallback((event: WebViewMessageEvent) => {
    let msg: any;
    try { msg = JSON.parse(event.nativeEvent.data); } catch { return; }
    if (!msg || msg.__mylikeCap !== true) return;
    const state = capRef.current;
    if (!state || state.done || msg.op !== state.kind) return;
    const body = typeof msg.body === 'string' ? msg.body : '';
    if (!body) return;
    const status = Number(msg.status) || 0;
    const key = `${status}|${body.length}|${body.slice(0, 48)}`;
    if (state.seen.has(key)) return;
    state.seen.add(key);
    const page = { status, body };
    state.pages.push(page);
    try { state.onPage?.(page); } catch { /* progress callback must never break capture */ }
    if (capIdle.current) clearTimeout(capIdle.current);
    capIdle.current = setTimeout(() => { capFinish.current?.(); }, 7_000);
  }, []);

  const captureCollection = useCallback((kind: 'likes' | 'favorites', onPage?: (page: CapturePage) => void): Promise<CapturePage[]> => {
    return new Promise<CapturePage[]>(resolve => {
      capSeq.current += 1;
      const state = { kind, pages: [] as CapturePage[], seen: new Set<string>(), done: false, onPage };
      capRef.current = state;
      if (capTimer.current) clearTimeout(capTimer.current);
      if (capIdle.current) clearTimeout(capIdle.current);
      const finish = () => {
        if (state.done) return;
        state.done = true;
        if (capTimer.current) { clearTimeout(capTimer.current); capTimer.current = null; }
        if (capIdle.current) { clearTimeout(capIdle.current); capIdle.current = null; }
        capFinish.current = null;
        if (capRef.current === state) capRef.current = null;
        setCapture(null);
        resolve(state.pages.slice());
      };
      capFinish.current = finish;
      capTimer.current = setTimeout(finish, 55_000);
      setCapture({ kind, nonce: capSeq.current });
    });
  }, []);

  const cancelCapture = useCallback(() => { capFinish.current?.(); }, []);

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

  useEffect(() => () => { for (const entry of pending.current.values()) clearTimeout(entry.timer); if (capTimer.current) clearTimeout(capTimer.current); if (capIdle.current) clearTimeout(capIdle.current); }, []);

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
        source={{ uri: capture.kind === 'likes' ? LIKES_URL : FAVORITES_URL }}
        userAgent={DESKTOP_UA}
        injectedJavaScriptBeforeContentLoaded={FINGERPRINT + '\n' + CAPTURE_HOOK}
        injectedJavaScript={CAPTURE_SCROLL}
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
