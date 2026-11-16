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
//
// Douyin's reply endpoint is risk-gated: it returns nothing until the account
// clears a human-verification slider. That slider only exists on the real page
// and must be touched, so the verify overlay is presented as its own RN Modal
// (which sits above the comment sheet's Modal) with a second WebView on the video
// page. Both WebViews share the process CookieManager, so the verification
// clearance lands in the same cookie jar the request WebView uses, and the retry
// succeeds in the primary WebView.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Modal, Pressable, StatusBar, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import {
  buildBridgeScript, CommentReadError, parseBridgeMessage, parseSelf,
  type BridgeOperation, type BridgeResult,
} from '../douyin-bridge';

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
// Desktop login page: forces the QR login overlay. The mobile site only shows a
// "download app" landing page, so login must be done on the desktop layout.
const LOGIN_URL = 'https://www.douyin.com/user/self?showTab=like';
// Force a desktop-like navigator so the PC page's fingerprint stays consistent.
const FINGERPRINT = `(function(){try{Object.defineProperty(navigator,'platform',{get:function(){return 'Win32';}});Object.defineProperty(navigator,'hardwareConcurrency',{get:function(){return 8;}});}catch(e){}})();true;`;

// Detect Douyin's visible human-verification widget (slider captcha) in the page.
// MODE is substituted at module load to route the probe result to the right
// consumer: "__verify" for a one-shot request, "__verifyPoll" for the poller.
const CAPTCHA_CHECK = `(function(){try{var b=document.body?document.body.innerText:'';var sel=!!document.querySelector('[class*="captcha-slider"],[class*="captcha_slider"],[role="slider"],iframe[src*="/captcha"],iframe[src*="/verify"]');var w=/拖动滑块|滑动.{0,12}(?:验证|拼图)|完成安全验证|请完成验证|安全验证|旋转.{0,12}(?:图片|验证)/.test(b);window.ReactNativeWebView.postMessage(JSON.stringify({MODE:true,captcha:(sel||w)}));}catch(e){window.ReactNativeWebView.postMessage(JSON.stringify({MODE:true,captcha:false}));}})();true;`;
const CAPTCHA_PROBE = CAPTCHA_CHECK.split('MODE').join('__verify');
const CAPTCHA_POLL = CAPTCHA_CHECK.split('MODE').join('__verifyPoll');

