import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { GestureDetector, GestureStateManager, useNativeGesture, usePanGesture, useSimultaneousGestures } from 'react-native-gesture-handler';
import Animated, { cancelAnimation, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';
import { mediaHeaders } from './douyin';
import { parseCommentList, type CommentPage, type FullComment } from './douyin-bridge';
import { cachedGuestComments, fetchGuestCommentPreview, type GuestComment, type GuestCommentPreview } from './guest-comments';
import { fetchGuestReplies } from './mobile/guest-replies';
import { useDouyinSession } from './mobile/douyin-session';

const GuestCommentRow = memo(function GuestCommentRow({ item }: { item: GuestComment }) {
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

const FullCommentRow = memo(function FullCommentRow({ item, depth, onToggleReplies, loadingReplies, hasLoadedReplies }: {
  item: FullComment; depth: number; onToggleReplies?: () => void; loadingReplies?: boolean; hasLoadedReplies?: boolean;
}) {
  const [failed, setFailed] = useState(false); const [expanded, setExpanded] = useState(false);
  useEffect(() => { setFailed(false); }, [item.avatar]);
  const meta = [item.createdAt ? new Date(item.createdAt).toLocaleDateString() : '', item.region].filter(Boolean).join(' · ');
  return <View style={[styles.row, depth > 0 && styles.replyRow]}>
    {item.avatar && !failed ? <Image source={{ uri: item.avatar, headers: mediaHeaders }} style={[styles.avatar, depth > 0 && styles.replyAvatar]} onError={() => setFailed(true)} /> : <View style={[styles.avatar, depth > 0 && styles.replyAvatar]} />}
    <View style={styles.body}>
      <Text style={styles.name}>{item.nickname}</Text>
      <Text selectable numberOfLines={expanded ? undefined : 6} style={styles.text}>{item.text}</Text>
      {item.text.length > 160 && <Pressable accessibilityRole="button" onPress={() => setExpanded(value => !value)} hitSlop={5}><Text style={styles.reply}>{expanded ? '收起' : '展开'}</Text></Pressable>}
      {item.attachments.length > 0 && <View style={styles.attachments}>{item.attachments.map(attachment => <Image key={attachment.url} source={{ uri: attachment.url, headers: mediaHeaders }} style={styles.attachment} resizeMode="cover" />)}</View>}
      {!!meta && <Text style={styles.meta}>{meta}</Text>}
      {item.replyCount > 0 && depth === 0 && onToggleReplies && <Pressable accessibilityRole="button" onPress={onToggleReplies} hitSlop={5}><Text style={styles.reply}>{loadingReplies ? '正在读取回复…' : hasLoadedReplies ? '收起回复' : `${item.replyCount} 条回复`}</Text></Pressable>}
    </View>{item.likes !== null && <Text accessibilityLabel={`${item.likes} 个赞`} style={styles.likes}>♡ {item.likes}</Text>}
  </View>;
});

// One row in the flat list. Replies are flattened to depth 1, followed by an
// optional "load more replies" row or an inline reply error row.
type ListRow =
  | { key: string; type: 'comment'; item: FullComment }
  | { key: string; type: 'reply'; item: FullComment }
  | { key: string; type: 'moreReplies'; comment: FullComment; loading: boolean }
  | { key: string; type: 'replyEmpty'; comment: FullComment }
  | { key: string; type: 'replyError'; comment: FullComment; error: string };

type ReplyState = { items: FullComment[]; cursor: string | null; hasMore: boolean; loading: boolean; loaded: boolean; error: string };

export function CommentSheet({ workId, height, onClose, onClosing, closeRequest = 0 }: { workId: string; height: number; onClose: () => void; onClosing?: () => void; closeRequest?: number }) {
  const insets = useSafeAreaInsets();
  const { request, loggedIn, openLogin, checkLogin, loginDebug } = useDouyinSession();
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

  // Load a page of replies for one comment. Replies are login-gated: the public
  // mobile endpoint returns `total:0` for guests, so we read them through the
  // signed, logged-in page (the same channel that already loads the comment
  // list). The public endpoint stays only as a fallback if the page route comes
  // back empty or errors.
  const loadReplies = useCallback(async (comment: FullComment, cursor: string, append: boolean) => {
    setReplyState(previous => {
      const base = previous[comment.id] ?? { items: [], cursor: null, hasMore: false, loaded: false, loading: false, error: '' } as ReplyState;
      return { ...previous, [comment.id]: { ...base, loading: true, error: '' } };
    });
    try {
      let page: CommentPage | null = null;
      try {
        const response = await request('commentReplies', {
          item_id: workId, comment_id: comment.id, cursor, count: '20', item_type: '0',
        });
        page = parseCommentList(response.body, workId, cursor, response.status);
      } catch { page = null; }
      if (!page || (page.items.length === 0 && !page.hasMore)) {
        try {
          const fallback = await fetchGuestReplies(workId, comment.id, cursor);
          if (!page || fallback.items.length > 0 || fallback.hasMore) page = fallback;
        } catch { /* keep whatever the page route returned */ }
      }
      if (!page) throw new Error('回复读取失败，请重试。');
      const resolved = page;
      setReplyState(previous => {
        const base = previous[comment.id] ?? { items: [], cursor: null, hasMore: false, loaded: false, error: '', loading: false } as ReplyState;
        const seen = new Set(base.items.map(item => item.id));
        const merged = append ? base.items.slice() : [];
        if (!append) seen.clear();
        for (const item of resolved.items) if (!seen.has(item.id)) { merged.push(item); seen.add(item.id); }
        return { ...previous, [comment.id]: { items: merged, cursor: resolved.nextCursor, hasMore: resolved.hasMore, loaded: true, loading: false, error: '' } };
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
    if (!state || (!state.loaded && !state.loading)) void loadReplies(comment, '0', false);
  }, [repliesOpen, replyState, loadReplies]);

  const rows = useMemo<ListRow[]>(() => {
    const out: ListRow[] = [];
    for (const comment of fullComments) {
      out.push({ key: comment.id, type: 'comment', item: comment });
      if (!repliesOpen[comment.id]) continue;
      const state = replyState[comment.id];
      if (state?.items.length) for (const reply of state.items) out.push({ key: `${comment.id}_${reply.id}`, type: 'reply', item: reply });
      if (state?.error) out.push({ key: `${comment.id}_err`, type: 'replyError', comment, error: state.error });
      else if (state?.hasMore && state.cursor) out.push({ key: `${comment.id}_more`, type: 'moreReplies', comment, loading: state.loading });
      else if (state?.loaded && state.items.length === 0) out.push({ key: `${comment.id}_empty`, type: 'replyEmpty', comment });
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
  return <Animated.View accessibilityViewIsModal style={[styles.sheet, { height }, style]}>
    <GestureDetector gesture={pan}><View style={styles.header}><View style={styles.grip} /><Text style={styles.title}>{loggedIn ? `评论 · ${fullComments.length} 条` : `评论预览${current ? ` · ${current.items.length} 条` : ''}`}</Text><Pressable accessibilityLabel="关闭评论" onPress={close} hitSlop={15} style={styles.close}><Text style={styles.closeText}>×</Text></Pressable></View></GestureDetector>
    {loggedIn
      ? <View style={styles.noticeFull}><Text style={styles.noticeFullText}>已登录 · 完整评论，支持翻页和楼中楼回复</Text>{fullLoading && <ActivityIndicator size="small" color="#3ddc84" />}</View>
      : <View style={styles.notice}><Text style={styles.noticeText}>游客有限预览 · 登录后可看完整评论和回复</Text><Pressable accessibilityRole="button" accessibilityLabel="登录抖音" onPress={openLogin} hitSlop={8}><Text style={styles.loginCta}>登录</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel="刷新评论预览" disabled={refreshing} onPress={retry} hitSlop={8}><Text style={styles.retry}>{refreshing ? '读取中' : '刷新'}</Text></Pressable></View>}
    {!loggedIn && loginDebug ? <Text style={styles.debug}>{loginDebug}</Text> : null}
    {loggedIn
      ? <>
        {fullLoading && !fullComments.length && <ActivityIndicator color="#888" style={styles.loading} />}
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
              return <FullCommentRow item={item.item} depth={0} loadingReplies={!!state?.loading} hasLoadedReplies={!!repliesOpen[item.item.id] && !!state?.items.length} onToggleReplies={item.item.replyCount > 0 ? () => toggleReplies(item.item) : undefined} />;
            }
            if (item.type === 'reply') return <FullCommentRow item={item.item} depth={1} />;
            if (item.type === 'moreReplies') return <Pressable accessibilityRole="button" disabled={item.loading} onPress={() => void loadReplies(item.comment, replyState[item.comment.id]?.cursor ?? '0', true)} style={styles.replyMore}><Text style={styles.retry}>{item.loading ? '正在读取更多回复…' : '加载更多回复'}</Text></Pressable>;
            if (item.type === 'replyEmpty') return <Text style={styles.replyEmpty}>暂无可见回复</Text>;
            return <Pressable accessibilityRole="button" onPress={() => void loadReplies(item.comment, '0', false)} style={styles.replyError}><Text style={styles.meta}>回复读取失败：{item.error}</Text><Text style={styles.retry}>点按重试</Text></Pressable>;
          }} /></GestureDetector> : null}
      </>
      : <>
        {!current && refreshing && <ActivityIndicator color="#888" style={styles.loading} />}
        {!!error && <Pressable onPress={retry} style={styles.error}><Text style={styles.meta}>{error}</Text><Text style={styles.retry}>点按重试</Text></Pressable>}
        {current && <GestureDetector gesture={listGesture}><Animated.FlatList data={current.items} keyExtractor={item => item.id} contentContainerStyle={[styles.list, { paddingBottom: Math.max(16, insets.bottom) }]} style={{ flex: 1 }}
          initialNumToRender={10} maxToRenderPerBatch={8} windowSize={5} scrollEnabled={!dragging} onScroll={scroll} scrollEventThrottle={16} bounces={false} overScrollMode="never"
          ListEmptyComponent={<Text style={styles.meta}>分享接口未提供预览，无法据此判断作品是否无评论。</Text>}
          ListFooterComponent={current.items.length ? <Text style={styles.footer}>仅展示游客可读取的预览，登录后可看全部评论。</Text> : undefined}
          renderItem={({ item }) => <GuestCommentRow item={item} />} /></GestureDetector>}
      </>}
  </Animated.View>;
}
const styles = StyleSheet.create({
  sheet: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: '#1b1d29', borderTopLeftRadius: 16, borderTopRightRadius: 16, overflow: 'hidden', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#2c2f3d' },
  header: { height: 56, alignItems: 'center', justifyContent: 'center' }, grip: { width: 32, height: 3, borderRadius: 2, backgroundColor: '#3a3d4a', position: 'absolute', top: 8 },
  title: { color: '#fff', fontWeight: '600', fontSize: 14 }, close: { position: 'absolute', right: 20, top: 14 }, closeText: { color: '#d8d8de', fontSize: 25 },
  notice: { backgroundColor: '#2c2718', paddingHorizontal: 14, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 10 }, noticeText: { color: '#e8c477', fontSize: 11, flex: 1 },
  noticeFull: { backgroundColor: '#16241d', paddingHorizontal: 14, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 10 }, noticeFullText: { color: '#7fdcaa', fontSize: 11, flex: 1 },
  debug: { color: '#8b8b96', fontSize: 10, paddingHorizontal: 14, paddingBottom: 6, backgroundColor: '#20222e' },
  loginCta: { color: '#fc2f56', fontSize: 12, fontWeight: '600' },
  list: { padding: 16 }, loading: { padding: 28 }, error: { padding: 16, gap: 9, alignItems: 'center' }, more: { padding: 14, alignItems: 'center' },
  replyMore: { paddingVertical: 8, paddingLeft: 42, alignItems: 'flex-start' }, replyError: { paddingVertical: 8, paddingLeft: 42, gap: 4, alignItems: 'flex-start' }, replyEmpty: { color: '#8b8b96', fontSize: 12, paddingVertical: 8, paddingLeft: 42 },
  row: { flexDirection: 'row', gap: 11, marginBottom: 25 }, replyRow: { marginBottom: 14, paddingLeft: 8 }, avatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#2a2c3a' }, replyAvatar: { width: 26, height: 26, borderRadius: 13 }, body: { flex: 1, gap: 6 },
  name: { color: '#9a9aa5', fontSize: 12 }, text: { color: '#f2f2f5', fontSize: 15, lineHeight: 22 }, meta: { color: '#8b8b96', fontSize: 11 }, reply: { color: '#9a9aa5', fontSize: 12 }, likes: { color: '#9a9aa5', fontSize: 11, paddingTop: 2, maxWidth: 58 },
  attachments: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 }, attachment: { width: 84, height: 84, borderRadius: 6, backgroundColor: '#2a2c3a' },
  footer: { color: '#7c7c88', textAlign: 'center', fontSize: 12, padding: 12 }, retry: { color: '#fc2f56', fontSize: 12 },
});
