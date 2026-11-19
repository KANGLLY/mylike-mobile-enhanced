import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { InlineWorkComments } from '../CommentSheet';
import { mediaHeaders, type ArticleData } from '../douyin';
import { estimateReadMinutes, formatRelativeTime, parseArticleBlocks } from './article-helpers';

const SCROLL_PX_PER_SEC = 22;
const HERO_BLACK_GRADIENT =
  'linear-gradient(to bottom, rgba(0, 0, 0, 0) 0%, rgba(0, 0, 0, 0.16) 28%, rgba(0, 0, 0, 0.56) 62%, rgba(0, 0, 0, 0.88) 84%, #000000 100%)';
const READER_HERO_GRADIENT =
  'linear-gradient(to bottom, rgba(18, 18, 22, 0) 0%, rgba(18, 18, 22, 0.36) 45%, rgba(18, 18, 22, 0.82) 78%, #121216 100%)';
const READER_TOP_GRADIENT =
  'linear-gradient(to bottom, rgba(18, 18, 22, 0.52) 0%, rgba(18, 18, 22, 0) 100%)';
const BOTTOM_BAR_GRADIENT =
  'linear-gradient(to bottom, rgba(0, 0, 0, 0) 0%, rgba(0, 0, 0, 0.72) 52%, rgba(0, 0, 0, 0.94) 100%)';

/**
 * Unified article canvas: background cover image smoothly fades into pure black at the bottom,
 * and both the cover image and the white article title/body glide upward together slowly
 * before the user taps "阅读文章".
 */
export function ArticlePreviewCanvas({
  article,
  coverUri,
  width,
  height,
  active,
  paused,
  onReady,
}: {
  article: ArticleData;
  coverUri?: string;
  width: number;
  height: number;
  active: boolean;
  paused: boolean;
  onReady?: () => void;
}) {
  const previewText = useMemo(() => {
    const raw = (article.abstract || article.body || '').trim();
    return raw.replace(/\n{3,}/g, '\n\n');
  }, [article.abstract, article.body]);

  const [canvasHeight, setCanvasHeight] = useState(0);
  const [imageFailed, setImageFailed] = useState(false);
  const translateY = useSharedValue(0);

  useEffect(() => {
    setImageFailed(false);
  }, [coverUri]);

  useEffect(() => {
    if (!coverUri || imageFailed) onReady?.();
  }, [coverUri, imageFailed, onReady]);

  const heroHeight = useMemo(() => {
    if (!coverUri || imageFailed || width <= 0 || height <= 0) return 0;
    return Math.max(260, Math.min(Math.round(height * 0.62), Math.round(width * 1.28)));
  }, [coverUri, imageFailed, width, height]);

  // Keep bottom area clear for the floating "阅读文章" pill + @author tag.
  const bottomReserved = 136;
  const visibleHeight = Math.max(200, height - bottomReserved);
  const maxTravel = Math.max(0, canvasHeight - visibleHeight);

  useEffect(() => {
    cancelAnimation(translateY);
    translateY.value = 0;
  }, [article.title, previewText, translateY]);

  useEffect(() => {
    cancelAnimation(translateY);
    if (!active) {
      translateY.value = 0;
      return;
    }
    if (paused || maxTravel <= 12) return;
    const duration = Math.max(3000, Math.round((maxTravel / SCROLL_PX_PER_SEC) * 1000));
    translateY.value = 0;
    translateY.value = withRepeat(
      withSequence(
        withDelay(450, withTiming(-maxTravel, { duration, easing: Easing.linear })),
        withDelay(1100, withTiming(0, { duration: 400 })),
      ),
      -1,
      false,
    );
    return () => cancelAnimation(translateY);
  }, [active, paused, maxTravel, translateY]);

  const scrollStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  const textOverlap = heroHeight > 0 ? Math.round(heroHeight * 0.22) : 64;

  return (
    <View style={[StyleSheet.absoluteFill, styles.canvasRoot]}>
      <Animated.View
        style={[styles.unifiedTrack, scrollStyle]}
        onLayout={(e) => {
          const h = e.nativeEvent.layout.height;
          if (h > 0) setCanvasHeight(h);
        }}
      >
        {heroHeight > 0 && coverUri ? (
          <View style={{ width: '100%', height: heroHeight, backgroundColor: '#000' }}>
            <Image
              source={{ uri: coverUri, headers: mediaHeaders }}
              onLoad={() => onReady?.()}
              onError={() => setImageFailed(true)}
              fadeDuration={0}
              resizeMode="cover"
              style={StyleSheet.absoluteFill}
            />
            <View
              pointerEvents="none"
              style={[styles.heroGradientOverlay, { backgroundImage: HERO_BLACK_GRADIENT }]}
            />
          </View>
        ) : (
          <View style={{ height: Math.max(88, Math.round(height * 0.22)) }} />
        )}

        <View
          style={[
            styles.canvasTextWrap,
            {
              marginTop: heroHeight > 0 ? -textOverlap : 0,
              paddingRight: 76,
            },
          ]}
        >
          <Text style={styles.feedTitle}>{article.title}</Text>
          {previewText.length > 0 && <Text style={styles.previewText}>{previewText}</Text>}
        </View>
      </Animated.View>
    </View>
  );
}