type Pending = { resolve: (value: BridgeResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export type DouyinSessionValue = {
  mounted: boolean;
  loggedIn: boolean;
  checking: boolean;
  loginVisible: boolean;
  loginError: string;
  loginDebug: string;
  nickname: string;
  verifyVisible: boolean;
  verifyCaptcha: boolean;
  verifyError: string;
  openLogin: () => void;
  closeLogin: () => void;
  completeLogin: () => Promise<boolean>;
  checkLogin: (silent?: boolean) => Promise<boolean>;
  openVerify: (url: string, onDone?: (ok: boolean) => void) => void;
  closeVerify: () => void;
  completeVerify: () => Promise<void>;
  request: (operation: BridgeOperation, parameters: Record<string, string>, timeoutMs?: number) => Promise<BridgeResult>;
};

const fallback: DouyinSessionValue = {
  mounted: false, loggedIn: false, checking: false, loginVisible: false, loginError: '', loginDebug: '', nickname: '',
  verifyVisible: false, verifyCaptcha: false, verifyError: '',
  openLogin: () => {}, closeLogin: () => {}, completeLogin: async () => false, checkLogin: async () => false,
  openVerify: () => {}, closeVerify: () => {}, completeVerify: async () => {},
  request: async () => { throw new CommentReadError('bridge', '评论服务尚未就绪。'); },
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
  const verifyWebRef = useRef<any>(null);
  const pending = useRef(new Map<string, Pending>());
  const sequence = useRef(0);
  const ready = useRef<{ promise: Promise<void>; resolve: () => void } | null>(null);
  const mountedRef = useRef(false);
  const verifyCallback = useRef<((ok: boolean) => void) | null>(null);
  const verifyPending = useRef<((captcha: boolean) => void) | null>(null);

  const [mounted, setMounted] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);
  const [nickname, setNickname] = useState('');
  const [checking, setChecking] = useState(false);
  const [loginVisible, setLoginVisible] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [loginDebug, setLoginDebug] = useState('');
  const [verifyVisible, setVerifyVisible] = useState(false);
  const [verifyUrl, setVerifyUrl] = useState('https://www.douyin.com/');
  const [verifyCaptcha, setVerifyCaptcha] = useState(false);
  const [verifyError, setVerifyError] = useState('');

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

  const onVerifyMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const obj = JSON.parse(event.nativeEvent.data);
      if (obj && obj.__verifyPoll) { setVerifyCaptcha(!!obj.captcha); return; }
      if (obj && obj.__verify) { const settle = verifyPending.current; verifyPending.current = null; settle?.(!!obj.captcha); }
    } catch { /* ignore non-probe messages */ }
  }, []);

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

  const completeLogin = useCallback(async (): Promise<boolean> => {
    setLoginError('');
    setChecking(true);
    let result: { loggedIn: boolean; label: string };
    try { result = await probe(); } finally { setChecking(false); }
    if (result.loggedIn) { setLoginVisible(false); return true; }
    setLoginError(`还没有检测到登录状态。${result.label}`);
    return false;
  }, [probe]);

  const openVerify = useCallback((url: string, onDone?: (ok: boolean) => void) => {
    setVerifyError(''); setVerifyCaptcha(false);
    verifyCallback.current = onDone ?? null;
    setVerifyUrl(url);
    setVerifyVisible(true);
  }, []);

  const probeCaptcha = useCallback((): Promise<boolean> => new Promise<boolean>(resolve => {
    verifyPending.current = resolve;
    try { verifyWebRef.current?.injectJavaScript(CAPTCHA_PROBE); } catch { resolve(false); }
    setTimeout(() => { if (verifyPending.current === resolve) { verifyPending.current = null; resolve(false); } }, 2_500);
  }), []);

  const completeVerify = useCallback(async () => {
    const captcha = await probeCaptcha();
    if (captcha) { setVerifyError('页面上仍检测到安全验证，请先完成滑块，再点“我已完成”。'); return; }
    setVerifyVisible(false);
    const callback = verifyCallback.current; verifyCallback.current = null;
    if (callback) setTimeout(() => callback(true), 350);
  }, [probeCaptcha]);

  const closeVerify = useCallback(() => {
    setVerifyVisible(false);
    const callback = verifyCallback.current; verifyCallback.current = null;
    if (callback) callback(false);
  }, []);

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

  // While the verify overlay is open, keep checking whether a slider is present.
  useEffect(() => {
    if (!verifyVisible) return;
    let alive = true;
    const tick = () => { if (alive) { try { verifyWebRef.current?.injectJavaScript(CAPTCHA_POLL); } catch { /* ignore */ } } };
    const first = setTimeout(tick, 1200);
    const interval = setInterval(tick, 2000);
    return () => { alive = false; clearTimeout(first); clearInterval(interval); };
  }, [verifyVisible]);

  useEffect(() => () => { for (const entry of pending.current.values()) clearTimeout(entry.timer); }, []);

  const value = useMemo<DouyinSessionValue>(() => ({
    mounted, loggedIn, checking, loginVisible, loginError, loginDebug, nickname,
    verifyVisible, verifyCaptcha, verifyError,
    openLogin, closeLogin, completeLogin, checkLogin, request,
    openVerify, closeVerify, completeVerify,
  }), [mounted, loggedIn, checking, loginVisible, loginError, loginDebug, nickname, verifyVisible, verifyCaptcha, verifyError, openLogin, closeLogin, completeLogin, checkLogin, request, openVerify, closeVerify, completeVerify]);

  return <SessionContext.Provider value={value}>
    {children}
    {mounted && <View style={loginVisible ? styles.overlay : styles.hidden} pointerEvents={loginVisible ? 'auto' : 'none'} accessibilityElementsHidden={!loginVisible} importantForAccessibility={loginVisible ? 'auto' : 'no-hide-descendants'}>
      <WebView
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
    <Modal visible={verifyVisible} animationType="slide" onRequestClose={closeVerify} statusBarTranslucent>
      <View style={styles.verifyRoot}>
        <StatusBar barStyle="light-content" />
        <View style={[styles.verifyHeader, { paddingTop: insets.top }]}>
          <View style={styles.loginHeader}>
            <Pressable accessibilityRole="button" accessibilityLabel="取消验证" onPress={closeVerify} hitSlop={10}><Text style={styles.loginCancel}>取消</Text></Pressable>
            <Text style={styles.loginTitle}>安全验证</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="我已完成验证" onPress={() => { void completeVerify(); }} hitSlop={10}><Text style={styles.loginDone}>我已完成</Text></Pressable>
          </View>
          <Text style={styles.loginHint}>抖音要求完成一次安全验证后才能查看楼中楼回复。请把下方抖音页面里的滑块/安全验证完成，然后点右上角“我已完成”。{verifyCaptcha ? '\n当前仍检测到安全验证，请先完成滑块。' : ''}{verifyError ? `\n${verifyError}` : ''}</Text>
        </View>
        <WebView
          ref={verifyWebRef}
          source={{ uri: verifyUrl }}
          userAgent={DESKTOP_UA}
          injectedJavaScriptBeforeContentLoaded={FINGERPRINT}
          onMessage={onVerifyMessage}
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
      </View>
    </Modal>
  </SessionContext.Provider>;
}

const styles = StyleSheet.create({
  hidden: { position: 'absolute', left: 0, top: 0, width: 2, height: 2, opacity: 0.01, overflow: 'hidden' },
  overlay: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, zIndex: 1000, elevation: 1000, backgroundColor: '#151723' },
  verifyRoot: { flex: 1, backgroundColor: '#151723' },
  verifyHeader: { backgroundColor: '#151723' },
  webview: { flex: 1, backgroundColor: '#fff' },
  loginChrome: { position: 'absolute', left: 0, right: 0, top: 0, zIndex: 1001, elevation: 1001, backgroundColor: '#151723' },
  loginHeader: { height: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#2c2f3d' },
  loginTitle: { fontSize: 16, fontWeight: '600', color: '#fff' },
  loginCancel: { fontSize: 15, color: '#bababb' },
  loginDone: { fontSize: 15, fontWeight: '600', color: '#fc2f56' },
  loginDoneBusy: { color: '#666' },
  loginHint: { fontSize: 12, lineHeight: 18, color: '#c7c7cf', paddingHorizontal: 16, paddingVertical: 8, backgroundColor: '#22242f' },
});
