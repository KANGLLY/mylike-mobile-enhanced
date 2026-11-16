import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState, createContext } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { GestureDetector, GestureStateManager, useNativeGesture, usePanGesture, useSimultaneousGestures } from 'react-native-gesture-handler';
import Animated, { cancelAnimation, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';
import { mediaHeaders } from './douyin';
import { parseCommentList, type FullComment } from './douyin-bridge';
import { cachedGuestComments, fetchGuestCommentPreview, type GuestComment, type GuestCommentPreview } from './guest-comments';
import { useDouyinSession } from './mobile/douyin-session';
import { useMobile } from './mobile/context';

function formatLikes(value: number): string {
  return value >= 10000 ? `${(value / 10000).toFixed(1)}万` : String(value);
}

// Two palettes for the comment sheet. The dark one is the original Douyin-like
// look; the light one is a daytime variant the user can pick in Settings.
const darkColors = {
  sheetBg: '#0b0b0d', border: '#1e1e22', grip: '#333338',
  title: '#f2f2f5', closeText: '#9a9aa0',
  noticeBg: '#151310', noticeText: '#b99a5a',
  noticeFullBg: '#0f1512', noticeFullText: '#6fbf8f',
  debugBg: '#121316', debugText: '#7a7a82',
  loginCta: '#ff4d5e',
  replyEmpty: '#7a7a82', footerAction: '#9a9a9a', avatarBg: '#242429',
  name: '#8b8b93', text: '#e9e9ec', meta: '#7a7a82', metaDot: '#5a5a62',
  reply: '#9a9a9a', likeCount: '#8b8b93', likes: '#9a9a9a',
  attachBg: '#242429', footer: '#6f6f78', retry: '#ff4d5e',
  icon: '#9a9a9a', iconFaint: '#55555c', spinner: '#888888', green: '#3ddc84',
};
const lightColors = {
  sheetBg: '#ffffff', border: '#e6e6ea', grip: '#cfcfd4',
  title: '#17171a', closeText: '#8a8a90',
  noticeBg: '#fff6e6', noticeText: '#8a6a2f',
  noticeFullBg: '#e9f7ef', noticeFullText: '#2f8a5b',
  debugBg: '#f2f2f5', debugText: '#8a8a90',
  loginCta: '#e5344f',
  replyEmpty: '#8a8a90', footerAction: '#6a6a72', avatarBg: '#e8e8ee',
  name: '#5a5a62', text: '#1a1a1c', meta: '#8a8a90', metaDot: '#b5b5bc',
  reply: '#7a7a82', likeCount: '#5a5a62', likes: '#8a8a90',
  attachBg: '#e8e8ee', footer: '#9a9aa0', retry: '#e5344f',
  icon: '#8a8a90', iconFaint: '#c2c2c8', spinner: '#999999', green: '#2f8a5b',
};

function makeStyles(c: typeof darkColors) {
  return StyleSheet.create({
    sheet: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: c.sheetBg, borderTopLeftRadius: 16, borderTopRightRadius: 16, overflow: 'hidden', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
    header: { height: 56, alignItems: 'center', justifyContent: 'center' }, grip: { width: 32, height: 3, borderRadius: 2, backgroundColor: c.grip, position: 'absolute', top: 8 },
    title: { color: c.title, fontWeight: '600', fontSize: 14 }, close: { position: 'absolute', right: 20, top: 14 }, closeText: { color: c.closeText, fontSize: 25 },
    notice: { backgroundColor: c.noticeBg, paddingHorizontal: 14, paddingVertical: 9, flexDirection: 'row', alignItems: 'center', gap: 10 }, noticeText: { color: c.noticeText, fontSize: 11, flex: 1 },
    noticeFull: { backgroundColor: c.noticeFullBg, paddingHorizontal: 14, paddingVertical: 9, flexDirection: 'row', alignItems: 'center', gap: 10 }, noticeFullText: { color: c.noticeFullText, fontSize: 11, flex: 1 },
    debug: { color: c.debugText, fontSize: 10, paddingHorizontal: 14, paddingBottom: 6, backgroundColor: c.debugBg },
    loginCta: { color: c.loginCta, fontSize: 12, fontWeight: '600' },
    list: { padding: 14 }, loading: { padding: 28 }, error: { padding: 16, gap: 9, alignItems: 'center' }, more: { padding: 14, alignItems: 'center' },
    replyError: { paddingVertical: 8, paddingLeft: 76, gap: 4, alignItems: 'flex-start' }, replyEmpty: { color: c.replyEmpty, fontSize: 12, paddingVertical: 8, paddingLeft: 76 },
    replyFooter: { flexDirection: 'row', alignItems: 'center', gap: 24, paddingLeft: 76, paddingVertical: 10, marginBottom: 4 },
    footerActionRow: { flexDirection: 'row', alignItems: 'center', gap: 2 }, footerAction: { color: c.footerAction, fontSize: 13 },
    row: { flexDirection: 'row', gap: 10, marginBottom: 24, alignItems: 'flex-start' }, replyRow: { marginBottom: 12, paddingLeft: 46 },
    avatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: c.avatarBg }, replyAvatar: { width: 26, height: 26, borderRadius: 13 },
    body: { flex: 1, gap: 5 },
    name: { color: c.name, fontSize: 12.5 }, replyName: { fontSize: 11.5 },
    text: { color: c.text, fontSize: 15, lineHeight: 22 }, replyText: { fontSize: 14, lineHeight: 20 },
    metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8 }, meta: { color: c.meta, fontSize: 11 }, metaDot: { color: c.metaDot, fontSize: 11 },
    reply: { color: c.reply, fontSize: 12 }, expandReplies: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 1 },
    actions: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingTop: 2 }, likeCol: { alignItems: 'center', minWidth: 26 }, likeCount: { color: c.likeCount, fontSize: 10.5, marginTop: 1 }, dislike: {},
    likes: { color: c.likes, fontSize: 11, paddingTop: 2, maxWidth: 58 },
    attachments: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 }, attachment: { width: 84, height: 84, borderRadius: 6, backgroundColor: c.attachBg },
    footer: { color: c.footer, textAlign: 'center', fontSize: 12, padding: 12 }, retry: { color: c.retry, fontSize: 12 },
  });
}