export function ArticleFeedChrome({
  buttonText,
  bottom,
  onRead,
}: {
  buttonText: string;
  bottom: number;
  onRead: () => void;
}) {
  return (
    <>
      <View
        pointerEvents="none"
        style={[styles.bottomScrim, { height: bottom + 116, backgroundImage: BOTTOM_BAR_GRADIENT }]}
      />
      <View pointerEvents="box-none" style={[styles.readBtnRow, { bottom: bottom + 6 }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={buttonText || '阅读文章'}
          onPress={onRead}
          hitSlop={8}
          style={({ pressed }) => [styles.readBtn, pressed && styles.readBtnPressed]}
        >
          <Ionicons name="document-text-outline" size={14} color="#fff" />
          <Text style={styles.readBtnText}>{buttonText || '阅读文章'}</Text>
        </Pressable>
      </View>
    </>
  );
}

export function ArticleReaderOverlay({
  visible,
  workId,
  article,
  heroUri,
  metaLabel,
  title,
  bodyText,
  author,
  authorAvatar,
  commentsCount,
  topInset,
  bottomInset,
  liked,
  saved,
  likesLabel,
  commentsLabel,
  favoritesLabel,
  sharesLabel,
  onClose,
  onAuthor,
  onLike,
  onFavorite,
  onFavoriteLongPress,
  onShare,
}: {
  visible: boolean;
  workId: string;
  article?: ArticleData;
  heroUri?: string;
  metaLabel?: string;
  title?: string;
  bodyText?: string;
  author: string;
  authorAvatar?: string;
  commentsCount?: number;
  topInset: number;
  bottomInset: number;
  liked: boolean;
  saved: boolean;
  likesLabel: string;
  commentsLabel: string;
  favoritesLabel: string;
  sharesLabel: string;
  onClose: () => void;
  onAuthor: () => void;
  onLike: () => void;
  onFavorite: () => void;
  onFavoriteLongPress: () => void;
  onShare: () => void;
}) {
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [commentY, setCommentY] = useState(0);
  const scrollRef = useRef<ComponentRef<typeof ScrollView> | null>(null);

  const resolvedTitle = title ?? article?.title ?? '';
  const resolvedBody = bodyText ?? article?.body ?? article?.abstract ?? '';
  const resolvedHero = heroUri ?? article?.headerImages[0];
  const resolvedMeta = useMemo(() => {
    if (metaLabel) return metaLabel;
    if (!article) return '';
    const minutes = estimateReadMinutes(article);
    const relTime = formatRelativeTime(article.publishedAt);
    return `阅读 ${minutes} 分钟${relTime ? ` · ${relTime}` : ''}`;
  }, [metaLabel, article]);

  const blocks = useMemo(() => parseArticleBlocks(resolvedBody), [resolvedBody]);

  useEffect(() => { setAvatarFailed(false); }, [authorAvatar]);

  if (!visible) return null;

  const scrollToComments = () => {
    scrollRef.current?.scrollTo({ y: Math.max(0, commentY - (topInset + 54)), animated: true });
  };

  return (
    <View style={[styles.readerRoot, { backgroundColor: '#121216' }]}>
      <View style={[styles.readerHeader, { paddingTop: topInset + 6 }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="返回" onPress={onClose} hitSlop={10} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={24} color="#fff" />
        </Pressable>
        <Pressable accessibilityRole="button" onPress={onAuthor} style={styles.readerAuthorRow}>
          <View style={styles.readerAvatar}>
            {authorAvatar && !avatarFailed
              ? <Image source={{ uri: authorAvatar, headers: mediaHeaders }} style={styles.readerAvatarImg} onError={() => setAvatarFailed(true)} />
              : <Text style={styles.readerAvatarText}>{author.slice(0, 1)}</Text>}
          </View>
          <Text numberOfLines={1} style={styles.readerAuthorName}>{author}</Text>
        </Pressable>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView
        ref={scrollRef}
        style={styles.readerScroll}
        contentContainerStyle={{ paddingBottom: 24 }}
        showsVerticalScrollIndicator={false}
      >
        {resolvedHero ? (
          <View style={styles.heroWrap}>
            <Image source={{ uri: resolvedHero, headers: mediaHeaders }} resizeMode="cover" style={styles.heroImg} />
            <View pointerEvents="none" style={[styles.heroFadeTop, { backgroundImage: READER_TOP_GRADIENT }]} />
            <View pointerEvents="none" style={[styles.heroFadeBottom, { backgroundImage: READER_HERO_GRADIENT }]} />
          </View>
        ) : (
          <View style={{ height: topInset + 54 }} />
        )}

        <View style={[styles.readerBodyWrap, !resolvedHero && { paddingTop: 12 }]}>
          {!!resolvedMeta && <Text style={styles.readerMeta}>{resolvedMeta}</Text>}
          {!!resolvedTitle && <Text selectable style={styles.readerTitle}>{resolvedTitle}</Text>}
          <View style={[styles.readerContent, !resolvedTitle && { marginTop: 10 }]}>
            {blocks.length > 0 ? blocks.map((block, index) => (
              <Text
                key={index}
                selectable
                style={block.kind === 'heading' ? styles.readerSubheading : styles.readerParagraph}
              >
                {block.text}
              </Text>
            )) : (
              <Text style={styles.readerParagraph}>暂无文字内容</Text>
            )}
          </View>
        </View>

        <View
          style={styles.commentsDivider}
          onLayout={(e) => setCommentY(e.nativeEvent.layout.y)}
        >
          <InlineWorkComments workId={workId} countHint={commentsCount} />
        </View>
      </ScrollView>

      <View style={[styles.readerFooter, { paddingBottom: Math.max(10, bottomInset + 6) }]}>
        <Pressable accessibilityRole="button" onPress={scrollToComments} style={styles.commentInputMock}>
          <Ionicons name="create-outline" size={16} color="#9e9ea6" />
          <Text style={styles.commentInputText}>查看评论区…</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="喜欢" onPress={onLike} style={styles.footerTool}>
          <Ionicons name="heart" size={23} color={liked ? '#fc2f56' : '#e8e8ee'} />
          <Text style={styles.footerCount}>{likesLabel}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="评论" onPress={scrollToComments} style={styles.footerTool}>
          <Ionicons name="chatbubble-ellipses" size={22} color="#e8e8ee" />
          <Text style={styles.footerCount}>{commentsLabel}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="收藏"
          onPress={onFavorite}
          onLongPress={onFavoriteLongPress}
          style={styles.footerTool}
        >
          <Ionicons name="star" size={23} color={saved ? '#ffc345' : '#e8e8ee'} />
          <Text style={styles.footerCount}>{favoritesLabel}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="分享" onPress={onShare} style={styles.footerTool}>
          <Ionicons name="arrow-redo" size={22} color="#e8e8ee" />
          <Text style={styles.footerCount}>{sharesLabel}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  canvasRoot: {
    backgroundColor: '#000000',
    overflow: 'hidden',
  },
  unifiedTrack: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: '#000000',
    paddingBottom: 60,
  },
  heroGradientOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '62%',
  },
  canvasTextWrap: {
    paddingHorizontal: 14,
    gap: 10,
    backgroundColor: 'transparent',
  },
  feedTitle: {
    color: '#ffffff',
    fontSize: 20,
    lineHeight: 28,
    fontWeight: '700',
    textShadowColor: 'rgba(0,0,0,0.65)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  previewText: {
    color: 'rgba(255, 255, 255, 0.92)',
    fontSize: 15.5,
    lineHeight: 26,
    textShadowColor: 'rgba(0,0,0,0.65)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  bottomScrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 1,
  },
  readBtnRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 3,
  },
  readBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 22,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.28)',
  },
  readBtnPressed: {
    backgroundColor: 'rgba(255, 255, 255, 0.34)',
  },
  readBtnText: {
    color: '#ffffff',
    fontSize: 13.5,
    fontWeight: '600',
  },
  readerRoot: {
    ...StyleSheet.absoluteFill,
    zIndex: 20,
  },
  readerHeader: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 5,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingBottom: 10,
    backgroundColor: 'rgba(18, 18, 22, 0.36)',
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  readerAuthorRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginLeft: 4,
  },
  readerAvatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#4c5764',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  readerAvatarImg: {
    width: 28,
    height: 28,
  },
  readerAvatarText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  readerAuthorName: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
    flexShrink: 1,
  },
  headerSpacer: {
    width: 36,
  },
  readerScroll: {
    flex: 1,
  },
  heroWrap: {
    height: 240,
    width: '100%',
    backgroundColor: '#121216',
  },
  heroImg: {
    width: '100%',
    height: '100%',
  },
  heroFadeTop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 82,
  },
  heroFadeBottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 110,
  },
  readerBodyWrap: {
    paddingHorizontal: 18,
    paddingTop: 12,
    paddingBottom: 22,
  },
  readerMeta: {
    color: '#9b9ca6',
    fontSize: 12.5,
  },
  readerTitle: {
    color: '#ffffff',
    fontSize: 22,
    lineHeight: 30,
    fontWeight: '700',
    marginTop: 10,
  },
  readerContent: {
    marginTop: 16,
    gap: 14,
  },
  readerSubheading: {
    color: '#ffffff',
    fontSize: 18,
    lineHeight: 27,
    fontWeight: '700',
  },
  readerParagraph: {
    color: '#e8e9ef',
    fontSize: 16.5,
    lineHeight: 28,
  },
  commentsDivider: {
    marginTop: 8,
    borderTopWidth: 6,
    borderTopColor: '#1a1a20',
    backgroundColor: '#121216',
  },
  readerFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 14,
    paddingTop: 10,
    backgroundColor: '#16161b',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.1)',
  },
  commentInputMock: {
    flex: 1,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#252630',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
  },
  commentInputText: {
    color: '#9e9ea6',
    fontSize: 13.5,
  },
  footerTool: {
    alignItems: 'center',
    minWidth: 34,
  },
  footerCount: {
    color: '#d4d5dc',
    fontSize: 11,
    marginTop: 1,
  },
});
