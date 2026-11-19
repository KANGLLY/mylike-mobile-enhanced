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
import { appendSyncLog, sanitizeBodyPreview } from './sync-log';

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
function logCap(op,msg){send({__mylikeLog:true,op:op||'',msg:String(msg||'')});}
function opOf(u){try{if(!u)return '';if(u.indexOf('/aweme/v1/web/aweme/favorite/')>=0)return 'likes';if(u.indexOf('/aweme/v1/web/aweme/listcollection/')>=0)return 'favorites';}catch(e){}return '';}
function readHeaders(h){var out={};if(!h)return out;try{if(typeof h.forEach==='function'){h.forEach(function(v,k){out[k]=v;});return out;}}catch(e){}try{if(Array.isArray(h)){for(var i=0;i<h.length;i++){if(h[i]&&h[i].length>=2)out[h[i][0]]=h[i][1];}return out;}}catch(e){}try{var ks=Object.keys(h);for(var j=0;j<ks.length;j++){out[ks[j]]=h[ks[j]];}}catch(e){}return out;}
function readBody(b){if(!b)return '';if(typeof b==='string')return b;try{if(typeof URLSearchParams!=='undefined'&&b instanceof URLSearchParams)return b.toString();}catch(e){}return '';}
function cursorOf(u,b){try{var uu=new URL(u,location.origin);var mc=uu.searchParams.get('max_cursor')||uu.searchParams.get('cursor');if(mc!==null&&mc!=='')return String(mc);}catch(e){}var bs=readBody(b);if(bs){try{if(bs.charAt(0)==='{'){var o=JSON.parse(bs);if(o&&o.cursor!=null)return String(o.cursor);}else{var bp=new URLSearchParams(bs);var bc=bp.get('cursor')||bp.get('max_cursor');if(bc!==null&&bc!=='')return String(bc);}}catch(e){}}return '';}
function saveTpl(op,transport,url,method,headers,body){if(!op)return;if(window.__mylikeTpl&&window.__mylikeTpl.op===op)return;window.__mylikeTpl={op:op,transport:transport,url:String(url||''),method:String(method||'GET'),headers:readHeaders(headers),body:readBody(body)};logCap(op,'tpl_saved tr='+transport+' method='+String(method||'GET')+' cur='+cursorOf(url,body));}
window.__mylikePendingDirect={};window.__mylikeRewrittenCursors={};window.__mylikeReported={};
function markReported(rid){if(!rid)return true;if(window.__mylikeReported[rid])return false;window.__mylikeReported[rid]=true;return true;}
var of=window.fetch;
if(of){window.fetch=function(input,init){var url='';try{url=typeof input==='string'?input:(input&&input.url)||'';}catch(e){}var op=opOf(url);var rid='';var dcur='';var rewritten=false;if(op){dcur=cursorOf(url,init&&init.body);if(dcur&&window.__mylikePendingDirect[dcur]){rid=window.__mylikePendingDirect[dcur];delete window.__mylikePendingDirect[dcur];}if(!rid&&dcur&&window.__mylikeRewrittenCursors[dcur]){rewritten=true;delete window.__mylikeRewrittenCursors[dcur];}if(!rid&&!rewritten){var hdrs=readHeaders(input&&input.headers);var ih=readHeaders(init&&init.headers);var hk=Object.keys(ih);for(var hi=0;hi<hk.length;hi++){hdrs[hk[hi]]=ih[hk[hi]];}saveTpl(op,'fetch',url,(init&&init.method)||(input&&input.method)||'GET',hdrs,init&&init.body);}}var pr=of.apply(this,arguments);if(op){try{pr.then(function(resp){try{resp.clone().text().then(function(t){if(markReported(rid))send({__mylikeCap:true,op:op,status:resp.status,body:t,reqId:rid,cursor:dcur,engine:rid?'direct':'scroll',rewrittenResume:rewritten});}).catch(function(re){if(rid&&markReported(rid))send({__mylikeCap:true,op:op,status:resp.status||0,body:'',reqId:rid,cursor:dcur,engine:'direct',rewrittenResume:rewritten,error:'READ_ERROR:'+String((re&&re.message)||re||'')});});}catch(e){if(rid&&markReported(rid))send({__mylikeCap:true,op:op,status:resp.status||0,body:'',reqId:rid,cursor:dcur,engine:'direct',rewrittenResume:rewritten,error:'READ_ERROR'});}}).catch(function(err){if(rid&&markReported(rid))send({__mylikeCap:true,op:op,status:0,body:'',reqId:rid,cursor:dcur,engine:'direct',rewrittenResume:rewritten,error:String((err&&err.message)||err||'NETWORK_ERROR')});});}catch(e){}}return pr;};}
var oo=XMLHttpRequest.prototype.open,oh=XMLHttpRequest.prototype.setRequestHeader,os=XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open=function(m,u){try{this.__mop=opOf(u);this.__murl=u;this.__mmethod=m||'GET';this.__mheaders={};}catch(e){}return oo.apply(this,arguments);};
XMLHttpRequest.prototype.setRequestHeader=function(k,v){try{if(this.__mop&&this.__mheaders)this.__mheaders[k]=v;}catch(e){}return oh.apply(this,arguments);};
XMLHttpRequest.prototype.send=function(b){var x=this;if(x.__mop){var dcur=cursorOf(x.__murl,b);var rid='';var rewritten=false;if(dcur&&window.__mylikePendingDirect[dcur]){rid=window.__mylikePendingDirect[dcur];delete window.__mylikePendingDirect[dcur];}if(!rid&&dcur&&window.__mylikeRewrittenCursors[dcur]){rewritten=true;delete window.__mylikeRewrittenCursors[dcur];}if(!rid&&!rewritten){saveTpl(x.__mop,'xhr',x.__murl,x.__mmethod,x.__mheaders,b);}x.__mrid=rid;x.__mdcur=dcur;x.__mrewritten=rewritten;try{x.addEventListener('load',function(){try{if(markReported(x.__mrid))send({__mylikeCap:true,op:x.__mop,status:x.status,body:x.responseText,reqId:x.__mrid||'',cursor:x.__mdcur||'',engine:x.__mrid?'direct':'scroll',rewrittenResume:Boolean(x.__mrewritten)});}catch(e){}});x.addEventListener('error',function(){if(x.__mrid&&markReported(x.__mrid))send({__mylikeCap:true,op:x.__mop,status:0,body:'',reqId:x.__mrid,cursor:x.__mdcur||'',engine:'direct',error:'NETWORK_ERROR'});});x.addEventListener('timeout',function(){if(x.__mrid&&markReported(x.__mrid))send({__mylikeCap:true,op:x.__mop,status:0,body:'',reqId:x.__mrid,cursor:x.__mdcur||'',engine:'direct',error:'TIMEOUT'});});}catch(e){}}return os.apply(this,arguments);};
window.__mylikePauseScroll=function(){if(window.__mylikeScrollCtrl)window.__mylikeScrollCtrl.paused=true;};
window.__mylikeResumeScroll=function(){if(window.__mylikeScrollCtrl)window.__mylikeScrollCtrl.paused=false;};
window.__mylikeFetchPage=function(reqId,cursor,altTransport){try{var tpl=window.__mylikeTpl;if(!tpl){logCap('','direct_no_tpl reqId='+reqId);send({__mylikeCap:true,op:'',status:0,body:'',reqId:String(reqId),cursor:String(cursor),engine:'direct',error:'NO_TEMPLATE'});return;}var tr=altTransport?(tpl.transport==='fetch'?'xhr':'fetch'):(tpl.transport||'xhr');var curStr=String(cursor);var reqStr=String(reqId);logCap(tpl.op,'direct_send reqId='+reqStr+' cur='+curStr+' tr='+tr+(altTransport?'(alt)':''));var u=new URL(tpl.url,location.origin);u.searchParams.delete('a_bogus');u.searchParams.delete('X-Bogus');u.searchParams.delete('x-bogus');if(tpl.op==='likes'){u.searchParams.set('max_cursor',curStr);}else{if(u.searchParams.has('cursor')||(tpl.method||'GET').toUpperCase()==='GET'){u.searchParams.set('cursor',curStr);}}var body=tpl.body||'';if(body){try{if(body.charAt(0)==='{'){var obj=JSON.parse(body);if('cursor' in obj)obj.cursor=Number(cursor)||cursor;body=JSON.stringify(obj);}else{var bp=new URLSearchParams(body);bp.set('cursor',curStr);body=bp.toString();}}catch(e){}}var hdrs={};var ks=Object.keys(tpl.headers||{});for(var i=0;i<ks.length;i++){var k=ks[i];var lk=String(k).toLowerCase();if(lk.indexOf('bd-ticket-guard')===0||lk==='x-bogus'||lk==='content-length'||lk==='host'||lk==='cookie'||lk==='user-agent'||lk==='referer'||lk==='origin')continue;hdrs[k]=tpl.headers[k];}window.__mylikePendingDirect[curStr]=reqStr;if(tr==='xhr'){var xhr=new XMLHttpRequest();xhr.withCredentials=true;xhr.timeout=9000;xhr.onreadystatechange=function(){if(xhr.readyState!==4)return;if(window.__mylikePendingDirect[curStr]===reqStr)delete window.__mylikePendingDirect[curStr];var txt='';try{txt=typeof xhr.responseText==='string'?xhr.responseText:'';}catch(e){}if(xhr.status===0&&!txt)return;if(markReported(reqStr)){logCap(tpl.op,'outer_xhr_end reqId='+reqStr+' status='+xhr.status+' len='+txt.length);send({__mylikeCap:true,op:tpl.op,status:xhr.status,body:txt,reqId:reqStr,cursor:curStr,engine:'direct',error:xhr.status===0?'OUTER_XHR_STATUS_0':''});}};xhr.onerror=function(){if(window.__mylikePendingDirect[curStr]===reqStr)delete window.__mylikePendingDirect[curStr];if(markReported(reqStr)){logCap(tpl.op,'outer_xhr_err reqId='+reqStr);send({__mylikeCap:true,op:tpl.op,status:0,body:'',reqId:reqStr,cursor:curStr,engine:'direct',error:'OUTER_XHR_ERROR'});}};xhr.onabort=function(){if(window.__mylikePendingDirect[curStr]===reqStr)delete window.__mylikePendingDirect[curStr];if(markReported(reqStr)){logCap(tpl.op,'outer_xhr_abort reqId='+reqStr);send({__mylikeCap:true,op:tpl.op,status:0,body:'',reqId:reqStr,cursor:curStr,engine:'direct',error:'OUTER_XHR_ABORT'});}};xhr.ontimeout=function(){if(window.__mylikePendingDirect[curStr]===reqStr)delete window.__mylikePendingDirect[curStr];if(markReported(reqStr)){logCap(tpl.op,'outer_xhr_timeout reqId='+reqStr);send({__mylikeCap:true,op:tpl.op,status:0,body:'',reqId:reqStr,cursor:curStr,engine:'direct',error:'OUTER_XHR_TIMEOUT'});}};xhr.open(tpl.method||'GET',u.toString(),true);var hks=Object.keys(hdrs);for(var j=0;j<hks.length;j++){try{xhr.setRequestHeader(hks[j],hdrs[hks[j]]);}catch(e){}}xhr.send(body||null);}else{var opts={method:tpl.method||'GET',credentials:'include',headers:hdrs};if(body&&String(tpl.method||'GET').toUpperCase()!=='GET')opts.body=body;window.fetch(u.toString(),opts).then(function(resp){if(window.__mylikePendingDirect[curStr]===reqStr)delete window.__mylikePendingDirect[curStr];try{resp.clone().text().then(function(t){if(markReported(reqStr)){logCap(tpl.op,'outer_fetch_end reqId='+reqStr+' status='+resp.status+' len='+t.length);send({__mylikeCap:true,op:tpl.op,status:resp.status,body:t,reqId:reqStr,cursor:curStr,engine:'direct'});}}).catch(function(re){if(markReported(reqStr)){logCap(tpl.op,'outer_fetch_read_err reqId='+reqStr);send({__mylikeCap:true,op:tpl.op,status:resp.status||0,body:'',reqId:reqStr,cursor:curStr,engine:'direct',error:'OUTER_READ_ERROR:'+String((re&&re.message)||re||'')});}});}catch(e){if(markReported(reqStr)){send({__mylikeCap:true,op:tpl.op,status:resp.status||0,body:'',reqId:reqStr,cursor:curStr,engine:'direct',error:'OUTER_CLONE_ERROR'});}}}).catch(function(err){if(window.__mylikePendingDirect[curStr]===reqStr)delete window.__mylikePendingDirect[curStr];if(markReported(reqStr)){var em=String((err&&err.message)||err||'OUTER_FETCH_REJECT');logCap(tpl.op,'outer_fetch_err reqId='+reqStr+' err='+em);send({__mylikeCap:true,op:tpl.op,status:0,body:'',reqId:reqStr,cursor:curStr,engine:'direct',error:em});}});}}catch(e){delete window.__mylikePendingDirect[String(cursor)];if(markReported(String(reqId)))send({__mylikeCap:true,op:(window.__mylikeTpl&&window.__mylikeTpl.op)||'',status:0,body:'',reqId:String(reqId),cursor:String(cursor),engine:'direct',error:String((e&&e.message)||e||'DIRECT_ERROR')});}};
}catch(e){}})();true;`;
const captureScroll = (max: number, opKind: 'likes' | 'favorites', initialPaused: boolean) => `(function(){
function opOf(u){try{if(!u)return '';if(u.indexOf('/aweme/v1/web/aweme/favorite/')>=0)return 'likes';if(u.indexOf('/aweme/v1/web/aweme/listcollection/')>=0)return 'favorites';}catch(e){}return '';}
function logCap(msg){try{window.ReactNativeWebView.postMessage(JSON.stringify({__mylikeLog:true,op:'${opKind}',msg:String(msg||'')}));}catch(e){}}
function rewriteUrl(u,target){try{var nu=new URL(u,location.origin);if(opOf(u)==='likes'){nu.searchParams.set('max_cursor',target);}else if(nu.searchParams.has('cursor')){nu.searchParams.set('cursor',target);}return nu.toString();}catch(e){return u;}}
function rewriteBody(b,target){if(!b||typeof b!=='string')return b;try{if(b.charAt(0)==='{'){var o=JSON.parse(b);if('cursor' in o){o.cursor=Number(target)||target;return JSON.stringify(o);}}else{var bp=new URLSearchParams(b);if(bp.has('cursor')){bp.set('cursor',target);return bp.toString();}}}catch(e){}return b;}
window.__mylikeInstallOuter=function(){
  if(window.__mylikeOuterInstalled)return;
  window.__mylikeOuterInstalled=true;
  var cf=window.fetch;
  if(cf){window.fetch=function(input,init){try{var u=typeof input==='string'?input:(input&&input.url)||'';var op=opOf(u);if(op==='${opKind}'&&window.__mylikeRewriteTarget&&!(window.__mylikePendingDirect&&window.__mylikePendingDirect[window.__mylikeRewriteTarget])){var t=window.__mylikeRewriteTarget;window.__mylikeRewriteTarget='';window.__mylikeRewrittenCursors=window.__mylikeRewrittenCursors||{};window.__mylikeRewrittenCursors[t]=true;var ru=rewriteUrl(u,t);logCap('outer_rewrite tr=fetch target='+t);if(typeof input==='string'){if(init&&init.body)init=Object.assign({},init,{body:rewriteBody(init.body,t)});return cf.call(this,ru,init);}return cf.call(this,new Request(ru,input),init);}}catch(e){}return cf.apply(this,arguments);};}
  var co=XMLHttpRequest.prototype.open,cs=XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open=function(m,u){try{if(opOf(u)==='${opKind}'&&window.__mylikeRewriteTarget&&!(window.__mylikePendingDirect&&window.__mylikePendingDirect[window.__mylikeRewriteTarget])){var t=window.__mylikeRewriteTarget;this.__mrw=t;u=rewriteUrl(u,t);}}catch(e){}return co.apply(this,arguments);};
  XMLHttpRequest.prototype.send=function(b){try{if(this.__mrw){var t=this.__mrw;this.__mrw='';window.__mylikeRewriteTarget='';window.__mylikeRewrittenCursors=window.__mylikeRewrittenCursors||{};window.__mylikeRewrittenCursors[t]=true;if(b)b=rewriteBody(b,t);logCap('outer_rewrite tr=xhr target='+t);}}catch(e){}return cs.apply(this,arguments);};
};
window.__mylikeInstallOuter();
window.__mylikeArmResumeRewrite=function(target){
  window.__mylikeInstallOuter();
  window.__mylikeRewriteTarget=String(target||'');
  logCap('arm_rewrite target='+window.__mylikeRewriteTarget);
};
window.__mylikeProbe=function(){try{
  var txt='';try{var rawTxt=(document.body&&document.body.innerText)||'';txt=rawTxt.length>2000?(rawTxt.slice(0,500)+' '+rawTxt.slice(-1500)):rawTxt;}catch(e){}
  var hay=String(location.href||'')+' '+String(document.title||'')+' '+txt;
  var visVerify=false;
  try{
    var nodes=document.querySelectorAll('iframe[src*="verify"],iframe[src*="captcha"],iframe[src*="turing"],iframe[src*="secsdk"],iframe[src*="rmc.bytedance"],[class*="captcha_verify"],[id*="captcha_verify"],[class*="bdturing"],[id*="bdturing"],[class*="secsdk-captcha"],[role="dialog"]');
    for(var vi=0;vi<nodes.length;vi++){
      var el=nodes[vi];
      var st=window.getComputedStyle?window.getComputedStyle(el):null;
      if(st&&(st.display==='none'||st.visibility==='hidden'||st.opacity==='0'))continue;
      var rect=el.getBoundingClientRect?el.getBoundingClientRect():{width:el.offsetWidth||0,height:el.offsetHeight||0};
      if(rect.width>60&&rect.height>60){
        if(el.tagName==='IFRAME'||/captcha|verify|turing|secsdk/i.test((el.className||'')+' '+(el.id||''))||/验证|滑块|拼图|verify|captcha/i.test(el.innerText||'')){visVerify=true;break;}
      }
    }
  }catch(e){}
  var hasVerify=visVerify||/拖动滑块|拼图验证|完成下列验证|请完成验证|向右滑动|安全验证|verifycenter|bdturing/i.test(hay);
  var needLogin=/扫码登录|请先登录|login/i.test(String(document.title||''))&&!window.__mylikeTpl;
  window.ReactNativeWebView.postMessage(JSON.stringify({__mylikeDiag:true,op:'${opKind}',href:String(location.href||''),title:String(document.title||''),readyState:String(document.readyState||''),hasTpl:Boolean(window.__mylikeTpl),verify:hasVerify,needLogin:needLogin}));
}catch(e){}};
var ctrl=window.__mylikeScrollCtrl={paused:${initialPaused ? 'true' : 'false'},n:0,tick:0,box:null};
function findBox(){if(ctrl.box&&ctrl.box.isConnected&&ctrl.box.scrollHeight>ctrl.box.clientHeight+100)return ctrl.box;var els=document.querySelectorAll('div');var best=null,bh=0;for(var i=0;i<els.length;i++){var el=els[i];if(el.scrollHeight>el.clientHeight+100&&el.clientHeight>300&&el.scrollHeight>bh){bh=el.scrollHeight;best=el;}}ctrl.box=best;return best;}
function pruneDom(){try{var imgs=document.querySelectorAll('img');for(var i=0;i<imgs.length;i++){var img=imgs[i];if(img.dataset&&img.dataset.mylikePruned)continue;var r=img.getBoundingClientRect();if(r.bottom<-800){if(img.dataset)img.dataset.mylikePruned='1';img.removeAttribute('src');img.removeAttribute('srcset');}}var vids=document.querySelectorAll('video');for(var j=0;j<vids.length;j++){var v=vids[j];if(v.dataset&&v.dataset.mylikePruned)continue;var vr=v.getBoundingClientRect();if(vr.bottom<-800){if(v.dataset)v.dataset.mylikePruned='1';try{v.pause();}catch(e){}v.removeAttribute('src');try{v.load();}catch(e){}}}}catch(e){}}
function push(){if(ctrl.paused)return;try{window.scrollTo(0,1e9);}catch(e){}try{document.documentElement.scrollTop=1e9;document.body.scrollTop=1e9;}catch(e){}try{var box=findBox();if(box){box.scrollTop=box.scrollHeight;}}catch(e){}if(++ctrl.tick%3===0)pruneDom();}
var diagIv=setInterval(function(){window.__mylikeProbe();},1500);
setTimeout(function(){window.__mylikeProbe();},700);
var iv=setInterval(function(){if(ctrl.paused)return;push();if(++ctrl.n>${max}){clearInterval(iv);clearInterval(diagIv);try{window.ReactNativeWebView.postMessage(JSON.stringify({__mylikeScrollEnd:true,op:'${opKind}'}));}catch(e){}}},1000);
push();
})();true;`;

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
  openCaptureVerify: () => void;
};

const fallback: DouyinSessionValue = {
  mounted: false, loggedIn: false, checking: false, loginVisible: false, loginError: '', loginDebug: '', nickname: '',
  openLogin: () => {}, closeLogin: () => {}, completeLogin: async () => false, checkLogin: async () => false, logout: async () => {},
  request: async () => { throw new CommentReadError('bridge', '评论服务尚未就绪。'); },
  captureCollection: async () => [],
  cancelCapture: () => {},
  openCaptureVerify: () => {},
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
  const [capture, setCapture] = useState<{ kind: 'likes' | 'favorites'; nonce: number; maxScrolls: number; initialPaused: boolean } | null>(null);
  const [verifyVisible, setVerifyVisible] = useState(false);
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
    loadEnded: boolean;
    sawCaptcha: boolean;
    verifyOpen: boolean;
    usedDirect: boolean;
    usedScroll: boolean;
    directTried: boolean;
    triedAltTransport: boolean;
    directSuccessPages: number;
    directRetries: number;
    directFailNote: string;
    armedRewrite: boolean;
    resumeJumpVerified: boolean;
    unrewrittenScrollCount: number;
    pendingReqId: string;
    pendingCursor: string;
    pendingAltTransport: boolean;
    lastHasMore: boolean | null;
    lastCursor: string | null;
    lastStatus: number | null;
    lastStatusCode: string;
    lastDetail: string;
    lastDiagNote: string;
  };
  const capRef = useRef<CapState | null>(null);
  const capSeq = useRef(0);
  const capDirectSeq = useRef(0);
  const capTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const capIdle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const capDirectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const capAttemptTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const capFinish = useRef<((reason?: SyncStopReason, detail?: string) => void) | null>(null);
  const capFallback = useRef<((state: CapState, note: string) => void) | null>(null);

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

  const sendDirectPage = useCallback((state: CapState, cursor: string, delayMs = 320, altTransport = false) => {
    if (state.done || capRef.current !== state) return;
    if (capDirectTimer.current) clearTimeout(capDirectTimer.current);
    if (capAttemptTimer.current) { clearTimeout(capAttemptTimer.current); capAttemptTimer.current = null; }
    const reqId = `d${++capDirectSeq.current}`;
    state.pendingReqId = reqId;
    state.pendingCursor = cursor;
    state.pendingAltTransport = altTransport;
    capDirectTimer.current = setTimeout(() => {
      capDirectTimer.current = null;
      if (state.done || capRef.current !== state) return;
      appendSyncLog(`direct_inject[${state.kind}]: reqId=${reqId} cur=${cursor} alt=${altTransport ? '1' : '0'}`);
      try {
        capWebRef.current?.injectJavaScript(`window.__mylikeFetchPage&&window.__mylikeFetchPage(${JSON.stringify(reqId)},${JSON.stringify(cursor)},${altTransport ? 'true' : 'false'});true;`);
        const waitMs = state.directSuccessPages === 0 ? 6_500 : 12_000;
        capAttemptTimer.current = setTimeout(() => {
          capAttemptTimer.current = null;
          if (state.done || capRef.current !== state || state.pendingReqId !== reqId) return;
          state.pendingReqId = '';
          appendSyncLog(`direct_watchdog_timeout[${state.kind}]: reqId=${reqId} waitMs=${waitMs}`);
          if (state.directSuccessPages === 0) {
            capFallback.current?.(state, `直连(${altTransport ? '备线' : '主线'})超时(${Math.round(waitMs / 1000)}s无回包)`);
          } else if (state.directRetries < 2) {
            state.directRetries += 1;
            sendDirectPage(state, cursor, state.directRetries === 1 ? 1800 : 4000, altTransport);
          } else {
            capFinish.current?.('idle_timeout', '直连续传等待下一页超时');
          }
        }, waitMs);
      } catch {
        // If inject fails, fall back (or rewrite in resume mode).
        appendSyncLog(`direct_inject_error[${state.kind}]: reqId=${reqId}`);
        state.usedScroll = true;
        state.pendingReqId = '';
        if (state.mode === 'resume' && state.resumeCursor) {
          state.armedRewrite = true;
          state.unrewrittenScrollCount = 0;
          try { capWebRef.current?.injectJavaScript(`window.__mylikeArmResumeRewrite&&window.__mylikeArmResumeRewrite(${JSON.stringify(state.resumeCursor)});window.__mylikeResumeScroll&&window.__mylikeResumeScroll();true;`); } catch {}
        }
        if (capIdle.current) clearTimeout(capIdle.current);
        capIdle.current = setTimeout(() => { capFinish.current?.('idle_timeout'); }, state.idleTimeoutMs);
      }
      if (capIdle.current) clearTimeout(capIdle.current);
      capIdle.current = setTimeout(() => { capFinish.current?.('idle_timeout'); }, Math.max(state.idleTimeoutMs, 20_000));
    }, delayMs);
  }, []);

  const fallBackFromFirstDirect = useCallback((state: CapState, note: string) => {
    appendSyncLog(`fallback[${state.kind}]: ${note} altTried=${state.triedAltTransport ? '1' : '0'}`);
    state.directFailNote = note;
    if (!state.triedAltTransport) {
      state.triedAltTransport = true;
      const targetCursor = state.mode === 'resume' && state.resumeCursor ? state.resumeCursor : (state.pendingCursor || state.lastCursor || '');
      if (targetCursor) {
        sendDirectPage(state, targetCursor, 260, true);
        return;
      }
    }
    state.usedScroll = true;
    if (state.mode === 'resume' && state.resumeCursor) {
      state.armedRewrite = true;
      state.unrewrittenScrollCount = 0;
    }
    try {
      if (state.mode === 'resume' && state.resumeCursor) {
        capWebRef.current?.injectJavaScript(`window.__mylikeArmResumeRewrite&&window.__mylikeArmResumeRewrite(${JSON.stringify(state.resumeCursor)});window.__mylikeResumeScroll&&window.__mylikeResumeScroll();true;`);
      } else {
        capWebRef.current?.injectJavaScript('window.__mylikeResumeScroll&&window.__mylikeResumeScroll();true;');
      }
    } catch {}
    if (capIdle.current) clearTimeout(capIdle.current);
    capIdle.current = setTimeout(() => { capFinish.current?.('idle_timeout'); }, state.idleTimeoutMs);
  }, [sendDirectPage]);
  capFallback.current = fallBackFromFirstDirect;

  const enterVerifyMode = useCallback((state: CapState, detail: string) => {
    state.sawCaptcha = true;
    state.verifyOpen = true;
    state.lastDetail = detail;
    setVerifyVisible(true);
    if (capIdle.current) clearTimeout(capIdle.current);
    capIdle.current = setTimeout(() => { capFinish.current?.('captcha', state.lastDetail); }, 180_000);
  }, []);

  const resumeAfterVerify = useCallback(() => {
    const state = capRef.current;
    if (!state || state.done) { setVerifyVisible(false); return; }
    state.verifyOpen = false;
    setVerifyVisible(false);
    if (capIdle.current) clearTimeout(capIdle.current);
    capIdle.current = setTimeout(() => { capFinish.current?.('idle_timeout'); }, Math.max(state.idleTimeoutMs, 30_000));
    if (state.usedDirect && (state.pendingCursor || state.lastCursor)) {
      sendDirectPage(state, state.pendingCursor || state.lastCursor!, 350, state.pendingAltTransport);
    } else {
      try { capWebRef.current?.injectJavaScript('window.__mylikeResumeScroll&&window.__mylikeResumeScroll();true;'); } catch {}
    }
  }, [sendDirectPage]);

  const openCaptureVerify = useCallback(() => {
    const state = capRef.current;
    if (!state || state.done) return;
    enterVerifyMode(state, state.lastDetail || '手动打开安全验证页面');
  }, [enterVerifyMode]);

  const onCaptureMessage = useCallback((event: WebViewMessageEvent) => {
    let msg: any;
    try { msg = JSON.parse(event.nativeEvent.data); } catch { return; }
    const state = capRef.current;
    if (!state || state.done) return;
    if (msg?.__mylikeLog) {
      if (!msg.op || msg.op === state.kind) {
        appendSyncLog(`wv[${state.kind}]: ${String(msg.msg || '')}`);
      }
      return;
    }
    if (msg?.__mylikeDiag && msg.op === state.kind) {
      const title = String(msg.title || '').trim();
      const href = String(msg.href || '').trim();
      const readyState = String(msg.readyState || '');
      const diagSummary = `页面(${readyState}) ${title || href || '未知'} tpl=${msg.hasTpl ? '1' : '0'}`;
      if (!state.directTried) {
        state.lastDiagNote = diagSummary;
      }
      if (msg.verify) {
        appendSyncLog(`diag_verify[${state.kind}]: ${diagSummary}`);
        if (!state.verifyOpen) enterVerifyMode(state, `触发安全验证(${title || href})`);
      } else if (msg.needLogin) {
        appendSyncLog(`diag_need_login[${state.kind}]: ${diagSummary}`);
        state.lastDetail = `页面显示未登录(${title})`;
      } else if (!state.directTried && !msg.hasTpl) {
        appendSyncLog(`diag[${state.kind}]: ${diagSummary}`);
      }
      return;
    }
    if (msg?.__mylikeScrollEnd && msg.op === state.kind) {
      appendSyncLog(`scroll_end[${state.kind}]: pending=${state.pendingReqId || '-'} verify=${state.verifyOpen ? '1' : '0'}`);
      if (!state.pendingReqId && !state.verifyOpen) capFinish.current?.('scroll_limit');
      return;
    }
    if (!msg || msg.__mylikeCap !== true) return;
    if (msg.op && msg.op !== state.kind) return;

    const status = Number(msg.status) || 0;
    const body = typeof msg.body === 'string' ? msg.body : '';
    const reqId = typeof msg.reqId === 'string' ? msg.reqId : '';
    const reqCursor = typeof msg.cursor === 'string' ? msg.cursor : '';
    const rewrittenResume = Boolean(msg.rewrittenResume);
    const isDirect = Boolean(reqId && reqId === state.pendingReqId);
    if (reqId && !isDirect) return; // Ignore stale direct responses.

    if (isDirect) {
      state.pendingReqId = '';
      if (capDirectTimer.current) { clearTimeout(capDirectTimer.current); capDirectTimer.current = null; }
      if (capAttemptTimer.current) { clearTimeout(capAttemptTimer.current); capAttemptTimer.current = null; }
    }

    // Ignore passive scroll responses once direct cursor paging is driving.
    if (!isDirect && state.usedDirect && state.directSuccessPages > 0) return;

    if (msg.error || !body) {
      state.lastStatus = status;
      state.lastDetail = String(msg.error || `HTTP ${status}`);
      appendSyncLog(`cap_err[${state.kind}]: direct=${isDirect ? reqId : '0'} rw=${rewrittenResume ? '1' : '0'} cur=${reqCursor} status=${status} err=${state.lastDetail}`);
      if (isDirect) {
        if (state.directSuccessPages === 0) {
          fallBackFromFirstDirect(state, `直连(${state.pendingAltTransport ? '备线' : '主线'})错误:${state.lastDetail}`);
          return;
        }
        if (state.directRetries < 2) {
          state.directRetries += 1;
          sendDirectPage(state, reqCursor || state.pendingCursor, state.directRetries === 1 ? 1800 : 4000, state.pendingAltTransport);
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
      appendSyncLog(`cap_ok[${state.kind}]: direct=${isDirect ? reqId : '0'} rw=${rewrittenResume ? '1' : '0'} reqCur=${reqCursor} status=${status} items=${parsed.items.length} hasMore=${parsed.hasMore ? '1' : '0'} next=${parsed.nextCursor ?? '-'}`);
    } catch (err) {
      parseErr = err;
      const codeMatch = err instanceof Error ? err.message.match(/status_code=([^，,\s）)]+)/) : null;
      if (codeMatch) state.lastStatusCode = codeMatch[1];
      state.lastDetail = err instanceof Error ? err.message : String(err);
      appendSyncLog(`cap_parse_err[${state.kind}]: direct=${isDirect ? reqId : '0'} rw=${rewrittenResume ? '1' : '0'} cur=${reqCursor} status=${status} err=${state.lastDetail} body=${sanitizeBodyPreview(body)}`);
    }

    // If API response carries verify/captcha challenge, bring the WebView to foreground instead of killing the task!
    const looksLikeCaptcha = Boolean(parseErr) && /verify_data|bdturing|verifycenter|captcha|验证码|安全验证|status_code=(?:10000|2154)/i.test(`${state.lastDetail} ${body.slice(0, 600)}`);
    if (looksLikeCaptcha) {
      enterVerifyMode(state, `接口返回安全验证(${state.lastStatusCode ? `code=${state.lastStatusCode}` : `HTTP ${status}`})`);
      try { capWebRef.current?.injectJavaScript('window.__mylikeResumeScroll&&window.__mylikeResumeScroll();true;'); } catch {}
      return;
    }

    if (parseErr && isDirect) {
      const isAuth = parseErr instanceof CommentReadError && parseErr.code === 'auth';
      const isRate = status === 429 || (parseErr instanceof CommentReadError && parseErr.message.includes('过于频繁'));
      if (state.directSuccessPages === 0 && !isAuth) {
        fallBackFromFirstDirect(state, `直连(${state.pendingAltTransport ? '备线' : '主线'})被拒:${state.lastDetail}`);
        return;
      }
      if (isRate && state.directRetries < 2) {
        state.directRetries += 1;
        sendDirectPage(state, reqCursor || state.pendingCursor, state.directRetries === 1 ? 2200 : 5000, state.pendingAltTransport);
        return;
      }
      capFinish.current?.(isAuth ? 'auth' : isRate ? 'rate_limit' : 'restricted', state.lastDetail);
      return;
    }

    // Valid API data came through: auto-dismiss captcha overlay if it was open.
    if (state.verifyOpen) {
      state.verifyOpen = false;
      setVerifyVisible(false);
    }

    // In 'resume' mode, Page 1 (cursor=0 from initial page load) is ONLY used to capture
    // the signed request template; never count it as resumed progress or trigger scroll from Page 1.
    if (state.mode === 'resume' && !isDirect && !rewrittenResume) {
      if (!state.directTried) {
        const targetResume = state.resumeCursor;
        if (targetResume) {
          state.directTried = true;
          state.usedDirect = true;
          state.lastDiagNote = '已获取请求模板，正在直连断点';
          appendSyncLog(`resume_page1[${state.kind}]: target=${targetResume} -> pause scroll & direct`);
          try { capWebRef.current?.injectJavaScript('window.__mylikePauseScroll&&window.__mylikePauseScroll();true;'); } catch {}
          sendDirectPage(state, targetResume, 280, false);
          return;
        }
      }
      // While waiting for direct attempts (before rewrite fallback is armed), ignore duplicate
      // initial page-load chatter instead of falsely aborting the in-flight direct request.
      if (!state.armedRewrite) return;
      if (!state.resumeJumpVerified) {
        state.unrewrittenScrollCount += 1;
        appendSyncLog(`rewrite_miss[${state.kind}]: count=${state.unrewrittenScrollCount} reqCur=${reqCursor}`);
        if (state.unrewrittenScrollCount >= 3) {
          const note = state.directFailNote ? `${state.directFailNote}；滚动改写未命中断点` : '滚动改写未命中断点';
          capFinish.current?.('restricted', `断点跳转失败(${note})`);
          return;
        }
        return;
      }
    }

    if (state.mode === 'resume' && !isDirect && rewrittenResume) {
      appendSyncLog(`rewrite_hit[${state.kind}]: reqCur=${reqCursor}`);
      state.resumeJumpVerified = true;
    }

    const key = `${status}|${body.length}|${body.slice(0, 48)}`;
    if (state.seen.has(key)) {
      if (isDirect && parsed?.hasMore && parsed.nextCursor && parsed.nextCursor !== reqCursor) {
        sendDirectPage(state, parsed.nextCursor, 320, state.pendingAltTransport);
      }
      return;
    }
    state.seen.add(key);

    const engineTag: 'direct' | 'scroll' = isDirect ? 'direct' : 'scroll';
    if (isDirect) { state.usedDirect = true; state.directSuccessPages += 1; state.directRetries = 0; }
    else { state.usedScroll = true; }

    if (parsed) {
      state.lastHasMore = parsed.hasMore;
      // Preserve resumeCursor until resumed jump (direct or rewritten scroll) confirms progress.
      if (parsed.nextCursor && (state.mode !== 'resume' || isDirect || state.resumeJumpVerified)) {
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
        sendDirectPage(state, startCursor, 280, false);
        return;
      }
    }

    if (isDirect) {
      if (parsed?.nextCursor) {
        sendDirectPage(state, parsed.nextCursor, 320, state.pendingAltTransport);
      } else {
        capFinish.current?.('completed');
      }
      return;
    }

    if (capIdle.current) clearTimeout(capIdle.current);
    capIdle.current = setTimeout(() => { capFinish.current?.('idle_timeout'); }, state.idleTimeoutMs);
  }, [fallBackFromFirstDirect, sendDirectPage]);

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
        loadEnded: false,
        sawCaptcha: false,
        verifyOpen: false,
        usedDirect: false,
        usedScroll: false,
        directTried: false,
        triedAltTransport: false,
        directSuccessPages: 0,
        directRetries: 0,
        directFailNote: '',
        armedRewrite: false,
        resumeJumpVerified: false,
        unrewrittenScrollCount: 0,
        pendingReqId: '',
        pendingCursor: '',
        pendingAltTransport: false,
        lastHasMore: null,
        lastCursor: resumeCursor,
        lastStatus: null,
        lastStatusCode: '',
        lastDetail: '',
        lastDiagNote: '',
      };
      capRef.current = state;
      appendSyncLog(`capture_start[${kind}]: mode=${mode} resumeCursor=${resumeCursor ?? 'null'} idleMs=${idleTimeoutMs}`);
      if (capTimer.current) clearTimeout(capTimer.current);
      if (capIdle.current) clearTimeout(capIdle.current);
      if (capDirectTimer.current) clearTimeout(capDirectTimer.current);
      if (capAttemptTimer.current) { clearTimeout(capAttemptTimer.current); capAttemptTimer.current = null; }
      const finish = (reason: SyncStopReason = 'idle_timeout', detail?: string) => {
        if (state.done) return;
        state.done = true;
        if (capTimer.current) { clearTimeout(capTimer.current); capTimer.current = null; }
        if (capIdle.current) { clearTimeout(capIdle.current); capIdle.current = null; }
        if (capDirectTimer.current) { clearTimeout(capDirectTimer.current); capDirectTimer.current = null; }
        if (capAttemptTimer.current) { clearTimeout(capAttemptTimer.current); capAttemptTimer.current = null; }
        capFinish.current = null;
        if (capRef.current === state) capRef.current = null;
        setVerifyVisible(false);
        setCapture(null);
        const engine: SyncEngine = state.usedDirect && state.usedScroll ? 'mixed' : state.usedDirect ? 'direct' : 'scroll';
        const effectiveReason: SyncStopReason = reason === 'idle_timeout' && state.sawCaptcha && state.pages.length === 0 ? 'captcha' : reason;
        const notes = [detail || state.lastDetail, state.directFailNote, state.pages.length === 0 ? state.lastDiagNote : ''].filter(Boolean);
        const finalNextCursor = state.lastHasMore === false ? null : state.lastCursor;
        appendSyncLog(`capture_finish[${kind}]: reason=${effectiveReason} engine=${engine} pages=${state.pages.length} hasMore=${String(state.lastHasMore)} next=${finalNextCursor ?? 'null'} detail=${notes.join('；')}`);
        resolve({
          pages: state.pages.slice(),
          diagnostic: {
            reason: effectiveReason,
            engine,
            pages: state.pages.length,
            hasMore: state.lastHasMore,
            nextCursor: finalNextCursor,
            lastStatus: state.lastStatus,
            lastStatusCode: state.lastStatusCode,
            elapsedMs: Math.max(1, Date.now() - state.startedAt),
            detail: notes.join('；'),
          },
        });
      };
      capFinish.current = finish;
      capTimer.current = setTimeout(() => finish('total_timeout'), timeoutMs);
      // Give cold WebView loads up to 40s initially; once onLoadEnd completes, idleTimeoutMs applies.
      capIdle.current = setTimeout(() => finish('idle_timeout'), Math.max(idleTimeoutMs, 40_000));
      setVerifyVisible(false);
      setCapture({ kind, nonce: capSeq.current, maxScrolls, initialPaused: mode === 'resume' && Boolean(resumeCursor) });
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
    openLogin, closeLogin, completeLogin, checkLogin, logout, request, captureCollection, cancelCapture, openCaptureVerify,
  }), [mounted, loggedIn, checking, loginVisible, loginError, loginDebug, nickname, openLogin, closeLogin, completeLogin, checkLogin, logout, request, captureCollection, cancelCapture, openCaptureVerify]);

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
    {capture && <View key={`cap-${capture.nonce}`} style={verifyVisible ? styles.overlay : styles.captureHidden} pointerEvents={verifyVisible ? 'auto' : 'none'} accessibilityElementsHidden={!verifyVisible} importantForAccessibility={verifyVisible ? 'auto' : 'no-hide-descendants'}>
      <WebView
        ref={capWebRef}
        source={{ uri: capture.kind === 'likes' ? LIKES_URL : FAVORITES_URL }}
        userAgent={DESKTOP_UA}
        injectedJavaScriptBeforeContentLoaded={FINGERPRINT + '\n' + CAPTURE_HOOK}
        injectedJavaScript={captureScroll(capture.maxScrolls, capture.kind, capture.initialPaused)}
        onLoadEnd={() => {
          const st = capRef.current;
          if (!st || st.done) return;
          st.loadEnded = true;
          appendSyncLog(`wv_load_end[${st.kind}]: pages=${st.pages.length} pending=${st.pendingReqId || '-'}`);
          try { capWebRef.current?.injectJavaScript('window.__mylikeProbe&&window.__mylikeProbe();true;'); } catch {}
          if (st.pages.length === 0 && !st.sawCaptcha && !st.pendingReqId) {
            if (capIdle.current) clearTimeout(capIdle.current);
            capIdle.current = setTimeout(() => { capFinish.current?.('idle_timeout'); }, st.idleTimeoutMs);
          }
        }}
        onError={(e) => {
          const st = capRef.current;
          if (st && !st.done) {
            st.lastDetail = `WebView错误:${e.nativeEvent?.description || e.nativeEvent?.code || 'unknown'}`;
            appendSyncLog(`wv_error[${st.kind}]: ${st.lastDetail}`);
          }
        }}
        onHttpError={(e) => {
          const st = capRef.current;
          if (st && !st.done) {
            st.lastStatus = e.nativeEvent?.statusCode ?? st.lastStatus;
            st.lastDetail = `页面HTTP ${e.nativeEvent?.statusCode ?? 0}`;
            appendSyncLog(`wv_http_error[${st.kind}]: ${st.lastDetail}`);
          }
        }}
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
      {verifyVisible && <View style={[styles.loginChrome, { paddingTop: insets.top }]} pointerEvents="box-none">
        <StatusBar barStyle="light-content" />
        <View style={styles.loginHeader}>
          <Pressable accessibilityRole="button" accessibilityLabel="取消验证" onPress={() => capFinish.current?.('cancelled')} hitSlop={10}><Text style={styles.loginCancel}>取消</Text></Pressable>
          <Text style={styles.loginTitle}>抖音安全验证</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="继续同步" onPress={resumeAfterVerify} hitSlop={10}><Text style={styles.loginDone}>继续</Text></Pressable>
        </View>
        <Text style={styles.loginHint}>请手动完成页面上的滑块/验证；通过后通常会自动隐藏继续，若未自动关闭请点右上角「继续」。</Text>
      </View>}
    </View>}
  </SessionContext.Provider>;
}

const styles = StyleSheet.create({
  hidden: { position: 'absolute', left: 0, top: 0, width: 2, height: 2, opacity: 0.01, overflow: 'hidden' },
  captureHidden: { position: 'absolute', left: 0, top: 0, width: 390, height: 800, opacity: 0.01, zIndex: -1, elevation: -1 },
  overlay: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, opacity: 1, zIndex: 2000, elevation: 2000, backgroundColor: '#151723' },
  webview: { flex: 1, backgroundColor: '#fff' },
  loginChrome: { position: 'absolute', left: 0, right: 0, top: 0, zIndex: 1001, elevation: 1001, backgroundColor: '#151723' },
  loginHeader: { height: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#2c2f3d' },
  loginTitle: { fontSize: 16, fontWeight: '600', color: '#fff' },
  loginCancel: { fontSize: 15, color: '#bababb' },
  loginDone: { fontSize: 15, fontWeight: '600', color: '#fc2f56' },
  loginDoneBusy: { color: '#666' },
  loginHint: { fontSize: 12, lineHeight: 18, color: '#c7c7cf', paddingHorizontal: 16, paddingVertical: 8, backgroundColor: '#22242f' },
});