type CommentThemeValue = { light: boolean; C: typeof darkColors; styles: ReturnType<typeof makeStyles> };
const darkTheme: CommentThemeValue = { light: false, C: darkColors, styles: makeStyles(darkColors) };
const lightTheme: CommentThemeValue = { light: true, C: lightColors, styles: makeStyles(lightColors) };
const ThemeCtx = createContext<CommentThemeValue>(darkTheme);
const useCommentTheme = () => useContext(ThemeCtx);

const GuestCommentRow = memo(function GuestCommentRow({ item }: { item: GuestComment }) {
  const { styles } = useCommentTheme();
  const [failed, setFailed] = useState(false); const [expanded, setExpanded] = useState(false);
  useEffect(() => { setFailed(false); }, [item.avatar]);
  const meta = [item.createdAt ? new Date(item.createdAt).toLocaleDateString() : '', item.region].filter(Boolean).join(' · ');
  return <View style={styles.row}>
    {item.avatar && !failed ? <Image source={{ uri: item.avatar, headers: mediaHeaders }} style={styles.avatar} onError={() => setFailed(true)} /> : <View style={styles.avatar} />}
    <View style={styles.body}><Text style={styles.name}>{item.nickname}</Text><Text selectable numberOfLines={expanded ? undefined : 6} style={styles.text}>{item.text}</Text>
      {item.text.length > 160 && <Pressable accessibilityRole="button" onPress={() => setExpanded(value => !value)} hitSlop={5}><Text style={styles.reply}>{expanded ? '收起' : '展开'}</Text></Pressable>}
      {!!meta && <Text style={styles.meta}>{meta}</Text>}
      {!!item.replyCount && <Text style={styles.reply}>{item.replyCount} 条回复 · 游客暂不可读取</Text>}
    </View>{item.likes !== null && <Text accessibilityLabel={`${item.likes} 个赞`} style={styles.likes}>♡ {item.likes}</Text>}
  </View>;
});

const FullCommentRow = memo(function FullCommentRow({ item, depth, repliesOpen, onToggleReplies, loadingReplies }: {
  item: FullComment; depth: number; repliesOpen?: boolean; onToggleReplies?: () => void; loadingReplies?: boolean;
}) {
  const { styles, C } = useCommentTheme();
  const [failed, setFailed] = useState(false); const [expanded, setExpanded] = useState(false);
  useEffect(() => { setFailed(false); }, [item.avatar]);
  const meta = [item.createdAt ? new Date(item.createdAt).toLocaleDateString() : '', item.region].filter(Boolean).join(' · ');
  return <View style={[styles.row, depth > 0 && styles.replyRow]}>
    {item.avatar && !failed ? <Image source={{ uri: item.avatar, headers: mediaHeaders }} style={[styles.avatar, depth > 0 && styles.replyAvatar]} onError={() => setFailed(true)} /> : <View style={[styles.avatar, depth > 0 && styles.replyAvatar]} />}
    <View style={styles.body}>
      <Text style={[styles.name, depth > 0 && styles.replyName]}>{item.nickname}</Text>
      <Text selectable numberOfLines={expanded ? undefined : 6} style={[styles.text, depth > 0 && styles.replyText]}>{item.text}</Text>
      {item.text.length > 160 && <Pressable accessibilityRole="button" onPress={() => setExpanded(value => !value)} hitSlop={5}><Text style={styles.reply}>{expanded ? '收起' : '展开'}</Text></Pressable>}
      {item.attachments.length > 0 && <View style={styles.attachments}>{item.attachments.map(attachment => <Image key={attachment.url} source={{ uri: attachment.url, headers: mediaHeaders }} style={styles.attachment} resizeMode="cover" />)}</View>}
      <View style={styles.metaRow}>
        {!!meta && <Text style={styles.meta}>{meta}</Text>}
        {depth === 0 && <Text style={styles.metaDot}>·</Text>}
        {depth === 0 && <Text style={styles.reply}>回复</Text>}
      </View>
      {item.replyCount > 0 && depth === 0 && onToggleReplies && !repliesOpen && <Pressable accessibilityRole="button" onPress={onToggleReplies} hitSlop={5} style={styles.expandReplies}><Text style={styles.reply}>{loadingReplies ? '正在读取回复…' : `展开 ${item.replyCount} 条回复`}</Text><Ionicons name="chevron-down" size={13} color={C.icon} /></Pressable>}
    </View>
    <View style={styles.actions}>
      <View style={styles.likeCol}>
        <Ionicons name="heart-outline" size={16} color={C.icon} />
        {item.likes !== null && <Text style={styles.likeCount}>{formatLikes(item.likes)}</Text>}
      </View>
      <Ionicons name="heart-dislike-outline" size={16} color={C.iconFaint} style={styles.dislike} />
    </View>
  </View>;
});

// One row in the flat list. Replies are flattened to depth 1, followed by an
// optional "load more replies" row or an inline reply error row.
type ListRow =
  | { key: string; type: 'comment'; item: FullComment }
  | { key: string; type: 'reply'; item: FullComment }
  | { key: string; type: 'replyFooter'; comment: FullComment; hasMore: boolean; loading: boolean }
  | { key: string; type: 'replyEmpty'; comment: FullComment }
  | { key: string; type: 'replyError'; comment: FullComment; error: string };

type ReplyState = { items: FullComment[]; cursor: string | null; hasMore: boolean; loading: boolean; loaded: boolean; error: string };

export function CommentSheet({ workId, height, onClose, onClosing, closeRequest = 0 }: { workId: string; height: number; onClose: () => void; onClosing?: () => void; closeRequest?: number }) {
  const insets = useSafeAreaInsets();
  const { request, loggedIn, openLogin, checkLogin, loginDebug } = useDouyinSession();
  const { preferences } = useMobile();
  const theme = preferences.commentTheme === 'light' ? lightTheme : darkTheme;
  const { styles, C } = theme;
  const [result, setResult] = useState<GuestCommentPreview | null>(() => cachedGuestComments(workId));
  const [error, setError] = useState(''); const [refreshing, setRefreshing] = useState(false); const [attempt, setAttempt] = useState(0);
  const [fullComments, setFullComments] = useState<FullComment[]>([]); const [fullCursor, setFullCursor] = useState<string | null>(null);
  const [fullHasMore, setFullHasMore] = useState(false); const [fullLoading, setFullLoading] = useState(false); const [fullLoadingMore, setFullLoadingMore] = useState(false); const [fullError, setFullError] = useState('');
  const [repliesOpen, setRepliesOpen] = useState<Record<string, boolean>>({});
  const [replyState, setReplyState] = useState<Record<string, ReplyState>>({});
  const offset = useSharedValue(height); const closing = useSharedValue(false); const previousClose = useRef(closeRequest);
  const scrollY = useSharedValue(0); const start = useSharedValue({ x: 0, y: 0 }); const [dragging, setDragging] = useState(false);
  const current = result?.workId === workId ? result : null;

  // Detect an already-signed-in session the first time the sheet opens, so a
  // returning user does not have to open the login page and press "完成" again.
  const initedRef = useRef(false);
  useEffect(() => {
    if (initedRef.current) return;
    initedRef.current = true;
    if (!loggedIn) void checkLogin(true);
  }, [checkLogin, loggedIn]);

  const loadFull = useCallback(async (cursor: string, append: boolean) => {
    if (append) setFullLoadingMore(true); else setFullLoading(true);
    setFullError('');
    try {
      // Same parameter set the desktop app sends for the web comment endpoint.
      const response = await request('comments', {
        aweme_id: workId, cursor, count: '20', item_type: '0',
        insert_ids: '', whale_cut_token: '', cut_version: '1', rcFT: '',
      });
      const page = parseCommentList(response.body, workId, cursor, response.status);
      setFullComments(previous => {
        const next = append ? previous.slice() : [];
        const seen = new Set(next.map(comment => comment.id));
        for (const item of page.items) if (!seen.has(item.id)) { next.push(item); seen.add(item.id); }
        return next;
      });
      setFullCursor(page.nextCursor);
      setFullHasMore(page.hasMore);
    } catch (failure) {
      setFullError(failure instanceof Error ? failure.message : '读取评论失败，请重试。');
    } finally { if (append) setFullLoadingMore(false); else setFullLoading(false); }
  }, [request, workId]);

  // Load a page of replies for one comment. Replies are login-gated: guests get
  // `total:0`, so we read them through the signed, logged-in page (same channel
  // as the comment list). The first tap expands a short page of 3 (like Douyin);
  // each subsequent "展开更多" pulls a fixed 10.
  const loadReplies = useCallback(async (comment: FullComment, cursor: string, append: boolean, limit: number) => {
    setReplyState(previous => {
      const base = previous[comment.id] ?? { items: [], cursor: null, hasMore: false, loaded: false, loading: false, error: '' } as ReplyState;
      return { ...previous, [comment.id]: { ...base, loading: true, error: '' } };
    });
    try {
      const response = await request('commentReplies', {
        item_id: workId, comment_id: comment.id, cursor, count: String(limit), item_type: '0',
      }, 8000);
      const page = parseCommentList(response.body, workId, cursor, response.status);
      setReplyState(previous => {
        const base = previous[comment.id] ?? { items: [], cursor: null, hasMore: false, loaded: false, loading: false, error: '' } as ReplyState;
        const seen = new Set(base.items.map(item => item.id));
        const merged = append ? base.items.slice() : [];
        if (!append) seen.clear();
        for (const item of page.items) if (!seen.has(item.id)) { merged.push(item); seen.add(item.id); }
        return { ...previous, [comment.id]: { items: merged, cursor: page.nextCursor, hasMore: page.hasMore, loaded: true, loading: false, error: '' } };
      });
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : '回复读取失败，请重试。';
      setReplyState(previous => {
        const base = previous[comment.id] ?? { items: [], cursor: null, hasMore: false, loaded: false, loading: false, error: '' } as ReplyState;
        return { ...previous, [comment.id]: { ...base, loading: false, error: message } };
      });
    }
  }, [request, workId]);

  const toggleReplies = useCallback((comment: FullComment) => {
    if (repliesOpen[comment.id]) { setRepliesOpen(previous => ({ ...previous, [comment.id]: false })); return; }
    setRepliesOpen(previous => ({ ...previous, [comment.id]: true }));
    const state = replyState[comment.id];
    if (!state || (!state.loaded && !state.loading)) void loadReplies(comment, '0', false, 3);
  }, [repliesOpen, replyState, loadReplies]);

  const rows = useMemo<ListRow[]>(() => {
    const out: ListRow[] = [];
    for (const comment of fullComments) {
      out.push({ key: comment.id, type: 'comment', item: comment });
      if (!repliesOpen[comment.id]) continue;
      const state = replyState[comment.id];
      if (state?.items.length) for (const reply of state.items) out.push({ key: `${comment.id}_${reply.id}`, type: 'reply', item: reply });
      if (state?.error) out.push({ key: `${comment.id}_err`, type: 'replyError', comment, error: state.error });
      else if (state?.loaded && state.items.length === 0 && !state.hasMore) out.push({ key: `${comment.id}_empty`, type: 'replyEmpty', comment });
      out.push({ key: `${comment.id}_footer`, type: 'replyFooter', comment, hasMore: !!state?.hasMore && !!state?.cursor, loading: !!state?.loading });
    }
    return out;
  }, [fullComments, repliesOpen, replyState]);

  useEffect(() => {
    if (!loggedIn) return;
    setFullComments([]); setFullCursor(null); setFullHasMore(false); setRepliesOpen({}); setReplyState({});
    void loadFull('0', false);
  }, [loggedIn, workId, loadFull]);

  useEffect(() => {
    if (loggedIn) return;
    let alive = true; const abort = new AbortController();
    setError(''); const cached = cachedGuestComments(workId); setResult(cached); setRefreshing(true);
    void fetchGuestCommentPreview(workId, abort.signal, attempt > 0).then(page => { if (alive) setResult(page); })
      .catch(failure => { if (alive) setError(failure instanceof Error ? failure.message : '读取失败。'); }).finally(() => { if (alive) setRefreshing(false); });
    return () => { alive = false; abort.abort(); };
  }, [workId, attempt, loggedIn]);

  useEffect(() => {
    closing.value = false; offset.value = height; offset.value = withTiming(0, { duration: 250 });
    return () => cancelAnimation(offset);
  }, [workId, height, closing, offset]);
  const close = useCallback(() => {
    if (closing.value) return; closing.value = true; onClosing?.();
    offset.value = withTiming(height, { duration: 250 }, done => { if (done) scheduleOnRN(onClose); });
  }, [height, closing, offset, onClose, onClosing]);
  useEffect(() => { if (previousClose.current !== closeRequest) { previousClose.current = closeRequest; close(); } }, [closeRequest, close]);
  const pan = usePanGesture({ activeOffsetY: [-12, 12], failOffsetX: [-18, 18],
    onUpdate: event => { 'worklet'; if (!closing.value) offset.value = Math.max(0, event.translationY); },
    onDeactivate: event => { 'worklet'; if (!event.canceled && event.translationY > 0 && (event.translationY > 85 || event.velocityY > 900)) scheduleOnRN(close); else if (!closing.value) offset.value = withTiming(0, { duration: 180 }); },
  });
  const listPan = usePanGesture({ manualActivation: true, maxPointers: 1,
    onTouchesDown: event => { 'worklet'; const touch = event.allTouches[0]; if (!touch || event.numberOfTouches !== 1 || scrollY.value > 1 || closing.value) GestureStateManager.fail(event.handlerTag); else start.value = { x: touch.absoluteX, y: touch.absoluteY }; },
    onTouchesMove: event => {
      'worklet'; const touch = event.allTouches[0]; if (!touch || event.numberOfTouches !== 1) { GestureStateManager.fail(event.handlerTag); return; }
      const y = touch.absoluteY - start.value.y; const x = touch.absoluteX - start.value.x;
      if (Math.abs(x) > 18 || y < -8 || scrollY.value > 1 || closing.value) GestureStateManager.fail(event.handlerTag);
      else if (y > 12) GestureStateManager.activate(event.handlerTag);
    },
    onActivate: () => { 'worklet'; scheduleOnRN(setDragging, true); },
    onUpdate: event => { 'worklet'; if (!closing.value) offset.value = Math.max(0, event.translationY); },
    onDeactivate: event => { 'worklet'; if (!event.canceled && event.translationY > 0 && (event.translationY > 85 || event.velocityY > 900)) scheduleOnRN(close); else if (!closing.value) offset.value = withTiming(0, { duration: 180 }); },
    onFinalize: () => { 'worklet'; scheduleOnRN(setDragging, false); },
  });
  const native = useNativeGesture(); const listGesture = useSimultaneousGestures(listPan, native);
  const scroll = useAnimatedScrollHandler({ onScroll: event => { scrollY.value = Math.max(0, event.contentOffset.y); } });
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: offset.value }] }));
  const retry = () => { if (!refreshing) setAttempt(value => value + 1); };
  const retryFull = () => { if (!fullLoading) void loadFull(fullComments.length ? (fullCursor ?? '0') : '0', false); };
  return <ThemeCtx.Provider value={theme}><Animated.View accessibilityViewIsModal style={[styles.sheet, { height }, style]}>
    <GestureDetector gesture={pan}><View style={styles.header}><View style={styles.grip} /><Text style={styles.title}>{loggedIn ? `评论 · ${fullComments.length} 条` : `评论预览${current ? ` · ${current.items.length} 条` : ''}`}</Text><Pressable accessibilityLabel="关闭评论" onPress={close} hitSlop={15} style={styles.close}><Text style={styles.closeText}>×</Text></Pressable></View></GestureDetector>
    {loggedIn
      ? <View style={styles.noticeFull}><Text style={styles.noticeFullText}>已登录 · 完整评论，支持翻页和楼中楼回复</Text>{fullLoading && <ActivityIndicator size="small" color={C.green} />}</View>
      : <View style={styles.notice}><Text style={styles.noticeText}>游客有限预览 · 登录后可看完整评论和回复</Text><Pressable accessibilityRole="button" accessibilityLabel="登录抖音" onPress={openLogin} hitSlop={8}><Text style={styles.loginCta}>登录</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel="刷新评论预览" disabled={refreshing} onPress={retry} hitSlop={8}><Text style={styles.retry}>{refreshing ? '读取中' : '刷新'}</Text></Pressable></View>}
    {!loggedIn && loginDebug ? <Text style={styles.debug}>{loginDebug}</Text> : null}
    {loggedIn
      ? <>
        {fullLoading && !fullComments.length && <ActivityIndicator color={C.spinner} style={styles.loading} />}
        {!!fullError && <Pressable onPress={retryFull} style={styles.error}><Text style={styles.meta}>{fullError}</Text><Text style={styles.retry}>点按重试</Text></Pressable>}
        {!fullLoading || fullComments.length > 0 ? <GestureDetector gesture={listGesture}><Animated.FlatList data={rows} keyExtractor={row => row.key} contentContainerStyle={[styles.list, { paddingBottom: Math.max(16, insets.bottom) }]} style={{ flex: 1 }}
          initialNumToRender={10} maxToRenderPerBatch={8} windowSize={5} scrollEnabled={!dragging} onScroll={scroll} scrollEventThrottle={16} bounces={false} overScrollMode="never"
          ListEmptyComponent={!fullLoading && !fullError ? <Text style={styles.meta}>还没有评论。</Text> : undefined}
          ListFooterComponent={fullHasMore
            ? <Pressable accessibilityRole="button" disabled={fullLoadingMore} onPress={() => { if (fullCursor && !fullLoadingMore) void loadFull(fullCursor, true); }} style={styles.more}><Text style={styles.retry}>{fullLoadingMore ? '加载中…' : '加载更多评论'}</Text></Pressable>
            : rows.length ? <Text style={styles.footer}>已展示全部评论</Text> : undefined}
          renderItem={({ item }) => {
            if (item.type === 'comment') {
              const state = replyState[item.item.id];
              return <FullCommentRow item={item.item} depth={0} repliesOpen={!!repliesOpen[item.item.id]} loadingReplies={!!state?.loading} onToggleReplies={item.item.replyCount > 0 ? () => toggleReplies(item.item) : undefined} />;
            }
            if (item.type === 'reply') return <FullCommentRow item={item.item} depth={1} />;
            if (item.type === 'replyFooter') return <View style={styles.replyFooter}>
              {item.hasMore ? <Pressable accessibilityRole="button" disabled={item.loading} onPress={() => void loadReplies(item.comment, replyState[item.comment.id]?.cursor ?? '0', true, 10)} hitSlop={6} style={styles.footerActionRow}><Text style={styles.footerAction}>{item.loading ? '正在读取更多…' : '展开更多'}</Text><Ionicons name="chevron-down" size={13} color={C.icon} /></Pressable> : null}
              <Pressable accessibilityRole="button" onPress={() => setRepliesOpen(previous => ({ ...previous, [item.comment.id]: false }))} hitSlop={6} style={styles.footerActionRow}><Text style={styles.footerAction}>收起</Text><Ionicons name="chevron-up" size={13} color={C.icon} /></Pressable>
            </View>;
            if (item.type === 'replyEmpty') return <Text style={styles.replyEmpty}>暂无回复</Text>;
            return <Pressable accessibilityRole="button" onPress={() => void loadReplies(item.comment, '0', false, 3)} style={styles.replyError}><Text style={styles.meta}>回复读取失败：{item.error}</Text><Text style={styles.retry}>点按重试</Text></Pressable>;
          }} /></GestureDetector> : null}
      </>
      : <>
        {!current && refreshing && <ActivityIndicator color={C.spinner} style={styles.loading} />}
        {!!error && <Pressable onPress={retry} style={styles.error}><Text style={styles.meta}>{error}</Text><Text style={styles.retry}>点按重试</Text></Pressable>}
        {current && <GestureDetector gesture={listGesture}><Animated.FlatList data={current.items} keyExtractor={item => item.id} contentContainerStyle={[styles.list, { paddingBottom: Math.max(16, insets.bottom) }]} style={{ flex: 1 }}
          initialNumToRender={10} maxToRenderPerBatch={8} windowSize={5} scrollEnabled={!dragging} onScroll={scroll} scrollEventThrottle={16} bounces={false} overScrollMode="never"
          ListEmptyComponent={<Text style={styles.meta}>分享接口未提供预览，无法据此判断作品是否无评论。</Text>}
          ListFooterComponent={current.items.length ? <Text style={styles.footer}>仅展示游客可读取的预览，登录后可看全部评论。</Text> : undefined}
          renderItem={({ item }) => <GuestCommentRow item={item} />} /></GestureDetector>}
      </>}
  </Animated.View></ThemeCtx.Provider>;
}
